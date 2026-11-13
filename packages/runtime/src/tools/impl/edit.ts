import { guestFileSessionOf, guestFileError } from "../../guest/file-session.ts";
import { assertHostCodePathAccess } from "../../sandbox/host-code-protection.ts";
import { guestEdit } from "../../guest/file-tools.ts";
// WS-06 §3.1 "Edit" -- implement-now, pinned schema `{file_path, old_string, new_string,
// replace_all?}`. `old_string` is literal (never regex/fuzzy) and normally unique; `replace_all`
// replaces every occurrence. Subject to the shared read-before-edit ladder (read-ladder.ts,
// "edit" operation) and MUST retain Read-deny enforcement on the target -- the latter is the
// STANDING P2 evaluator's job (findReadDenyBlockingEdit + boundedRoots), composed in BEFORE this
// executor ever runs; this file never re-implements a permission check of its own.
import { fstatSync, lstatSync } from "node:fs";
import { checkPlannedTarget, closeTarget, openPlanned, planWrite, readAll, refuseHardLinks, replaceContents } from "../no-follow-write.ts";
import { resolve } from "node:path";
import "../descriptors/index.ts"; // side-effect only: guarantees the "Edit" stub exists first.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { evaluateEditRead, recordAfterWrite, type ReadLadderDeps } from "./read-ladder.ts";
import { computeLineDiff, type DiffLine } from "./write.ts";

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

function parseInput(input: unknown): EditInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const filePath = rec["file_path"];
  const oldString = rec["old_string"];
  const newString = rec["new_string"];
  const replaceAllRaw = rec["replace_all"];
  if (typeof filePath !== "string" || typeof oldString !== "string" || typeof newString !== "string") return undefined;
  if (replaceAllRaw !== undefined && typeof replaceAllRaw !== "boolean") return undefined;
  return { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAllRaw === true };
}

function errorResult(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

// Literal (never regex) occurrence count -- `.split(needle)` treats a STRING needle as literal text
// regardless of any regex-metacharacter-looking content, so no escaping is needed (advisor/brief:
// "count occurrences with a literal indexOf scan, not regex" -- split-based counting is the same
// literal-match semantics as a manual indexOf loop, without the loop).
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

// NOT `haystack.replace(needle, replacement)` / `.replaceAll(...)` -- empirically verified gotcha:
// even when the SEARCH argument is a plain string (a literal match, never a regex), JS still treats
// `$`-sequences in the REPLACEMENT string specially (`$$` collapses to one `$`, `$&` re-inserts the
// matched text, `$1`/`$<name>` look for capture groups). A `new_string` containing a shell variable
// (`$HOME`), a template placeholder (`${x}`), or literally "$$" would be silently corrupted by the
// built-in methods. split/join has no such special-casing on EITHER side -- fully literal, which is
// exactly what Edit's pinned contract ("old_string is literal") demands for new_string too.
function replaceFirstLiteral(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

// Minimal, honest result shape (WS-06 §3.1 + report §40.8): file/diff info (a full old-vs-new line
// diff, reusing write.ts's own helper -- more informative than a bare old/new echo, and the one
// diff engine this lane builds), original content (always retained -- no size threshold is pinned
// anywhere that would justify sometimes omitting it), the replace-all flag, and userModified.
// `userModified` is always `false` for the identical reason write.ts's `userEdited` is: the
// evaluator's own approval-time `transformedInput` rewrite happens upstream of this executor, which
// has no seam to observe it. Flagged for T8.
interface EditToolResult {
  filePath: string;
  diff: DiffLine[];
  originalContent: string;
  replaceAll: boolean;
  userModified: boolean;
  /** 0.0.80: the file changed on disk since the model last saw it: its changed lines (read-ladder.ts). */
  note?: string;
}

const editExecutor: ToolExecutor = {
  async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const parsed = parseInput(rawInput);
    if (!parsed) return errorResult("Edit requires string fields 'file_path', 'old_string', 'new_string' (and an optional boolean 'replace_all')");
    if (parsed.old_string === "") return errorResult("'old_string' must not be empty");
    if (parsed.old_string === parsed.new_string) return errorResult("'old_string' and 'new_string' are identical -- no change to make");

    try { const guest = guestFileSessionOf(ctx); if (guest) return await guestEdit(parsed, ctx, guest); }
    catch (error) { return guestFileError(error); }

    // Fix round 10, item B: trim FIRST, as claude does -- see write.ts's identical
    // comment (the check and the write must never disagree).
    const resolvedPath = resolve(ctx.cwd, parsed.file_path.trim());

    try {
      assertHostCodePathAccess(resolvedPath, "read", ctx.sandboxSettings, ctx.cwd);
      assertHostCodePathAccess(resolvedPath, "write", ctx.sandboxSettings, ctx.cwd);
      // 0.0.77: resolve ONCE to the real file, check THAT, then read and write it through ONE verified
      // descriptor (tools/no-follow-write.ts): the file read is the file written, and a link or a folder
      // swapped in after the check can't redirect either.
      if (lstatOrMissing(resolvedPath) === undefined) return errorResult(`"${resolvedPath}" does not exist -- Edit can only modify an existing file`);
      const plan = planWrite(resolvedPath, { followLeafLink: true, createParents: false });
      if (plan.existing === undefined) return errorResult(`"${resolvedPath}" does not exist -- Edit can only modify an existing file`);
      if (plan.existing.isDirectory()) return errorResult(`"${resolvedPath}" is a directory, not a file`);
      if (!plan.existing.isFile()) return errorResult(`"${resolvedPath}" is not a regular file`);
      checkPlannedTarget(plan, ctx, ["read", "write"]);
      const target = openPlanned(plan, { mode: "existing", refuseHardLinks: refuseHardLinks(ctx) });
      let originalContent: string;
      let updatedContent: string;
      let newMtimeMs: number;
      let note: string | undefined;
      const deps: ReadLadderDeps = { readState: ctx.readState, probeReadAccess: ctx.permissions.probeReadAccess };
      try {
        originalContent = readAll(target.fd).toString("utf8");
        const occurrences = countOccurrences(originalContent, parsed.old_string);

        // 0.0.80: the read rule by the turn's model class (read-ladder.ts `evaluateEditRead`).
        const decision = evaluateEditRead(
          {
            filePath: resolvedPath,
            currentMtimeMs: target.stat.mtimeMs,
            operation: "edit",
            ...(ctx.editStrength !== undefined ? { strength: ctx.editStrength } : {}),
            currentContent: originalContent,
            oldString: parsed.old_string,
            replaceAll: parsed.replace_all,
          },
          deps,
        );
        if (!decision.eligible) return errorResult(decision.reason);
        note = decision.note;
        const withNote = (message: string) => (note !== undefined ? `${message}\n\n${note}` : message);

        if (occurrences === 0) return errorResult(withNote(`old_string not found in "${resolvedPath}"`));
        if (occurrences > 1 && !parsed.replace_all) {
          return errorResult(withNote(`old_string appears ${occurrences} times in "${resolvedPath}" -- pass replace_all:true, or include more surrounding context to make it unique`));
        }

        updatedContent = parsed.replace_all
          ? replaceAllLiteral(originalContent, parsed.old_string, parsed.new_string)
          : replaceFirstLiteral(originalContent, parsed.old_string, parsed.new_string);
        replaceContents(target.fd, updatedContent);
        newMtimeMs = fstatSync(target.fd).mtimeMs;
      } finally {
        closeTarget(target);
      }
      // A targeted, known delta on top of whatever was already known: what was read carries through the edit, and
      // the lines it wrote count as read (read-ladder.ts `recordAfterWrite`).
      recordAfterWrite(deps, resolvedPath, { before: originalContent, after: updatedContent, mtimeMs: newMtimeMs, kind: "carryForward" });

      const result: EditToolResult = {
        filePath: resolvedPath,
        diff: computeLineDiff(originalContent, updatedContent),
        originalContent,
        replaceAll: parsed.replace_all,
        userModified: false,
        ...(note !== undefined ? { note } : {}),
      };
      return { output: JSON.stringify(result) };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

replaceExecutor("Edit", editExecutor);
