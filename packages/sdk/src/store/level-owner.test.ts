// The transcript store's owner check with the platform as a parameter (the Windows branch runs on any system). The real
// Windows run is the `windows` CI job's `embedded-start.test.ts`; the reasons are in the runtime's `paths/owner.ts`.
import { describe, expect, test } from "bun:test";
import { levelOwnedByThisUser } from "./session-store.ts";

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
