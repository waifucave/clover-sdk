// Clover A-M2 (spec §3.3, §5.3 `models`): a session whose providers are its HOST's model plugins
// (`RuntimeConfig.modelProviders`, from `Options.modelProviders`).
//
// The host (Clover's core) reads every enabled `models[]` entry, builds one catalog from them
// (provider-catalog's `catalogFromModelPlugins`) and writes it to a file, content-addressed. The session:
//   * reads that file and checks its sha256 and the catalog validator, so a torn or tampered file never becomes
//     the registry (it fails the session's start, which is the host's bug to see, never a silent fallback to this
//     build's own catalog);
//   * registers the GENERIC adapters only (`createGenericAdapters`: the ones a declarative plugin's endpoint runs
//     on), built against that catalog, so each declarative provider gets its own endpoint and rows;
//   * registers a STUB for each adapter the host serves (`hostServedProviderAdapter`), whose calls ride the
//     session's control bridge to the host, which runs them on the plugin (`model_adapter_*`);
//   * registers THIS BUILD'S OWN adapter for a provider in the host's catalog whose adapter the host doesn't serve
//     (a code plugin whose host can't start here: Bedrock and Vertex run on Node, which the plugin host doesn't start
//     yet), so the provider stays on the compiled path rather than refusing every turn (Clover #302's review B3).
//     Only for a provider THIS BUILD SHIPS, on the adapter this build pairs it with: a row is never given a compiled
//     adapter by its adapterId alone. A provider this build doesn't ship (a third party's) that names a compiled
//     adapter's id gets none (`no-adapter`); if a shipped provider in the same catalog keeps that adapter, the adapter
//     refuses every call made for any other provider.
// No other adapter of this build is registered: a provider not in the host's catalog is one the session has not got.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GENERIC_ADAPTER_IDS, loadCatalog, validateCatalog, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import type { RuntimeConfig } from "@waifucave/clover-agent-sdk";
import { createGenericAdapters, createShippedAdapters, hostServedProviderAdapter, WinterProviderResolutionError, type HostModelAdapterSender, type HostServedAdapterIdentity, type ProviderAdapter, type ProviderContext } from "@waifucave/clover-provider-runtime";

export type ModelProvidersConfig = NonNullable<RuntimeConfig["modelProviders"]>;

/** What `buildSessionProvider` takes from the host's model plugins. */
export interface HostModelProviders {
  catalog: WinterCatalog;
  adapters: (catalog: WinterCatalog) => readonly ProviderAdapter[];
}

const loaded = new Map<string, WinterCatalog>();

/** Reads and checks the host's catalog file (memoised per digest: a Worker realm runs one session, a process may run several). */
export function readHostCatalog(path: string, sha256: string): WinterCatalog {
  const cached = loaded.get(sha256);
  if (cached !== undefined) return cached;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(`clover runtime: the host's model catalog could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256.toLowerCase()) throw new Error("clover runtime: the host's model catalog file does not match its digest");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("clover runtime: the host's model catalog file is not JSON");
  }
  const result = validateCatalog(json);
  if (!result.ok) throw new Error(`clover runtime: the host's model catalog is invalid (${result.errors.length} error(s)): ${result.errors.slice(0, 3).map((e) => e.message).join("; ")}`);
  loaded.set(sha256, result.catalog);
  return result.catalog;
}

/**
 * The catalog and adapters a session on the host's model plugins runs with. `sender` is the session's line to its
 * host, bound late (the control bridge exists only once the engine runs); required when the host serves adapters.
 */
export function hostModelProviders(config: ModelProvidersConfig, sender: HostModelAdapterSender | undefined): HostModelProviders {
  const catalog = readHostCatalog(config.catalogPath, config.catalogSha256);
  const served = config.hostAdapters ?? [];
  for (const a of served) {
    if (GENERIC_ADAPTER_IDS.has(a.id)) throw new Error(`clover runtime: the host may not serve ${JSON.stringify(a.id)}: it is a generic adapter's id`);
  }
  if (served.length > 0 && sender === undefined) throw new Error("clover runtime: the host serves model adapters but the session has no line to it");
  return {
    catalog,
    adapters: (c) => {
      const servedIds = new Set(served.map((a) => a.id));
      // This build's own adapters, for the catalog's providers that this build SHIPS on the adapter it pairs them
      // with, that nothing else covers (not generic, not host-served).
      const shipped = shippedAdapterOf();
      const eligible = new Set(c.providers.filter((p) => shipped.get(p.id) === p.adapterId).map((p) => p.id));
      const fallbackIds = new Set(c.providers.filter((p) => eligible.has(p.id)).map((p) => p.adapterId));
      const compiled = createShippedAdapters(c)
        .filter((a) => fallbackIds.has(a.id) && !GENERIC_ADAPTER_IDS.has(a.id) && !servedIds.has(a.id))
        .map((a) => (c.providers.some((p) => p.adapterId === a.id && !eligible.has(p.id)) ? onlyForProviders(a, eligible) : a));
      return [
        ...createGenericAdapters(c),
        ...served.map((a) => hostServedProviderAdapter({ ...(a as HostServedAdapterIdentity) }, sender!)),
        ...compiled,
      ];
    },
  };
}

/** providerId -> the adapter this build pairs it with, from this build's own catalog. */
function shippedAdapterOf(): ReadonlyMap<string, string> {
  return new Map(loadCatalog().providers.map((p) => [p.id, p.adapterId]));
}

/**
 * A compiled adapter that answers only for `providers`: a catalog that also has a provider this build doesn't ship
 * naming the same adapter id gets a refusal for that provider's calls, never this build's adapter (or its endpoint and
 * credential routing) for a provider it invented.
 */
function onlyForProviders(adapter: ProviderAdapter, providers: ReadonlySet<string>): ProviderAdapter {
  const check = (ctx: ProviderContext): void => {
    const id = ctx.connection.providerId;
    if (!providers.has(id)) throw new WinterProviderResolutionError("no-adapter", `no adapter registered for "${adapter.id}" (provider "${id}"): this build's adapter serves only the providers it ships`);
  };
  const guarded: ProviderAdapter = {
    id: adapter.id,
    version: adapter.version,
    family: adapter.family,
    protocol: adapter.protocol,
    validateCredential: async (ref, ctx) => {
      check(ctx);
      return adapter.validateCredential(ref, ctx);
    },
    listModels: async (ctx) => {
      check(ctx);
      return adapter.listModels(ctx);
    },
    streamTurn: (req, ctx) =>
      (async function* () {
        check(ctx);
        yield* adapter.streamTurn(req, ctx);
      })(),
    mapEffort: (effort, model) => adapter.mapEffort(effort, model),
    capabilities: (model) => adapter.capabilities(model),
  };
  if (adapter.countTokens !== undefined) {
    const count = adapter.countTokens.bind(adapter);
    guarded.countTokens = async (req, ctx) => {
      check(ctx);
      return count(req, ctx);
    };
  }
  return guarded;
}
