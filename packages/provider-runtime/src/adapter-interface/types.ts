// THE MODEL ADAPTER INTERFACE (Clover spec §3.3, §5.2, §5.4): what a model plugin's adapter implements.
//
// It replaces `ProviderAdapter`'s one assumption that cannot survive plugins: that an adapter holds the
// key. `ProviderAdapter` is handed a `ProviderContext` with a `CredentialStore` and an `authRef`, reads
// the material and writes it into a header itself. A model plugin's adapter runs in the shared plugin
// host, whose workers are not isolated from each other's memory (§5.2), so it is handed a KEYED FETCH
// instead: `ctx.fetch(url, init, { auth })` goes out through the core, which adds the named `auth`
// entry's key or token, reaches only the plugin's `network:` hosts, refuses a redirect elsewhere,
// streams both ways with no time limit while data flows, and after a 401 gets a newer token and
// retries once (§5.4). The adapter never sees a key, a token or a refresh token.
//
// THE ONE EXCEPTION is an adapter that must SIGN with the secret (AWS SigV4 for Bedrock): it runs in a
// process of its own (`own-process/`), where `ctx.secrets.get(name)` reads the plugin's own secret
// (§5.4). `secrets` is absent everywhere else, by construction: a worker's context has no such member.
//
// Everything an adapter is handed and returns is structured-clone data except `fetch`, `signal`,
// `log` and the streamed `Response`, so the plugin host can carry a call across its IPC (§5.2).
//
// VERSIONED. `MODEL_ADAPTER_INTERFACE_VERSION` is the contract number; a change that is not purely
// additive bumps it, and `interface.test.ts` pins the shape (member names and kinds) so an accidental
// change fails a test before it reaches a plugin.
import type { ProviderProtocol, ToolCalling, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ConnectionProfile, CredentialMaterial, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderContext, ProviderEvent, ProviderFamily, TurnRequest } from "../types.ts";

/** The contract number of this interface. A plugin states the one it was built against. */
export const MODEL_ADAPTER_INTERFACE_VERSION = 1 as const;

/**
 * What a keyed request carries. A deliberate SUBSET of `RequestInit`: headers are a plain record (data
 * that crosses IPC), and the body is a string, bytes, or a stream (which the keyed fetch streams out as
 * it is read, with no time limit while data flows). No `redirect` (the keyed fetch decides) and no
 * `credentials`/`mode`/`cache` (browser concepts with no meaning here).
 */
export interface KeyedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}

/**
 * WHERE the key or token goes. The core adds it; the adapter, which knows its provider's protocol, says
 * where. Header placement only: a key in a URL lands in every proxy and access log on the way.
 */
export interface AuthPlacement {
  /** The header that carries it. Default `authorization`. */
  header?: string;
  /** What precedes the value, with one space. Default `Bearer` on `authorization`, nothing on any other header. */
  scheme?: string;
}

export interface KeyedFetchOptions {
  /**
   * Which of the plugin's `auth` entries to add, by its `secret` name. ABSENT: the plugin's only one
   * (a refusal when it has several, `ambiguous_auth`; nothing when it has none). `false`: no key at all,
   * for a public endpoint of a plugin that has one.
   */
  auth?: string | false;
  placement?: AuthPlacement;
}

/** Spec §5.4's `net.fetch(url, init, { auth })`: the only door an adapter has to the network. */
export type KeyedFetch = (url: string, init?: KeyedFetchInit, options?: KeyedFetchOptions) => Promise<Response>;

/** Spec §5.4's `secrets.get(name)`: the plugin's own secret, by name. Only in a process of the plugin's own. */
export interface AdapterSecrets {
  get(name: string): Promise<CredentialMaterial | null>;
}

/** What every adapter call is handed. */
export interface AdapterContext {
  /** Non-secret connection metadata: region, project, deployment, a user endpoint (`baseUrl`). */
  connection: ConnectionProfile;
  /** The keyed fetch. Every request the adapter makes goes through it. */
  fetch: KeyedFetch;
  /**
   * PRESENT ONLY in a process of the plugin's own, for an adapter that must sign with its secret
   * (§5.2). A worker in the shared plugin host is never handed it.
   */
  secrets?: AdapterSecrets;
  /** Mid-stream silence longer than this is a typed stall (the adapter's own watchdog, as today). */
  stallTimeoutMs: number;
  /** Telemetry: identifiers and counts only, as `ProviderContext.log`. */
  log: ProviderContext["log"];
}

export interface AdapterDiscoveryContext extends AdapterContext {
  signal?: AbortSignal;
  /** Discovery responses MUST be size-, time- and item-bounded. Not advisory. */
  limits: DiscoveryContext["limits"];
}

/**
 * A model adapter. The same members as `ProviderAdapter`, with the credential arguments gone:
 * `validateCredential` checks the key or token behind the plugin's `auth` entry (a cheap
 * authenticated call through `ctx.fetch`), since the adapter has no reference to name.
 */
export interface ModelAdapter {
  readonly interfaceVersion: typeof MODEL_ADAPTER_INTERFACE_VERSION;
  readonly id: string;
  readonly version: string;
  readonly family: ProviderFamily;
  readonly protocol: ProviderProtocol;
  validateCredential(ctx: AdapterContext): Promise<CredentialStatus>;
  listModels(ctx: AdapterDiscoveryContext): Promise<ModelCatalogResult>;
  streamTurn(req: TurnRequest, ctx: AdapterContext): AsyncIterable<ProviderEvent>;
  /** Optional. A REAL count when the provider offers one; never an estimate. */
  countTokens?(req: TurnRequest, ctx: AdapterContext): Promise<number>;
  /** Map onto the model's VERIFIED effort vocabulary, or refuse BEFORE a request is sent. */
  mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor): { ok: true; value: unknown } | { ok: false; reason: string };
  capabilities(model: WinterModelDescriptor): { toolCalling: ToolCalling; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed" };
}
