// The transcript store's owner check with the platform as a parameter (the Windows branch runs on any system). The real
// Windows run is the `windows` CI job's `embedded-start.test.ts`; the reasons are in the runtime's `paths/owner.ts`.
import { describe, expect, test } from "bun:test";
import { assertSafeSingleSegment, assertSafeSubpath, levelNameProblem, levelOwnedByThisUser } from "./session-store.ts";

describe("levelOwnedByThisUser", () => {
  test("Windows: no owner to compare, so every level passes the owner check", () => {
    expect(levelOwnedByThisUser({ uid: 0 }, "win32")).toBe(true);
    expect(levelOwnedByThisUser({ uid: 4242 }, "win32")).toBe(true);
  });

  test.skipIf(process.platform === "win32")("Unix, as before: the real uid passes; any other uid is refused", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(levelOwnedByThisUser({ uid: process.getuid!() }, platform)).toBe(true);
      expect(levelOwnedByThisUser({ uid: process.getuid!() + 1 }, platform)).toBe(false);
    }
  });
});

// The single-segment and subpath checks on Windows (the rule and why it is win32-only: `levelNameProblem`'s comment).
const REFUSED_ON_WINDOWS = ["a\\b", "..\\x", "\\x", "\\\\server\\share", "C:x", "x:stream", "a<b", "a?b", "a\u0000b", "x.", "x ", "...", "con", "NUL", "Com3", "lpt1", "con.txt", "CONIN$"];
const FINE = ["b_luna", "sess-1", "8f14e45f-ceea-467a-9575-ea5bb57fd5f8", "agent-0a1b", "provider-state", "C--Users-me-proj", "a.b", ".hidden", "console", "com10", "x y"];

describe("the transcript store's name checks", () => {
  test("win32: a path, a drive-relative name, a stream, a forbidden character, a dropped dot or space and a device name are refused", () => {
    for (const name of REFUSED_ON_WINDOWS) {
      expect(levelNameProblem(name, "win32"), JSON.stringify(name)).toBeString();
      expect(() => assertSafeSingleSegment(name, "sessionId", "win32"), JSON.stringify(name)).toThrow();
      expect(() => assertSafeSubpath(`subagents/${name}`, "win32"), JSON.stringify(name)).toThrow();
    }
    for (const name of FINE) {
      expect(() => assertSafeSingleSegment(name, "sessionId", "win32"), JSON.stringify(name)).not.toThrow();
      expect(assertSafeSubpath(`subagents/${name}`, "win32")).toEqual(["subagents", name]);
    }
  });

  test("Unix, as before: nothing is added; the old refusals (empty, slash, dot segments) stay on every system", () => {
    for (const name of [...REFUSED_ON_WINDOWS, ...FINE]) {
      expect(() => assertSafeSingleSegment(name, "sessionId", "linux"), JSON.stringify(name)).not.toThrow();
      expect(assertSafeSubpath(`subagents/${name}`, "linux")).toEqual(["subagents", name]);
    }
    for (const platform of ["linux", "win32"] as const) {
      for (const name of ["", ".", "..", "a/b"]) expect(() => assertSafeSingleSegment(name, "projectKey", platform), name).toThrow();
      for (const sub of ["", "/x", "a//b", "a/", "a/../b", "./a"]) expect(() => assertSafeSubpath(sub, platform), sub).toThrow();
    }
  });
});
