// A MODEL ADAPTER THE HOST SERVES (Clover spec §3.3, §5.2; A-M2). A code model plugin's adapter runs in the plugin
// host, which only the host (Clover's core) can reach; the session runs in a Worker of the core, or a process of
// its own. So the session's registry holds a STUB for each such adapter, whose calls cross the session's control
// channel to the host, which runs them on the plugin and streams the events back.
//
// THE WIRE, three control requests from the session to its host (`HOST_MODEL_ADAPTER_SUBTYPES`):
//   model_adapter_open   { adapterId, method, req?, connection, stallTimeoutMs, limits? }  ->  { callId }
//   model_adapter_next   { callId }                                                        ->  { events, done, value?, error? }
//   model_adapter_cancel { callId }                                                        ->  {}
// A stream is PULLED: `next` waits until at least one event is ready or the call ends, then answers every event
// ready so far, so a fast stream costs one round trip per batch and a slow one a held request. A `streamTurn` ends
// with `done`; the other methods answer their `value` with `done`. A failure is `error` (a `ProviderError`'s fields),
// after which the call is gone. Everything on the wire is JSON: a `TurnRequest` without its `signal` (cancel is its
// own request), `ProviderEvent`s, and the context's data fields; never a credential (the plugin's own key reaches
// it through the core's keyed fetch, §5.4, never through the session).
//
// THE STUB'S LOCAL HALF. `mapEffort` and `capabilities` are synchronous in the interface, and a host round trip is
// not, so the stub answers them from the catalog row, by the rules the SDK's OpenAI family uses
// (`rowDerivedMapEffort`, `rowDerivedCapabilities`): the row's verified effort vocabulary, its tool-calling
// evidence, its continuation domain. The plugin's adapter maps the effort again when the turn reaches it, and its
// refusal comes back as the turn's error, so a row-derived answer can only be more permissive at the early check,
// never send what the plugin refuses.
import type { WinterModelDescriptor } from "@waifucave/clover-provider-catalog";
import { ProviderRequestError } from "../http.ts";
import { capabilitiesFrom, mapEffortAgainst } from "../adapters/openai/shared.ts";
import type { ConnectionProfile, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderError, ProviderEvent, ProviderFamily, TurnRequest } from "../types.ts";
import type { ProviderProtocol } from "@waifucave/clover-provider-catalog";

export const HOST_MODEL_ADAPTER_SUBTYPES = {
  open: "model_adapter_open",
  next: "model_adapter_next",
  cancel: "model_adapter_cancel",
} as const;

export type HostModelAdapterMethod = "streamTurn" | "listModels" | "validateCredential" | "countTokens";

/** The identity of an adapter the host serves, as the session's config names it. */
export interface HostServedAdapterIdentity {
  id: string;
  version: string;
  family: ProviderFamily;
  protocol: ProviderProtocol;
  /** The plugin's adapter counts tokens. */
  countTokens?: boolean;
}

export interface HostModelAdapterOpen {
  adapterId: string;
  method: HostModelAdapterMethod;
  req?: Omit<TurnRequest, "signal">;
  connection: ConnectionProfile;
  stallTimeoutMs: number;
  limits?: DiscoveryContext["limits"];
}

export type WireProviderError = Partial<ProviderError> & { message: string };

export interface HostModelAdapterBatch {
  events: ProviderEvent[];
  done: boolean;
  value?: unknown;
  error?: WireProviderError;
}

/** The narrow request door the stub needs (the runtime's control bridge satisfies it). */
export interface HostModelAdapterSender {
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/** How long one `next` may be held: a stream that sends nothing for longer is the adapter's stall watchdog's call. */
export const HOST_MODEL_ADAPTER_NEXT_TIMEOUT_MS = 30 * 60_000;
/** How long `open` and `cancel` may take. */
export const HOST_MODEL_ADAPTER_CONTROL_TIMEOUT_MS = 60_000;

export function toWireProviderError(err: unknown): WireProviderError {
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

export function fromWireProviderError(wire: WireProviderError): Error {
  if (wire.code !== undefined && wire.retryable !== undefined) return new ProviderRequestError(wire as ProviderError);
  return new ProviderRequestError({ code: "network", message: wire.message, retryable: false });
}

/** The row-derived `mapEffort` a host-served stub answers with (see this file's header). */
export function rowDerivedMapEffort(effort: TurnRequest["effort"], row: WinterModelDescriptor): { ok: true; value: unknown } | { ok: false; reason: string } {
  return mapEffortAgainst(effort, row);
}

/** The row-derived `capabilities` a host-served stub answers with. */
export function rowDerivedCapabilities(row: WinterModelDescriptor): ReturnType<ProviderAdapter["capabilities"]> {
  return capabilitiesFrom(row);
}

/**
 * The session side: a `ProviderAdapter` whose calls the host serves. It holds no credential and reads none from
 * its context: the plugin's key is the core's business.
 */
export function hostServedProviderAdapter(identity: HostServedAdapterIdentity, sender: HostModelAdapterSender): ProviderAdapter {
  const open = async (method: HostModelAdapterMethod, ctx: ProviderContext, extra: { req?: TurnRequest; limits?: DiscoveryContext["limits"] }): Promise<string> => {
    const { signal: _signal, ...req } = extra.req ?? ({} as TurnRequest);
    const payload: HostModelAdapterOpen = {
      adapterId: identity.id,
      method,
      ...(extra.req !== undefined ? { req } : {}),
      connection: ctx.connection,
      stallTimeoutMs: ctx.stallTimeoutMs,
      ...(extra.limits !== undefined ? { limits: extra.limits } : {}),
    };
    const opened = await sender.request<{ callId?: unknown }>(HOST_MODEL_ADAPTER_SUBTYPES.open, payload, { timeoutMs: HOST_MODEL_ADAPTER_CONTROL_TIMEOUT_MS });
    if (typeof opened?.callId !== "string") throw new ProviderRequestError({ code: "network", message: `the host did not open a call on ${identity.id}`, retryable: false });
    return opened.callId;
  };
  const next = (callId: string): Promise<HostModelAdapterBatch> => sender.request<HostModelAdapterBatch>(HOST_MODEL_ADAPTER_SUBTYPES.next, { callId }, { timeoutMs: HOST_MODEL_ADAPTER_NEXT_TIMEOUT_MS });
  const cancel = (callId: string): void => {
    void sender.request(HOST_MODEL_ADAPTER_SUBTYPES.cancel, { callId }, { timeoutMs: HOST_MODEL_ADAPTER_CONTROL_TIMEOUT_MS }).catch(() => {});
  };
  /** A one-value call: open, then pull until `done`. */
  const call = async <T>(method: HostModelAdapterMethod, ctx: ProviderContext, extra: { req?: TurnRequest; limits?: DiscoveryContext["limits"]; signal?: AbortSignal }): Promise<T> => {
    const callId = await open(method, ctx, extra);
    const onAbort = (): void => cancel(callId);
    extra.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const batch = await next(callId);
        if (batch.error !== undefined) throw fromWireProviderError(batch.error);
        if (batch.done) return batch.value as T;
      }
    } finally {
      extra.signal?.removeEventListener("abort", onAbort);
    }
  };
  const adapter: ProviderAdapter = {
    id: identity.id,
    version: identity.version,
    family: identity.family,
    protocol: identity.protocol,
    validateCredential: (_ref, ctx): Promise<CredentialStatus> => call<CredentialStatus>("validateCredential", ctx, {}),
    listModels: (ctx): Promise<ModelCatalogResult> => call<ModelCatalogResult>("listModels", ctx, { limits: ctx.limits, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) }),
    async *streamTurn(req, ctx): AsyncGenerator<ProviderEvent, void, undefined> {
      if (req.signal?.aborted === true) {
        yield { type: "error", error: { code: "aborted", message: "the turn was aborted before it reached the model plugin", retryable: false } };
        return;
      }
      const callId = await open("streamTurn", ctx, { req });
      let finished = false;
      const onAbort = (): void => cancel(callId);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          const batch = await next(callId);
          for (const event of batch.events) yield event;
          if (batch.error !== undefined) {
            finished = true;
            const err = batch.error;
            yield { type: "error", error: { code: err.code ?? "network", message: err.message, retryable: err.retryable ?? false, ...(err.status !== undefined ? { status: err.status } : {}), ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) } as ProviderError };
            return;
          }
          if (batch.done) {
            finished = true;
            return;
          }
        }
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        if (!finished) cancel(callId);
      }
    },
    mapEffort: rowDerivedMapEffort,
    capabilities: rowDerivedCapabilities,
  };
  if (identity.countTokens === true) adapter.countTokens = (req, ctx) => call<number>("countTokens", ctx, { req, ...(req.signal !== undefined ? { signal: req.signal } : {}) });
  return adapter;
}

// ---------------------------------------------------------------------------------------------------
// The host side.

/** What the host runs a call on: a model plugin's adapter, minus what the host supplies itself (its fetch). */
export interface HostModelAdapter {
  streamTurn(req: TurnRequest, ctx: HostModelAdapterContext): AsyncIterable<ProviderEvent>;
  listModels(ctx: HostModelAdapterContext & { limits: DiscoveryContext["limits"] }): Promise<ModelCatalogResult>;
  validateCredential(ctx: HostModelAdapterContext): Promise<CredentialStatus>;
  countTokens?(req: TurnRequest, ctx: HostModelAdapterContext): Promise<number>;
}

export interface HostModelAdapterContext {
  connection: ConnectionProfile;
  stallTimeoutMs: number;
  signal: AbortSignal;
}

/** The answer to a control request: a value, or a typed refusal. */
export type HostControlAnswer = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

/** How long a call nobody pulls is kept before it is cancelled (a session that died mid-stream). */
export const HOST_MODEL_ADAPTER_ABANDON_MS = 10 * 60_000;

interface ServedCall {
  queue: ProviderEvent[];
  done: boolean;
  value?: unknown;
  error?: WireProviderError;
  wake?: (() => void) | undefined;
  controller: AbortController;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * The host side of the wire: answers `open`, `next` and `cancel` for the adapters it serves, by id. `adapterFor`
 * returns undefined for an id the session may not call (it was not in its config, or its plugin went away).
 */
export function createHostModelAdapterServer(adapterFor: (adapterId: string) => HostModelAdapter | undefined, opts: { abandonMs?: number } = {}): {
  handle(subtype: string, payload: unknown): Promise<HostControlAnswer>;
  /** Cancels every call (the session ended). */
  close(): void;
  readonly open: number;
} {
  const calls = new Map<string, ServedCall>();
  let seq = 0;
  const abandonMs = opts.abandonMs ?? HOST_MODEL_ADAPTER_ABANDON_MS;
  const arm = (id: string, call: ServedCall): void => {
    if (call.idle !== undefined) clearTimeout(call.idle);
    call.idle = setTimeout(() => {
      call.controller.abort();
      calls.delete(id);
    }, abandonMs);
    (call.idle as { unref?: () => void }).unref?.();
  };
  const finish = (call: ServedCall): void => {
    call.done = true;
    call.wake?.();
  };
  const refuse = (code: string, message: string): HostControlAnswer => ({ ok: false, error: { code, message } });
  return {
    get open() {
      return calls.size;
    },
    close() {
      for (const call of calls.values()) {
        call.controller.abort();
        if (call.idle !== undefined) clearTimeout(call.idle);
      }
      calls.clear();
    },
    async handle(subtype, payload): Promise<HostControlAnswer> {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (subtype === HOST_MODEL_ADAPTER_SUBTYPES.open) {
        const open = p as unknown as HostModelAdapterOpen;
        if (typeof open.adapterId !== "string" || typeof open.method !== "string" || typeof open.connection !== "object" || open.connection === null) return refuse("invalid_payload", "model_adapter_open expects { adapterId, method, connection, stallTimeoutMs }");
        const adapter = adapterFor(open.adapterId);
        if (adapter === undefined) return refuse("not_served", `the host serves no model adapter ${JSON.stringify(open.adapterId)} to this session`);
        const id = `mac-${++seq}`;
        const call: ServedCall = { queue: [], done: false, controller: new AbortController() };
        calls.set(id, call);
        arm(id, call);
        const ctx: HostModelAdapterContext = { connection: open.connection, stallTimeoutMs: typeof open.stallTimeoutMs === "number" ? open.stallTimeoutMs : 120_000, signal: call.controller.signal };
        const run = async (): Promise<void> => {
          try {
            switch (open.method) {
              case "streamTurn": {
                if (open.req === undefined) throw new ProviderRequestError({ code: "capability", message: "a streamTurn call carries its request", retryable: false });
                for await (const event of adapter.streamTurn({ ...open.req, signal: call.controller.signal } as TurnRequest, ctx)) {
                  if (call.controller.signal.aborted) break;
                  call.queue.push(event);
                  call.wake?.();
                }
                break;
              }
              case "listModels":
                call.value = await adapter.listModels({ ...ctx, limits: open.limits ?? { maxBytes: 4 * 1024 * 1024, maxItems: 5000, timeoutMs: 30_000 } });
                break;
              case "validateCredential":
                call.value = await adapter.validateCredential(ctx);
                break;
              case "countTokens":
                if (adapter.countTokens === undefined || open.req === undefined) throw new ProviderRequestError({ code: "capability", message: "this model plugin's adapter does not count tokens", retryable: false });
                call.value = await adapter.countTokens({ ...open.req, signal: call.controller.signal } as TurnRequest, ctx);
                break;
              default:
                throw new ProviderRequestError({ code: "capability", message: `no adapter method ${JSON.stringify(open.method)}`, retryable: false });
            }
          } catch (err) {
            call.error = toWireProviderError(err);
          } finally {
            finish(call);
          }
        };
        void run();
        return { ok: true, value: { callId: id } };
      }
      if (subtype === HOST_MODEL_ADAPTER_SUBTYPES.next) {
        const id = typeof p["callId"] === "string" ? p["callId"] : "";
        const call = calls.get(id);
        if (call === undefined) return refuse("unknown_call", `no model adapter call ${JSON.stringify(id)} (it ended, or was cancelled)`);
        arm(id, call);
        if (call.queue.length === 0 && !call.done) await new Promise<void>((resolve) => (call.wake = resolve));
        call.wake = undefined;
        const events = call.queue.splice(0);
        const batch: HostModelAdapterBatch = { events, done: call.done && call.queue.length === 0 };
        if (batch.done) {
          if (call.error !== undefined) batch.error = call.error;
          else if (call.value !== undefined) batch.value = call.value;
          if (call.idle !== undefined) clearTimeout(call.idle);
          calls.delete(id);
        }
        return { ok: true, value: batch };
      }
      if (subtype === HOST_MODEL_ADAPTER_SUBTYPES.cancel) {
        const id = typeof p["callId"] === "string" ? p["callId"] : "";
        const call = calls.get(id);
        if (call !== undefined) {
          call.controller.abort();
          if (call.idle !== undefined) clearTimeout(call.idle);
          calls.delete(id);
          call.wake?.();
        }
        return { ok: true, value: {} };
      }
      return refuse("unknown_subtype", `not a model adapter request: ${subtype}`);
    },
  };
}

/** A model adapter's host half, from a `ModelAdapter` and the context pieces the host supplies (its keyed fetch). */
export function hostModelAdapterOf(
  adapter: Pick<import("./types.ts").ModelAdapter, "streamTurn" | "listModels" | "validateCredential" | "countTokens">,
  supply: (ctx: HostModelAdapterContext) => Omit<import("./types.ts").AdapterContext, "connection" | "stallTimeoutMs">,
): HostModelAdapter {
  const full = (ctx: HostModelAdapterContext): import("./types.ts").AdapterContext => ({ connection: ctx.connection, stallTimeoutMs: ctx.stallTimeoutMs, ...supply(ctx) });
  const out: HostModelAdapter = {
    streamTurn: (req, ctx) => adapter.streamTurn(req, full(ctx)),
    listModels: (ctx) => adapter.listModels({ ...full(ctx), limits: ctx.limits, signal: ctx.signal }),
    validateCredential: (ctx) => adapter.validateCredential(full(ctx)),
  };
  if (adapter.countTokens !== undefined) {
    const count = adapter.countTokens.bind(adapter);
    out.countTokens = (req, ctx) => count(req, full(ctx));
  }
  return out;
}
