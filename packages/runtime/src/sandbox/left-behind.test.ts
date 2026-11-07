// What a command leaves running when it ends (Clover's F8): the run ends, and what it left is handed to its caller
// (`RunCommandResult.leftBehind`) to adopt as a background task, never killed with the call. With the host's process
// holder (macOS, `native/process-holder.c`) everything the command started is found, setsid'd and double-forked
// processes and ones that cleared their environment included, and one stop ends them all. Without it, the command's
// process group stands for what it left (`(cmd) &`, `nohup … &`); a setsid'd process is out of reach there.
//
// A process the command has launchd start (`launchctl submit`, `open -a`, an XPC service) is launchd's child, not the
// command's, so nothing is responsible to the holder for it. The opt-in `sandbox.denyLaunchServices` closes those paths
// (running launchctl, open and osascript, and the LaunchServices, AppleEvents and job-submission services); Clover turns
// it on for every bot and agent session. Tested below.
//
// THE RESIDUAL, accepted and documented rather than tested: a native program speaking launchd's private protocol over
// the bootstrap port, which is how launchctl itself talks to launchd. That connection has no service name for Seatbelt
// to deny, and it needs deliberately built native code.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandLocally, type LeftBehind } from "./spawn.ts";
import { buildSeatbeltProfile, LAUNCH_SERVICES_DENIES } from "./profile.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "left-behind-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The holder, built from its source here (the host builds and signs its own). */
let holder: string | undefined;
beforeAll(() => {
  if (process.platform !== "darwin") return;
  const out = join(dir, "process-holder");
  const built = spawnSync("/usr/bin/clang", ["-O2", "-o", out, join(import.meta.dir, "../../native/process-holder.c")], { encoding: "utf8" });
  if (built.status === 0) holder = out;
  else console.warn(`process-holder did not build: ${built.stderr}`);
});

// Short enough for `sleep` (it refuses ten digits), unique enough for one run.
const tag = () => `${(Date.now() % 10000) * 10 + Math.floor(Math.random() * 10)}`;
/** A sleep that can be found by its own argument. */
const alive = (seconds: string) => spawnSync("/usr/bin/pgrep", ["-f", `^sleep ${seconds}$`]).status === 0;
const waitFor = async (ok: () => boolean, ms = 8_000) => {
  for (let t = 0; t < ms / 100 && !ok(); t++) await Bun.sleep(100);
  return ok();
};

async function run(command: string, processHolder?: string) {
  const started = Date.now();
  const result = await runCommandLocally({ command, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" }, timeoutMs: 30_000, settings: { enabled: false }, ...(processHolder !== undefined ? { processHolder } : {}) });
  return { result, took: Date.now() - started };
}

/** P10's two forms, setsid, and a double fork that clears its environment; each sleeps on its own number. */
function leaveFour(n: string[]): string {
  const py = existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "/usr/bin/python3";
  const script = join(dir, `leave-${n[0]}.sh`);
  writeFileSync(script, [
    `(sleep ${n[0]} &)`,
    `nohup sleep ${n[1]} >/dev/null 2>&1 &`,
    `${py} -c 'import os,subprocess; os.setsid(); subprocess.Popen(["sleep","${n[2]}"]); os._exit(0)' &`,
    `${py} -c 'import os
if os.fork()==0:
    os.setsid(); os.environ.clear(); os.execv("/bin/sleep",["sleep","${n[3]}"])
os._exit(0)' &`,
    "sleep 0.5",
    "echo done",
  ].join("\n"));
  return `/bin/bash ${JSON.stringify(script)} >/dev/null 2>&1; echo ran`;
}

describe.if(process.platform === "darwin")("with the process holder (macOS)", () => {
  test("P10's two forms, setsid and a cleared-environment double fork: all found when the command ends, all stopped by one stop", async () => {
    expect(holder).toBeDefined();
    const n = [1, 2, 3, 4].map((i) => `3${tag()}${i}`);
    const { result, took } = await run(leaveFour(n), holder);
    expect(result.exitCode).toBe(0);
    expect(took).toBeLessThan(10_000);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    for (const s of n) expect(await waitFor(() => alive(s))).toBe(true);
    let ended = false;
    void left.done.then(() => { ended = true; });
    left.stop();
    expect(await waitFor(() => n.every((s) => !alive(s)))).toBe(true);
    expect(await waitFor(() => ended)).toBe(true);
  }, 30_000);

  test("a nohup server survives the call and stays up until stopped; what it writes later reaches the adopter", async () => {
    const n = `3${tag()}5`;
    const { result } = await run(`nohup /bin/sh -c 'sleep 1; echo serving; exec sleep ${n}' &\necho started`, holder);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    const seen: string[] = [];
    left.onOutput((c) => seen.push(c.toString("utf8")));
    await Bun.sleep(2_500);
    expect(alive(n)).toBe(true);
    expect(seen.join("")).toContain("serving");
    left.stop();
    expect(await waitFor(() => !alive(n))).toBe(true);
  }, 30_000);

  test("a command that leaves nothing ends as before, with nothing to adopt", async () => {
    const { result, took } = await run("echo hi; sleep 0.2", holder);
    expect(result.exitCode).toBe(0);
    expect(result.leftBehind).toBeUndefined();
    expect(took).toBeLessThan(5_000);
  });

  test("under the Seatbelt sandbox too", async () => {
    const n = `3${tag()}6`;
    const result = await runCommandLocally({ command: `python3 -c 'import os,subprocess; os.setsid(); subprocess.Popen(["sleep","${n}"]); os._exit(0)' & sleep 0.5`, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" }, timeoutMs: 30_000, settings: { enabled: true }, processHolder: holder! });
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    expect(await waitFor(() => alive(n))).toBe(true);
    left.stop();
    expect(await waitFor(() => !alive(n))).toBe(true);
  }, 30_000);

  test("a timeout stops everything the command started, setsid'd ones included", async () => {
    const n = `3${tag()}7`;
    const result = await runCommandLocally({ command: `python3 -c 'import os,subprocess; os.setsid(); subprocess.Popen(["sleep","${n}"]); os._exit(0)' & sleep 30`, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" }, timeoutMs: 1_500, settings: { enabled: false }, processHolder: holder! });
    expect(result.timedOut).toBe(true);
    expect(result.leftBehind).toBeUndefined();
    expect(await waitFor(() => !alive(n))).toBe(true);
  }, 30_000);
});

describe("without a holder: the process group stands for what a command left", () => {
  test("`(cmd) &` and `nohup … &` are found and stopped; a setsid'd process is out of the group's reach", async () => {
    const n = [1, 2].map((i) => `4${tag()}${i}`);
    const { result, took } = await run(`(sleep ${n[0]} &) >/dev/null 2>&1\nnohup sleep ${n[1]} >/dev/null 2>&1 &\necho ran`);
    expect(took).toBeLessThan(10_000);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    for (const s of n) expect(await waitFor(() => alive(s))).toBe(true);
    // Their output went elsewhere, so the pipes closed at once; they are still running, and not done.
    let ended = false;
    void left.done.then(() => { ended = true; });
    await Bun.sleep(1_500);
    expect(ended).toBe(false);
    left.stop();
    expect(await waitFor(() => n.every((s) => !alive(s)))).toBe(true);
    expect(await waitFor(() => ended)).toBe(true);
  }, 30_000);
});

describe("sandbox.denyLaunchServices", () => {
  test("off by default: the profile is unchanged; on: the three execs and the services are denied, last", () => {
    const base = buildSeatbeltProfile({ cwd: dir, allowNetwork: false });
    expect(base).not.toContain("/bin/launchctl");
    const closed = buildSeatbeltProfile({ cwd: dir, allowNetwork: false, denyLaunchServices: true });
    expect(closed.startsWith(base.trimEnd())).toBe(true);
    for (const p of LAUNCH_SERVICES_DENIES.exec) expect(closed).toContain(`(literal "${p}")`);
    for (const n of LAUNCH_SERVICES_DENIES.services) expect(closed).toContain(`(global-name "${n}")`);
  });

  test.if(process.platform === "darwin")("on: launchctl, open and osascript are refused; git and python run as before", async () => {
    const sandboxed = (command: string) => runCommandLocally({ command, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: dir }, timeoutMs: 30_000, settings: { enabled: true, denyLaunchServices: true } });
    for (const refused of ["/bin/launchctl list", "/usr/bin/open -g /tmp", "/usr/bin/osascript -e 'return 1'"]) expect(`${refused}: ${(await sandboxed(refused)).exitCode}`).not.toBe(`${refused}: 0`);
    expect((await sandboxed("git --version")).exitCode).toBe(0);
    expect((await sandboxed("python3 -c 'import json; print(1)'")).exitCode).toBe(0);
  }, 60_000);
});
