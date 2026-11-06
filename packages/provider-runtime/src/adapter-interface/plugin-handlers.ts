// A MODEL ADAPTER AS A PLUGIN'S HANDLER (Clover spec §5.3 `models`, §5.4; A-M2). A code model plugin's manifest
// entry names an export of its host module (`"adapter": "adapter"`); the core calls that export's methods through
// the plugin host (`invoke` for one value, `stream` for a turn), with structured-clone arguments and the plugin
// API in `ctx`. `modelAdapterHandlers(adapter)` is that export for a `ModelAdapter`:
//
//   describe()                                          -> the adapter's identity and interface version
//   streamTurn({ req, connection, stallTimeoutMs })     -> its events, streamed
//   listModels({ connection, stallTimeoutMs, limits })  -> a ModelCatalogResult
//   validateCredential({ connection, stallTimeoutMs })  -> a CredentialStatus
//   countTokens({ req, connection, stallTimeoutMs })    -> a number (only when the adapter counts)
//
// Each call's `AdapterContext` is built from the plugin API the call was handed: `fetch` is `ctx.api.net.fetch`,
// the core's keyed fetch (§5.4), and `secrets` is `ctx.api.secrets`, which only a process of the plugin's own has
// (§5.2). A secret's value is the credential material as JSON (`{"kind":"aws",...}`), or a bare key.
import { catalogFromModelPlugins, loadCatalog, type ModelEntry, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import { familyAdapterById } from "../adapters/index.ts";
import type { CredentialMaterial, DiscoveryContext, ProviderContext, ProviderError, ProviderEvent, TurnRequest } from "../types.ts";
import { toWireProviderError } from "./host-served.ts";
import { modelAdapterFromSigningAdapter } from "./bridge.ts";
import { modelAdapterFromProviderAdapter } from "./keyed-bridge.ts";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type AdapterSecrets, type KeyedFetch, type ModelAdapter } from "./types.ts";

/** What these handlers use of the plugin SDK's `HandlerContext`. */
export interface ModelHandlerContext {
  readonly signal: AbortSignal;
  readonly api: {
    readonly net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string | false; idleTimeoutMs?: number }): Promise<Response> };
    readonly secrets?: { get(name: string): Promise<string | undefined> };
  };
}

/** The arguments every adapter call carries. */
export interface ModelCallArgs {
  connection: AdapterContext["connection"];
  stallTimeoutMs: number;
}

/** What `describe` answers. */
export interface ModelAdapterDescription {
  interfaceVersion: typeof MODEL_ADAPTER_INTERFACE_VERSION;
  id: string;
  version: string;
  family: ModelAdapter["family"];
  protocol: ModelAdapter["protocol"];
  countTokens: boolean;
}

/** A secret's stored value as credential material: JSON material, or a bare key. */
export function materialOfSecret(value: string): CredentialMaterial {
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { kind?: unknown };
      if (parsed !== null && typeof parsed === "object" && typeof parsed.kind === "string") return parsed as CredentialMaterial;
    } catch {
      // not JSON: a bare key
    }
  }
  return { kind: "api-key", key: value };
}

function contextFor(args: ModelCallArgs, ctx: ModelHandlerContext, log: ProviderContext["log"]): AdapterContext {
  const net = ctx.api.net;
  const fetch: KeyedFetch = (url, init, options) => net.fetch(url, init as RequestInit | undefined, options);
  const secrets = ctx.api.secrets;
  const adapterSecrets: AdapterSecrets | undefined =
    secrets === undefined
      ? undefined
      : {
          get: async (name) => {
            const value = await secrets.get(name);
            return value === undefined ? null : materialOfSecret(value);
          },
        };
  return { connection: args.connection, stallTimeoutMs: args.stallTimeoutMs, fetch, log, ...(adapterSecrets !== undefined ? { secrets: adapterSecrets } : {}) };
}

/**
 * A provider failure as plain data (0.0.66, the A-M2 review): what crosses the plugin host's structured clone and the
 * control wire's JSON whole. A `ProviderRequestError` instance keeps only its message through a clone, so a session
 * used to get `{type: "error", error: {}}`, a rate limit or a refused host with no code. A failure that isn't a
 * provider error (a thrown `TypeError`, say) is a `network` error, not retryable, with its message.
 */
export function plainProviderError(err: unknown): ProviderError {
  const wire = toWireProviderError(err);
  if (wire.code !== undefined && wire.retryable !== undefined) return wire as ProviderError;
  return { code: "network", message: wire.message, retryable: false };
}

/** A turn's events with every error as plain data; a throw mid-stream ends the turn as one such `error` event. */
async function* plainEvents(events: AsyncIterable<ProviderEvent>): AsyncGenerator<ProviderEvent, void, undefined> {
  try {
    for await (const event of events) yield event.type === "error" ? { ...event, error: plainProviderError(event.error) } : event;
  } catch (err) {
    yield { type: "error", error: plainProviderError(err) };
  }
}

/** A `ModelAdapter` as the handler object a code model plugin exports. */
export function modelAdapterHandlers(adapter: ModelAdapter, opts: { log?: ProviderContext["log"] } = {}) {
  const log = opts.log ?? ((): void => {});
  const handlers = {
    describe: (): ModelAdapterDescription => ({
      interfaceVersion: adapter.interfaceVersion,
      id: adapter.id,
      version: adapter.version,
      family: adapter.family,
      protocol: adapter.protocol,
      countTokens: adapter.countTokens !== undefined,
    }),
    streamTurn: (args: ModelCallArgs & { req: Omit<TurnRequest, "signal"> }, ctx: ModelHandlerContext): AsyncIterable<ProviderEvent> =>
      plainEvents(adapter.streamTurn({ ...args.req, signal: ctx.signal } as TurnRequest, contextFor(args, ctx, log))),
    listModels: (args: ModelCallArgs & { limits: DiscoveryContext["limits"] }, ctx: ModelHandlerContext) =>
      adapter.listModels({ ...contextFor(args, ctx, log), limits: args.limits, signal: ctx.signal }),
    validateCredential: (args: ModelCallArgs, ctx: ModelHandlerContext) => adapter.validateCredential(contextFor(args, ctx, log)),
    countTokens: async (args: ModelCallArgs & { req: Omit<TurnRequest, "signal"> }, ctx: ModelHandlerContext): Promise<number> => {
      if (adapter.countTokens === undefined) throw new TypeError(`${adapter.id} does not count tokens`);
      return adapter.countTokens({ ...args.req, signal: ctx.signal } as TurnRequest, contextFor(args, ctx, log));
    },
  };
  return handlers;
}

export type ModelAdapterHandlers = ReturnType<typeof modelAdapterHandlers>;

/** The catalog of one model plugin alone: its provider and rows (and the families they serve). */
export function catalogOfModelPlugin(pluginId: string, entry: ModelEntry, catalogFile: unknown): WinterCatalog {
  const built = catalogFromModelPlugins([{ pluginId, entry, catalog: catalogFile, trusted: true }], { families: loadCatalog().families, catalogVersion: pluginId });
  if (built.refused.length > 0) throw new TypeError(`${pluginId}: ${built.refused.map((r) => r.message).join("; ")}`);
  return built.catalog;
}

export interface FamilyModelAdapterOptions {
  pluginId: string;
  /** The plugin's `models[]` entry, as its manifest has it. */
  entry: ModelEntry;
  /** The entry's catalog file, parsed. */
  catalogFile: unknown;
  /**
   * How the family adapter reaches its credential:
   *   `keyed`: keyless on the core's keyed fetch, with this `auth` entry (`modelAdapterFromProviderAdapter`), for a
   *     worker in the shared plugin host;
   *   `signing`: reading this secret with `secrets.get` (`modelAdapterFromSigningAdapter`), for a process of its own.
   */
  credential: { keyed: { name: string; material: "api-key" | "bearer" | "oauth" } | null } | { signing: string };
  /** The Codex adapter's `originator` (Clover's Codex plugin: `"clover"`). */
  codexOriginator?: string;
}

/**
 * A code model plugin's adapter: the SDK's family adapter for its catalog record's `adapterId`, built against the
 * plugin's own provider and rows, as a `ModelAdapter` that holds no key (or signs only where `secrets` exists).
 */
export function familyModelAdapter(opts: FamilyModelAdapterOptions): ModelAdapter {
  const catalog = catalogOfModelPlugin(opts.pluginId, opts.entry, opts.catalogFile);
  const provider = catalog.providers[0]!;
  const family = familyAdapterById(catalog, provider.adapterId, opts.codexOriginator !== undefined ? { codexOriginator: opts.codexOriginator } : {});
  if ("signing" in opts.credential) return modelAdapterFromSigningAdapter(family, { secret: opts.credential.signing });
  return modelAdapterFromProviderAdapter(family, opts.credential.keyed === null ? {} : { auth: opts.credential.keyed });
}
