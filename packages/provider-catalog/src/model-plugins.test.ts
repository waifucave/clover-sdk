// Clover A-M2: the catalog built from model plugins. The load-bearing case is the round trip: every provider of the
// SDK's own catalog, split into a manifest entry and a catalog file (`modelPluginForProvider`, what Clover's
// generator writes) and built back (`catalogFromModelPlugins`, what Clover's core runs), gives the same providers
// and rows, so nothing a provider carried is lost in the move into plugins.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "./index.ts";
import {
  GENERIC_ADAPTER_IDS,
  adapterIdForEntry,
  catalogFromModelPlugins,
  familiesServedBy,
  modelPluginForProvider,
  readModelPluginCatalog,
  settingKeysOfTemplate,
  settingTemplateOf,
  type ModelPluginInput,
} from "./model-plugins.ts";
import type { CatalogRow } from "./row.ts";

const sdk = loadCatalog();

function inputsFor(providerIds: readonly string[]): ModelPluginInput[] {
  return providerIds.map((id) => {
    const { entry, file } = modelPluginForProvider(sdk, id);
    return { pluginId: `clover/model-${id}`, entry: { ...entry, auth: [] }, catalog: JSON.parse(JSON.stringify(file)), trusted: true };
  });
}

const byKey = (rows: readonly CatalogRow[]) => [...rows].sort((a, b) => a.key.localeCompare(b.key));

describe("catalogFromModelPlugins", () => {
  test("the SDK's whole catalog, split into plugins and built back, is the same catalog", () => {
    const built = catalogFromModelPlugins(inputsFor(sdk.providers.map((p) => p.id)), { families: sdk.families, catalogVersion: sdk.catalogVersion, upstream: sdk.upstream });
    expect(built.refused).toEqual([]);
    expect(built.catalog.providers).toEqual(sdk.providers);
    expect(byKey(built.catalog.models)).toEqual(byKey(sdk.models));
    expect(built.catalog.families).toEqual(sdk.families);
    expect(built.catalog.catalogVersion).toBe(sdk.catalogVersion);
    for (const p of sdk.providers) expect(built.adapters.get(p.id)?.adapterId).toBe(p.adapterId);
  });

  test("a provider left out takes its rows with it, and the families keep only the slots something still serves", () => {
    const without = sdk.providers.map((p) => p.id).filter((id) => id !== "anthropic");
    const built = catalogFromModelPlugins(inputsFor(without), { families: sdk.families, catalogVersion: "test" });
    expect(built.catalog.providers.some((p) => p.id === "anthropic")).toBe(false);
    expect(built.catalog.models.some((m) => m.providerId === "anthropic")).toBe(false);
    for (const family of built.catalog.families) {
      for (const slot of family.slots) {
        expect(built.catalog.models.some((m) => m.canonicalModelId === slot.canonicalModelId && (slot.provider === undefined || m.providerId === slot.provider))).toBe(true);
      }
    }
  });

  test("only the plugins' own families survive when one provider is all there is", () => {
    const built = catalogFromModelPlugins(inputsFor(["groq"]), { families: sdk.families, catalogVersion: "test" });
    expect(built.catalog.providers.map((p) => p.id)).toEqual(["groq"]);
    expect(built.catalog.families.some((f) => f.id === "claude")).toBe(false);
    const ids = new Set(built.catalog.families.map((f) => f.id));
    for (const row of built.catalog.models) expect(row.modelFamily === "other" || ids.has(row.modelFamily)).toBe(true);
  });

  test("a second plugin naming a provider already taken is refused alone; the first keeps it", () => {
    const [first] = inputsFor(["groq"]);
    const second = { ...first!, pluginId: "someone/groq-too" };
    const built = catalogFromModelPlugins([first!, second], { families: [], catalogVersion: "test" });
    expect(built.catalog.providers.map((p) => p.id)).toEqual(["groq"]);
    expect(built.adapters.get("groq")?.pluginId).toBe("clover/model-groq");
    expect(built.refused).toEqual([{ pluginId: "someone/groq-too", provider: "groq", code: "provider-taken", message: expect.stringContaining("clover/model-groq") }]);
  });

  test("bad rows and bad catalog shapes refuse their entry with a reason", () => {
    const [ok] = inputsFor(["groq"]);
    const badRows: ModelPluginInput = { pluginId: "x/bad", entry: { provider: "bad", name: "Bad", auth: [], endpoint: { protocol: "openai-chat", baseUrl: "https://bad.example/v1" } }, catalog: [{ key: "nope" }] };
    const otherProvider: ModelPluginInput = { pluginId: "x/thief", entry: { provider: "thief", name: "Thief", auth: [], endpoint: { protocol: "openai-chat", baseUrl: "https://thief.example/v1" } }, catalog: sdk.models.filter((m) => m.providerId === "groq").slice(0, 1) };
    const newer: ModelPluginInput = { pluginId: "x/newer", entry: { provider: "newer", name: "Newer", auth: [], endpoint: { protocol: "openai-chat", baseUrl: "https://newer.example/v1" } }, catalog: { catalog: 2, rows: [] } };
    const built = catalogFromModelPlugins([ok!, badRows, otherProvider, newer], { families: [], catalogVersion: "test" });
    expect(built.catalog.providers.map((p) => p.id)).toEqual(["groq"]);
    expect(built.refused.map((r) => [r.pluginId, r.code])).toEqual([["x/bad", "rows-invalid"], ["x/thief", "rows-invalid"], ["x/newer", "catalog-format-newer"]]);
  });

  test("a third party's declarative entry gets conservative defaults: review-required, no discovery, its endpoint as api", () => {
    const rows = sdk.models.filter((m) => m.providerId === "groq").slice(0, 2).map((m) => ({ ...m, key: m.key.replace(/^groq\//, "acme/"), providerId: "acme" }));
    const built = catalogFromModelPlugins([{ pluginId: "acme", entry: { provider: "acme", name: { en: "Acme" }, auth: [{ method: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://api.acme.example/v1" } }, catalog: rows }], { families: sdk.families, catalogVersion: "test" });
    expect(built.refused).toEqual([]);
    const p = built.catalog.providers[0]!;
    expect(p).toMatchObject({ id: "acme", displayName: "Acme", adapterId: "winter.openai-chat-completions", protocols: ["openai-chat-completions"], authKinds: ["api-key"], defaultEndpoints: { api: "https://api.acme.example/v1" }, modelDiscovery: "none", risk: { class: "review-required" } });
  });
});

describe("catalogFromModelPlugins: what an untrusted plugin may state (0.0.65, the A-M2 review)", () => {
  const acmeRows = () => sdk.models.filter((m) => m.providerId === "groq").slice(0, 1).map((m) => ({ ...m, key: m.key.replace(/^groq\//, "acme/"), providerId: "acme" }));
  const entry = { provider: "acme", name: { en: "Acme" }, auth: [{ method: "api-key" as const }], endpoint: { protocol: "openai-chat" as const, baseUrl: "https://api.acme.example/v1" } };

  test("an untrusted plugin's risk and admission are ignored: it can't mark itself approved", () => {
    const provider = { risk: { class: "approved", reasons: ["trust me"] }, admission: { basis: "first-party", citation: "self", tier: "core" } };
    const untrusted = catalogFromModelPlugins([{ pluginId: "acme", entry, catalog: { catalog: 1, provider, rows: acmeRows() } as never }], { families: sdk.families, catalogVersion: "test" });
    expect(untrusted.refused).toEqual([]);
    expect(untrusted.catalog.providers[0]!.risk.class).toBe("review-required");
    expect(untrusted.catalog.providers[0]!.admission.citation).toBe("plugin:acme");
  });

  test("one plugin's bad provider meta refuses that plugin alone; the others still build", () => {
    const bad = { pluginId: "acme", entry, catalog: { catalog: 1, provider: { identityHeaders: { "x-bad header": 42 } }, rows: acmeRows() } as never };
    const { entry: groqEntry, file } = modelPluginForProvider(sdk, "groq");
    const built = catalogFromModelPlugins([bad, { pluginId: "clover/model-groq", entry: { ...groqEntry, auth: [] }, catalog: file, trusted: true }], { families: sdk.families, catalogVersion: "test" });
    expect(built.refused.map((r) => [r.pluginId, r.code])).toEqual([["acme", "provider-invalid"]]);
    expect(built.catalog.providers.map((p) => p.id)).toEqual(["groq"]);
  });
});

describe("adapterIdForEntry", () => {
  const base = { pluginId: "acme/models", entry: { provider: "acme", name: "Acme", auth: [] } } as const;

  test("a declarative entry runs on its protocol's generic adapter, and a key-less loopback chat endpoint on the local one", () => {
    expect(adapterIdForEntry({ ...base, entry: { ...base.entry, auth: [{ method: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://x.example/v1" } } }, undefined)).toEqual({ ok: true, adapterId: "winter.openai-chat-completions" });
    expect(adapterIdForEntry({ ...base, entry: { ...base.entry, endpoint: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" } } }, undefined)).toEqual({ ok: true, adapterId: "winter.local-openai" });
    expect(adapterIdForEntry({ ...base, entry: { ...base.entry, endpoint: { protocol: "anthropic-messages", baseUrl: "https://x.example" } } }, undefined)).toEqual({ ok: true, adapterId: "winter.anthropic-messages" });
    expect(adapterIdForEntry({ ...base, entry: { ...base.entry, endpoint: { protocol: "openai-responses", baseUrl: "https://x.example/v1" } } }, undefined)).toEqual({ ok: true, adapterId: "winter.openai-responses" });
  });

  test("a declarative entry may name only its own protocol's generic adapters", () => {
    const r = adapterIdForEntry({ ...base, entry: { ...base.entry, endpoint: { protocol: "openai-chat", baseUrl: "https://x.example/v1" } } }, { adapterId: "winter.codex-oauth" });
    expect(r).toMatchObject({ ok: false, code: "endpoint-adapter" });
  });

  test("a code entry of a third party gets a namespaced id, whatever its catalog file claims; a trusted one keeps its own", () => {
    const code = { ...base, entry: { ...base.entry, adapter: "adapter" } };
    expect(adapterIdForEntry(code, { adapterId: "winter.openai-chat-completions" })).toEqual({ ok: true, adapterId: "plugin.acme--models.adapter" });
    expect(adapterIdForEntry({ ...code, trusted: true }, { adapterId: "winter.bedrock-converse" })).toEqual({ ok: true, adapterId: "winter.bedrock-converse" });
    expect(adapterIdForEntry({ ...code, trusted: true }, { adapterId: "winter.openai-chat-completions" })).toMatchObject({ ok: false, code: "adapter-id-generic" });
    for (const id of ["winter.openai-chat-completions", "winter.local-openai", "winter.openai-responses", "winter.anthropic-messages"]) expect(GENERIC_ADAPTER_IDS.has(id)).toBe(true);
  });

  test("an entry with both an endpoint and an adapter, or neither, is refused", () => {
    expect(adapterIdForEntry(base, undefined)).toMatchObject({ ok: false, code: "endpoint-or-adapter" });
    expect(adapterIdForEntry({ ...base, entry: { ...base.entry, adapter: "a", endpoint: { protocol: "openai-chat", baseUrl: "https://x.example" } } }, undefined)).toMatchObject({ ok: false, code: "endpoint-or-adapter" });
  });
});

describe("the catalog file and endpoint templates", () => {
  test("a catalog is rows, or a format-1 file with nothing else in it", () => {
    expect(readModelPluginCatalog([])).toEqual({ ok: true, rows: [], meta: undefined });
    expect(readModelPluginCatalog({ catalog: 1, rows: [], provider: { modelDiscovery: "none" } })).toEqual({ ok: true, rows: [], meta: { modelDiscovery: "none" } });
    expect(readModelPluginCatalog({ catalog: 1, rows: [], extra: true })).toMatchObject({ ok: false, code: "catalog-shape" });
    expect(readModelPluginCatalog("rows")).toMatchObject({ ok: false, code: "catalog-shape" });
  });

  test("a per-tenant endpoint template becomes a URL over the plugin's settings", () => {
    expect(settingTemplateOf("https://<resource>.services.ai.azure.com/openai/v1")).toBe("https://${setting:resource}.services.ai.azure.com/openai/v1");
    expect(settingTemplateOf("https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1")).toBe("https://api.cloudflare.com/client/v4/accounts/${setting:accountId}/ai/v1");
    expect(settingKeysOfTemplate("https://<account-identifier>.snowflakecomputing.com/api/v2/cortex/v1")).toEqual(["accountIdentifier"]);
  });

  test("a per-tenant provider round-trips with no api endpoint and its template", () => {
    const { entry, file } = modelPluginForProvider(sdk, "azure-ai");
    expect(entry.endpoint?.baseUrl).toBe("https://${setting:resource}.services.ai.azure.com/openai/v1");
    const built = catalogFromModelPlugins([{ pluginId: "clover/model-azure-ai", entry: { ...entry, auth: [] }, catalog: file, trusted: true }], { families: [], catalogVersion: "t" });
    expect(built.catalog.providers[0]).toEqual(sdk.providers.find((p) => p.id === "azure-ai")!);
  });
});

describe("familiesServedBy", () => {
  test("with every provider the families are unchanged", () => {
    const out = familiesServedBy(sdk.families, sdk.providers, sdk.models);
    expect(out.families).toEqual(sdk.families);
    expect(out.rows).toEqual(sdk.models);
  });
});
