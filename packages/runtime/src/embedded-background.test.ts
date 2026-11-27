// A coding session that BACKGROUNDS a Bash command keeps running, on every operating system -- the proof the `windows-runtime-start` job runs.
//
// A host (MOSS Code) that counts a session's background commands reads the runtime's `task_started` and `background_tasks_changed` frames. On the
// Windows acceptance run the session's Bash call came back as backgrounded, yet no such frame reached the host (the only system frame kind it
// saw was `init`), and the host logged "unexpected process death: runtime exited without a terminal result". This file drives the same turn
// with no provider, network or secret: the session's own Worker (`spawnEmbeddedWorker`), the `winter-test/calls` double scripting
// `Bash` with `run_in_background`, a temp home. It asserts what a host relies on: the `task_started` and `background_tasks_changed` frames
// arrive, in that order, BEFORE the tool's result; the turn ends with a success result; and the Worker exits with code 0 (it did not die when
// the command was backgrounded). A foreground Bash call in the same session runs first as the control: if only the backgrounded one fails, the
// background spawn is at fault.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SdkMessage } from "@waifucave/clover-agent-sdk";
import { spawnEmbeddedWorker } from "./embedded-host.ts";

const WORKER_ENTRY = process.env["START_PROOF_DIST"] === "1" ? join(import.meta.dir, "..", "dist", "embedded-worker.js") : join(import.meta.dir, "embedded-worker.ts");
const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `winter-bg-${label}-`));
  ROOTS.push(dir);
  return dir;
}

async function run(script: string): Promise<{ messages: SdkMessage[]; exit: { code: number | null; signal: string | null } | undefined; stderr: string }> {
  const home = tempDir("home");
  const cwd = tempDir("cwd");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["WINTER_HOME"] = home;
  env["WINTER_DISABLE_GIT_INSTRUCTIONS"] = "1";
  if (process.platform !== "win32") env["WINTER_TMPDIR"] = tempDir("tmp");
  let exit: Promise<{ code: number | null; signal: string | null }> | undefined;
  let stderr = "";
  const messages: SdkMessage[] = [];
  try {
    for await (const m of query({
      prompt: script,
      options: {
        model: "winter-test/calls",
        cwd,
        env,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (o) => {
          const proc = spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: o });
          exit = proc.exited;
          void (async () => {
            for await (const chunk of proc.stderr!) stderr += chunk;
          })();
          return proc;
        },
      },
    })) messages.push(m);
  } catch (error) {
    await Promise.race([exit, Bun.sleep(2000)]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- the session's stderr ---\n${stderr}\n--- messages so far: ${messages.map((m) => `${(m as { type?: string }).type}/${(m as { subtype?: string }).subtype ?? ""}`).join(", ")}`);
  }
  return { messages, exit: await Promise.race([exit, Bun.sleep(10_000).then(() => undefined)]), stderr };
}

const kind = (m: SdkMessage): string => `${(m as { type?: string }).type}/${(m as { subtype?: string }).subtype ?? ""}`;
// `sleep` is a command every shell the runtime uses on every OS knows (Git Bash on Windows included).
const SLEEP_BACKGROUND = JSON.stringify({ command: "sleep 3", run_in_background: true, description: "the background proof" });
const FOREGROUND = JSON.stringify({ command: "echo foreground-ok", description: "the control" });

describe("a session that backgrounds a Bash command", () => {
  test("control: a foreground Bash call in the same kind of session returns and the Worker exits 0", async () => {
    const { messages, exit, stderr } = await run(`CALL Bash ${FOREGROUND}`);
    const result = messages.find((m) => (m as { type?: string }).type === "result") as { subtype?: string; result?: string } | undefined;
    expect(result?.subtype, `stderr: ${stderr}\nkinds: ${messages.map(kind).join(", ")}`).toBe("success");
    expect(result?.result).toContain("foreground-ok");
    expect(exit, `stderr: ${stderr}`).toEqual({ code: 0, signal: null });
  }, 90_000);

  test("a backgrounded command: task_started and background_tasks_changed reach the host before the tool result, the turn succeeds and the Worker exits 0", async () => {
    const { messages, exit, stderr } = await run(`CALL Bash ${SLEEP_BACKGROUND}`);
    const kinds = messages.map(kind);
    const context = `stderr: ${stderr}\nkinds: ${kinds.join(", ")}`;
    const started = kinds.indexOf("system/task_started");
    const changed = kinds.indexOf("system/background_tasks_changed");
    expect(started, context).toBeGreaterThanOrEqual(0);
    expect(changed, context).toBeGreaterThan(started);
    const started0 = messages[started] as { task_type?: string; is_backgrounded?: boolean };
    expect(started0.task_type).toBe("local_bash");
    expect(started0.is_backgrounded).toBe(true);
    // The tool's result (a user message carrying a tool_result) comes after both frames.
    const resultAt = messages.findIndex((m) => (m as { type?: string }).type === "user" && JSON.stringify(m).includes("tool_result"));
    expect(resultAt, context).toBeGreaterThan(changed);
    const result = messages.find((m) => (m as { type?: string }).type === "result") as { subtype?: string } | undefined;
    expect(result?.subtype, context).toBe("success");
    expect(exit, context).toEqual({ code: 0, signal: null });
  }, 90_000);
});
