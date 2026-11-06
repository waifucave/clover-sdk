// Clover A-M3: a host's plain-named in-process tool may take the name of a built-in the session isn't offered
// (`shadowBuiltins`), which is set aside while the host's tool holds the name and comes back when it lets go. Any
// other collision with a built-in is still refused.
import { describe, expect, test } from "bun:test";
import "./descriptors/index.ts";
import { getRegisteredTool, isBuiltinShadowed, registerMcpServerTools, unregisterMcpServerTools } from "./registry.ts";

const SRV = "clover_core_shadow_test";

describe("shadowBuiltins", () => {
  test("a plain name takes a built-in's name the session isn't offered, and gives it back", () => {
    const before = getRegisteredTool("TaskStop");
    expect(before?.descriptor.source).toBe("builtin");
    try {
      registerMcpServerTools(SRV, [{ name: "TaskStop", inputSchema: { type: "object" } }], { deferredDefault: false, toolNames: { TaskStop: "TaskStop" }, shadowBuiltins: ["TaskStop"] });
      const now = getRegisteredTool("TaskStop");
      expect(now?.descriptor.source).toBe("mcp");
      expect(isBuiltinShadowed("TaskStop")).toBe(true);
    } finally {
      unregisterMcpServerTools(SRV);
    }
    expect(isBuiltinShadowed("TaskStop")).toBe(false);
    expect(getRegisteredTool("TaskStop")).toBe(before);
  });

  test("a re-registration that drops the name gives the built-in back too", () => {
    const before = getRegisteredTool("TaskStop");
    try {
      registerMcpServerTools(SRV, [{ name: "TaskStop", inputSchema: { type: "object" } }], { deferredDefault: false, toolNames: { TaskStop: "TaskStop" }, shadowBuiltins: ["TaskStop"] });
      registerMcpServerTools(SRV, [{ name: "other", inputSchema: { type: "object" } }], { deferredDefault: false });
      expect(getRegisteredTool("TaskStop")).toBe(before);
      expect(isBuiltinShadowed("TaskStop")).toBe(false);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("without the session's leave, or under another name, a built-in's name is still refused", () => {
    expect(() => registerMcpServerTools(SRV, [{ name: "TaskStop", inputSchema: { type: "object" } }], { deferredDefault: false, toolNames: { TaskStop: "TaskStop" } })).toThrow(/already registered by a non-live-MCP mechanism/);
    expect(() => registerMcpServerTools(SRV, [{ name: "stop", inputSchema: { type: "object" } }], { deferredDefault: false, toolNames: { stop: "TaskStop" }, shadowBuiltins: ["Read"] })).toThrow(/already registered by a non-live-MCP mechanism/);
    expect(getRegisteredTool("TaskStop")?.descriptor.source).toBe("builtin");
  });
});
