import { describe, expect, test } from "bun:test";
import { activeWinterIdentity, identityFromBrand, identityRefusal, installBrandIdentity, setWinterIdentity, winterIdentityHeaders, winterUserAgent } from "./identity.ts";
import { WINTER_DEFAULT_IDENTITY } from "./winter-defaults.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import pkg from "../package.json";

describe("WS-13b honest identity", () => {
  test("the user agent names Winter and its version, never an editor or vendor CLI", () => {
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
    expect(winterUserAgent()).not.toMatch(/vscode|cursor|claude|codex|grok|copilot/i);
  });

  // The rule this file exists to keep true is not "the string is right" but "the string is OURS".
  // WS-13 §5 / D21: a client-identity header is never imported, and every adapter family authors its
  // own -- so the one place that authors it must be incapable of naming somebody else's product.
  test("it is a single well-formed product token — no vendor originator can be appended to it", () => {
    expect(winterUserAgent()).toMatch(/^winter-agent-sdk\/\S+$/);
    expect(winterUserAgent().includes(" ")).toBe(false);
  });
});

// --- P7a fix wave (item 5): overlapping installs unwind in ANY order ------------------------------
//
// Found while writing M-2's two-same-brand-session test. The old shape captured a `previous` value
// per call and no-oped when its own value was no longer active -- correct for STRICTLY NESTED
// teardown, and a leak for every other order, which two concurrent sessions produce routinely:
// install A, install B, dispose A (a no-op), dispose B (restores A's value, not the default). The
// process then presented as the LAST BRAND with no session live at all, so a subsequent UNBRANDED
// session would have put a reuser's product token and contact URL on the wire -- in the one field
// whose entire purpose is honest identity.
describe("P7a: setWinterIdentity frames", () => {
  const DEFAULTS = { product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator, contactUrl: WINTER_BRAND.contactUrl };
  const acme = { product: "acme", codexOriginator: "acme", contactUrl: "https://acme.example/support" };
  const zeda = { product: "zeda", codexOriginator: "zeda", contactUrl: "https://zeda.example/contact" };

  test("nested (LIFO) teardown behaves exactly as before", () => {
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    expect(activeWinterIdentity()).toEqual(acme);
    disposeA();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("OUT-OF-ORDER teardown returns to the default -- the leak this replaced never did", () => {
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    disposeA(); // the OUTER one first: `zeda` is still live and must stay
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    // Before the frame stack this asserted `acme` -- a brand nothing was running any more.
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("a disposer is idempotent and can only ever remove its OWN frame", () => {
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    disposeA();
    disposeA();
    disposeA();
    // Three calls, one frame removed: `zeda`'s is untouched.
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("two frames with the SAME value still unwind one at a time", () => {
    // Frames are compared by object identity, not by value, so two same-brand sessions (M-2's
    // topology) each hold their own -- disposing one must not withdraw the other's.
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(acme);
    disposeA();
    expect(activeWinterIdentity()).toEqual(acme);
    disposeB();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });
});

// --- 0.0.56 (W9): a host installs its own identity ---------------------------------------------------
describe("0.0.56: setWinterIdentity from a host", () => {
  const host = { product: "example-host", codexOriginator: "example-host", contactUrl: "https://example.test/contact", version: "1.2.3" };

  test("the User-Agent names the host and the HOST's version, then returns to Winter's own", () => {
    const dispose = setWinterIdentity(host);
    expect(winterUserAgent()).toBe("example-host/1.2.3");
    dispose();
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
  });

  test("without a version the package's own version is used (Winter's default behaviour is unchanged)", () => {
    const { version: _omitted, ...noVersion } = host;
    const dispose = setWinterIdentity(noVersion);
    expect(winterUserAgent()).toBe(`example-host/${pkg.version}`);
    dispose();
  });

  test("a row's <product>/<version>/<contact> placeholders render the host's values", () => {
    const dispose = setWinterIdentity(host);
    const lookup = () => ({ "Client-Agent": "<product>:<version>:<contact>" });
    expect(winterIdentityHeaders(lookup, "aihorde")).toEqual({ "Client-Agent": "example-host:1.2.3:https://example.test/contact" });
    dispose();
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    ["an uppercase product", { ...host, product: "Example" }],
    ["a product with a space", { ...host, product: "example host" }],
    ["a first-party originator", { ...host, codexOriginator: "codex" }],
    ["another first-party originator", { ...host, codexOriginator: "claude-code" }],
    ["an http contact", { ...host, contactUrl: "http://example.test" }],
    ["a contact with a newline", { ...host, contactUrl: "https://example.test/\nX-Injected: 1" }],
    ["a version with a space", { ...host, version: "1.2 beta" }],
    ["a version with a slash", { ...host, version: "1/2" }],
  ];
  for (const [label, identity] of refusals) {
    test(`refuses ${label}, typed, and installs nothing`, () => {
      expect(identityRefusal(identity as never)).toBeString();
      expect(() => setWinterIdentity(identity as never)).toThrow(TypeError);
      expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
    });
  }

  test("every value the sdk's brand profile accepts is accepted here (Winter's own wiring still installs)", () => {
    expect(identityRefusal({ product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator, contactUrl: WINTER_BRAND.contactUrl })).toBeUndefined();
  });
});

// --- 0.0.63: a brand's identity, through one mapping -------------------------------------------------
//
// A branded session's wiring and a branded HOST (Clover's daemon, whose titles, bash reviewer and
// sign-ins run outside any session) install the identity from the same brand fields. Before this the
// host spelled `setWinterIdentity({ product, codexOriginator, contactUrl })` by hand, and the brand's
// own release had no field to ride in, so a host's User-Agent carried this package's version.
describe("0.0.63: identityFromBrand / installBrandIdentity", () => {
  const brand = { packageName: "example-host", codexOriginator: "example-host", contactUrl: "https://example.test/contact", productVersion: "1.2.3" };

  test("the one mapping: packageName is the product token, productVersion the version", () => {
    expect(identityFromBrand(brand)).toEqual({ product: "example-host", codexOriginator: "example-host", contactUrl: "https://example.test/contact", version: "1.2.3" });
    const { productVersion: _omitted, ...noVersion } = brand;
    // No productVersion: no `version` key at all (the package's own version applies), never `undefined`.
    expect(identityFromBrand(noVersion)).toEqual({ product: "example-host", codexOriginator: "example-host", contactUrl: "https://example.test/contact" });
    expect("version" in identityFromBrand(noVersion)).toBe(false);
  });

  test("Winter's own brand maps to Winter's own default identity", () => {
    expect(identityFromBrand(WINTER_BRAND)).toEqual(WINTER_DEFAULT_IDENTITY);
  });

  test("installBrandIdentity installs a frame (the host's product AND release on the User-Agent) and its disposer gives it back", () => {
    const dispose = installBrandIdentity(brand);
    expect(activeWinterIdentity()).toEqual(identityFromBrand(brand));
    expect(winterUserAgent()).toBe("example-host/1.2.3");
    dispose();
    dispose();
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
  });

  test("a brand whose identity would be refused throws TypeError and installs nothing", () => {
    expect(() => installBrandIdentity({ ...brand, codexOriginator: "codex" })).toThrow(TypeError);
    expect(() => installBrandIdentity({ ...brand, productVersion: "1.2 beta" })).toThrow(TypeError);
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
  });
});
