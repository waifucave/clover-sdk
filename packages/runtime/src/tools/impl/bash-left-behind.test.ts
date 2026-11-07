// The Bash tool adopts what a command leaves running (Clover's F8): a background task of the session, announced as one
// (`task_started`, `is_backgrounded: true`), which TaskStop, a host's `stopTask` and the session's teardown stop like
// any background command, and which ends by itself once the last process it stands for does. With the host's process
// holder (`<PREFIX>PROCESS_HOLDER`, macOS) that includes setsid'd and double-forked processes.
//
// The residual a holder can't see (a process the command has launchd start) is documented in
// `sandbox/left-behind.test.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINTER_BRAND, envName, type BackgroundTaskMessage } from "@waifucave/clover-agent-sdk";
import "./bash.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "../background-tasks.ts";
import { getTask, resetBackgroundTaskRuntimeForTest, stopSessionShellTasks } from "./background-task-runtime.ts";
import { taskStopExecutor } from "./task-stop.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "bash-left-behind-")));
const HOLDER_ENV = envName(WINTER_BRAND, "PROCESS_HOLDER");
let holder: string | undefined;
beforeAll(() => {
  if (process.platform !== "darwin") return;
  const out = join(dir, "process-holder");
  if (spawnSync("/usr/bin/clang", ["-O2", "-o", out, join(import.meta.dir, "../../../native/process-holder.c")]).status === 0) holder = out;
});
afterAll(() => {
  delete process.env[HOLDER_ENV];
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetBackgroundTaskRootForTest();
  resetBackgroundTaskRuntimeForTest();
  const root = mkdtempSync(join(dir, "tasks-"));
  configureBackgroundTaskRoot(() => ({ root, scratchpad: join(root, "scratchpad"), tasks: join(root, "tasks") }));
});
afterEach(() => {
  resetBackgroundTaskRootForTest();
  resetBackgroundTaskRuntimeForTest();
  delete process.env[HOLDER_ENV];
});

function ctxWith(frames: BackgroundTaskMessage[], sessionId = "s-left"): ToolExecutionContext {
  const cwd = realpathSync(mkdtempSync(join(dir, "cwd-")));
  return {
    cwd, home: dir, sessionId, brand: WINTER_BRAND,
    readState: createSessionReadState({ cwd }),
    emitFrame: (f) => frames.push(f),
    permissions: { probeReadAccess: () => "silent" },
    tempDir: realpathSync(mkdtempSync(join(dir, "tmp-"))),
    sandboxSettings: { enabled: false },
    session: {
      setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {},
      getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => cwd, setSessionRoot() {},
    },
  } as ToolExecutionContext;
}

const bash = (input: unknown, ctx: ToolExecutionContext) => getRegisteredTool("Bash")!.executor!.execute(input, ctx);
const tag = () => `${(Date.now() % 10000) * 10 + Math.floor(Math.random() * 10)}`;
const alive = (n: string) => spawnSync("/usr/bin/pgrep", ["-f", `^sleep ${n}$`]).status === 0;
const waitFor = async (ok: () => boolean, ms = 8_000) => {
  for (let i = 0; i < ms / 100 && !ok(); i++) await Bun.sleep(100);
  return ok();
};
const adoptedId = (output: string) => /They are background task (\S+?)[ ;]/.exec(output)?.[1];

describe.if(process.platform === "darwin")("Bash adopts what a command leaves running", () => {
  test("P10's two forms and setsid, under the holder: one adopted background task, stopped by TaskStop", async () => {
    expect(holder).toBeDefined();
    process.env[HOLDER_ENV] = holder!;
    const n = [1, 2, 3].map((i) => `5${tag()}${i}`);
    const frames: BackgroundTaskMessage[] = [];
    const ctx = ctxWith(frames);
    const res = await bash({
      command: `(sleep ${n[0]} &) >/dev/null 2>&1; nohup sleep ${n[1]} >/dev/null 2>&1 & python3 -c 'import os,subprocess; os.setsid(); subprocess.Popen(["sleep","${n[2]}"]); os._exit(0)' & sleep 0.5; echo ok`,
      description: "leave three",
    }, ctx);
    expect(res.output).toContain("ok");
    const id = adoptedId(res.output)!;
    expect(id).toBeDefined();
    expect(frames.some((f) => f.subtype === "task_started" && (f as { task_id?: string }).task_id === id && (f as { is_backgrounded?: boolean }).is_backgrounded === true)).toBe(true);
    expect(getTask(id)).toMatchObject({ kind: "bash", isBackgrounded: true, adopted: true, status: "running", description: "Left running by: leave three" });
    for (const s of n) expect(await waitFor(() => alive(s))).toBe(true);
    await taskStopExecutor.execute({ task_id: id }, ctx);
    expect(await waitFor(() => n.every((s) => !alive(s)))).toBe(true);
    expect(getTask(id)?.status).toBe("stopped");
  }, 30_000);

  test("a nohup server stays up after the call; it ends as completed when it exits by itself", async () => {
    process.env[HOLDER_ENV] = holder!;
    const frames: BackgroundTaskMessage[] = [];
    const ctx = ctxWith(frames);
    const res = await bash({ command: "nohup sleep 2 >/dev/null 2>&1 & echo started", description: "short server" }, ctx);
    const id = adoptedId(res.output)!;
    expect(getTask(id)?.status).toBe("running");
    expect(await waitFor(() => getTask(id)?.status === "completed", 10_000)).toBe(true);
    expect(frames.some((f) => f.subtype === "task_notification" && (f as { task_id?: string }).task_id === id && (f as { status?: string }).status === "completed")).toBe(true);
  }, 30_000);

  test("the session's teardown stops what its commands left (no holder: the process group)", async () => {
    const n = `6${tag()}1`;
    const frames: BackgroundTaskMessage[] = [];
    const ctx = ctxWith(frames, "s-teardown");
    const res = await bash({ command: `nohup sleep ${n} >/dev/null 2>&1 & echo ok`, description: "leave one" }, ctx);
    const id = adoptedId(res.output)!;
    expect(await waitFor(() => alive(n))).toBe(true);
    expect(stopSessionShellTasks({ sessionId: "s-teardown" })).toEqual([id]);
    expect(await waitFor(() => !alive(n))).toBe(true);
  }, 30_000);

  test("a command that leaves nothing adopts nothing", async () => {
    process.env[HOLDER_ENV] = holder!;
    const frames: BackgroundTaskMessage[] = [];
    const res = await bash({ command: "echo plain", description: "plain" }, ctxWith(frames));
    expect(res.output).not.toContain("still running");
    expect(frames.some((f) => f.subtype === "task_started")).toBe(false);
  }, 30_000);
});
