// The `./sandbox` entry's host run (sandbox.ts), on every OS: it refuses BEFORE anything starts when the settings would
// run the command plain (`requireSandboxed`), it never hands the command to a host Code broker bound in the calling
// thread, and the end-of-run clean-up moves aside an entry swapped in at a held path (the rename) by its identity alone,
// with no mount involved (`swappedHeld`).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandSandboxAvailable, movedAsideNote, notePath, runCommand, SandboxUnavailableError } from "@waifucave/clover-agent-runtime/sandbox";
import { installHostCodeProcessClient, type HostCodeProcessClient } from "./sandbox/host-code-process.ts";
import { beginLinuxRun, heldPathOf, quarantineName, resetLinuxRunsForTest, swappedHeld, type HeldPath, type RunReport } from "./sandbox/linux-runs.ts";
import { sweepExpander } from "./sandbox/spawn.ts";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) {
    // The sweep's cases leave folders without write (chmod 111, then the sweep's u+rx): writable again first.
    if (process.platform !== "win32") spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
});
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };
/** A held path as a run takes it: its handle kept (Linux), so a reused inode number can't pass for it. */
const hp = (p: string) => heldPathOf(p, true);
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
    const held = [hp(join(root, "proj", ".git"))!];
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
    const held: HeldPath[] = [hp(join(root, "a", ".git"))!, hp(join(root, "b", ".git"))!];
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
    const held = [hp(join(root, "proj", ".envrc"))!, hp(join(root, "proj", ".git", "config"))!];
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
    const held = [hp(join(root, "proj", ".envrc"))!, hp(join(root, "other", ".husky"))!];
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

  test("a held LINK (no mount holds one): replaced in the same parent, by a file or by a folder, it is moved aside", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-link-");
    mkdirSync(join(root, "dots", "hooks"), { recursive: true });
    writeFileSync(join(root, "dots", "zshrc"), "# mine\n");
    // A stow-style home: `.zshrc` a link to a file, `.husky` a link to a folder.
    symlinkSync(join(root, "dots", "zshrc"), join(root, ".zshrc"));
    symlinkSync(join(root, "dots", "hooks"), join(root, ".husky"));
    const held = [hp(join(root, ".zshrc"))!, hp(join(root, ".husky"))!];
    expect(held.map((h) => h.kind)).toEqual(["link", "link"]);
    const quarantine = join(root, ".home", "quarantine");
    const end = beginLinuxRun({ unheld: [], held, quarantineRoot: quarantine, made: [] });
    // `rm ~/.zshrc; echo … > ~/.zshrc`, and the same for the folder link.
    rmSync(join(root, ".zshrc"));
    writeFileSync(join(root, ".zshrc"), "PLANTED\n");
    rmSync(join(root, ".husky"));
    mkdirSync(join(root, ".husky"));
    writeFileSync(join(root, ".husky", "pre-commit"), "PLANTED\n");
    expect(end().sort()).toEqual([join(root, ".husky"), join(root, ".zshrc")].sort());
    expect(existsSync(join(root, ".zshrc"))).toBe(false);
    expect(existsSync(join(root, ".husky"))).toBe(false);
    // What the links pointed at is untouched.
    expect(readFileSync(join(root, "dots", "zshrc"), "utf8")).toBe("# mine\n");
  });

  test("the spare is by the START kind: a held folder replaced by a file in the same parent is moved aside", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-kind-");
    mkdirSync(join(root, ".husky"));
    const held = [hp(join(root, ".husky"))!];
    const end = beginLinuxRun({ unheld: [], held, quarantineRoot: join(root, ".home", "quarantine"), made: [] });
    rmSync(join(root, ".husky"), { recursive: true });
    writeFileSync(join(root, ".husky"), "PLANTED\n");
    expect(end()).toEqual([join(root, ".husky")]);
  });

  test("with no quarantine folder, a swapped or new match is never deleted: it stays, said in notMoved", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-noq-");
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    const held = [hp(join(root, "proj", ".git"))!];
    const report: RunReport = { notMoved: [], unswept: [] };
    // A literal protected path missing at the start too (`unheld`): the same rule.
    const end = beginLinuxRun({ unheld: [{ path: join(root, ".mcp.json"), anchor: root }], held, rescan: () => [{ path: join(root, "sub", ".envrc"), anchor: root }], report, quarantineRoot: undefined, made: [] });
    renameSync(join(root, "proj"), join(root, "proj-old"));
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", ".envrc"), "mine\n");
    writeFileSync(join(root, ".mcp.json"), "{}\n");
    expect(end()).toEqual([]);
    expect(existsSync(join(root, "proj", ".git"))).toBe(true);
    expect(readFileSync(join(root, "sub", ".envrc"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{}\n");
    expect(report.notMoved.map((n) => n.path).sort()).toEqual([join(root, ".mcp.json"), join(root, "proj", ".git"), join(root, "sub", ".envrc")].sort());
    expect(report.notMoved[0]!.why).toBe("there is no quarantine folder to move it to");
  });

  test("a sweep that throws is never swallowed: said in unswept", () => {
    resetLinuxRunsForTest();
    const root = temp("sbx-host-throw-");
    const report: RunReport = { notMoved: [], unswept: [] };
    const end = beginLinuxRun({ unheld: [], held: [], rescan: () => { throw new Error("boom"); }, report, quarantineRoot: join(root, "q"), made: [] });
    expect(end()).toEqual([]);
    expect(report.unswept).toEqual([{ root: "(the sweep)", why: "it failed: boom" }]);
  });

  test("a quarantine name stays a valid name however deep the path", () => {
    const deep = `/${Array.from({ length: 40 }, (_, i) => `folder-${i}-${"x".repeat(20)}`).join("/")}/.git`;
    const name = quarantineName(deep);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).toMatch(/\.git\.quarantined-[0-9a-f]+$/);
  });
});

describe("the end-of-run sweep (sweepRoots): honest about what it couldn't read", () => {
  const MATCH = [/\/\.git$/, /\/\.husky$/];
  const linuxOwner = process.platform === "linux" && process.getuid?.() !== 0;
  test.skipIf(!linuxOwner)("a folder the command made unreadable (chmod 111) is opened and read; a 17-deep folder doesn't hide its sibling; the old mode comes back", () => {
    const root = temp("sbx-sweep-read-");
    mkdirSync(join(root, "sub", ".git"), { recursive: true });
    chmodSync(join(root, "sub"), 0o111);
    mkdirSync(join(root, ...Array.from({ length: 17 }, (_, i) => `d${i}`)), { recursive: true });
    mkdirSync(join(root, "z", ".husky"), { recursive: true });
    const unswept: { root: string; why: string }[] = [];
    const sweep = sweepExpander([root], unswept);
    const r = sweep(root, MATCH);
    expect(r.found[0]).toEqual([join(root, "sub", ".git")]);
    expect(r.found[1]).toEqual([join(root, "z", ".husky")]);
    expect(unswept).toEqual([]);
    // Open for the moves until `restore`, then as the command left it.
    expect(lstatSync(join(root, "sub")).mode & 0o777).toBe(0o711);
    sweep.restore();
    expect(lstatSync(join(root, "sub")).mode & 0o777).toBe(0o111);
  });

  test.skipIf(!linuxOwner)("a folder that can be read but not entered (chmod 400) is opened BEFORE it is read: what's in it is found", () => {
    const root = temp("sbx-sweep-enter-");
    mkdirSync(join(root, "sub", "x", ".git"), { recursive: true });
    chmodSync(join(root, "sub"), 0o400);
    const unswept: { root: string; why: string }[] = [];
    const sweep = sweepExpander([root], unswept);
    expect(sweep(root, MATCH).found[0]).toEqual([join(root, "sub", "x", ".git")]);
    expect(unswept).toEqual([]);
    sweep.restore();
    expect(lstatSync(join(root, "sub")).mode & 0o777).toBe(0o400);
  });

  test.skipIf(!linuxOwner)("a link swapped in for a folder is never chmod'ed through: what it points at keeps its mode", () => {
    const root = temp("sbx-sweep-link-");
    mkdirSync(join(root, "elsewhere"));
    chmodSync(join(root, "elsewhere"), 0o500);
    symlinkSync(join(root, "elsewhere"), join(root, "sub"));
    const unswept: { root: string; why: string }[] = [];
    const sweep = sweepExpander([join(root, "sub")], unswept, { writeRoots: [root] });
    sweep(join(root, "sub"), MATCH);
    sweep.restore();
    expect(lstatSync(join(root, "elsewhere")).mode & 0o777).toBe(0o500);
  });

  test("a child that can't be looked at (listed, not entered) is counted unread, not taken as gone", () => {
    // Off Linux (no O_PATH opener) a folder left 0400 is read but its children can't be looked at.
    if (process.platform === "linux" || process.platform === "win32" || process.getuid?.() === 0) return;
    const root = temp("sbx-sweep-unread-");
    mkdirSync(join(root, "sub", "x"), { recursive: true });
    chmodSync(join(root, "sub"), 0o400);
    const unswept: { root: string; why: string }[] = [];
    sweepExpander([root], unswept)(root, MATCH);
    expect(unswept).toEqual([{ root, why: `a folder in it can't be read: ${join(root, "sub")}` }]);
  });

  test("past its budget: the root is said unswept, never silent", () => {
    const root = temp("sbx-sweep-budget-");
    for (let i = 0; i < 30; i++) mkdirSync(join(root, `f${i}`, "inner"), { recursive: true });
    const unswept: { root: string; why: string }[] = [];
    sweepExpander([root], unswept, { budget: { maxVisited: 10, maxMs: 60_000 } })(root, MATCH);
    expect(unswept).toEqual([{ root, why: "it holds more than one command's end can check" }]);
    expect(movedAsideNote([], undefined, { unswept })).toBe(`[sandbox] ${root}: could not be fully checked at the command's end (it holds more than one command's end can check); something it made there may have stayed`);
  });

  test("a folder it can't open even so (not the user's): the root is said unswept", () => {
    const root = temp("sbx-sweep-fail-");
    mkdirSync(join(root, "locked"));
    const unswept: { root: string; why: string }[] = [];
    const real = sweepExpander([root], unswept);
    // A root another user owns can't be chmod'ed; here a name that is a folder no read can open (a seam-free stand-in:
    // a path under a file).
    writeFileSync(join(root, "afile"), "");
    real(join(root, "afile", "x"), MATCH);
    expect(unswept).toEqual([]); // ENOTDIR: nothing there, not a failure
    if (linuxOwner) {
      chmodSync(join(root, "locked"), 0o000);
      // Owned by this user: opened and read.
      real(root, MATCH);
      expect(unswept).toEqual([]);
      real.restore();
    }
  });

  test("a path in a note is escaped: a newline in a folder's name can't start a line", () => {
    expect(notePath("/w/a\nb/.husky")).toBe("/w/a\\u000ab/.husky");
    const note = movedAsideNote(["/w/a\n[sandbox] /x: moved to/.husky"], "/q");
    expect(note.split("\n").length).toBe(1);
  });
});
