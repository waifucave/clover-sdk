// Clover A-M2: a session on its host's model plugins. The catalog comes from the host's file (digest-checked and
// validated), the registry holds the generic adapters and the host's stubs only, and a provider no plugin brings is
// a provider the session has not got.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogFromModelPlugins, loadCatalog, modelPluginForProvider } from "@waifucave/clover-provider-catalog";
import { createRegistry, WinterProviderResolutionError } from "@waifucave/clover-provider-runtime";
import { hostModelProviders, readHostCatalog } from "./model-plugins.ts";

const sdk = loadCatalog();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function catalogFile(providerIds: readonly string[]): { path: string; sha256: string } {
  const built = catalogFromModelPlugins(
    providerIds.map((id) => {
      const { entry, file } = modelPluginForProvider(sdk, id);
      return { pluginId: `clover/model-${id}`, entry: { ...entry, auth: [] }, catalog: file, trusted: true };
    }),
    { families: sdk.families, catalogVersion: "test" },
  );
  const dir = mkdtempSync(join(tmpdir(), "clover-model-catalog-"));
  dirs.push(dir);
  const bytes = JSON.stringify(built.catalog);
  const path = join(dir, "catalog.json");
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const sender = { request: async () => ({}) as never };

describe("a session on the host's model plugins", () => {
  test("its registry has the plugins' providers on the generic adapters and the host's stubs, and nothing else", () => {
    const file = catalogFile(["groq", "anthropic", "bedrock"]);
    const providers = hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "winter.bedrock-converse", version: "1", family: "bedrock", protocol: "bedrock-converse" }] }, sender);
    expect(providers.catalog.providers.map((p) => p.id)).toEqual(["groq", "anthropic", "bedrock"]);
    const adapters = providers.adapters(providers.catalog);
    expect(adapters.map((a) => a.id).sort()).toEqual(["winter.anthropic-messages", "winter.bedrock-converse", "winter.local-openai", "winter.openai-chat-completions", "winter.openai-responses"]);
    const registry = createRegistry(providers.catalog);
    for (const a of adapters) registry.register(a);
    const groq = registry.resolve({ model: "groq/llama-3.3-70b-versatile" });
    expect(groq).not.toBeInstanceOf(WinterProviderResolutionError);
    expect((groq as { adapterId: string }).adapterId).toBe("winter.openai-chat-completions");
    expect((registry.resolve({ model: "bedrock/amazon.nova-lite-v1:0" }) as { adapterId: string }).adapterId).toBe("winter.bedrock-converse");
    // No plugin brings OpenAI: the session has no such provider, whatever this build ships.
    const openai = registry.resolve({ model: "openai/gpt-4.1" });
    expect(openai).toBeInstanceOf(WinterProviderResolutionError);
    expect((openai as WinterProviderResolutionError).code).toBe("unknown-provider");
  });

  test("a catalog file that does not match its digest, or a host serving a generic adapter's id, fails the start", () => {
    const file = catalogFile(["groq"]);
    expect(() => readHostCatalog(file.path, "0".repeat(64))).toThrow(/does not match its digest/);
    expect(() => hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "winter.openai-chat-completions", version: "1", family: "openai", protocol: "openai-chat-completions" }] }, sender)).toThrow(/generic adapter/);
    expect(() => hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "plugin.x.adapter", version: "1", family: "openai", protocol: "openai-chat-completions" }] }, undefined)).toThrow(/no line to it/);
  });
});
