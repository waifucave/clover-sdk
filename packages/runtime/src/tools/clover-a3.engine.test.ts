// Clover A-M3 in the engine: a host's plain-named in-process tool takes the name of a built-in the session isn't
// offered (`shadowBuiltins`), and a host's own search-and-load tool (`hostToolSearch`, Clover's `Glossary`) keeps
// deferral on with `ToolSearch` left out and loads the tools its result names through `ToolSearch`'s `select:` path.
import { describe, expect, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@waifucave/clover-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { getRegisteredTool } from "./registry.ts";

interface Driven {
  requests: ProviderRequest[];
  frames: WinterFrame[];
  sdkCalls: Array<{ server?: string; tool?: string; arguments?: unknown }>;
  hookPayloads: Array<Record<string, unknown>>;
  permissionPayloads: Array<Record<string, unknown>>;
  error?: unknown;
}

let seq = 0;

async function drive(over: Partial<RuntimeConfig>, script: ProviderTurn[], answer: (call: Driven["sdkCalls"][number]) => Record<string, unknown> = (c) => ({ content: [{ type: "text", text: `${c.tool} ran` }] })): Promise<Driven> {
  const extra: Partial<EngineOptions> = {};
  const requests: ProviderRequest[] = [];
  const frames: WinterFrame[] = [];
  const sdkCalls: Driven["sdkCalls"] = [];
  const hookPayloads: Driven["hookPayloads"] = [];
  const permissionPayloads: Driven["permissionPayloads"] = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: `tool-surface-${++seq}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...over };
  let error: unknown;
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages), ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return script[requests.length - 1] ?? { kind: "text", text: "done" };
      },
    },
    ...extra,
  } as EngineOptions).catch((err: unknown) => {
    error = err;
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const reader = (async () => {
    for await (const f of host.input) {
      frames.push(f);
      if (f.type !== "control_request") continue;
      const cf = f as ControlRequestFrame;
      if (cf.subtype === "sdk_mcp_call") {
        const payload = cf.payload as Driven["sdkCalls"][number];
        sdkCalls.push(payload);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: answer(payload) });
      } else if (cf.subtype === "hook") {
        hookPayloads.push(cf.payload as Record<string, unknown>);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
      } else if (cf.subtype === "permission") {
        permissionPayloads.push(cf.payload as Record<string, unknown>);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { behavior: "allow" } });
      }
    }
  })();
  await done;
  // A run that THREW at startup never ends its output stream (a real host sees the child exit); the
  // frames written before the throw are all there is.
  await (error === undefined ? reader : Promise.race([reader, new Promise((r) => setTimeout(r, 50))]));
  return { requests, frames, sdkCalls, hookPayloads, permissionPayloads, ...(error !== undefined ? { error } : {}) };
}

const names = (req: ProviderRequest | undefined): string[] => (req?.tools ?? []).map((t) => t.name);
const messages = (frames: WinterFrame[]): Array<Record<string, unknown>> =>
  frames.filter((f) => f.type === "data").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
const initTools = (frames: WinterFrame[]): string[] => {
  const init = messages(frames).find((m) => m["type"] === "system" && m["subtype"] === "init") as { tools?: string[] } | undefined;
  return init?.tools ?? [];
};
const toolResult = (frames: WinterFrame[], id: string): Record<string, unknown> | undefined =>
  messages(frames)
    .filter((m) => m["type"] === "user")
    .flatMap((m) => ((m["message"] as { content?: unknown })?.content as Array<Record<string, unknown>> | undefined) ?? [])
    .find((b) => b["type"] === "tool_result" && b["tool_use_id"] === id);
const toolUseNames = (frames: WinterFrame[]): string[] =>
  messages(frames)
    .filter((m) => m["type"] === "assistant")
    .flatMap((m) => ((m["message"] as { content?: unknown })?.content as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((b) => b["type"] === "tool_use")
    .map((b) => String(b["name"]));


const CORE = "clover_core";
function coreServer(tools: string[]): NonNullable<RuntimeConfig["mcpServers"]> {
  return {
    [CORE]: {
      type: "sdk", name: CORE,
      tools: tools.map((name) => ({ name, inputSchema: { type: "object" }, _meta: { "anthropic/alwaysLoad": true } })),
      toolNames: Object.fromEntries(tools.map((t) => [t, t])),
    },
  };
}
const BUILTINS = ["Read", "Glob", "Grep"];

describe("shadowBuiltins in a session", () => {
  test("a host's TaskStop replaces the built-in the session isn't offered; the built-in is back after the run", async () => {
    const before = getRegisteredTool("TaskStop");
    const d = await drive({ mcpServers: coreServer(["TaskStop"]), tools: BUILTINS }, [{ kind: "tool_use", calls: [{ id: "c1", name: "TaskStop", input: { id: "a1" } }] }, { kind: "text", text: "ok" }]);
    expect(d.error).toBeUndefined();
    expect(d.sdkCalls).toEqual([{ server: CORE, tool: "TaskStop", arguments: { id: "a1" } }]);
    expect(String(toolResult(d.frames, "c1")?.["content"])).toContain("TaskStop ran");
    expect(getRegisteredTool("TaskStop")).toBe(before);
  });

  test("a built-in the session IS offered is never shadowed: the session refuses at startup", async () => {
    const d = await drive({ mcpServers: coreServer(["TaskStop"]), tools: [...BUILTINS, "TaskStop"] }, []);
    expect(String(d.error ?? JSON.stringify(messages(d.frames)))).toContain("TaskStop");
    expect(getRegisteredTool("TaskStop")?.descriptor.source).toBe("builtin");
  });
});

describe("hostToolSearch", () => {
  test("deferral stays on with ToolSearch left out; the host tool's _meta loads a deferred built-in", async () => {
    const d = await drive(
      { mcpServers: coreServer(["Glossary"]), tools: BUILTINS, deferTools: ["Glob"], toolSearchEnabled: true, hostToolSearch: "Glossary" },
      [
        { kind: "tool_use", calls: [{ id: "c0", name: "Glob", input: { pattern: "*" } }] },
        { kind: "tool_use", calls: [{ id: "c1", name: "Glossary", input: { load: "Glob" } }] },
        { kind: "text", text: "ok" },
      ],
      (c) => (c.tool === "Glossary" ? { content: [{ type: "text", text: "loading" }], _meta: { "clover/load": ["Glob", "Nope"] } } : { content: [{ type: "text", text: "?" }] }),
    );
    expect(d.error).toBeUndefined();
    expect(names(d.requests[0])).not.toContain("Glob");
    expect(names(d.requests[0])).not.toContain("ToolSearch");
    expect(String(toolResult(d.frames, "c0")?.["content"])).toContain("use Glossary to load it");
    const loaded = String(toolResult(d.frames, "c1")?.["content"]);
    expect(loaded).toContain("loading");
    expect(loaded).toContain("Loaded, callable now: Glob");
    expect(loaded).toContain("Not loaded (unknown, not deferred or not available to you): Nope");
  });

  test("without hostToolSearch, leaving ToolSearch out switches deferral off (claude's rule, unchanged)", async () => {
    const d = await drive({ mcpServers: coreServer(["Glossary"]), tools: BUILTINS, deferTools: ["Glob"], toolSearchEnabled: true }, [{ kind: "text", text: "ok" }]);
    expect(names(d.requests[0])).toContain("Glob");
  });
});
