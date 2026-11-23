// The runtime STARTS and answers a plain turn, on every operating system -- the proof the `windows` CI job runs.
//
// Release 0.0.83 died before it started on Windows: the temp folder default was the literal "/tmp" (the current
// drive's `\tmp`, which does not exist) and four owner checks called `process.getuid()`, which Windows does not have.
// A session ended with "runtime exited before init". This file runs the smallest real turn the repository's own
// harness can run with no provider, network or secret: the session's own Worker (`spawnEmbeddedWorker`, the topology
// a desktop host embeds), the reserved `winter-test/echo` double, a temp home, one user message, one result.
//
// It runs in the normal `bun test` on Linux and macOS too, where it must stay green. Its two cases hold the whole
// start path: the session temp chain (`paths/temp.ts`), the transcript store (the sdk's `session-store.ts`), the
// permission journal and the approval and auto-counter stores (each `ensureSecureDir`).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINTER_BRAND, query, type SdkMessage } from "@waifucave/clover-agent-sdk";
import { spawnEmbeddedWorker } from "./embedded-host.ts";

// START_PROOF_DIST=1 (the `windows` CI job's second leg) runs the BUILT Worker entry, the shape a published package has,
// instead of the source one: a bundle can start differently from its sources.
const WORKER_ENTRY = process.env["START_PROOF_DIST"] === "1" ? join(import.meta.dir, "..", "dist", "embedded-worker.js") : join(import.meta.dir, "embedded-worker.ts");
const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `winter-start-${label}-`));
  ROOTS.push(dir);
  return dir;
}

/**
 * The environment a host hands the session: the host's own (a Windows session needs SystemRoot and the temp
 * variables to find anything), a temp home, no git snapshot. The temp base override is removed where the default must
 * be the thing under test (Windows), and pointed at a throwaway folder elsewhere so nothing lands in the real `/tmp`.
 */
function sessionEnv(home: string, tmpBase: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["WINTER_HOME"] = home;
  env["WINTER_DISABLE_GIT_INSTRUCTIONS"] = "1";
  if (process.platform === "win32") delete env["WINTER_TMPDIR"];
  else env["WINTER_TMPDIR"] = tmpBase;
  return env;
}

async function drain(gen: AsyncIterable<SdkMessage>): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

function jsonlFiles(dir: string): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonlFiles(path));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

describe("the runtime starts and answers one plain turn", () => {
  test("a session in its own Worker: init, the echo double's answer, a success result, the temp chain and the transcript on disk", async () => {
    const home = tempDir("home");
    const tmpBase = tempDir("tmp");
    const cwd = tempDir("cwd");
    // Where the session's temp chain must appear: the throwaway base, or on Windows the operating system's temp folder.
    const chainBase = process.platform === "win32" ? tmpdir() : tmpBase;
    const chainBefore = new Set(readdirSync(chainBase));
    let exit: Promise<{ code: number | null; signal: string | null }> | undefined;
    let stderrText = "";
    let messages: SdkMessage[];
    try {
      messages = await drain(
        query({
          prompt: "hello from the start proof",
          options: {
            model: "winter-test/echo",
            cwd,
            env: sessionEnv(home, tmpBase),
            sandbox: { enabled: false },
            spawnClaudeCodeProcess: (o) => {
              const proc = spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: o });
              exit = proc.exited;
              void (async () => {
                for await (const chunk of proc.stderr!) stderrText += chunk;
              })();
              return proc;
            },
          },
        }),
      );
    } catch (error) {
      // A session that dies before init says why on its stderr; the bare "runtime exited before init" does not.
      await Promise.race([exit, Bun.sleep(2000)]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- the session's stderr ---\n${stderrText}`);
    }
    const init = messages.find((m) => (m as { subtype?: string }).subtype === "init");
    expect(init, `no init message; the session's stderr: ${stderrText}`).toBeDefined();
    const result = messages.find((m) => (m as { type?: string }).type === "result") as { subtype?: string; result?: string } | undefined;
    expect(result?.subtype, `the session's stderr: ${stderrText}`).toBe("success");
    // The echo double answers `echo: <the last user message>`; the session wraps the prompt in its own context blocks.
    expect(result?.result?.startsWith("echo: ")).toBe(true);
    expect(result?.result).toContain("hello from the start proof");
    expect(await exit).toEqual({ code: 0, signal: null });
    // The session temp chain (`<root>-<user>`) was made under that base, by the default there when none was set.
    const roots = readdirSync(chainBase).filter((n) => n.startsWith(`${WINTER_BRAND.tempRootName}-`));
    if (process.platform === "win32") for (const name of roots) if (!chainBefore.has(name)) ROOTS.push(join(chainBase, name)); // only what this run made
    expect(roots.length).toBeGreaterThan(0);
    // The transcript was written under the home (the sdk's session store walked and validated its levels).
    expect(jsonlFiles(join(home, "projects")).length).toBeGreaterThan(0);
  }, 90_000);
});
