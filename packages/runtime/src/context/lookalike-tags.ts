// Clover A-F8 review (0.0.71): text a background task, a monitored command, an agent or a tool produced can't open or
// close one of the blocks it is delivered in, however it spells the tag. Ported from Clover's own turn-loop escaping
// (lane A, `turn-loop/defuse.ts`), so both sides read a tag the same way:
// - format characters (zero-width spaces and joiners, soft hyphens, bidi marks: `\p{Cf}`), the invisible joiners and
//   variation selectors, and whitespace may sit anywhere between `<`, the `/` and the name's letters;
// - each character is compared after NFKC (fullwidth and mathematical letters, the `ﬁ` ligature, `＜` and `﹤`);
// - `<` has look-alikes (`〈`, `⟨`, `˂`, `ᐸ`, `❮`…), and so do `/` and `-`;
// - a name's letters have look-alikes in other scripts (Cyrillic `е`, `о`, `р`, `ѕ`; Greek `α`, `ο`, `ν`; Armenian `օ`,
//   `ս`, `ց`; Cherokee `Ꮇ`, `Ꭼ`, `Ꮪ`, small capitals…), read through `lookalikeOf` (`lookalike-fold.ts`, Clover's
//   plugin SDK map vendored), and a look-alike of an `i` or an `l` reads as either;
// - any case.
// Only the opening bracket of a tag so found becomes `‹`; everything else stays as written, so the text still reads.
// Not read as a tag: whitespace between a name's letters (`<mes sage>`), which a model doesn't read as one either.
// A `<` that opens no guarded name (`a < b`, `<messages>`) is left alone.

import { lookalikeOf } from "./lookalike-fold.ts";

/** The defused bracket. */
export const DEFUSED_BRACKET = "‹";

/** `<` and its look-alikes (NFKC already folds `＜` and `﹤`). */
const LESS_THAN = new Set(["<", "〈", "〈", "⟨", "˂", "ᐸ", "❮", "⧼", "❰", "❬"]);
/** `/` and its look-alikes (NFKC folds `／`). */
const SLASH = new Set(["/", "⁄", "∕", "⧸", "╱", "ノ", "〳"]);
/** `-` and its look-alikes (NFKC folds `﹣` and `－`). */
const HYPHEN = new Set(["-", "‐", "‑", "‒", "–", "—", "―", "−", "⁃", "˗", "֊", "⸺", "⸻", "ー", "﹘"]);

/** Invisible characters a tag may carry anywhere: the format characters, plus the joiners and fillers that aren't. */
const INVISIBLE = /^[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ]$|^[\u{E0100}-\u{E01EF}]$/u;

/** Letters the map lacks: Cyrillic Komi sje, which reads as a G. Everything else is `lookalikeOf`, the
 *  map Clover's plugin name check (`foldTitle`) and its island read names with, so they never disagree. */
const EXTRA: Record<string, string> = { "Ԍ": "g", "ԍ": "g" };

/** What a look-alike of an `i` or an `l` reads as: either. The map reads Greek `Ι` and Cyrillic `І`, `Ї` and `Ӏ` as an
 *  `l`, Greek `ι` and Cyrillic `і` as an `i`; in a tag name a model reads any of them as whichever letter the tag
 *  spells (`<task-notΙfication>`, `<bot-Іnstructions>`). A Latin `i` or `l` stays itself. A noncharacter, and one the
 *  text itself carries reads as U+FFFD (`readAs`), so no input stands for it. */
const EITHER_I_OR_L = "\uFDD0";

/** Cherokee small letters, which the map knows by their capitals. */
const CHEROKEE_SMALL = /^[\uAB70-\uABBF\u13F8-\u13FD]$/u;

/** A non-ASCII character as `lookalikeOf` reads it (its own case, then lower case, a Cherokee small letter
 *  by its capital), or undefined. */
function lookalike(c: string): string | undefined {
  return lookalikeOf(c) ?? lookalikeOf(c.toLowerCase()) ?? (CHEROKEE_SMALL.test(c) ? lookalikeOf(c.toUpperCase()) : undefined) ?? EXTRA[c];
}

/** One character of the text as a model reads it: the look-alike map, else NFKC, the map again, lower case. A Latin
 *  letter reads as itself; the map's digits and strokes read as letters too (`<n0te>` is the tag, `|` an `i` or `l`). */
function readAs(ch: string): string {
  let out = "";
  for (const c of lookalike(ch) === undefined ? ch.normalize("NFKC") : ch) {
    const l = /^[A-Za-z]$/.test(c) ? undefined : lookalike(c);
    const s = c === EITHER_I_OR_L ? "\uFFFD" : l === undefined ? c.toLowerCase() : l === "i" || l === "l" ? EITHER_I_OR_L : l;
    out += HYPHEN.has(s) ? "-" : SLASH.has(s) ? "/" : s;
  }
  return out;
}

function isLessThan(ch: string): boolean {
  return LESS_THAN.has(ch) || ch.normalize("NFKC") === "<";
}

const WORD = /[\p{L}\p{N}_\uFDD0]/u;

/**
 * `text` with the bracket of every tag that opens or closes one of `names` defused, however it is spelled (see the
 * header). `names` are lower-case ASCII, `-` allowed.
 */
export function defuseTagNames(text: string, names: readonly string[]): string {
  if (text === "") return text;
  const cps = Array.from(text);
  let changed = false;
  for (let i = 0; i < cps.length; i++) {
    if (!isLessThan(cps[i]!)) continue;
    if (opensGuarded(cps, i + 1, names)) {
      cps[i] = DEFUSED_BRACKET;
      changed = true;
    }
  }
  return changed ? cps.join("") : text;
}

/** Whether the code points from `start` read as `\s* /? \s* <name>\b` for one of `names`, invisibles skipped. */
function opensGuarded(cps: readonly string[], start: number, names: readonly string[]): boolean {
  // The characters after the bracket as read, with where each came from; bounded by the longest name and the padding.
  const longest = Math.max(...names.map((n) => n.length));
  const read: string[] = [];
  let slashSeen = false;
  let i = start;
  // Leading padding and one slash.
  for (; i < cps.length; i++) {
    const c = cps[i]!;
    if (INVISIBLE.test(c)) continue;
    const r = readAs(c);
    if (/^\s+$/u.test(r)) continue;
    if (r === "/" && !slashSeen) {
      slashSeen = true;
      continue;
    }
    break;
  }
  // The name's characters, invisibles skipped, and one more to see the boundary.
  for (; i < cps.length && read.join("").length <= longest; i++) {
    const c = cps[i]!;
    if (INVISIBLE.test(c)) continue;
    read.push(readAs(c));
  }
  const word = read.join("");
  return names.some((name) => {
    if (word.length < name.length) return false;
    for (let k = 0; k < name.length; k++) {
      const w = word[k]!;
      if (w !== name[k] && !(w === EITHER_I_OR_L && (name[k] === "i" || name[k] === "l"))) return false;
    }
    const next = word.charAt(name.length);
    return next === "" || !WORD.test(next);
  });
}
