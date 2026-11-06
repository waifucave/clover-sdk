// The coding agent as an ACP agent, against a scripted `query()`: what a client (Clover's agent manager) sees on the
// wire for a session, a turn, a tool call with a permission request, a cancel, config options and a resume.
import { describe, expect, test } from "bun:test";
import { RpcPeer } from "./jsonrpc.ts";
import { mcpServersOf, serveAcpAgent, toolKindOf, type AcpQuery } from "./agent.ts";

type CanUseTool = (name: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }) => Promise<{ behavior: string; message?: string }>;

/** A scripted `query()`: each input plays the next script entry; a `tool` step asks `canUseTool` first. */
function fakeQuery(script: ((ctl: { ask: CanUseTool; signal: AbortSignal }) => AsyncGenerator<unknown>)[]) {
  const seen: { options?: Record<string, unknown>; calls: string[] } = { calls: [] };
  const fn = (args: { prompt: AsyncIterable<string>; options: Record<string, unknown> }): AcpQuery => {
    seen.options = args.options;
    let abort = new AbortController();
    const ask = args.options["canUseTool"] as CanUseTool;
    async function* run(): AsyncGenerator<unknown> {
      yield { type: "system", subtype: "init", session_id: args.options["sessionId"] ?? args.options["resume"], model: "fake-model", permissionMode: "default" };
      let i = 0;
      for await (const text of args.prompt) {
        seen.calls.push(`prompt:${text}`);
        const step = script[i++];
        abort = new AbortController();
        if (step) yield* step({ ask, signal: abort.signal });
        yield { type: "result", subtype: abort.signal.aborted ? "error_during_execution" : "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: async () => {
        seen.calls.push("interrupt");
        abort.abort();
      },
      setModel: async (m?: string) => void seen.calls.push(`model:${m}`),
      setPermissionMode: async (m: string) => void seen.calls.push(`mode:${m}`),
      setEffort: async (e?: string | null) => void seen.calls.push(`effort:${e}`),
      supportedModels: async () => [{ value: "fake-model" }, { value: "fake-model-2" }],
    });
  };
  return { fn, seen };
}

function connect(query: ReturnType<typeof fakeQuery>["fn"], answer: (params: Record<string, unknown>) => unknown = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }), options?: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];
  let client!: RpcPeer;
  const server = serveAcpAgent({ query, agentInfo: { name: "clover-code", version: "0.0.0" }, write: (l) => queueMicrotask(() => client.feed(new TextEncoder().encode(l))), newId: () => "sess-1", ...(options ? { options } : {}) });
  client = new RpcPeer({
    write: (l) => queueMicrotask(() => server.feed(l)),
    onRequest: async (method, params) => {
      if (method !== "session/request_permission") throw new Error(method);
      asks.push(params as Record<string, unknown>);
      return answer(params as Record<string, unknown>);
    },
    onNotification: (method, params) => {
      if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
    },
  });
  return { client, server, updates, asks };
}

describe("the coding agent over ACP", () => {
  test("initialize, a session, a streamed turn with a tool call that asks first, and its result", async () => {
    const q = fakeQuery([
      async function* ({ ask, signal }) {
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me look." } } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Running the tests." } } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } };
        const verdict = await ask("Bash", { command: "npm test" }, { signal, toolUseID: "tu1" });
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: verdict.behavior === "allow" ? "12 passed" : "denied", is_error: verdict.behavior !== "allow" }] } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "All 12 pass." } } };
        yield { type: "assistant", message: { content: [{ type: "text", text: "All 12 pass." }] } };
      },
    ]);
    const { client, updates, asks } = connect(q.fn);
    const init = (await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} })) as Record<string, unknown>;
    expect(init).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } }, authMethods: [] });
    const s = (await client.request("session/new", {
      cwd: "/work/project",
      mcpServers: [{ name: "clover_ab12", command: "/opt/clover-core", args: ["bridge"], env: [{ name: "CLOVER_BRIDGE_TOKEN", value: "t" }] }],
      _meta: { systemPrompt: { append: "Use SendMessage to report." } },
    })) as { sessionId: string; configOptions: { id: string }[]; modes: { currentModeId: string } };
    expect(s.sessionId).toBe("sess-1");
    expect(s.configOptions.map((c) => c.id)).toEqual(["model", "mode", "thought_level"]);
    expect(s.modes.currentModeId).toBe("default");
    expect(q.seen.options).toMatchObject({
      cwd: "/work/project", sessionId: "sess-1", includePartialMessages: true, permissionMode: "default",
      mcpServers: { clover_ab12: { type: "stdio", command: "/opt/clover-core", args: ["bridge"], env: { CLOVER_BRIDGE_TOKEN: "t" } } },
      systemPrompt: { type: "preset", preset: "claude_code", append: "Use SendMessage to report." },
    });
    const end = await client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "Fix the tests." }] });
    expect(end).toEqual({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(updates.map((u) => u["sessionUpdate"])).toEqual(["agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    expect(updates[2]).toMatchObject({ toolCallId: "tu1", kind: "execute", title: "npm test", status: "pending", rawInput: { command: "npm test" } });
    expect(updates[3]).toMatchObject({ toolCallId: "tu1", status: "completed", content: [{ type: "content", content: { type: "text", text: "12 passed" } }] });
    expect(asks[0]).toMatchObject({ sessionId: "sess-1", toolCall: { toolCallId: "tu1", kind: "execute" } });
    expect((asks[0]!["options"] as { kind: string }[]).map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  test("a refused permission becomes the tool's denial; a cancel interrupts the turn and ends it cancelled", async () => {
    let release!: () => void;
    const q = fakeQuery([
      async function* ({ ask, signal }) {
        const v = await ask("Write", { file_path: "/work/a.txt", content: "x" }, { signal, toolUseID: "tu2" });
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: v.message ?? "", is_error: v.behavior !== "allow" }] } };
      },
      async function* ({ signal }) {
        await new Promise<void>((r) => {
          release = r;
          signal.addEventListener("abort", () => r(), { once: true });
        });
      },
    ]);
    const { client, updates, asks } = connect(q.fn, () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }));
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    await client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "Write a." }] });
    expect(asks[0]).toMatchObject({ toolCall: { kind: "edit", locations: [{ path: "/work/a.txt" }] } });
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "tu2", status: "failed", content: [{ content: { text: "The user refused this." } }] });
    const turn = client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "Wait." }] });
    await new Promise((r) => setTimeout(r, 20));
    client.notify("session/cancel", { sessionId: "sess-1" });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect(q.seen.calls).toContain("interrupt");
    void release;
  });

  test("config options and modes reach the query; plan is the read-only mode; a resume uses the transcript", async () => {
    const q = fakeQuery([]);
    const { client, updates } = connect(q.fn);
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    const r = (await client.request("session/set_config_option", { sessionId: "sess-1", configId: "mode", value: "plan" })) as { configOptions: { id: string; currentValue: string }[] };
    expect(r.configOptions.find((c) => c.id === "mode")!.currentValue).toBe("plan");
    await client.request("session/set_config_option", { sessionId: "sess-1", configId: "model", value: "fake-model-2" });
    await client.request("session/set_config_option", { sessionId: "sess-1", configId: "thought_level", value: "high" });
    await client.request("session/set_mode", { sessionId: "sess-1", modeId: "acceptEdits" });
    expect(q.seen.calls).toEqual(["mode:plan", "model:fake-model-2", "effort:high", "mode:acceptEdits"]);
    expect(updates.at(-1)).toEqual({ sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" });
    const bad = await client.request("session/set_config_option", { sessionId: "sess-1", configId: "mode", value: "bypassPermissions" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
    await client.request("session/close", { sessionId: "sess-1" });
    const q2 = fakeQuery([]);
    const c2 = connect(q2.fn);
    await c2.client.request("initialize", { protocolVersion: 1 });
    await c2.client.request("session/resume", { sessionId: "sess-1", cwd: "/work", mcpServers: [] });
    expect(q2.seen.options).toMatchObject({ resume: "sess-1", cwd: "/work" });
    expect(q2.seen.options!["sessionId"]).toBeUndefined();
  });

  test("tool kinds and MCP server entries", () => {
    expect(["Read", "Edit", "Bash", "Grep", "WebFetch", "Task"].map(toolKindOf)).toEqual(["read", "edit", "execute", "search", "fetch", "other"]);
    expect(mcpServersOf([{ type: "http", name: "h", url: "https://x", headers: [{ name: "a", value: "b" }] }, { name: "nocommand" }])).toEqual({ h: { type: "http", url: "https://x", headers: { a: "b" } } });
  });
  test("the client's answer is the only allow: no settings files by default, never bypass, pre-allowing options refused", async () => {
    const q = fakeQuery([]);
    const { client } = connect(q.fn, undefined, { model: "m", allowDangerouslySkipPermissions: false, trustedWorkspace: true });
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    expect(q.seen.options).toMatchObject({ settingSources: [], allowDangerouslySkipPermissions: false, permissionMode: "default" });
    const q2 = fakeQuery([]);
    const c2 = connect(q2.fn, undefined, { settingSources: ["project"] });
    await c2.client.request("initialize", { protocolVersion: 1 });
    await c2.client.request("session/new", { cwd: "/work", mcpServers: [] });
    expect(q2.seen.options!["settingSources"]).toEqual(["project"]);
    const write = () => {};
    for (const bad of [
      { allowedTools: ["Bash"] }, { permissionPromptToolName: "mcp__x__ask" }, { permissions: { allow: ["Bash(*)"] } },
      { serverManagedSettings: { permissions: { allow: ["Edit"] } } }, { allowDangerouslySkipPermissions: true },
    ]) {
      expect(() => serveAcpAgent({ query: q.fn, agentInfo: { name: "x", version: "0" }, write, options: bad })).toThrow(/without the client's answer/);
    }
  });

  test("an allow that arrives after its turn was cancelled is a refusal", async () => {
    let verdict: { behavior: string } | undefined;
    let answer!: (v: unknown) => void;
    const q = fakeQuery([
      async function* ({ ask, signal }) {
        verdict = await ask("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, toolUseID: "tu9" });
        void signal;
      },
    ]);
    const { client, asks } = connect(q.fn, () => new Promise((r) => (answer = r)));
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    const turn = client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "Clean." }] });
    for (let i = 0; i < 50 && asks.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(asks.length).toBe(1);
    client.notify("session/cancel", { sessionId: "sess-1" });
    await new Promise((r) => setTimeout(r, 10));
    answer({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect(verdict?.behavior).toBe("deny");
  });

  test("plan mode is left only through an ExitPlanMode the client allowed, and the client is told the new mode", async () => {
    const q = fakeQuery([
      async function* ({ ask, signal }) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "tp1", name: "ExitPlanMode", input: { plan: "1. Fix it." } }] } };
        const v = await ask("ExitPlanMode", { plan: "1. Fix it." }, { signal, toolUseID: "tp1" });
        const allowed = v.behavior === "allow";
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tp1", is_error: !allowed, content: allowed ? JSON.stringify({ previousMode: "plan", newMode: "default" }) : "refused" }] },
        };
      },
    ]);
    const { client, updates, asks } = connect(q.fn);
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    await client.request("session/set_mode", { sessionId: "sess-1", modeId: "plan" });
    await client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "Plan, then fix." }] });
    expect(asks[0]).toMatchObject({ toolCall: { kind: "switch_mode" } });
    expect(updates.find((u) => u["sessionUpdate"] === "tool_call")).toMatchObject({ kind: "switch_mode" });
    expect(updates.at(-1)).toEqual({ sessionUpdate: "current_mode_update", currentModeId: "default" });
    const r = (await client.request("session/set_config_option", { sessionId: "sess-1", configId: "thought_level", value: "low" })) as { configOptions: { id: string; currentValue: string }[] };
    expect(r.configOptions.find((c) => c.id === "mode")!.currentValue).toBe("default");
  });

  test("a resume takes only a session id this agent hands out; the sessions end when the link closes", async () => {
    const q = fakeQuery([]);
    const { client, server } = connect(q.fn);
    await client.request("initialize", { protocolVersion: 1 });
    for (const bad of ["../../etc/passwd", "a b", "*", "x".repeat(200)]) {
      expect(await client.request("session/resume", { sessionId: bad, cwd: "/work", mcpServers: [] }).catch((e: unknown) => e)).toBeInstanceOf(Error);
    }
    await client.request("session/new", { cwd: "/work", mcpServers: [] });
    // A line too long to read breaks the link: the agent ends every session and says it has ended.
    const small = serveAcpAgent({ query: fakeQuery([]).fn, agentInfo: { name: "x", version: "0" }, write: () => {} });
    small.feed(`${"x".repeat(33 * 1024 * 1024)}\n`);
    await small.ended;
    await server.close();
    await server.ended;
  });
});
