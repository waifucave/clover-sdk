// Linux (#74's review B1, check 2): the sandboxed runs alive in this realm, what each must check at its end, and the
// ends a run doesn't reach on its own.
//
// A run's protected paths the sandbox couldn't hold (`UnheldPath`) are checked when the command ends: what it made at
// one is moved aside (`quarantinePlanted`). A run that doesn't reach its end is covered twice over:
// * the realm's own sweep (`sweepLinuxRuns`): a SIGTERM or SIGINT to `winter` (main.ts) and an embedded session's
//   abort (embedded.ts) run it right after their process-group kill, synchronously, and leave the record for the next;
// * a record on disk (`<winter home>/sandbox-runs/<pid>-<n>.json`), written before the command starts and removed at
//   its end: a run whose process died without either (a crash, a SIGKILL) is finished by the next sandboxed run on
//   this computer (`recoverCrashedLinuxRuns`).
// The protected folders a run made before it started (`ensureProtectedFolders`) are removed at its end when they are
// still empty and no other sandboxed run is live (none in this realm, no record of a live process).
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** An unheld protected path and its deepest ancestor that existed before the run (its anchor). */
export interface UnheldPath { path: string; anchor: string }

export function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The deepest ancestor of `path` that exists now (by `lstat`, links not followed). */
export function anchorOf(path: string): string {
  let a = dirname(path);
  while (a !== dirname(a) && !lexists(a)) a = dirname(a);
  return a;
}

/**
 * Moves aside whatever the command made at an unheld protected path (lane C's `quarantinePlanted`). It walks from the
 * path's anchor down, never through a link: the first link it meets (one the command made) is what moves, else the
 * path itself. It goes into the home's `quarantine/` folder, or is removed when it can't be moved there.
 */
export function quarantinePlanted(unheld: readonly UnheldPath[], quarantineRoot: string | undefined): string[] {
  const planted: string[] = [];
  for (const { path, anchor } of unheld) {
    const rest = path.slice(anchor.length).split("/").filter(Boolean);
    let at = anchor;
    let target: string | undefined;
    for (const [i, part] of rest.entries()) {
      at = join(at, part);
      let st;
      try {
        st = lstatSync(at);
      } catch {
        break; // still missing
      }
      if (st.isSymbolicLink() || i === rest.length - 1) {
        target = at;
        break;
      }
    }
    if (target === undefined || planted.includes(target)) continue;
    try {
      if (quarantineRoot === undefined) throw new Error("no quarantine folder");
      mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      renameSync(target, join(quarantineRoot, `${target.split("/").filter(Boolean).join("_")}.quarantined-${Math.random().toString(16).slice(2, 10)}`));
    } catch {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    planted.push(target);
  }
  return planted;
}


/** One live run. */
export interface LinuxRun {
  unheld: UnheldPath[];
  quarantineRoot: string | undefined;
  /** The folders made for it before it started, top first. */
  made: string[];
}

const live = new Map<number, LinuxRun & { record?: string }>();
let nextRun = 0;

function runsDirOf(quarantineRoot: string | undefined): string | undefined {
  return quarantineRoot === undefined ? undefined : join(dirname(quarantineRoot), "sandbox-runs");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Other runs' records whose process is alive (this realm's own excluded). */
function otherLiveRecords(dir: string | undefined, own: ReadonlySet<string>): number {
  if (dir === undefined) return 0;
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (own.has(path)) continue;
    const pid = Number(name.split("-")[0]);
    if (Number.isSafeInteger(pid) && pidAlive(pid)) n++;
  }
  return n;
}

/** Removes the folders a run made, deepest first, while each is still an empty real folder. */
function removeMadeFolders(made: readonly string[]): void {
  for (const f of [...made].reverse()) {
    try {
      const st = lstatSync(f);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      rmdirSync(f); // fails unless empty
    } catch { /* not empty, gone, or not ours to remove */ }
  }
}

/** Registers a run before its command starts (and writes its record); the returned end runs at the command's end. */
export function beginLinuxRun(run: LinuxRun): () => string[] {
  const id = nextRun++;
  const dir = runsDirOf(run.quarantineRoot);
  let record: string | undefined;
  if (dir !== undefined) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      record = join(dir, `${process.pid}-${id}-${Math.random().toString(16).slice(2, 10)}.json`);
      writeFileSync(record, JSON.stringify(run), { mode: 0o600 });
    } catch {
      record = undefined;
    }
  }
  live.set(id, { ...run, ...(record !== undefined ? { record } : {}) });
  let ended = false;
  return () => {
    if (ended) return [];
    ended = true;
    const entry = live.get(id);
    live.delete(id);
    if (entry === undefined) return []; // swept already
    return finishRun(entry);
  };
}

function finishRun(entry: LinuxRun & { record?: string }, keepRecord = false): string[] {
  const quarantined = quarantinePlanted(entry.unheld, entry.quarantineRoot);
  if (keepRecord) return quarantined;
  if (entry.record !== undefined) rmSync(entry.record, { force: true });
  const own = new Set([...live.values()].flatMap((r) => (r.record !== undefined ? [r.record] : [])));
  if (live.size === 0 && otherLiveRecords(runsDirOf(entry.quarantineRoot), own) === 0) removeMadeFolders(entry.made);
  return quarantined;
}

/** The realm's sweep (a SIGTERM, SIGINT or an embedded abort): every live run's plants moved aside now,
 *  synchronously. The records stay: a command still dying after the sweep is checked again by the next start. */
export function sweepLinuxRuns(): string[] {
  const out: string[] = [];
  for (const [id, entry] of [...live]) {
    live.delete(id);
    try {
      out.push(...finishRun(entry, true));
    } catch { /* a sweep never throws */ }
  }
  return out;
}

/** Finishes the runs whose process died without reaching their end (their record is still on disk). */
export function recoverCrashedLinuxRuns(quarantineRoot: string | undefined): string[] {
  const dir = runsDirOf(quarantineRoot);
  if (dir === undefined) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const pid = Number(name.split("-")[0]);
    if (!Number.isSafeInteger(pid) || pidAlive(pid)) continue;
    const path = join(dir, name);
    try {
      const run = JSON.parse(readFileSync(path, "utf8")) as LinuxRun;
      if (!Array.isArray(run.unheld)) throw new Error("not a run record");
      out.push(...quarantinePlanted(run.unheld, run.quarantineRoot ?? quarantineRoot));
      if (Array.isArray(run.made)) removeMadeFolders(run.made);
    } catch { /* an unreadable record is dropped */ }
    rmSync(path, { force: true });
  }
  return out;
}

/** Test seam: forgets the live runs. */
export function resetLinuxRunsForTest(): void {
  live.clear();
}
