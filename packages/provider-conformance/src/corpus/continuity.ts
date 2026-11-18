// Phase 6 Lane C: the CONTINUITY CORPUS -- report §12.3's eight named switch cases and its §12.4
// security/privacy proofs, as executable fixtures.
//
// WHY A SECOND CORPUS BESIDE `runner.ts` RATHER THAN CASES INSIDE IT. `runner.ts` asks a QUESTION PER
// ADAPTER ("does this family's wire mapping do X?") and is keyed on `CorpusCaseId`; it is frozen
// (R6-12) and a lane supplies implementations for its cases. Continuity is not a per-family question
// at all -- every case here is about a PAIR of endpoints and the policy between them, and half of
// them involve no wire traffic whatsoever. Filing them under a per-adapter runner would have meant
// either editing a frozen file or answering an adapter-shaped question with a pair-shaped fixture.
// The shape is copied deliberately, though: cases are DATA, a missing required case is reported as
// `missing` rather than silently absent, and every case runs even after one fails.
//
// WHAT THE SUBJECTS ARE. Scripted in-process adapters over a hand-built catalog -- no HTTP, no
// credentials, no filesystem. The continuity layer never speaks to a provider: it reads capability
// EVIDENCE through the registry and decides what may cross. A loopback fake would add a socket to a
// test whose entire subject is a policy decision.
//
// review r1 (Critical-2): T10's re-export line landed (this repo's `src/index.ts` now re-exports
// `continuity/index.ts` in full, see that barrel's own "UNFROZEN AT CLOSE" section), so the
// continuity module itself is a package-name import below. `continuity/fixtures.ts` was NOT part of
// that re-export and still isn't on the main barrel -- it comes through the new
// `@waifucave/clover-provider-runtime/testing` subpath instead (review r1's one granted manifest
// edit), since these are generic in-memory catalog/adapter fixtures for testing, not part of the
// package's production adapter surface.
import {
  classifySwitch,
  createHistoryRenderer,
  sameDomain,
  shouldRequestSummary,
  summaryRequestOf,
  type ContinuityEndpoint,
  type HistoryTarget,
  createRegistry,
  type ProviderMessageLike,
  type ProviderRegistry,
} from "@waifucave/clover-provider-runtime";
import { fixtureCatalog, fixtureModel, fixtureProvider, fixtureReasoning, scriptedAdapter } from "@waifucave/clover-provider-runtime/testing";

/** The case ids. Stable strings: a report names them and a reader can trace each to its clause of the report. */
export type ContinuityCaseId =
  // --- §12.3's eight REQUIRED named transitions -------------------------------------------------
  | "claude-to-openai-reasoning-kept"
  | "openai-to-claude-reasoning-kept"
  | "gemini-to-openai-reasoning-kept"
  | "xai-to-openai-no-shared-domain"
  | "deepseek-to-openai-full-no-warning"
  | "deepseek-to-openai-truncation-not-a-loss"
  | "same-provider-model-profile-no-warning"
  | "same-provider-unverified-model-not-native"
  // --- §12.3's per-pair procedure (its numbered checks 1-6) --------------------------------------
  | "switch-during-tool-loop-waits"
  | "source-receives-every-native-tool-result"
  | "target-never-receives-source-opaque-state"
  | "target-receives-the-visible-conversation-only"
  | "immediate-switch-cancels-rather-than-splices"
  // --- §12.4's security and privacy proofs ------------------------------------------------------
  | "reasoning-completeness-is-not-a-loss"
  | "opaque-state-never-in-a-warning-or-report"
  | "no-reasoning-text-is-pasted-into-a-request"
  | "exposed-reasoning-never-forwarded-to-another-model"
  | "telemetry-and-reports-carry-identifiers-only"
  // --- §9.1's proactive-summary policy ----------------------------------------------------------
  | "summaries-requested-where-the-provider-documents-how";

export interface ContinuityCaseSpec {
  id: ContinuityCaseId;
  /** What the case proves, in one sentence, reproduced in the report so a passing case is legible without opening this file. */
  question: string;
  /** The report clause it answers. */
  clause: string;
}

export const CONTINUITY_CASES: readonly ContinuityCaseSpec[] = [
  // WS-23 (reasoning-state, user decision 9): a switch replays the conversation as it is and each model's
  // reasoning stays in the sidecar for that model, so a cross-family switch loses nothing the target can
  // see -- these cases now pin that it is SILENT, and still never certifies a shared domain.
  { id: "claude-to-openai-reasoning-kept", question: "does a Claude -> OpenAI switch stay silent, Claude's signed reasoning kept for Claude (never sent to OpenAI)?", clause: "§12.3 / WS-23 decision 9" },
  { id: "openai-to-claude-reasoning-kept", question: "does OpenAI -> Claude stay silent the other way round?", clause: "§12.3 / WS-23 decision 9" },
  { id: "gemini-to-openai-reasoning-kept", question: "does Gemini -> OpenAI stay silent, the thought signature kept for Gemini?", clause: "§12.3 / WS-23 decision 9" },
  { id: "xai-to-openai-no-shared-domain", question: "does xAI -> OpenAI stay non-native (no shared domain) despite the shared wire family?", clause: "§12.3 / §8.5" },
  { id: "deepseek-to-openai-full-no-warning", question: "does DeepSeek -> OpenAI with COMPLETE forwarded reasoning raise no hidden-reasoning warning?", clause: "§12.3 / §8.4(2)" },
  { id: "deepseek-to-openai-truncation-not-a-loss", question: "does trimmed reasoning stay a lossless transfer, the trace being kept for its source (WS-23)?", clause: "§12.3 / WS-23 decision 9" },
  { id: "same-provider-model-profile-no-warning", question: "does the identical provider/model/profile switch cleanly, with no warning?", clause: "§12.3" },
  { id: "same-provider-unverified-model-not-native", question: "does an uncertified model-to-model switch inside one provider refuse the NATIVE classification?", clause: "§12.3 / §8.5" },
  { id: "switch-during-tool-loop-waits", question: "does a switch requested during a live tool loop wait for turn completion by default?", clause: "§12.3(2) / §8.2" },
  { id: "source-receives-every-native-tool-result", question: "does the source provider receive every native tool result of the turn it owns?", clause: "§12.3(3) / §8.1" },
  { id: "target-never-receives-source-opaque-state", question: "is the source's opaque state absent from everything the target sees, in BOTH carriers?", clause: "§12.3(4) / §12.4" },
  { id: "target-receives-the-visible-conversation-only", question: "does the target receive the visible conversation intact -- and none of the source's reasoning (2026-11: native or nothing)?", clause: "§12.3(5) / 2026-11" },
  { id: "immediate-switch-cancels-rather-than-splices", question: "does an immediate switch cancel the source loop instead of splicing a foreign model into it?", clause: "§12.3(6) / §8.3" },
  { id: "reasoning-completeness-is-not-a-loss", question: "does an exposed source switch silently whatever its trace's completeness, the trace being kept for it (WS-23 decision 9)?", clause: "§12.4 / WS-23 decision 9" },
  { id: "opaque-state-never-in-a-warning-or-report", question: "can an encrypted payload reach a warning or a render report at all?", clause: "§12.4" },
  { id: "no-reasoning-text-is-pasted-into-a-request", question: "is no earlier model's reasoning ever pasted into a request as text -- no tag, no summary, no handoff note (2026-11)?", clause: "§12.4 / 2026-11" },
  { id: "exposed-reasoning-never-forwarded-to-another-model", question: "does an open model's raw reasoning stay with that model, never forwarded to another (2026-11)?", clause: "§12.4 / 2026-11" },
  { id: "telemetry-and-reports-carry-identifiers-only", question: "do the render report and the discard report carry identifiers and counts, never content?", clause: "§12.4" },
  { id: "summaries-requested-where-the-provider-documents-how", question: "are summaries requested from session start exactly where the provider documents a way to ask?", clause: "§9.1" },
];

// --- the fixture world ---------------------------------------------------------------------------

export interface ContinuityWorld {
  registry: ProviderRegistry;
  endpoints: Record<"claudeA" | "claudeB" | "openai" | "openaiMini" | "gemini" | "xai" | "deepseek", ContinuityEndpoint>;
  targets: Record<"claudeA" | "openai" | "deepseek", HistoryTarget>;
}

/**
 * The catalog every case shares.
 *
 * The Anthropic rows declare NO continuation-domain evidence (each is its own single-member domain,
 * which is what makes model-A-to-model-B a real boundary); OpenAI, Gemini, xAI and DeepSeek each
 * declare their own. xAI and DeepSeek deliberately sit in the SAME wire family as OpenAI with the
 * same endpoint shape -- the corpus is worthless if the fixtures make the distinctions easy.
 */
export function createContinuityWorld(): ContinuityWorld {
  const catalog = fixtureCatalog(
    [
      fixtureProvider({ id: "anthropic", family: "anthropic", adapterId: "anthropic-adapter", baseUrl: "https://anthropic.invalid/v1/messages" }),
      fixtureProvider({ id: "openai", family: "openai", adapterId: "openai-adapter", baseUrl: "https://openai.invalid/v1/responses" }),
      fixtureProvider({ id: "google", family: "google", adapterId: "google-adapter", baseUrl: "https://google.invalid/v1/models" }),
      fixtureProvider({ id: "xai", family: "openai", adapterId: "xai-adapter", baseUrl: "https://xai.invalid/v1/responses" }),
      fixtureProvider({ id: "deepseek", family: "openai", adapterId: "deepseek-adapter", baseUrl: "https://deepseek.invalid/v1/responses" }),
    ],
    [
      fixtureModel({ key: "anthropic/claude-a", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({ key: "anthropic/claude-b", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({
        key: "openai/o-reason",
        providerId: "openai",
        reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-reason"], summaryRequest: { field: "reasoning.summary", values: ["auto", "detailed"] } }),
      }),
      fixtureModel({ key: "openai/o-mini", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-mini"], summaryRequest: { field: "reasoning.summary", values: ["auto"] } }) }),
      fixtureModel({ key: "google/gemini-x", providerId: "google", reasoning: fixtureReasoning({ readableState: "summary", domain: ["google/gemini-x"], summaryRequest: { field: "includeThoughts", values: ["true"] } }) }),
      fixtureModel({ key: "xai/grok-x", providerId: "xai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["xai/grok-x"], summaryRequest: { field: "reasoning", values: ["summary"] } }) }),
      // DeepSeek: complete readable reasoning, and NO documented way to request a summary.
      fixtureModel({ key: "deepseek/r-reason", providerId: "deepseek", reasoning: fixtureReasoning({ readableState: "full-exposed", domain: ["deepseek/r-reason"] }) }),
    ],
  );
  const registry = createRegistry(catalog);
  for (const id of ["anthropic-adapter", "openai-adapter", "google-adapter", "xai-adapter", "deepseek-adapter"]) {
    registry.register(scriptedAdapter({ id, family: id === "anthropic-adapter" ? "anthropic" : id === "google-adapter" ? "google" : "openai" }));
  }
  const endpoint = (providerId: string, modelKey: string, family: string, readableState: ContinuityEndpoint["readableState"]): ContinuityEndpoint => ({
    providerId,
    modelKey,
    family,
    continuationDomain: modelKey,
    readableState,
  });
  return {
    registry,
    endpoints: {
      claudeA: endpoint("anthropic", "anthropic/claude-a", "anthropic", "summary"),
      claudeB: endpoint("anthropic", "anthropic/claude-b", "anthropic", "summary"),
      openai: endpoint("openai", "openai/o-reason", "openai", "summary"),
      openaiMini: endpoint("openai", "openai/o-mini", "openai", "summary"),
      gemini: endpoint("google", "google/gemini-x", "google", "summary"),
      xai: endpoint("xai", "xai/grok-x", "openai", "summary"),
      deepseek: endpoint("deepseek", "deepseek/r-reason", "openai", "full-exposed"),
    },
    targets: {
      claudeA: { family: "anthropic", continuationDomain: "anthropic/claude-a", readableState: "summary" },
      openai: { family: "openai", continuationDomain: "openai/o-reason", readableState: "summary" },
      deepseek: { family: "openai", continuationDomain: "deepseek/r-reason", readableState: "full-exposed" },
    },
  };
}

/** The markers every "no opaque state escaped" assertion looks for. If one of these appears anywhere a model or a log can see, the case fails. */
export const OPAQUE_MARKERS = ["CLAUDE-SIGNATURE-OPAQUE", "CLAUDE-REDACTED-OPAQUE", "OPENAI-ENCRYPTED-OPAQUE", "GEMINI-SIGNATURE-OPAQUE"] as const;

/** A Claude turn carrying BOTH carriers of opaque state: signed in-dialect blocks in `content`, and native items beside them. */
export function claudeTurn(uuid: string, text: string): ProviderMessageLike {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "the private chain of thought", signature: "CLAUDE-SIGNATURE-OPAQUE" },
      { type: "redacted_thinking", data: "CLAUDE-REDACTED-OPAQUE" },
      { type: "text", text },
    ],
    uuid,
    origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
    nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["CLAUDE-SIGNATURE-OPAQUE"] },
  };
}

export function openaiTurn(uuid: string, text: string): ProviderMessageLike {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    uuid,
    origin: { providerId: "openai", modelKey: "openai/o-reason", family: "openai", continuationDomain: "openai/o-reason" },
    nativeState: { family: "openai", continuationDomain: "openai/o-reason", items: [{ encrypted_content: "OPENAI-ENCRYPTED-OPAQUE" }] },
  };
}

// --- the cases -----------------------------------------------------------------------------------

export interface ContinuityCaseContext {
  world: ContinuityWorld;
}

export type ContinuityCaseImpl = (ctx: ContinuityCaseContext) => void | Promise<void>;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const chainOf = (entries: Record<string, { summary?: string }>): Map<string, { summary?: string }> => new Map(Object.entries(entries));

export const CONTINUITY_CASE_IMPLS: Record<ContinuityCaseId, ContinuityCaseImpl> = {
  "claude-to-openai-reasoning-kept": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true, completedToolResults: 1 });
    assert(verdict.lossClass === "lossless-portable" && verdict.warnings.length === 0, "a Claude -> OpenAI switch loses nothing the target can see: silent, and never native");
    assert(verdict.portable[0] === "the whole visible conversation, as it is", "the visible conversation crosses as it is");
    assert(verdict.portable.some((p) => p.includes("kept for")), "and Claude's reasoning is named as kept for Claude");
  },
  "openai-to-claude-reasoning-kept": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.openai, world.endpoints.claudeA, { summaryAvailable: true });
    assert(verdict.lossClass === "lossless-portable" && verdict.warnings.length === 0, "an OpenAI -> Claude switch is silent too");
  },
  "gemini-to-openai-reasoning-kept": ({ world }) => {
    assert(classifySwitch(world.endpoints.gemini, world.endpoints.openai, { summaryAvailable: true }).lossClass === "lossless-portable", "Gemini -> OpenAI is silent, and never native");
  },
  "xai-to-openai-no-shared-domain": ({ world }) => {
    const { xai, openai } = world.endpoints;
    assert(xai.family === openai.family, "the fixture must put xAI in OpenAI's own wire family, or the case proves nothing");
    assert(classifySwitch(xai, openai, { summaryAvailable: true }).lossClass === "lossless-portable", "xAI -> OpenAI must NOT be native despite the shared family and endpoint shape");
    assert(!sameDomain(xai, openai), "and they must not share a continuation domain");
  },
  "deepseek-to-openai-full-no-warning": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.deepseek, world.endpoints.openai, { exposedComplete: true, completedToolResults: 2 });
    assert(verdict.lossClass === "lossless-portable", "complete exposed reasoning forwarded unmodified is not a lossy transfer");
    assert(verdict.warnings.length === 0, "and it must raise no warning at all");
  },
  "deepseek-to-openai-truncation-not-a-loss": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.deepseek, world.endpoints.openai, { exposedComplete: true, truncated: true });
    assert(verdict.lossClass === "lossless-portable" && verdict.warnings.length === 0, "trimmed reasoning is not a loss: the trace stays with its source");
  },
  "same-provider-model-profile-no-warning": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.openai, world.endpoints.openai, { summaryAvailable: true });
    assert(verdict.lossClass === "lossless-native" && verdict.warnings.length === 0, "the identical model must switch with no warning");
  },
  "same-provider-unverified-model-not-native": ({ world }) => {
    for (const [from, to] of [
      [world.endpoints.openai, world.endpoints.openaiMini],
      [world.endpoints.claudeA, world.endpoints.claudeB],
    ] as const) {
      const verdict = classifySwitch(from, to, { summaryAvailable: true });
      assert(verdict.lossClass === "lossless-portable", `${from.modelKey} -> ${to.modelKey} must refuse the NATIVE classification (no certified shared domain)`);
    }
  },

  "switch-during-tool-loop-waits": ({ world }) => {
    // P6 fix wave (Ruling E-2): the WAIT itself is the engine's -- it parks a `set_model` and applies
    // it at the quiescent boundary (`packages/runtime/src/provider/engine-seam-p6.test.ts`, "a
    // set_model arriving BETWEEN turns applies at the next turn's quiescent boundary";
    // `switch-seam.test.ts`, "a `set_model` parked MID-TURN and applied on interrupt"). What the PURE
    // matrix proves is WHY waiting is the default: the same transition classified at the boundary
    // carries no abort loss, and forced mid-turn it does -- the loss the wait exists to avoid.
    const deferred = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true });
    const forced = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true, midTurnAbort: true });
    assert(!deferred.warnings.some((w) => w.includes("cancelled before it finished")), "a switch applied at the boundary must report no cancelled turn");
    assert(forced.warnings.some((w) => w.includes("cancelled before it finished")), "the same switch forced mid-turn must report the cancelled turn -- the loss the default avoids");
    assert(forced.warnings.length > deferred.warnings.length, "so the deferred switch is strictly the less lossy of the two");
  },
  "source-receives-every-native-tool-result": ({ world }) => {
    // The DELIVERY is the engine's (a parked switch never applies inside a tool loop -- the runtime
    // fixtures named above). The pure half proved here: at the boundary every tool call the source
    // COMPLETED crosses as it is, in the visible conversation -- calls and their real results.
    const messages: ProviderMessageLike[] = [
      { role: "user", content: "read the three files" },
      {
        role: "assistant",
        uuid: "m1",
        origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic" },
        content: ["t1", "t2", "t3"].map((id) => ({ type: "tool_use" as const, id, name: "Read", input: { file_path: `/work/${id}.ts` } })),
      },
      { role: "tool", content: ["t1", "t2", "t3"].map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: `contents of ${id}` })) },
    ];
    const rendered = JSON.stringify(createHistoryRenderer(world.registry).render(messages, chainOf({}), world.targets.openai));
    for (const id of ["t1", "t2", "t3"]) assert(rendered.includes(`contents of ${id}`) && rendered.includes(`/work/${id}.ts`), `the call ${id} and its real result must cross as they are`);
    const verdict = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true, completedToolResults: 3 });
    assert(verdict.portable.includes("3 completed tool results"), "the classification must name the completed results as portable");
  },
  "target-never-receives-source-opaque-state": ({ world }) => {
    const renderer = createHistoryRenderer(world.registry);
    const history = [claudeTurn("m1", "claude's visible answer"), openaiTurn("m2", "openai's visible answer")];
    const chain = chainOf({ m1: { summary: "claude's summary" }, m2: { summary: "openai's summary" } });

    const forOpenai = JSON.stringify(renderer.render(history, chain, world.targets.openai));
    for (const marker of ["CLAUDE-SIGNATURE-OPAQUE", "CLAUDE-REDACTED-OPAQUE"]) {
      assert(!forOpenai.includes(marker), `the OpenAI target must not receive ${marker} -- in EITHER carrier`);
    }
    assert(forOpenai.includes("OPENAI-ENCRYPTED-OPAQUE"), "while OpenAI's own state must still replay exactly");

    const forClaude = JSON.stringify(renderer.render(history, chain, world.targets.claudeA));
    assert(!forClaude.includes("OPENAI-ENCRYPTED-OPAQUE"), "and the Claude target must not receive OpenAI's encrypted reasoning item");
    assert(forClaude.includes("CLAUDE-SIGNATURE-OPAQUE"), "while Claude's own signed blocks replay unchanged");
  },
  "target-receives-the-visible-conversation-only": ({ world }) => {
    const renderer = createHistoryRenderer(world.registry);
    const rendered = renderer.render([claudeTurn("m1", "claude's visible answer")], chainOf({ m1: { summary: "claude's own summary" } }), world.targets.openai);
    assert(rendered[0]!.decoration === undefined, "no annotation of any kind rides the message");
    const serialized = JSON.stringify(rendered);
    assert(!serialized.includes("claude's own summary"), "the source's summary is not sent to another model");
    assert(!serialized.includes("the private chain of thought"), "nor its thinking text");
    assert(serialized.includes("claude's visible answer"), "and the visible conversation crosses intact");
  },
  "immediate-switch-cancels-rather-than-splices": ({ world }) => {
    // The CANCEL is the engine's interrupt path (`switch-seam.test.ts`, "a `set_model` parked
    // MID-TURN and applied on interrupt ... classified with `midTurnAbort`"). The pure half: an
    // immediate switch is classified as an ABORT -- it reports the cancelled turn, keeps the completed
    // facts, undoes nothing -- and the request built over an unfinished native loop fabricates no
    // result and appends nothing to close it.
    const verdict = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true, midTurnAbort: true, completedToolResults: 1 });
    assert(verdict.lossClass === "warned-lossy", "an immediate switch is always lossy: the turn is unfinished");
    assert(verdict.warnings.some((w) => w.includes("cancelled before it finished")), "it must report the cancelled turn");
    assert(verdict.warnings.some((w) => w.includes("nothing that ran is undone")), "and say that side effects are not rolled back");
    assert(verdict.portable.includes("1 completed tool result"), "completed tool facts are retained");
    const messages: ProviderMessageLike[] = [
      { role: "user", content: "do the work" },
      { role: "assistant", uuid: "m1", origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic" }, content: [{ type: "tool_use", id: "t-open", name: "Bash", input: { command: "make" } }] },
    ];
    const before = messages.length;
    const rendered = createHistoryRenderer(world.registry).render(messages, chainOf({}), world.targets.openai);
    assert(!JSON.stringify(rendered).includes("tool_result"), "no tool result may be fabricated to close the open call");
    assert(messages.length === before && rendered.length === before, "nothing may be appended to the conversation to make it look complete");
  },

  "reasoning-completeness-is-not-a-loss": ({ world }) => {
    // WS-23 (reasoning-state, user decision 9): the trace -- complete or not -- stays in the sidecar for
    // the model that produced it, so its completeness no longer decides a warning. What still must hold:
    // an exposed source is never classified NATIVE on the target.
    for (const facts of [{}, { summaryAvailable: true }, { completedToolResults: 2 }, { exposedComplete: false }, { exposedComplete: true }]) {
      const verdict = classifySwitch(world.endpoints.deepseek, world.endpoints.openai, facts);
      assert(verdict.lossClass === "lossless-portable", `an exposed source's trace is kept for it, never lost and never native (facts: ${JSON.stringify(facts)})`);
      assert(verdict.warnings.length === 0, "and it raises no warning");
    }
  },
  "opaque-state-never-in-a-warning-or-report": ({ world }) => {
    const verdict = classifySwitch(world.endpoints.claudeA, world.endpoints.openai, { summaryAvailable: true, truncated: true, midTurnAbort: true, completedToolResults: 2 });
    const { report } = createHistoryRenderer(world.registry).renderWithReport([{ role: "user", content: "go" }, claudeTurn("m1", "answer")], chainOf({ m1: { summary: "a summary" } }), world.targets.openai);
    const surface = `${verdict.warnings.join(" ")} ${verdict.portable.join(" ")} ${JSON.stringify(report)}`;
    for (const marker of OPAQUE_MARKERS) assert(!surface.includes(marker), `an opaque payload (${marker}) reached a user- or model-visible surface`);
    assert(!surface.includes("the private chain of thought"), "and the source's private reasoning text must not cross either");
  },
  "no-reasoning-text-is-pasted-into-a-request": ({ world }) => {
    const renderer = createHistoryRenderer(world.registry);
    const history: ProviderMessageLike[] = [
      { role: "user", content: "go", decoration: { text: "<prior_model_handoff>x</prior_model_handoff>", door: "tag" } },
      claudeTurn("m1", "claude answer"),
      openaiTurn("m2", "openai answer"),
    ];
    const chain = chainOf({ m1: { summary: "claude's summary" }, m2: { summary: "openai's summary" } });
    for (const [name, target] of Object.entries(world.targets)) {
      const serialized = JSON.stringify(renderer.render(history, chain, target));
      for (const needle of ["recovered_", "prior_model_handoff", "prior-model reasoning", '"decoration"', "'s summary"]) assert(!serialized.includes(needle), `${name}: a request must never carry ${needle}`);
    }
  },
  "exposed-reasoning-never-forwarded-to-another-model": ({ world }) => {
    const deepseekTurn: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
      uuid: "m1",
      origin: { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai", continuationDomain: "deepseek/r-reason" },
      nativeState: { family: "openai", continuationDomain: "deepseek/r-reason", items: [{ type: "winter.exposed_reasoning", text: "the complete readable trace" }] },
    };
    const chain = chainOf({ m1: { summary: "the complete readable trace" } });
    const rendered = createHistoryRenderer(world.registry).render([deepseekTurn], chain, world.targets.openai);
    assert(!JSON.stringify(rendered).includes("the complete readable trace"), "an open model's raw reasoning never reaches another model");
    assert(JSON.stringify(createHistoryRenderer(world.registry).render([deepseekTurn], chain, world.targets.deepseek)).includes("the complete readable trace"), "while it still replays natively to the model that produced it");
    // WS-23 (decision 9): the withheld trace is still the source's own, kept for it -- not a loss to warn about.
    const verdict = classifySwitch(world.endpoints.deepseek, world.endpoints.openai, { exposedComplete: true, policyBlocksForwarding: true });
    assert(verdict.warnings.length === 0, "keeping the trace home loses nothing the target was owed");
  },
  "telemetry-and-reports-carry-identifiers-only": ({ world }) => {
    const renderer = createHistoryRenderer(world.registry);
    const { report } = renderer.renderWithReport([claudeTurn("m1", "answer")], chainOf({ m1: { summary: "a summary" } }), world.targets.openai);
    const serialized = JSON.stringify(report);
    for (const marker of OPAQUE_MARKERS) assert(!serialized.includes(marker), "a render report must never carry opaque state");
    assert(!serialized.includes("a summary"), "nor any reasoning text -- counts only");
    assert(typeof report.strippedInDialectBlocks === "number", "alongside counts");
  },

  "summaries-requested-where-the-provider-documents-how": ({ world }) => {
    const resolveDescriptor = (modelKey: string) => {
      const resolved = world.registry.resolve({ model: modelKey });
      assert(!(resolved instanceof Error), `the fixture catalog must resolve ${modelKey}`);
      return (resolved as { descriptor?: Parameters<typeof shouldRequestSummary>[0] }).descriptor;
    };
    for (const modelKey of ["anthropic/claude-a", "openai/o-reason", "google/gemini-x", "xai/grok-x"]) {
      const descriptor = resolveDescriptor(modelKey);
      assert(shouldRequestSummary(descriptor), `${modelKey} documents a summary request field, so summaries must be asked for from session start`);
      assert(summaryRequestOf(descriptor) !== undefined, `${modelKey}'s request field must be readable from the descriptor`);
    }
    // DeepSeek exposes complete reasoning and documents NO way to request a summary: asking anyway
    // would send a field it does not honour, on every request of the session.
    assert(!shouldRequestSummary(resolveDescriptor("deepseek/r-reason")), "DeepSeek must not be asked for a summary it cannot produce");
  },
};

// --- the runner ----------------------------------------------------------------------------------

export interface ContinuityCaseOutcome {
  id: ContinuityCaseId;
  status: "passed" | "failed" | "missing";
  detail?: string;
}

export interface ContinuityReport {
  outcomes: ContinuityCaseOutcome[];
  ok: boolean;
}

/**
 * Runs every case, even after one fails -- a reader wants the whole picture from one run, and
 * stopping at the first failure turns a corpus into a bisect. A case with no implementation is
 * `missing`, never silently absent: "the corpus passed" has to mean "every question was asked".
 */
export async function runContinuityCorpus(cases: Partial<Record<ContinuityCaseId, ContinuityCaseImpl>> = CONTINUITY_CASE_IMPLS): Promise<ContinuityReport> {
  const world = createContinuityWorld();
  const outcomes: ContinuityCaseOutcome[] = [];
  for (const spec of CONTINUITY_CASES) {
    const impl = cases[spec.id];
    if (impl === undefined) {
      outcomes.push({ id: spec.id, status: "missing", detail: `no implementation supplied for a REQUIRED case: ${spec.question}` });
      continue;
    }
    try {
      await impl({ world });
      outcomes.push({ id: spec.id, status: "passed" });
    } catch (err) {
      outcomes.push({ id: spec.id, status: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { outcomes, ok: outcomes.every((o) => o.status === "passed") };
}

/** One line per case, so a failing run says which questions went unanswered without anyone opening this file. */
export function formatContinuityReport(report: ContinuityReport): string {
  const byId = new Map(CONTINUITY_CASES.map((c) => [c.id, c]));
  const lines = report.outcomes.map((o) => `  ${o.status.padEnd(7)} ${o.id}${o.detail !== undefined ? ` -- ${o.detail}` : ""}  (${byId.get(o.id)?.clause ?? ""}: ${byId.get(o.id)?.question ?? ""})`);
  return [`continuity corpus -- ${report.ok ? "OK" : "FAILED"}`, ...lines].join("\n");
}
