// The `./sandbox` entry's host run (sandbox.ts), on every OS: it refuses BEFORE anything starts when the settings would
// run the command plain (`requireSandboxed`), it never hands the command to a host Code broker bound in the calling
// thread, and the end-of-run clean-up moves aside an entry swapped in at a held path (the rename) by its identity alone,
// with no mount involved (`swappedHeld`).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSandboxAvailable, runCommand, SandboxUnavailableError } from "@waifucave/clover-agent-runtime/sandbox";
import { installHostCodeProcessClient, type HostCodeProcessClient } from "./sandbox/host-code-process.ts";
import { beginLinuxRun, resetLinuxRunsForTest, swappedHeld, type HeldPath } from "./sandbox/linux-runs.ts";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };
const base = (cwd: string) => ({ command: "", cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 20_000, writableRoots: [cwd], home: cwd });

describe("requireSandboxed: refused before anything starts", () => {
  test("settings off, an excluded command, or an unsandboxed-commands policy: a typed refusal, the command never ran", async () => {
    const cwd = temp("sbx-host-req-");
    const marker = join(cwd, "ran.txt");
    const command = `touch ${JSON.stringify(marker)}`;
    for (const settings of [{ enabled: false }, { excludedCommands: [command], allowUnsandboxedCommands: true }]) {
      await expect(runCommand({ ...base(cwd), command, settings })).rejects.toBeInstanceOf(SandboxUnavailableError);
      expect(existsSync(marker)).toBe(false);
    }
  });
});

describe("the host run never hands off to a bound broker", () => {
  test.skipIf(!commandSandboxAvailable({}))("with a broker bound in this thread, the command still runs here, sandboxed", async () => {
    const cwd = temp("sbx-host-broker-");
    let asked = 0;
    const refuse = async () => { asked++; throw new Error("the broker was asked"); };
    const client: HostCodeProcessClient = { start: refuse, poll: refuse, write: refuse, signal: refuse, release: refuse };
    const unbind = installHostCodeProcessClient({ client, generationId: "g-test" });
    try {
      let out = "";
      const r = await runCommand({ ...base(cwd), command: "echo local", settings: {}, onStdout: (c) => { out += c.toString(); } });
      expect(r.posture).toBe("sandboxed");
      expect(out.trim()).toBe("local");
      expect(asked).toBe(0);
    } finally { unbind(); }
  });
});

describe("the end-of-run clean-up holds a held path by its identity (no mounts)", () => {
  test("the rename: the real .git moved away with its folder, a new one made at its path: the new one is moved aside", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-swap-");
    const quarantine = join(root, ".home", "quarantine");
    mkdirSync(join(root, "proj", ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, "proj", ".git", "config"), "ORIGINAL\n");
    const at = (p: string): HeldPath => { const st = lstatSync(p); return { path: p, dev: st.dev, ino: st.ino }; };
    const held = [at(join(root, "proj", ".git"))];
    const end = beginLinuxRun({ unheld: [], held, quarantineRoot: quarantine, made: [] });
    // What a command does when nothing holds the folders: the rename, then a planted repository at the held path.
    renameSync(join(root, "proj"), join(root, "proj-old"));
    mkdirSync(join(root, "proj", ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, "proj", ".git", "hooks", "post-checkout"), "PLANTED\n");
    expect(swappedHeld(held).map((u) => u.path)).toEqual([join(root, "proj", ".git")]);
    const moved = end();
    expect(moved).toEqual([join(root, "proj", ".git")]);
    expect(existsSync(join(root, "proj", ".git"))).toBe(false);
    // The real one, where the rename took it, untouched; the plant is in the quarantine folder, not deleted.
    expect(readFileSync(join(root, "proj-old", ".git", "config"), "utf8")).toBe("ORIGINAL\n");
    expect(readdirSync(quarantine).length).toBe(1);
  });

  test("an unchanged held path, or one that is gone with nothing in its place: nothing moves", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-same-");
    mkdirSync(join(root, "a", ".git"), { recursive: true });
    mkdirSync(join(root, "b", ".git"), { recursive: true });
    const at = (p: string): HeldPath => { const st = lstatSync(p); return { path: p, dev: st.dev, ino: st.ino }; };
    const held = [at(join(root, "a", ".git")), at(join(root, "b", ".git"))];
    rmSync(join(root, "b"), { recursive: true });
    expect(swappedHeld(held)).toEqual([]);
    expect(beginLinuxRun({ unheld: [], held, quarantineRoot: join(root, ".home", "quarantine"), made: [] })()).toEqual([]);
    expect(existsSync(join(root, "a", ".git"))).toBe(true);
  });
});
