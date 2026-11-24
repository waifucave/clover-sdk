// The runtime decorates its OWN built-in tools per session (the Agent tool's `model` enum from the active slot set
// and its gate-aware schema, the web tools' lean/full description and schema, the Bash sandbox section, the native
// `tool_search` marker on ToolSearch). A host tool that takes one of those names (`toolNames` + `shadowBuiltins`)
// replaces the built-in: the model must be offered the HOST's definition exactly as the host wrote it, never the
// runtime's decoration on top of it.
import { describe, expect, test } from "bun:test";
import type { ActiveSlotSet, RuntimeConfig } from "@waifucave/clover-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions, type ProviderRequest } from "../engine.ts";
import type { McpToolDefinition } from "./registry.ts";

const GPT_SET: ActiveSlotSet = {
  family: "gpt",
  source: "family-default",
  slots: ["astra", "sol", "terra", "luna"].map((name) => ({ name, canonicalModelId: `gpt-${name}`, description: `what ${name} is for`, reason: `why ${name} is here` })),
};

let seq = 0;

async function firstRequestTools(over: Partial<RuntimeConfig>, engine: Partial<EngineOptions> = {}): Promise<NonNullable<ProviderRequest["tools"]>> {
  const requests: ProviderRequest[] = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: `host-tool-schema-${++seq}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...over };
  let error: unknown;
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return { kind: "text", text: "ok" };
      },
    },
    activeSlotSet: () => GPT_SET,
    ...engine,
  } as EngineOptions).catch((err: unknown) => {
    error = err;
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const reader = (async () => {
    for await (const _ of host.input) {
      // drained
    }
  })();
  await done;
  await (error === undefined ? reader : Promise.race([reader, new Promise((r) => setTimeout(r, 50))]));
  expect(error).toBeUndefined();
  return requests[0]?.tools ?? [];
}

const CORE = "clover_core_schema_test";
function hostServer(tools: McpToolDefinition[]): NonNullable<RuntimeConfig["mcpServers"]> {
  return {
    [CORE]: {
      type: "sdk",
      name: CORE,
      tools: tools.map((t) => ({ ...t, _meta: { "anthropic/alwaysLoad": true } })),
      toolNames: Object.fromEntries(tools.map((t) => [t.name, t.name])),
    },
  };
}
const BUILTINS = ["Read", "Glob", "Grep"];

const HOST_AGENT: McpToolDefinition = {
  name: "Agent",
  description: "The host's own Agent tool: start a coding agent on any model the host knows.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the agent should do." },
      model: { type: "string", description: "Any model id, e.g. terra." },
    },
    required: ["prompt"],
  },
};

function specNamed(tools: NonNullable<ProviderRequest["tools"]>, name: string) {
  const spec = tools.find((t) => t.name === name);
  expect(spec).toBeDefined();
  return spec!;
}

function expectHostBytes(tools: NonNullable<ProviderRequest["tools"]>, def: McpToolDefinition): void {
  const spec = specNamed(tools, def.name);
  expect(JSON.stringify(spec.inputSchema)).toBe(JSON.stringify(def.inputSchema));
  expect(spec.description).toBe(def.description!);
  expect(spec.toolSearch).toBeUndefined();
}

describe("a host tool with a built-in's name is offered exactly as the host defined it", () => {
  test("a host Agent with a free-string model gets no slot enum and no slot lines", async () => {
    const tools = await firstRequestTools({ mcpServers: hostServer([HOST_AGENT]), tools: BUILTINS });
    expectHostBytes(tools, HOST_AGENT);
    const model = (specNamed(tools, "Agent").inputSchema as { properties: { model: { enum?: unknown } } }).properties.model;
    expect(model.enum).toBeUndefined();
  });

  test("a host Agent is untouched on the gated path too (fork gate on), which would replace the whole schema", async () => {
    const tools = await firstRequestTools({ mcpServers: hostServer([HOST_AGENT]), tools: BUILTINS, forkSubagent: true } as Partial<RuntimeConfig>);
    expectHostBytes(tools, HOST_AGENT);
  });

  test("a host Bash, WebFetch and WebSearch keep their own description and schema", async () => {
    const defs: McpToolDefinition[] = ["Bash", "WebFetch", "WebSearch"].map((name) => ({
      name,
      description: `The host's own ${name}.`,
      inputSchema: { type: "object", properties: { thing: { type: "string", description: `host ${name} field` } }, required: ["thing"] },
    }));
    const tools = await firstRequestTools({ mcpServers: hostServer(defs), tools: BUILTINS });
    for (const def of defs) expectHostBytes(tools, def);
  });
});

describe("the built-in Agent is still decorated", () => {
  test("no host replacement: the model enum is the active slot set and the slot lines are in the description", async () => {
    const tools = await firstRequestTools({ tools: [...BUILTINS, "Agent"] });
    const agent = specNamed(tools, "Agent");
    expect((agent.inputSchema as { properties: { model: { enum: string[] } } }).properties.model.enum).toEqual(["astra", "sol", "terra", "luna"]);
    expect(agent.description).toContain("astra — gpt-astra:");
    expect(agent.description).not.toContain("{{MODEL_SLOTS}}");
  });
});
