// THE CATALOG ROW SCHEMA (Clover spec §3.3, §5.9): what one model row is, for every model plugin.
//
// A model plugin's manifest names its catalog (`models[].catalog: Path | object[]`, "rows follow the
// SDK catalog schema"). This file pins that schema: the SDK's own `WinterModelDescriptor`, as a
// standalone, VERSIONED JSON Schema (`schema/catalog-row.schema.json`) and a validator for a plugin's
// rows (`validateCatalogRows`), so a plugin author, the plugin registry and the SDK all read the same
// definition.
//
// HOW IT IS PINNED (`row.test.ts`):
//   * the committed row schema is exactly what `buildCatalogRowSchema` derives from the catalog schema
//     (`schema/catalog.schema.json`), so the two cannot drift apart;
//   * its canonical hash is pinned beside `CATALOG_ROW_SCHEMA_VERSION`, so any change to a row's shape
//     fails a test until the version is bumped and the pin updated together;
//   * every model row the SDK ships validates against it, provider by provider.
//
// Version 1 is the row as the catalog's schemaVersion 2 defines it. An ADDITIVE change (a new optional
// field) keeps the version; anything else (a new required field, a narrowed vocabulary, a removed
// field) bumps it, and a plugin built against version N names it.
import catalogRowSchema from "../schema/catalog-row.schema.json" with { type: "json" };
import type { CatalogValidationError, WinterModelDescriptor } from "./types.ts";

/** The row schema's contract number. */
export const CATALOG_ROW_SCHEMA_VERSION = 1 as const;

/**
 * The pinned hash (sha256 of `canonicalJson`) of `schema/catalog-row.schema.json` at this version. A
 * change to the row's shape changes it; `row.test.ts` then fails until the version and this pin move
 * together.
 */
export const CATALOG_ROW_SCHEMA_SHA256 = "b49824cf42f093fb751a2d93b28bbcb8d2a85466678e13e908aaa68b643ae57e";

/** The row schema's `$id`: a name, not a URL to fetch (the schema ships in this package). */
export const CATALOG_ROW_SCHEMA_ID = `urn:waifucave:clover:catalog-row:${CATALOG_ROW_SCHEMA_VERSION}`;

/** The row schema itself (`schema/catalog-row.schema.json`), for a host or a plugin's tooling to validate against. */
export const CATALOG_ROW_SCHEMA: Readonly<Record<string, unknown>> = catalogRowSchema as Record<string, unknown>;

/** One catalog row, as a model plugin supplies it. */
export type CatalogRow = WinterModelDescriptor;

type JsonSchema = Record<string, unknown>;

/** Every `#/$defs/<name>` a schema fragment refers to, transitively. */
function referencedDefs(root: unknown, defs: Record<string, unknown>, into: Set<string>): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        const name = value.slice("#/$defs/".length);
        if (!into.has(name)) {
          into.add(name);
          visit(defs[name]);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(root);
}

/**
 * The row schema, derived from the catalog schema: its `WinterModelDescriptor` definition and every
 * definition that one refers to, under the row schema's own `$id`.
 */
export function buildCatalogRowSchema(catalogSchema: JsonSchema): JsonSchema {
  const defs = (catalogSchema["$defs"] ?? {}) as Record<string, unknown>;
  if (defs["WinterModelDescriptor"] === undefined) throw new TypeError("the catalog schema has no WinterModelDescriptor definition");
  const needed = new Set<string>(["WinterModelDescriptor"]);
  referencedDefs(defs["WinterModelDescriptor"], defs, needed);
  const rowDefs: Record<string, unknown> = {};
  for (const name of [...needed].sort()) rowDefs[name] = defs[name];
  return {
    $schema: catalogSchema["$schema"],
    $id: CATALOG_ROW_SCHEMA_ID,
    title: "CloverCatalogRow",
    description: `One model row of a model plugin's catalog (Clover spec §3.3, §5.9), version ${CATALOG_ROW_SCHEMA_VERSION}: the SDK catalog's own model descriptor. A plugin's catalog is an array of these.`,
    $ref: "#/$defs/WinterModelDescriptor",
    $defs: rowDefs,
  };
}

/** JSON with every object's keys sorted: the form the row schema's hash is taken over. */
export function canonicalJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(Object.keys(node as Record<string, unknown>).sort().map((key) => [key, sort((node as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(value));
}

export type CatalogRowsValidationResult = { ok: true; rows: CatalogRow[] } | { ok: false; errors: CatalogValidationError[] };
