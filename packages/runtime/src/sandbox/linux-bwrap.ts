// Clover's Linux sandbox for a shell command (Bash, Monitor, background Bash): bubblewrap, beside the macOS Seatbelt
// profile (profile.ts), with the same policy. Lane A wrote it after lane C's bubblewrap fence (Clover's
// `fence/linux-bwrap.ts` and `fence/seccomp.ts`, lanes C-M2 and C-M3), which C reviews.
//
// THE POLICY, against the Seatbelt profile it mirrors (`buildSeatbeltProfile`):
//
//   macOS (sandbox-exec)                          Linux (bubblewrap)
//   --------------------------------------------  ----------------------------------------------------------------
//   (allow file-read*)                            `--ro-bind / /`: everything readable, nothing writable
//   (allow file-write* <cwd and writableRoots>)   `--bind r r` for each root that exists
//   (deny file-write* <denyWrite, the defaults,   an existing one is bound read-only again (`--ro-bind p p`); a missing
//    the control plane, the home floor…>)          one can't be: the nearest folder that exists inside a root becomes a
//                                                  "naming folder", read-only with its present children bound back
//                                                  writable, so nothing new appears there (it fails closed)
//   the ancestor-rename fence                     every folder between a root and a denied path is bound onto itself:
//                                                  a mount point, so renaming or removing it fails (EBUSY)
//   (deny file-read* <denyRead, run/, the         an existing folder gets an empty `--tmpfs`, a file `/dev/null`
//    provider-state files>)                        bound over it (both mount points, so they stay in place)
//   (deny network*)                               `--unshare-net`
//   (nothing)                                     a seccomp filter on every command, network or not: no
//                                                  `socket(AF_UNIX)` (a namespace doesn't cover the sockets the root
//                                                  still shows under /run, /var/run and /tmp) and no io_uring
//   (deny default) for processes                  its own pid, ipc, uts and cgroup namespaces, `--new-session` (no
//                                                  TIOCSTI), `--die-with-parent`, every capability dropped, and no
//                                                  user namespace inside (`--unshare-user --disable-userns`, bwrap
//                                                  0.8+; probed)
//   (nothing: macOS has no such paths)            /run/user (the session's sockets, D-Bus included), /media,
//                                                  /run/media and /mnt hidden; DBUS_SESSION_BUS_ADDRESS and
//                                                  XDG_RUNTIME_DIR unset
//
// WHAT A MOUNT CAN'T SAY (the residuals, as lane C's fence records them):
//  * A pattern (a glob-shaped denyWrite/denyRead, the control-plane and default-protection names at any depth, the
//    provider-state file names) is matched against what is on disk when the command starts (`expandPattern`,
//    bounded): a match made later by the command itself isn't covered. The direct literals (`<cwd>/.git/hooks`,
//    `<root>/<projectDir>/settings.json`…) are covered whether or not they exist, through the naming folders.
//  * A denied path that doesn't exist yet, directly in a writable root or in a `.git` folder, can be created: holding
//    the root or `.git` read-only for new names would stop the command's own work (`unheld`). Everywhere else the
//    nearest existing folder is held. Every tool call's own permission check still applies; this is the shell's gap.
//  * A denied path is matched by name, case-sensitively (Seatbelt ignores case; Linux file systems mostly don't).
//
// Never silent: with no bubblewrap at a system path, a probe that fails, or an architecture the seccomp filter doesn't
// know, the command is refused (`SandboxUnavailableError`), as on a Mac without sandbox-exec.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

/** Where bubblewrap is looked for: system paths only, never PATH (anything that can set PATH could plant one). */
export const BWRAP_SYSTEM_PATHS = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] as const;

/** Paths hidden from every command (an empty tmpfs over each that exists): the login session's sockets, D-Bus's
 *  included, and removable and mounted media. */
export const LINUX_HIDDEN_PATHS = ["/run/user", "/media", "/run/media", "/mnt"] as const;

/** Variables the command never gets: the user's session bus and runtime folder (hidden above). */
export const LINUX_UNSET_ENV = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;

/** The child's fd the seccomp filter is read from (`--seccomp 3`). */
export const SECCOMP_FD = 3;

/** The first system path that holds bubblewrap, or undefined. */
export function findBwrap(exists: (p: string) => boolean = existsSync): string | undefined {
  return BWRAP_SYSTEM_PATHS.find((p) => exists(p));
}

const disableUsernsCache = new Map<string, boolean>();
/** Whether this bubblewrap has `--disable-userns` (0.8.0 and later), from its `--help`, once per binary. */
export function bwrapHasDisableUserns(bin: string): boolean {
  let known = disableUsernsCache.get(bin);
  if (known === undefined) {
    const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5_000 });
    known = `${r.stdout ?? ""}${r.stderr ?? ""}`.includes("--disable-userns");
    disableUsernsCache.set(bin, known);
  }
  return known;
}

const workingCache = new Map<string, boolean>();
/** Whether bubblewrap can start a sandbox here at all (user namespaces allowed, its AppArmor profile in place):
 *  a probe that runs `true` in the base shape, once per binary. */
export function bwrapWorks(bin: string): boolean {
  let known = workingCache.get(bin);
  if (known === undefined) {
    const r = spawnSync(bin, ["--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"], { timeout: 10_000, stdio: "ignore" });
    known = r.status === 0;
    workingCache.set(bin, known);
  }
  return known;
}

/** Test seam: forgets what the probes found. */
export function resetBwrapProbesForTest(): void {
  disableUsernsCache.clear();
  workingCache.clear();
}

/**
 * The seccomp filter every command runs under (classic BPF, `struct sock_filter[]`), lane C's (`fence/seccomp.ts`):
 * `socket(AF_UNIX, …)` and `io_uring_setup` fail with EPERM, and so does every call of another architecture (a 32-bit
 * binary's) or with the x32 bit, so no Unix socket on the disk can be reached. `socketpair` stays, for pipes between
 * the command's own processes. Null where the architecture isn't x64 or arm64: the command is then refused.
 */
export function unixSocketFilter(arch: string = process.arch): Buffer | null {
  const t = arch === "x64" ? { audit: 0xc000003e, socket: 41 } : arch === "arm64" ? { audit: 0xc00000b7, socket: 198 } : null;
  if (t === null) return null;
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, ALLOW = 0x7fff0000, EPERM = 0x00050001, IO_URING_SETUP = 425, AF_UNIX = 1, X32 = 0x40000000;
  const prog: [number, number, number, number][] = [
    [LD, 0, 0, 4], //               0: the architecture
    [JEQ, 0, 7, t.audit], //        1: another one: EPERM (9)
    [LD, 0, 0, 0], //               2: the call
    [JGE, 5, 0, X32], //            3: x32 numbers: EPERM (9)
    [JEQ, 4, 0, IO_URING_SETUP], // 4: EPERM (9)
    [JEQ, 0, 2, t.socket], //       5: not socket(): allow (8)
    [LD, 0, 0, 16], //              6: its first argument, the domain (low 32 bits)
    [JEQ, 1, 0, AF_UNIX], //        7: AF_UNIX: EPERM (9), else allow (8)
    [RET, 0, 0, ALLOW], //          8
    [RET, 0, 0, EPERM], //          9
  ];
  const b = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => {
    b.writeUInt16LE(code, i * 8);
    b.writeUInt8(jt, i * 8 + 2);
    b.writeUInt8(jf, i * 8 + 3);
    b.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return b;
}

/** The disk as the plan reads it (a test seam). */
export interface BwrapFs {
  kind(path: string): "dir" | "file" | "other" | null;
  list(dir: string): string[];
}

export const realBwrapFs: BwrapFs = {
  kind(path) {
    try {
      const s = lstatSync(path);
      return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export interface BwrapPlanInput {
  /** The writable roots (the cwd first), canonical. */
  writableRoots: readonly string[];
  /** Paths no command may write (a folder: nothing under it), canonical; missing ones too. */
  denyWrite: readonly string[];
  /** Paths no command may read, canonical; missing ones need nothing. */
  denyRead: readonly string[];
  allowNetwork: boolean;
  /** Where the command starts. */
  cwd: string;
  /** `--unshare-user --disable-userns` (bwrap 0.8+). */
  disableUserns: boolean;
  /** Pass `--seccomp <SECCOMP_FD>`. */
  seccomp: boolean;
  fs?: BwrapFs;
  /** Paths hidden from the command (default `LINUX_HIDDEN_PATHS`). */
  hidden?: readonly string[];
}

/** A folder held read-only for new names, because a denied path in it isn't there yet. */
export interface HeldFolder {
  readonly folder: string;
  readonly because: string;
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root === "/" ? "/" : `${root}/`);

/** bubblewrap's arguments up to (not including) the command, the folders held for missing denied paths, and the
 *  missing denied paths no folder could be held for (`unheld`: creatable, see the header's residuals). */
export function buildBwrapPlan(input: BwrapPlanInput): { args: string[]; held: HeldFolder[]; unheld: string[] } {
  const fs = input.fs ?? realBwrapFs;
  const held: HeldFolder[] = [];
  const roots = [...new Set(input.writableRoots)].filter((r) => fs.kind(r) === "dir");
  const inRoot = (p: string): boolean => roots.some((r) => inside(p, r));
  const a: string[] = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    ...(input.disableUserns ? ["--unshare-user", "--disable-userns"] : []),
    ...(input.allowNetwork ? [] : ["--unshare-net"]),
    "--cap-drop", "ALL",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  ];
  for (const h of input.hidden ?? LINUX_HIDDEN_PATHS) if (fs.kind(h) === "dir") a.push("--tmpfs", h);
  for (const r of roots) a.push("--bind", r, r);

  // Only what is inside a writable root needs a deny: the rest is read-only already.
  const denyWrite = [...new Set(input.denyWrite)].filter(inRoot);
  const fenced = new Set(denyWrite);
  // A denied path that isn't there yet can't be bound: its nearest existing folder inside a root is held (read-only,
  // its present children bound back writable), so nothing new appears there. Never a root itself (the command
  // couldn't make a file in its own folder) nor a `.git` folder (git makes new names there on every commit): a missing
  // path whose nearest folder is one of those stays creatable, a residual the plan reports (`unheld`).
  const naming = new Set<string>();
  const unheld: string[] = [];
  for (const d of denyWrite) {
    if (fs.kind(d) !== null) continue;
    let p = dirname(d);
    while (fs.kind(p) === null && p !== dirname(p)) p = dirname(p);
    if (!inRoot(p) || roots.includes(p) || basename(p) === ".git") {
      unheld.push(d);
      continue;
    }
    if (!naming.has(p)) held.push({ folder: p, because: d });
    naming.add(p);
  }
  // The ancestor-rename fence: every folder between a root and a denied path (written or read) is a mount point.
  const readDenied = [...new Set(input.denyRead)].filter((d) => fs.kind(d) !== null);
  const holders = new Set<string>();
  for (const d of [...denyWrite, ...readDenied]) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) {
      if (!inRoot(p) || roots.includes(p)) break;
      if (!naming.has(p)) holders.add(p);
    }
  }
  const byDepth = (x: string, y: string): number => x.split("/").length - y.split("/").length || (x < y ? -1 : x > y ? 1 : 0);
  for (const h of [...holders].sort(byDepth)) if (fs.kind(h) === "dir") a.push("--bind", h, h);
  for (const n of [...naming].sort(byDepth)) {
    if (fs.kind(n) !== "dir") continue;
    a.push("--ro-bind", n, n);
    for (const name of fs.list(n).sort()) {
      const c = join(n, name);
      if (fenced.has(c) || naming.has(c) || denyWrite.some((d) => inside(d, c))) continue;
      const k = fs.kind(c);
      if (k === "dir" || k === "file") a.push("--bind", c, c);
    }
  }
  for (const d of [...denyWrite].sort(byDepth)) {
    const k = fs.kind(d);
    if (k === "dir" || k === "file") a.push("--ro-bind", d, d);
  }
  // Read denies last: nothing above may show them again. A writable root inside one is bound back after it (it is
  // writable; Seatbelt's write re-permit does the same).
  for (const d of readDenied.sort(byDepth)) {
    const k = fs.kind(d);
    if (k === "dir") a.push("--tmpfs", d);
    else a.push("--ro-bind", "/dev/null", d);
    for (const r of roots) if (r !== d && inside(r, d)) a.push("--bind", r, r);
  }
  for (const v of LINUX_UNSET_ENV) a.push("--unsetenv", v);
  a.push("--chdir", input.cwd);
  if (input.seccomp) a.push("--seccomp", String(SECCOMP_FD));
  return { args: a, held, unheld };
}

/** The note a command gets on stderr when it failed to write into a held folder (lane C's `heldFolderNote`). */
export function heldFolderNote(held: readonly HeldFolder[]): string {
  if (held.length === 0) return "";
  return `\n[sandbox] read-only here, so nothing new can be made in it (a protected path in it doesn't exist yet): ${held.map((h) => `${h.folder} (for ${h.because})`).join(", ")}\n`;
}

/** For each of `regexes`, the existing paths under `prefix` it matches: one walk, at most `maxVisited` entries and
 *  `maxDepth` levels down, skipping `node_modules`; a matched folder isn't walked into (the deny covers it). What a
 *  mount can bind of a pattern-shaped deny (see the header's residuals). */
export function expandPatterns(prefix: string, regexes: readonly RegExp[], o: { fs?: BwrapFs; maxVisited?: number; maxDepth?: number; skip?: ReadonlySet<string> } = {}): string[][] {
  const fs = o.fs ?? realBwrapFs;
  const maxVisited = o.maxVisited ?? 50_000, maxDepth = o.maxDepth ?? 16, skip = o.skip ?? new Set(["node_modules"]);
  const out: string[][] = regexes.map(() => []);
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const name of fs.list(dir)) {
      if (++visited > maxVisited) return;
      const p = join(dir, name);
      let matched = false;
      regexes.forEach((re, i) => {
        if (re.test(p)) {
          out[i]!.push(p);
          matched = true;
        }
      });
      if (!matched && !skip.has(name) && fs.kind(p) === "dir") walk(p, depth + 1);
    }
  };
  if (fs.kind(prefix) === "dir") walk(prefix, 0);
  return out;
}
