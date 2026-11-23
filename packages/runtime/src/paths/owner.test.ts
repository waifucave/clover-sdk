// Windows starts: the owner check and the temp base, with the platform as a parameter (the Windows branch runs here on
// any system; nothing fakes `process.platform` or `process.getuid` for the suite). The real Windows run is the `windows`
// CI job's `embedded-start.test.ts`.
import { describe, expect, test } from "bun:test";
import { WINTER_BRAND } from "@waifucave/clover-agent-sdk";
import { ownedByThisUser } from "./owner.ts";
import { assertOwnedDir, resolveTempBase, tempUserSegment, WinterPathsError } from "./temp.ts";

const onUnix = process.platform !== "win32";
const dir = { isDirectory: () => true, isSymbolicLink: () => false };

describe("ownedByThisUser", () => {
  test("Windows: no owner to compare (Node reports uid 0 for every file there), so every level passes the owner check", () => {
    expect(ownedByThisUser({ uid: 0 }, "win32")).toBe(true);
    expect(ownedByThisUser({ uid: 4242 }, "win32")).toBe(true);
  });

  test.skipIf(!onUnix)("Unix, as before: the real uid passes; any other uid is refused", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      expect(ownedByThisUser({ uid: process.getuid!() }, platform)).toBe(true);
      expect(ownedByThisUser({ uid: process.getuid!() + 1 }, platform)).toBe(false);
      expect(ownedByThisUser({ uid: 0 }, platform)).toBe(process.getuid!() === 0);
    }
  });

  test.skipIf(!onUnix)("a Unix platform with no getuid is a thrown bug, never a silent pass", () => {
    const real = process.getuid!;
    // The one place a global is touched, and put back at once: to prove the Unix branch does not turn a missing getuid into a pass.
    delete (process as { getuid?: unknown }).getuid;
    try {
      expect(() => ownedByThisUser({ uid: 0 }, "linux")).toThrow();
    } finally {
      process.getuid = real;
    }
  });
});

describe("assertOwnedDir with the platform as a parameter", () => {
  test("Windows: a foreign uid is not refused (there is none to read); a link or a file still is", () => {
    expect(() => assertOwnedDir({ uid: 99999, ...dir }, "C:\\x", "win32")).not.toThrow();
    expect(() => assertOwnedDir({ uid: 0, isDirectory: () => true, isSymbolicLink: () => true }, "C:\\x", "win32")).toThrow(WinterPathsError);
    expect(() => assertOwnedDir({ uid: 0, isDirectory: () => false, isSymbolicLink: () => false }, "C:\\x", "win32")).toThrow(WinterPathsError);
  });

  test.skipIf(!onUnix)("Unix, as before: a foreign uid is refused", () => {
    expect(() => assertOwnedDir({ uid: process.getuid!() + 1, ...dir }, "/x", "linux")).toThrow(/different uid/);
    expect(() => assertOwnedDir({ uid: process.getuid!(), ...dir }, "/x", "linux")).not.toThrow();
  });
});

describe("resolveTempBase", () => {
  test("Unix, as before: the default is /tmp, whatever TEMP or TMPDIR say; the override and the blank rule are unchanged", () => {
    expect(resolveTempBase({}, WINTER_BRAND, "darwin")).toBe("/tmp");
    expect(resolveTempBase({ TEMP: "C:\\T", TMPDIR: "/var/x" }, WINTER_BRAND, "linux")).toBe("/tmp");
    expect(resolveTempBase({ WINTER_TMPDIR: "/data/t" }, WINTER_BRAND, "linux")).toBe("/data/t");
    expect(resolveTempBase({ WINTER_TMPDIR: "  " }, WINTER_BRAND, "linux")).toBe("/tmp");
  });

  const PROFILE = "C:\\Users\\Jo";
  test("Windows: the host's override is used as given; TEMP, then TMP, are used only inside the profile", () => {
    expect(resolveTempBase({ WINTER_TMPDIR: "D:\\scratch", TEMP: "C:\\Windows\\Temp" }, WINTER_BRAND, "win32", PROFILE)).toBe("D:\\scratch");
    expect(resolveTempBase({ TEMP: "C:\\Users\\Jo\\AppData\\Local\\Temp", TMP: "C:\\Users\\Jo\\other" }, WINTER_BRAND, "win32", PROFILE)).toBe("C:\\Users\\Jo\\AppData\\Local\\Temp");
    expect(resolveTempBase({ TEMP: " ", TMP: "C:\\Users\\Jo\\t" }, WINTER_BRAND, "win32", PROFILE)).toBe("C:\\Users\\Jo\\t");
    // case-insensitive, and resolved (a `..` that leaves the profile is outside)
    expect(resolveTempBase({ TEMP: "c:\\users\\JO\\appdata\\local\\temp" }, WINTER_BRAND, "win32", PROFILE)).toBe("c:\\users\\JO\\appdata\\local\\temp");
    expect(resolveTempBase({ TEMP: "C:\\Users\\Jo\\..\\Other\\T" }, WINTER_BRAND, "win32", PROFILE)).toBe("C:\\Users\\Jo\\AppData\\Local\\Temp");
  });

  test("Windows: a shared or foreign TEMP is not used; the fallback is the per-user temp folder under the profile", () => {
    const fallback = "C:\\Users\\Jo\\AppData\\Local\\Temp";
    for (const temp of ["C:\\Windows\\Temp", "C:\\Temp", "D:\\Users\\Jo\\T", "C:\\Users\\Other\\AppData\\Local\\Temp", "C:\\Users\\Jo", "C:\\Users\\JoBob\\T", "\\\\server\\share\\t", "relative\\t"]) {
      expect(resolveTempBase({ TEMP: temp }, WINTER_BRAND, "win32", PROFILE), temp).toBe(fallback);
      expect(resolveTempBase({ TMP: temp }, WINTER_BRAND, "win32", PROFILE), temp).toBe(fallback);
    }
    expect(resolveTempBase({}, WINTER_BRAND, "win32", PROFILE)).toBe(fallback);
    expect(resolveTempBase({ TEMP: "C:\\Windows\\Temp", TMP: "C:\\Users\\Jo\\t" }, WINTER_BRAND, "win32", PROFILE)).toBe("C:\\Users\\Jo\\t");
  });

  test("Windows: with no profile given it is the process's own home", async () => {
    const { homedir } = await import("node:os");
    const { win32 } = await import("node:path");
    expect(resolveTempBase({}, WINTER_BRAND, "win32")).toBe(win32.join(homedir(), "AppData", "Local", "Temp"));
  });
});

describe("tempUserSegment", () => {
  test("Windows: the account name made safe for one path segment, a stable fallback when there is none", () => {
    expect(tempUserSegment("win32", () => "runneradmin")).toBe("runneradmin");
    expect(tempUserSegment("win32", () => "DOMAIN\\Jo Smith")).toBe("DOMAIN-Jo-Smith");
    expect(tempUserSegment("win32", () => "..\\..")).toBe("user");
    expect(tempUserSegment("win32", () => "")).toBe("user");
    expect(tempUserSegment("win32", () => { throw new Error("no account"); })).toBe("user");
    expect(tempUserSegment("win32", () => "a".repeat(200)).length).toBe(64);
    expect(tempUserSegment("win32", () => "x/y")).toMatch(/^[A-Za-z0-9-]+$/);
  });

  test.skipIf(!onUnix)("Unix, as before: the real uid", () => {
    expect(tempUserSegment("darwin")).toBe(String(process.getuid!()));
    expect(tempUserSegment("linux", () => "ignored")).toBe(String(process.getuid!()));
  });
});
