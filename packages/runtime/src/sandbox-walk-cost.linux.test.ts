// What the end-of-run walk (spawn.ts `rescan`: the write roots walked again for the held patterns, so a match the
// command made itself is moved aside) costs one command on Linux, on a home of 100 top folders (about 300,000 entries, a
// repository in every tenth), each its own write root, as MOSS draws a home at fully automatic. Each posture timed warm
// (after a first run that fills the page cache and the walk's size memory): the walk on, then off (the test seam). The
// numbers are printed for the review; the bound is the controller's: about a second added.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostSandboxRunInputs, linuxSandboxReady, runCommand } from "@waifucave/clover-agent-runtime/sandbox";
import { setEndOfRunWalkForTest } from "./sandbox/spawn.ts";

const ready = process.platform === "linux" && linuxSandboxReady();
const temps: string[] = [];
afterAll(() => { setEndOfRunWalkForTest(true); for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HELD = ["/**/*.git", "/**/.husky", "/**/.githooks", "/**/.envrc", "/**/.vscode", "/**/.mcp.json"];

test.skipIf(!ready)("the end-of-run walk on a 100-folder, ~300,000-entry home: warm, with and without", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sbx-walk-cost-")));
  temps.push(home);
  const roots: string[] = [];
  for (let f = 0; f < 100; f++) {
    const top = join(home, `top${f}`);
    const sub = join(top, "a", "b");
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 3_000; i++) writeFileSync(join(i % 2 === 0 ? top : sub, `f${i}`), "");
    if (f % 10 === 0) mkdirSync(join(top, "repo", ".git", "hooks"), { recursive: true });
    roots.push(top);
  }
  const once = async () => {
    const settings = { filesystem: { allowWrite: roots, denyWrite: HELD } };
    const inputs = buildHostSandboxRunInputs({ cwd: roots[0]!, env: { ...process.env, TMPDIR: roots[0]! }, settings, writableRoots: roots, home });
    const t = performance.now();
    const r = await runCommand({ ...inputs, command: "true", timeoutMs: 120_000 });
    expect(r.exitCode).toBe(0);
    return Math.round(performance.now() - t);
  };
  await once(); // the cold walk: fills the cache and the walk's size memory
  const on = [await once(), await once()];
  setEndOfRunWalkForTest(false);
  const off = [await once(), await once()];
  setEndOfRunWalkForTest(true);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  console.log(`sandbox walk cost: one command on 100 roots (~300,000 entries), warm: with the end-of-run walk ${on.join(", ")} ms, without ${off.join(", ")} ms; added ${median(on) - median(off)} ms`);
  expect(median(on) - median(off)).toBeLessThan(1_500);
}, 600_000);
