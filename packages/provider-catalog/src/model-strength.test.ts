import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_STRENGTH, MODEL_STRENGTHS, loadCatalog, stampFamilyFields, strengthOfCanonicalModel, validateCatalogRows } from "./index.ts";

const catalog = loadCatalog();
const canonicalIds = new Set(catalog.models.map((m) => m.canonicalModelId));

describe("each model's class, set by hand (model-strength.ts)", () => {
  test("every canonical model in the catalog has a line (a refresh that adds a model fails until it is classed)", () => {
    const missing = [...canonicalIds].filter((id) => strengthOfCanonicalModel(id) === undefined).sort();
    expect(missing).toEqual([]);
  });

  test("no line names a model the catalog doesn't have", () => {
    const stale = Object.keys(MODEL_STRENGTH).filter((id) => !canonicalIds.has(id)).sort();
    expect(stale).toEqual([]);
  });

  test("every value is one of the three classes", () => {
    for (const [id, cls] of Object.entries(MODEL_STRENGTH)) expect({ id, ok: MODEL_STRENGTHS.includes(cls) }).toEqual({ id, ok: true });
  });

  test("the counts, pinned (a change to a class is a reviewed change here too)", () => {
    const counts = { strong: 0, medium: 0, weak: 0 };
    for (const cls of Object.values(MODEL_STRENGTH)) counts[cls]++;
    const unsure = readFileSync(join(import.meta.dir, "model-strength.ts"), "utf8").split("\n").filter((l) => /^\s+".*":\s+"(strong|medium|weak)",\s+\/\/ unsure$/.test(l)).length;
    expect({ models: Object.keys(MODEL_STRENGTH).length, ...counts, unsure }).toEqual({ models: 574, strong: 87, medium: 187, weak: 300, unsure: 236 });
  });

  test("every catalog row carries its canonical model's class, stamped at build", () => {
    for (const row of catalog.models) expect({ key: row.key, strength: row.strength }).toEqual({ key: row.key, strength: MODEL_STRENGTH[row.canonicalModelId] });
  });

  test("the owner's anchors: Claude Fable and Opus strong, Sonnet medium, Haiku weak", () => {
    expect([MODEL_STRENGTH["claude-fable-5.1"], MODEL_STRENGTH["claude-opus-5.5"], MODEL_STRENGTH["claude-sonnet-5.5"], MODEL_STRENGTH["claude-haiku-4.5"]]).toEqual(["strong", "strong", "medium", "weak"]);
  });

  test("the stamper keeps a row's own class, stamps the table's, and stamps nothing for a model the table doesn't name", () => {
    const [own, table, unknown] = stampFamilyFields([
      { upstreamId: "claude-haiku-4.5", strength: "strong" as const },
      { upstreamId: "claude-opus-5.5" },
      { upstreamId: "my-local-model-7b" },
    ], catalog.families);
    expect(own!.strength).toBe("strong");
    expect(table!.strength).toBe("strong");
    expect("strength" in unknown!).toBe(false);
  });

  test("a model plugin's row may state its class; any other value is refused; none is fine (read as weak)", () => {
    const row = catalog.models.find((m) => m.canonicalModelId === "claude-opus-5.5")!;
    const { strength: _drop, ...bare } = row;
    expect(validateCatalogRows([{ ...row, strength: "weak" }], { providerId: row.providerId }).ok).toBe(true);
    expect(validateCatalogRows([bare], { providerId: row.providerId }).ok).toBe(true);
    const bad = validateCatalogRows([{ ...row, strength: "huge" }], { providerId: row.providerId });
    expect(bad.ok).toBe(false);
  });
});
