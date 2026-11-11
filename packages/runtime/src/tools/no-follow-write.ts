// THE ONE WRITER behind every file tool that writes a model-named path (Write, Edit, NotebookEdit), the
// runtime's own new files in the session temp folder (MCP resource blobs, Bash's overflow output, the MCP
// output spill: `writeNewFileUnder`), the checkpoint rewind's restore and delete, and the Linux sandbox's
// clean-up of planted protected paths (`removePlanned`). It exists to close one hole: the tools used to check a
// path and then write it with `writeFileSync`, which follows links. Between the check and the write a
// sandboxed shell (a background command, a monitor) could put a link where the checked file was, or
// swap a folder above it for one, and the write landed wherever the link pointed.
//
// What it does, in order:
//   1. PLAN. Resolve the path ONCE to the real file it names: a link at the leaf is followed here, at
//      planning time, never at the write (`followLeafLink`; rewind refuses one instead). The folders
//      above it are resolved with `realpath` from the deepest one that exists, and the names still to
//      be made are kept. The caller checks this real target (deny lists, write roots) -- the SAME
//      string the write then opens.
//   2. MAKE MISSING FOLDERS one at a time, never `mkdir -p`: each new folder is checked after it is
//      made (still a folder, still where it was meant to be); a wrong one is removed and the call fails.
//   3. OPEN exactly the planned real path with `O_NOFOLLOW` (a link swapped in at the leaf fails the
//      open) and `O_NONBLOCK` (a FIFO swapped in can't hang it). On macOS also `O_NOFOLLOW_ANY`: a
//      link ANYWHERE in the path fails the open, so a folder swapped for a link between the plan and
//      the open cannot redirect it. A new file is `O_CREAT|O_EXCL`; an existing one is opened without
//      `O_TRUNC`, so nothing changes before step 4.
//   4. VERIFY before the first byte: the descriptor is a regular file (and has one link when the caller
//      refuses hard links); the parent's realpath is still the planned one; and the name at the planned
//      place is the descriptor's own file (same device and inode; on Linux `/proc/self/fd` agrees too).
//      On a mismatch the call fails, and a file this call created is removed when it can be found.
//   5. The caller then reads and writes through the descriptor (`readAll`/`replaceContents`), so the
//      file read is the file written.
//
// THE WINDOW THAT REMAINS (said plainly, also in the changelog):
//   - macOS: none for content. A folder swapped while missing folders are made can leave an EMPTY
//     folder outside for a moment; it is removed, and the open fails anyway (`O_NOFOLLOW_ANY`).
//   - Linux: no `O_NOFOLLOW_ANY` (and `openat2`'s RESOLVE_NO_SYMLINKS is out of reach from Node/Bun). A
//     folder swapped between the plan and the open can make a NEW file's open create an EMPTY file at
//     the link's target; step 4 sees it and removes it (found through `/proc/self/fd`, removed only when
//     the name there is still that file). An existing outside file is never truncated or written: the
//     open has no `O_TRUNC` and nothing is written before step 4.
//   - Forging step 4 needs a hard link to the outside file (refused when the caller refuses hard links)
//     or moving the outside file into the checked folder, which needs write access outside the roots.
//   - Windows: no `O_NOFOLLOW`. The leaf is lstat'ed right before the open instead, which leaves the gap
//     between that lstat and the open; step 4 still runs.
//   - Processes running as the same user outside any sandbox are out of scope (README).
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, ftruncateSync, writeSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { resolveRealTarget, resolveSymlinkTargetChain } from "../permissions/paths.ts";
import { assertHostCodePathAccess } from "../sandbox/host-code-protection.ts";
import type { ToolExecutionContext } from "./registry.ts";
import { computeWritableRoots } from "./sandbox-run-inputs.ts";
import { isOnCaseSensitiveVolume } from "../sandbox/case-variants.ts";

/** darwin's `O_NOFOLLOW_ANY` (sys/fcntl.h): refuse a symbolic link in ANY component of the path. Node/Bun don't export it. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const MAX_LEAF_LINKS = 8;

export class NoFollowWriteError extends Error {
  readonly code: "link_refused" | "not_regular" | "hard_link" | "moved" | "exists" | "missing" | "outside_roots";
  constructor(code: NoFollowWriteError["code"], message: string) {
    super(message);
    this.name = "NoFollowWriteError";
    this.code = code;
  }
}

/** What `planWrite` found: the real file a path names, and what still has to be made for it. */
export interface WritePlan {
  /** The path as the caller named it (absolute, normalized). */
  lexicalPath: string;
  /** The real file it names: `realParent/base`. The checks and the open use this. */
  realPath: string;
  realParent: string;
  base: string;
  /** Folders that don't exist yet, outermost first, as real paths under the deepest existing folder. */
  missingDirs: string[];
  /** The leaf's lstat at planning time, or undefined when nothing is there yet. Never a link's own stat. */
  existing: Stats | undefined;
  /** A link was followed somewhere on the way (at the leaf or above it): `lexicalPath !== realPath`. */
  throughLink: boolean;
}

export interface PlanOptions {
  /** Follow a link at the leaf to its target (the file tools); false refuses it (rewind). */
  followLeafLink: boolean;
  /** Allow missing folders above the file (Write's "new file in a new folder"). */
  createParents: boolean;
}

/** Case is folded only on a macOS volume that ignores it (`pathconf(_PC_CASE_SENSITIVE)`, probed at `where`); an
 *  unknown answer counts as case-sensitive, which only makes these comparisons stricter. */
function foldsCase(where: string): boolean {
  return process.platform === "darwin" && !isOnCaseSensitiveVolume(where);
}

/** `a` names the same place as `b`: exact, or case-folded on a case-insensitive macOS volume. */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  return foldsCase(b) && a.toLowerCase() === b.toLowerCase();
}

/** `path` is `root` or under it (both real paths): exact, or case-folded on a case-insensitive macOS volume. */
export function isUnder(path: string, root: string): boolean {
  const under = (p: string, r: string) => p === r || r === "/" || p.startsWith(r.endsWith("/") ? r : r + "/");
  if (under(path, root)) return true;
  return foldsCase(root) && under(path.toLowerCase(), root.toLowerCase());
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/** Step 1. Resolve `path` once to the real file it names. Throws `NoFollowWriteError` for what it refuses. */
export function planWrite(path: string, opts: PlanOptions, depth = 0): WritePlan {
  if (!isAbsolute(path) || /\0/.test(path)) throw new NoFollowWriteError("missing", `"${path}" is not an absolute path`);
  const lexicalPath = normalize(path);
  const base = basename(lexicalPath);
  if (base === "" || lexicalPath === "/") throw new NoFollowWriteError("not_regular", `"${lexicalPath}" is not a file`);

  const leaf = lstatOrUndefined(lexicalPath);
  if (leaf?.isSymbolicLink()) {
    if (!opts.followLeafLink) throw new NoFollowWriteError("link_refused", `"${lexicalPath}" is a symbolic link; refusing to write through it`);
    if (depth >= MAX_LEAF_LINKS) throw new NoFollowWriteError("link_refused", `"${lexicalPath}": too many symbolic links`);
    let target: string;
    try {
      target = realpathSync(lexicalPath);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
      // A link to a file that doesn't exist yet: the write creates THAT file, in a folder that must exist.
      const chain = resolveSymlinkTargetChain(lexicalPath);
      if (chain === undefined) throw new NoFollowWriteError("link_refused", `"${lexicalPath}" is a symbolic link that can't be followed`);
      target = chain;
    }
    const plan = planWrite(target, { ...opts, createParents: false }, depth + 1);
    return { ...plan, lexicalPath, throughLink: true };
  }

  // The deepest folder above the leaf that exists, resolved; the names below it are still to be made.
  const missing: string[] = [];
  let ancestor = dirname(lexicalPath);
  for (;;) {
    const st = lstatOrUndefined(ancestor);
    if (st !== undefined) break;
    missing.unshift(basename(ancestor));
    const up = dirname(ancestor);
    if (up === ancestor) throw new NoFollowWriteError("missing", `no folder of "${lexicalPath}" exists`);
    ancestor = up;
  }
  if (missing.length > 0 && !opts.createParents) throw new NoFollowWriteError("missing", `the folder of "${lexicalPath}" does not exist`);
  const realAncestor = realpathSync(ancestor);
  const missingDirs: string[] = [];
  let realParent = realAncestor;
  for (const name of missing) {
    realParent = join(realParent, name);
    missingDirs.push(realParent);
  }
  const realPath = join(realParent, base);
  // The leaf seen through the real parent: the same file as through the lexical one, but stat it where the open will go.
  const existing = missing.length === 0 ? lstatOrUndefined(realPath) : undefined;
  if (existing?.isSymbolicLink()) {
    // Only reachable when the leaf changed between the two lstats; plan again from the start.
    if (depth >= MAX_LEAF_LINKS) throw new NoFollowWriteError("link_refused", `"${lexicalPath}": too many symbolic links`);
    return planWrite(lexicalPath, opts, depth + 1);
  }
  return { lexicalPath, realPath, realParent, base, missingDirs, existing, throughLink: !samePath(realPath, lexicalPath) };
}

// --- Test seam ---------------------------------------------------------------------------------------
// Called between the plan (and the caller's checks on it) and the open, and before each folder is made,
// so a test can swap a link in deterministically. Nothing in the runtime sets it.
type SeamStage = "beforeMkdir" | "beforeOpen" | "beforeRemove" | "beforeRemember";
let seam: ((stage: SeamStage, plan: WritePlan) => void) | undefined;
export function _setNoFollowWriteSeamForTests(fn: ((stage: SeamStage, plan: WritePlan) => void) | undefined): void {
  seam = fn;
}

export interface OpenOptions {
  /** "existing": the plan saw a file and the open must find the same kind of thing (read and write); "read": the
   *  same, read-only; "create": nothing may be there. */
  mode: "existing" | "create" | "read";
  /** Refuse a file with more than one hard link. */
  refuseHardLinks: boolean;
  /** Mode bits for a new file (umask applies). */
  fileMode?: number;
  /** Open an existing file for appending (`O_APPEND`): every write lands at its end. */
  append?: boolean;
}

export interface OpenedTarget {
  fd: number;
  plan: WritePlan;
  created: boolean;
  /** Folders this call made, outermost first. */
  createdDirs: string[];
  stat: Stats;
}

function removeCreatedDirs(dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      rmdirSync(dir);
    } catch {
      /* not empty, or gone: leave it */
    }
  }
}

/** Step 2: make the missing folders one at a time, each checked after it is made. */
function makeMissingDirs(plan: WritePlan): string[] {
  const created: string[] = [];
  for (const dir of plan.missingDirs) {
    seam?.("beforeMkdir", plan);
    let made = false;
    try {
      mkdirSync(dir);
      made = true;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") {
        removeCreatedDirs(created);
        throw err;
      }
    }
    let landed: string | undefined;
    try {
      landed = realpathSync(dir);
    } catch {
      landed = undefined;
    }
    const st = lstatOrUndefined(dir);
    if (st === undefined || st.isSymbolicLink() || !st.isDirectory() || landed === undefined || !samePath(landed, dir)) {
      if (made && landed !== undefined && !samePath(landed, dir)) {
        try {
          rmdirSync(landed); // the folder we made where a swapped link sent it (empty: we just made it)
        } catch {
          /* gone or not empty: leave it */
        }
      }
      removeCreatedDirs(created);
      throw new NoFollowWriteError("moved", `a folder of "${plan.lexicalPath}" changed while it was being made; nothing was written`);
    }
    if (made) created.push(dir);
  }
  return created;
}

function flagsFor(mode: OpenOptions["mode"]): number {
  // macOS: `O_NOFOLLOW_ANY` alone -- it covers the leaf too, and darwin refuses it beside `O_NOFOLLOW` (EINVAL).
  const nofollow = process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (constants.O_NOFOLLOW ?? 0);
  // O_NONBLOCK: a FIFO swapped in can't hang the open. O_NOCTTY: a terminal device never becomes the process's.
  const base = nofollow | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
  if (mode === "create") return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | base;
  return (mode === "read" ? constants.O_RDONLY : constants.O_RDWR) | base;
}

/** Linux: where the descriptor really is, or undefined when /proc can't say. */
function procPathOf(fd: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const target = readlinkSync(`/proc/self/fd/${fd}`);
    return target.startsWith("/") ? target.replace(/ \(deleted\)$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A file this call created must go, after a failed check: removed through `removePlanned` (rename to a random
 * name, check, unlink) and only at a place whose folder is known -- where Linux's `/proc` says the descriptor is,
 * or the planned place when the location check PASSED. Never by a path through a folder that failed the check:
 * between a look and an unlink the link could be re-pointed and a same-named file elsewhere deleted. Returns
 * where the file was left, or undefined when it was removed.
 */
function removeStrayCreated(fd: number, stat: Stats, plan: WritePlan, locationOk: boolean): string | undefined {
  const proc = procPathOf(fd);
  const where = proc ?? (locationOk ? plan.realPath : undefined);
  if (where === undefined) return "an unknown place (the folder it was made in moved)";
  try {
    const parent = dirname(where);
    if (realpathSync(parent) !== parent) return where;
    removePlanned({ lexicalPath: where, realPath: where, realParent: parent, base: basename(where), missingDirs: [], existing: stat, throughLink: false });
    return undefined;
  } catch {
    return where;
  }
}

/** Steps 2-4. Opens the planned real path, verified, or throws having changed nothing outside. */
export function openPlanned(plan: WritePlan, opts: OpenOptions): OpenedTarget {
  const createdDirs = opts.mode === "create" ? makeMissingDirs(plan) : [];
  seam?.("beforeOpen", plan);
  if (constants.O_NOFOLLOW === undefined) {
    // Windows: no O_NOFOLLOW. Look right before the open instead (the remaining gap is said in this file's header).
    if (lstatOrUndefined(plan.realPath)?.isSymbolicLink()) {
      removeCreatedDirs(createdDirs);
      throw new NoFollowWriteError("link_refused", `"${plan.lexicalPath}" became a symbolic link; nothing was written`);
    }
  }
  let fd: number;
  try {
    fd = opts.mode === "create" ? openSync(plan.realPath, flagsFor("create"), opts.fileMode ?? 0o666) : openSync(plan.realPath, flagsFor(opts.mode) | (opts.append === true ? constants.O_APPEND : 0));
  } catch (err) {
    removeCreatedDirs(createdDirs);
    const code = (err as { code?: unknown }).code;
    if (code === "ELOOP" || code === "EMLINK" || code === "EFTYPE") throw new NoFollowWriteError("link_refused", `a symbolic link appeared in "${plan.lexicalPath}" while it was being written; nothing was written`);
    if (code === "EEXIST") throw new NoFollowWriteError("exists", `"${plan.lexicalPath}" appeared while it was being written; nothing was written`);
    if (code === "ENOENT" && opts.mode !== "create") throw new NoFollowWriteError("moved", `"${plan.lexicalPath}" disappeared while it was being written; nothing was written`);
    if (code === "ENXIO" || code === "EISDIR") throw new NoFollowWriteError("not_regular", `"${plan.lexicalPath}" is not a regular file`);
    throw err;
  }
  const created = opts.mode === "create";
  const stat = fstatSync(fd);
  // Step 4: the place is still the planned one, and the name there is this descriptor's file.
  let parentNow: string | undefined;
  try {
    parentNow = realpathSync(plan.realParent);
  } catch {
    parentNow = undefined;
  }
  const named = lstatOrUndefined(plan.realPath);
  const proc = procPathOf(fd);
  const locationOk = parentNow !== undefined && samePath(parentNow, plan.realParent) && named !== undefined && !named.isSymbolicLink() && named.dev === stat.dev && named.ino === stat.ino && (proc === undefined || proc === plan.realPath);
  const fail = (code: NoFollowWriteError["code"], message: string): never => {
    const left = created ? removeStrayCreated(fd, stat, plan, locationOk) : undefined;
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    removeCreatedDirs(createdDirs);
    throw new NoFollowWriteError(code, left !== undefined ? `${message} (an empty file this call created was left at ${left})` : message);
  };
  if (!stat.isFile()) fail("not_regular", `"${plan.lexicalPath}" is not a regular file`);
  if (opts.refuseHardLinks && stat.nlink > 1) fail("hard_link", `"${plan.lexicalPath}" has ${stat.nlink} hard links; refusing to write a file that other names share`);
  if (!locationOk) fail("moved", `"${plan.lexicalPath}" moved while it was being written; nothing was written`);
  if (opts.mode !== "create" && plan.existing !== undefined && (plan.existing.dev !== stat.dev || plan.existing.ino !== stat.ino)) {
    fail("moved", `"${plan.lexicalPath}" was replaced while it was being written; nothing was written`);
  }
  return { fd, plan, created, createdDirs, stat };
}

/**
 * Remove the planned file -- a regular file, never a link or a folder -- and nothing else, even if a folder
 * above it is swapped for a link meanwhile (the checkpoint rewind's delete). Node has no `unlinkat`, so a
 * plain `unlink(path)` would follow a swapped folder to an outside file of the same name. Instead:
 *   1. RENAME the name to a fresh random name in the same folder. Wherever the folder really is at that
 *      moment, a rename destroys nothing.
 *   2. VERIFY that the renamed file is the planned one: opened at the planned real place with no link
 *      anywhere (`O_NOFOLLOW_ANY` on macOS; on Linux the folder's realpath is checked again), and the
 *      same device and inode the plan saw. If not, the rename is undone and the call fails.
 *   3. UNLINK the random name. If a folder is swapped between 2 and 3, the unlink meets a name that
 *      exists nowhere else (ENOENT) and the call fails having deleted nothing.
 * What remains: if a folder is swapped during step 1 and back before the undo, an outside file can be left
 * under the random name (renamed, never deleted); the error says so.
 */
export function removePlanned(plan: WritePlan, opts: { allowLink?: boolean } = {}): void {
  const existing = plan.existing;
  if (existing === undefined) return;
  const isLink = existing.isSymbolicLink();
  if (isLink && opts.allowLink !== true) throw new NoFollowWriteError("link_refused", `"${plan.lexicalPath}" is a symbolic link; not removed`);
  if (!isLink && !existing.isFile()) throw new NoFollowWriteError("not_regular", `"${plan.lexicalPath}" is not a regular file; not removed`);
  seam?.("beforeRemove", plan);
  const parked = join(plan.realParent, `.${plan.base}.removing-${randomUUID()}`);
  try {
    renameSync(plan.realPath, parked);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") throw new NoFollowWriteError("moved", `"${plan.lexicalPath}" moved before it could be removed; nothing was removed`);
    throw err;
  }
  let same = false;
  if (isLink) {
    // A link (`allowLink`: the link itself is what goes): the folder still the planned one, and the parked name the same link.
    try {
      const st = lstatSync(parked);
      same = st.isSymbolicLink() && st.dev === existing.dev && st.ino === existing.ino && samePath(realpathSync(plan.realParent), plan.realParent);
    } catch {
      same = false;
    }
  } else try {
    const fd = openSync(parked, flagsFor("read"));
    try {
      const st = fstatSync(fd);
      const parentNow = realpathSync(plan.realParent);
      same = st.isFile() && st.dev === existing.dev && st.ino === existing.ino && samePath(parentNow, plan.realParent) && (procPathOf(fd) ?? parked) === parked;
    } finally {
      closeSync(fd);
    }
  } catch {
    same = false;
  }
  if (!same) {
    let restored = false;
    try {
      renameSync(parked, plan.realPath);
      restored = true;
    } catch {
      /* the folder moved again: say so below */
    }
    throw new NoFollowWriteError(
      "moved",
      restored
        ? `"${plan.lexicalPath}" moved while it was being removed; nothing was removed`
        : `"${plan.lexicalPath}" moved while it was being removed; nothing was removed, but a file was left renamed to "${basename(parked)}" in the folder the path then led to`,
    );
  }
  try {
    unlinkSync(parked);
  } catch (err) {
    throw new NoFollowWriteError("moved", `"${plan.lexicalPath}" moved while it was being removed; nothing was removed (left as "${basename(parked)}"): ${(err as Error).message}`);
  }
}

/**
 * A NEW file the runtime itself names (a random or counted name) under a folder of the session temp tree --
 * which a sandboxed command can write, so it can plant a link where the file's folder should be. Made with
 * the same writer: folders one at a time, exclusive create, and the real file must land under `root`.
 * Returns the path as named (under `root`).
 */
export function writeNewFileUnder(root: string, parts: readonly string[], data: string | Uint8Array): string {
  const path = join(root, ...parts);
  const plan = planWrite(path, { followLeafLink: false, createParents: true });
  if (!isUnder(plan.realPath, resolveRealTarget(root))) {
    throw new NoFollowWriteError("outside_roots", `a folder under "${root}" leads somewhere else; nothing was written`);
  }
  const target = openPlanned(plan, { mode: "create", refuseHardLinks: true });
  try {
    replaceContents(target.fd, data);
  } finally {
    closeTarget(target);
  }
  return path;
}

/**
 * A file directly in a folder the runtime made and validated (its path is already real, e.g. a session's
 * `tasks/`): the folder must still be exactly that folder -- no link at it or above it -- and the file is
 * never followed. Throws `NoFollowWriteError` otherwise.
 */
const knownFolders = new Map<string, string>();

/** Remember a runtime-made folder's real path, taken right after the runtime made and validated it, so a later
 *  open of a file in it (`openInFolder`, `readInFolder`) can tell it from a link swapped in since. */
export function rememberFolder(folder: string): void {
  const key = normalize(folder);
  if (knownFolders.has(key)) return; // the first good look counts; never re-learned
  seam?.("beforeRemember", { lexicalPath: key, realPath: key, realParent: dirname(key), base: basename(key), missingDirs: [], existing: undefined, throughLink: false });
  // Built from the PARENT's real path (a folder the command can't move) and the folder's own name, never by
  // following the folder itself: a link swapped in at the folder since the runtime validated it must not
  // become the remembered "real" folder. The folder at that place must be a real folder, and resolve to it.
  const expected = join(realpathSync(dirname(key)), basename(key));
  const st = lstatOrUndefined(expected);
  if (st === undefined || st.isSymbolicLink() || !st.isDirectory() || !samePath(realpathSync(key), expected)) {
    throw new NoFollowWriteError("moved", `"${key}" is not the folder the runtime made; refusing to use it`);
  }
  knownFolders.set(key, expected);
}

function planInFolder(path: string): WritePlan {
  const plan = planWrite(path, { followLeafLink: false, createParents: false });
  const folder = dirname(normalize(path));
  const expected = knownFolders.get(folder);
  const ok = expected !== undefined ? samePath(plan.realParent, expected) : !plan.throughLink && samePath(plan.realParent, folder);
  if (!ok) throw new NoFollowWriteError("moved", `the folder of "${path}" is not the folder it was made as; nothing was written`);
  return plan;
}

/** Open (creating it exclusively when missing) a file in a runtime-made folder, verified (`planInFolder`). */
export function openInFolder(path: string, opts: { create?: boolean; fileMode?: number; append?: boolean } = {}): OpenedTarget {
  const plan = planInFolder(path);
  if (plan.existing === undefined && opts.create === false) throw new NoFollowWriteError("missing", `"${path}" does not exist`);
  return openPlanned(plan, { mode: plan.existing === undefined ? "create" : "existing", refuseHardLinks: true, ...(opts.fileMode !== undefined ? { fileMode: opts.fileMode } : {}), ...(opts.append === true ? { append: true } : {}) });
}

/** Append (or replace) the contents of a file in a runtime-made folder, through one verified descriptor. */
export function writeInFolder(path: string, data: string | Uint8Array, how: "append" | "replace", fileMode?: number): void {
  const target = openInFolder(path, fileMode !== undefined ? { fileMode } : {});
  try {
    if (how === "replace") replaceContents(target.fd, data);
    else appendContents(target.fd, data);
  } finally {
    closeTarget(target);
  }
}

/** Read a file in a runtime-made folder through one verified descriptor (never through a link planted at it or above it). */
export function readInFolder(path: string): Buffer {
  const plan = planInFolder(path);
  if (plan.existing === undefined) throw new NoFollowWriteError("missing", `"${path}" does not exist`);
  const target = openPlanned(plan, { mode: "read", refuseHardLinks: true });
  try {
    return readAll(target.fd);
  } finally {
    closeTarget(target);
  }
}

/** Append through the descriptor, at the file's current end. */
export function appendContents(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let at = fstatSync(fd).size;
  let written = 0;
  while (written < bytes.length) {
    const n = writeSync(fd, bytes, written, bytes.length - written, at);
    written += n;
    at += n;
  }
}

/** The whole file, from the start, through the descriptor. */
export function readAll(fd: number): Buffer {
  return readFileSync(fd);
}

/** Replace the file's contents through the descriptor (truncate, then write from offset 0). */
export function replaceContents(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
}

export function closeTarget(target: OpenedTarget): void {
  try {
    closeSync(target.fd);
  } catch {
    /* already closed */
  }
}

// --- The file tools' checks on a plan ------------------------------------------------------------------

type PolicyContext = Pick<ToolExecutionContext, "sandboxSettings" | "cwd" | "permission" | "tempDir" | "session" | "outDir">;

/**
 * `sandbox.filesystem.enforceWriteRootsInFileTools`: the file tools write only inside the session's write
 * roots -- the set its sandboxed commands may write (`computeWritableRoots`: the session temp folder, the
 * bounded roots with the cwd, the outputs folder, `filesystem.allowWrite`). Off unless the host (or a
 * settings file, which may only turn it on) sets it.
 */
export function writeRootsEnforced(ctx: Pick<ToolExecutionContext, "sandboxSettings">): boolean {
  return ctx.sandboxSettings?.filesystem?.enforceWriteRootsInFileTools === true;
}

/** Hard links are refused while the write roots are enforced (a hard link is the one way to forge that check), unless the host allows them. */
export function refuseHardLinks(ctx: Pick<ToolExecutionContext, "sandboxSettings">): boolean {
  return writeRootsEnforced(ctx) && ctx.sandboxSettings?.filesystem?.allowHardLinkWrites !== true;
}

/**
 * The checks a file tool runs on its plan, BEFORE the open: the host and sandbox deny lists on both the
 * name the model gave and the real file it names, for each access; then, when enforced, the write roots
 * on the real file.
 *
 * The roots are waived for ONE case only: the host's `canUseTool` answered allow for THIS call (the
 * permission layer stamps that as `explicitApproval: "prompt"` on these tools, and only for a
 * `canUseTool` answer) AND the name it approved is the real file -- no link anywhere on the way. A link
 * means the host approved a name whose target could change between its answer and this write.
 */
export function checkPlannedTarget(plan: WritePlan, ctx: PolicyContext, accesses: readonly ("read" | "write")[]): void {
  for (const access of accesses) {
    assertHostCodePathAccess(plan.lexicalPath, access, ctx.sandboxSettings, ctx.cwd);
    assertHostCodePathAccess(plan.realPath, access, ctx.sandboxSettings, ctx.cwd);
  }
  if (!writeRootsEnforced(ctx)) return;
  if (ctx.permission?.explicitApproval === "prompt" && !plan.throughLink) return;
  const roots = computeWritableRoots(ctx as ToolExecutionContext).map((root) => resolveRealTarget(isAbsolute(root) ? normalize(root) : resolve(ctx.cwd, root)));
  if (roots.some((root) => isUnder(plan.realPath, root))) return;
  throw new NoFollowWriteError(
    "outside_roots",
    plan.throughLink
      ? `"${plan.lexicalPath}" leads through a symbolic link to "${plan.realPath}", which is outside this session's write roots; nothing was written. Write "${plan.realPath}" itself if that is the file you mean`
      : `"${plan.realPath}" is outside this session's write roots; nothing was written`,
  );
}
