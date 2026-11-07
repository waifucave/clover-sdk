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
// THE RESIDUALS, accepted:
//   * A process that disclaims its own responsibility: `posix_spawn` with `responsibility_spawnattrs_setdisclaim(1)`
//     and POSIX_SPAWN_SETSID, a few lines of Python ctypes or bun:ffi (no native build needed). It is its own
//     responsible process, so the holder can't find or stop it. It stays inside the command's Seatbelt sandbox (the
//     sandbox is inherited through the spawn; tested below) and its fence. When it still holds the command's output,
//     the holder sees it and `leftBehind.escaped` says so (tested below); one that also let go of the output is unseen.
//   * A program speaking launchd's private protocol over the bootstrap port, which is how launchctl itself talks to
//     launchd. That connection has no service name for Seatbelt to deny, and the calls are exported by libSystem, so
//     Python ctypes or bun:ffi reach them as well. Documented, not tested.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUP_STOP_GRACE_MS, HOLDER_STOP_GRACE_MS, runCommandLocally, type LeftBehind } from "./spawn.ts";
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

async function run(command: string, processHolder?: string, env: Record<string, string> = {}) {
  const started = Date.now();
  const result = await runCommandLocally({ command, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", ...env }, timeoutMs: 30_000, settings: { enabled: false }, ...(processHolder !== undefined ? { processHolder } : {}) });
  return { result, took: Date.now() - started };
}

const python = () => (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "/usr/bin/python3");

/** Every `process.kill` this process makes from now on, as `[pid, signal]` (the calls still go through). */
function watchKills() {
  const spy = spyOn(process, "kill");
  return { get calls() { return spy.mock.calls as unknown as Array<[number, string | number | undefined]>; }, restore: () => spy.mockRestore() };
}
const kills: Array<{ restore: () => void }> = [];
afterEach(() => { for (const k of kills.splice(0)) k.restore(); });

/** A script (Python ctypes, nothing built) that starts `inner` disclaimed and in a session of its own: out from under
 *  the holder. The escaped shell keeps the command's output. */
function escapeScript(inner: string): string {
  const innerFile = join(dir, `inner-${tag()}.sh`);
  writeFileSync(innerFile, inner);
  const file = join(dir, `escape-${tag()}.py`);
  writeFileSync(file, `import ctypes, sys
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
attr = ctypes.c_void_p()
libc.posix_spawnattr_init(ctypes.byref(attr))
libc.posix_spawnattr_setflags(ctypes.byref(attr), ctypes.c_short(0x0400))  # POSIX_SPAWN_SETSID
libc.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1)
pid = ctypes.c_int()
argv = (ctypes.c_char_p * 3)(b"/bin/sh", ${JSON.stringify(innerFile)}.encode(), None)
envp = (ctypes.c_char_p * 2)(b"PATH=/usr/bin:/bin", None)
sys.exit(libc.posix_spawn(ctypes.byref(pid), b"/bin/sh", None, ctypes.byref(attr), argv, envp))
`);
  return `${python()} ${JSON.stringify(file)}`;
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

describe.if(process.platform === "darwin")("the holder's edges", () => {
  test("a process that disclaims itself (Python ctypes) escapes the holder, stays in the sandbox, and is reported as escaped", async () => {
    const n = `3${tag()}8`;
    const rc = join(dir, `escaped-${n}.rc`);
    // Under the sandbox a write to the working folder's .zshrc is refused; the escaped shell tries it, then waits.
    const inner = `touch ${JSON.stringify(join(dir, ".zshrc"))} 2>/dev/null; echo "touch=$?" > ${JSON.stringify(rc)}; echo escaped-shell; exec sleep ${n}\n`;
    const result = await runCommandLocally({ command: `${escapeScript(inner)}; echo command-done`, cwd: dir, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" }, timeoutMs: 30_000, settings: { enabled: true }, processHolder: holder! });
    try {
      expect(result.posture).toBe("sandboxed");
      expect(result.timedOut).toBe(false);
      const left = result.leftBehind as LeftBehind;
      expect(left).toBeDefined();
      expect(left.escaped).toBe(true);
      expect(await waitFor(() => alive(n))).toBe(true);
      expect(await waitFor(() => existsSync(rc))).toBe(true);
      expect(readFileSync(rc, "utf8").trim()).not.toBe("touch=0");
      expect(existsSync(join(dir, ".zshrc"))).toBe(false);
      // Nothing here can stop it; a stop lets go of its output, and the task is done.
      let ended = false;
      void left.done.then(() => { ended = true; });
      left.stop();
      expect(await waitFor(() => ended, 3_000)).toBe(true);
    } finally {
      spawnSync("/usr/bin/pkill", ["-f", `^sleep ${n}$`]);
    }
  }, 30_000);

  test("PROCESS_HOLDER_DISCLAIMED set beforehand changes nothing: what the command leaves is still found and stopped", async () => {
    const n = [1, 2, 3, 4].map((i) => `3${tag()}${i}`);
    const { result } = await run(leaveFour(n), holder, { PROCESS_HOLDER_DISCLAIMED: "1" });
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    expect(left.escaped).toBeUndefined();
    for (const s of n) expect(await waitFor(() => alive(s))).toBe(true);
    left.stop();
    expect(await waitFor(() => n.every((s) => !alive(s)))).toBe(true);
  }, 30_000);

  test("processes that ignore SIGTERM and keep starting more are all stopped by the holder's SIGKILL passes", async () => {
    const n = `3${tag()}9`;
    const script = join(dir, `spawner-${n}.sh`);
    writeFileSync(script, `trap '' TERM\nwhile true; do (trap '' TERM; exec sleep ${n}) & sleep 0.05; done\n`);
    const { result } = await run(`nohup /bin/bash ${JSON.stringify(script)} >/dev/null 2>&1 &\nsleep 0.5; echo ok`, holder);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    expect(await waitFor(() => alive(n))).toBe(true);
    let ended = false;
    void left.done.then(() => { ended = true; });
    left.stop();
    expect(await waitFor(() => ended, HOLDER_STOP_GRACE_MS)).toBe(true);
    expect(alive(n)).toBe(false);
    expect(spawnSync("/usr/bin/pgrep", ["-f", script]).status).not.toBe(0);
  }, 30_000);

  test("probe C, holder: once the holder has exited nothing signals its pid or group, whatever asks", async () => {
    let stopOwned: (() => void) | undefined;
    let pid = 0;
    const controller = new AbortController();
    const result = await runCommandLocally({ command: "echo hi", cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000, settings: { enabled: false }, processHolder: holder!, signal: controller.signal, onSpawned: (s) => { pid = s.pid; stopOwned = s.stopOwnedProcess; } });
    expect(result.exitCode).toBe(0);
    const k = watchKills();
    kills.push(k);
    stopOwned!();
    controller.abort();
    await Bun.sleep(300);
    expect(k.calls.filter(([p]) => p === pid || p === -pid)).toEqual([]);
  }, 30_000);

  test("probe C/D, holder: a stop after the holder exited, and its SIGKILL fallback, never reach its pid or group", async () => {
    const n = `3${tag()}0`;
    const { result } = await run(`nohup sleep ${n} >/dev/null 2>&1 & echo ok`, holder);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    const k = watchKills();
    kills.push(k);
    left.stop();
    await left.done;
    expect(alive(n)).toBe(false);
    left.stop();
    // The fallback would have fired by now had it not been dropped on the holder's exit.
    await Bun.sleep(HOLDER_STOP_GRACE_MS + 500);
    expect(k.calls.filter(([p, s]) => p === -left.pid || (p === left.pid && s !== "SIGTERM"))).toEqual([]);
    expect(k.calls.filter(([p]) => p === left.pid)).toEqual([[left.pid, "SIGTERM"]]);
  }, 30_000);
});

describe("without a holder: the process group stands for what a command left", () => {
  test("probe D: no SIGKILL lands on the group once it is gone; a stop after that is nothing", async () => {
    const n = `4${tag()}3`;
    const { result } = await run(`(sleep ${n} &) >/dev/null 2>&1\necho ran`);
    const left = result.leftBehind as LeftBehind;
    expect(left).toBeDefined();
    const k = watchKills();
    kills.push(k);
    left.stop();
    await left.done;
    expect(alive(n)).toBe(false);
    left.stop();
    await Bun.sleep(GROUP_STOP_GRACE_MS + 500);
    expect(k.calls.filter(([p, s]) => p === -left.pid && s !== 0)).toEqual([[-left.pid, "SIGTERM"]]);
  }, 30_000);

  test("probe C: after the leader exits nothing signals its group, a timeout included; the run lets go of the output", async () => {
    const n = `4${tag()}4`;
    let pid = 0;
    const k = watchKills();
    kills.push(k);
    // A setsid'd process keeps the output open while the group is gone: without a holder it is out of reach.
    const result = await runCommandLocally({ command: `${python()} -c 'import os,subprocess; os.setsid(); subprocess.Popen(["sleep","${n}"]); os._exit(0)'; echo ran`, cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 1_500, settings: { enabled: false }, onSpawned: (s) => { pid = s.pid; } });
    try {
      expect(result.timedOut).toBe(true);
      expect(k.calls.filter(([p, s]) => (p === pid || p === -pid) && s !== 0)).toEqual([]);
    } finally {
      spawnSync("/usr/bin/pkill", ["-f", `^sleep ${n}$`]);
    }
  }, 30_000);

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
