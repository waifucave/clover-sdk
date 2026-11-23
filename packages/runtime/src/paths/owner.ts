import type { Stats } from "node:fs";

// Whose is this folder? The one owner check the runtime's folder levels share (the session temp chain in `temp.ts`, the
// permission journal in `permissions/ruleset.ts`, the durable approvals in `permissions/approvals.ts`, the auto-mode
// counters in `permissions/auto/caches.ts`). The sdk's own transcript store keeps its own copy of this function, as it
// keeps its own copy of the rest of the level walk (its package exports no subpath to import it from).
//
// WHAT IT PROTECTS (Unix). Every level of a chain the runtime writes through (`<tmp>/<root>-<uid>/...`, and
// `<home>/projects/<key>/...`) is created with mode 0700 by the runtime. A level that already exists and belongs to
// another user was made by that user, not by the runtime: under a shared base such as `/tmp` that is the way to plant a
// folder (or a link inside it) the runtime would then write transcripts, approvals and scratch files through. The
// runtime refuses it. Nothing changes here on Unix: the same `getuid()` comparison, and a platform without `getuid` that
// is not Windows still throws rather than pass.
//
// WINDOWS HAS NO SUCH THING TO COMPARE. Node and Bun report `uid` 0 for every file there (libuv has no owner to give),
// and `process.getuid` does not exist; there is no cheap way to read an NTFS owner SID from the runtime. So the owner
// comparison is skipped on win32, and what holds instead is, in order: (1) the bases the runtime picks by default are
// per-user folders whose ACL other standard users cannot write into (`%TEMP%`, normally `%LOCALAPPDATA%\Temp`, and the
// home under `%USERPROFILE%`); (2) the chain's own folder name carries the user's name (`tempUserSegment`); (3) the
// symlink check stays, and lstat reports a junction as a link too, so a planted junction or symbolic link is refused as
// on Unix. WHAT DOES NOT HOLD: a host that points the temp base or the home at a folder shared between users
// (`WINTER_TMPDIR=C:\Temp`) gets no owner protection on Windows; a host should not do that.
//
// `platform` is a parameter so the Windows branch runs in a test on any system.
export function ownedByThisUser(stat: Pick<Stats, "uid">, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return true;
  return stat.uid === process.getuid!(); // POSIX: as it was. No `getuid` here is a bug to surface, never a pass.
}
