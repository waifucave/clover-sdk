// The two bridges between the model adapter interface and `ProviderAdapter`, today's runtime seam.
//
//   providerAdapterFromModelAdapter: a model adapter (it holds no key) runs in today's runtime. Each
//     call builds the adapter's keyed fetch from the runtime's `ProviderContext`: its credential store
//     and `authRef` become the one `auth` entry's token source, and its connection decides the hosts.
//     This is how a plugin's adapter reaches the engine until the plugin host carries calls itself.
//
//   modelAdapterFromSigningAdapter: a `ProviderAdapter` that must SIGN with its secret (Bedrock's
//     SigV4) becomes a model adapter that reads that secret with `ctx.secrets.get` -- and so runs only
//     where `secrets` exists, a process of the plugin's own (`own-process.ts`, §5.2). Anywhere else it
//     refuses, typed, before anything is sent.
import type { ConnectionProfile, CredentialMaterial, CredentialRef, CredentialStatus, CredentialStore, ProviderAdapter, ProviderContext } from "../types.ts";
import { ProviderRequestError, runWithProviderTransport } from "../http.ts";
import { createKeyedFetch, type KeyPlacement } from "./keyed-fetch.ts";
import { keyedTransport, withTransport } from "./keyed-bridge.ts";
import { tokenSourceFromCredentialStore } from "./token-source.ts";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type AdapterSecrets, type ModelAdapter } from "./types.ts";

export interface ModelAdapterBridgeOptions {
  /** The hosts a call may reach: the plugin's `network:` hosts, for this connection. */
  hosts(connection: ConnectionProfile): readonly string[];
  /** The name the adapter gives its one `auth` entry. Default `"default"`. */
  authName?: string;
  /** Where that entry's key goes, as its manifest declares it. Default `Authorization: Bearer`. */
  placement?: KeyPlacement;
  /** The keyed fetch's idle limit (a test seam). */
  idleTimeoutMs?: number;
}

export function providerAdapterFromModelAdapter(adapter: ModelAdapter, options: ModelAdapterBridgeOptions): ProviderAdapter {
  const authName = options.authName ?? "default";
  const contextFor = (ctx: ProviderContext, ref: CredentialRef): AdapterContext => ({
    connection: ctx.connection,
    stallTimeoutMs: ctx.stallTimeoutMs,
    log: ctx.log,
    fetch: createKeyedFetch({
      hosts: options.hosts(ctx.connection),
      auth: ref.kind === "none" ? {} : { [authName]: { source: tokenSourceFromCredentialStore(ctx.credentials, ref), ...(options.placement === undefined ? {} : { placement: options.placement }) } },
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    }),
  });
  const bridged: ProviderAdapter = {
    id: adapter.id,
    version: adapter.version,
    family: adapter.family,
    protocol: adapter.protocol,
    validateCredential: (ref, ctx) => adapter.validateCredential(contextFor(ctx, ref)),
    listModels: (ctx) => adapter.listModels({ ...contextFor(ctx, ctx.authRef), limits: ctx.limits, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }),
    streamTurn: (req, ctx) => adapter.streamTurn(req, contextFor(ctx, ctx.authRef)),
    mapEffort: (effort, model) => adapter.mapEffort(effort, model),
    capabilities: (model) => adapter.capabilities(model),
  };
  if (adapter.countTokens !== undefined) {
    const count = adapter.countTokens.bind(adapter);
    bridged.countTokens = (req, ctx) => count(req, contextFor(ctx, ctx.authRef));
  }
  return bridged;
}

/** A read-only store over `secrets.get`: every reference resolves to the one named secret. */
function secretsStore(secrets: AdapterSecrets, name: string): CredentialStore {
  const readOnly = (): never => {
    throw new ProviderRequestError({ code: "capability", message: "a plugin's own process reads its secrets; it never writes them", retryable: false });
  };
  return {
    get: async (): Promise<CredentialMaterial | null> => secrets.get(name),
    set: async () => readOnly(),
    delete: async () => readOnly(),
  };
}

export interface SigningAdapterOptions {
  /** The plugin's secret the adapter signs with (`secrets.get(name)`). */
  secret: string;
}

export function modelAdapterFromSigningAdapter(adapter: ProviderAdapter, options: SigningAdapterOptions): ModelAdapter {
  const ref: CredentialRef = { kind: "keychain", account: options.secret };
  const contextFor = (ctx: AdapterContext): ProviderContext => {
    if (ctx.secrets === undefined) {
      throw new ProviderRequestError({
        code: "capability",
        message: `the ${adapter.id} adapter signs requests with its secret, so it runs only in a process of its own, where secrets.get exists (spec §5.2)`,
        retryable: false,
      });
    }
    return { connection: ctx.connection, credentials: secretsStore(ctx.secrets, options.secret), authRef: ref, stallTimeoutMs: ctx.stallTimeoutMs, log: ctx.log };
  };
  // 0.0.65 (A-M2 review B3): every request the adapter makes goes out through the plugin's `net.fetch`, so the host
  // limit (its `network:` capabilities) holds for a signing adapter too. It signs the request itself, so the keyed
  // fetch adds no key (`auth: false`); a request to a host the plugin didn't declare is refused there.
  const transportOf = (ctx: AdapterContext) => keyedTransport(ctx.fetch, undefined, undefined);
  const model: ModelAdapter = {
    interfaceVersion: MODEL_ADAPTER_INTERFACE_VERSION,
    id: adapter.id,
    version: adapter.version,
    family: adapter.family,
    protocol: adapter.protocol,
    validateCredential: async (ctx): Promise<CredentialStatus> => {
      const pctx = contextFor(ctx);
      return runWithProviderTransport(transportOf(ctx), () => adapter.validateCredential(ref, pctx));
    },
    listModels: (ctx) => {
      const pctx = contextFor(ctx);
      return runWithProviderTransport(transportOf(ctx), () => adapter.listModels({ ...pctx, limits: ctx.limits, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }));
    },
    streamTurn: (req, ctx) => {
      const pctx = contextFor(ctx);
      return withTransport(transportOf(ctx), () => adapter.streamTurn(req, pctx));
    },
    mapEffort: (effort, descriptor) => adapter.mapEffort(effort, descriptor),
    capabilities: (descriptor) => adapter.capabilities(descriptor),
  };
  if (adapter.countTokens !== undefined) {
    const count = adapter.countTokens.bind(adapter);
    model.countTokens = (req, ctx) => {
      const pctx = contextFor(ctx);
      return runWithProviderTransport(transportOf(ctx), () => count(req, pctx));
    };
  }
  return model;
}
