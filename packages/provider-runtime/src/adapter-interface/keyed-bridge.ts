// A FAMILY ADAPTER ON THE KEYED FETCH (Clover spec §5.2, §5.4; A-M2): `modelAdapterFromProviderAdapter` turns one of
// the SDK's `ProviderAdapter`s, which read a credential store and write the key into a header themselves, into a
// `ModelAdapter` that never holds a key, so a model plugin can run it in the shared plugin host.
//
// HOW. Each call hands the family adapter a credential store holding a SENTINEL: a random string, fresh per call, in
// the material shape the family reads (`api-key`, `bearer`, `oauth`). The adapter builds its request as it always
// does, with the sentinel where the key would go, and sends it through `boundedFetch`, whose hop this call's
// transport (`runWithProviderTransport`) takes over. The transport:
//   * takes the sentinel out of the one header the family put it in (any of `KEY_HEADERS`), and sends the request
//     through `ctx.fetch` with this adapter's `auth` entry, so the CORE adds the real key, where the plugin's
//     manifest says (§5.4);
//   * refuses a request that carries the sentinel anywhere else (a URL's query, another header): the keyed fetch
//     places keys in a header only, and a key copied elsewhere would leave the core's control;
//   * sends a request with no sentinel at all with `auth: false` (a public endpoint).
// So the plugin sees the sentinel and never the key; the response comes back through the keyed fetch, with every
// header that echoes the key already taken out.
//
// WHAT CROSSES. Non-secret fields a family reads off its material beside the secret (a ChatGPT account id names the
// `chatgpt-account-id` header) come from the connection (`ConnectionProfile.account`), which the host fills from its
// own sign-in record. Expiry is "not soon", so no family tries to refresh on its own: the keyed fetch's 401 retry,
// with a newer token from the core's refresher, is the only refresh (§3.3).
import { randomUUID } from "node:crypto";
import { ProviderRequestError, runWithProviderTransport, type ProviderTransport } from "../http.ts";
import type { CredentialMaterial, CredentialRef, CredentialStatus, CredentialStore, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "../types.ts";
import { KEY_HEADERS } from "./keyed-fetch.ts";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type KeyedFetch, type KeyedFetchInit, type ModelAdapter } from "./types.ts";

export interface KeyedBridgeOptions {
  /**
   * The plugin's `auth` entry the family's credential is (its `secret` name), and the material shape the family
   * reads. Absent: the adapter runs with no credential at all (a local runner).
   */
  auth?: { name: string; material: "api-key" | "bearer" | "oauth" };
  /** The adapter id to present. Default: the family adapter's own. */
  id?: string;
}

/** How long a sentinel `oauth`/`bearer` material reads as valid: long enough that no family refreshes on its own. */
const SENTINEL_LIFETIME_MS = 24 * 60 * 60 * 1000;

function sentinelMaterial(kind: "api-key" | "bearer" | "oauth", sentinel: string, connection: ProviderContext["connection"]): CredentialMaterial {
  const expiresAt = Date.now() + SENTINEL_LIFETIME_MS;
  if (kind === "api-key") return { kind: "api-key", key: sentinel };
  if (kind === "bearer") return { kind: "bearer", token: sentinel, expiresAt };
  return { kind: "oauth", accessToken: sentinel, expiresAt, ...(connection.account !== undefined ? { accountId: connection.account } : {}) };
}

/** A store that answers every read with the call's sentinel and refuses every write: a keyless worker writes nothing. */
function sentinelStore(material: CredentialMaterial | null): CredentialStore {
  const refuse = async (): Promise<never> => {
    throw new ProviderRequestError({ code: "capability", message: "a model plugin's adapter holds no credential; the core keeps and refreshes it (spec §3.3)", retryable: false });
  };
  return {
    get: async () => material,
    set: refuse,
    delete: refuse,
    refresh: async () => {
      if (material === null) return refuse();
      return material;
    },
  };
}

function capability(message: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message, retryable: false });
}

/** A request body as the keyed fetch takes it. */
async function keyedBody(body: BodyInit | null | undefined): Promise<NonNullable<KeyedFetchInit["body"]> | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (body instanceof URLSearchParams) return body.toString();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** The transport one call runs with: every hop through `fetch` with `authName`'s key in place of `sentinel`. */
export function keyedTransport(fetch: KeyedFetch, sentinel: string | undefined, authName: string | undefined): ProviderTransport {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    let carried = false;
    if (sentinel !== undefined) {
      if (url.includes(sentinel) || url.includes(encodeURIComponent(sentinel))) throw capability("the adapter put its credential in a URL; the keyed fetch places keys only in a header (spec §5.4)");
      for (const name of KEY_HEADERS) {
        const value = headers.get(name);
        if (value !== null && value.includes(sentinel)) {
          headers.delete(name);
          carried = true;
        }
      }
      headers.forEach((value, name) => {
        if (value.includes(sentinel)) throw capability(`the adapter put its credential in the ${name} header; the keyed fetch places keys only where the plugin's manifest says (spec §5.4)`);
      });
    }
    const plain: Record<string, string> = {};
    headers.forEach((value, name) => {
      plain[name] = value;
    });
    const keyedInit: KeyedFetchInit = { method: init.method ?? "GET", headers: plain, body: await keyedBody(init.body), ...(init.signal ? { signal: init.signal } : {}) };
    try {
      return await fetch(url, keyedInit, carried && authName !== undefined ? { auth: authName } : { auth: false });
    } catch (err) {
      throw refusalOf(err) ?? err;
    }
  };
}

/** The keyed fetch's own refusals (its rules, never the network's), by code: none of them goes away on a retry. */
const POLICY_REFUSALS: ReadonlySet<string> = new Set(["host_not_declared", "insecure_url", "redirect_refused", "unknown_auth", "ambiguous_auth", "credential_header", "refused"]);

/**
 * 0.0.65: a request the keyed fetch refused by its rules (a host the plugin didn't declare, a plain-http URL, a
 * redirect off its hosts) is a `capability` error, not retryable, as the adapters' retry ladder reads it; before, it
 * read as a network failure and was retried for a minute. `no_credential` is `auth`. A refusal that crossed a process
 * boundary carries its code on a plain error, so the code alone decides.
 */
function refusalOf(err: unknown): ProviderRequestError | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (POLICY_REFUSALS.has(code)) return new ProviderRequestError({ code: "capability", message: `the keyed fetch refused the request (${code}): ${message}`, retryable: false });
  if (code === "no_credential") return new ProviderRequestError({ code: "auth", message: `no credential for the request: ${message}`, retryable: false });
  return undefined;
}

/** Iterates `iterable` with every step inside `transport`, so each request the adapter makes takes it. */
/** Runs an adapter's stream with `transport` in force for every step (the hop of each pull). */
export async function* withTransport<T>(transport: ProviderTransport, start: () => AsyncIterable<T>): AsyncGenerator<T, void, undefined> {
  const iterator = runWithProviderTransport(transport, () => start()[Symbol.asyncIterator]());
  let finished = false;
  try {
    for (;;) {
      const step = await runWithProviderTransport(transport, () => iterator.next());
      if (step.done === true) {
        finished = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!finished) await runWithProviderTransport(transport, async () => void (await iterator.return?.(undefined)));
  }
}

/**
 * A `ProviderAdapter` (a family adapter of this SDK) as a keyless `ModelAdapter` on the keyed fetch. See this file's
 * header. `mapEffort` and `capabilities` need no credential and pass straight through.
 */
export function modelAdapterFromProviderAdapter(adapter: ProviderAdapter, options: KeyedBridgeOptions = {}): ModelAdapter {
  const auth = options.auth;
  const ref: CredentialRef = auth === undefined ? { kind: "none" } : { kind: "keychain", account: auth.name };
  /** One call's context, transport and sentinel. */
  const callFor = (ctx: AdapterContext): { pctx: ProviderContext; transport: ProviderTransport } => {
    const sentinel = auth === undefined ? undefined : `clover-keyed-${randomUUID()}`;
    const material = auth === undefined || sentinel === undefined ? null : sentinelMaterial(auth.material, sentinel, ctx.connection);
    return {
      pctx: { connection: ctx.connection, credentials: sentinelStore(material), authRef: ref, stallTimeoutMs: ctx.stallTimeoutMs, log: ctx.log },
      transport: keyedTransport(ctx.fetch, sentinel, auth?.name),
    };
  };
  const model: ModelAdapter = {
    interfaceVersion: MODEL_ADAPTER_INTERFACE_VERSION,
    id: options.id ?? adapter.id,
    version: adapter.version,
    family: adapter.family,
    protocol: adapter.protocol,
    async validateCredential(ctx): Promise<CredentialStatus> {
      const { pctx, transport } = callFor(ctx);
      return runWithProviderTransport(transport, () => adapter.validateCredential(ref, pctx));
    },
    async listModels(ctx) {
      const { pctx, transport } = callFor(ctx);
      return runWithProviderTransport(transport, () => adapter.listModels({ ...pctx, limits: ctx.limits, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }));
    },
    streamTurn(req: TurnRequest, ctx: AdapterContext): AsyncIterable<ProviderEvent> {
      const { pctx, transport } = callFor(ctx);
      return withTransport(transport, () => adapter.streamTurn(req, pctx));
    },
    mapEffort: (effort, row) => adapter.mapEffort(effort, row),
    capabilities: (row) => adapter.capabilities(row),
  };
  if (adapter.countTokens !== undefined) {
    const count = adapter.countTokens.bind(adapter);
    model.countTokens = async (req, ctx) => {
      const { pctx, transport } = callFor(ctx);
      return runWithProviderTransport(transport, () => count(req, pctx));
    };
  }
  return model;
}
