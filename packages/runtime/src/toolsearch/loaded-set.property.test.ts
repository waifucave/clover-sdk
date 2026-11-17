// Generated sessions across REOPENS: one MCP tool is eager or on demand in the live registry, flipped at random
// between runtime reopens (a resume on the same history), and the model sometimes searches for it. After every
// request the invariant: a tool the request offers as callable (declared eager in the epoch's frozen `tools`, or
// surfaced by a `tool_reference` in the history or by a tool-change entry, and not withdrawn since) is never
// refused by the load-first gate; a tool the request does NOT offer is never callable. Seeded (mulberry32), the
// failing seed is in the message.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@waifucave/clover-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { registerMcpServerTools, registerTool, replaceExecutor, unregisterMcpServerTools, unregisterToolForTest } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { attachmentMessage } from "../context/attachments.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROW: ModelDescription = { wire: { deferredToolLoading: true, toolChanges: "inline" } };

async function runOnce(opts: { server: string; select: string; script: ProviderTurn[]; initialMessages: ProviderMessage[] }): Promise<{ requests: ProviderRequest[]; attachments: Array<{ type: string }>; frames: WinterFrame[] }> {
  const requests: ProviderRequest[] = [];
  const attachments: Array<{ type: string }> = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: `loaded-set-${Math.random().toString(36).slice(2)}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: true, capabilities: ["winter.mcp"] };
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages), ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return opts.script[requests.length - 1] ?? { kind: "text", text: "done" };
      },
    },
    mcpServerStateSource: createFakeMcpServerStateSource([{ name: opts.server, state: "connected", toolNames: [] }]),
    providerSupportsToolSearch: true,
    deferrableContextShare: 100,
    describeModel: () => ROW,
    initialMessages: opts.initialMessages,
    store: {
      recordUserEntry() {},
      recordAssistantEntry() {},
      recordAttachmentEntry(a: { type: string }) {
        attachments.push(structuredClone(a));
      },
    },
  } as EngineOptions);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const frame of host.input) frames.push(frame);
  await done;
  return { requests, attachments, frames };
}

async function session(seed: number): Promise<void> {
  const rand = rng(seed);
  const tag = `ls${seed}`;
  const server = `ws23-${tag}`;
  const canonical = `mcp__${server}__search_docs`;
  const select = `__ls_select_${tag}__`;
  const trace: string[] = [];
  const register = (deferred: boolean): void => {
    unregisterMcpServerTools(server);
    registerMcpServerTools(server, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: deferred });
    replaceExecutor(canonical, { async execute() { return { output: "real result" }; } });
  };
  registerTool({
    descriptor: { canonicalName: select, advertisedName: select, source: "sdk", inputSchema: { type: "object" }, description: "test-only ToolSearch stand-in", exposure: "hidden", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: {
      async execute(_input, ctx) {
        ctx.emitToolReference?.([canonical]);
        return { output: "{}" };
      },
    },
  });
  try {
    let history: ProviderMessage[] = [];
    let deferred = rand() < 0.5;
    register(deferred);
    for (let phase = 0; phase < 4; phase++) {
      if (phase > 0 && rand() < 0.6) {
        deferred = !deferred; // the person flips the setting; the runtime is reopened (this run) on the same history
        register(deferred);
      }
      const search = rand() < 0.35;
      trace.push(`${deferred ? "D" : "E"}${search ? "+search" : ""}`);
      const script: ProviderTurn[] = search
        ? [{ kind: "tool_use", calls: [{ id: "s1", name: select, input: {} }] }, { kind: "tool_use", calls: [{ id: "c1", name: canonical, input: {} }] }, { kind: "text", text: "done" }]
        : [{ kind: "tool_use", calls: [{ id: "c1", name: canonical, input: {} }] }, { kind: "text", text: "done" }];
      const { requests, attachments, frames } = await runOnce({ server, select, script, initialMessages: history });
      const callIndex = search ? 1 : 0;
      const req = requests[callIndex]!;
      // What the request offers: eager declaration, a reference in history/this run, a tool-change reference not withdrawn since.
      const declared = req.tools!.find((t) => t.name === canonical);
      const referencedInHistory = JSON.stringify(req.messages).includes(`"loadedTools":["${canonical}"]`) || history.some((m) => JSON.stringify(m).includes(`"loadedTools":["${canonical}"]`)) || search;
      let changeState: boolean | undefined;
      for (const m of req.messages) {
        if (m.toolChanges === undefined) continue;
        if (m.toolChanges.remove.includes(canonical)) changeState = false;
        for (const a of m.toolChanges.add) if (a.name === canonical) changeState = true;
      }
      const offered = declared !== undefined && changeState !== false && (declared.deferLoading !== true || referencedInHistory || changeState === true);
      const userFrames = frames.filter((fr) => fr.type === "data" && (fr as { message: { type: string } }).message.type === "user");
      const results = userFrames.flatMap((fr) => (fr as unknown as { message: { message: { content: Array<{ tool_use_id: string; content: unknown }> } } }).message.message.content);
      const call = results.find((b) => b.tool_use_id === "c1");
      const answered = String(call?.content);
      const fail = (why: string): never => {
        throw new Error(`seed ${seed}: ${why}\n  trace: ${trace.join(" | ")}\n  declared=${JSON.stringify(declared)} offered=${offered} answered=${answered.slice(0, 120)}`);
      };
      if (offered && answered !== "real result") fail("a tool the request offers as callable was refused");
      if (!offered && answered === "real result") fail("a tool the request does not offer ran");
      // The history the next reopen reads: the user turn, this run's attachments, the tool round, the reply.
      history = [
        ...history,
        { role: "user", content: "go" },
        ...attachments.map((a) => attachmentMessage(a as never)!),
        ...(search ? [{ role: "assistant" as const, content: [{ type: "tool_use" as const, id: `s${phase}`, name: select, input: {} }] }, { role: "tool" as const, content: [{ type: "tool_result" as const, tool_use_id: `s${phase}`, content: "{}", loadedTools: [canonical] }] }] : []),
        { role: "assistant", content: "ok" },
      ];
    }
  } finally {
    unregisterMcpServerTools(server);
    unregisterToolForTest(select);
  }
}

describe("loaded set across reopens (generated, seeded)", () => {
  test("a tool a request offers as callable is never refused by the load-first gate; one it does not offer never runs", async () => {
    for (let seed = 1; seed <= 60; seed++) await session(seed);
  });
  test("reproducible", async () => {
    await session(7);
    expect(true).toBe(true);
  });
});
