import { describe, expect, test } from "bun:test";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";
import { toWireMessages } from "../adapters/anthropic/messages.ts";
import { fixtureCatalog, fixtureModel, fixtureProvider, fixtureReasoning, scriptedAdapter } from "./fixtures.ts";
import { createHistoryRenderer, type ContinuationChainLike, type ContinuationLinkLike, type HistoryTarget } from "./renderer.ts";
import { reasoningBlockItems, separateReasoningBlocks } from "./reasoning-blocks.ts";

// Four models across three families. The two Claude rows declare NO domain evidence, so each is its
// own single-member domain -- which is what makes "Claude model A -> Claude model B" a real boundary
// rather than a same-provider free pass.
function buildRegistry(): ProviderRegistry {
  const catalog = fixtureCatalog(
    [
      fixtureProvider({ id: "anthropic", family: "anthropic", adapterId: "anthropic-adapter" }),
      fixtureProvider({ id: "openai", family: "openai", adapterId: "openai-adapter" }),
      fixtureProvider({ id: "deepseek", family: "openai", adapterId: "deepseek-adapter" }),
      // WS-24 (follow-up 7): the real catalog's own shape (verified against `loadCatalog()`) --
      // `console` is its OWN provider id on the SAME adapter/wire family as `anthropic`, never a
      // second `anthropic` row. See the "a Winter-native console/* entry" describe block below.
      fixtureProvider({ id: "console", family: "anthropic", adapterId: "anthropic-adapter" }),
    ],
    [
      fixtureModel({ key: "anthropic/claude-a", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({ key: "anthropic/claude-b", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({ key: "openai/o-reason", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-reason"], summaryRequest: { field: "reasoning.summary", values: ["detailed"] } }) }),
      fixtureModel({ key: "deepseek/r-reason", providerId: "deepseek", reasoning: fixtureReasoning({ readableState: "full-exposed", domain: ["deepseek/r-reason"] }) }),
      fixtureModel({ key: "console/claude-fable", providerId: "console", reasoning: fixtureReasoning({ readableState: "summary", domain: ["console/claude-fable"], summaryRequest: { field: "display", values: ["summarized"] } }) }),
    ],
  );
  const registry = createRegistry(catalog);
  registry.register(scriptedAdapter({ id: "anthropic-adapter", family: "anthropic" }));
  registry.register(scriptedAdapter({ id: "openai-adapter" }));
  registry.register(scriptedAdapter({ id: "deepseek-adapter" }));
  return registry;
}

const CLAUDE_A: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-a", readableState: "summary" };
const OPENAI: HistoryTarget = { family: "openai", continuationDomain: "openai/o-reason", readableState: "summary" };
const DEEPSEEK: HistoryTarget = { family: "openai", continuationDomain: "deepseek/r-reason", readableState: "full-exposed" };

// A real chain also carries each turn's captured SUMMARY (the runtime's `ContinuationLink.summary`); the
// renderer must never read it, so the fixtures put one on every link and the tests prove it never shows.
const chainOf = (entries: Record<string, ContinuationLinkLike & { summary?: string }>): ContinuationChainLike => new Map(Object.entries(entries));

const claudeMessage = (uuid: string, extra: Partial<ProviderMessageLike> = {}): ProviderMessageLike => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private claude reasoning", signature: "SIG-OPAQUE" },
    { type: "redacted_thinking", data: "REDACTED-OPAQUE" },
    { type: "text", text: "the visible answer" },
  ],
  uuid,
  origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
  ...extra,
});

const openaiMessage = (uuid: string): ProviderMessageLike => ({
  role: "assistant",
  content: [{ type: "text", text: "openai visible answer" }],
  uuid,
  origin: { providerId: "openai", modelKey: "openai/o-reason", family: "openai", continuationDomain: "openai/o-reason" },
  nativeState: { family: "openai", continuationDomain: "openai/o-reason", items: [{ encrypted_content: "OPENAI-OPAQUE" }] },
});

const deepseekMessage = (uuid: string): ProviderMessageLike => ({
  role: "assistant",
  content: [{ type: "text", text: "deepseek visible answer" }],
  uuid,
  origin: { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai", continuationDomain: "deepseek/r-reason" },
});

// Everything that would mean reasoning was pasted into a request: the retired tags and labels, and every
// piece of reasoning TEXT the fixtures carry (summaries, thinking text, exposed reasoning).
const GLUE = ["recovered_", "prior_model_handoff", "prior-model reasoning", "private claude reasoning", "SUMMARY-TEXT", "EXPOSED-TEXT"];
function expectNoGlue(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of GLUE) expect(serialized).not.toContain(needle);
  expect(serialized).not.toContain('"decoration"');
}

// The origin-resolution PRECEDENCE, pinned with all three sources present and CONTRADICTING each other --
// `message.origin` > the sidecar chain's own origin > the structural `message.model` fallback. The target
// is the model each source names in turn: only the winning source makes the message the target's own.
describe("origin resolution precedence: message.origin > sidecar chain origin > structural message.model", () => {
  const withState = (extra: Partial<ProviderMessageLike> & { model?: string }): ProviderMessageLike =>
    ({ role: "assistant", content: [{ type: "text", text: "answer" }], uuid: "m1", nativeState: { family: "x", continuationDomain: "x", items: ["OWN-STATE"] }, ...extra }) as ProviderMessageLike;
  const claudeA = { ...CLAUDE_A, providerId: "anthropic", modelKey: "anthropic/claude-a" };
  const claudeB: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-b", readableState: "summary", providerId: "anthropic", modelKey: "anthropic/claude-b" };
  const openai = { ...OPENAI, providerId: "openai", modelKey: "openai/o-reason" };

  test("all three present and contradicting: message.origin wins", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = withState({ origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" }, model: "anthropic/claude-b" });
    const chain = chainOf({ m1: { origin: { providerId: "openai", modelKey: "openai/o-reason", family: "openai" } } });
    expect(renderer.renderWithReport([message], chain, claudeA).report.replayedNatively).toBe(1);
    expect(renderer.renderWithReport([message], chain, openai).report.droppedNativeState).toBe(1);
  });

  test("message.origin absent: the sidecar chain origin wins over the structural fallback", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = withState({ model: "anthropic/claude-b" });
    const chain = chainOf({ m1: { origin: { providerId: "openai", modelKey: "openai/o-reason", family: "openai" } } });
    expect(renderer.renderWithReport([message], chain, openai).report.replayedNatively).toBe(1);
    expect(renderer.renderWithReport([message], chain, claudeB).report.droppedNativeState).toBe(1);
  });

  test("message.origin AND the sidecar chain origin both absent: the structural message.model fallback is the last resort", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = withState({ model: "anthropic/claude-b" });
    expect(renderer.renderWithReport([message], chainOf({ m1: { summary: "SUMMARY-TEXT" } }), claudeB).report.replayedNatively).toBe(1);
    expect(renderer.renderWithReport([message], chainOf({}), openai).report.droppedNativeState).toBe(1);
  });
});

describe("the same model, or the same continuation domain: exact native replay", () => {
  test("native state, in-dialect blocks and content all ride unchanged, by identity", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["A-OPAQUE"] } });
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "SUMMARY-TEXT" } }), CLAUDE_A);
    expect(messages[0]).toBe(message);
    expect(report).toEqual({ replayedNatively: 1, droppedNativeState: 0, strippedInDialectBlocks: 0, droppedEmptyMessages: 0 });
    expect(JSON.stringify(messages)).not.toContain("SUMMARY-TEXT");
  });

  test("the same model on a row with NO continuation domain is still its own (sameModel)", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const own: ProviderMessageLike = { ...claudeMessage("m1"), origin: { providerId: "anthropic", modelKey: "anthropic/claude-b", family: "anthropic" } };
    const target: HistoryTarget = { family: "anthropic", readableState: "summary", providerId: "anthropic", modelKey: "anthropic/claude-b" };
    expect(renderer.render([own], chainOf({}), target)[0]).toBe(own);
  });

  test("user and tool messages are never touched", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const user: ProviderMessageLike = { role: "user", content: "do the thing" };
    const tool: ProviderMessageLike = { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] };
    const { messages } = renderer.renderWithReport([user, tool], chainOf({}), OPENAI);
    expect(messages[0]).toBe(user);
    expect(messages[1]).toBe(tool);
  });
});

describe("another model: the reasoning is REMOVED and nothing takes its place", () => {
  test("Claude -> OpenAI: both carriers come off; text survives; no summary, no thinking text, no tag", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["A-OPAQUE"] } });
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "SUMMARY-TEXT" } }), OPENAI);
    expect(messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "the visible answer" }], uuid: "m1", origin: message.origin! });
    expect(report).toEqual({ replayedNatively: 0, droppedNativeState: 1, strippedInDialectBlocks: 2, droppedEmptyMessages: 0 });
    for (const opaque of ["SIG-OPAQUE", "REDACTED-OPAQUE", "A-OPAQUE"]) expect(JSON.stringify(messages)).not.toContain(opaque);
    expectNoGlue(messages);
  });

  test("Claude model A -> Claude model B on the same provider is another model too (per-model domains)", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const target: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-b", readableState: "summary", providerId: "anthropic", modelKey: "anthropic/claude-b" };
    const { messages, report } = renderer.renderWithReport([claudeMessage("m1")], chainOf({ m1: { summary: "SUMMARY-TEXT" } }), target);
    expect(report.strippedInDialectBlocks).toBe(2);
    expect((messages[0]!.content as ContentBlockLike[]).map((b) => b.type)).toEqual(["text"]);
    expectNoGlue(messages);
  });

  test("DeepSeek's exposed reasoning never reaches another model, whichever kind of target", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const deepseek: ProviderMessageLike = { ...deepseekMessage("m1"), nativeState: { family: "openai", continuationDomain: "deepseek/r-reason", items: [{ type: "winter.exposed_reasoning", text: "EXPOSED-TEXT" }] } };
    for (const target of [OPENAI, CLAUDE_A]) {
      const { messages, report } = renderer.renderWithReport([deepseek], chainOf({ m1: { summary: "EXPOSED-TEXT" } }), target);
      expect(messages[0]!.nativeState).toBeUndefined();
      expect(messages[0]!.content).toEqual([{ type: "text", text: "deepseek visible answer" }]);
      expect(report.droppedNativeState).toBe(1);
      expectNoGlue(messages);
    }
    // ... and OpenAI's summary-backed state never reaches DeepSeek.
    expectNoGlue(renderer.render([openaiMessage("m2")], chainOf({ m2: { summary: "SUMMARY-TEXT" } }), DEEPSEEK));
  });

  test("a turn whose only content was its reasoning is left out of the request, never sent empty", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const thinkingOnly: ProviderMessageLike = {
      role: "assistant",
      content: [],
      uuid: "m1",
      origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
      nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: reasoningBlockItems([{ at: 0, block: { type: "thinking", thinking: "private claude reasoning", signature: "S" } }]) },
    };
    const user: ProviderMessageLike = { role: "user", content: "next" };
    const { messages, report } = renderer.renderWithReport([user, thinkingOnly, user], chainOf({}), OPENAI);
    expect(messages).toEqual([user, user]);
    expect(report.droppedEmptyMessages).toBe(1);
    // A turn with a tool call and nothing else stays: the call is visible conversation.
    const callOnly: ProviderMessageLike = { ...thinkingOnly, content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
    expect(renderer.render([callOnly], chainOf({}), OPENAI)[0]!.content).toEqual([{ type: "tool_use", id: "t1", name: "Read", input: {} }]);
    // The model's own empty turn is ITS state, not stripped, so it is never dropped here.
    expect(renderer.render([thinkingOnly], chainOf({}), { ...CLAUDE_A, providerId: "anthropic", modelKey: "anthropic/claude-a" })).toEqual([thinkingOnly]);
  });

  test("a decoration a caller left on any message, of any role, is removed -- nothing annotates a request", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const user: ProviderMessageLike = { role: "user", content: "carry on", decoration: { text: "<prior_model_handoff>x</prior_model_handoff>", door: "tag" } };
    const own = claudeMessage("m1", { decoration: { text: "<recovered_reasoning>x</recovered_reasoning>", door: "tag" } });
    const foreign: ProviderMessageLike = { ...openaiMessage("m2"), decoration: { text: "[prior-model reasoning, carried as data]", door: "thinking-channel" } };
    const orphan: ProviderMessageLike = { role: "assistant", content: "rebuilt by compaction", decoration: { text: "<recovered_reasoning>x</recovered_reasoning>", door: "tag" } };
    const rendered = JSON.stringify(renderer.render([user, own, foreign, orphan], chainOf({}), CLAUDE_A));
    for (const needle of ['"decoration"', "recovered_", "prior_model_handoff", "prior-model reasoning"]) expect(rendered).not.toContain(needle);
  });
});

describe("the multi-hop chain (Claude -> OpenAI -> DeepSeek -> Claude)", () => {
  test("each hop back lights the returning model's own state up again; nobody ever sees anybody else's", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const history = [
      claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["CLAUDE-OPAQUE"] } }),
      openaiMessage("m2"),
      { ...deepseekMessage("m3"), nativeState: { family: "openai", continuationDomain: "deepseek/r-reason", items: [{ type: "winter.exposed_reasoning", text: "EXPOSED-TEXT" }] } },
      claudeMessage("m4", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["CLAUDE-OPAQUE-2"] } }),
    ];
    const chain = chainOf({ m1: { summary: "SUMMARY-TEXT" }, m2: { summary: "SUMMARY-TEXT" }, m3: { summary: "EXPOSED-TEXT" }, m4: { summary: "SUMMARY-TEXT" } });

    const forClaude = renderer.renderWithReport(history, chain, CLAUDE_A);
    expect(forClaude.messages[0]).toBe(history[0]!);
    expect(forClaude.messages[3]).toBe(history[3]!);
    expect(forClaude.report).toEqual({ replayedNatively: 2, droppedNativeState: 2, strippedInDialectBlocks: 0, droppedEmptyMessages: 0 });
    expect(JSON.stringify(forClaude.messages)).not.toContain("OPENAI-OPAQUE");
    expectNoGlue(forClaude.messages.slice(1, 3));

    const forOpenai = renderer.renderWithReport(history, chain, OPENAI);
    expect(forOpenai.messages[1]).toBe(history[1]!);
    for (const opaque of ["CLAUDE-OPAQUE", "SIG-OPAQUE", "REDACTED-OPAQUE"]) expect(JSON.stringify(forOpenai.messages)).not.toContain(opaque);
    expectNoGlue(forOpenai.messages);
    expect(forOpenai.messages.map((m) => (m.content as ContentBlockLike[]).flatMap((b) => (b.type === "text" ? [b.text] : [])))).toEqual([["the visible answer"], ["openai visible answer"], ["deepseek visible answer"], ["the visible answer"]]);
  });

  test("`onReport` sees every render", () => {
    const seen: number[] = [];
    const renderer = createHistoryRenderer(buildRegistry(), { onReport: (report) => seen.push(report.droppedNativeState) });
    renderer.render([openaiMessage("m1")], chainOf({}), CLAUDE_A);
    renderer.render([openaiMessage("m1")], chainOf({}), OPENAI);
    expect(seen).toEqual([1, 0]);
  });
});

// An OFFICIAL-written assistant entry (the retired `claude` leg) has NO sidecar record: its only
// provenance is claude's own `message.model`, read structurally.
describe("an official-written entry with no sidecar origin", () => {
  function officialClaudeMessage(): ProviderMessageLike & { model: string } {
    return {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private claude reasoning, first", signature: "SIG-FIRST-OPAQUE" },
        { type: "thinking", thinking: "private claude reasoning, then", signature: "SIG-SECOND-OPAQUE" },
        { type: "redacted_thinking", data: "REDACTED-PAYLOAD-OPAQUE" },
        { type: "text", text: "the visible final answer" },
      ],
      model: "anthropic/claude-a",
    };
  }

  test("for a foreign target its thinking (text, signatures, redacted data) is all left out, and the answer stays", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    for (const target of [OPENAI, DEEPSEEK]) {
      const { messages } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), target);
      const serialized = JSON.stringify(messages);
      for (const opaque of ["SIG-FIRST-OPAQUE", "SIG-SECOND-OPAQUE", "REDACTED-PAYLOAD-OPAQUE", "signature"]) expect(serialized).not.toContain(opaque);
      expect(serialized).toContain("the visible final answer");
      expectNoGlue(messages);
    }
  });

  test("a Claude target replays it NATIVELY -- the real thinking blocks, with their real signatures", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const content = renderer.render([officialClaudeMessage()], chainOf({}), CLAUDE_A)[0]!.content as ContentBlockLike[];
    expect(content.map((b) => b.type)).toEqual(["thinking", "thinking", "redacted_thinking", "text"]);
    expect(JSON.stringify(content)).toContain("SIG-FIRST-OPAQUE");
  });

  test("a Winter-native console/* entry keeps its own `console` origin (the structural fallback never applies to it)", () => {
    const consoleMessage: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "console reasoning", signature: "SIG-CONSOLE-OPAQUE" }, { type: "text", text: "the visible answer" }],
      uuid: "c1",
      origin: { providerId: "console", modelKey: "console/claude-fable", family: "anthropic", continuationDomain: "console/claude-fable" },
    };
    const renderer = createHistoryRenderer(buildRegistry());
    expect(JSON.stringify(renderer.render([consoleMessage], chainOf({}), { family: "anthropic", continuationDomain: "console/claude-fable", readableState: "summary" }))).toContain("SIG-CONSOLE-OPAQUE");
    expect(JSON.stringify(renderer.render([consoleMessage], chainOf({}), CLAUDE_A))).not.toContain("SIG-CONSOLE-OPAQUE");
  });
});

describe("fail-closed: a message whose origin cannot be resolved never rides its reasoning onto the wire", () => {
  test("no origin, no chain record, no structural model -- the REAL Anthropic wire body carries no signature, no redacted data, no thinking text", () => {
    const unresolved: ProviderMessageLike = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private claude reasoning, unattributed", signature: "SIG-SHOULD-NEVER-REACH-THE-WIRE" },
        { type: "redacted_thinking", data: "REDACTED-SHOULD-NEVER-REACH-THE-WIRE" },
        { type: "text", text: "the visible final answer" },
      ],
    };
    const { messages, report } = createHistoryRenderer(buildRegistry()).renderWithReport([unresolved], chainOf({}), CLAUDE_A);
    expect(messages[0]!.content).toEqual([{ type: "text", text: "the visible final answer" }]);
    expect(report.strippedInDialectBlocks).toBe(2);
    const wireJson = JSON.stringify(toWireMessages(messages));
    for (const opaque of ["signature", "redacted_thinking", "SIG-SHOULD-NEVER-REACH-THE-WIRE", "REDACTED-SHOULD-NEVER-REACH-THE-WIRE"]) expect(wireJson).not.toContain(opaque);
    expectNoGlue(wireJson);
    expect(wireJson).toContain("the visible final answer");
  });

  test("identity is preserved when there is nothing to strip", () => {
    const plain: ProviderMessageLike = { role: "assistant", content: "ordinary text, no opaque state at all" };
    expect(createHistoryRenderer(buildRegistry()).render([plain], chainOf({}), CLAUDE_A)[0]).toBe(plain);
  });

  test("nativeState alone is stripped too", () => {
    const unresolved: ProviderMessageLike = { role: "assistant", content: [{ type: "text", text: "visible answer" }], nativeState: { family: "openai", continuationDomain: "openai/o-reason", items: [{ encrypted_content: "OPAQUE-REASONING-STATE" }] } };
    const { messages, report } = createHistoryRenderer(buildRegistry()).renderWithReport([unresolved], chainOf({}), CLAUDE_A);
    expect(messages[0]!.nativeState).toBeUndefined();
    expect(report.droppedNativeState).toBe(1);
  });
});

// --- WS-23 (reasoning-state): Claude's thinking rides the sidecar, not the content --------------------
describe("WS-23: a Claude turn whose thinking rides `nativeState` (the sidecar) instead of its content", () => {
  const sidecarClaude = (uuid: string): ProviderMessageLike => {
    const { neutral, blocks } = separateReasoningBlocks(claudeMessage(uuid).content as ContentBlockLike[]);
    return {
      role: "assistant",
      content: neutral.length === 1 && neutral[0]!.type === "text" ? neutral[0]!.text : neutral,
      uuid,
      origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
      nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: reasoningBlockItems(blocks) },
    };
  };

  test("another model: the sidecar blocks are dropped with the native state, and nothing is built from their text", () => {
    const { messages, report } = createHistoryRenderer(buildRegistry()).renderWithReport([sidecarClaude("m1")], chainOf({ m1: {} }), OPENAI);
    expect(messages[0]!.nativeState).toBeUndefined();
    for (const opaque of ["SIG-OPAQUE", "REDACTED-OPAQUE", "winter.reasoning_block"]) expect(JSON.stringify(messages)).not.toContain(opaque);
    expectNoGlue(messages);
    expect(report.droppedNativeState).toBe(1);
  });

  test("same model: the blocks ride, and the Anthropic wire is the inline form byte for byte", () => {
    const moved = createHistoryRenderer(buildRegistry()).render([sidecarClaude("m1")], chainOf({ m1: {} }), { ...CLAUDE_A, providerId: "anthropic", modelKey: "anthropic/claude-a" });
    expect(JSON.stringify(toWireMessages(moved))).toBe(JSON.stringify(toWireMessages([claudeMessage("m1")])));
  });

  test("another Claude model gets neither the signed blocks nor their text", () => {
    const claudeB: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-b", readableState: "summary", providerId: "anthropic", modelKey: "anthropic/claude-b" };
    const wire = JSON.stringify(toWireMessages(createHistoryRenderer(buildRegistry()).render([sidecarClaude("m1")], chainOf({ m1: {} }), claudeB)));
    expect(wire).not.toContain("SIG-OPAQUE");
    expectNoGlue(wire);
    expect(wire).toContain("the visible answer");
  });
});

// --- WS-23 (reasoning-state, decisions 8 and 9): what the target cannot represent becomes text -------------
describe("WS-23: another vendor's server tools and unreadable media reach the target as text", () => {
  const serverTurn = (): ProviderMessageLike =>
    ({
      role: "assistant",
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "winter" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "Winter", url: "https://example.com/w" }] },
        { type: "text", text: "found it" },
      ],
      origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
    }) as unknown as ProviderMessageLike;

  test("to another vendor: the call and its results become text (titles and urls), the rest untouched", () => {
    const [message] = createHistoryRenderer(buildRegistry()).render([serverTurn()], chainOf({}), OPENAI);
    expect(message!.content).toEqual([
      { type: "text", text: '[server tool call: web_search {"query":"winter"}]' },
      { type: "text", text: "[web search results]\n- Winter (https://example.com/w)" },
      { type: "text", text: "found it" },
    ]);
  });

  test("to Anthropic itself: untouched", () => {
    const original = serverTurn();
    const [message] = createHistoryRenderer(buildRegistry()).render([original], chainOf({}), { ...CLAUDE_A, providerId: "anthropic", modelKey: "anthropic/claude-a" });
    expect(message!.content).toEqual(original.content);
  });

  test("a model that reads no images gets a note in each image's place, nested ones included; one that does is untouched", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "QUJD" } };
    const history: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "look" }, image] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: [image, { type: "text", text: "page 1" }] }] },
    ];
    const textOnly = createHistoryRenderer(buildRegistry()).render(history, chainOf({}), { ...OPENAI, readsImages: false });
    expect(JSON.stringify(textOnly)).not.toContain("QUJD");
    expect(textOnly[0]!.content).toEqual([{ type: "text", text: "look" }, { type: "text", text: "[an image was here; this model cannot read images]" }]);
    expect((textOnly[1]!.content as Array<{ content: unknown }>)[0]!.content).toEqual([{ type: "text", text: "[an image was here; this model cannot read images]" }, { type: "text", text: "page 1" }]);
    const vision = createHistoryRenderer(buildRegistry()).render(history, chainOf({}), OPENAI);
    expect(vision[0]).toBe(history[0]!);
  });
});
