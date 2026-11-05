// THE PIN on the catalog row schema (`row.ts`): no drift from the catalog schema, a pinned hash per
// version, and every shipped row valid against it.
import { describe, expect, test } from "bun:test";
import catalogSchema from "../schema/catalog.schema.json" with { type: "json" };
import rowSchema from "../schema/catalog-row.schema.json" with { type: "json" };
import { CATALOG_ROW_SCHEMA, CATALOG_ROW_SCHEMA_ID, CATALOG_ROW_SCHEMA_SHA256, CATALOG_ROW_SCHEMA_VERSION, buildCatalogRowSchema, canonicalJson, loadCatalog, validateCatalogRows } from "./index.ts";
import type { WinterModelDescriptor } from "./types.ts";

describe("the catalog row schema is pinned", () => {
  test("the committed row schema is exactly what the catalog schema defines (no drift)", () => {
    expect(rowSchema).toEqual(buildCatalogRowSchema(catalogSchema as never) as never);
    expect(rowSchema.$id).toBe(CATALOG_ROW_SCHEMA_ID);
    expect(CATALOG_ROW_SCHEMA).toEqual(rowSchema as never);
    expect(CATALOG_ROW_SCHEMA_ID).toBe(`urn:waifucave:clover:catalog-row:${CATALOG_ROW_SCHEMA_VERSION}`);
  });

  test(`version ${CATALOG_ROW_SCHEMA_VERSION}'s hash: a change to a row's shape must bump the version and this pin together`, () => {
    expect(new Bun.CryptoHasher("sha256").update(canonicalJson(rowSchema)).digest("hex")).toBe(CATALOG_ROW_SCHEMA_SHA256);
  });

  test("every model row the SDK ships validates as a plugin's rows would, provider by provider", () => {
    const catalog = loadCatalog();
    const byProvider = new Map<string, WinterModelDescriptor[]>();
    for (const row of catalog.models) byProvider.set(row.providerId, [...(byProvider.get(row.providerId) ?? []), row]);
    expect(byProvider.size).toBeGreaterThan(100);
    const failures: string[] = [];
    for (const [providerId, rows] of byProvider) {
      const result = validateCatalogRows(rows, { providerId });
      if (!result.ok) failures.push(`${providerId}: ${result.errors.slice(0, 3).map((e) => e.message).join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("validateCatalogRows refuses what a plugin must not ship", () => {
  const good = (): WinterModelDescriptor => structuredClone(loadCatalog().models.find((m) => m.providerId === "openai")!);

  test("a valid row passes and comes back typed", () => {
    const result = validateCatalogRows([good()], { providerId: "openai" });
    expect(result.ok).toBe(true);
  });

  const cases: Array<[string, (row: Record<string, unknown>) => unknown[], string]> = [
    ["not an array", () => ({} as never), "expected an array"],
    ["a missing required field", (row) => { delete row["upstreamId"]; return [row]; }, "upstreamId"],
    ["a key that is not <providerId>/<upstreamId>", (row) => { row["key"] = "openai/something-else"; return [row]; }, "key"],
    ["an unknown tool-calling state", (row) => { row["toolCalling"] = { value: "telepathic", source: "vendor-docs", confidence: "documented" }; return [row]; }, "toolCalling"],
    ["two rows with one key", (row) => [row, structuredClone(row)], "duplicate model key"],
    ["a row on another provider than the plugin's", (row) => { row["providerId"] = "acme"; row["key"] = `acme/${String(row["upstreamId"])}`; return [row]; }, "belong to the provider"],
    ["a credential-shaped value", (row) => { row["displayName"] = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; return [row]; }, "secret"],
  ];
  for (const [label, mutate, needle] of cases) {
    test(`refuses ${label}`, () => {
      const result = validateCatalogRows(mutate(good() as unknown as Record<string, unknown>), { providerId: "openai" });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors.map((e) => e.message).join("\n")).toContain(needle);
    });
  }
});
