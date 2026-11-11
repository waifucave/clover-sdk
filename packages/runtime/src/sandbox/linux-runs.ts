// Linux (#74's review B1, check 2): the sandboxed runs alive in this realm, what each must check at its end, and the
// ends a run doesn't reach on its own.
//
// A run's protected paths the sandbox couldn't hold (`UnheldPath`) are checked when the command ends: what it made at
// one is moved aside (`quarantinePlanted`). A run that doesn't reach its end is covered twice over:
// * the realm's own sweep (`sweepLinuxRuns`): a SIGTERM or SIGINT to `winter` (main.ts) and an embedded session's
//   abort (embedded.ts) run it right after their process-group kill, synchronously, and leave the record for the next;
// * a record on disk (`<winter home>/sandbox-runs/<pid>-<n>.json`, 0600), written before the command starts and
//   removed at its end: a run whose process died without either (a crash, a SIGKILL) is finished by the next
//   sandboxed run on this computer (`recoverCrashedLinuxRuns`).
//
// A RECORD IS NOT TRUSTED (#74's review, check 3). The recovery runs unsandboxed, so it acts only on what it can
// recompute: `sandbox-runs/` and `quarantine/` are write-denied in every sandbox (`linuxSandboxListsFor`), a record
// that is a link, not the user's or not 0600 is skipped, the record's quarantine folder is ignored for the current
// one, and only entries that recompute as protected paths under the run's roots are acted on (`RecoveryCheck`). The
// quarantine folder must be a real folder (never a link), and nothing here ever deletes recursively.
// The protected folders a run made before it started (`ensureProtectedFolders`) are removed at its end when they are
// still empty and no other sandboxed run is live (none in this realm, no record of a live process).
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { removePlanned } from "../tools/no-follow-write.ts";

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

function realDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
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

/** The quarantine folder, made if missing, when it (and the folder holding it) is a real folder and never a link. */
function quarantineFolder(quarantineRoot: string | undefined): string | undefined {
  if (quarantineRoot === undefined) return undefined;
  try {
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  } catch { /* checked below */ }
  return realDir(quarantineRoot) && realDir(dirname(quarantineRoot)) ? quarantineRoot : undefined;
}

/**
 * Moves aside whatever the command made at an unheld protected path (lane C's `quarantinePlanted`). It walks from the
 * path's anchor down, never through a link: the first link it meets (one the command made) is what moves, else the
 * path itself. It goes into the home's `quarantine/` folder when that is a real folder; otherwise, at a run's own end, a
 * file or a link is unlinked and an empty folder removed, and a folder with something in it stays; a recovery
 * (`removeWhenStuck: false`) leaves it in place and reports it in `kept`. Never a recursive delete.
 */
export function quarantinePlanted(unheld: readonly UnheldPath[], quarantineRoot: string | undefined, o: { removeWhenStuck?: boolean; kept?: string[] } = {}): string[] {
  const planted: string[] = [];
  const folder = quarantineFolder(quarantineRoot);
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
    // 0.0.77: the folder above the target as the walk found it (no link from the anchor down). A command still
    // running (a leftover child) could swap a folder for a link after the walk: the move and the removal both
    // check it again first, and the removal goes through the shared no-follow remover, which never deletes
    // through a swapped folder (tools/no-follow-write.ts's `removePlanned`).
    let parentReal: string;
    try {
      parentReal = realpathSync(dirname(target));
    } catch {
      continue;
    }
    const parentStill = (): boolean => {
      try {
        return realpathSync(dirname(target!)) === parentReal;
      } catch {
        return false;
      }
    };
    let gone = false;
    if (folder !== undefined && parentStill()) {
      try {
        renameSync(target, join(folder, `${target.split("/").filter(Boolean).join("_")}.quarantined-${Math.random().toString(16).slice(2, 10)}`));
        gone = true;
      } catch { /* below */ }
    }
    if (!gone && o.removeWhenStuck === false) {
      // A recovery: the path may be the user's own, made after the crash, so it stays where it is, reported.
      o.kept?.push(target);
      continue;
    }
    if (!gone && parentStill()) {
      try {
        const real = join(parentReal, basename(target));
        const st = lstatSync(real);
        if (st.isDirectory() && !st.isSymbolicLink()) rmdirSync(real); // only when empty
        else {
          removePlanned({ lexicalPath: target, realPath: real, realParent: parentReal, base: basename(target), missingDirs: [], existing: st, throughLink: false }, { allowLink: true });
        }
        gone = true;
      } catch { /* a folder with something in it stays; a folder that moved meanwhile stays too */ }
    }
    if (gone) planted.push(target);
  }
  return planted;
}

/** What a run's protected paths are computed from: its own roots (the homes and the brand are the recovering run's). */
export interface LinuxRunRoots {
  cwd: string;
  writableRoots: string[];
  allowGitConfigWrites?: boolean;
}

/** One live run. */
export interface LinuxRun {
  unheld: UnheldPath[];
  quarantineRoot: string | undefined;
  /** The folders made for it before it started, top first. */
  made: string[];
  /** Its roots, so a recovery can recompute its protected paths. */
  roots?: LinuxRunRoots;
}

/** What a recovery may act on for a record's roots: the protected paths (deny and folder literals) and the roots. */
export interface RecoveryCheck {
  protectedPaths: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  roots: readonly string[];
}

const live = new Map<number, LinuxRun & { record?: string }>();
let nextRun = 0;

function runsDirOf(quarantineRoot: string | undefined): string | undefined {
  return quarantineRoot === undefined ? undefined : join(dirname(quarantineRoot), "sandbox-runs");
}

/** A process's start time (Linux: `/proc/<pid>/stat`'s field 22), so a reused pid isn't the record's process. */
function startTimeOf(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
const ownStart = startTimeOf(process.pid);

function pidAlive(pid: number, start?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (start === undefined) return true;
  const now = startTimeOf(pid);
  return now === undefined || now === start;
}

/** A record file as the user's own 0600 file, never a link; its parsed contents, or undefined. */
function readRecord(path: string): (LinuxRun & { pid?: number; start?: string }) | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    if (process.getuid !== undefined && st.uid !== process.getuid()) return undefined;
    if ((st.mode & 0o777) !== 0o600) return undefined;
    const run = JSON.parse(readFileSync(path, "utf8")) as LinuxRun & { pid?: number; start?: string };
    return run !== null && typeof run === "object" ? run : undefined;
  } catch {
    return undefined;
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
    const start = readRecord(path)?.start;
    if (Number.isSafeInteger(pid) && pidAlive(pid, typeof start === "string" ? start : undefined)) n++;
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
      if (!realDir(dir)) throw new Error("not a real folder");
      record = join(dir, `${process.pid}-${id}-${Math.random().toString(16).slice(2, 10)}.json`);
      writeFileSync(record, JSON.stringify({ ...run, pid: process.pid, ...(ownStart !== undefined ? { start: ownStart } : {}) }), { mode: 0o600, flag: "wx" });
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

const rejectedSaid = new Set<string>();
function rejectRecord(dir: string, name: string, log: ((line: string) => void) | undefined): void {
  const rejected = join(dir, "rejected");
  try {
    mkdirSync(rejected, { recursive: true, mode: 0o700 });
    if (!realDir(rejected)) throw new Error("not a real folder");
    renameSync(join(dir, name), join(rejected, `${name}.${Math.random().toString(16).slice(2, 10)}`));
    log?.(`sandbox: a run record that isn't this user's own 0600 file was set aside, unread: ${name}`);
  } catch {
    if (rejectedSaid.has(name)) return;
    rejectedSaid.add(name);
    log?.(`sandbox: a run record that isn't this user's own 0600 file is skipped, unread: ${name}`);
  }
}

const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Finishes the runs whose process died without reaching their end (their record is still on disk), trusting nothing
 * the record says: `check(roots)` recomputes the run's protected paths from its roots, and only an unheld entry that
 * is one of them, anchored at or under a root, or a made folder that is one of them or on the way to one, is acted on.
 * The quarantine folder is always `quarantineRoot` (the current one).
 */
export function recoverCrashedLinuxRuns(quarantineRoot: string | undefined, check: (roots: LinuxRunRoots) => RecoveryCheck | undefined, log?: (line: string) => void): string[] {
  const dir = runsDirOf(quarantineRoot);
  if (dir === undefined || !realDir(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // `rejected/`
    const path = join(dir, name);
    const pid = Number(name.split("-")[0]);
    const run = readRecord(path);
    if (run === undefined) {
      // A link, not the user's, not 0600, or unreadable: never acted on, and moved aside once into `rejected/` (the
      // link itself, never what it points at) so no later start reads it again; when it can't be moved, said once.
      rejectRecord(dir, name, log);
      continue;
    }
    if (!Number.isSafeInteger(pid) || pidAlive(pid, typeof run.start === "string" ? run.start : undefined)) continue;
    const roots = run.roots;
    const ok = roots !== undefined && typeof roots.cwd === "string" && roots.cwd.startsWith("/") && Array.isArray(roots.writableRoots) && roots.writableRoots.every((r) => typeof r === "string" && r.startsWith("/"));
    const facts = ok ? check({ cwd: roots.cwd, writableRoots: [...roots.writableRoots], ...(roots.allowGitConfigWrites === true ? { allowGitConfigWrites: true } : {}) }) : undefined;
    if (facts !== undefined) {
      const unheld = (Array.isArray(run.unheld) ? run.unheld : []).filter((u): u is UnheldPath =>
        u !== null && typeof u === "object" && typeof u.path === "string" && typeof u.anchor === "string"
        && facts.protectedPaths.has(u.path) && u.anchor !== u.path && within(u.path, u.anchor)
        && facts.roots.some((r) => within(u.anchor, r)));
      const kept: string[] = [];
      out.push(...quarantinePlanted(unheld, quarantineRoot, { removeWhenStuck: false, kept }));
      if (kept.length > 0) log?.(`sandbox: a crashed run's protected paths stay where they are (the quarantine folder can't be used): ${kept.join(", ")}`);
      const made = (Array.isArray(run.made) ? run.made : []).filter((m): m is string =>
        typeof m === "string" && !facts.roots.includes(m) && [...facts.folders].some((f) => f === m || f.startsWith(`${m}/`))
        && (facts.roots.some((r) => within(m, r)) || (quarantineRoot !== undefined && within(m, dirname(dirname(quarantineRoot))))));
      removeMadeFolders(made);
    }
    rmSync(path, { force: true });
  }
  return out;
}

/** Test seam: forgets the live runs. */
export function resetLinuxRunsForTest(): void {
  live.clear();
}
