// The mode baseline's silent allows vouch for what the RUNTIME's own built-in does when it runs: a read-only
// looking Bash command, a Read/Glob/Grep inside the working directory, an acceptEdits/auto edit inside it, the
// sandboxed-Bash auto-allow, the task/mode-class tools, a preapproved WebFetch host. A host or MCP tool that took
// one of those names (`mcpServer` set on the call) is run by the host, so it gets none of them: it reaches the
// host's canUseTool like any other host tool. The built-in keeps every allow it had.
import { describe, expect, test } from "bun:test";
import type { McpServerIdentity, PermissionMode } from "@waifucave/clover-agent-sdk";
import { evaluate, NO_OPINION_HOOK_STAGE, REAL_SPECIAL_CHECKS, type AutoEngine, type EvaluationContext, type PermissionCall } from "./evaluator.ts";
import { emptyRuleSet } from "./ruleset.ts";

const CWD = "/work/repo";
const HOST: McpServerIdentity = { name: "clover_core", configName: "clover_core" };

function harness(mode: PermissionMode, opts: { sandboxed?: boolean } = {}): { ctx: EvaluationContext; prompts: PermissionCall[]; classified: PermissionCall[] } {
  const prompts: PermissionCall[] = [];
  const classified: PermissionCall[] = [];
  const ctx: EvaluationContext = {
    policy: { mode, version: 0, rules: emptyRuleSet() },
    cwd: CWD,
    sessionRoot: CWD,
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    sessionBypassEnabled: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(c) {
        prompts.push(c);
        return { decision: "allow" };
      },
    },
    autoEngine: {
      async classify(c: PermissionCall) {
        classified.push(c);
        return { verdict: "ask", fallbackToPrompt: true };
      },
    } as unknown as AutoEngine,
    specialChecks: REAL_SPECIAL_CHECKS,
    ...(opts.sandboxed === true ? { bashRunsSandboxed: (c: PermissionCall) => c.toolName === "Bash" } : {}),
  };
  return { ctx, prompts, classified };
}

const CASES: Array<{ what: string; mode: PermissionMode; call: Omit<PermissionCall, "toolUseId">; sandboxed?: boolean }> = [
  { what: "a read-only Bash command", mode: "default", call: { toolName: "Bash", input: { command: "ls -la" } } },
  { what: "a Read inside the working directory", mode: "default", call: { toolName: "Read", input: { file_path: `${CWD}/README.md` } } },
  { what: "a Glob inside the working directory", mode: "default", call: { toolName: "Glob", input: { pattern: "*.ts" } } },
  { what: "a Grep inside the working directory", mode: "default", call: { toolName: "Grep", input: { pattern: "x", path: CWD } } },
  { what: "a task-class tool", mode: "default", call: { toolName: "TodoWrite", input: { todos: [] } } },
  { what: "an acceptEdits edit inside the working directory", mode: "acceptEdits", call: { toolName: "Edit", input: { file_path: `${CWD}/a.ts`, old_string: "a", new_string: "b" } } },
  { what: "an acceptEdits Bash mkdir inside the working directory", mode: "acceptEdits", call: { toolName: "Bash", input: { command: "mkdir build" } } },
  { what: "a sandboxed Bash under autoAllowBashIfSandboxed", mode: "default", call: { toolName: "Bash", input: { command: "make" } }, sandboxed: true },
  { what: "a WebFetch of a preapproved host", mode: "default", call: { toolName: "WebFetch", input: { url: "https://modelcontextprotocol.io/docs", prompt: "x" } } },
];

describe("the built-in keeps its silent allow", () => {
  for (const c of CASES) {
    test(`${c.what} (${c.mode})`, async () => {
      const h = harness(c.mode, { sandboxed: c.sandboxed === true });
      const record = await evaluate({ ...c.call, toolUseId: "t1" }, h.ctx);
      expect(record.decision).toBe("allow");
      expect(h.prompts).toHaveLength(0);
    });
  }
});

describe("a host tool with the same name gets none of them: the host is asked", () => {
  for (const c of CASES) {
    test(`${c.what} (${c.mode})`, async () => {
      const h = harness(c.mode, { sandboxed: c.sandboxed === true });
      const record = await evaluate({ ...c.call, toolUseId: "t1", mcpServer: HOST }, h.ctx);
      expect(h.prompts).toHaveLength(1);
      expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
    });
  }

  test("auto mode: a host Read inside the working directory goes to the classifier, not the silent allow", async () => {
    const builtin = harness("auto");
    await evaluate({ toolName: "Read", input: { file_path: `${CWD}/README.md` }, toolUseId: "t1" }, builtin.ctx);
    expect(builtin.classified).toHaveLength(0);
    const host = harness("auto");
    await evaluate({ toolName: "Read", input: { file_path: `${CWD}/README.md` }, toolUseId: "t1", mcpServer: HOST }, host.ctx);
    expect(host.classified.length + host.prompts.length).toBeGreaterThan(0);
  });
});
