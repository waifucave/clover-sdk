import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ownedByThisUser } from "./owner.ts";
// home.ts moved to the sdk package (Task 10, WS-05 §6) — isUnset is the one piece of it this
// runtime-private module still needs; reused from there rather than re-implemented, preserving
// the "one shared blank-env-value rule" this file's own resolveTempBase comment documents.
import { isUnset, envName, type BrandProfile, requireBrand } from "@waifucave/clover-agent-sdk";

// P7a (D19): the two brand fields this module needs, as a `Pick` rather than the whole profile --
// the same shape (and the same reason) as the sdk's `HomeBrand`: a caller holding a partially
// threaded config, or a test, can call these without constructing a full profile. `brand` defaults
// to `WINTER_BRAND` at every entry point below, so a caller that has not threaded one yet keeps
// exactly today's behaviour.
export type TempBrand = Pick<BrandProfile, "envPrefix" | "tempRootName">;

export class WinterPathsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WinterPathsError";
  }
}

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_KEY_SEGMENT.test(value)) {
    throw new WinterPathsError(
      `invalid ${label} ${JSON.stringify(value)}: expected non-empty [A-Za-z0-9-]+ (no path separators or traversal)`,
    );
  }
}

// The `<root>-<user>` folder name's second half. POSIX: the real uid, as it always was; `process.getuid` is absent only
// on Windows, which takes the other branch, so a non-null assertion is right there.
//
// Windows has no uid (`process.getuid` does not exist, and `os.userInfo().uid` is -1), and the temp base there is already
// a per-user folder, but a host may point the base at one folder for several users, so the name still carries the user:
// the account name with everything outside [A-Za-z0-9-] turned into "-" (a name is not a path segment: `DOMAIN\user`,
// spaces), and "user" when the system will not say. The same account always gets the same name, so a later run finds
// its own folder. `platform` and `username` are parameters so the Windows form is tested on any system.
export function tempUserSegment(platform: NodeJS.Platform = process.platform, username?: () => string): string {
  if (platform !== "win32") return String(process.getuid!());
  let name = "";
  try {
    name = (username ?? (() => userInfo().username))();
  } catch {
    /* the account name is unavailable: the fallback below */
  }
  const segment = name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return segment === "" ? "user" : segment.slice(0, 64);
}

// Exported so the foreign-owner refusal branch is reachable without root (task-6-brief: "assert
// the CHECK exists by unit-testing the validator's branch, not by faking uid") — callers construct
// a stat-shaped object directly. Accepts a minimal duck-typed shape rather than a full fs.Stats so
// a test never needs a real Stats instance to exercise this.
export function assertOwnedDir(
  stat: Pick<Stats, "uid"> & { isDirectory(): boolean; isSymbolicLink(): boolean },
  pathForError: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (stat.isSymbolicLink()) throw new WinterPathsError(`refusing a symlink at a level Winter must own: ${pathForError}`);
  if (!stat.isDirectory()) throw new WinterPathsError(`expected a directory, found something else at: ${pathForError}`);
  // Against another local user pre-creating a level under a shared base: Unix compares the owner; Windows cannot, and paths/owner.ts says what holds there.
  if (!ownedByThisUser(stat, platform)) throw new WinterPathsError(`refusing a directory owned by a different uid: ${pathForError}`);
}

// Create-if-missing, then always lstat-validate (own uid, real directory, never a symlink — even a
// dangling one, which is why creation failure is routed through the SAME validation rather than
// trusted at face value) and self-heal the mode to exactly 0700. Every level this resolver walks
// goes through here (WS-05 §9 MUST: "0700 directories... throughout").
function ensureValidatedDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    // T6 fix-wave (doc note): a non-EEXIST failure here (EACCES, a missing/non-directory parent,
    // resource exhaustion, ...) is deliberately re-thrown UNWRAPPED — the raw Node error, not a
    // WinterPathsError. This mirrors session-store.ts's identical ensureSecureDir catch (same
    // shape, same choice): only the conditions this module actually VALIDATES (symlink, wrong
    // owner, wrong type — see assertOwnedDir below) get this module's own typed error; a plain
    // filesystem failure it never attempted to interpret is more honestly surfaced as-is than
    // repackaged into a WinterPathsError that would imply this code understood what went wrong.
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path); // lstat, never stat — a symlink (dangling or not) must be caught, not followed
  assertOwnedDir(stat, path, platformOf());
  ensureDirSeam?.(path);
  // Windows: no O_DIRECTORY / O_NOFOLLOW, and opening a folder with a plain open fails there, so the mode change
  // stays the plain chmod it was (a POSIX mode means little there anyway); the lstat validation above still holds.
  if (platformOf() === "win32") {
    chmodSync(path, 0o700);
    return;
  }
  // Idempotent self-heal — this whole chain is Winter-owned. 0.0.77: through a descriptor opened as a directory
  // with no-follow, and only when it is the folder the lstat just validated (same device and inode): a plain
  // chmod follows a link swapped in after the lstat and would set an outside folder to 0700.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new WinterPathsError(`a level Winter must own changed while it was being checked: ${path}`);
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

// Test seam: the platform `ensureValidatedDir` branches on, so the Windows branch runs in a test on any OS.
let platformOverride: NodeJS.Platform | undefined;
function platformOf(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}
export function _setTempPlatformForTests(platform: NodeJS.Platform | undefined): void {
  platformOverride = platform;
}

// Test seam: called between a level's lstat and its mode change, so a test can swap a link in. Nothing sets it in the runtime.
let ensureDirSeam: ((path: string) => void) | undefined;
export function _setEnsureDirSeamForTests(fn: ((path: string) => void) | undefined): void {
  ensureDirSeam = fn;
}

// `<PREFIX>TMPDIR` || the default base (blank = unset, same rule as `<PREFIX>HOME` — see home.ts's isUnset).
// The default base is "/tmp" on every system that has one, exactly as before (the macOS and Linux scratch folder and
// the paths the sandbox profiles and the Claude Code layout agree on do not move); on Windows, which has no `/tmp`
// (a bare "/tmp" there is the current drive's `\tmp`, which does not exist, and 0.0.83 died on it), it is the
// operating system's temp folder: `TEMP`, then `TMP`, from the env the session was given (a host's `env` replaces the
// Worker's own), then `os.tmpdir()`. `platform` is a parameter so the Windows branch is tested on any system.
// Exported so the DEFAULT can be asserted as a pure string decision in tests, never by actually
// creating directories under the real, shared /tmp/<tempRootName>-<uid> chain.
//
// P7a (D19): THE ENV NAME IS DERIVED, NEVER SPELLED, and it is read INSIDE this function — the
// brand arrives with `--config-json`, so a module-load read would bake in Winter's own prefix for a
// reuser and could never be corrected (brand-gate rules 9 and 10 pin both halves of that).
export function resolveTempBase(env?: Record<string, string | undefined>, brand?: Pick<BrandProfile, "envPrefix">, platform: NodeJS.Platform = platformOf()): string {
  const source = env ?? process.env;
  const override = source[envName(requireBrand(brand), "TMPDIR")];
  if (!isUnset(override)) return override as string;
  if (platform !== "win32") return "/tmp";
  for (const name of ["TEMP", "TMP"]) {
    const value = source[name];
    if (!isUnset(value)) return value as string;
  }
  return tmpdir();
}

export interface SessionTempDirOptions {
  tempProjectKey: string;
  backendUuid: string;
  env?: Record<string, string | undefined>;
  /** P7a (D19): the session's resolved brand. Omitted = the brand installed for this process (`requireBrand`; A1: there is no default brand). */
  brand?: TempBrand;
}

export interface SessionTempDirPaths {
  root: string;
  scratchpad: string;
  tasks: string;
}

// D18: ${realpath(<PREFIX>TMPDIR|/tmp)}/<root>-<uid>/<root>-<uid>/<tempProjectKey>/<backendUuid>/,
// where <root> is `brand.tempRootName`
// — the OUTER "<root>-<uid>" is the shared per-user root (the value handed to a spawned
// official-branch child as CLAUDE_CODE_TMPDIR, whose own hard-coded sibling becomes claude-<uid>
// alongside it); the INNER "<root>-<uid>" is Winter's own engine directory, following the
// identical <engine>-<uid>/<key>/<uuid> shape as that sibling. Only the base is realpath'd (macOS
// /tmp -> /private/tmp) — done ONCE, up front, before composing the rest of the chain; every level
// beneath it is created/validated by ensureValidatedDir above, never realpath'd again. scratchpad/
// is created eagerly here; tasks/ stays lazy (see ensureTasksDir). `uid` is always the real
// process uid (process.getuid()) — never injectable, never a fixed literal: a fixed suffix would
// let one user's 0700 root lock out every other user on a shared machine. On Windows, which has no uid, the suffix is
// the account name (`tempUserSegment`), for the same reason.
export function sessionTempDir(opts: SessionTempDirOptions): SessionTempDirPaths {
  assertSafeSegment(opts.tempProjectKey, "tempProjectKey");
  assertSafeSegment(opts.backendUuid, "backendUuid");

  const brand = requireBrand(opts.brand);
  const base = realpathSync(resolveTempBase(opts.env, brand));
  const uid = tempUserSegment(platformOf());
  const sharedRoot = join(base, `${brand.tempRootName}-${uid}`);
  const engineDir = join(sharedRoot, `${brand.tempRootName}-${uid}`);
  const projectDir = join(engineDir, opts.tempProjectKey);
  const sessionDir = join(projectDir, opts.backendUuid);
  const scratchpad = join(sessionDir, "scratchpad");
  const tasks = join(sessionDir, "tasks");

  for (const level of [sharedRoot, engineDir, projectDir, sessionDir, scratchpad]) {
    ensureValidatedDir(level);
  }

  return { root: sessionDir, scratchpad, tasks };
}

// Lazy tasks/ creation (WS-05 §9/§10: "tasks/ is a sibling of scratchpad/, created lazily at first
// task"). First call creates + validates it; later calls are a validated no-op that returns the
// same path.
export function ensureTasksDir(paths: Pick<SessionTempDirPaths, "tasks">): string {
  ensureValidatedDir(paths.tasks);
  return paths.tasks;
}
