// A1 (fail closed): THERE IS NO DEFAULT BRAND. A session, or a reader inside one, runs under the brand
// it is handed or the brand INSTALLED for its process (`installBrand`), and with neither it is refused
// (`BrandRequiredError`) rather than quietly using Winter's home (`~/.winter`), environment (`WINTER_*`)
// or Keychain service, which belong to a live install this SDK must never reach by accident.
//
// This repository's test preload installs Winter's own profile for the suites, so every case here
// runs in a FRESH child process that has none installed: the production starting point.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Run `body` in a fresh Bun process with no test preload (so no brand installed); returns its JSON. */
function inFreshProcess(body: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "brand-required-"));
  try {
    const script = join(dir, "probe.ts");
    writeFileSync(script, `import * as sdk from ${JSON.stringify(SDK_INDEX)};\nconst out: Record<string, unknown> = {};\nconst code = (f: () => unknown): unknown => { try { const v = f(); return { returned: v === undefined ? null : v }; } catch (e) { return (e as { code?: string }).code ?? (e as Error).name; } };\n${body}\nconsole.log(JSON.stringify(out));\n`);
    // A home that is not the real one, in case anything were to resolve one (nothing here should).
    const env = { PATH: process.env["PATH"] ?? "", HOME: dir, TMPDIR: dir };
    const result = Bun.spawnSync([process.execPath, script], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString().trim().split("\n").pop() ?? "";
    if (result.exitCode !== 0 || stdout === "") throw new Error(`probe failed (${result.exitCode}): ${result.stderr.toString()}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ACME = `{ ...sdk.WINTER_BRAND, productName: "Acme", packageName: "acme-agent", homeDirName: ".acme", projectDirName: ".acme", instructionsFile: "ACME.md", envPrefix: "ACME_", keychainService: "com.acme.core", mcpServerName: "acme", presetName: "acme_code", processLabel: "acme", codexOriginator: "acme", tempRootName: "acme", pluginManifestDir: ".acme-plugin", contactUrl: "https://example.com/acme" }`;

describe("A1: no brand named and none installed is refused, never Winter's", () => {
  test("query() with no brand throws BrandRequiredError before anything is spawned, and a partial profile is refused too", () => {
    const out = inFreshProcess(`
      out.installed = sdk.installedBrand() === undefined ? "none" : "some";
      out.query = code(() => { sdk.query({ prompt: "hello", options: {} }); });
      out.partial = code(() => { sdk.query({ prompt: "hello", options: { brand: { productName: "Acme", homeDirName: ".acme" } } }); });
      out.alias = code(() => { sdk.query({ prompt: "hello", options: { keychainService: "com.acme.core" } }); });
    `);
    expect(out).toEqual({ installed: "none", query: "brand_required", partial: "brand_required", alias: "brand_required" });
  });

  test("requireBrand(), resolveBrand() and the home and settings paths refuse; resolveBrand names what is missing", () => {
    const out = inFreshProcess(`
      out.require = code(() => sdk.requireBrand());
      const none = sdk.resolveBrand();
      out.none = none.ok ? "ok" : { missing: none.missing?.length, mentionsInstall: none.reason.includes("installBrand") };
      const partial = sdk.resolveBrand({ productName: "Acme", homeDirName: ".acme" });
      out.partial = partial.ok ? "ok" : partial.missing?.includes("envPrefix") && partial.missing?.includes("keychainService") && !partial.missing?.includes("homeDirName");
      out.home = code(() => sdk.resolveWinterHome({}));
      out.settings = code(() => sdk.settingsPathFor("user", { cwd: "/", env: {} }));
    `);
    expect(out).toEqual({ require: "brand_required", none: { missing: 14, mentionsInstall: true }, partial: true, home: "brand_required", settings: "brand_required" });
  });

  test("a complete profile needs nothing installed, and an explicit brand always wins", () => {
    const out = inFreshProcess(`
      const acme = ${ACME};
      const resolved = sdk.resolveBrand(acme);
      out.complete = resolved.ok ? resolved.brand.homeDirName : "refused";
      out.explicit = code(() => sdk.requireBrand(acme).homeDirName);
      out.home = code(() => sdk.resolveWinterHome({}, acme).endsWith("/.acme/sdk"));
    `);
    expect(out).toEqual({ complete: ".acme", explicit: { returned: ".acme" }, home: { returned: true } });
  });
});

describe("A1: installBrand names the process's brand, once", () => {
  test("an installed brand is what an unbranded reader and a partial profile read, and the first install wins", () => {
    const out = inFreshProcess(`
      const acme = ${ACME};
      out.incomplete = code(() => sdk.installBrand({ productName: "Acme" }));
      out.invalid = code(() => sdk.installBrand({ ...acme, envPrefix: "acme" }));
      out.first = sdk.installBrand(acme);
      out.again = sdk.installBrand({ ...acme });
      out.other = sdk.installBrand(sdk.WINTER_BRAND);
      out.installed = sdk.installedBrand()?.homeDirName;
      out.require = sdk.requireBrand().homeDirName;
      const partial = sdk.resolveBrand({ productName: "Acme Two" });
      out.partial = partial.ok ? [partial.brand.productName, partial.brand.homeDirName, partial.brand.keychainService] : "refused";
      out.home = sdk.resolveWinterHome({}).endsWith("/.acme/sdk");
      out.frozen = Object.isFrozen(sdk.installedBrand());
    `);
    expect(out).toEqual({
      incomplete: "TypeError",
      invalid: "TypeError",
      first: true,
      again: true,
      other: false,
      installed: ".acme",
      require: ".acme",
      partial: ["Acme Two", ".acme", "com.acme.core"],
      home: true,
      frozen: true,
    });
  });
});
