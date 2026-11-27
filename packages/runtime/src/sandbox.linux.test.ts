// The public `./sandbox` entry (sandbox.ts), as a host uses it: its own `SandboxSettings` turned into run inputs by
// `buildHostSandboxRunInputs` (the deny globs split the way a session's Bash splits them), then `runCommand`. On Linux
// under real bubblewrap, with a host's held-names list (`/**/<name>` globs): a repository's `.git` held against the
// rename (`mv proj proj-old && mkdir -p proj/.git/hooks …`), a hook planted in a new repository moved aside at the
// command's end, nothing written outside the roots, and no network. Every Linux case is `test.skipIf`, per this
// codebase's convention; CI's WINTER_REQUIRE_LINUX_SANDBOX=1 turns "no bubblewrap here" into a failure.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

/** A host's held names, as MOSS draws them for a command's folder on Linux (one `/**` pattern per name). */
const HELD = ["/**/*.git", "/**/.husky", "/**/.githooks", "/**/.envrc", "/**/.vscode"];

/** A command as a host runs it: its settings, its roots, the entry's own input builder. The working folder is one of
 *  the roots (the runtime makes it writable). */
async function hostRun(command: string, o: { cwd: string; roots: string[]; home: string; settings?: SandboxSettings }) {
  const settings: SandboxSettings = o.settings ?? { filesystem: { allowWrite: o.roots, denyWrite: HELD } };
  const inputs = buildHostSandboxRunInputs({ cwd: o.cwd, env: { ...process.env, TMPDIR: o.roots[0]! }, settings, writableRoots: o.roots, home: o.home });
  let out = "", err = "";
  const r = await runCommand({ ...inputs, command, timeoutMs: 30_000, onStdout: (c) => { out += c.toString(); }, onStderr: (c) => { err += c.toString(); } });
  // It ran sandboxed, never plain.
  expect(r.posture).toBe("sandboxed");
  return { ...r, out, err };
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
    for (const name of ["runCommand", "linuxSandboxReady", "commandSandboxAvailable", "isSandboxAvailable", "sweepLinuxRuns", "buildHostSandboxRunInputs", "computeDenyPaths", "splitDenyPathsByGlobShape", "globDenyEntriesOf", "sandboxUnavailableMessage"]) {
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

  linuxTest("a hook planted in a new repository is moved aside at the command's end; an ordinary file stays", async () => {
    const home = temp("sbx-entry-plant-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const cmd = "mkdir -p sub/.git/hooks && echo PLANTED > sub/.git/hooks/post-checkout; mkdir -p sub/.husky && echo PLANTED > sub/.husky/pre-commit; echo kept > sub/notes.txt; echo done";
    const r = await hostRun(cmd, { cwd: work, roots: [work], home });
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

describe("a repository and the run-later names a command makes itself (Linux): what stays, what is moved aside, what it is told", () => {
  const GIT = "git -c user.email=t@example.invalid -c user.name=t";
  linuxTest("git init, add, commit: the repository works in the next command; its hooks and config were moved aside, and said", async () => {
    const home = temp("sbx-git-init-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const r = await hostRun(`mkdir proj && cd proj && git init -q && echo a > f && git add f && ${GIT} commit -qm one && echo done`, { cwd: work, roots: [work], home });
    expect(r.out).toContain("done");
    expect(existsSync(join(work, "proj", ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(work, "proj", ".git", "hooks"))).toBe(false);
    expect(existsSync(join(work, "proj", ".git", "config"))).toBe(false);
    expect(r.err).toContain(`[sandbox] ${join(work, "proj", ".git", "hooks")}: moved to`);
    expect(r.err).toContain(`[sandbox] ${join(work, "proj", ".git", "config")}: moved to`);
    const next = await hostRun("cd proj && git status --short && git log --oneline | wc -l", { cwd: work, roots: [work], home });
    expect(next.exitCode).toBe(0);
    expect(next.out.trim()).toBe("1");
  });

  linuxTest("git clone of a local bare repository: git log works in the next command; hooks and config moved aside", async () => {
    const home = temp("sbx-git-clone-");
    const work = join(home, "work");
    const src = join(home, "src");
    mkdirSync(work, { recursive: true });
    expect(spawnSync("bash", ["-c", `git init -q --bare ${JSON.stringify(join(src, "b.git"))} && git init -q ${JSON.stringify(join(src, "w"))} && cd ${JSON.stringify(join(src, "w"))} && echo a > f && git add f && ${GIT} commit -qm one && git push -q ${JSON.stringify(join(src, "b.git"))} HEAD:main`]).status).toBe(0);
    const r = await hostRun(`git clone -q ${JSON.stringify(join(src, "b.git"))} x && echo done`, { cwd: work, roots: [work], home });
    expect(r.out).toContain("done");
    expect(existsSync(join(work, "x", "f"))).toBe(true);
    expect(existsSync(join(work, "x", ".git", "hooks"))).toBe(false);
    const next = await hostRun("cd x && git log --oneline | wc -l", { cwd: work, roots: [work], home });
    expect(next.out.trim()).toBe("1");
  });

  linuxTest("a new .husky, .envrc, .mcp.json and .vscode/tasks.json: each moved aside whole at the end, one line each", async () => {
    const home = temp("sbx-runlater-");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const settings: SandboxSettings = { filesystem: { allowWrite: [work], denyWrite: [...HELD, "/**/.mcp.json"] } };
    const r = await hostRun("mkdir -p .husky && echo x > .husky/pre-commit; echo x > .envrc; echo {} > .mcp.json; mkdir -p .vscode && echo {} > .vscode/tasks.json; echo kept > notes.txt; echo done", { cwd: work, roots: [work], home, settings });
    expect(r.out).toContain("done");
    for (const name of [".husky", ".envrc", ".mcp.json", ".vscode"]) {
      expect([name, existsSync(join(work, name))]).toEqual([name, false]);
      expect(r.err).toContain(`[sandbox] ${join(work, name)}: moved to`);
    }
    expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("kept\n");
  });
});
