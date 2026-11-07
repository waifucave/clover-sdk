// The look-alike map is Clover's plugin SDK map (`packages/plugin-sdk/src/catalogs/fold.ts`), vendored: its fingerprint
// is pinned here so an edit fails until it is made on purpose, and Clover's gate compares the `./lookalike` export with
// the plugin SDK's `lookalikeOf` over every code point.
import { describe, expect, test } from "bun:test";
import { lookalikeEntries, lookalikeOf } from "./lookalike-fold.ts";

/** The fingerprint of the vendored table (clover main 6eea15436): sha256 of `JSON.stringify(lookalikeEntries())`. */
const PINNED = { entries: 257, sha256: "cf24769f7bf6cc10e55c8b66ac9e51ad8039695e5b64a8519413fd7e77504917" };

describe("the vendored look-alike map", () => {
  test("is the table Clover's plugin SDK ships, unchanged", () => {
    const entries = lookalikeEntries();
    const sha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(entries)).digest("hex");
    expect({ entries: entries.length, sha256 }).toEqual(PINNED);
  });

  test("reads the letters the plugin SDK's own tests name", () => {
    // Cyrillic, Greek (the capital iota and the Cyrillic І and Ї read as "l", as foldTitle reads them), Armenian,
    // Cherokee, a small capital, a stroked letter, Lisu, digits and strokes.
    const cases: Array<[string, string]> = [
      ["\u0435", "e"], ["\u041D", "h"], ["\u0399", "l"], ["\u0406", "l"], ["\u0407", "l"], ["\u03B9", "i"], ["\u0456", "i"],
      ["\u0585", "o"], ["\u057D", "u"], ["\u0578", "n"], ["\u054F", "s"],
      ["\u13B7", "m"], ["\u13AC", "e"], ["\u13DA", "s"], ["\u13C6", "l"],
      ["\u1D00", "a"], ["\u0142", "l"], ["\uA4E0", "n"], ["0", "o"], ["1", "l"], ["|", "l"],
    ];
    for (const [ch, as] of cases) expect([ch, lookalikeOf(ch)]).toEqual([ch, as]);
    expect(lookalikeOf("a")).toBeUndefined();
    expect(lookalikeOf("\u03B7")).toBeUndefined();
  });
});
