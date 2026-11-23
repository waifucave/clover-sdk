// What makes a string NOT "one plain name" on Windows, though it is one on Unix. The single-segment checks of the
// runtime's stores (`permissions/ruleset.ts`, `permissions/approvals.ts`, `permissions/auto/caches.ts`) refuse
// `/`, "" , "." and ".." everywhere, and add this on win32. The sdk's transcript store keeps its own copy of this function
// (`levelNameProblem` in `store/session-store.ts`: the sdk exports no subpath to share it from); keep the two in step.
//
// WIN32 ONLY, NOT EVERYWHERE. A backslash is an ordinary character in a Unix file name, and these ids are
// consumer-supplied (the store's `SessionKey` is a pinned type with a deliberately lenient charset), so there is no way
// to know that no host's id contains one. Refusing it on Unix would change what is valid today. On Windows it is a path
// separator, so a name holding one is a path, not a name.
//
// On win32 a name is refused when it holds, or is, any of:
//   - a path separator, `\` (or `/`), which also covers a UNC-looking name (`\\server\share`) and a rooted one (`\x`);
//   - `:`, which makes a drive-relative name (`C:x`, relative to that drive's current folder) or an alternate data stream (`x:s`);
//   - a character Windows forbids in a file name (`< > " | ? *`, and the control characters 0x00-0x1F);
//   - a trailing dot or space, which Windows silently strips (`x.` and `x ` are the folder `x`; `...` is `.`-like);
//   - a reserved device name, with or without an extension and in any case (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`,
//     `LPT0`-`LPT9`, the superscript digit forms, `CONIN$`, `CONOUT$`): opening `con.approvals.jsonl` opens the console.
// Anything else, including everything valid on Unix without those, passes.
//
// Returns why the name is refused, or `undefined`. `platform` is a parameter so the win32 rule runs in a test anywhere.
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i;

export function windowsNameProblem(value: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  if (value.includes("\\") || value.includes("/")) return "must not contain a path separator on Windows";
  if (value.includes(":")) return "must not contain a colon on Windows (a drive-relative name or an alternate data stream)";
  // eslint-disable-next-line no-control-regex
  if (/[<>"|?*\u0000-\u001f]/.test(value)) return "must not contain a character Windows forbids in a file name";
  if (value.endsWith(".") || value.endsWith(" ")) return "must not end in a dot or a space (Windows drops them, so the name would mean another)";
  const stem = value.split(".")[0]!.replace(/ +$/, "");
  if (RESERVED_DEVICE.test(stem)) return "must not be a reserved Windows device name";
  return undefined;
}
