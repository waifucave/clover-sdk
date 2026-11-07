// Clover A-F8 review (0.0.71): text a background task, a monitored command, an agent or a tool produced can't open or
// close one of the blocks it is delivered in, however it spells the tag. Ported from Clover's own turn-loop escaping
// (lane A), so both sides read a tag the same way:
// - format characters (zero-width spaces and joiners, soft hyphens, bidi marks: `\p{Cf}`), the invisible joiners and
//   variation selectors, and whitespace may sit anywhere between `<`, the `/` and the name's letters;
// - each character is compared after NFKC (fullwidth and mathematical letters, the `ﬁ` ligature, `＜` and `﹤`);
// - `<` has look-alikes (`〈`, `⟨`, `˂`, `ᐸ`, `❮`…), and so do `/` and `-`;
// - a name's letters have Cyrillic and Greek look-alikes (`е`, `о`, `р`, `с`, `ѕ`, `α`, `ο`, `ν`…), compared through a
//   small skeleton map;
// - any case.
// Only the opening bracket of a tag so found becomes `‹`; everything else stays as written, so the text still reads.
// Not read as a tag: whitespace between a name's letters (`<mes sage>`), which a model doesn't read as one either.
// A `<` that opens no guarded name (`a < b`, `<messages>`) is left alone.

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

/** Cyrillic, Greek and other letters that look like the Latin ones the guarded names use. Upper case where it differs
 *  in look from its lower case (`Н` is an H, `н` a small-capital H). */
const SKELETON: Record<string, string> = {
  // Cyrillic
  "А": "a", "а": "a", "В": "b", "в": "b", "Е": "e", "е": "e", "Ё": "e", "ё": "e", "К": "k", "к": "k", "М": "m", "м": "m",
  "Н": "h", "н": "h", "О": "o", "о": "o", "Р": "p", "р": "p", "С": "c", "с": "c", "Т": "t", "т": "t", "У": "y", "у": "y",
  "Х": "x", "х": "x", "І": "i", "і": "i", "Ї": "i", "ї": "i", "Ј": "j", "ј": "j", "Ѕ": "s", "ѕ": "s", "Ԁ": "d", "ԁ": "d",
  "Ԍ": "g", "ԍ": "g", "Ӏ": "l", "ӏ": "l", "Ү": "y", "ү": "y", "Һ": "h", "һ": "h", "Ԛ": "q", "ԛ": "q", "Ԝ": "w", "ԝ": "w",
  // Greek
  "Α": "a", "α": "a", "Β": "b", "β": "b", "Ε": "e", "ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "ι": "i", "Κ": "k", "κ": "k",
  "Μ": "m", "Ν": "n", "ν": "v", "Ο": "o", "ο": "o", "Ρ": "p", "ρ": "p", "Τ": "t", "τ": "t", "Υ": "y", "υ": "u", "Χ": "x",
  "χ": "x", "γ": "y", "ϲ": "c", "Ϲ": "c", "ϳ": "j",
  // Latin look-alikes
  "ı": "i", "ɡ": "g", "ɑ": "a", "ɩ": "i", "ʟ": "l", "ꮪ": "s", "ꜱ": "s", "ᴅ": "d", "ᴇ": "e", "ᴋ": "k", "ᴍ": "m", "ᴏ": "o",
  "ᴘ": "p", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴄ": "c", "ʜ": "h", "ɪ": "i", "ɴ": "n", "ʀ": "r", "ꜰ": "f", "ʏ": "y",
};

/** One character of the text as a model reads it: NFKC, then the skeleton, lower case. */
function readAs(ch: string): string {
  const n = ch.normalize("NFKC");
  let out = "";
  for (const c of n) {
    const s = SKELETON[c] ?? SKELETON[c.toLowerCase()] ?? c.toLowerCase();
    out += HYPHEN.has(s) ? "-" : SLASH.has(s) ? "/" : s;
  }
  return out;
}

function isLessThan(ch: string): boolean {
  return LESS_THAN.has(ch) || ch.normalize("NFKC") === "<";
}

const WORD = /[\p{L}\p{N}_]/u;

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
    if (!word.startsWith(name)) return false;
    const next = word.charAt(name.length);
    return next === "" || !WORD.test(next);
  });
}
