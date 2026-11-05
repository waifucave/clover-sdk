// A1 (fail closed), at the runtime's own session boundary: a config with no brand, in a process with
// none installed, is refused by the production wiring before it reads a home, an environment variable
// or a Keychain service; and the readers that used to fall back to Winter's names (the Keychain
// service, the home, the env names) refuse instead. Each case runs in a FRESH child process, because
// this repository's test preload installs Winter's own brand for the suites.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
// The SDK by path (a probe in a temp folder cannot resolve the package name): the same file the
// runtime's own imports resolve to, so the probe and the runtime share one installed brand.
const SDK = JSON.stringify(fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)));

function inFreshProcess(imports: string, body: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "runtime-brand-required-"));
  try {
    const script = join(dir, "probe.ts");
    writeFileSync(
      script,
      `${imports}\nconst out: Record<string, unknown> = {};\nconst code = async (f: () => unknown): Promise<unknown> => { try { const v = await f(); return { returned: v === undefined ? null : typeof v === "object" ? "object" : v }; } catch (e) { return (e as { code?: string }).code ?? (e as Error).name; } };\n${body}\nconsole.log(JSON.stringify(out));\n`,
    );
    const env = { PATH: process.env["PATH"] ?? "", HOME: dir, TMPDIR: dir };
    const result = Bun.spawnSync([process.execPath, script], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString().trim().split("\n").pop() ?? "";
    if (result.exitCode !== 0 || stdout === "") throw new Error(`probe failed (${result.exitCode}): ${result.stderr.toString()}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("A1: the runtime has no default brand", () => {
  test("the production wiring refuses a config with no brand (no Winter home, env or Keychain is read)", () => {
    const out = inFreshProcess(
      `import { buildProductionWiring } from ${JSON.stringify(here("./production-wiring.ts"))};\nimport { installedBrand } from ${SDK};`,
      `out.before = installedBrand() === undefined;
       out.wiring = await code(() => buildProductionWiring({ config: { cwd: process.cwd() } as never, env: {} }));
       out.after = installedBrand() === undefined;`,
    );
    expect(out).toEqual({ before: true, wiring: "brand_required", after: true });
  });

  test("the readers that fell back to Winter's names refuse: the Keychain service, the env names, the project folder", () => {
    const out = inFreshProcess(
      [
        `import { createKeychainCredentialStore, createKeychainSecretReader } from ${JSON.stringify(here("./provider/keychain-store.ts"))};`,
        `import { resolveMaxWebSearchesPerSession } from ${JSON.stringify(here("./tools/impl/_search-budget.ts"))};`,
        `import { pluginManifestDirs } from ${JSON.stringify(here("./plugins/manifest.ts"))};`,
        `import { resolveMcpServerSources } from ${JSON.stringify(here("./mcp/lifecycle.ts"))};`,
      ].join("\n"),
      `out.keychain = await code(() => createKeychainCredentialStore());
       out.secrets = await code(() => createKeychainSecretReader());
       out.envName = await code(() => resolveMaxWebSearchesPerSession({}));
       out.manifest = await code(() => pluginManifestDirs());
       out.mcp = await code(() => resolveMcpServerSources([], { trustedWorkspace: false }));`,
    );
    expect(out).toEqual({ keychain: "brand_required", secrets: "brand_required", envName: "brand_required", manifest: "brand_required", mcp: "brand_required" });
  });

  test("with the session's brand installed, the same readers read that brand, never Winter's", () => {
    const out = inFreshProcess(
      [
        `import { installBrand, WINTER_BRAND } from ${SDK};`,
        `import { pluginManifestDirs } from ${JSON.stringify(here("./plugins/manifest.ts"))};`,
        `import { maxWebSearchesPerSessionEnvName } from ${JSON.stringify(here("./tools/impl/_search-budget.ts"))};`,
      ].join("\n"),
      `installBrand({ ...WINTER_BRAND, productName: "Acme", packageName: "acme-agent", homeDirName: ".acme", projectDirName: ".acme", instructionsFile: "ACME.md", envPrefix: "ACME_", keychainService: "com.acme.core", mcpServerName: "acme", presetName: "acme_code", processLabel: "acme", codexOriginator: "acme", tempRootName: "acme", pluginManifestDir: ".acme-plugin", contactUrl: "https://example.com/acme" });
       out.manifest = pluginManifestDirs()[0];
       out.envName = maxWebSearchesPerSessionEnvName().startsWith("ACME_");`,
    );
    expect(out).toEqual({ manifest: ".acme-plugin", envName: true });
  });
});
