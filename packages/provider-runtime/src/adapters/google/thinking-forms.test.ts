// The Google adapter sends each row's thinking control in the form the ROW declares (`reasoning.effortRequest`):
//   - a LEVEL row (`thinkingConfig.thinkingLevel` + `levels`, the Gemini 4 rows) gets `{ thinkingLevel }` and never a
//     budget: Vertex documents a budget on Gemini 4 as a 400, and a budget beside a level as an error;
//   - every other row keeps the budget ladder, byte for byte;
//   - no effort sends no `thinkingConfig` at all, and an effort on a row that declares none is refused before sending.
// The bodies below are the exact `generationConfig` JSON the request carries (both the AI Studio and the Vertex
// transport send `buildRequestBody`'s result as it is).
import { describe, expect, test } from "bun:test";
import { loadCatalog, type WinterModelDescriptor } from "@waifucave/clover-provider-catalog";
import type { ProviderContext, TurnRequest } from "../../types.ts";
import { buildRequestBody, findDescriptor } from "./generate-content.ts";

const catalog = loadCatalog();
const row = (providerId: string, model: string): WinterModelDescriptor => {
  const found = findDescriptor(catalog, providerId, model);
  expect(found).toBeDefined();
  return found!;
};
const ctx = (providerId: string): ProviderContext => ({ connection: { providerId }, log() {} }) as unknown as ProviderContext;
const turn = (model: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({ model, messages: [{ role: "user", content: "hi" }], ...extra }) as TurnRequest;

function generationConfig(providerId: string, model: string, extra: Partial<TurnRequest> = {}): Record<string, unknown> {
  const body = buildRequestBody(turn(model, extra), row(providerId, model), {}, ctx(providerId));
  // Through JSON, as the transport sends it.
  return (JSON.parse(JSON.stringify(body)) as { generationConfig: Record<string, unknown> }).generationConfig;
}
const thinkingOf = (providerId: string, model: string, extra: Partial<TurnRequest> = {}): unknown => generationConfig(providerId, model, extra)["thinkingConfig"];

describe("a level row (Gemini 4) is sent a named level and never a budget", () => {
  for (const [providerId, model] of [["google", "gemini-4-hydrogen"], ["google", "gemini-4-argon"], ["vertex", "gemini-4-argon"]] as const) {
    test(`${providerId}/${model}: low, medium, high`, () => {
      expect(thinkingOf(providerId, model, { effort: "low" })).toEqual({ thinkingLevel: "LOW" });
      expect(thinkingOf(providerId, model, { effort: "medium" })).toEqual({ thinkingLevel: "MEDIUM" });
      expect(thinkingOf(providerId, model, { effort: "high" })).toEqual({ thinkingLevel: "HIGH" });
    });
  }

  test("vertex/gemini-4-hydrogen at medium (and its other levels): a level, no budget", () => {
    const config = generationConfig("vertex", "gemini-4-hydrogen", { effort: "medium" });
    expect(config["thinkingConfig"]).toEqual({ thinkingLevel: "MEDIUM" });
    expect(JSON.stringify(config)).not.toContain("thinkingBudget");
    expect(thinkingOf("vertex", "gemini-4-hydrogen", { effort: "low" })).toEqual({ thinkingLevel: "LOW" });
    expect(thinkingOf("vertex", "gemini-4-hydrogen", { effort: "high" })).toEqual({ thinkingLevel: "HIGH" });
    expect(thinkingOf("vertex", "gemini-4-hydrogen", { effort: "xhigh" })).toEqual({ thinkingLevel: "XHIGH" });
    expect("thinkingConfig" in generationConfig("vertex", "gemini-4-hydrogen")).toBe(false);
  });

  test("google/gemini-4-hydrogen: xhigh, and Argon refuses xhigh (not one of its levels)", () => {
    expect(thinkingOf("google", "gemini-4-hydrogen", { effort: "xhigh" })).toEqual({ thinkingLevel: "XHIGH" });
    expect(() => thinkingOf("google", "gemini-4-argon", { effort: "xhigh" })).toThrow(/not in model .*verified vocabulary/);
  });

  test("the exact generationConfig for medium on Hydrogen: the level alone, no budget key anywhere", () => {
    const config = generationConfig("google", "gemini-4-hydrogen", { effort: "medium" });
    expect(config["thinkingConfig"]).toEqual({ thinkingLevel: "MEDIUM" });
    expect(JSON.stringify(config)).not.toContain("thinkingBudget");
  });

  test("no effort: no thinkingConfig at all", () => {
    expect("thinkingConfig" in generationConfig("google", "gemini-4-hydrogen")).toBe(false);
    expect("thinkingConfig" in generationConfig("vertex", "gemini-4-argon")).toBe(false);
  });

  test("a budget has no form on a level row: disabled and a budgeted enabled are refused; adaptive takes the effort's level", () => {
    expect(() => thinkingOf("google", "gemini-4-hydrogen", { thinking: { type: "disabled" } } as Partial<TurnRequest>)).toThrow(/named level/);
    expect(() => thinkingOf("google", "gemini-4-hydrogen", { thinking: { type: "enabled", budgetTokens: 2048 } } as Partial<TurnRequest>)).toThrow(/named level/);
    expect(thinkingOf("google", "gemini-4-hydrogen", { thinking: { type: "adaptive" } } as Partial<TurnRequest>)).toBeUndefined();
    expect(thinkingOf("google", "gemini-4-hydrogen", { thinking: { type: "adaptive" }, effort: "high" } as Partial<TurnRequest>)).toEqual({ thinkingLevel: "HIGH" });
  });
});

describe("Gemini 3.x rows the references cover take the level form too", () => {
  test("Gemini 3.8 Flash at medium (MOSS's Vertex fallback and light model) is a level on both providers, no budget", () => {
    for (const providerId of ["google", "vertex"] as const) {
      const config = generationConfig(providerId, "gemini-3.8-flash", { effort: "medium" });
      expect(config["thinkingConfig"]).toEqual({ thinkingLevel: "MEDIUM" });
      expect(JSON.stringify(config)).not.toContain("thinkingBudget");
    }
    expect(thinkingOf("vertex", "gemini-3.8-flash", { effort: "low" })).toEqual({ thinkingLevel: "LOW" });
    expect(thinkingOf("vertex", "gemini-3.8-flash", { effort: "high" })).toEqual({ thinkingLevel: "HIGH" });
    expect("thinkingConfig" in generationConfig("vertex", "gemini-3.8-flash")).toBe(false);
  });

  // `TurnRequest.effort` names no "minimal", so a typed caller reaches a row's MINIMAL level through the numeric
  // scale (0 is the row's first effort); a named "minimal" arrives only from an untyped host, and is held to the row.
  const minimal = { effort: "minimal" } as unknown as Partial<TurnRequest>;
  test("minimal exists where the reference lists it (3.6 Flash), and is refused where it does not (3.8 Flash)", () => {
    expect(thinkingOf("google", "gemini-3.6-flash", { effort: 0 })).toEqual({ thinkingLevel: "MINIMAL" });
    expect(thinkingOf("vertex", "gemini-3.6-flash", { effort: 0 })).toEqual({ thinkingLevel: "MINIMAL" });
    expect(thinkingOf("google", "gemini-3.6-flash", minimal)).toEqual({ thinkingLevel: "MINIMAL" });
    expect(thinkingOf("google", "gemini-3.8-flash", { effort: 0 })).toEqual({ thinkingLevel: "LOW" });
    expect(() => thinkingOf("google", "gemini-3.8-flash", minimal)).toThrow(/not in model .*verified vocabulary/);
  });
});

describe("a budget row keeps the ladder, unchanged", () => {
  test("google/gemini-3.7-flash (absent from AI Studio's level table): low, medium, high are 1024, 4096, 8192 tokens; no level", () => {
    expect(thinkingOf("google", "gemini-3.7-flash", { effort: "low" })).toEqual({ thinkingBudget: 1024 });
    expect(thinkingOf("google", "gemini-3.7-flash", { effort: "medium" })).toEqual({ thinkingBudget: 4096 });
    expect(thinkingOf("google", "gemini-3.7-flash", { effort: "high" })).toEqual({ thinkingBudget: 8192 });
    expect(JSON.stringify(generationConfig("google", "gemini-3.7-flash", { effort: "medium" }))).not.toContain("thinkingLevel");
  });

  test("no effort: no thinkingConfig; disabled is still a zero budget", () => {
    expect("thinkingConfig" in generationConfig("google", "gemini-3.7-flash")).toBe(false);
    expect(thinkingOf("google", "gemini-3.7-flash", { thinking: { type: "disabled" } } as Partial<TurnRequest>)).toEqual({ thinkingBudget: 0 });
  });
});

describe("a row that declares no effort", () => {
  test("no effort sends no thinkingConfig; an effort is refused before anything is sent (never silently dropped)", () => {
    const effortless = catalog.models.find((m) => m.providerId === "google" && (m.reasoning?.efforts ?? []).length === 0 && m.reasoning?.supported.value !== true);
    expect(effortless).toBeDefined();
    const model = effortless!.upstreamId;
    expect("thinkingConfig" in generationConfig("google", model)).toBe(false);
    expect(() => generationConfig("google", model, { effort: "medium" })).toThrow();
  });
});

describe("the catalog's Gemini 4 and Gemini 3.x rows declare the level form, so a later refresh cannot quietly put the budget back", () => {
  for (const [key, levels] of [
    ["google/gemini-4-hydrogen", { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" }],
    ["google/gemini-4-neon", { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" }],
    ["google/gemini-4-argon", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-4-carbon", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-4-argon", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-4-hydrogen", { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" }],
    // Gemini 3.x, from AI Studio's and Vertex's level tables (read 2026-11-24).
    ["google/gemini-3.8-flash", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-3.6-flash", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-3.5-flash-lite", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-3.1-pro-preview", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-3.1-flash-lite", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["google/gemini-3-flash-preview", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.8-flash", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.8-flash-cyber", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.7-flash", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.6-flash", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.5-flash", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.5-flash-lite", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.1-flash-lite", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3-flash-preview", { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" }],
    ["vertex/gemini-3.1-pro-preview", { low: "LOW", medium: "MEDIUM", high: "HIGH" }],
  ] as const) {
    test(key, () => {
      const model = catalog.models.find((m) => m.key === key)!;
      expect(model.reasoning?.effortRequest?.value).toEqual({ field: "thinkingConfig.thinkingLevel", levels });
    });
  }
});

describe("rows the references do not cover stay on the budget ladder", () => {
  // AI Studio's level table (read 2026-11-24) has no row for gemini-3.7-flash or gemini-3.5-flash on `google`.
  for (const key of ["google/gemini-3.7-flash", "google/gemini-3.5-flash"]) {
    test(key, () => {
      expect(catalog.models.find((m) => m.key === key)!.reasoning?.effortRequest).toBeUndefined();
    });
  }
});
