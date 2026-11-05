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
//     host per call) and a fetch limited to the plugin's `network:` hosts. It puts the same limit on
//     `globalThis.fetch`, BEST EFFORT: `node:http(s)`, `Bun.connect`, a WebSocket or a `fetch` captured
//     before `init` are not held to it (spec §5.3: host code is not held to the list). It installs the
//     identity the host sends in `init`, so the process presents as its host does.
//
// THE WIRE, one JSON object per line, `t` naming the message:
//   host → child   init {hosts, identity}          first, once
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
// LIFECYCLE. `exited` settles when the process ends. A process that ends before it is ready fails every
// call at once, NOT retryable, with the tail of its stderr. One that ends later fails the calls in flight
// as a retryable `network` error (the same turn can succeed on a new process), and every LATER call at
// once as a `network` error that is NOT retryable: this object will never answer again, so a retry here
// would loop; the host watches `exited` and starts a new one. Every call has a cancel path or a deadline,
// and after stdin closes the child gives its calls a short grace, then exits.
// Nothing a secret touches is ever written to the pipe by the host except the `secret` answer the child
// asked for.
import { requireBunRuntime } from "../bun-required.ts";
import { ProviderRequestError } from "../http.ts";
import { activeWinterIdentity, setWinterIdentity, type WinterIdentity } from "../identity.ts";
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
  | { t: "init"; hosts: string[]; identity?: WinterIdentity }
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
  /** The identity the process presents (User-Agent, originator, contact). Default: this process's own. */
  identity?: WinterIdentity;
  /** A deadline for `validateCredential` and `countTokens`, which have no limit of their own. Default 60 s. */
  callDeadlineMs?: number;
}

/** How a model adapter's process ended. */
export interface ModelAdapterProcessExit {
  code: number | null;
  /** True when it ended before it was ready (a broken install, a crash at load). */
  beforeReady: boolean;
  /** The last lines it wrote to stderr. */
  stderrTail: string[];
}

export interface ModelAdapterProcess extends ModelAdapter {
  readonly pid: number;
  /** Settles when the process has ended. */
  readonly exited: Promise<ModelAdapterProcessExit>;
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
  let isReady = false;
  const stderrTail: string[] = [];
  const STDERR_TAIL_LINES = 20;
  const callDeadlineMs = options.callDeadlineMs ?? 60_000;
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

  const sink = options.stderr;
  const stderrDone = (async () => {
    for await (const line of lines(proc.stderr)) {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      sink?.(line);
    }
  })().catch(() => {});

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
            isReady = true;
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
      // Its stderr is read to the end before the reason is written, so the tail is complete.
      await stderrDone;
      if (!isReady) {
        // A process that never became ready will not on a retry either (a broken install, a crash at load).
        const reason = stderrTail.length > 0 ? `: ${stderrTail.slice(-5).join(" | ")}` : "";
        const err = new ProviderRequestError({ code: "capability", message: `the model adapter's process exited before it was ready${reason}`, retryable: false });
        readyReject(err);
        for (const call of pending.values()) call.reject(err);
        pending.clear();
      } else {
        failAll("the model adapter's process exited");
      }
    }
  })();

  const exitedPromise: Promise<ModelAdapterProcessExit> = (async () => {
    const code = await proc.exited;
    await stderrDone;
    return { code, beforeReady: !isReady, stderrTail: [...stderrTail] };
  })();

  send({ t: "init", hosts: [...options.hosts], identity: options.identity ?? activeWinterIdentity() });

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
    // A process that already exited answers nothing: fail now rather than wait on a reply that cannot come,
    // and not as retryable (this object never answers again; the host starts a new process, see `exited`).
    if (exited) throw new ProviderRequestError({ code: "network", message: "the model adapter's process has exited; a new one must be started", retryable: false });
    if (signal?.aborted === true) throw new ProviderRequestError({ code: "aborted", message: "the call was aborted before it was sent", retryable: false });
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, log: ctx.log, ...(onEvent === undefined ? {} : { onEvent }) });
    });
    let request: Omit<TurnRequest, "signal"> | undefined;
    if (req !== undefined) {
      const { signal: _signal, ...rest } = req;
      request = rest;
    }
    // The child is told, and the caller is answered at once: a call the child's adapter does not end on
    // cancel (validateCredential takes no signal) never holds its caller.
    const onAbort = (): void => {
      send({ t: "cancel", id });
      const call = pending.get(id);
      pending.delete(id);
      const timedOut = (signal?.reason as { name?: string } | undefined)?.name === "TimeoutError";
      call?.reject(new ProviderRequestError(timedOut ? { code: "timeout", message: `the model adapter's process did not answer ${method} in time`, retryable: true } : { code: "aborted", message: `${method} was aborted`, retryable: false }));
    };
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
    exited: exitedPromise,
    mapEffort: (effort, model) => options.local.mapEffort(effort, model),
    capabilities: (model) => options.local.capabilities(model),
    // No signal of its own: a deadline, so a hung process cannot hold the caller forever.
    validateCredential: async (ctx) => (await call("validateCredential", ctx, undefined, undefined, AbortSignal.timeout(callDeadlineMs))) as Awaited<ReturnType<ModelAdapter["validateCredential"]>>,
    // Discovery is time-bounded by its own limits, and the caller's signal ends it sooner.
    listModels: async (ctx) => (await call("listModels", ctx, undefined, undefined, ctx.signal === undefined ? AbortSignal.timeout(ctx.limits.timeoutMs) : AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.limits.timeoutMs)]))) as ModelCatalogResult,
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
    adapter.countTokens = async (req, ctx) => (await call("countTokens", ctx, req, undefined, req.signal === undefined ? AbortSignal.timeout(callDeadlineMs) : AbortSignal.any([req.signal, AbortSignal.timeout(callDeadlineMs)]))) as number;
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
        // The host's identity, installed for this process's life: its provider calls present as the host's.
        if (message.identity !== undefined) setWinterIdentity(message.identity);
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
            // A `Request` carries its own method, headers, body and signal; `init` overrides each, as `fetch` does.
            const req = input instanceof Request ? input : undefined;
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method ?? req?.method;
            const headers = init?.headers ?? req?.headers;
            const body = init?.body ?? req?.body ?? undefined;
            const signal = init?.signal ?? req?.signal ?? undefined;
            return guarded(url, {
              ...(method === undefined ? {} : { method }),
              ...(headers === undefined ? {} : { headers: Object.fromEntries(new Headers(headers).entries()) }),
              ...(body === undefined || body === null ? {} : { body: body as string | Uint8Array | ReadableStream<Uint8Array> }),
              ...(signal === undefined || signal === null ? {} : { signal }),
            }, { auth: false });
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
  // A short grace for the calls to end on their abort; an adapter that ignores it does not keep the process.
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SERVE_EXIT_GRACE_MS));
  await Promise.race([Promise.allSettled(calls), grace]);
  if (io === undefined) process.exit(0);
}

/** How long a model adapter's process waits for its calls after stdin closes before it exits. */
export const SERVE_EXIT_GRACE_MS = 2000;
