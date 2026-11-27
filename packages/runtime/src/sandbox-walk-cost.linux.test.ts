// What the end-of-run sweep (`sweepRoots`: the named roots walked again for the held patterns, so a match the command
// made itself is moved aside) costs one command on Linux, in the shape it is asked for: another computer's command in one
// given folder (about 30,000 entries, a repository in every tenth top folder) and its own temp root, both swept. Timed
// warm (after a first run that fills the page cache), with the sweep and without it. The numbers are printed for the
// review; the bound: a few hundred milliseconds added at most.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostSandboxRunInputs, linuxSandboxReady, runCommand } from "@waifucave/clover-agent-runtime/sandbox";

const ready = process.platform === "linux" && linuxSandboxReady();
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HELD = ["/**/*.git", "/**/.husky", "/**/.githooks", "/**/.envrc", "/**/.vscode", "/**/.mcp.json"];

test.skipIf(!ready)("the end-of-run sweep of a peer's folder (~30,000 entries) and its temp root: warm, with and without", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sbx-sweep-cost-")));
  temps.push(home);
  const folder = join(home, "project");
  const scratch = join(home, "tmp");
  mkdirSync(scratch, { recursive: true });
  for (let f = 0; f < 30; f++) {
    const top = join(folder, `top${f}`);
    const sub = join(top, "a", "b");
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 1_000; i++) writeFileSync(join(i % 2 === 0 ? top : sub, `f${i}`), "");
    if (f % 10 === 0) mkdirSync(join(top, "repo", ".git", "hooks"), { recursive: true });
  }
  const roots = [folder, scratch];
  const once = async (sweep: boolean) => {
    const settings = { filesystem: { allowWrite: roots, denyWrite: HELD } };
    const inputs = buildHostSandboxRunInputs({ cwd: folder, env: { ...process.env, TMPDIR: scratch }, settings, writableRoots: roots, home });
    const t = performance.now();
    const r = await runCommand({ ...inputs, command: "true", timeoutMs: 120_000, ...(sweep ? { sweepRoots: roots } : {}) });
    expect(r.exitCode).toBe(0);
    expect(r.unswept).toBeUndefined();
    return Math.round(performance.now() - t);
  };
  await once(true); // cold: fills the cache
  const on = [await once(true), await once(true), await once(true)];
  const off = [await once(false), await once(false), await once(false)];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  console.log(`sandbox sweep cost: one peer command, a ~30,000-entry folder and its temp root, warm: with the sweep ${on.join(", ")} ms, without ${off.join(", ")} ms; added ${median(on) - median(off)} ms`);
  expect(median(on) - median(off)).toBeLessThan(500);
}, 600_000);
