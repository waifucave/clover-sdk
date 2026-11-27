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
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** An unheld protected path and its deepest ancestor that existed before the run (its anchor). */
export interface UnheldPath { path: string; anchor: string }

/** A held match that existed when the run started: its identity then (device, inode), its kind then, and its parent
 *  folder's identity. */
export interface HeldPath { path: string; dev: number; ino: number; kind: "file" | "dir" | "link" | "other"; parentDev: number; parentIno: number; fd?: number }

/** Linux's O_PATH (the same on x64 and arm64): a handle on an entry, a link itself with O_NOFOLLOW, without reading it. */
const O_PATH = 0o10000000;
/** How many held entries one run keeps a handle on (past it, identity is by device, inode and kind alone). */
export const HELD_HANDLES_MAX = 4_096;
let heldHandles = 0;

/** A held path as it is now, with its kind and its parent's identity: what `swappedHeld` compares at the end. With
 *  `hold` (Linux), the entry is also opened (O_PATH, no follow) and the handle kept for the run: while it is open the
 *  entry's inode can't be freed, so a new entry made at the path after `rm` can never reuse its number (ext4 hands a
 *  freed inode number straight to the next file) and pass for the old one. `releaseHeld` closes them. */
export function heldPathOf(path: string, hold = false): HeldPath | undefined {
  let fd: number | undefined;
  try {
    if (hold && process.platform === "linux" && heldHandles < HELD_HANDLES_MAX) {
      try { fd = openSync(path, O_PATH | fsConstants.O_NOFOLLOW); heldHandles++; } catch { fd = undefined; }
    }
    const st = fd !== undefined ? fstatSync(fd) : lstatSync(path);
    const parent = lstatSync(dirname(path));
    const kind = st.isSymbolicLink() ? "link" : st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    return { path, dev: st.dev, ino: st.ino, kind, parentDev: parent.dev, parentIno: parent.ino, ...(fd !== undefined ? { fd } : {}) };
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } heldHandles--; }
    return undefined;
  }
}

/** Closes the handles `heldPathOf` kept for a run. */
export function releaseHeld(held: readonly HeldPath[]): void {
  for (const h of held) {
    if (h.fd === undefined) continue;
    try { closeSync(h.fd); } catch { /* closed */ }
    heldHandles--;
    delete h.fd;
  }
}

/**
 * The held paths swapped during the command: an entry at a held path that is another entry than at the start is moved
 * aside, but for ONE case: the entry at the start was a regular FILE, and its parent is the same folder. That is a
 * person's own change made while a command ran (an editor's atomic save of `.envrc` or `.mcp.json`, `git config`
 * rewriting `.git/config`), never the command's, which can't make it: a held regular file is bound read-only onto
 * itself (linux-bwrap.ts `buildBwrapPlan`: `a.push("--ro-bind", d, d)` for each existing deny path whose kind is a file
 * or a folder), so a rename over it or an unlink of it fails with EBUSY, and the folders between a root and it are mount
 * points (the ancestor-rename fence). A held LINK gets no mount (its kind is neither), so the command can replace it
 * (`rm ~/.zshrc; echo … > ~/.zshrc` with a stow link there): a link at the start is never spared, nor is a folder, nor
 * anything under a new parent (the rename). Each one moved comes back as an unheld path anchored at its parent, so
 * `quarantinePlanted` moves it aside (its parent's identity checked as for any plant). A held path that is gone now has
 * nothing to move.
 */
export function swappedHeld(held: readonly HeldPath[]): UnheldPath[] {
  const out: UnheldPath[] = [];
  for (const h of held) {
    const now = heldPathOf(h.path);
    // The same entry: its device, inode and kind (with its handle held, an inode number can't have been reused).
    if (now === undefined || (now.dev === h.dev && now.ino === h.ino && now.kind === h.kind)) continue;
    const sameParent = now.parentDev === h.parentDev && now.parentIno === h.parentIno;
    if (h.kind === "file" && sameParent) continue;
    out.push({ path: h.path, anchor: dirname(h.path) });
  }
  return out;
}

/** What a run's end couldn't do, said as data and in plain lines outside the command's own output (`protectedPathsNote`). */
export interface RunReport {
  /** A path that should have been moved aside and wasn't, and why (left where it is: never deleted). */
  notMoved: { path: string; why: string }[];
  /** A swept root the end-of-run sweep couldn't read through, and why: a new match there may have stayed. */
  unswept: { root: string; why: string }[];
  /** Run once after the end's moves (the sweep puts back the modes of the folders it opened). Not data. */
  afterMoves?: () => void;
}

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
/** `renameat(parentfd, name, …)` as Node can say it on Linux: the parent opened as a folder (`O_DIRECTORY |
 *  O_NOFOLLOW`), its identity (device, inode) checked against `walked`, the identity the walk recorded for it, and the
 *  move made through `/proc/self/fd/<fd>/<name>`, which names the entry in that opened folder whatever its path has
 *  become. `O_NOFOLLOW` covers only the last component; Node has no `openat` to open the path one component at a time,
 *  so a folder higher up swapped for a link between the walk and the open would reach some other folder. That other
 *  folder has another identity, so nothing moves: the window is closed by the identity check, not by the open. A
 *  parent swapped for another folder moves nothing for the same reason. Elsewhere (no `/proc`): the move by path, after
 *  the same check. */
export function renameFromParent(parentReal: string, walked: { dev: number; ino: number }, name: string, to: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/")) throw new Error(`not one name: ${name}`);
  const fd = openSync(parentReal, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const got = fstatSync(fd);
    if (!got.isDirectory() || got.dev !== walked.dev || got.ino !== walked.ino) throw new Error(`${parentReal} isn't the folder the walk found`);
    const viaFd = `/proc/self/fd/${fd}`;
    renameSync(existsSync(viaFd) ? join(viaFd, name) : join(parentReal, name), to);
  } finally {
    closeSync(fd);
  }
}

/** A quarantined entry's name: its path with `_` for `/` and a random tail, cut (keeping the tail) so it stays a valid
 *  name (255 bytes) however deep the path was. */
export function quarantineName(target: string): string {
  const tail = `.quarantined-${Math.random().toString(16).slice(2, 10)}`;
  let base = target.split("/").filter(Boolean).join("_");
  while (Buffer.byteLength(base + tail) > 240) base = base.slice(Math.max(1, Math.floor(base.length / 8)));
  return base + tail;
}

export function quarantinePlanted(unheld: readonly UnheldPath[], quarantineRoot: string | undefined, o: { kept?: string[]; notMoved?: { path: string; why: string }[] } = {}): string[] {
  const planted: string[] = [];
  const folder = quarantineFolder(quarantineRoot);
  for (const { path, anchor } of unheld) {
    const rest = path.slice(anchor.length).split("/").filter(Boolean);
    let at = anchor;
    let target: string | undefined;
    // The parent's identity as the walk found it (device, inode): the move compares the folder it opens against this,
    // never against a look taken just before the open.
    let parentId: { dev: number; ino: number } | undefined;
    try { const a = lstatSync(anchor); if (a.isDirectory() && !a.isSymbolicLink()) parentId = { dev: a.dev, ino: a.ino }; } catch { /* below */ }
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
      parentId = st.isDirectory() ? { dev: st.dev, ino: st.ino } : undefined;
    }
    if (target === undefined || planted.includes(target)) continue;
    // 0.0.77: the folder above the target as the walk found it (no link from the anchor down). A command still
    // running (a leftover child) could swap a folder for a link after the walk: the move checks it again first,
    // and the folder it opens against the walk's identity. Nothing is ever deleted: what can't be moved stays.
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
    let why = folder === undefined ? "there is no quarantine folder to move it to" : "it couldn't be moved";
    if (folder !== undefined && !parentStill()) why = "the folder holding it changed while it was checked";
    if (folder !== undefined && parentStill() && parentId !== undefined) {
      try {
        renameFromParent(parentReal, parentId, basename(target), join(folder, quarantineName(target)));
        gone = true;
      } catch (err) { why = `it couldn't be moved (${(err as NodeJS.ErrnoException).code ?? "error"})`; }
    }
    if (!gone) {
      // Never deleted, wherever it came from (a literal path missing at the start, a swap, a sweep's find, a recovery:
      // any of them may be the person's own): it stays where it is, and the reason is said.
      o.kept?.push(target);
      o.notMoved?.push({ path: target, why });
      continue;
    }
    planted.push(target);
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
  /** The held matches inside the write roots, by their identity at the start (`swappedHeld` at the end). */
  held?: HeldPath[];
  /** The matches the command made itself, found by sweeping the roots the caller named at the end (in memory, never
   *  recorded); it says in `report.unswept` what it couldn't read through. */
  rescan?: () => UnheldPath[];
  /** Where the end says what it couldn't do (in memory, never recorded). */
  report?: RunReport;
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
      // The held identities stay in memory: a recovery recomputes only what the lists name and trusts no record's
      // identities (a crashed run's swapped entry is the known gap the mounts still cover).
      const { held: _held, rescan: _rescan, report: _report, ...recorded } = run;
      writeFileSync(record, JSON.stringify({ ...recorded, pid: process.pid, ...(ownStart !== undefined ? { start: ownStart } : {}) }), { mode: 0o600, flag: "wx" });
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
  let made: UnheldPath[] = [];
  try { made = entry.rescan?.() ?? []; } catch (err) {
    // Never swallowed: a sweep that threw checked nothing, and says so.
    entry.report?.unswept.push({ root: "(the sweep)", why: `it failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` });
  }
  // The literal paths missing at the start, what was swapped, and what was made new: moved aside, never deleted when
  // they can't be (any may be the person's own), each failure said.
  const notMoved = entry.report ? { notMoved: entry.report.notMoved } : {};
  const quarantined = quarantinePlanted(entry.unheld, entry.quarantineRoot, notMoved);
  const swapped = swappedHeld(entry.held ?? []);
  releaseHeld(entry.held ?? []);
  const more = quarantinePlanted([...swapped, ...made].filter((u) => !quarantined.includes(u.path)), entry.quarantineRoot, notMoved);
  quarantined.push(...more);
  // The sweep's opened folders get their old modes back, now that the moves out of them are done.
  try { entry.report?.afterMoves?.(); } catch { /* a folder gone meanwhile */ }
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
      out.push(...quarantinePlanted(unheld, quarantineRoot, { kept }));
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
