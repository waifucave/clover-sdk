// The single-segment checks of the runtime's stores on Windows, with the platform as a parameter (the win32 rule runs here
// on any system). The rule and why it is win32-only: `segment.ts`.
import { describe, expect, test } from "bun:test";
import { windowsNameProblem } from "./segment.ts";
import { assertSafePathSegment as approvalsCheck } from "../permissions/approvals.ts";
import { assertSafePathSegment as journalCheck } from "../permissions/ruleset.ts";
import { assertSafeSegment as countersCheck } from "../permissions/auto/caches.ts";

const REFUSED_ON_WINDOWS = [
  "a\\b", "..\\x", "\\x", "\\\\server\\share", "x\\", // a backslash: a path, not a name; UNC-looking; rooted
  "C:x", "C:", "x:stream", // drive-relative and alternate data stream
  "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\u0000b", "a\u001fb", // characters Windows forbids
  "x.", "x ", "...", "a. ", // trailing dot or space
  "con", "CON", "Con", "nul", "AUX", "prn", "COM1", "com9", "LPT3", "COM¹", "con.txt", "NUL.approvals.jsonl", "con .x", "CONIN$", "conout$", // reserved device names
];
const FINE_EVERYWHERE = ["b_luna", "sess-1", "8f14e45f-ceea-467a-9575-ea5bb57fd5f8", "agent-0a1b", "provider-state", "C--Users-me-proj", "a.b", ".hidden", "console", "com10", "lpt", "nullable", "x y", "é"];

describe("windowsNameProblem", () => {
  test("win32: every name that is a path, drive-relative, a stream, forbidden, dropped or a device is refused", () => {
    for (const name of REFUSED_ON_WINDOWS) expect(windowsNameProblem(name, "win32"), JSON.stringify(name)).toBeString();
  });

  test("win32: ordinary names pass", () => {
    for (const name of FINE_EVERYWHERE) expect(windowsNameProblem(name, "win32"), JSON.stringify(name)).toBeUndefined();
  });

  test("Unix, as before: nothing is added (a backslash, a colon, a trailing dot, `con` are valid names there)", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      for (const name of [...REFUSED_ON_WINDOWS, ...FINE_EVERYWHERE]) expect(windowsNameProblem(name, platform), `${platform} ${JSON.stringify(name)}`).toBeUndefined();
    }
  });
});

describe("the three stores' segment checks", () => {
  for (const [label, check] of [["approvals", approvalsCheck], ["permission journal", journalCheck], ["auto counters", countersCheck]] as const) {
    test(`${label}: win32 refuses what Windows reads as more than one plain name; Unix accepts and refuses exactly what it always did`, () => {
      for (const name of REFUSED_ON_WINDOWS) expect(() => check(name, "sessionId", "win32"), JSON.stringify(name)).toThrow();
      for (const name of FINE_EVERYWHERE) expect(() => check(name, "sessionId", "win32"), JSON.stringify(name)).not.toThrow();
      for (const name of ["", ".", "..", "a/b", "/x", "a/"]) {
        expect(() => check(name, "sessionId", "linux"), JSON.stringify(name)).toThrow();
        expect(() => check(name, "sessionId", "win32"), JSON.stringify(name)).toThrow();
      }
      for (const name of ["a\\b", "C:x", "x.", "con", "NUL.txt"]) expect(() => check(name, "sessionId", "linux"), JSON.stringify(name)).not.toThrow();
    });
  }
});
