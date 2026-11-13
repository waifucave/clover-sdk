// 0.0.80: the turn's model class reaches the file tools' read rule from the session's catalog row: the row's
// `strength` -> `describeCatalogModel` -> `ModelDescription.strength` -> the engine's per-call `editStrength` ->
// `ToolExecutionContext.editStrength` -> Edit. A strong row edits a file it never read; a weak row, or a row that
// states no class, is refused and told which line to read. Real engine, scripted model on a loopback endpoint.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@waifucave/clover-agent-sdk";
import { createMemoryCredentialStore } from "@waifucave/clover-provider-runtime";
import type { ModelStrength } from "@waifucave/clover-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { buildSessionProvider } from "../provider/session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type FakeBlock } from "../provider/anthropic-fake.test-support.ts";
import "./impl/index.ts";

type Block = Record<string, unknown>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function editUnreadFile(strength: ModelStrength | undefined): Promise<{ result: string; file: string }> {
  const model = "anthropic/claude-opus-5-5";
  const home = mkdtempSync(join(tmpdir(), "clover-strength-turn-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "notes.md");
  writeFileSync(file, "one\ntwo\nthree\n");
  const call: FakeBlock = { type: "tool_use", id: "t1", name: "Edit", input: { file_path: file, old_string: "two\n", new_string: "TWO\n" } };
  const fake = await startAnthropicFake((_r, i) => (i === 0 ? { blocks: [call], stopReason: "tool_use" } : { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" }));
  cleanups.push(() => fake.close());
  const base = fakeAnthropicCatalog(fake.url, [model]);
  // The row as the catalog (or a model plugin's catalog.json) carries it; "no class" is a row without the field (a
  // third-party plugin's row that states none).
  const catalog = { ...base, models: base.models.map(({ strength: _own, ...m }) => (strength === undefined ? m : { ...m, strength })) };
  const config = {
    sessionId: `strength-${strength ?? "none"}`, cwd: home, model, winterHome: join(home, ".sdk-home"), persistSession: false,
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
  } as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config, input: runtime.input, output: runtime.output, provider: wiring.provider,
    providerIdentity: { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: "anthropic" },
    describeModel: (m: string, p?: string) => describeCatalogModel(catalog, m, p),
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
  } as EngineOptions);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  for (const f of frames) {
    const content = (f as { message?: { message?: { content?: unknown } } }).message?.message?.content;
    if (Array.isArray(content)) for (const b of content as Block[]) if (b["type"] === "tool_result" && b["tool_use_id"] === "t1") return { result: JSON.stringify(b["content"]), file };
  }
  throw new Error("no tool result for t1");
}

test("a strong row: Edit of a file the model never read goes through", async () => {
  const { result, file } = await editUnreadFile("strong");
  expect(result).not.toContain("has not been read");
  expect(readFileSync(file, "utf8")).toBe("one\nTWO\nthree\n");
}, 30_000);

test("a medium row: the same", async () => {
  const { file } = await editUnreadFile("medium");
  expect(readFileSync(file, "utf8")).toBe("one\nTWO\nthree\n");
}, 30_000);

for (const strength of ["weak", undefined] as const) {
  test(`${strength === undefined ? "a row that states no class" : "a weak row"}: refused, told the line to read, the file unchanged`, async () => {
    const { result, file } = await editUnreadFile(strength);
    expect(result).toContain("this edit changes line 2");
    expect(result).toContain("Read line 2 first (offset 2, limit 1)");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
  }, 30_000);
}
