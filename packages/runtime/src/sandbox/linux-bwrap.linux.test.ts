// The Linux sandbox for real (bubblewrap, linux-bwrap.ts): a sandboxed command writes only where it may, reads nothing
// denied, reaches no network and no Unix socket on the disk, sees no other process, can't make a user namespace, and
// gets no session bus. Every case is `test.skipIf`, per this codebase's convention: another OS, or a Linux without
// bubblewrap, still enumerates them as skipped. CI sets WINTER_REQUIRE_LINUX_SANDBOX=1, which turns "no bubblewrap
// here" into a failure, so a runner that lost it can't turn this file green by skipping.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandSandboxAvailable, isSandboxAvailable, linuxHostConfinement, linuxSandboxReady, linuxUnheldProtectedPaths, runCommand, SandboxUnavailableError } from "./spawn.ts";
import { findBwrap, bwrapHasDisableUserns } from "./linux-bwrap.ts";
import { WINTER_BRAND } from "@waifucave/clover-agent-sdk";
import { buildHostCodePermissionContext, type HostCodePermissionSnapshot } from "../permissions/host-code.ts";
import type { SandboxSettings } from "./profile.ts";

const linux = process.platform === "linux";
const ready = linux && linuxSandboxReady();
if (linux && !ready && process.env.WINTER_REQUIRE_LINUX_SANDBOX === "1") throw new Error("WINTER_REQUIRE_LINUX_SANDBOX=1, but bubblewrap can't sandbox a command on this runner");
const linuxTest = test.skipIf(!ready);

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

async function run(command: string, cwd: string, o: { settings?: SandboxSettings; writableRoots?: string[]; denyWritePaths?: string[]; denyReadPaths?: string[]; home?: string } = {}) {
  let out = "", err = "";
  const result = await runCommand({
    command, cwd, env: { ...process.env, TMPDIR: cwd, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus", XDG_RUNTIME_DIR: "/run/user/0" }, timeoutMs: 20_000,
    settings: o.settings ?? {},
    ...(o.writableRoots ? { writableRoots: o.writableRoots } : {}),
    ...(o.denyWritePaths ? { denyWritePaths: o.denyWritePaths } : {}),
    ...(o.denyReadPaths ? { denyReadPaths: o.denyReadPaths } : {}),
    ...(o.home ? { home: o.home } : {}),
    onStdout: (c) => { out += c.toString(); },
    onStderr: (c) => { err += c.toString(); },
  });
  return { ...result, out, err };
}

describe("the Linux sandbox (bubblewrap)", () => {
  test("available exactly where bubblewrap can sandbox; a missing bwrap is refused, never run unsandboxed", async () => {
    if (!linux) return expect(linuxSandboxReady()).toBe(false);
    expect(isSandboxAvailable()).toBe(ready);
    expect(isSandboxAvailable("/nonexistent/bwrap")).toBe(false);
    // hostFenced counts only in a process verified to be confined; a CI runner's isn't.
    expect(commandSandboxAvailable({ hostFenced: true }, "/nonexistent/bwrap")).toBe(linuxHostConfinement().ok);
    if (!ready) await expect(run("true", temp("clover-a3-lx-"))).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  linuxTest("writes land in the working folder and its writable roots, nowhere else", async () => {
    const cwd = temp("clover-a3-lx-cwd-"), extra = temp("clover-a3-lx-extra-"), outside = temp("clover-a3-lx-out-");
    const r = await run(`echo a > in.txt && echo b > ${extra}/x.txt && (echo c > ${outside}/no.txt) 2>/dev/null; echo done`, cwd, { writableRoots: [extra] });
    expect(r.exitCode).toBe(0);
    expect(r.posture).toBe("sandboxed");
    expect(readFileSync(join(cwd, "in.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(extra, "x.txt"), "utf8")).toBe("b\n");
    expect(existsSync(join(outside, "no.txt"))).toBe(false);
  });

  linuxTest("a denied path stays as it is: written, renamed out, or its folder renamed out; a missing one in a held folder can't be made", async () => {
    const cwd = temp("clover-a3-lx-cwd-");
    mkdirSync(join(cwd, "keep"));
    writeFileSync(join(cwd, "keep", "secret.txt"), "orig");
    mkdirSync(join(cwd, "cfg"));
    writeFileSync(join(cwd, "cfg", "other.json"), "{}");
    const r = await run([
      "(echo x > keep/secret.txt) 2>/dev/null",
      "(mv keep/secret.txt keep/moved.txt) 2>/dev/null",
      "(mv keep gone) 2>/dev/null",
      "(echo y > cfg/new.json) 2>/dev/null",
      "echo z > cfg/other.json",
      "echo ok",
    ].join("; "), cwd, { denyWritePaths: [join(cwd, "keep", "secret.txt"), join(cwd, "cfg", "new.json")] });
    expect(r.out).toContain("ok");
    expect(readFileSync(join(cwd, "keep", "secret.txt"), "utf8")).toBe("orig");
    expect(existsSync(join(cwd, "gone"))).toBe(false);
    expect(existsSync(join(cwd, "cfg", "new.json"))).toBe(false);
    expect(readFileSync(join(cwd, "cfg", "other.json"), "utf8")).toBe("z\n");
  });

  linuxTest("a read-denied file reads as nothing, a read-denied folder as empty, and the run folder is hidden", async () => {
    const cwd = temp("clover-a3-lx-cwd-"), home = temp("clover-a3-lx-home-");
    writeFileSync(join(cwd, ".env"), "TOKEN=hunter2");
    mkdirSync(join(home, "private"));
    writeFileSync(join(home, "private", "key"), "SECRETKEY");
    mkdirSync(join(home, ".winter", "run"), { recursive: true });
    writeFileSync(join(home, ".winter", "run", "core.token"), "RUNTOKEN");
    const r = await run(`cat .env; ls ${home}/private; cat ${home}/private/key; cat ${home}/.winter/run/core.token; echo end`, cwd, { denyReadPaths: [join(cwd, ".env"), join(home, "private")], home });
    expect(r.out).toContain("end");
    for (const s of ["hunter2", "SECRETKEY", "RUNTOKEN"]) expect(r.out + r.err).not.toContain(s);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("TOKEN=hunter2");
  });

  linuxTest("no network by default, and never a Unix socket on the disk; the default protections hold (.git/hooks)", async () => {
    const cwd = temp("clover-a3-lx-cwd-");
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    const sock = join(cwd, "s.sock");
    const server = spawnSync("python3", ["-c", `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(sock)}); print("bound")`], { encoding: "utf8" });
    const py = server.status === 0;
    const r = await run([
      "(exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo NET || echo nonet",
      py ? `python3 -c "import socket; socket.socket(socket.AF_UNIX)" 2>/dev/null && echo UNIX || echo nounix` : "echo nounix",
      "(echo x > .git/hooks/pre-commit) 2>/dev/null && echo HOOK || echo nohook",
    ].join("; "), cwd);
    expect(r.out).toContain("nonet");
    expect(r.out).toContain("nounix");
    expect(r.out).toContain("nohook");
    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  linuxTest("its own pid namespace, no user namespace inside, no capabilities, and no session bus in its environment", async () => {
    const cwd = temp("clover-a3-lx-cwd-");
    const r = await run([
      `kill -0 ${process.pid} 2>/dev/null && echo SEES || echo nopid`,
      `ls /proc | grep -c '^[0-9]' `,
      "(unshare -U true) 2>/dev/null && echo USERNS || echo nouserns",
      'echo "bus=${DBUS_SESSION_BUS_ADDRESS:-none} rt=${XDG_RUNTIME_DIR:-none}"',
      "ls /run/user | wc -l",
    ].join("; "), cwd);
    expect(r.out).toContain("nopid");
    expect(Number(r.out.split("\n")[1])).toBeLessThan(10);
    if (bwrapHasDisableUserns(findBwrap()!)) expect(r.out).toContain("nouserns");
    expect(r.out).toContain("bus=none rt=none");
    expect(r.out.trim().split("\n").at(-1)).toBe("0");
  });

  linuxTest("hostFenced in a process that isn't confined: refused, never run unsandboxed", async () => {
    const cwd = temp("clover-a3-lx-cwd-");
    expect(linuxHostConfinement().ok).toBe(false);
    const err = await run(`echo ran > ran.txt`, cwd, { settings: { hostFenced: true } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxUnavailableError);
    expect(String((err as Error).message)).toContain("hostFenced");
    expect(existsSync(join(cwd, "ran.txt"))).toBe(false);
  });

  linuxTest("a missing .git/hooks is made before the run and holds; with no repo, what the command makes there is moved aside", async () => {
    const repo = temp("clover-a3-lx-cwd-"), home = temp("clover-a3-lx-home-");
    mkdirSync(join(repo, ".git"));
    const r = await run("(echo x > .git/hooks/pre-commit) 2>/dev/null && echo HOOK || echo nohook", repo, { home });
    expect(r.out).toContain("nohook");
    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    // Made for the run, and removed at its end while still empty (no other run is live).
    expect(existsSync(join(repo, ".git", "hooks"))).toBe(false);
    expect(existsSync(join(repo, ".vscode"))).toBe(false);
    expect(existsSync(join(repo, ".winter"))).toBe(false);
    const bare = temp("clover-a3-lx-cwd-");
    const r2 = await run("mkdir -p .git/hooks && echo x > .git/hooks/pre-commit && echo made", bare, { home });
    expect(r2.out).toContain("made");
    expect(r2.quarantined).toEqual([join(bare, ".git", "hooks")]);
    expect(r2.err).toContain("moved aside");
    expect(existsSync(join(bare, ".git", "hooks"))).toBe(false);
    expect(readdirSync(join(home, ".winter", "quarantine")).length).toBeGreaterThan(0);
  });

  linuxTest("a planted .winter/settings.json: the folder is made before the run and held, so it can't be; a planted .mcp.json is moved aside", async () => {
    const cwd = temp("clover-a3-lx-cwd-"), home = temp("clover-a3-lx-home-");
    const r = await run([
      `(echo '{"sandbox":{"enabled":false}}' > .winter/settings.json) 2>/dev/null && echo PLANTED || echo noplant`,
      "(ln -s /tmp .winter/settings.local.json) 2>/dev/null && echo LINKED || echo nolink",
      "echo '{}' > .mcp.json && echo mcp",
    ].join("; "), cwd, { home });
    expect(r.out).toContain("noplant");
    expect(r.out).toContain("nolink");
    expect(r.out).toContain("mcp");
    expect(existsSync(join(cwd, ".winter", "settings.json"))).toBe(false);
    expect(() => lstatSync(join(cwd, ".winter", "settings.local.json"))).toThrow();
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(r.quarantined).toEqual([join(cwd, ".mcp.json")]);
    expect(r.unheldProtectedPaths).toBeUndefined();
  });

  linuxTest("a forged run record from inside the sandbox does nothing: the bookkeeping folders are read-only to it, even with the home as the working folder", async () => {
    const home = temp("clover-a3-lx-home-");
    const outside = temp("clover-a3-lx-outside-");
    writeFileSync(join(outside, "precious.txt"), "the user's");
    const forged = JSON.stringify({ unheld: [{ path: join(outside, "precious.txt"), anchor: outside }], quarantineRoot: outside, made: [outside], roots: { cwd: outside, writableRoots: ["/"] } });
    const r = await run([
      `(printf '%s' '${forged}' > .winter/sandbox-runs/1-0-forged.json) 2>/dev/null && echo FORGED || echo noforge`,
      "(ln -s /tmp .winter/quarantine/x) 2>/dev/null && echo LINKED || echo nolink",
      "echo '{}' > .mcp.json",
    ].join("; "), home, { home });
    expect(r.out).toContain("noforge");
    expect(r.out).toContain("nolink");
    expect(existsSync(join(home, ".winter", "sandbox-runs", "1-0-forged.json"))).toBe(false);
    // The next run's recovery finds nothing to act on, and the user's file is untouched.
    await run("true", temp("clover-a3-lx-cwd-"), { home });
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("the user's");
  });

  linuxTest("the host-code broker asks the engine's check: no auto-allow while a protected folder can't be held", async () => {
    const snapshot = (cwd: string): HostCodePermissionSnapshot => ({
      scope: { generationId: "g", sessionId: "s" }, policyRevision: 1,
      config: { permissionMode: "default", sandbox: { enabled: true, autoAllowBashIfSandboxed: true } },
      cwd, sessionRoot: cwd, home: temp("clover-a3-lx-home-"), trustedWorkspace: false, brand: WINTER_BRAND,
    });
    const call = { toolName: "Bash", input: { command: "ls" } };
    const ok = temp("clover-a3-lx-cwd-");
    expect(buildHostCodePermissionContext(snapshot(ok)).bashRunsSandboxed!(call as never)).toBe(true);
    const locked = temp("clover-a3-lx-ro-");
    // A link where .claude should be: .claude/commands can't be made, so it can't be held.
    symlinkSync(temp("clover-a3-lx-elsewhere-"), join(locked, ".claude"));
    expect(linuxUnheldProtectedPaths({ cwd: locked })).toContain(join(locked, ".claude", "commands"));
    expect(buildHostCodePermissionContext(snapshot(locked)).bashRunsSandboxed!(call as never)).toBe(false);
  });

  linuxTest("a protected folder that can't be made stays unheld: reported, and the command isn't counted as sandboxed", async () => {
    const cwd = temp("clover-a3-lx-cwd-");
    expect(linuxUnheldProtectedPaths({ cwd })).toEqual([]);
    const locked = temp("clover-a3-lx-ro-");
    chmodSync(locked, 0o555);
    try {
      const unheld = linuxUnheldProtectedPaths({ cwd: locked });
      expect(unheld).toContain(join(locked, ".winter"));
      expect(unheld).toContain(join(locked, ".vscode"));
      const r = await run("echo ran", locked);
      expect(r.unheldProtectedPaths).toContain(join(locked, ".winter"));
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
