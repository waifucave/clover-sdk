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
import { beginLinuxRun, heldPathOf, resetLinuxRunsForTest, swappedHeld, type HeldPath } from "./sandbox/linux-runs.ts";

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
    const held = [heldPathOf(join(root, "proj", ".git"))!];
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
    const held: HeldPath[] = [heldPathOf(join(root, "a", ".git"))!, heldPathOf(join(root, "b", ".git"))!];
    rmSync(join(root, "b"), { recursive: true });
    expect(swappedHeld(held)).toEqual([]);
    expect(beginLinuxRun({ unheld: [], held, quarantineRoot: join(root, ".home", "quarantine"), made: [] })()).toEqual([]);
    expect(existsSync(join(root, "a", ".git"))).toBe(true);
  });

  test("a match the command made itself (found by the end-of-run walk): moved aside from its root, never through a link", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-new-");
    const quarantine = join(root, ".home", "quarantine");
    const end = beginLinuxRun({ unheld: [], held: [], rescan: () => [{ path: join(root, "sub", ".git"), anchor: root }], quarantineRoot: quarantine, made: [] });
    mkdirSync(join(root, "sub", ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, "sub", ".git", "hooks", "post-checkout"), "PLANTED\n");
    writeFileSync(join(root, "sub", "notes.txt"), "kept\n");
    expect(end()).toEqual([join(root, "sub", ".git")]);
    expect(existsSync(join(root, "sub", ".git"))).toBe(false);
    expect(readFileSync(join(root, "sub", "notes.txt"), "utf8")).toBe("kept\n");
    expect(readdirSync(quarantine).length).toBe(1);
  });

  test("a person's atomic save of a held file during the run (same parent, a new file): left where it is", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-save-");
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    writeFileSync(join(root, "proj", ".envrc"), "export A=1\n");
    writeFileSync(join(root, "proj", ".git", "config"), "[core]\n");
    const held = [heldPathOf(join(root, "proj", ".envrc"))!, heldPathOf(join(root, "proj", ".git", "config"))!];
    const quarantine = join(root, ".home", "quarantine");
    const end = beginLinuxRun({ unheld: [], held, quarantineRoot: quarantine, made: [] });
    // As an editor saves (and as `git config` rewrites its file): a new file written beside it, renamed over it. Another
    // process does it here, outside any sandbox; the command itself can't (each held file is bound read-only onto itself).
    for (const [p, text] of [[join(root, "proj", ".envrc"), "export A=2\n"], [join(root, "proj", ".git", "config"), "[core]\n\tbare = false\n"]] as const) {
      writeFileSync(`${p}.tmp`, text);
      renameSync(`${p}.tmp`, p);
    }
    expect(lstatSync(join(root, "proj", ".envrc")).ino).not.toBe(held[0]!.ino);
    expect(swappedHeld(held)).toEqual([]);
    expect(end()).toEqual([]);
    expect(readFileSync(join(root, "proj", ".envrc"), "utf8")).toBe("export A=2\n");
    expect(readFileSync(join(root, "proj", ".git", "config"), "utf8")).toBe("[core]\n\tbare = false\n");
    expect(existsSync(quarantine) ? readdirSync(quarantine) : []).toEqual([]);
  });

  test("a held file under a renamed folder (a new parent): moved aside; a held folder swapped in the same parent: moved aside", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-parent-");
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", ".envrc"), "export A=1\n");
    mkdirSync(join(root, "other", ".husky"), { recursive: true });
    const held = [heldPathOf(join(root, "proj", ".envrc"))!, heldPathOf(join(root, "other", ".husky"))!];
    const end = beginLinuxRun({ unheld: [], held, quarantineRoot: join(root, ".home", "quarantine"), made: [] });
    renameSync(join(root, "proj"), join(root, "proj-old"));
    mkdirSync(join(root, "proj"));
    writeFileSync(join(root, "proj", ".envrc"), "PLANTED\n");
    renameSync(join(root, "other", ".husky"), join(root, "other", ".husky-old"));
    mkdirSync(join(root, "other", ".husky"));
    writeFileSync(join(root, "other", ".husky", "pre-commit"), "PLANTED\n");
    expect(end().sort()).toEqual([join(root, "other", ".husky"), join(root, "proj", ".envrc")].sort());
    expect(existsSync(join(root, "proj", ".envrc"))).toBe(false);
    expect(existsSync(join(root, "other", ".husky"))).toBe(false);
    expect(readFileSync(join(root, "proj-old", ".envrc"), "utf8")).toBe("export A=1\n");
  });
});
