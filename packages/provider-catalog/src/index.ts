// `@waifucave/clover-provider-catalog` — the inert provider catalog and its validator.
//
// FROZEN BETWEEN PHASES (R6-12): only a phase's SPINE task edits `src/` or `schema/` (P6.6's did,
// WS-13c §1); lanes ADD files (overlay rows, the upstream layer under `generated/`), never edit them.

export type {
  CapabilityEvidence,
  CatalogValidationResult,
  EvidenceConfidence,
  EvidenceSource,
  // WS-13c §1/§2 (P6.6 spine): the family layer's data shapes.
  FamilySlot,
  ModelFamilyDescriptor,
  ModelPricing,
  ModelStrength,
  PricingTier,
  ModelStatus,
  ProviderAuthKind,
  ProviderProtocol,
  ReasoningCapabilities,
  SlotBasis,
  SlotStatus,
  ToolCalling,
  WinterCatalog,
  WinterModelDescriptor,
  WinterProviderDescriptor,
} from "./types.ts";

// 0.0.80: each model's class for the read-before-edit rule, set by hand per canonical model.
export { MODEL_STRENGTHS } from "./types.ts";
export { MODEL_STRENGTH, strengthOfCanonicalModel } from "./model-strength.ts";
export { CATALOG_VOCABULARIES, scanForSecrets, validateCatalog, validateCatalogRows } from "./validate.ts";
// Clover A-M1: the catalog row schema every model plugin's rows follow, pinned and versioned.
export { CATALOG_ROW_SCHEMA, CATALOG_ROW_SCHEMA_ID, CATALOG_ROW_SCHEMA_SHA256, CATALOG_ROW_SCHEMA_VERSION, buildCatalogRowSchema, canonicalJson } from "./row.ts";
export type { CatalogRow, CatalogRowsValidationResult } from "./row.ts";
// Clover A-M2: every provider is a model plugin's `models[]` entry; this builds the catalog the SDK resolves against
// from a host's enabled entries (and splits the SDK's own catalog into plugins, for the generator).
export {
  CODE_ADAPTER_HANDLER,
  ENDPOINT_PROTOCOLS,
  GENERIC_ADAPTER_IDS,
  GENERIC_ENDPOINT_ADAPTERS,
  MODEL_PLUGIN_CATALOG_FORMAT,
  WIRE_PROTOCOL_OF_ENDPOINT,
  adapterIdForEntry,
  authKindsOf,
  catalogFromModelPlugins,
  familiesServedBy,
  isInterpolatedUrl,
  modelPluginForProvider,
  providerDescriptorForEntry,
  readModelPluginCatalog,
  settingKeysOfTemplate,
  settingTemplateOf,
  textOf,
} from "./model-plugins.ts";
export type { CatalogFromModelPluginsOptions, CatalogFromModelPluginsResult, EndpointProtocol, ModelEntry, ModelPluginCatalogFile, ModelPluginInput, ModelPluginRefusal, ProviderMeta } from "./model-plugins.ts";

// WS-13c §1–§3 (P6.6 spine): the pure family helpers. Every lane IMPORTS these — the normaliser, the
// matcher fallback and the slot-name acceptance rule each have exactly one implementation, because a
// second copy of "which family is this" is how the Agent tool's enum and the resolver start
// disagreeing about the same model.
export {
  CLAUDE_FAMILY_ID,
  CLAUDE_RESERVED_SLOT_NAMES,
  CURRENCY_RE,
  FAMILY_ID_RE,
  OTHER_FAMILY_ID,
  SLOT_NAME_RE,
  canonicalModelIdOf,
  familyIdOf,
  familyOfModelKey,
  blockedProviderIdsOf,
  isSlotServableRow,
  modelFamilyOf,
  resolveSlotName,
  rowsForCanonicalId,
  stampFamilyFields,
} from "./families.ts";
export type { SlotNameResolution } from "./families.ts";

// WS-21 lane L1b (spec §8 step 5; F23): the reviewed refresh's own old-tag -> new-key map, derived
// from `generated/rejections.json` + `generated/catalog.json` -- see tag-renames.ts's own header.
export { CATALOG_TAG_RENAMES } from "./tag-renames.ts";

import type { WinterCatalog } from "./types.ts";
import { validateCatalog } from "./validate.ts";

// --- the bundled catalog ------------------------------------------------------------------------
//
// A BUNDLED JSON MODULE, never `fs.readFile`. This is the whole point: `bun build --compile`
// produces a single-file binary whose `$bunfs` has no repository beside it, so a runtime path read
// resolves to nothing there while type-checking and dev-mode testing both pass — the exact
// "silently breaks only in the compiled form" class scripts/build-runtime.ts's own header warns
// about. An import is resolved by the bundler at build time and travels INSIDE the binary.
// Task 10 re-proves this on the compiled artifact; this package proves the mechanism under
// `bun run typecheck` and its own unit test.
import catalogJson from "../generated/catalog.json" with { type: "json" };

let cached: WinterCatalog | undefined;

/**
 * The catalog compiled into this build.
 *
 * VALIDATES rather than casts. TypeScript infers the imported JSON's *widened* shape
 * (`schemaVersion: number`, every union member a bare `string`), so `catalogJson as WinterCatalog`
 * would be an unchecked assertion dressed as a type — and a malformed committed catalog would then
 * surface as an incomprehensible failure deep in an adapter. Running the real validator is what
 * narrows it, and a failure here is a BUILD defect, so it throws rather than degrading.
 *
 * Memoised: the validator walks every row, and the catalog is immutable for the life of a process.
 */
export function loadCatalog(): WinterCatalog {
  if (cached !== undefined) return cached;
  const result = validateCatalog(catalogJson);
  if (!result.ok) {
    throw new Error(
      `winter-provider-catalog: the bundled catalog.json is invalid (${result.errors.length} error(s)) — this is a build defect, not a runtime condition:\n  ${result.errors.map((e) => e.message).join("\n  ")}`,
    );
  }
  cached = result.catalog;
  return cached;
}

/** Test seam: forget the memoised catalog. Never used in production — `loadCatalog()` is idempotent there. */
export function __resetCatalogCacheForTests(): void {
  cached = undefined;
}
