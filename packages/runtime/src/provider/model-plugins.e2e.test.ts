// Clover A-M2, end to end through `query()`: a session whose providers are its host's model plugins. The host
// serves a code plugin's adapter over the control wire (`model_adapter_*`): the turn's request reaches the host's
// adapter, its events come back as the session's answer, and the session never asks for a credential for it.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CredentialResolveRequest } from "@waifucave/clover-agent-sdk";
import { catalogFromModelPlugins, loadCatalog, modelPluginForProvider } from "@waifucave/clover-provider-catalog";
import { createHostModelAdapterServer, type HostModelAdapter, type ProviderEvent, type TurnRequest } from "@waifucave/clover-provider-runtime";
import { inMemoryProcess } from "../testing.ts";
import { echoProvider } from "./mock.ts";

const sdk = loadCatalog();
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a turn on a host-served adapter: the request reaches the host's plugin, its text is the answer, no credential is asked", async () => {
  const home = mkdtempSync(join(tmpdir(), "clover-model-plugins-e2e-"));
  temps.push(home);
  const built = catalogFromModelPlugins(
    ["groq", "bedrock"].map((id) => {
      const { entry, file } = modelPluginForProvider(sdk, id);
      return { pluginId: `clover/model-${id}`, entry: { ...entry, auth: [] }, catalog: file, trusted: true };
    }),
    { families: sdk.families, catalogVersion: "e2e" },
  );
  const bytes = JSON.stringify(built.catalog);
  const catalogPath = join(home, "catalog.json");
  writeFileSync(catalogPath, bytes);

  const seen: TurnRequest[] = [];
  const plugin: HostModelAdapter = {
    async *streamTurn(req): AsyncGenerator<ProviderEvent> {
      seen.push(req);
      yield { type: "message_start", id: "m1", model: req.model };
      yield { type: "text_delta", text: "served " };
      yield { type: "text_delta", text: "by the plugin" };
      yield { type: "usage", inputTokens: 3, outputTokens: 4 } as ProviderEvent;
      yield { type: "done", stopReason: "end_turn" };
    },
    listModels: async () => ({ models: [], partial: false, cached: false, warnings: [] }),
    validateCredential: async () => ({ ok: true }),
  };
  const server = createHostModelAdapterServer((id) => (id === "winter.bedrock-converse" ? plugin : undefined));
  const asks: CredentialResolveRequest[] = [];
  const frames: string[] = [];
  const q = query({
    prompt: "hi",
    options: {
      model: "bedrock/amazon.nova-lite-v1:0",
      provider: { providerId: "bedrock", authRef: { kind: "none" }, connection: { region: "us-east-1" } },
      modelProviders: {
        catalog: { path: catalogPath, sha256: createHash("sha256").update(bytes).digest("hex") },
        hostAdapters: [{ id: "winter.bedrock-converse", version: "1", family: "bedrock", protocol: "bedrock-converse" }],
        serve: (subtype, payload) => server.handle(subtype, payload),
      },
      onCredentialResolve: async (req) => {
        asks.push(req);
        return { ok: false, reason: "not_found" };
      },
      spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, echoProvider, undefined, { WINTER_HOME: home, HOME: home }),
    },
  });
  for await (const msg of q) frames.push(JSON.stringify(msg));
  expect(seen.length).toBe(1);
  expect(seen[0]!.model).toBe("amazon.nova-lite-v1:0");
  expect(JSON.stringify(frames)).toContain("served by the plugin");
  expect(asks.filter((a) => a.ref.account.startsWith("bedrock"))).toEqual([]);
  expect(server.open).toBe(0);
}, 30_000);
