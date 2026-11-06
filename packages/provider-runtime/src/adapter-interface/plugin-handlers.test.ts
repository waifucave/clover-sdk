// Clover A-M2: a code model plugin's handler object (`modelAdapterHandlers`) and its adapter (`familyModelAdapter`),
// built from the plugin's own manifest entry and catalog file.
import { describe, expect, test } from "bun:test";
import { loadCatalog, modelPluginForProvider } from "@waifucave/clover-provider-catalog";
import { familyModelAdapter, materialOfSecret, modelAdapterHandlers } from "./plugin-handlers.ts";

const sdk = loadCatalog();

describe("a code model plugin's adapter and handlers", () => {
  test("the family adapter its catalog file names, keyless, describing itself on interface 1", () => {
    const { entry, file } = modelPluginForProvider(sdk, "google");
    const adapter = familyModelAdapter({ pluginId: "clover/model-google", entry: { ...entry, auth: [{ method: "api-key" }] }, catalogFile: file, credential: { keyed: { name: "api-key", material: "api-key" } } });
    expect(modelAdapterHandlers(adapter).describe()).toEqual({ interfaceVersion: 1, id: "winter.google-generate-content", version: adapter.version, family: adapter.family, protocol: adapter.protocol, countTokens: true });
  });

  test("a signing adapter refuses where secrets.get does not exist, before anything is sent", async () => {
    const { entry, file } = modelPluginForProvider(sdk, "bedrock");
    const adapter = familyModelAdapter({ pluginId: "clover/model-bedrock", entry: { ...entry, auth: [] }, catalogFile: file, credential: { signing: "aws" } });
    const handlers = modelAdapterHandlers(adapter);
    let sent = 0;
    const ctx = { signal: new AbortController().signal, api: { net: { fetch: async () => (sent++, new Response("")) } } };
    const events: unknown[] = [];
    try {
      for await (const e of handlers.streamTurn({ req: { model: "amazon.nova-lite-v1:0", messages: [{ role: "user", content: "hi" }] }, connection: { providerId: "bedrock", region: "us-east-1" }, stallTimeoutMs: 1000 }, ctx)) events.push(e);
    } catch (err) {
      events.push({ thrown: (err as { code?: string }).code });
    }
    expect(JSON.stringify(events)).toContain("capability");
    expect(sent).toBe(0);
  });

  test("a secret's value is JSON material, or a bare key", () => {
    expect(materialOfSecret('{"kind":"aws","accessKeyId":"a","secretAccessKey":"b"}')).toEqual({ kind: "aws", accessKeyId: "a", secretAccessKey: "b" } as never);
    expect(materialOfSecret("plain-key")).toEqual({ kind: "api-key", key: "plain-key" });
    expect(materialOfSecret("{not json")).toEqual({ kind: "api-key", key: "{not json" });
  });

  test("the codex adapter refuses a first-party originator", async () => {
    const { entry, file } = modelPluginForProvider(sdk, "codex-oauth");
    expect(() => familyModelAdapter({ pluginId: "x", entry: { ...entry, auth: [] }, catalogFile: file, credential: { keyed: { name: "chatgpt", material: "oauth" } }, codexOriginator: "codex_cli_rs" })).toThrow(/first party/);
    expect(familyModelAdapter({ pluginId: "x", entry: { ...entry, auth: [] }, catalogFile: file, credential: { keyed: { name: "chatgpt", material: "oauth" } }, codexOriginator: "clover" }).id).toBe("winter.codex-oauth");
  });
});
