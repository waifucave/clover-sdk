// WS-06 §3.1 -- the shared read-before-edit ladder, implemented ONCE here and consumed by all three
// Lane B tools (edit.ts, write.ts, notebook-edit.ts). Every one of them asks the SAME question --
// "given what this session knows about this path, and what a probe read would do right now, may this
// operation proceed?" -- so the decision lives in exactly one place rather than three near-identical
// copies that would inevitably drift.
//
// THE THREE MUTUALLY EXCLUSIVE STATES a target path can be in, per `ctx.readState.lookup(path)`:
//   1. No record at all                              -- "unread"
//   2. A record whose mtimeMs === the CURRENT mtime   -- "cleanly read" (further split by `complete`)
//   3. A record whose mtimeMs !== the CURRENT mtime   -- "changed since read" (drifted)
// These states, plus the `readLadderProfile` family knob and the operation's own shape, are composed
// into exactly four rungs, checked in this fixed order:
//
//   RUNG 1 (both profiles, any operation): a COMPLETE read that is still FRESH (mtime unchanged)
//     always satisfies the ladder. This is the base case every other rung is an escape hatch FROM.
//
//   THE WRITE-OVERWRITE-ONLY OVERRIDE (advisor-adjudicated scope, see below): a notebook target, or
//     an existing-but-PARTIAL read record, collapses the ladder to rung 1 ONLY for an "overwrite"
//     operation -- no unread-file shortcut (rung 2), no drift rescue (rung 3). WS-06 §3.1's Write
//     paragraph is the ONLY place this sentence appears ("notebooks and partially-read files always
//     need a complete read"), immediately after "same ladder as Edit for existing files" -- i.e. it
//     is a carve-OUT from Edit's ladder, not a universal rule. Report §40.45 confirms the scope
//     independently: Write inherits only the *unread* condition from Edit ("may overwrite an unread
//     existing file only under the same ... conditions as Edit"), never the drift-rescue sentence,
//     which report §40.8 (Edit) states with no profile/family qualifier of its own. Concretely: this
//     override is NEVER consulted for `operation: "edit"` -- plain Edit and NotebookEdit both stay on
//     rungs 1/2/3 even against a notebook path or a partial prior read.
//     LOAD-BEARING REASON this override must exist at all (why "partially-read" isn't already
//     covered by rung 2 below): without it, an existing-but-partial record would be indistinguishable
//     from "no record" and would ride the exact same relaxed/silent-probe shortcut rung 2 grants an
//     unread file -- making the WS-06 sentence dead code. This override is what makes it real.
//
//   RUNG 3 (both profiles, "edit" operation only): a record EXISTS but has drifted (mtime changed).
//     Rescued when the CURRENT on-disk content's match is unambiguous (Edit's own `old_string`
//     search, computed by the caller against what is on disk RIGHT NOW, independent of what was read)
//     AND a fresh Read of this path would resolve silently. Never available to "overwrite" (Write has
//     no substring-match concept -- nothing to be "unambiguous" about) or to NotebookEdit (cell
//     identity is matched by id, not content) -- both simply omit `hasUnambiguousCurrentMatch`, which
//     structurally forces this rung closed for them without any special-casing.
//
//   RUNG 2 ("relaxed" profile only, any operation not already forced into the override above): never
//     read, or read only partially with no drift -- a "newer model family" may still proceed when
//     Read is available (Winter's `Read` is an unconditional, always-advertised implement-now
//     builtin -- WS-06 §3.1/§2 -- so this is a structural truth here, never a registry lookup; a
//     registry lookup would also be WRONG in-process during Phase 3, since Lane A's own Read
//     executor lands in a sibling worktree this lane never imports) and reading this exact path RIGHT
//     NOW would resolve SILENTLY.
//     RULING P3-B (binding): the ONLY value that satisfies this is `probeReadAccess(...) === "silent"`.
//     `"prompt"` (a real Read here would need interaction) and `"deny"` (a real Read here would be
//     rejected) both fail closed -- never treated as "safe to skip the read."
//
// `readLadderProfile` (strict | relaxed, default "strict") is the R3-4-style family knob: a
// declarative seam nothing populates yet (progress ledger: "readLadderProfile ... P6 carry" --
// provider/model-family catalog work). Every call site in this lane omits it, relying on the
// "strict" default, exactly like `AdvertisedSetInputs.familyMetadata` (registry.ts) reads absent as
// its own conservative default today. This module cannot itself grow a field on ToolDescriptor or
// ToolExecutionContext to carry the resolved value (both live in registry.ts, off-limits to every
// lane per R3-5) -- so the seam is this function's own optional parameter, exactly as buildable now
// as it will be once a real caller resolves something other than the default.
import { mergeRanges, READ_CONTENT_MAX, type SessionReadState } from "../read-state.ts";
import { lineChanges, linesOf } from "../line-changes.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";

export type ReadLadderProfile = "strict" | "relaxed";
export const DEFAULT_READ_LADDER_PROFILE: ReadLadderProfile = "strict";

// "edit" = a targeted, verifiable delta (Edit's old_string/new_string; NotebookEdit's per-cell
// replace/insert/delete) -- eligible for rungs 1/2/3. "overwrite" = Write's whole-file replace, which
// has no match concept of its own -- eligible for rungs 1/2 only, and subject to the override above.
export type ReadLadderOperation = "edit" | "overwrite";

export interface ReadLadderInput {
  // MUST already be the resolved, absolute path the caller actually opened/will open -- this module
  // performs no resolution of its own (read-state.ts's own header: keying is the executor's job).
  filePath: string;
  // The target's CURRENT on-disk mtime (milliseconds), as of THIS call -- the caller stats the file
  // itself; this module never touches the filesystem (kept synchronous and side-effect-free so it is
  // trivially unit-testable against a bare SessionReadState, with no fixture files at all).
  currentMtimeMs: number;
  currentFileVersion?: string;
  operation: ReadLadderOperation;
  // Edit-only (see RUNG 3 above): does `old_string` currently match EXACTLY ONCE against the
  // target's CURRENT on-disk content? Omit for "overwrite" and for NotebookEdit's "edit" calls --
  // both have no match concept, and omitting (rather than passing `false`) is what keeps rung 3
  // closed for them without a second, redundant flag.
  hasUnambiguousCurrentMatch?: boolean;
  profile?: ReadLadderProfile;
}

export interface ReadLadderDeps {
  readState: SessionReadState;
  probeReadAccess: (filePath: string) => ReadAccessProbe;
}

export type ReadLadderDecision = { eligible: true } | { eligible: false; reason: string };

function isNotebookPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".ipynb");
}

export function evaluateReadLadder(input: ReadLadderInput, deps: ReadLadderDeps): ReadLadderDecision {
  const profile = input.profile ?? DEFAULT_READ_LADDER_PROFILE;
  const record = deps.readState.lookup(input.filePath);

  const fresh = record !== undefined && (input.currentFileVersion !== undefined ? record.fileVersion === input.currentFileVersion : record.mtimeMs === input.currentMtimeMs);
  // Rung 1.
  if (record !== undefined && record.complete && fresh) {
    return { eligible: true };
  }

  // The Write-overwrite-only override -- see module header for why this is scoped to "overwrite".
  if (input.operation === "overwrite" && (isNotebookPath(input.filePath) || (record !== undefined && !record.complete))) {
    return {
      eligible: false,
      reason: `"${input.filePath}" needs a complete, up-to-date read before it can be overwritten -- notebooks and partially-read files always require a fresh, complete read first`,
    };
  }

  // Rung 3: a record exists but has drifted (mtime changed since it was taken).
  if (record !== undefined && !fresh) {
    if (input.operation === "edit" && input.hasUnambiguousCurrentMatch === true && deps.probeReadAccess(input.filePath) === "silent") {
      return { eligible: true };
    }
    return {
      eligible: false,
      reason: `"${input.filePath}" has changed on disk since it was last read in this session -- read it again before editing`,
    };
  }

  // Rung 2: never read, or read only partially with no drift.
  if (profile === "relaxed" && deps.probeReadAccess(input.filePath) === "silent") {
    return { eligible: true };
  }
  return {
    eligible: false,
    reason: `"${input.filePath}" has not been read in this session -- read it first`,
  };
}

// After a successful Edit/Write/NotebookEdit, the executor knows strictly MORE about the file's
// current content than it did a moment ago -- recording that here is what keeps a same-session
// SEQUENCE of edits on the same path off the drift rung. Without this, the tool's own write would
// immediately invalidate its own prior read via mtime drift, and the very next call on the same path
// would need a fresh Read (or a relaxed silent probe) just to continue a chain the caller never
// actually left.
//
// "full" (Write only) always records complete:true -- the new content is 100% author-known,
// regardless of how much of the PREVIOUS content was ever seen. "carryForward" (Edit/NotebookEdit --
// a targeted delta applied ON TOP OF whatever was already known) preserves the PRE-OPERATION
// completeness verbatim: a prior complete read plus one known, applied delta is still complete; a
// prior partial/absent read is still not. Honesty nuance flagged for T8: this treats "was complete,
// but the on-disk file had ALSO drifted from an external actor before this edit landed" the same as
// an ordinary complete carry-forward once the edit itself succeeds (rung 3 already required the
// drifted content's match to be unambiguous to get here at all, which is the load-bearing safety
// check -- this function only ever runs after that has already passed).
export type PostOperationReadKind = "full" | "carryForward";

export function recordPostOperationRead(deps: ReadLadderDeps, filePath: string, kind: PostOperationReadKind, mtimeMs: number): void {
  const complete = kind === "full" ? true : deps.readState.lookup(filePath)?.complete === true;
  deps.readState.recordRead(filePath, { complete, mtimeMs });
}

// =====================================================================================================================
// 0.0.80: THE READ RULE BY MODEL CLASS (the owner's ruling, 2026-11-12: "strong and medium models would be like you
// matching all 3"; weak models "would get the restriction of reading the part they want to edit first").
//
// The class is the session's model RIGHT NOW (`ToolExecutionContext.editStrength`, from its catalog row's hand-set
// `strength`; absent is weak), so a model switch mid-session changes the rule from the next call.
//
//   strong / medium: no read needed before an edit, a partial read is enough, and a file changed on disk since the
//     model last saw it is edited anyway when `old_string` still matches uniquely (the caller's own match check);
//     the changed lines come back in the result (`note`). Never a refusal for any of the three.
//   weak: the lines the edit changes (each line `old_string` spans; for a Write, every line) must lie inside what the
//     model has read of the file since it last changed: any partial reads that cover them count, and after a change on
//     disk the changed lines it is handed count as read. Outside that, refused with the line range to read.
//
// ONE GATE STAYS FOR EVERY CLASS: skipping the read (an edit of lines never read, or the changed lines handed over)
// shows the model file text, so it is allowed only where a Read of this path would itself be silent
// (`probeReadAccess(...) === "silent"`): a path whose Read would ask or be refused still needs that Read first. The
// fence, the deny lists and the sandbox are checked before this rule and are not changed by it.
// =====================================================================================================================

export type EditStrength = "strong" | "medium" | "weak";

export interface EditReadInput {
  /** The resolved path the caller opened (see `ReadLadderInput.filePath`). */
  filePath: string;
  currentMtimeMs: number;
  currentFileVersion?: string;
  /** "edit" (Edit), "overwrite" (Write over an existing file), "notebook-edit" (NotebookEdit: cells, not lines). */
  operation: "edit" | "overwrite" | "notebook-edit";
  /** The class of the turn's model; absent is weak. */
  strength?: EditStrength;
  /** The file's text as it is on disk now (Edit and Write). */
  currentContent?: string;
  /** Edit: what it replaces, and whether every occurrence. */
  oldString?: string;
  replaceAll?: boolean;
}

export type EditReadDecision = { eligible: true; note?: string } | { eligible: false; reason: string };

/** The most changed lines a note shows; the rest are named, not shown (and are not counted as read). */
const NOTE_MAX_LINES = 60;
const NOTE_MAX_CHARS = 6_000;

function fmtRange([a, b]: readonly [number, number]): string {
  return a === b ? `line ${a}` : `lines ${a}-${b}`;
}

/** `ranges` minus `covered` (both 1-based inclusive, merged). */
function uncovered(ranges: ReadonlyArray<readonly [number, number]>, covered: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    let start = a;
    for (const [c, d] of covered) {
      if (d < start || c > b) continue;
      if (c > start) out.push([start, Math.min(b, c - 1)]);
      start = Math.max(start, d + 1);
      if (start > b) break;
    }
    if (start <= b) out.push([start, b]);
  }
  return out;
}

/** The lines (1-based, inclusive) each counted occurrence of `needle` spans in `text`. */
function linesOfOccurrences(text: string, needle: string, all: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lineAt = (index: number) => { let n = 1; for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++; return n; };
  for (let at = text.indexOf(needle); at !== -1; at = all ? text.indexOf(needle, at + needle.length) : -1) {
    out.push([lineAt(at), lineAt(at + Math.max(needle.length - 1, 0))]);
  }
  return mergeRanges(out);
}

/** The note a model is handed when the file changed on disk since it last saw it, and the lines it showed. */
function changeNote(filePath: string, before: string, after: string): { note: string; shown: Array<[number, number]> } {
  const ch = lineChanges(before, after);
  const lines = linesOf(after);
  const shownLines: number[] = [];
  const body: string[] = [];
  let chars = 0;
  let hidden = 0;
  for (const [a, b] of ch.changed) {
    for (let n = a; n <= b; n++) {
      const text = `${n}\t${lines[n - 1] ?? ""}`;
      if (shownLines.length >= NOTE_MAX_LINES || chars + text.length > NOTE_MAX_CHARS) { hidden++; continue; }
      body.push(text);
      chars += text.length + 1;
      shownLines.push(n);
    }
  }
  const removed = ch.removed.map((r) => `${r.count} line${r.count === 1 ? "" : "s"} removed ${r.after === 0 ? "at the top" : `after line ${r.after}`}`);
  const parts = [`"${filePath}" changed on disk since you last saw it (outside these file tools).`];
  if (body.length > 0) parts.push(`Its changed lines now read:\n${body.join("\n")}`);
  if (hidden > 0) parts.push(`${hidden} more changed line${hidden === 1 ? " is" : "s are"} not shown here: Read the file to see ${hidden === 1 ? "it" : "them"}.`);
  if (removed.length > 0) parts.push(`${removed.join("; ")}.`);
  if (body.length === 0 && removed.length === 0) parts.push("Its lines are the same; only its timestamp moved.");
  return { note: parts.join("\n"), shown: mergeRanges(shownLines.map((n) => [n, n] as [number, number])) };
}

export function evaluateEditRead(input: EditReadInput, deps: ReadLadderDeps): EditReadDecision {
  const strength = input.strength ?? "weak";
  const path = input.filePath;
  const record = deps.readState.lookup(path);
  let silentCache: boolean | undefined;
  const silent = () => (silentCache ??= deps.probeReadAccess(path) === "silent");
  const sameVersion = record !== undefined && (input.currentFileVersion !== undefined && record.fileVersion !== undefined ? record.fileVersion === input.currentFileVersion : record.mtimeMs === input.currentMtimeMs);
  const fresh = record !== undefined && (record.content !== undefined && input.currentContent !== undefined ? record.content === input.currentContent : sameVersion);
  const version = { mtimeMs: input.currentMtimeMs, ...(input.currentFileVersion !== undefined ? { fileVersion: input.currentFileVersion } : {}) };

  // A complete read of this very version satisfies every class.
  if (record !== undefined && record.complete && fresh) return { eligible: true };

  // Changed on disk since the model last saw it: hand it the changed lines (where a Read would be silent), and they
  // count as read of the new version.
  let note: string | undefined;
  let seenNow: Array<[number, number]> = [];
  if (record !== undefined && !fresh && silent()) {
    if (record.content !== undefined && input.currentContent !== undefined) {
      const changed = changeNote(path, record.content, input.currentContent);
      note = changed.note;
      seenNow = changed.shown;
      deps.readState.recordRead(path, { complete: false, ...version, ranges: seenNow, ...(input.currentContent.length <= READ_CONTENT_MAX ? { content: input.currentContent } : {}) });
    } else {
      note = `"${path}" changed on disk since you last saw it; its earlier text wasn't kept, so the changed lines can't be shown here.`;
    }
  }

  if (strength !== "weak") {
    // Strong and medium: no refusal for an unread file, a partial read or a change on disk -- where a Read is silent.
    if (record !== undefined && fresh) return { eligible: true };
    if (silent()) return { eligible: true, ...(note !== undefined ? { note } : {}) };
    return { eligible: false, reason: record === undefined || fresh ? `"${path}" has not been read in this session -- read it first` : `"${path}" has changed on disk since it was last read in this session -- read it again before editing` };
  }

  // Weak.
  const withNote = (reason: string) => (note !== undefined ? `${reason}\n\n${note}` : reason);
  if (input.operation === "notebook-edit" || input.currentContent === undefined) {
    // Cells are not lines: any read of this version of the notebook (or of a file whose text isn't known).
    if (record !== undefined && fresh) return { eligible: true };
    return { eligible: false, reason: withNote(record === undefined ? `"${path}" has not been read in this session -- read it first` : `"${path}" has changed on disk since it was last read in this session -- read it again before editing`) };
  }
  const readable: ReadonlyArray<readonly [number, number]> = fresh ? record!.ranges ?? [] : seenNow;
  const total = linesOf(input.currentContent).length;
  let needed: Array<[number, number]>;
  if (input.operation === "overwrite") {
    needed = total > 0 ? [[1, total]] : [];
  } else {
    const needle = input.oldString ?? "";
    const count = needle === "" ? 0 : input.currentContent.split(needle).length - 1;
    // Not found, or ambiguous without replace_all: the caller says so (nothing is changed); the note still goes along.
    if (count === 0 || (count > 1 && input.replaceAll !== true)) return { eligible: true, ...(note !== undefined ? { note } : {}) };
    needed = linesOfOccurrences(input.currentContent, needle, input.replaceAll === true);
  }
  const missing = uncovered(needed, readable);
  if (missing.length === 0) return { eligible: true, ...(note !== undefined ? { note } : {}) };
  const first = missing[0]!;
  const last = missing[missing.length - 1]!;
  const span = `offset ${first[0]}, limit ${last[1] - first[0] + 1}`;
  const what = input.operation === "overwrite"
    ? `Write replaces the whole file, and ${missing.map(fmtRange).join(", ")} of it ${missing.length === 1 && first[0] === first[1] ? "hasn't" : "haven't"} been read since it last changed`
    : `this edit changes ${missing.map(fmtRange).join(", ")}, which ${missing.length === 1 && first[0] === first[1] ? "hasn't" : "haven't"} been read since the file last changed`;
  return { eligible: false, reason: withNote(`"${path}": ${what} -- Read ${first[0] === last[1] ? `line ${first[0]}` : `lines ${first[0]}-${last[1]}`} first (${span})`) };
}

/**
 * 0.0.80: what the model knows of a file after its own successful Edit or Write: the new text, and the lines it has
 * read carried through the change (each old line to its new place) plus the lines it wrote. A Write wrote every line.
 */
export function recordAfterWrite(deps: ReadLadderDeps, filePath: string, o: { before: string | undefined; after: string; mtimeMs: number; fileVersion?: string; kind: PostOperationReadKind }): void {
  const version = { mtimeMs: o.mtimeMs, ...(o.fileVersion !== undefined ? { fileVersion: o.fileVersion } : {}) };
  const content = o.after.length <= READ_CONTENT_MAX ? { content: o.after } : {};
  const prev = deps.readState.lookup(filePath);
  if (o.kind === "full" || o.before === undefined) {
    deps.readState.recordRead(filePath, { complete: o.kind === "full", ...version, ...content, ...(o.kind === "full" ? {} : { ranges: [[1, Math.max(1, linesOf(o.after).length)]] }) });
    return;
  }
  // Only what was read of the version this edit started from carries over.
  const prevMatches = prev !== undefined && (prev.content === undefined || prev.content === o.before);
  const ch = lineChanges(o.before, o.after);
  if (prevMatches && prev!.complete) {
    deps.readState.recordRead(filePath, { complete: true, ...version, ...content });
    return;
  }
  const carried: Array<[number, number]> = [];
  if (prevMatches) {
    for (const [a, b] of prev!.ranges ?? []) {
      for (let n = a; n <= b; n++) {
        const to = ch.mapOld(n);
        if (to !== undefined) carried.push([to, to]);
      }
    }
  }
  deps.readState.recordRead(filePath, { complete: false, ...version, ...content, ranges: mergeRanges([...carried, ...ch.changed]) });
}
