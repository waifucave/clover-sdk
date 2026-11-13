// 0.0.80: which lines of a file changed between two versions of its text, and where each old line went -- for the
// read-before-edit rule (tools/impl/read-ladder.ts): the lines a model is shown after a change made outside the file
// tools, and the lines it has read carried through its own edit.
//
// Bounded: the common head and tail are trimmed first (an edit or a `sed` usually touches a small middle), and only a
// middle small enough is diffed line by line (the shared `computeLineDiff`, quadratic in memory). A middle larger than
// that counts as changed whole: more lines shown or re-read, never a line wrongly taken as unchanged.
import { computeLineDiff } from "./line-diff.ts";

/** The largest middle (old lines times new lines) diffed line by line. */
const MIDDLE_DIFF_MAX_CELLS = 250_000;

export interface LineChanges {
  /** The new version's changed or added lines, 1-based and inclusive, merged. */
  changed: Array<[number, number]>;
  /** An old line's number in the new version, or `undefined` when that line was changed or removed. */
  mapOld(line: number): number | undefined;
  /** Old lines removed with nothing in their place, as `{ count, after }`: `after` is the new line they followed (0: the top). */
  removed: Array<{ count: number; after: number }>;
  /** The new version's line count. */
  newLineCount: number;
}

/** A text's lines; an empty text has none. */
export function linesOf(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function lineChanges(before: string, after: string): LineChanges {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldMid = a.length - head - tail;
  const newMid = b.length - head - tail;
  // Old line (1-based) -> new line, inside the middle; filled by the line diff when the middle is small enough.
  const midMap = new Map<number, number>();
  const changedLines: number[] = [];
  const removed: Array<{ count: number; after: number }> = [];
  if (oldMid > 0 || newMid > 0) {
    if (oldMid * newMid <= MIDDLE_DIFF_MAX_CELLS && oldMid > 0 && newMid > 0) {
      let pendingRemoved = 0;
      let lastNew = head;
      for (const d of computeLineDiff(a.slice(head, head + oldMid).join("\n"), b.slice(head, head + newMid).join("\n"))) {
        if (d.type === "context") {
          if (pendingRemoved > 0) { removed.push({ count: pendingRemoved, after: lastNew }); pendingRemoved = 0; }
          midMap.set(head + d.oldLineNumber!, head + d.newLineNumber!);
          lastNew = head + d.newLineNumber!;
        } else if (d.type === "add") {
          if (pendingRemoved > 0) pendingRemoved = 0; // replaced, not removed: the added line is shown
          changedLines.push(head + d.newLineNumber!);
          lastNew = head + d.newLineNumber!;
        } else {
          pendingRemoved++;
        }
      }
      if (pendingRemoved > 0) removed.push({ count: pendingRemoved, after: lastNew });
    } else {
      for (let i = 1; i <= newMid; i++) changedLines.push(head + i);
      if (newMid === 0 && oldMid > 0) removed.push({ count: oldMid, after: head });
    }
  }
  const changed: Array<[number, number]> = [];
  for (const n of changedLines) {
    const last = changed[changed.length - 1];
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else changed.push([n, n]);
  }
  const shift = b.length - a.length;
  return {
    changed,
    removed,
    newLineCount: b.length,
    mapOld(line: number): number | undefined {
      if (line >= 1 && line <= head) return line;
      if (line > a.length - tail && line <= a.length) return line + shift;
      return midMap.get(line);
    },
  };
}
