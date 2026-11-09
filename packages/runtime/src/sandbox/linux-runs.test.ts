// The live sandboxed runs (linux-runs.ts, #74's review check 2): a run's record on disk from before its command starts,
// its end (plants moved aside, record gone, the folders made for it removed while empty and nothing else is live), the
// realm's sweep (a SIGTERM, SIGINT or embedded abort), and a crashed run finished by the next start. Plain files only:
// every OS runs these.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beginLinuxRun, quarantinePlanted, recoverCrashedLinuxRuns, resetLinuxRunsForTest, sweepLinuxRuns, type LinuxRunRoots, type RecoveryCheck } from "./linux-runs.ts";

const temps: string[] = [];
afterEach(() => {
  resetLinuxRunsForTest();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

function setup() {
  const cwd = temp("clover-a3-runs-cwd-"), home = temp("clover-a3-runs-home-");
  const quarantineRoot = join(home, "quarantine");
  const runsDir = join(home, "sandbox-runs");
  return { cwd, quarantineRoot, runsDir, unheld: [{ path: join(cwd, ".mcp.json"), anchor: cwd }] };
}
const records = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
function writeRecord(dir: string, name: string, run: object, mode = 0o600): void {
  writeFileSync(join(dir, name), JSON.stringify(run), { mode });
  chmodSync(join(dir, name), mode);
}
/** The recompute a spawn passes: the protected literals at a cwd (here, the few these tests use). */
const checkFor = (cwd: string) => (roots: LinuxRunRoots): RecoveryCheck | undefined => {
  if (roots.cwd !== cwd) return undefined;
  const folders = new Set([join(cwd, ".vscode"), join(cwd, ".claude", "commands")]);
  return { protectedPaths: new Set([join(cwd, ".mcp.json"), ...folders]), folders, roots: [cwd, ...roots.writableRoots] };
};

describe("live sandboxed runs", () => {
  test("a run's record is on disk before its command starts; its end moves the plant aside, drops the record, and removes the empty folders made for it", () => {
    const w = setup();
    mkdirSync(join(w.cwd, ".vscode"));
    mkdirSync(join(w.cwd, ".claude"));
    mkdirSync(join(w.cwd, ".claude", "commands"));
    const end = beginLinuxRun({ unheld: w.unheld, quarantineRoot: w.quarantineRoot, made: [join(w.cwd, ".vscode"), join(w.cwd, ".claude"), join(w.cwd, ".claude", "commands")] });
    expect(records(w.runsDir)).toHaveLength(1);
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(end()).toEqual([join(w.cwd, ".mcp.json")]);
    expect(existsSync(join(w.cwd, ".mcp.json"))).toBe(false);
    expect(records(w.runsDir)).toHaveLength(0);
    expect(existsSync(join(w.cwd, ".vscode"))).toBe(false);
    expect(existsSync(join(w.cwd, ".claude"))).toBe(false);
    expect(end()).toEqual([]); // once
  });

  test("a made folder that isn't empty stays; none is removed while another run is live", () => {
    const w = setup();
    mkdirSync(join(w.cwd, ".vscode"));
    mkdirSync(join(w.cwd, ".idea"));
    writeFileSync(join(w.cwd, ".idea", "kept.xml"), "x");
    const other = beginLinuxRun({ unheld: [], quarantineRoot: w.quarantineRoot, made: [] });
    const end = beginLinuxRun({ unheld: [], quarantineRoot: w.quarantineRoot, made: [join(w.cwd, ".vscode"), join(w.cwd, ".idea")] });
    end();
    expect(existsSync(join(w.cwd, ".vscode"))).toBe(true);
    other();
    const again = beginLinuxRun({ unheld: [], quarantineRoot: w.quarantineRoot, made: [join(w.cwd, ".vscode"), join(w.cwd, ".idea")] });
    again();
    expect(existsSync(join(w.cwd, ".vscode"))).toBe(false);
    expect(existsSync(join(w.cwd, ".idea", "kept.xml"))).toBe(true);
  });

  test("the sweep (SIGTERM, SIGINT, an embedded abort) moves every live run's plants aside at once and keeps the record for the next start", () => {
    const w = setup();
    const end = beginLinuxRun({ unheld: w.unheld, quarantineRoot: w.quarantineRoot, made: [] });
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(sweepLinuxRuns()).toEqual([join(w.cwd, ".mcp.json")]);
    expect(existsSync(join(w.cwd, ".mcp.json"))).toBe(false);
    expect(records(w.runsDir)).toHaveLength(1);
    expect(end()).toEqual([]); // swept: the late end does nothing
  });

  test("a run whose process died before its end is finished by the next start; a live process's record is left alone", () => {
    const w = setup();
    mkdirSync(w.runsDir, { recursive: true });
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid!;
    mkdirSync(join(w.cwd, ".vscode"));
    writeRecord(w.runsDir, `${dead}-0-dead.json`, { unheld: w.unheld, quarantineRoot: "/somewhere/else", made: [join(w.cwd, ".vscode")], roots: { cwd: w.cwd, writableRoots: [] } });
    writeRecord(w.runsDir, `${process.pid}-9-live.json`, { unheld: [], quarantineRoot: w.quarantineRoot, made: [], roots: { cwd: w.cwd, writableRoots: [] } });
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(recoverCrashedLinuxRuns(w.quarantineRoot, checkFor(w.cwd))).toEqual([join(w.cwd, ".mcp.json")]);
    expect(existsSync(join(w.cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(w.cwd, ".vscode"))).toBe(false);
    expect(records(w.runsDir)).toEqual([`${process.pid}-9-live.json`]);
    // The record's own quarantine folder is ignored: the current one is used.
    expect(readdirSync(w.quarantineRoot)).toHaveLength(1);
  });

  test("a forged record does nothing: a path that isn't protected under its roots, an anchor outside them, a link or a loose record", () => {
    const w = setup();
    mkdirSync(w.runsDir, { recursive: true });
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid!;
    const outside = temp("clover-a3-runs-outside-");
    writeFileSync(join(outside, "precious.txt"), "the user's");
    mkdirSync(join(outside, ".vscode"));
    writeFileSync(join(outside, ".vscode", "tasks.json"), "{}");
    const forged = [
      // not a protected path
      { unheld: [{ path: join(outside, "precious.txt"), anchor: outside }], roots: { cwd: w.cwd, writableRoots: [] } },
      // a protected name, but outside the record's roots' recomputed set
      { unheld: [{ path: join(outside, ".vscode"), anchor: outside }], roots: { cwd: w.cwd, writableRoots: [] } },
      // a protected path whose anchor is above every root
      { unheld: [{ path: join(w.cwd, ".mcp.json"), anchor: "/" }], roots: { cwd: w.cwd, writableRoots: [] } },
      // made folders that aren't the run's
      { unheld: [], made: [outside, "/tmp", join(outside, ".vscode")], roots: { cwd: w.cwd, writableRoots: [] } },
    ];
    forged.forEach((r, i) => writeRecord(w.runsDir, `${dead}-${i}-forged.json`, { quarantineRoot: outside, made: [], ...r }));
    // A loose (0644) record and a link as a record are skipped outright, and left.
    writeRecord(w.runsDir, `${dead}-8-loose.json`, { unheld: [{ path: join(w.cwd, ".mcp.json"), anchor: w.cwd }], made: [], quarantineRoot: w.quarantineRoot, roots: { cwd: w.cwd, writableRoots: [] } }, 0o644);
    writeRecord(outside, "target.json", { unheld: [{ path: join(w.cwd, ".mcp.json"), anchor: w.cwd }], made: [], quarantineRoot: w.quarantineRoot, roots: { cwd: w.cwd, writableRoots: [] } });
    symlinkSync(join(outside, "target.json"), join(w.runsDir, `${dead}-9-link.json`));
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(recoverCrashedLinuxRuns(w.quarantineRoot, checkFor(w.cwd))).toEqual([]);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("the user's");
    expect(existsSync(join(outside, ".vscode", "tasks.json"))).toBe(true);
    expect(existsSync(join(w.cwd, ".mcp.json"))).toBe(true);
    expect(records(w.runsDir).sort()).toEqual([`${dead}-8-loose.json`, `${dead}-9-link.json`]);
  });

  test("a link as the quarantine folder is refused: nothing goes through it, and a planted folder with something in it is never deleted", () => {
    const w = setup();
    const elsewhere = temp("clover-a3-runs-elsewhere-");
    symlinkSync(elsewhere, w.quarantineRoot);
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    mkdirSync(join(w.cwd, ".claude"));
    writeFileSync(join(w.cwd, ".claude", "kept.md"), "x");
    const moved = quarantinePlanted([{ path: join(w.cwd, ".mcp.json"), anchor: w.cwd }, { path: join(w.cwd, ".claude"), anchor: w.cwd }], w.quarantineRoot);
    expect(readdirSync(elsewhere)).toEqual([]);
    // The file is unlinked; the folder with something in it stays (never a recursive delete).
    expect(moved).toEqual([join(w.cwd, ".mcp.json")]);
    expect(existsSync(join(w.cwd, ".claude", "kept.md"))).toBe(true);
  });

  test.skipIf(process.platform !== "linux")("a reused pid doesn't hold a crashed run's record: the process start time must match too", () => {
    const w = setup();
    mkdirSync(w.runsDir, { recursive: true });
    writeRecord(w.runsDir, `${process.pid}-0-reused.json`, { unheld: w.unheld, quarantineRoot: w.quarantineRoot, made: [], roots: { cwd: w.cwd, writableRoots: [] }, pid: process.pid, start: "1" });
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(recoverCrashedLinuxRuns(w.quarantineRoot, checkFor(w.cwd))).toEqual([join(w.cwd, ".mcp.json")]);
    expect(records(w.runsDir)).toEqual([]);
  });
});
