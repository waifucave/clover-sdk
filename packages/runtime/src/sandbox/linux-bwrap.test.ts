// The Linux sandbox's pure half (linux-bwrap.ts, profile.ts's `linuxSandboxListsFor`), on every OS: the bubblewrap
// arguments a policy becomes, the seccomp filter's bytes, and the paths the Seatbelt profile's policy maps to. The
// real runs are linux-bwrap.linux.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BWRAP_SYSTEM_PATHS, buildBwrapPlan, expandPatterns, expandPatternsChecked, findBwrap, perCommandExpander, LINUX_UNSET_ENV, SECCOMP_FD, unixSocketFilter, type BwrapFs } from "./linux-bwrap.ts";
import { linuxSandboxListsFor } from "./profile.ts";

/** A disk from a list of folders and files. */
function fakeFs(dirs: readonly string[], files: readonly string[] = []): BwrapFs {
  const d = new Set(dirs), f = new Set(files);
  return {
    kind: (p) => (d.has(p) ? "dir" : f.has(p) ? "file" : null),
    list: (dir) => [...d, ...f].filter((p) => p !== dir && p.startsWith(`${dir === "/" ? "" : dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
  };
}

/** The pairs `flag a b` in `args` (`--bind x x`, `--ro-bind x x`), as "flag a" strings for order checks. */
const pairs = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe("unixSocketFilter (lane C's filter)", () => {
  test("ten instructions for x64 and arm64, each architecture's audit value and socket number; none elsewhere", () => {
    const x64 = unixSocketFilter("x64")!, arm = unixSocketFilter("arm64")!;
    expect(x64.length).toBe(80);
    expect(arm.length).toBe(80);
    expect(x64.readUInt32LE(8 + 4)).toBe(0xc000003e);
    expect(arm.readUInt32LE(8 + 4)).toBe(0xc00000b7);
    expect(x64.readUInt32LE(5 * 8 + 4)).toBe(41);
    expect(arm.readUInt32LE(5 * 8 + 4)).toBe(198);
    // The last two: allow, then EPERM.
    expect(x64.readUInt32LE(8 * 8 + 4)).toBe(0x7fff0000);
    expect(x64.readUInt32LE(9 * 8 + 4)).toBe(0x00050001);
    expect(unixSocketFilter("ia32")).toBeNull();
  });
});

describe("findBwrap", () => {
  test("system paths only, in order; never PATH", () => {
    expect(BWRAP_SYSTEM_PATHS).toEqual(["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]);
    expect(findBwrap((p) => p === "/usr/local/bin/bwrap")).toBe("/usr/local/bin/bwrap");
    expect(findBwrap((p) => p === "/home/u/bin/bwrap")).toBeUndefined();
  });
});

describe("buildBwrapPlan", () => {
  const base = { allowNetwork: false, disableUserns: true, seccomp: true, hidden: [] as string[] };

  test("the base: namespaces, no capabilities, the root read-only, roots writable, the env and the seccomp fd", () => {
    const fs = fakeFs(["/", "/w", "/run/user", "/mnt"]);
    const { args } = buildBwrapPlan({ ...base, hidden: ["/run/user", "/media", "/mnt"], writableRoots: ["/w", "/gone"], denyWrite: [], denyRead: [], cwd: "/w", fs });
    expect(args.slice(0, 11)).toEqual(["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--unshare-user", "--disable-userns", "--unshare-net", "--cap-drop", "ALL"]);
    expect(args.join(" ")).toContain("--ro-bind / / --dev /dev --proc /proc --tmpfs /run/user --tmpfs /mnt --bind /w /w");
    expect(pairs(args, "--bind")).toEqual(["/w"]); // a root that isn't there isn't bound
    for (const v of LINUX_UNSET_ENV) expect(args.join(" ")).toContain(`--unsetenv ${v}`);
    expect(args.slice(-4)).toEqual(["--chdir", "/w", "--seccomp", String(SECCOMP_FD)]);
  });

  test("network allowed: no --unshare-net (the seccomp filter stays); an old bwrap: no user-namespace flags", () => {
    const { args } = buildBwrapPlan({ ...base, allowNetwork: true, disableUserns: false, writableRoots: ["/w"], denyWrite: [], denyRead: [], cwd: "/w", fs: fakeFs(["/w"]) });
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--disable-userns");
    expect(args).not.toContain("--unshare-user");
    expect(args).toContain("--seccomp");
  });

  test("an existing denied path is bound read-only again, its folders up to the root are mount points (the rename fence)", () => {
    const fs = fakeFs(["/w", "/w/a", "/w/a/b", "/w/a/b/.git", "/w/a/b/.git/hooks"]);
    const { args, held } = buildBwrapPlan({ ...base, writableRoots: ["/w"], denyWrite: ["/w/a/b/.git/hooks", "/elsewhere/x"], denyRead: [], cwd: "/w", fs });
    expect(pairs(args, "--ro-bind")).toEqual(["/", "/w/a/b/.git/hooks"]);
    expect(pairs(args, "--bind")).toEqual(["/w", "/w/a", "/w/a/b", "/w/a/b/.git"]);
    expect(held).toEqual([]);
    // The holders come before the read-only bind, deepest last.
    expect(args.lastIndexOf("/w/a/b/.git/hooks")).toBeGreaterThan(args.lastIndexOf("/w/a/b/.git"));
  });

  // The plan alone leaves a missing path directly in a root or in `.git` unheld; the spawn closes that (#74's review
  // B1): it makes the protected folders before the run, and moves aside at the command's end what appeared at the rest
  // (linux-protected.test.ts, and the live cases in linux-bwrap.linux.test.ts).
  test("a missing denied path holds its nearest folder inside a root (read-only, present children writable), never the root or .git", () => {
    const fs = fakeFs(["/w", "/w/proj", "/w/proj/.clover", "/w/proj/src", "/w/.git"], ["/w/proj/.clover/other.json"]);
    const { args, held, unheld } = buildBwrapPlan({
      ...base, writableRoots: ["/w"], cwd: "/w", fs, denyRead: [],
      denyWrite: ["/w/proj/.clover/settings.json", "/w/.vscode", "/w/.git/hooks"],
    });
    expect(held).toEqual([{ folder: "/w/proj/.clover", because: "/w/proj/.clover/settings.json" }]);
    expect(unheld.sort()).toEqual(["/w/.git/hooks", "/w/.vscode"]);
    expect(pairs(args, "--ro-bind")).toContain("/w/proj/.clover");
    expect(pairs(args, "--bind")).toContain("/w/proj/.clover/other.json");
    expect(pairs(args, "--ro-bind")).not.toContain("/w");
    expect(pairs(args, "--ro-bind")).not.toContain("/w/.git");
  });

  test("read denies: an empty tmpfs over a folder, /dev/null over a file, after every bind; a root inside one is bound back", () => {
    const fs = fakeFs(["/w", "/h", "/h/.clover", "/h/.clover/run", "/h/.clover/run/s"], ["/w/.env"]);
    const { args } = buildBwrapPlan({ ...base, writableRoots: ["/w", "/h/.clover/run/s"], denyWrite: [], denyRead: ["/h/.clover/run", "/w/.env", "/missing"], cwd: "/w", fs });
    const s = args.join(" ");
    expect(s).toContain("--tmpfs /h/.clover/run --bind /h/.clover/run/s /h/.clover/run/s");
    expect(s).toContain("--ro-bind /dev/null /w/.env");
    expect(s).not.toContain("/missing");
    expect(args.indexOf("/h/.clover/run")).toBeGreaterThan(args.indexOf("/w"));
  });
});

describe("expandPatterns", () => {
  test("one walk for every pattern, node_modules skipped, a matched folder not walked into, bounded", () => {
    const fs = fakeFs(["/r", "/r/a", "/r/a/.git", "/r/a/.git/hooks", "/r/node_modules", "/r/node_modules/x", "/r/node_modules/x/.git", "/r/b"], ["/r/b/.env", "/r/a/.git/hooks/pre-commit"]);
    const [hooks, envs] = expandPatterns("/r", [/\/\.git\/hooks(\/.*)?$/, /\/\.env$/], { fs });
    expect(hooks).toEqual(["/r/a/.git/hooks"]);
    expect(envs).toEqual(["/r/b/.env"]);
    const capped = expandPatterns("/r", [/\.env$/], { fs, maxVisited: 2 });
    expect(capped[0]).toEqual([]);
  });

  test("checked: a walk stopped at its limits says so; node_modules is walked for the patterns, within its own budget", () => {
    const fs = fakeFs(["/r", "/r/node_modules", "/r/node_modules/p", "/r/node_modules/p/.git", "/r/node_modules/p/.git/hooks", "/r/a", "/r/a/b", "/r/a/b/c"]);
    const hooks = /\/\.git\/hooks(\/.*)?$/;
    const all = expandPatternsChecked("/r", [hooks], { fs });
    expect(all).toMatchObject({ found: [["/r/node_modules/p/.git/hooks"]], complete: true });
    expect(expandPatternsChecked("/r", [hooks], { fs, maxVisited: 1 }).complete).toBe(false);
    expect(expandPatternsChecked("/r", [hooks], { fs, maxDepth: 1 }).complete).toBe(false);
    expect(expandPatternsChecked("/r", [hooks], { fs, maxSkippedVisited: 1 }).complete).toBe(false);
  });
});

describe("a pnpm-shaped project, on a real disk: the project stays writable, the walk is quick", () => {
  test.skipIf(process.platform === "win32")("nested .pnpm/<pkg>/node_modules/<dep> trees far past 16 levels keep the project root; a repo in them is found", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pnpm-shape-")));
    try {
      const proj = join(root, "app");
      mkdirSync(join(proj, "src"), { recursive: true });
      // 40 packages, each nesting 30 levels of node_modules/<dep>, as pnpm's store links lay them out.
      for (let p = 0; p < 40; p++) {
        let at = join(proj, "node_modules", ".pnpm", `pkg${p}@1.0.0`, "node_modules", `pkg${p}`);
        for (let d = 0; d < 30; d++) at = join(at, "node_modules", `dep${d}`);
        mkdirSync(at, { recursive: true });
        writeFileSync(join(at, "index.js"), "x");
      }
      const start = Date.now();
      const lists = linuxSandboxListsFor({ cwd: proj, writableRoots: [proj] } as Parameters<typeof linuxSandboxListsFor>[0], perCommandExpander());
      const ms = Date.now() - start;
      expect(lists.writableRoots).toContain(proj);
      expect(lists.notHeld).toBeUndefined();
      expect(ms).toBeLessThan(5_000);
      // A package from git deep in the tree: its .git hooks are held (a deny), and the project still writable.
      const deep = join(proj, "node_modules", ".pnpm", "pkg7@1.0.0", "node_modules", "pkg7", "node_modules", "dep0", "node_modules", "dep1");
      mkdirSync(join(deep, ".git", "hooks"), { recursive: true });
      const again = linuxSandboxListsFor({ cwd: proj, writableRoots: [proj] } as Parameters<typeof linuxSandboxListsFor>[0], perCommandExpander());
      expect(again.writableRoots).toContain(proj);
      expect(again.denyWrite).toContain(join(deep, ".git", "hooks"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one command's budget across every prefix: the working folder's walk first, the rest fail closed once it is spent", () => {
    const fs = fakeFs(["/w", "/w/a", "/big", "/big/x", "/other"], ["/w/a/f", "/big/x/1", "/big/x/2", "/big/x/3"]);
    let t = 0;
    const lists = linuxSandboxListsFor({ cwd: "/w", writableRoots: ["/big", "/w", "/other"] } as Parameters<typeof linuxSandboxListsFor>[0], perCommandExpander({ fs, budget: { maxVisited: 4, maxMs: 10_000 }, now: () => t }));
    expect(lists.writableRoots).toContain("/w");
    expect(lists.writableRoots).not.toContain("/big");
    const timed = perCommandExpander({ fs, budget: { maxVisited: 1_000, maxMs: 5 }, now: () => (t += 10) });
    expect(timed("/w", [/x/]).complete).toBe(false);
  });
});

describe("linuxSandboxListsFor: a walk that can't finish (fails closed)", () => {
  test("the root it covers isn't a writable root, and says so", () => {
    const lists = linuxSandboxListsFor({ cwd: "/w", writableRoots: ["/w", "/big"] } as Parameters<typeof linuxSandboxListsFor>[0], (prefix, regexes) => ({ found: regexes.map(() => []), complete: prefix !== "/big" }));
    expect(lists.writableRoots).toEqual(["/w"]);
    expect(lists.notHeld).toEqual([{ root: "/big", prefix: "/big" }]);
    const fine = linuxSandboxListsFor({ cwd: "/w", writableRoots: ["/w"] } as Parameters<typeof linuxSandboxListsFor>[0], (_p, regexes) => regexes.map(() => []));
    expect(fine.notHeld).toBeUndefined();
  });
});

describe("linuxSandboxListsFor (the Seatbelt profile's policy as paths)", () => {
  test("the roots, the user's denies, the defaults, the control plane, the home floor, run/ and the provider state", () => {
    const asked: { prefix: string; n: number }[] = [];
    const lists = linuxSandboxListsFor({
      cwd: "/nonexistent-w", writableRoots: ["/nonexistent-t"], denyWritePaths: ["/nonexistent-w/secret"], denyReadPaths: ["/nonexistent-h/.ssh"],
      denyWriteRegexes: ["^/nonexistent-w/(.*/)?\\.env$"], allowNetwork: false, home: "/nonexistent-h", winterHome: "/nonexistent-h/.winter/sdk",
    }, (prefix, regexes) => {
      asked.push({ prefix, n: regexes.length });
      return regexes.map((re) => (prefix === "/nonexistent-w" && re.test("/nonexistent-w/sub/.env") ? ["/nonexistent-w/sub/.env"] : []));
    });
    expect(lists.writableRoots).toEqual(["/nonexistent-w", "/nonexistent-t"]);
    for (const p of [
      "/nonexistent-w/secret", "/nonexistent-w/sub/.env", "/nonexistent-w/.git/hooks", "/nonexistent-w/.git/config", "/nonexistent-w/.zshrc", "/nonexistent-w/.vscode",
      "/nonexistent-w/.winter/settings.json", "/nonexistent-t/.winter/settings.local.json", "/nonexistent-w/.winter/permissions.local.json",
      "/nonexistent-h/.winter/sdk/settings.json", "/nonexistent-h/.winter/sdk/agents", "/nonexistent-h/.winter/sdk/plugins", "/nonexistent-h/.winter/file-history", "/nonexistent-h/.winter/image-prep",
    ]) expect([p, lists.denyWrite.includes(p)]).toEqual([p, true]);
    for (const p of ["/nonexistent-h/.ssh", "/nonexistent-h/.winter/run", "/nonexistent-h/.winter/sdk/run"]) expect([p, lists.denyRead.includes(p)]).toEqual([p, true]);
    // Each prefix walked once, for all of its patterns.
    expect(asked.filter((a) => a.prefix === "/nonexistent-w")).toHaveLength(1);
    expect(asked.find((a) => a.prefix === "/nonexistent-w")!.n).toBeGreaterThan(10);
    expect(asked.some((a) => a.prefix === "/nonexistent-h/.winter/projects")).toBe(true);
  });

  test("allowGitConfigWrites leaves .git/config writable; every other protection stays", () => {
    const lists = linuxSandboxListsFor({ cwd: "/nonexistent-w", allowNetwork: false, allowGitConfigWrites: true }, (_p, r) => r.map(() => []));
    expect(lists.denyWrite).not.toContain("/nonexistent-w/.git/config");
    expect(lists.denyWrite).toContain("/nonexistent-w/.git/hooks");
  });
});
