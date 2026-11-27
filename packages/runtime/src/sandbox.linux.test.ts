// The public `./sandbox` entry (sandbox.ts), as a host uses it: its own `SandboxSettings` turned into run inputs by
// `buildHostSandboxRunInputs` (the deny globs split the way a session's Bash splits them), then `runCommand`. On Linux
// under real bubblewrap, with a host's held-names list (`/**/<name>` globs): a repository's `.git` held against the
// rename (`mv proj proj-old && mkdir -p proj/.git/hooks …`), a hook planted in a new repository moved aside at the
// command's end, nothing written outside the roots, and no network. Every Linux case is `test.skipIf`, per this
// codebase's convention; CI's WINTER_REQUIRE_LINUX_SANDBOX=1 turns "no bubblewrap here" into a failure.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as entry from "@waifucave/clover-agent-runtime/sandbox";
import { buildHostSandboxRunInputs, linuxSandboxReady, runCommand, type SandboxSettings } from "@waifucave/clover-agent-runtime/sandbox";

const linux = process.platform === "linux";
const ready = linux && linuxSandboxReady();
if (linux && !ready && process.env.WINTER_REQUIRE_LINUX_SANDBOX === "1") throw new Error("WINTER_REQUIRE_LINUX_SANDBOX=1, but bubblewrap can't sandbox a command on this runner");
const linuxTest = test.skipIf(!ready);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) {
    // A case leaves a folder without write (chmod 111): writable again first.
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
});
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

/** A host's held names, as MOSS draws them for a command's folder on Linux (one `/**` pattern per name). */
const HELD = ["/**/*.git", "/**/.husky", "/**/.githooks", "/**/.envrc", "/**/.vscode"];

/** A command as a host runs it: its settings, its roots, the entry's own input builder. The working folder is one of
 *  the roots (the runtime makes it writable). */
async function hostRun(command: string, o: { cwd: string; roots: string[]; home: string; settings?: SandboxSettings; sweep?: string[] }) {
  const settings: SandboxSettings = o.settings ?? { filesystem: { allowWrite: o.roots, denyWrite: HELD } };
  const inputs = buildHostSandboxRunInputs({ cwd: o.cwd, env: { ...process.env, TMPDIR: o.roots[0]! }, settings, writableRoots: o.roots, home: o.home });
  let out = "", err = "";
  const r = await runCommand({ ...inputs, command, timeoutMs: 30_000, ...(o.sweep ? { sweepRoots: o.sweep } : {}), onStdout: (c) => { out += c.toString(); }, onStderr: (c) => { err += c.toString(); } });
  // It ran sandboxed, never plain.
  expect(r.posture).toBe("sandboxed");
  // What the end did, as a host words it (outside the command's own output).
  const note = entry.movedAsideNote(r.quarantined ?? [], r.quarantineRoot, { notMoved: r.notMoved ?? [], unswept: r.unswept ?? [] });
  return { ...r, out, err, note };
}

/** Every file under `dir` whose content is `text` (what a planted hook would be found by). */
function filesHolding(dir: string, text: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p, "utf8").includes(text)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

describe("the ./sandbox entry", () => {
  test("names what a host needs: the run, its readiness, the input builder and the deny splitter", () => {
    for (const name of ["runCommand", "linuxSandboxReady", "commandSandboxAvailable", "isSandboxAvailable", "sweepLinuxRuns", "buildHostSandboxRunInputs", "computeDenyPaths", "splitDenyPathsByGlobShape", "globDenyEntriesOf", "sandboxUnavailableMessage", "movedAsideNote", "notePath", "notWritableLine"]) {
      expect([name, typeof (entry as Record<string, unknown>)[name]]).toEqual([name, "function"]);
    }
    // The glob denies become regexes with their fixed prefix, as a session's Bash gets them.
    const split = entry.buildHostSandboxRunInputs({ cwd: "/w", env: {}, settings: { filesystem: { denyWrite: ["/**/*.git", "/w/plain"] } }, writableRoots: ["/w"], home: "/h" });
    expect(split.denyWritePaths).toEqual(["/w/plain"]);
    expect(split.denyWriteRegexes?.length).toBe(1);
  });
});

describe("a host's command under real bubblewrap (Linux)", () => {
  linuxTest("the review's rename: the held .git stays where it was, and nothing is planted at its path", async () => {
    const home = temp("sbx-entry-home-");
    const work = join(home, "work");
    mkdirSync(join(work, "proj", ".git", "hooks"), { recursive: true });
    writeFileSync(join(work, "proj", ".git", "config"), "ORIGINAL\n");
    const cmd = "mv proj proj-old 2>/dev/null; mkdir -p proj/.git/hooks 2>/dev/null; echo PLANTED > proj/.git/hooks/post-checkout 2>/dev/null; echo PLANTED > proj/.git/config 2>/dev/null; echo done";
    const r = await hostRun(cmd, { cwd: work, roots: [work], home });
    expect(r.out).toContain("done");
    // The repository's own .git keeps its config, wherever its folder now is, and no hook or config written by the
    // command is left at a .git path.
    const configs = [join(work, "proj", ".git", "config"), join(work, "proj-old", ".git", "config")].filter((p) => existsSync(p));
    expect(configs.length).toBeGreaterThan(0);
    for (const c of configs) expect(readFileSync(c, "utf8")).toBe("ORIGINAL\n");
    expect(filesHolding(work, "PLANTED").filter((p) => p.includes(".git"))).toEqual([]);
  });

  linuxTest("swept (the host's folder): a hook planted in a new repository is moved aside at the command's end; an ordinary file stays", async () => {
    const home = temp("sbx-entry-plant-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const cmd = "mkdir -p sub/.git/hooks && echo PLANTED > sub/.git/hooks/post-checkout; mkdir -p sub/.husky && echo PLANTED > sub/.husky/pre-commit; echo kept > sub/notes.txt; echo done";
    const r = await hostRun(cmd, { cwd: work, roots: [work], home, sweep: [work] });
    expect(r.out).toContain("done");
    expect(readFileSync(join(work, "sub", "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(work, "sub", ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(work, "sub", ".husky", "pre-commit"))).toBe(false);
    expect(filesHolding(work, "PLANTED")).toEqual([]);
  });

  linuxTest("only the roots are written, and no network: a loopback listener outside isn't reached", async () => {
    const home = temp("sbx-entry-net-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const outside = join(home, "outside.txt");
      const cmd = `echo x > ${JSON.stringify(outside)} 2>/dev/null; echo y > inside.txt; (exec 3<>/dev/tcp/127.0.0.1/${server.port}) 2>/dev/null && echo REACHED || echo NO-NETWORK`;
      const r = await hostRun(cmd, { cwd: work, roots: [work], home });
      expect(existsSync(outside)).toBe(false);
      expect(readFileSync(join(work, "inside.txt"), "utf8")).toBe("y\n");
      expect(r.out).toContain("NO-NETWORK");
    } finally { server.stop(true); }
  });
});

describe("a working folder inside a root whose walk can't finish (Linux): the working folder stays writable, the rest says why", () => {
  linuxTest("the parent's walk can't finish (a folder 17 deep): the working folder inside it is still written; the parent isn't, and that is said on an exit 0", async () => {
    const home = temp("sbx-inner-");
    const parent = join(home, "Projects");
    const work = join(parent, "app");
    mkdirSync(work, { recursive: true });
    // What makes the parent's walk stop: a folder past the walk's 16 levels (a big sibling-heavy folder does the same by
    // its budget, slower to build here).
    mkdirSync(join(parent, ...Array.from({ length: 18 }, (_, i) => `d${i}`)), { recursive: true });
    const r = await hostRun("echo x > ok.txt; echo y > ../outside.txt 2>/dev/null; echo done", { cwd: work, roots: [work, parent], home });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("done");
    // 0.0.91 dropped the working folder with the parent (any root overlapping an unfinished walk): ok.txt was refused
    // as a read-only file system and nothing said so on an exit 0.
    expect(readFileSync(join(work, "ok.txt"), "utf8")).toBe("x\n");
    expect(existsSync(join(parent, "outside.txt"))).toBe(false);
    expect(r.notWritable).toEqual([parent]);
    expect(entry.notWritableLine(r.notWritable ?? [])).toContain(`not writable this run, too large to check for protected paths`);
  });

  linuxTest("swept: a peer's folder whose walk can't finish is dropped, and the working folder kept inside it is still swept", async () => {
    // Command 1 left a folder 18 deep in the peer's folder F; command 2 runs in F/sub (kept writable inside the dropped
    // F) and makes a repository there: it must be swept and moved aside, never left unseen.
    const home = temp("sbx-inner-sweep-");
    const f = join(home, "F");
    const sub = join(f, "sub");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(f, ...Array.from({ length: 18 }, (_, i) => `d${i}`)), { recursive: true });
    const r = await hostRun("git init -q . && git config core.fsmonitor 'echo PLANTED' && echo done", { cwd: sub, roots: [f], home, sweep: [f] });
    expect(r.out).toContain("done");
    expect(r.notWritable).toEqual([f]);
    expect(r.quarantined).toEqual([join(sub, ".git")]);
    expect(existsSync(join(sub, ".git"))).toBe(false);
    expect(r.unswept).toBeUndefined();
  });

  linuxTest("a root inside an unfinished walk that its own walk didn't fully cover (the working folder's protections) is dropped too", async () => {
    const home = temp("sbx-inner2-");
    const work = join(home, "work");
    const inner = join(work, "sub");
    mkdirSync(inner, { recursive: true });
    mkdirSync(join(work, ...Array.from({ length: 18 }, (_, i) => `d${i}`)), { recursive: true });
    // The working folder's walk can't finish; `sub` is a root inside it, but the working folder's own protections
    // (`**/.git/hooks` under it, and the rest) were asked under the working folder only: `sub` isn't known whole.
    const r = await hostRun("echo x > sub/f.txt 2>/dev/null; echo done", { cwd: work, roots: [work, inner], home });
    expect(r.out).toContain("done");
    expect(existsSync(join(inner, "f.txt"))).toBe(false);
    expect([...(r.notWritable ?? [])].sort()).toEqual([inner, work].sort());
  });
});

describe("a repository and the run-later names a command makes itself (Linux): what stays, what is moved aside, what it is told", () => {
  const GIT = "git -c user.email=t@example.invalid -c user.name=t";
  linuxTest("a host that denies every .git: a command's git init ends with the whole new .git moved aside, its files kept, the line said", async () => {
    const home = temp("sbx-git-init-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const r = await hostRun(`mkdir proj && cd proj && git init -q && echo a > f && git add f && ${GIT} commit -qm one && echo done`, { cwd: work, roots: [work], home, sweep: [work] });
    expect(r.out).toContain("done");
    expect(existsSync(join(work, "proj", ".git"))).toBe(false);
    expect(readFileSync(join(work, "proj", "f"), "utf8")).toBe("a\n");
    expect(r.quarantined).toContain(join(work, "proj", ".git"));
    expect(r.note).toContain(`[sandbox] ${join(work, "proj", ".git")}: moved to`);
    // Said outside the command's own output, never in it.
    expect(r.err).not.toContain(": moved to");
  });

  linuxTest("a host that denies only .git/hooks: the hooks are moved aside (and the runtime's own .git/config deny), the files stay", async () => {
    const home = temp("sbx-git-hooks-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const settings: SandboxSettings = { filesystem: { allowWrite: [work], denyWrite: ["/**/.git/hooks"] } };
    const r = await hostRun(`mkdir proj && cd proj && git init -q && echo a > f && git add f && ${GIT} commit -qm one && echo done`, { cwd: work, roots: [work], home, settings, sweep: [work] });
    expect(r.out).toContain("done");
    expect(existsSync(join(work, "proj", ".git", "hooks"))).toBe(false);
    // The runtime denies `.git/config` at any depth (as macOS refuses writing it): a new one is moved aside too.
    expect(r.quarantined?.sort()).toEqual([join(work, "proj", ".git", "config"), join(work, "proj", ".git", "hooks")].sort());
    expect(existsSync(join(work, "proj", ".git", "objects"))).toBe(true);
    expect(readFileSync(join(work, "proj", "f"), "utf8")).toBe("a\n");
  });

  linuxTest("a new .husky, .envrc and .mcp.json: each moved aside whole at the end, one line each; the runtime's own .vscode stays held", async () => {
    const home = temp("sbx-runlater-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const settings: SandboxSettings = { filesystem: { allowWrite: [work], denyWrite: [...HELD, "/**/.mcp.json"] } };
    const r = await hostRun("mkdir -p .husky && echo x > .husky/pre-commit; echo x > .envrc; echo {} > .mcp.json; mkdir -p .vscode && echo {} > .vscode/tasks.json; echo kept > notes.txt; echo done", { cwd: work, roots: [work], home, settings, sweep: [work] });
    expect(r.out).toContain("done");
    for (const name of [".husky", ".envrc", ".mcp.json"]) {
      expect([name, existsSync(join(work, name))]).toEqual([name, false]);
      expect(r.note).toContain(`[sandbox] ${join(work, name)}: moved to`);
    }
    // `.vscode` at the working folder is one of the runtime's own protected folders: made before the run and mounted
    // read-only, so nothing could be written in it.
    expect(r.err).toContain(".vscode/tasks.json: Read-only file system");
    expect(existsSync(join(work, ".vscode", "tasks.json"))).toBe(false);
    expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("kept\n");
  });

  linuxTest("NOT swept (a local bot's Bash, the default): a new repository stays, as in 0.0.90", async () => {
    const home = temp("sbx-nosweep-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const r = await hostRun("mkdir -p sub/.husky && echo x > sub/.husky/pre-commit && echo done", { cwd: work, roots: [work], home });
    expect(r.out).toContain("done");
    expect(existsSync(join(work, "sub", ".husky", "pre-commit"))).toBe(true);
    expect(r.quarantined).toBeUndefined();
    expect(r.unswept).toBeUndefined();
  });

  linuxTest("a repository the PERSON makes outside the swept roots while a command runs is untouched", async () => {
    const home = temp("sbx-person-");
    const work = join(home, "work");
    const other = join(home, "other");
    mkdirSync(work, { recursive: true });
    mkdirSync(other, { recursive: true });
    const run = hostRun("sleep 1; echo done", { cwd: work, roots: [work, other], home, sweep: [work] });
    await Bun.sleep(300);
    mkdirSync(join(other, "repo", ".git", "hooks"), { recursive: true });
    writeFileSync(join(other, "repo", ".git", "hooks", "pre-commit"), "mine\n");
    const r = await run;
    expect(r.out).toContain("done");
    expect(readFileSync(join(other, "repo", ".git", "hooks", "pre-commit"), "utf8")).toBe("mine\n");
    expect(r.quarantined ?? []).toEqual([]);
  });

  linuxTest("chmod 111 after git init, and a 17-deep folder beside a plant: both found and moved, nothing unswept", async () => {
    const home = temp("sbx-hide-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const deep = Array.from({ length: 17 }, (_, i) => `d${i}`).join("/");
    const r = await hostRun(`git init -q sub && chmod 111 sub; mkdir -p ${deep} z/.husky && echo x > z/.husky/pre-commit; echo done`, { cwd: work, roots: [work], home, sweep: [work] });
    expect(r.out).toContain("done");
    expect(r.quarantined?.sort()).toEqual([join(work, "sub", ".git"), join(work, "z", ".husky")].sort());
    expect(r.unswept).toBeUndefined();
    spawnSync("chmod", ["-R", "u+rwx", work]);
  });

  linuxTest("a newline in a folder's name: the path is moved, and its note line escaped", async () => {
    const home = temp("sbx-newline-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const r = await hostRun("mkdir -p \"$(printf 'a\\nb')/.husky\" && echo done", { cwd: work, roots: [work], home, sweep: [work] });
    expect(r.out).toContain("done");
    expect(r.quarantined).toEqual([join(work, "a\nb", ".husky")]);
    expect(r.note.split("\n").length).toBe(1);
    expect(r.note).toContain("a\\u000ab/.husky");
  });

  linuxTest("a held stow link (.envrc → a file elsewhere) replaced by the command: moved aside at the end, its target untouched", async () => {
    const home = temp("sbx-link-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(home, "real-envrc"), "mine\n");
    symlinkSync(join(home, "real-envrc"), join(work, ".envrc"));
    const r = await hostRun("rm .envrc && echo PLANTED > .envrc; echo done", { cwd: work, roots: [work], home });
    expect(r.out).toContain("done");
    expect(r.quarantined).toEqual([join(work, ".envrc")]);
    expect(existsSync(join(work, ".envrc"))).toBe(false);
    expect(readFileSync(join(home, "real-envrc"), "utf8")).toBe("mine\n");
  });
});
