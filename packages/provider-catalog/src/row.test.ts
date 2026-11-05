// THE PIN on the catalog row schema (`row.ts`): no drift from the catalog schema, a pinned hash per
// version, and every shipped row valid against it, by `validateCatalogRows` and by a stock JSON Schema
// validator (Ajv, draft 2020-12) reading the published file, which is necessary, not sufficient.
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
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

// Review M5: what a plugin author's own tooling sees. The published schema is NECESSARY, NOT SUFFICIENT:
// every shipped row passes it, and some rows that pass it are still refused by `validateCatalogRows`
// (the rules no JSON Schema can state). A host must run `validateCatalogRows`; the schema is for tooling.
describe("the published JSON Schema, read by a stock validator", () => {
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addFormat("date-time", { type: "string", validate: (value: string) => !Number.isNaN(Date.parse(value)) });
  const compiled = ajv.compile(rowSchema);
  // Not Ajv's type guard: its `false` branch would narrow a typed row to `never`.
  const validate = (row: unknown): boolean => compiled(row) === true;
  const good = (): Record<string, unknown> => structuredClone(loadCatalog().models.find((m) => m.providerId === "openai")!) as unknown as Record<string, unknown>;

  test("every model row the SDK ships passes it (Ajv, draft 2020-12)", () => {
    const rows = loadCatalog().models;
    expect(rows.length).toBeGreaterThan(1000);
    const failures = rows.filter((row) => !validate(row)).map((row) => `${row.key}: ${ajv.errorsText(compiled.errors)}`);
    expect(failures).toEqual([]);
  });

  test("it refuses a row of the wrong shape (it is necessary)", () => {
    const row = good();
    delete row["upstreamId"];
    expect(validate(row)).toBe(false);
    expect(validate({ ...good(), surprise: true })).toBe(false);
  });

  const onlyTheValidator: Array<[string, (row: Record<string, unknown>) => void, string]> = [
    ["a key that is not <providerId>/<upstreamId>", (row) => { row["key"] = "openai/something-else"; }, "key"],
    ["a credential-shaped display name", (row) => { row["displayName"] = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; }, "secret"],
  ];
  for (const [label, mutate, needle] of onlyTheValidator) {
    test(`it accepts ${label}, which only validateCatalogRows refuses (it is not sufficient)`, () => {
      const row = good();
      mutate(row);
      expect(validate(row)).toBe(true);
      const result = validateCatalogRows([row], { providerId: "openai" });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors.map((e) => e.message).join("\n")).toContain(needle);
    });
  }
});
