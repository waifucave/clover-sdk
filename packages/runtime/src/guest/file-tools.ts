import { posix } from "node:path";
import { GuestFileHelperError, type GuestFileSnapshot } from "./file-helper.ts";
import { guestFileError, type GuestFileSession } from "./file-session.ts";
import type { ToolExecutionContext, ToolResultPayload } from "../tools/registry.ts";
import { evaluateEditRead, recordAfterWrite } from "../tools/impl/read-ladder.ts";
import { computeLineDiff } from "../tools/line-diff.ts";

export function guestTarget(ctx: ToolExecutionContext, path: string): string {
  if (!posix.isAbsolute(ctx.cwd) || path.includes("\0") || !path.trim()) throw new GuestFileHelperError("path_denied", "invalid guest path");
  return posix.resolve(ctx.cwd, path.trim());
}
function text(snapshot: GuestFileSnapshot): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes); }
  catch { throw new GuestFileHelperError("guest_file_type_unsupported", "guest text operations require UTF-8 text"); }
}
function diff(before: string, after: string) {
  // Host diff behavior stays unchanged; bounded guest payloads can still contain many short lines.
  const oldLines = before.split("\n").length, newLines = after.split("\n").length;
  if (Math.max(oldLines, newLines) > 8192 || oldLines * newLines > 1_000_000) return { diff: [], diffTruncated: true };
  return { diff: computeLineDiff(before, after) };
}
// 0.0.80: the same read rule by the turn's model class as the host's file tools (read-ladder.ts `evaluateEditRead`).
function decision(ctx: ToolExecutionContext, guest: GuestFileSession, path: string, snapshot: GuestFileSnapshot, operation: "edit" | "overwrite", content: string, edit?: { oldString: string; replaceAll: boolean }) {
  return evaluateEditRead({ filePath: path, currentMtimeMs: snapshot.mtimeMs, currentFileVersion: snapshot.fileVersion, operation,
    ...(ctx.editStrength !== undefined ? { strength: ctx.editStrength } : {}), currentContent: content, ...(edit ?? {}) }, deps(guest));
}
function deps(guest: GuestFileSession) {
  return { readState: guest.readState, probeReadAccess: (target: string) => guest.probeReadAccess(target) };
}
export async function guestWrite(input: { file_path: string; content: string }, ctx: ToolExecutionContext, guest: GuestFileSession): Promise<ToolResultPayload> {
  try {
    const path = guestTarget(ctx, input.file_path);
    let before: GuestFileSnapshot | undefined;
    try { before = await guest.read(path, ctx.signal); }
    catch (error) {
      if (!(error instanceof GuestFileHelperError && error.code === "path_denied" && error.errno === 2)) throw error;
    }
    const previous = before ? text(before) : undefined;
    let note: string | undefined;
    if (before) {
      const allowed = decision(ctx, guest, path, before, "overwrite", previous!);
      if (!allowed.eligible) return { output: `Error: ${allowed.reason}`, isError: true };
      note = allowed.note;
    }
    let after: GuestFileSnapshot;
    try { after = await guest.write(path, Buffer.from(input.content), before?.fileVersion ?? "absent", ctx.signal); }
    catch (error) {
      if (!before && error instanceof GuestFileHelperError && error.code === "path_denied" && error.errno === 2) throw new GuestFileHelperError("guest_parent_creation_unsupported", "new guest Write requires existing parent directories");
      throw error;
    }
    recordAfterWrite(deps(guest), path, { before: previous, after: input.content, mtimeMs: after.mtimeMs, fileVersion: after.fileVersion, kind: "full" });
    return { output: JSON.stringify({ type: before ? "update" : "create", filePath: path, content: input.content,
      ...diff(previous ?? "", input.content), ...(previous === undefined ? {} : { previousContent: previous }), userEdited: false, ...(note !== undefined ? { note } : {}) }) };
  } catch (error) { return guestFileError(error); }
}
export async function guestEdit(input: { file_path: string; old_string: string; new_string: string; replace_all: boolean }, ctx: ToolExecutionContext, guest: GuestFileSession): Promise<ToolResultPayload> {
  try {
    const path = guestTarget(ctx, input.file_path), before = await guest.read(path, ctx.signal), content = text(before);
    const occurrences = content.split(input.old_string).length - 1;
    const allowed = decision(ctx, guest, path, before, "edit", content, { oldString: input.old_string, replaceAll: input.replace_all });
    if (!allowed.eligible) return { output: `Error: ${allowed.reason}`, isError: true };
    const note = allowed.note, withNote = (m: string) => (note !== undefined ? `${m}\n\n${note}` : m);
    if (!occurrences) return { output: `Error: ${withNote(`old_string not found in "${path}"`)}`, isError: true };
    if (occurrences > 1 && !input.replace_all) return { output: `Error: ${withNote(`old_string appears ${occurrences} times in "${path}" -- pass replace_all:true, or include more surrounding context to make it unique`)}`, isError: true };
    const at = content.indexOf(input.old_string), updated = input.replace_all ? content.split(input.old_string).join(input.new_string) : content.slice(0, at) + input.new_string + content.slice(at + input.old_string.length);
    const after = await guest.write(path, Buffer.from(updated), before.fileVersion, ctx.signal);
    recordAfterWrite(deps(guest), path, { before: content, after: updated, mtimeMs: after.mtimeMs, fileVersion: after.fileVersion, kind: "carryForward" });
    return { output: JSON.stringify({ filePath: path, ...diff(content, updated), originalContent: content, replaceAll: input.replace_all, userModified: false, ...(note !== undefined ? { note } : {}) }) };
  } catch (error) { return guestFileError(error); }
}
export function guestText(snapshot: GuestFileSnapshot): string { return text(snapshot); }
