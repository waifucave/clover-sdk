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
//     session's control bridge to the host, which runs them on the plugin (`model_adapter_*`).
// No other adapter of this build is registered: a provider no plugin brings is a provider the session has not got.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GENERIC_ADAPTER_IDS, validateCatalog, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import type { RuntimeConfig } from "@waifucave/clover-agent-sdk";
import { createGenericAdapters, hostServedProviderAdapter, type HostModelAdapterSender, type HostServedAdapterIdentity, type ProviderAdapter } from "@waifucave/clover-provider-runtime";

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
    adapters: (c) => [
      ...createGenericAdapters(c),
      ...served.map((a) => hostServedProviderAdapter({ ...(a as HostServedAdapterIdentity) }, sender!)),
    ],
  };
}
