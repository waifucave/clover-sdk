// 0.0.87: a host's PreToolUse hook ANSWERS a call (`toolResult`), pinned through the real engine, the
// real registry and the real hook bridge (callback hooks answered over the in-memory channel as a
// host's SDK wrapper answers them): the tool never runs, its result is the answer (with a true
// `is_error`), the call is still the model's own call with its original input, PostToolUse sees it,
// and a deny, a defer or a prompt's no keeps the answer from being delivered.
import { test, expect, describe } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, RuntimeHooksConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@waifucave/clover-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { answeredToolResult, runEngine, type ContentBlock, type EngineOptions, type Provider, type ProviderMessage, type ProviderTurn } from "./engine.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "winter-test/echo", ...overrides });

interface HookCall {
  event: string;
  toolName?: string;
  payload?: Record<string, unknown>;
}

function recordingProvider(turns: ProviderTurn[]): { provider: Provider; requests: Array<{ messages: ProviderMessage[] }> } {
  const requests: Array<{ messages: ProviderMessage[] }> = [];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push({ messages: input.messages.map((m) => ({ ...m })) });
        return turns[Math.min(i++, turns.length - 1)]!;
      },
    },
  };
}

/** A tool executor that counts its runs: an answered call must never reach it. */
function countingTools(): { tools: NonNullable<EngineOptions["tools"]>; runs: unknown[] } {
  const runs: unknown[] = [];
  return { runs, tools: { async execute(call) { runs.push(call.input); return { output: "THE TOOL RAN" }; } } };
}

async function run(opts: {
  turns: ProviderTurn[];
  hooks: RuntimeHooksConfig;
  answer: (call: HookCall, n: number) => unknown | Promise<unknown>;
  config?: Partial<RuntimeConfig>;
  engine?: Partial<EngineOptions>;
  canUseTool?: (payload: unknown) => unknown;
  /** Called with each frame as it arrives (to interrupt mid-call). */
  onFrame?: (f: WinterFrame, send: (frame: unknown) => void) => void;
}): Promise<{ messages: SdkMessage[]; hookCalls: HookCall[]; requests: Array<{ messages: ProviderMessage[] }>; runs: unknown[] }> {
  const { host, runtime } = createInMemoryChannel();
  const { provider, requests } = recordingProvider(opts.turns);
  const counted = countingTools();
  const done = runEngine({
    config: baseConfig({ allowedTools: ["t"], hooks: opts.hooks, ...opts.config }),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: counted.tools,
    ...opts.engine,
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const hookCalls: HookCall[] = [];
  const frames: WinterFrame[] = [];
  const send = (frame: unknown) => host.output.write(frame as never);
  for await (const f of host.input) {
    frames.push(f);
    opts.onFrame?.(f, send);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const p = cf.payload as { event: string; toolName?: string; payload?: Record<string, unknown> };
      const call: HookCall = { event: p.event, ...(p.toolName !== undefined ? { toolName: p.toolName } : {}), ...(p.payload !== undefined ? { payload: p.payload } : {}) };
      hookCalls.push(call);
      const n = hookCalls.filter((h) => h.event === call.event).length;
      void Promise.resolve(opts.answer(call, n)).then((payload) => host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: payload ?? {} }));
    }
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "can_use_tool" && opts.canUseTool) {
      const cf = f as ControlRequestFrame;
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: opts.canUseTool(cf.payload) });
    }
  }
  await done;
  const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
  return { messages, hookCalls, requests, runs: counted.runs };
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n");
}

function toolResult(messages: ProviderMessage[], id: string): Extract<ContentBlock, { type: "tool_result" }> | undefined {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) return b;
  }
  return undefined;
}

function toolUse(messages: ProviderMessage[], id: string): Extract<ContentBlock, { type: "tool_use" }> | undefined {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use" && b.id === id) return b;
  }
  return undefined;
}

const TOOL_ROUND: ProviderTurn[] = [{ kind: "tool_use", calls: [{ id: "c1", name: "t", input: { path: "home/Studio/a.txt" } }] }, { kind: "text", text: "done" }];
const hooks = (pre: number, post = true): RuntimeHooksConfig => ({
  PreToolUse: [{ hookCount: pre, source: "sdk" }],
  ...(post ? { PostToolUse: [{ hookCount: 1, source: "sdk" }], PostToolUseFailure: [{ hookCount: 1, source: "sdk" }] } : {}),
});
const answerWith = (content: unknown, isError?: boolean) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content, ...(isError === undefined ? {} : { isError }) } } });

describe("a host hook answers a call (0.0.87)", () => {
  test("the tool never runs; the answer is the result; the call keeps the model's own input; PostToolUse sees the answer", async () => {
    const { requests, runs, hookCalls } = await run({ turns: TOOL_ROUND, hooks: hooks(1), answer: (c) => (c.event === "PreToolUse" ? answerWith("from Studio") : {}) });
    expect(runs).toHaveLength(0);
    const result = toolResult(requests[1]!.messages, "c1")!;
    expect(textOf(result.content)).toContain("from Studio");
    expect(result.is_error).toBeUndefined();
    expect(toolUse(requests[1]!.messages, "c1")?.input).toEqual({ path: "home/Studio/a.txt" });
    const post = hookCalls.find((h) => h.event === "PostToolUse");
    expect(post?.toolName).toBe("t");
    expect(JSON.stringify(post?.payload)).toContain("from Studio");
    expect(hookCalls.some((h) => h.event === "PostToolUseFailure")).toBe(false);
  });

  test("isError: true is a real failure: is_error on the block, PostToolUseFailure fires", async () => {
    const { requests, runs, hookCalls } = await run({ turns: TOOL_ROUND, hooks: hooks(1), answer: (c) => (c.event === "PreToolUse" ? answerWith("computer offline: Studio is offline", true) : {}) });
    expect(runs).toHaveLength(0);
    const result = toolResult(requests[1]!.messages, "c1")!;
    expect(result.is_error).toBe(true);
    expect(textOf(result.content)).toContain("computer offline");
    expect(hookCalls.some((h) => h.event === "PostToolUseFailure")).toBe(true);
    expect(hookCalls.some((h) => h.event === "PostToolUse")).toBe(false);
  });

  test("deny wins: a second hook's deny refuses the call, and neither the answer nor the tool reaches the model", async () => {
    const { requests, runs } = await run({
      turns: TOOL_ROUND, hooks: hooks(2, false),
      answer: (c, n) => (c.event !== "PreToolUse" ? {} : n === 1 ? answerWith("ANSWER") : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not here" } }),
    });
    expect(runs).toHaveLength(0);
    const text = textOf(toolResult(requests[1]!.messages, "c1")!.content);
    expect(text).not.toContain("ANSWER");
    expect(text).toContain("not here");
  });

  test("a deny rule wins over an answer too", async () => {
    const { requests, runs, hookCalls } = await run({ turns: TOOL_ROUND, hooks: hooks(1, false), answer: () => answerWith("ANSWER"), config: { allowedTools: ["t"], disallowedTools: ["t"] } });
    expect(runs).toHaveLength(0);
    const result = toolResult(requests[1]!.messages, "c1")!;
    expect(textOf(result.content)).not.toContain("ANSWER");
    expect(textOf(result.content).toLowerCase()).toContain("den");
    // Whether the rule is read before or after the hook, the answer never wins over it.
    expect(hookCalls.filter((h) => h.event === "PreToolUse").length).toBeLessThanOrEqual(1);
  });

  test("a defer from another hook with an answer is a denial: nothing parked, nothing delivered", async () => {
    const { requests, runs } = await run({
      turns: TOOL_ROUND, hooks: hooks(2, false),
      answer: (c, n) => (c.event !== "PreToolUse" ? {} : n === 1 ? answerWith("ANSWER") : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } }),
    });
    expect(runs).toHaveLength(0);
    const text = textOf(toolResult(requests[1]!.messages, "c1")!.content);
    expect(text).not.toContain("ANSWER");
    expect(text).toContain("can't be parked");
  });

  test("the answer is bounded as a PostToolUse replacement is (100,000 characters)", () => {
    const r = answeredToolResult({ content: "x".repeat(250_000), isError: false });
    expect(r.output.length).toBeLessThanOrEqual(100_200);
    expect(r.isError).toBeUndefined();
    const img = answeredToolResult({ content: [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], isError: true });
    expect(img.blocks).toHaveLength(2);
    expect(img.isError).toBe(true);
    expect(answeredToolResult({ content: [], isError: false })).toEqual({ output: "" });
    expect(answeredToolResult({ content: { content: [] }, isError: false })).toEqual({ output: "" });
  });

  test("a host hook's malformed answer denies: the tool never runs with the model's input", async () => {
    const { requests, runs } = await run({ turns: TOOL_ROUND, hooks: hooks(1, false), answer: () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content: "x", isError: "true" } } }) });
    expect(runs).toHaveLength(0);
    expect(textOf(toolResult(requests[1]!.messages, "c1")!.content)).toContain("was not run");
  });

  test("an empty listing answered as an empty block array: an empty result, the tool never runs", async () => {
    const { requests, runs } = await run({ turns: TOOL_ROUND, hooks: hooks(1, false), answer: () => answerWith([]) });
    expect(runs).toHaveLength(0);
    const result = toolResult(requests[1]!.messages, "c1")!;
    expect(result.is_error).toBeUndefined();
    expect(textOf(result.content)).not.toContain("THE TOOL RAN");
  });

  test("an interrupt while the answering hook runs aborts the call; the tool never runs", async () => {
    let interrupted = false;
    const { runs, messages } = await run({
      turns: TOOL_ROUND, hooks: hooks(1, false),
      // Never answers on its own: only the interrupt ends it (the turn's abort reaches the hook).
      answer: () => new Promise(() => {}),
      onFrame: (f, send) => {
        if (!interrupted && f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
          interrupted = true;
          setTimeout(() => send({ type: "control_request", requestId: "i1", subtype: "interrupt", payload: { scope: "turn" } }), 20);
        }
      },
      config: { allowedTools: ["t"] },
    });
    expect(interrupted).toBe(true);
    expect(runs).toHaveLength(0);
    expect(messages.some((m) => m.type === "result")).toBe(true);
  }, 15_000);
});
