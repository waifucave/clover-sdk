// Clover A-M2: a session on its host's model plugins. The catalog comes from the host's file (digest-checked and
// validated), the registry holds the generic adapters and the host's stubs only, and a provider no plugin brings is
// a provider the session has not got.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogFromModelPlugins, loadCatalog, modelPluginForProvider, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import { createRegistry, WinterProviderResolutionError } from "@waifucave/clover-provider-runtime";
import { hostModelProviders, readHostCatalog } from "./model-plugins.ts";

const sdk = loadCatalog();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function catalogFile(providerIds: readonly string[], edit?: (p: WinterCatalog["providers"][number]) => WinterCatalog["providers"][number]): { path: string; sha256: string } {
  const built = catalogFromModelPlugins(
    providerIds.map((id) => {
      const { entry, file } = modelPluginForProvider(sdk, id);
      return { pluginId: `clover/model-${id}`, entry: { ...entry, auth: [] }, catalog: file, trusted: true };
    }),
    { families: sdk.families, catalogVersion: "test" },
  );
  const catalog = edit === undefined ? built.catalog : { ...built.catalog, providers: built.catalog.providers.map(edit) };
  return writeCatalog(catalog);
}

/** `shipped` plus a provider this build doesn't ship, `rogue`: Bedrock's rows and adapter id under an id of its own. */
function forgedCatalogFile(shipped: readonly string[]): { path: string; sha256: string } {
  const bedrock = JSON.parse(JSON.stringify(sdk)) as WinterCatalog;
  const base = JSON.parse(readFileSync(catalogFile(shipped).path, "utf8")) as WinterCatalog;
  const provider = bedrock.providers.find((p) => p.id === "bedrock")!;
  const rogue = { ...provider, id: "rogue", displayName: "Rogue" };
  const rows = bedrock.models.filter((m) => m.providerId === "bedrock").map((m) => ({ ...m, providerId: "rogue", key: m.key.replace(/^bedrock\//, "rogue/"), modelFamily: base.families.some((f) => f.id === m.modelFamily) ? m.modelFamily : "other" }));
  return writeCatalog({ ...base, providers: [...base.providers, rogue], models: [...base.models, ...rows] });
}

function writeCatalog(catalog: WinterCatalog): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "clover-model-catalog-"));
  dirs.push(dir);
  const bytes = JSON.stringify(catalog);
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

  test("a provider in the host's catalog whose adapter the host doesn't serve stays on this build's own adapter (Clover #302 B3)", () => {
    const file = catalogFile(["groq", "bedrock", "vertex"]);
    // The host serves nothing: Bedrock's and Vertex's plugins run on Node, which its plugin host doesn't start.
    const providers = hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256 }, undefined);
    const adapters = providers.adapters(providers.catalog);
    const ids = adapters.map((a) => a.id);
    expect(ids).toContain("winter.bedrock-converse");
    expect(ids).toContain("winter.vertex-gemini");
    // Only the catalog's own adapters: none for a provider the host didn't bring.
    expect(ids).not.toContain("winter.codex-oauth");
    const registry = createRegistry(providers.catalog);
    for (const a of adapters) registry.register(a);
    expect((registry.resolve({ model: "bedrock/amazon.nova-lite-v1:0" }) as { adapterId: string }).adapterId).toBe("winter.bedrock-converse");
    // A served adapter wins over this build's own: one registration per id.
    const served = hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "winter.bedrock-converse", version: "1", family: "bedrock", protocol: "bedrock-converse" }] }, sender);
    expect(served.adapters(served.catalog).filter((a) => a.id === "winter.bedrock-converse")).toHaveLength(1);
  });

  test("a provider this build doesn't ship that names a compiled adapter's id gets no compiled adapter (it refuses no-adapter)", async () => {
    // A third party's provider on winter.bedrock-converse, and no shipped provider naming that adapter.
    const forged = forgedCatalogFile(["groq"]);
    const alone = hostModelProviders({ catalogPath: forged.path, catalogSha256: forged.sha256 }, undefined);
    const adapters = alone.adapters(alone.catalog);
    expect(adapters.map((a) => a.id)).not.toContain("winter.bedrock-converse");
    const registry = createRegistry(alone.catalog);
    for (const a of adapters) registry.register(a);
    const refused = registry.resolve({ model: "rogue/amazon.nova-lite-v1:0" });
    expect(refused).toBeInstanceOf(WinterProviderResolutionError);
    expect((refused as WinterProviderResolutionError).code).toBe("no-adapter");

    // Beside the shipped Bedrock provider: Bedrock keeps this build's adapter; every call for the rogue provider is
    // refused no-adapter, before any request.
    const both = forgedCatalogFile(["groq", "bedrock"]);
    const mixed = hostModelProviders({ catalogPath: both.path, catalogSha256: both.sha256 }, undefined);
    const bedrockAdapter = mixed.adapters(mixed.catalog).find((a) => a.id === "winter.bedrock-converse")!;
    expect(bedrockAdapter).toBeDefined();
    const ctx = (providerId: string) => ({ connection: { providerId }, log: () => {} }) as never;
    const turn = bedrockAdapter.streamTurn({ model: "amazon.nova-lite-v1:0", messages: [] } as never, ctx("rogue"));
    let error: unknown;
    try {
      for await (const _ of turn) break;
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WinterProviderResolutionError);
    expect((error as WinterProviderResolutionError).code).toBe("no-adapter");
    await expect(bedrockAdapter.validateCredential({} as never, ctx("rogue"))).rejects.toMatchObject({ code: "no-adapter" });
    await expect(bedrockAdapter.listModels(ctx("rogue"))).rejects.toMatchObject({ code: "no-adapter" });
    // The shipped provider is let through (whatever its call then does without credentials).
    const own = await Promise.resolve(bedrockAdapter.validateCredential({} as never, ctx("bedrock"))).catch((err: unknown) => err);
    expect((own as { code?: string } | undefined)?.code).not.toBe("no-adapter");
  });

  test("a shipped provider id on an adapter this build doesn't pair it with gets no compiled adapter", () => {
    // `groq` is shipped on the generic chat adapter; a catalog naming winter.bedrock-converse for it gets nothing.
    const file = catalogFile(["groq"], (p) => ({ ...p, adapterId: "winter.bedrock-converse" }));
    const providers = hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256 }, undefined);
    expect(providers.adapters(providers.catalog).map((a) => a.id)).not.toContain("winter.bedrock-converse");
  });

  test("a catalog file that does not match its digest, or a host serving a generic adapter's id, fails the start", () => {
    const file = catalogFile(["groq"]);
    expect(() => readHostCatalog(file.path, "0".repeat(64))).toThrow(/does not match its digest/);
    expect(() => hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "winter.openai-chat-completions", version: "1", family: "openai", protocol: "openai-chat-completions" }] }, sender)).toThrow(/generic adapter/);
    expect(() => hostModelProviders({ catalogPath: file.path, catalogSha256: file.sha256, hostAdapters: [{ id: "plugin.x.adapter", version: "1", family: "openai", protocol: "openai-chat-completions" }] }, undefined)).toThrow(/no line to it/);
  });
});
