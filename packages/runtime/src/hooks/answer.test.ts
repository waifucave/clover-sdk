// 0.0.87: a PreToolUse hook may ANSWER a call (`hookSpecificOutput.toolResult`): the tool doesn't run
// and the answer is its result. Pinned here at the runner and the reducer (the engine's half is
// engine.hook-answer.test.ts): only a host (`sdk`) hook may answer, an answer is the hook's allow,
// a deny from any hook wins over it, and a malformed answer contributes nothing (or denies, fail-closed).
import { describe, test, expect } from "bun:test";
import type { HookEvent } from "@waifucave/clover-agent-sdk";
import type { SourcedHookEntry, HookRegistry } from "./registry.ts";
import { runHooks, type HookInvoker, type HookInvocationRequest, type RunHooksContext } from "./runner.ts";
import { reduceHookOutcomes } from "./reducer.ts";

function fakeRegistry(entries: SourcedHookEntry[]): HookRegistry {
  return { matching: (event: HookEvent) => entries.filter((e) => e.event === event) };
}

function sequenceInvoker(raws: unknown[]): { invoker: HookInvoker; requests: HookInvocationRequest[] } {
  const requests: HookInvocationRequest[] = [];
  let i = 0;
  return { invoker: { invoke: async (request) => { requests.push(request); return raws[i++]; } }, requests };
}

function ctx(entries: SourcedHookEntry[], invoker: HookInvoker, extra: Partial<RunHooksContext> = {}): RunHooksContext {
  return { registry: fakeRegistry(entries), invoker, audit: { record: () => {} }, sessionId: "s", policyVersion: 1, timeouts: { gatingTimeoutMs: 200, observationalTimeoutMs: 200 }, ...extra };
}

const pre = (id: string, overrides: Partial<SourcedHookEntry> = {}): SourcedHookEntry => ({ id, event: "PreToolUse", source: "sdk", ...overrides });
const answer = (content: unknown, more: Record<string, unknown> = {}) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content }, ...more } });
const call = { toolUseID: "c1", toolName: "Read", input: { file_path: "home/Studio/a.txt" } };

describe("a PreToolUse hook's answer (0.0.87)", () => {
  test("a host hook's answer is its allow, carried on the composite with the hook that gave it", async () => {
    const { invoker } = sequenceInvoker([answer("hello")]);
    const c = await runHooks("PreToolUse", call, ctx([pre("h1", { name: "tree" })], invoker));
    expect(c.decision).toBe("allow");
    expect(c.answer).toEqual({ content: "hello", isError: false, hookId: "h1", hookName: "tree" });
  });

  test("isError, text and image blocks, and an MCP CallToolResult shape are taken as given", async () => {
    const blocks = [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }];
    for (const [content, isError] of [[blocks, true], [{ content: [{ type: "text", text: "x" }] }, false]] as const) {
      const { invoker } = sequenceInvoker([{ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content, isError } } }]);
      const c = await runHooks("PreToolUse", call, ctx([pre("h1")], invoker));
      expect(c.answer).toMatchObject({ content, isError });
    }
  });

  test("permissionDecision \"allow\" with it is fine; deny, ask or defer with it, or a top-level block, is malformed (no contribution)", async () => {
    const ok = await runHooks("PreToolUse", call, ctx([pre("h1")], sequenceInvoker([answer("x", { permissionDecision: "allow" })]).invoker));
    expect(ok.answer?.content).toBe("x");
    for (const d of ["deny", "ask", "defer"]) {
      const c = await runHooks("PreToolUse", call, ctx([pre("h1")], sequenceInvoker([answer("x", { permissionDecision: d })]).invoker));
      expect([d, c.decision, c.answer]).toEqual([d, undefined, undefined]);
      expect(c.lifecycleMessages[0]?.outcome).toBe("error");
    }
    const blocked = await runHooks("PreToolUse", call, ctx([pre("h1")], sequenceInvoker([{ decision: "block", hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content: "x" } } }]).invoker));
    expect(blocked.answer).toBeUndefined();
  });

  test("a malformed toolResult is no answer: never read as an allow that would run the tool", async () => {
    for (const bad of [{}, { content: 5 }, { content: [] }, { content: [{ type: "video" }] }, { content: "x", isError: "yes" }, "x", null]) {
      const c = await runHooks("PreToolUse", call, ctx([pre("h1")], sequenceInvoker([{ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: bad } }]).invoker));
      expect([bad, c.decision, c.answer]).toEqual([bad, undefined, undefined]);
    }
    // Fail-closed: a malformed answer denies.
    const closed = await runHooks("PreToolUse", call, ctx([pre("h1", { failClosed: true })], sequenceInvoker([{ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content: 5 } } }]).invoker));
    expect(closed.decision).toBe("deny");
  });

  test("only the host answers: a plugin's, a user settings', a project's or a managed hook's answer is refused", async () => {
    for (const source of ["plugin", "user", "project", "local", "managed"] as const) {
      const c = await runHooks("PreToolUse", call, ctx([pre("h1", { source })], sequenceInvoker([answer("forged")]).invoker));
      expect([source, c.decision, c.answer]).toEqual([source, undefined, undefined]);
      const closed = await runHooks("PreToolUse", call, ctx([pre("h1", { source, failClosed: true })], sequenceInvoker([answer("forged")]).invoker));
      expect([source, closed.decision, closed.answer]).toEqual([source, "deny", undefined]);
    }
  });

  test("deny wins: a later hook's deny drops the answer; an earlier deny means the answering hook never runs", async () => {
    const later = sequenceInvoker([answer("x"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } }]);
    const c = await runHooks("PreToolUse", call, ctx([pre("h1"), pre("h2", { source: "plugin" })], later.invoker));
    expect(c.decision).toBe("deny");
    expect(c.answer).toBeUndefined();
    const earlier = sequenceInvoker([{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } }, answer("x")]);
    const d = await runHooks("PreToolUse", call, ctx([pre("h1"), pre("h2")], earlier.invoker));
    expect(d.decision).toBe("deny");
    expect(d.answer).toBeUndefined();
    expect(earlier.requests).toHaveLength(1);
  });

  test("another hook's ask outranks the answer's allow, and the answer stays (delivered on a yes)", async () => {
    const { invoker } = sequenceInvoker([answer("x"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }]);
    const c = await runHooks("PreToolUse", call, ctx([pre("h1"), pre("h2")], invoker));
    expect(c.decision).toBe("ask");
    expect(c.answer?.content).toBe("x");
  });

  test("two answers: the earliest one stands", async () => {
    const { invoker } = sequenceInvoker([answer("first"), answer("second")]);
    const c = await runHooks("PreToolUse", call, ctx([pre("h1"), pre("h2")], invoker));
    expect(c.answer).toMatchObject({ content: "first", hookId: "h1" });
  });

  test("the turn's abort reaches a running hook's signal", async () => {
    const turn = new AbortController();
    let seen: AbortSignal | undefined;
    const invoker: HookInvoker = {
      invoke: (_r, opts) => new Promise((resolve) => {
        seen = opts.signal;
        opts.signal.addEventListener("abort", () => resolve(answer("late")), { once: true });
      }),
    };
    const running = runHooks("PreToolUse", call, ctx([pre("h1")], invoker, { signal: turn.signal, timeouts: { gatingTimeoutMs: 5_000, observationalTimeoutMs: 5_000 } }));
    await Bun.sleep(10);
    expect(seen?.aborted).toBe(false);
    turn.abort();
    await running;
    expect(seen?.aborted).toBe(true);
  });

  test("the reducer never carries an answer beside a deny", () => {
    const participant = (id: string) => ({ id, event: "PreToolUse" as const, source: "sdk" as const });
    const c = reduceHookOutcomes([
      { participant: participant("h1"), outcome: { kind: "decision", decision: "allow", answer: { content: "x", isError: false } } },
      { participant: participant("h2"), outcome: { kind: "decision", decision: "deny" } },
    ]);
    expect(c.decision).toBe("deny");
    expect(c.answer).toBeUndefined();
  });
});
