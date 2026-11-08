// The live sandboxed runs (linux-runs.ts, #74's review check 2): a run's record on disk from before its command starts,
// its end (plants moved aside, record gone, the folders made for it removed while empty and nothing else is live), the
// realm's sweep (a SIGTERM, SIGINT or embedded abort), and a crashed run finished by the next start. Plain files only:
// every OS runs these.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beginLinuxRun, recoverCrashedLinuxRuns, resetLinuxRunsForTest, sweepLinuxRuns } from "./linux-runs.ts";

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
    writeFileSync(join(w.runsDir, `${dead}-0-dead.json`), JSON.stringify({ unheld: w.unheld, quarantineRoot: w.quarantineRoot, made: [join(w.cwd, ".vscode")] }));
    writeFileSync(join(w.runsDir, `${process.pid}-9-live.json`), JSON.stringify({ unheld: [], quarantineRoot: w.quarantineRoot, made: [] }));
    writeFileSync(join(w.cwd, ".mcp.json"), "{}");
    expect(recoverCrashedLinuxRuns(w.quarantineRoot)).toEqual([join(w.cwd, ".mcp.json")]);
    expect(existsSync(join(w.cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(w.cwd, ".vscode"))).toBe(false);
    expect(records(w.runsDir)).toEqual([`${process.pid}-9-live.json`]);
    expect(readdirSync(w.quarantineRoot)).toHaveLength(1);
  });
});
