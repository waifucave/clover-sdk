// THE MODEL PLUGIN CATALOG (Clover spec §3.3, §5.3 `models`, §5.9 `Model`): how the models a host's plugins
// contribute become the catalog the SDK resolves against. Clover A-M2.
//
// The SDK ships no providers (§3.3): every provider is a plugin's `models[]` entry,
//
//   { provider, name, catalog: <path> | <rows>, auth: [...], endpoint?: { protocol, baseUrl }, adapter?: <handler> }
//
// and the host (Clover's core) reads each enabled entry, hands this module the entry and its catalog, and gets back
// one `WinterCatalog`: a provider descriptor per entry and every entry's rows. Nothing here reads a file or runs
// plugin code; it is data in, data out, like the rest of this package.
//
// THE CATALOG FILE. A `catalog` path names a JSON file in the plugin folder, in one of two shapes:
//   * an array of rows (the catalog row schema, `row.ts`), which is all a third-party plugin needs; or
//   * `{ "catalog": 1, "provider": { ... }, "rows": [ ... ] }`, a model plugin catalog file (format 1), whose
//     `provider` adds what a manifest entry has no field for: how the provider lists its models, its identity
//     headers, its per-tenant endpoint template, its risk and admission records (`ProviderMeta`). The plugins
//     Clover bundles are generated in this shape from the SDK's own catalog, so nothing a provider carried is lost
//     in the move.
//
// WHICH ADAPTER SERVES AN ENTRY.
//   * A declarative entry (`endpoint`) runs on the SDK's GENERIC adapter for its protocol: `openai-chat` on the
//     chat-completions adapter (the local-runner adapter for a key-less loopback endpoint), `openai-responses` on
//     the Responses adapter, `anthropic-messages` on the Messages adapter (`GENERIC_ENDPOINT_ADAPTERS`). A
//     catalog file may name one of its protocol's generic adapters, never any other.
//   * A code entry (`adapter`) runs on the plugin's own adapter, which the host serves. Its adapter id is the
//     one its catalog file names when the plugin is the host's own bundled tree (`trustedAdapterIds`: the ids
//     Clover's own logic keys on stay what they were), and `plugin.<plugin id>.<handler>` otherwise, so a third
//     party can never take over a generic adapter's id or another plugin's.
import type { CatalogRow } from "./row.ts";
import type { CatalogValidationError, ModelFamilyDescriptor, ProviderAuthKind, ProviderProtocol, WinterCatalog, WinterProviderDescriptor } from "./types.ts";
import { OTHER_FAMILY_ID, isSlotServableRow } from "./families.ts";
import { validateCatalog, validateCatalogRows } from "./validate.ts";

/** The model plugin catalog file's format number (`{ "catalog": 1, ... }`). */
export const MODEL_PLUGIN_CATALOG_FORMAT = 1 as const;

/** The protocols a declarative endpoint speaks: the manifest's `models[].endpoint.protocol` (spec §5.9). */
export type EndpointProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export const ENDPOINT_PROTOCOLS: readonly EndpointProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages"];

/** The SDK's generic adapters, by the endpoint protocol they serve; the first is the default. */
export const GENERIC_ENDPOINT_ADAPTERS: Readonly<Record<EndpointProtocol, readonly string[]>> = {
  "openai-chat": ["winter.openai-chat-completions", "winter.local-openai"],
  "openai-responses": ["winter.openai-responses"],
  "anthropic-messages": ["winter.anthropic-messages"],
};

/** Every generic adapter id. A code entry may never use one. */
export const GENERIC_ADAPTER_IDS: ReadonlySet<string> = new Set(Object.values(GENERIC_ENDPOINT_ADAPTERS).flat());

/** The catalog's wire protocol for an endpoint protocol. */
export const WIRE_PROTOCOL_OF_ENDPOINT: Readonly<Record<EndpointProtocol, ProviderProtocol>> = {
  "openai-chat": "openai-chat-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

/** What a model plugin catalog file's `provider` may say: every provider field but those the manifest entry
 *  carries (its id is `provider`, its name `name`). All optional; `providerDescriptorForEntry` fills the rest. */
export type ProviderMeta = Partial<Omit<WinterProviderDescriptor, "id" | "displayName">>;

/** A model plugin catalog file (format 1). */
export interface ModelPluginCatalogFile {
  catalog: typeof MODEL_PLUGIN_CATALOG_FORMAT;
  provider?: ProviderMeta;
  rows: CatalogRow[];
}

/** The parts of a manifest `models[]` entry this module reads (plugin SDK `Model`). */
export interface ModelEntry {
  provider: string;
  /** The manifest's `Text`: a string, or translations with English required. */
  name: string | { en: string; [lang: string]: string };
  auth: ReadonlyArray<{ method: "api-key" | "oauth-pkce" | "custom"; placement?: { header: string; scheme?: string } }>;
  endpoint?: { protocol: EndpointProtocol; baseUrl: string };
  adapter?: string;
}

/** One enabled entry, as the host read it. */
export interface ModelPluginInput {
  /** The plugin's id (`clover/model-openai`). */
  pluginId: string;
  /** Where in the manifest (`models/0`), for error paths. */
  ref?: string;
  entry: ModelEntry;
  /** The entry's `catalog`: the parsed file, or the inline rows. */
  catalog: unknown;
  /** True for a plugin of the host's own bundled tree, whose catalog file's `adapterId` is used as is. */
  trusted?: boolean;
}

/** A refused entry: the rest of the catalog still builds (§5.1 "only that entry is refused"). */
export interface ModelPluginRefusal {
  pluginId: string;
  ref?: string;
  provider: string;
  code: string;
  message: string;
}

/** Splits a parsed catalog value into rows and provider meta. */
export function readModelPluginCatalog(value: unknown): { ok: true; rows: unknown; meta: ProviderMeta | undefined } | { ok: false; code: string; message: string } {
  if (Array.isArray(value)) return { ok: true, rows: value, meta: undefined };
  if (value === null || typeof value !== "object") return { ok: false, code: "catalog-shape", message: "a model catalog is an array of rows or a catalog file ({ \"catalog\": 1, \"provider\"?, \"rows\" })" };
  const file = value as Record<string, unknown>;
  if (file["catalog"] !== MODEL_PLUGIN_CATALOG_FORMAT) {
    return typeof file["catalog"] === "number" && file["catalog"] > MODEL_PLUGIN_CATALOG_FORMAT
      ? { ok: false, code: "catalog-format-newer", message: `catalog format ${String(file["catalog"])} needs a newer SDK (this one reads ${MODEL_PLUGIN_CATALOG_FORMAT})` }
      : { ok: false, code: "catalog-shape", message: `a catalog file says "catalog": ${MODEL_PLUGIN_CATALOG_FORMAT}` };
  }
  for (const key of Object.keys(file)) {
    if (key !== "catalog" && key !== "provider" && key !== "rows") return { ok: false, code: "catalog-shape", message: `a catalog file has no field ${JSON.stringify(key)}` };
  }
  const meta = file["provider"];
  if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta))) return { ok: false, code: "catalog-shape", message: "a catalog file's `provider` is an object" };
  return { ok: true, rows: file["rows"], meta: meta as ProviderMeta | undefined };
}

/** The English name of a manifest `Text`. */
export function textOf(name: ModelEntry["name"]): string {
  return typeof name === "string" ? name : name.en;
}

/** The catalog's auth kinds for an entry's `auth`: none at all is `local-none`. */
export function authKindsOf(entry: ModelEntry): ProviderAuthKind[] {
  if (entry.auth.length === 0) return ["local-none"];
  const kinds = entry.auth.map((a): ProviderAuthKind => (a.method === "api-key" ? "api-key" : a.method === "oauth-pkce" ? "oauth-approved" : "custom"));
  return [...new Set(kinds)];
}

/** A URL whose host is to be filled from the plugin's settings (`https://${setting:resource}.example.com`). */
export function isInterpolatedUrl(url: string): boolean {
  return url.includes("${");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The adapter id an entry runs on, or why it can't run. */
export function adapterIdForEntry(input: Pick<ModelPluginInput, "pluginId" | "entry" | "trusted">, meta: ProviderMeta | undefined): { ok: true; adapterId: string } | { ok: false; code: string; message: string } {
  const { entry } = input;
  if ((entry.endpoint === undefined) === (entry.adapter === undefined)) {
    return { ok: false, code: "endpoint-or-adapter", message: "a model has either a compatible `endpoint` (data) or an `adapter` (code), not both or neither" };
  }
  if (entry.endpoint !== undefined) {
    const generic = GENERIC_ENDPOINT_ADAPTERS[entry.endpoint.protocol];
    if (generic === undefined) return { ok: false, code: "endpoint-protocol", message: `no generic adapter speaks ${JSON.stringify(entry.endpoint.protocol)}` };
    if (meta?.adapterId !== undefined) {
      if (!generic.includes(meta.adapterId)) {
        return { ok: false, code: "endpoint-adapter", message: `an ${entry.endpoint.protocol} endpoint runs on ${generic.join(" or ")}, not ${JSON.stringify(meta.adapterId)}` };
      }
      return { ok: true, adapterId: meta.adapterId };
    }
    // A key-less loopback chat endpoint is a local runner: the local adapter lists what the runner has loaded.
    if (entry.endpoint.protocol === "openai-chat" && entry.auth.length === 0 && isLoopbackUrl(entry.endpoint.baseUrl)) return { ok: true, adapterId: "winter.local-openai" };
    return { ok: true, adapterId: generic[0]! };
  }
  const handler = entry.adapter!;
  if (input.trusted === true && meta?.adapterId !== undefined) {
    if (GENERIC_ADAPTER_IDS.has(meta.adapterId)) return { ok: false, code: "adapter-id-generic", message: `${JSON.stringify(meta.adapterId)} is a generic adapter's id; a plugin's own adapter has its own` };
    return { ok: true, adapterId: meta.adapterId };
  }
  return { ok: true, adapterId: `plugin.${input.pluginId.replaceAll("/", "--")}.${handler}` };
}

/**
 * The provider descriptor for one entry: the entry's own fields, its catalog file's `provider` meta, and
 * conservative defaults for the rest (a third-party provider is `review-required`, discovers nothing and states no
 * catalog authority).
 */
export function providerDescriptorForEntry(input: Pick<ModelPluginInput, "pluginId" | "entry" | "trusted">, meta: ProviderMeta | undefined, adapterId: string): WinterProviderDescriptor {
  const { entry } = input;
  const endpointApi = entry.endpoint !== undefined && !isInterpolatedUrl(entry.endpoint.baseUrl) ? { api: entry.endpoint.baseUrl } : {};
  const defaultEndpoints = { ...(meta?.defaultEndpoints ?? {}), ...endpointApi };
  if (entry.endpoint !== undefined && isInterpolatedUrl(entry.endpoint.baseUrl)) delete defaultEndpoints["api"];
  const protocols: ProviderProtocol[] = meta?.protocols ?? (entry.endpoint !== undefined ? [WIRE_PROTOCOL_OF_ENDPOINT[entry.endpoint.protocol]] : ["custom"]);
  const family = meta?.family ?? (entry.endpoint?.protocol === "anthropic-messages" ? "anthropic" : entry.endpoint !== undefined ? "openai" : "custom");
  const authKinds = meta?.authKinds ?? authKindsOf(entry);
  const local = authKinds.length === 1 && authKinds[0] === "local-none";
  const descriptor: WinterProviderDescriptor = {
    id: entry.provider,
    displayName: textOf(entry.name),
    protocols,
    authKinds,
    defaultEndpoints,
    modelDiscovery: meta?.modelDiscovery ?? (adapterId === "winter.local-openai" ? "local" : "none"),
    liveCatalogAuthority: meta?.liveCatalogAuthority ?? "unknown",
    adapterId,
    family,
    upstream: meta?.upstream ?? { project: "winter", commit: "", sourcePaths: [`plugin:${input.pluginId}`] },
    risk: meta?.risk ?? { class: "review-required", reasons: [`added by the model plugin ${input.pluginId}`] },
    scope: meta?.scope ?? "llm",
    pricingBasis: meta?.pricingBasis ?? (local ? "free" : "token"),
    admission: meta?.admission ?? { basis: local ? "local" : "api-key", citation: `plugin:${input.pluginId}`, tier: local ? "local" : "audit" },
  };
  if (meta?.identityHeaders !== undefined) descriptor.identityHeaders = meta.identityHeaders;
  if (meta?.requiresUserEndpoint === true || (entry.endpoint !== undefined && isInterpolatedUrl(entry.endpoint.baseUrl))) descriptor.requiresUserEndpoint = true;
  if (meta?.endpointTemplate !== undefined) descriptor.endpointTemplate = meta.endpointTemplate;
  return descriptor;
}

/**
 * The families a set of providers and rows can serve: a slot whose model no row serves, or whose pinned provider
 * isn't installed, is dropped; the `claude` family, whose four slots are pinned (D25), stays only whole; a row
 * whose family is gone reads as `other`. With every bundled plugin on, nothing changes.
 */
export function familiesServedBy(families: readonly ModelFamilyDescriptor[], providers: readonly WinterProviderDescriptor[], rows: readonly CatalogRow[]): { families: ModelFamilyDescriptor[]; rows: CatalogRow[] } {
  const blocked = new Set(providers.filter((p) => p.risk.class === "blocked").map((p) => p.id));
  const servers = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!isSlotServableRow(row, blocked)) continue;
    const set = servers.get(row.canonicalModelId) ?? new Set<string>();
    set.add(row.providerId);
    servers.set(row.canonicalModelId, set);
  }
  const servable = (slot: ModelFamilyDescriptor["slots"][number]): boolean => {
    const by = servers.get(slot.canonicalModelId);
    return by !== undefined && (slot.provider === undefined || slot.provider.length === 0 || by.has(slot.provider));
  };
  const kept: ModelFamilyDescriptor[] = [];
  for (const family of families) {
    const slots = family.slots.filter(servable);
    if (family.id === "claude" && slots.length !== family.slots.length) continue;
    kept.push(slots.length === family.slots.length ? family : { ...family, slots });
  }
  const ids = new Set(kept.map((f) => f.id));
  const outRows = rows.map((row) => (row.modelFamily === OTHER_FAMILY_ID || ids.has(row.modelFamily) ? row : { ...row, modelFamily: OTHER_FAMILY_ID }));
  return { families: kept, rows: outRows };
}

export interface CatalogFromModelPluginsOptions {
  /** The model families (the SDK's curated lineups, `loadCatalog().families`); pruned to what the plugins serve. */
  families: readonly ModelFamilyDescriptor[];
  /** The catalog's version string; the host's own (a digest of what it read, say). */
  catalogVersion: string;
  /** The upstream pin the catalog reports. Default: none (empty strings). */
  upstream?: WinterCatalog["upstream"];
}

export interface CatalogFromModelPluginsResult {
  /** Every entry that was not refused, validated as one catalog (`validateCatalog`). */
  catalog: WinterCatalog;
  /** Each entry's adapter id, by provider id (what a host serves for a code entry). */
  adapters: Map<string, { adapterId: string; pluginId: string; handler?: string; ref?: string }>;
  refused: ModelPluginRefusal[];
}

/**
 * Builds the catalog the SDK resolves against from a host's enabled model entries, in the host's order. An entry
 * whose catalog is malformed, whose rows fail the row schema, whose provider id is already taken (the first
 * enabled keeps it, §5.1 "Entry ids") or which names an adapter it may not use is refused alone, with the reason;
 * the rest still build. Throws only if the surviving catalog fails `validateCatalog`, which is a defect in this
 * function, not in a plugin.
 */
export function catalogFromModelPlugins(inputs: readonly ModelPluginInput[], options: CatalogFromModelPluginsOptions): CatalogFromModelPluginsResult {
  const refused: ModelPluginRefusal[] = [];
  const providers: WinterProviderDescriptor[] = [];
  const rows: CatalogRow[] = [];
  const adapters = new Map<string, { adapterId: string; pluginId: string; handler?: string; ref?: string }>();
  const seenKeys = new Set<string>();
  const refuse = (input: ModelPluginInput, code: string, message: string): void => {
    refused.push({ pluginId: input.pluginId, ...(input.ref !== undefined ? { ref: input.ref } : {}), provider: input.entry.provider, code, message });
  };
  for (const input of inputs) {
    if (adapters.has(input.entry.provider)) {
      refuse(input, "provider-taken", `the provider id ${JSON.stringify(input.entry.provider)} is taken by ${adapters.get(input.entry.provider)!.pluginId}`);
      continue;
    }
    const read = readModelPluginCatalog(input.catalog);
    if (!read.ok) {
      refuse(input, read.code, read.message);
      continue;
    }
    const checked = validateCatalogRows(read.rows, { providerId: input.entry.provider });
    if (!checked.ok) {
      refuse(input, "rows-invalid", `${checked.errors.length} row error(s): ${checked.errors.slice(0, 3).map((e: CatalogValidationError) => e.message).join("; ")}`);
      continue;
    }
    const clash = checked.rows.find((r) => seenKeys.has(r.key));
    if (clash !== undefined) {
      refuse(input, "row-key-taken", `the model key ${JSON.stringify(clash.key)} is another provider's`);
      continue;
    }
    const adapter = adapterIdForEntry(input, read.meta);
    if (!adapter.ok) {
      refuse(input, adapter.code, adapter.message);
      continue;
    }
    providers.push(providerDescriptorForEntry(input, read.meta, adapter.adapterId));
    for (const row of checked.rows) {
      seenKeys.add(row.key);
      rows.push(row);
    }
    adapters.set(input.entry.provider, { adapterId: adapter.adapterId, pluginId: input.pluginId, ...(input.entry.adapter !== undefined ? { handler: input.entry.adapter } : {}), ...(input.ref !== undefined ? { ref: input.ref } : {}) });
  }
  const served = familiesServedBy(options.families, providers, rows);
  const candidate = {
    schemaVersion: 2 as const,
    catalogVersion: options.catalogVersion,
    upstream: options.upstream ?? { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers,
    models: served.rows,
    families: served.families,
  };
  const validated = validateCatalog(candidate);
  if (!validated.ok) {
    throw new Error(`catalogFromModelPlugins: the catalog built from ${providers.length} provider(s) is invalid (${validated.errors.length} error(s)) -- a defect in the builder, not a plugin:\n  ${validated.errors.slice(0, 10).map((e) => e.message).join("\n  ")}`);
  }
  return { catalog: validated.catalog, adapters, refused };
}

/** The handler a generated code plugin's entry names: its host module exports its adapter as `adapter`. */
export const CODE_ADAPTER_HANDLER = "adapter";

/**
 * The other way, for a generator: one provider of a catalog as a model plugin's manifest entry and its catalog
 * file. The entry holds what the manifest's `Model` has a field for; the file's `provider` holds the rest.
 * `catalogFromModelPlugins` over every provider's output gives back the same providers and rows.
 */
export function modelPluginForProvider(catalog: WinterCatalog, providerId: string): { entry: Omit<ModelEntry, "auth">; file: ModelPluginCatalogFile } {
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (provider === undefined) throw new Error(`modelPluginForProvider: no provider ${JSON.stringify(providerId)}`);
  const { id: _id, displayName, ...meta } = provider;
  const protocol = (Object.keys(GENERIC_ENDPOINT_ADAPTERS) as EndpointProtocol[]).find((p) => GENERIC_ENDPOINT_ADAPTERS[p].includes(provider.adapterId));
  const rows = catalog.models.filter((m) => m.providerId === providerId);
  if (protocol === undefined) return { entry: { provider: providerId, name: displayName, adapter: CODE_ADAPTER_HANDLER }, file: { catalog: MODEL_PLUGIN_CATALOG_FORMAT, provider: meta, rows } };
  const api = provider.defaultEndpoints["api"];
  const baseUrl = api !== undefined && api.length > 0 ? api : provider.endpointTemplate !== undefined ? settingTemplateOf(provider.endpointTemplate) : undefined;
  if (baseUrl === undefined) throw new Error(`modelPluginForProvider: ${providerId} runs on a generic adapter but has neither an api endpoint nor a template`);
  const { api: _api, ...otherEndpoints } = provider.defaultEndpoints;
  return {
    entry: { provider: providerId, name: displayName, endpoint: { protocol, baseUrl } },
    file: { catalog: MODEL_PLUGIN_CATALOG_FORMAT, provider: { ...meta, defaultEndpoints: otherEndpoints }, rows },
  };
}

/** `https://<resource>.example.com/v1` as a manifest URL whose placeholders are the plugin's settings
 *  (`https://${setting:resource}.example.com/v1`), and the setting keys it names. */
export function settingTemplateOf(template: string): string {
  return template.replace(/<([a-z][a-z0-9-]*)>/gi, (_m, name: string) => `\${setting:${toSettingKey(name)}}`);
}

/** The setting keys a template names (`<account-id>` is `accountId`). */
export function settingKeysOfTemplate(template: string): string[] {
  return [...template.matchAll(/<([a-z][a-z0-9-]*)>/gi)].map((m) => toSettingKey(m[1]!));
}

function toSettingKey(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}
