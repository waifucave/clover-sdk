// The Windows half of the file rules: the shapes `path.relative` gives there, the canonical (long-name) spelling, network and device paths, and the real
// junction. Everything but the last test runs on any OS (the platform and the lookup are injected); the ci.yml job `windows-runtime-start` runs this
// file on a real Windows runner too (the main test file is written for Unix paths).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  FileRuleCompileError,
  WindowsPathNotJudgeable,
  canonicalWindowsPath,
  isNetworkOrDevicePath,
  isOutsideIgnoreRoot,
  matchFileRulesGrouped,
  windowsLongForm,
  type FileRuleCandidate,
} from "./file-rules.ts";

describe("isOutsideIgnoreRoot (the shapes Windows' path.relative gives)", () => {
  // `ignore` (on Windows) throws RangeError for each of these; a group the path lies outside of must skip it, not deny the call.
  const shapes: Record<string, string> = {
    "an 8.3 short name against the long root": "..\\..\\..\\..\\..\\RUNNER~1\\AppData\\Local\\Temp\\x\\a.txt",
    "another drive": "D:\\a\\b.txt",
    "another drive, forward slashes": "D:/a/b.txt",
    "a sibling folder": "..\\q\\a.txt",
    "the current folder spelled out": ".\\a.txt",
    "a UNC share": "\\\\server\\share\\a.txt",
  };
  for (const [name, rel] of Object.entries(shapes)) {
    test(`${name} is outside on Windows`, () => expect(isOutsideIgnoreRoot(rel, true)).toBe(true));
  }
  test("a file inside the root is not outside, on Windows or elsewhere", () => {
    expect(isOutsideIgnoreRoot("sub\\a.txt", true)).toBe(false);
    expect(isOutsideIgnoreRoot("a.txt", true)).toBe(false);
    expect(isOutsideIgnoreRoot("..x\\evil.sh", true)).toBe(false);
  });
  test("off Windows a backslash or a colon is a file-name character: nothing there is outside", () => {
    for (const rel of ["..\\q\\a.txt", "D:\\a\\b.txt", "D:/a/b.txt", "\\\\x", ".\\a"]) expect(isOutsideIgnoreRoot(rel, false)).toBe(false);
    expect(isOutsideIgnoreRoot("../a", false)).toBe(true);
  });
});

describe("canonicalWindowsPath", () => {
  // A fake file system: the folder exists under its long name, and the short name resolves to it.
  const longDir = "C:\\Users\\runneradmin\\Temp\\x";
  const real = (p: string): string => {
    const q = p.replace("RUNNER~1", "runneradmin");
    if (q.toLowerCase() === longDir.toLowerCase()) return longDir;
    if (q.toLowerCase() === "c:\\users\\runneradmin\\temp") return "C:\\Users\\runneradmin\\Temp";
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  test("a short name is expanded through the nearest existing parent, a file not there yet keeps its own name", () => {
    expect(canonicalWindowsPath("C:\\Users\\RUNNER~1\\Temp\\x\\new.txt", real)).toBe("C:\\Users\\runneradmin\\Temp\\x\\new.txt");
  });
  test("nothing of it existing leaves it as it is", () => {
    expect(canonicalWindowsPath("Z:\\none\\a.txt", () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })).toBe("Z:\\none\\a.txt");
  });
});

// The Windows branch of `matchFileRulesGrouped` itself, with the platform and the canonical lookup injected (it runs on any OS; the real junction test below runs only on Windows).
describe("matchFileRulesGrouped on Windows", () => {
  const ROOT = "C:\\root";
  const win = (canonical: (p: string) => string = (p) => p) => ({ cwd: ROOT, home: "C:\\Users\\me", windows: true, canonical });
  const one = (pattern: string): FileRuleCandidate<{ pattern: string }>[] => [{ entry: { pattern }, pattern }];

  test("a deny on a link INSIDE the root still holds when the link's target is elsewhere (the given spelling is matched too)", () => {
    const canonical = (p: string) => p.replace("C:\\root\\.claude", "D:\\dotfiles\\claude");
    expect(matchFileRulesGrouped(one(".claude/**"), "C:\\root\\.claude\\settings.json", win(canonical), "denyAsk")).not.toBeNull();
  });

  test("an 8.3 spelling of the root's own folder is inside it once both are canonical, so the rule applies", () => {
    const canonical = (p: string) => p.replace("RUNNER~1", "runneradmin");
    const opts = { cwd: "C:\\Users\\runneradmin\\x", home: "C:\\Users\\me", windows: true, canonical };
    expect(matchFileRulesGrouped(one("*.txt"), "C:\\Users\\RUNNER~1\\x\\a.txt", opts, "denyAsk")).not.toBeNull();
  });

  test("a path on another drive or in a sibling folder is outside the group: no match, and no error", () => {
    expect(matchFileRulesGrouped(one("*.txt"), "D:\\a\\b.txt", win(), "denyAsk")).toBeNull();
    expect(matchFileRulesGrouped(one("*.txt"), "C:\\other\\b.txt", win(), "denyAsk")).toBeNull();
  });

  test("a rule still matches a plain path inside the root", () => {
    expect(matchFileRulesGrouped(one("*.txt"), "C:\\root\\sub\\b.txt", win(), "denyAsk")).not.toBeNull();
    expect(matchFileRulesGrouped(one("*.md"), "C:\\root\\sub\\b.txt", win(), "denyAsk")).toBeNull();
  });

  test("the \\\\?\\ and \\\\.\\ spellings of a drive path fold to the drive and are judged like it", () => {
    expect(windowsLongForm("\\\\?\\C:\\root\\a.txt")).toBe("C:\\root\\a.txt");
    expect(windowsLongForm("\\\\.\\C:\\root\\a.txt")).toBe("C:\\root\\a.txt");
    expect(windowsLongForm("\\\\?\\UNC\\server\\share\\a")).toBe("\\\\server\\share\\a");
    expect(matchFileRulesGrouped(one("*.txt"), "\\\\?\\C:\\root\\a.txt", win(), "denyAsk")).not.toBeNull();
    expect(matchFileRulesGrouped(one("*.txt"), "\\\\.\\C:\\root\\a.txt", win(), "denyAsk")).not.toBeNull();
  });

  for (const path of ["\\\\localhost\\C$\\Users\\me\\.ssh\\id_rsa", "\\\\127.0.0.1\\C$\\x", "\\\\?\\UNC\\server\\share\\a", "\\\\.\\pipe\\x", "\\\\?\\Volume{1}\\x", "//localhost/C$/x"]) {
    test(`a network or device path (${path}) fails closed with its own reason, never skipped`, () => {
      expect(isNetworkOrDevicePath(path)).toBe(true);
      expect(() => matchFileRulesGrouped(one("*.txt"), path, win(), "denyAsk")).toThrow(WindowsPathNotJudgeable);
      expect(() => matchFileRulesGrouped(one("*.txt"), path, win(), "allow")).toThrow(FileRuleCompileError);
    });
  }

  test("a lookup that fails for any reason but 'not there' fails the check (the caller denies), and 'not there' climbs", () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => canonicalWindowsPath("C:\\a\\b", () => { throw eacces; })).toThrow(eacces);
    const enotdir = Object.assign(new Error("x"), { code: "ENOTDIR" });
    expect(canonicalWindowsPath("C:\\a\\b", (p) => { if (p === "C:\\a") return "C:\\A"; throw enotdir; })).toBe("C:\\A\\b");
    expect(() => matchFileRulesGrouped(one("*.txt"), "C:\\root\\a.txt", win(() => { throw eacces; }), "denyAsk")).toThrow(eacces);
  });

  // The real thing, on the Windows runner only: a junction inside the root to a folder elsewhere.
  test.skipIf(process.platform !== "win32")("a real junction inside the root: the deny on its path still holds", () => {
    const { mkdtempSync, mkdirSync, realpathSync: rp, rmSync: rm, writeFileSync: wf } = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const base = rp.native(mkdtempSync(join(require("node:os").tmpdir(), "rules-junction-")));
    try {
      mkdirSync(join(base, "root"), { recursive: true });
      mkdirSync(join(base, "elsewhere"), { recursive: true });
      wf(join(base, "elsewhere", "settings.json"), "{}");
      expect(spawnSync("cmd.exe", ["/c", "mklink", "/J", join(base, "root", ".claude"), join(base, "elsewhere")]).status).toBe(0);
      const opts = { cwd: join(base, "root"), home: base };
      expect(matchFileRulesGrouped(one(".claude/**"), join(base, "root", ".claude", "settings.json"), opts, "denyAsk")).not.toBeNull();
      // and the 8.3 spelling of the temp folder (when it has one) is still inside the root it names
      expect(matchFileRulesGrouped(one("*.json"), join(require("node:os").tmpdir(), base.slice(base.indexOf("rules-junction-")), "root", "x.json"), opts, "denyAsk")).not.toBeNull();
    } finally { rm(base, { recursive: true, force: true }); }
  });
});
