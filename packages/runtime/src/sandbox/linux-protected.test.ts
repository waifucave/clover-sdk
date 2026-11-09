// #74's review B1/B2, the parts that need no Linux: `hostFenced` is honoured only once the process is verified to be
// confined (`judgeHostConfinement`), the folders made before a run (`linuxSandboxListsFor`'s `ensureFolders`), and the
// post-run quarantine that moves aside what a command made at a protected path, never following a link it planted.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeHostConfinement, quarantinePlanted } from "./spawn.ts";
import { linuxSandboxListsFor } from "./profile.ts";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

const confined = "Name:\tbun\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n";

describe("hostFenced is verified, never assumed (judgeHostConfinement)", () => {
  test("confined: no new privileges, a seccomp filter, and no user namespace", () => {
    expect(judgeHostConfinement({ status: confined, unshareExists: true, unshareStatus: () => 1 })).toEqual({ ok: true });
  });
  test("anything short of that refuses, with the reason", () => {
    const cases: [Parameters<typeof judgeHostConfinement>[0], RegExp][] = [
      [{ status: undefined, unshareExists: true, unshareStatus: () => 1 }, /can't be read/],
      [{ status: confined.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"), unshareExists: true, unshareStatus: () => 1 }, /NoNewPrivs/],
      [{ status: confined.replace("Seccomp:\t2", "Seccomp:\t0"), unshareExists: true, unshareStatus: () => 1 }, /Seccomp/],
      [{ status: confined, unshareExists: false, unshareStatus: () => 1 }, /unshare/],
      [{ status: confined, unshareExists: true, unshareStatus: () => 0 }, /user namespace/],
    ];
    for (const [facts, reason] of cases) {
      const v = judgeHostConfinement(facts);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(reason);
    }
  });
});

describe("the protected folders made before a run", () => {
  test("each root's project folder, the cwd's protected folders, and the cwd's .git/hooks", () => {
    const lists = linuxSandboxListsFor({ cwd: "/w/p", writableRoots: ["/t"], allowNetwork: false }, (_p, r) => r.map(() => []));
    expect(lists.ensureFolders.sort()).toEqual(["/t/.winter", "/w/p/.claude/agents", "/w/p/.claude/commands", "/w/p/.git/hooks", "/w/p/.idea", "/w/p/.vscode", "/w/p/.winter"].sort());
  });

  test("in the home itself, not the editors' or claude's folders (the end-of-run move covers them)", () => {
    const lists = linuxSandboxListsFor({ cwd: "/hh/u", home: "/hh/u", allowNetwork: false }, (_p, r) => r.map(() => []));
    expect(lists.ensureFolders.sort()).toEqual(["/hh/u/.git/hooks", "/hh/u/.winter", "/hh/u/.winter/quarantine", "/hh/u/.winter/sandbox-runs"]);
  });

  test("the sandbox's own bookkeeping (quarantine/, sandbox-runs/) is write-denied and made before the run (#74's review, check 3)", () => {
    const lists = linuxSandboxListsFor({ cwd: "/hh/u", home: "/hh/u", allowNetwork: false }, (_p, r) => r.map(() => []));
    expect(lists.denyWrite).toContain("/hh/u/.winter/quarantine");
    expect(lists.denyWrite).toContain("/hh/u/.winter/sandbox-runs");
  });
});

describe("quarantinePlanted: what a command made at a protected path is moved aside", () => {
  test("a planted file moves into the quarantine folder; a still-missing one is left alone", () => {
    const cwd = temp("clover-a3-q-"), q = join(temp("clover-a3-qh-"), "quarantine");
    writeFileSync(join(cwd, ".mcp.json"), "{}");
    const moved = quarantinePlanted([{ path: join(cwd, ".mcp.json"), anchor: cwd }, { path: join(cwd, ".bashrc"), anchor: cwd }], q);
    expect(moved).toEqual([join(cwd, ".mcp.json")]);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(readdirSync(q)).toHaveLength(1);
  });

  test("a link the command planted on the way moves itself, never what it points at", () => {
    const cwd = temp("clover-a3-q-"), outside = temp("clover-a3-qo-"), q = join(temp("clover-a3-qh-"), "quarantine");
    mkdirSync(join(outside, "commands"));
    writeFileSync(join(outside, "commands", "mine.md"), "the user's own");
    symlinkSync(outside, join(cwd, ".claude"));
    const moved = quarantinePlanted([{ path: join(cwd, ".claude", "commands"), anchor: cwd }], q);
    expect(moved).toEqual([join(cwd, ".claude")]);
    expect(existsSync(join(outside, "commands", "mine.md"))).toBe(true);
    expect(() => lstatSync(join(cwd, ".claude"))).toThrow();
  });

  test("with no quarantine folder a planted file is unlinked, and a folder with something in it is never deleted", () => {
    const cwd = temp("clover-a3-q-");
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    writeFileSync(join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh");
    writeFileSync(join(cwd, ".gitconfig"), "[x]");
    expect(quarantinePlanted([{ path: join(cwd, ".git", "hooks"), anchor: cwd }, { path: join(cwd, ".gitconfig"), anchor: cwd }], undefined)).toEqual([join(cwd, ".gitconfig")]);
    expect(existsSync(join(cwd, ".gitconfig"))).toBe(false);
    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(true);
  });
});
