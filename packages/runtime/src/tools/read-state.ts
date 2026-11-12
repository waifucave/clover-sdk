// WS-06 §3.1's read-before-edit ladder (Lane B, Task 5) needs to know, PER SESSION, which files
// have already been read this session and how completely -- "older model families require a
// complete in-session read... a changed-since-read file is editable when the exact current match is
// unambiguous." SessionReadState is the seam the task-1 brief pins (verbatim); this module supplies
// the one production implementation the engine constructs once per run (registry.ts's
// buildRegistryToolExecutor takes it as a dependency, never constructs its own).
//
// Ruling P3-D (spine amendment; Lane B Task 5 fix-round concern 3): Lane A (Read/Glob/Grep) and Lane
// B (Edit/Write/NotebookEdit) are two INDEPENDENT executor lanes that both populate/consume this one
// seam, and nothing forces them to agree on a path CONVENTION -- Lane B keys by lexical
// `path.resolve`, Lane A may realpath. On macOS a lexical resolve and a realpath of the identical
// logical file disagree the moment any ancestor is a symlink (e.g. `/tmp` -> `/private/tmp`), so a
// lexically-keyed recordRead("/tmp/x") would silently never satisfy a realpath'd
// lookup("/private/tmp/x"), or vice versa -- a correctness gap the read-before-edit ladder would
// fail closed on (treating an actually-read file as never-read) without ever raising an error.
// Rather than mandate a convention on every current and future caller (unenforceable -- nothing
// stops a third lane from getting it wrong too), this seam now canonicalizes every key ITSELF, so
// caller convention is irrelevant: `canonicalKey` resolves a relative path against the `cwd` fixed
// at construction time (see SessionReadStateOptions below -- a per-call cwd would let two calls for
// what the caller believes is "the same relative path" silently key differently within one session),
// then reuses permissions/paths.ts's own `resolveRealTarget` -- realpath-with-graceful-fallthrough
// for a not-yet-existing suffix (e.g. a file about to be Written, which cannot exist yet) -- rather
// than forking that algorithm a second time. Read/Edit/Write's own executors may still pass whatever
// spelling they have on hand -- lexical, realpath'd, relative, it no longer matters, which is the
// point. (`tools/paths-seam.ts` is a different module entirely -- a lexical-only, no-realpath
// resolve-and-dedupe helper for Bash's approval-matching path extraction; it solves a different
// problem and is not reused here.)
import { isAbsolute, join, normalize } from "node:path";
import { resolveRealTarget } from "../permissions/paths.ts";

export interface ReadRecord {
  complete: boolean;
  mtimeMs: number;
  /** Guest descriptor identity; mtime alone cannot detect replaced files or same-timestamp edits. */
  fileVersion?: string;
  /**
   * 0.0.80: the lines the model has seen of this version of the file, 1-based and inclusive, merged. Absent with
   * `complete: false`: nothing line-shaped is known (an image, a PDF, a notebook). `complete: true` covers every line.
   */
  ranges?: ReadonlyArray<readonly [number, number]>;
  /**
   * 0.0.80: the file's text as the model last saw it (a Read, or its own Edit/Write), so a change made outside the file
   * tools (a `sed` in the shell) can be shown to it as the lines that changed. Kept up to `READ_CONTENT_MAX` characters.
   */
  content?: string;
}

/** 0.0.80: the largest text a read record keeps for showing later changes (characters). */
export const READ_CONTENT_MAX = 1_000_000;

/** 0.0.80: merged line ranges (1-based, inclusive), sorted, adjacent ones joined. */
export function mergeRanges(ranges: Iterable<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...ranges].filter(([a, b]) => a >= 1 && b >= a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 0.0.80: a new read of a file joins what was already read of the SAME version (its lines add up: two partial reads
 * cover both windows); a read of a changed file replaces the old record. Same version: the same `fileVersion` (guest)
 * or mtime, and the same text where both kept it (a same-second change keeps the mtime).
 */
export function mergeReadRecord(prev: ReadRecord | undefined, next: ReadRecord): ReadRecord {
  if (prev === undefined) return { ...next };
  const sameVersion = prev.fileVersion !== undefined && next.fileVersion !== undefined ? prev.fileVersion === next.fileVersion : prev.mtimeMs === next.mtimeMs;
  const sameText = prev.content === undefined || next.content === undefined || prev.content === next.content;
  if (!sameVersion || !sameText) return { ...next };
  const complete = prev.complete || next.complete;
  const ranges = complete ? undefined : prev.ranges !== undefined || next.ranges !== undefined ? mergeRanges([...(prev.ranges ?? []), ...(next.ranges ?? [])]) : undefined;
  const content = next.content ?? prev.content;
  return { ...next, complete, ...(ranges !== undefined ? { ranges } : {}), ...(content !== undefined ? { content } : {}) };
}

export interface SessionReadState {
  recordRead(p: string, o: ReadRecord): void;
  lookup(p: string): ReadRecord | undefined;
}

export interface SessionReadStateOptions {
  // Base a relative path passed to recordRead/lookup resolves against. Construction-time only
  // (never per-call, see the ruling note above) so a session's keying stays internally consistent.
  // WS-23: REQUIRED -- it used to default to `process.cwd()`, which for an embedded session (a Worker
  // inside a host daemon) is the DAEMON's cwd, never the session's. The one production caller
  // (engine.ts) passes `config.cwd`.
  cwd: string;
}

// A fresh, empty, in-memory read history -- engine.ts constructs exactly one of these per run
// (session-scoped lifetime, mirroring how PolicyStateStore/hookRegistry are also built once per
// run) and threads it into every ToolExecutionContext that run ever builds.
export function createSessionReadState(opts: SessionReadStateOptions): SessionReadState {
  const cwd = opts.cwd;
  const reads = new Map<string, ReadRecord>();

  function canonicalKey(p: string): string {
    const abs = isAbsolute(p) ? p : join(cwd, p);
    return resolveRealTarget(normalize(abs));
  }

  return {
    recordRead(p, o) {
      const key = canonicalKey(p);
      reads.set(key, mergeReadRecord(reads.get(key), o));
    },
    lookup(p) {
      return reads.get(canonicalKey(p));
    },
  };
}
