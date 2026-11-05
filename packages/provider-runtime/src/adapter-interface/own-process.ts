// A MODEL ADAPTER IN A PROCESS OF ITS OWN (Clover spec §5.2): where an adapter that must sign with its
// secret runs (AWS SigV4 for Bedrock), so the secret never enters the shared plugin host, whose workers
// are not isolated from each other's memory.
//
// TWO HALVES over one NDJSON pipe (the child's stdin and stdout):
//
//   spawnModelAdapterProcess (the host side): starts the process and returns a `ModelAdapter` whose
//     calls cross the pipe. Its identity and its two pure methods (`mapEffort`, `capabilities`, which
//     need no secret) come from a LOCAL half, so they stay synchronous. It answers the child's
//     `secrets.get` from the `AdapterSecrets` door it was handed -- the only way the process reaches a
//     secret -- and it holds no secret itself.
//
//   serveModelAdapterProcess (the child side): runs the real adapter with `ctx.secrets` (asking the
//     host per call) and a fetch limited to the plugin's `network:` hosts. It installs that limit on
//     `globalThis.fetch` too, so an adapter that calls `fetch` directly is held to the same hosts.
//
// THE WIRE, one JSON object per line, `t` naming the message:
//   host → child   init {hosts}                    first, once
//                  call {id, method, req?, ctx}    a `streamTurn`, `listModels`, `validateCredential` or `countTokens`
//                  cancel {id}                     the caller aborted or stopped reading
//                  secret {rid, material|error}    the answer to a `secrets.get`
//   child → host   ready {identity}                after init
//                  event {id, event}               one `ProviderEvent` of a `streamTurn`
//                  result {id, value}              a call's value
//                  error {id, error}               a call's failure (a `ProviderError`'s fields, or a message)
//                  end {id}                        a `streamTurn` finished
//                  secret {rid, name}              `secrets.get(name)`
//                  log {id, event}                 a call's telemetry: identifiers and counts only
//
// A process that exits mid-call fails that call as a retryable `network` error. Nothing a secret
// touches is ever written to the pipe by the host except the `secret` answer the child asked for.
import { requireBunRuntime } from "../bun-required.ts";
import { ProviderRequestError } from "../http.ts";
import type { CredentialMaterial, ModelCatalogResult, ProviderContext, ProviderError, ProviderEvent, TurnRequest } from "../types.ts";
import { createKeyedFetch } from "./keyed-fetch.ts";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type AdapterDiscoveryContext, type AdapterSecrets, type ModelAdapter } from "./types.ts";

type CallMethod = "streamTurn" | "listModels" | "validateCredential" | "countTokens";

/** The context fields that cross the pipe (the rest are rebuilt on the child's side). */
interface WireContext {
  connection: AdapterContext["connection"];
  stallTimeoutMs: number;
  limits?: AdapterDiscoveryContext["limits"];
}

type HostMessage =
  | { t: "init"; hosts: string[] }
  | { t: "call"; id: number; method: CallMethod; req?: Omit<TurnRequest, "signal">; ctx: WireContext }
  | { t: "cancel"; id: number }
  | { t: "secret"; rid: number; material?: CredentialMaterial | null; error?: string };

interface WireIdentity {
  interfaceVersion: number;
  id: string;
  version: string;
  family: ModelAdapter["family"];
  protocol: ModelAdapter["protocol"];
}

type WireError = Partial<ProviderError> & { message: string };

type ChildMessage =
  | { t: "ready"; identity: WireIdentity }
  | { t: "event"; id: number; event: ProviderEvent }
  | { t: "result"; id: number; value: unknown }
  | { t: "error"; id: number; error: WireError }
  | { t: "end"; id: number }
  | { t: "secret"; rid: number; name: string }
  | { t: "log"; id: number; event: Parameters<ProviderContext["log"]>[0] };

function toWireError(err: unknown): WireError {
  if (err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string" && typeof (err as { retryable?: unknown }).retryable === "boolean") {
    const e = err as ProviderError;
    return {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      ...(e.status === undefined ? {} : { status: e.status }),
      ...(e.providerCode === undefined ? {} : { providerCode: e.providerCode }),
      ...(e.retryAfterMs === undefined ? {} : { retryAfterMs: e.retryAfterMs }),
      ...(e.contextOverflow === true ? { contextOverflow: true as const } : {}),
      ...(e.imageOverflow === true ? { imageOverflow: true as const } : {}),
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

function fromWireError(wire: WireError): Error {
  if (wire.code !== undefined && wire.retryable !== undefined) return new ProviderRequestError(wire as ProviderError);
  return new Error(wire.message);
}

/** Splits a byte stream into lines. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) yield line;
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.trim().length > 0) yield buffered;
}

// ---------------------------------------------------------------------------------------------------
// The host side.

export interface ModelAdapterProcessOptions {
  /** The process to start: an argv whose program serves the adapter (`serveModelAdapterProcess`). */
  command: readonly string[];
  /** The adapter's LOCAL half: its identity, `mapEffort` and `capabilities`, none of which needs a secret. */
  local: Pick<ModelAdapter, "id" | "version" | "family" | "protocol" | "mapEffort" | "capabilities">;
  /** The plugin's own secrets: the process's only door to them. */
  secrets: AdapterSecrets;
  /** The plugin's `network:` hosts. The process reaches only these. */
  hosts: readonly string[];
  /** The process's environment. Default: only `PATH`, so nothing secret is inherited. */
  env?: Record<string, string>;
  cwd?: string;
  /** Where the process's stderr goes, a line at a time. Default: dropped. */
  stderr?: (line: string) => void;
  /** The served adapter offers `countTokens`. Default false: the proxy then has none. */
  countTokens?: boolean;
}

export interface ModelAdapterProcess extends ModelAdapter {
  readonly pid: number;
  /** Ends the process: its stdin closes, and after `graceMs` (default 2000) it is killed. */
  close(graceMs?: number): Promise<void>;
}

interface PendingCall {
  onEvent?: (event: ProviderEvent) => void;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  log: AdapterContext["log"];
}

export function spawnModelAdapterProcess(options: ModelAdapterProcessOptions): ModelAdapterProcess {
  requireBunRuntime("spawnModelAdapterProcess", "Bun.spawn", "it starts the adapter's own process and speaks to it over its stdin and stdout");
  if (options.command.length === 0) throw new TypeError("spawnModelAdapterProcess: the command is empty");
  const proc = Bun.spawn([...options.command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let exited = false;
  let readyResolve!: (identity: WireIdentity) => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<WireIdentity>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});

  const send = (message: HostMessage): void => {
    if (exited) return;
    try {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      void proc.stdin.flush();
    } catch {
      // the process is gone; its exit fails every pending call below
    }
  };

  const failAll = (why: string): void => {
    const err = new ProviderRequestError({ code: "network", message: why, retryable: true });
    readyReject(err);
    for (const call of pending.values()) call.reject(err);
    pending.clear();
  };

  void (async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        let message: ChildMessage;
        try {
          message = JSON.parse(line) as ChildMessage;
        } catch {
          continue;
        }
        switch (message.t) {
          case "ready":
            readyResolve(message.identity);
            break;
          case "event":
            pending.get(message.id)?.onEvent?.(message.event);
            break;
          case "result": {
            const call = pending.get(message.id);
            pending.delete(message.id);
            call?.resolve(message.value);
            break;
          }
          case "end": {
            const call = pending.get(message.id);
            pending.delete(message.id);
            call?.resolve(undefined);
            break;
          }
          case "error": {
            const call = pending.get(message.id);
            pending.delete(message.id);
            call?.reject(fromWireError(message.error));
            break;
          }
          case "secret": {
            const rid = message.rid;
            options.secrets.get(message.name).then(
              (material) => send({ t: "secret", rid, material }),
              (err: unknown) => send({ t: "secret", rid, error: err instanceof Error ? err.message : String(err) }),
            );
            break;
          }
          case "log":
            pending.get(message.id)?.log(message.event);
            break;
        }
      }
    } finally {
      exited = true;
      failAll("the model adapter's process exited");
    }
  })();

  if (options.stderr !== undefined) {
    const sink = options.stderr;
    void (async () => {
      for await (const line of lines(proc.stderr)) sink(line);
    })().catch(() => {});
  } else {
    void proc.stderr.cancel().catch(() => {});
  }

  send({ t: "init", hosts: [...options.hosts] });

  const wireContext = (ctx: AdapterContext | AdapterDiscoveryContext): WireContext => ({
    connection: ctx.connection,
    stallTimeoutMs: ctx.stallTimeoutMs,
    ...("limits" in ctx ? { limits: ctx.limits } : {}),
  });

  const call = async (method: CallMethod, ctx: AdapterContext, req: TurnRequest | undefined, onEvent?: (event: ProviderEvent) => void, signal?: AbortSignal): Promise<unknown> => {
    const identity = await ready;
    if (identity.interfaceVersion !== MODEL_ADAPTER_INTERFACE_VERSION) {
      throw new ProviderRequestError({ code: "capability", message: `the adapter process speaks model adapter interface ${identity.interfaceVersion}; this host speaks ${MODEL_ADAPTER_INTERFACE_VERSION}`, retryable: false });
    }
    // A process that already exited answers nothing: fail now rather than wait on a reply that cannot come.
    if (exited) throw new ProviderRequestError({ code: "network", message: "the model adapter's process exited", retryable: true });
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, log: ctx.log, ...(onEvent === undefined ? {} : { onEvent }) });
    });
    let request: Omit<TurnRequest, "signal"> | undefined;
    if (req !== undefined) {
      const { signal: _signal, ...rest } = req;
      request = rest;
    }
    const onAbort = (): void => send({ t: "cancel", id });
    signal?.addEventListener("abort", onAbort, { once: true });
    send({ t: "call", id, method, ctx: wireContext(ctx), ...(request === undefined ? {} : { req: request }) });
    try {
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const adapter: ModelAdapterProcess = {
    interfaceVersion: MODEL_ADAPTER_INTERFACE_VERSION,
    id: options.local.id,
    version: options.local.version,
    family: options.local.family,
    protocol: options.local.protocol,
    pid: proc.pid,
    mapEffort: (effort, model) => options.local.mapEffort(effort, model),
    capabilities: (model) => options.local.capabilities(model),
    validateCredential: async (ctx) => (await call("validateCredential", ctx, undefined)) as Awaited<ReturnType<ModelAdapter["validateCredential"]>>,
    listModels: async (ctx) => (await call("listModels", ctx, undefined, undefined, ctx.signal)) as ModelCatalogResult,
    streamTurn(req, ctx) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          const queue: ProviderEvent[] = [];
          let wake: (() => void) | undefined;
          let done = false;
          let failure: Error | undefined;
          const stop = new AbortController();
          const signal = req.signal === undefined ? stop.signal : AbortSignal.any([req.signal, stop.signal]);
          const started = call("streamTurn", ctx, req, (event) => {
            queue.push(event);
            wake?.();
          }, signal).then(
            () => {
              done = true;
              wake?.();
            },
            (err: unknown) => {
              failure = err instanceof Error ? err : new Error(String(err));
              done = true;
              wake?.();
            },
          );
          void started;
          return {
            async next(): Promise<IteratorResult<ProviderEvent>> {
              for (;;) {
                const event = queue.shift();
                if (event !== undefined) return { value: event, done: false };
                if (failure !== undefined) throw failure;
                if (done) return { value: undefined, done: true };
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
              }
            },
            async return(): Promise<IteratorResult<ProviderEvent>> {
              // The caller stopped reading: the child's turn is cancelled, not left streaming into a queue.
              if (!done) stop.abort();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    async close(graceMs = 2000) {
      try {
        await proc.stdin.end();
      } catch {
        // already closed
      }
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // gone
        }
      }, graceMs);
      await proc.exited;
      clearTimeout(timer);
    },
  };
  if (options.countTokens === true) {
    adapter.countTokens = async (req, ctx) => (await call("countTokens", ctx, req, undefined, req.signal)) as number;
  }
  return adapter;
}

// ---------------------------------------------------------------------------------------------------
// The child side.

export interface ServeModelAdapterProcessIo {
  input: ReadableStream<Uint8Array>;
  write(line: string): void;
}

/**
 * Serves `create()`'s adapter over stdin/stdout until stdin closes. The process's `globalThis.fetch` is
 * replaced by one limited to the hosts `init` names, so every request the adapter makes, through
 * `ctx.fetch` or not, reaches only the plugin's `network:` hosts.
 */
export async function serveModelAdapterProcess(create: () => ModelAdapter, io?: ServeModelAdapterProcessIo): Promise<void> {
  requireBunRuntime("serveModelAdapterProcess", "Bun.stdin", "it serves the adapter over this process's stdin and stdout");
  const input = io?.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const write = io?.write ?? ((line: string) => {
    process.stdout.write(line);
  });
  const out = (message: ChildMessage): void => write(`${JSON.stringify(message)}\n`);

  let adapter: ModelAdapter | undefined;
  let hostLimitedFetch: AdapterContext["fetch"] | undefined;
  const secretWaits = new Map<number, { resolve: (m: CredentialMaterial | null) => void; reject: (e: Error) => void }>();
  let nextRid = 1;
  const running = new Map<number, AbortController>();
  const secrets: AdapterSecrets = {
    get: (name) =>
      new Promise<CredentialMaterial | null>((resolve, reject) => {
        const rid = nextRid++;
        secretWaits.set(rid, { resolve, reject });
        out({ t: "secret", rid, name });
      }),
  };

  const contextFor = (wire: WireContext, id: number): AdapterContext => ({
    connection: wire.connection,
    stallTimeoutMs: wire.stallTimeoutMs,
    fetch: hostLimitedFetch!,
    secrets,
    log: (event) => out({ t: "log", id, event }),
  });

  const run = async (message: Extract<HostMessage, { t: "call" }>): Promise<void> => {
    const controller = new AbortController();
    running.set(message.id, controller);
    try {
      if (adapter === undefined) throw new Error("the adapter process was called before init");
      const ctx = contextFor(message.ctx, message.id);
      switch (message.method) {
        case "streamTurn": {
          const req: TurnRequest = { ...(message.req as TurnRequest), signal: controller.signal };
          for await (const event of adapter.streamTurn(req, ctx)) {
            out({ t: "event", id: message.id, event });
            if (controller.signal.aborted) break;
          }
          out({ t: "end", id: message.id });
          return;
        }
        case "listModels": {
          const value = await adapter.listModels({ ...ctx, limits: message.ctx.limits ?? { maxBytes: 1024 * 1024, maxItems: 1000, timeoutMs: 30_000 }, signal: controller.signal });
          out({ t: "result", id: message.id, value });
          return;
        }
        case "validateCredential": {
          out({ t: "result", id: message.id, value: await adapter.validateCredential(ctx) });
          return;
        }
        case "countTokens": {
          if (adapter.countTokens === undefined) throw new ProviderRequestError({ code: "capability", message: `the ${adapter.id} adapter has no token count`, retryable: false });
          out({ t: "result", id: message.id, value: await adapter.countTokens({ ...(message.req as TurnRequest), signal: controller.signal }, ctx) });
          return;
        }
      }
    } catch (err) {
      out({ t: "error", id: message.id, error: toWireError(err) });
    } finally {
      running.delete(message.id);
    }
  };

  const calls: Array<Promise<void>> = [];
  for await (const line of lines(input)) {
    let message: HostMessage;
    try {
      message = JSON.parse(line) as HostMessage;
    } catch {
      continue;
    }
    switch (message.t) {
      case "init": {
        const limited = createKeyedFetch({ hosts: message.hosts });
        hostLimitedFetch = limited;
        // The process's own `fetch` too: an adapter written against `fetch` directly (or a library it
        // uses) is held to the same hosts. Redirects stay manual-by-default in the keyed fetch.
        const platform = globalThis.fetch;
        // Redirects are handed back, not followed: the adapter's own fetch layer (`boundedFetch`) follows
        // them by hand and drops its credentials across origins, and each hop comes back through here.
        const guarded = createKeyedFetch({ hosts: message.hosts, followRedirects: false, fetch: (url, init) => platform(url, init) });
        globalThis.fetch = Object.assign(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            return guarded(url, { ...(init?.method === undefined ? {} : { method: init.method }), ...(init?.headers === undefined ? {} : { headers: Object.fromEntries(new Headers(init.headers).entries()) }), ...(init?.body === undefined || init.body === null ? {} : { body: init.body as string }), ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }) }, { auth: false });
          },
          { preconnect: platform.preconnect },
        ) as typeof fetch;
        adapter = create();
        out({ t: "ready", identity: { interfaceVersion: adapter.interfaceVersion, id: adapter.id, version: adapter.version, family: adapter.family, protocol: adapter.protocol } });
        break;
      }
      case "call":
        calls.push(run(message));
        break;
      case "cancel":
        running.get(message.id)?.abort();
        break;
      case "secret": {
        const wait = secretWaits.get(message.rid);
        secretWaits.delete(message.rid);
        if (wait === undefined) break;
        if (message.error !== undefined) wait.reject(new Error(message.error));
        else wait.resolve(message.material ?? null);
        break;
      }
    }
  }
  for (const controller of running.values()) controller.abort();
  await Promise.allSettled(calls);
}
