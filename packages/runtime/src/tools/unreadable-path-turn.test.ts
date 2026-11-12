// SDK 0.0.79: a file-tool call whose own path the process can't read (a folder macOS keeps it out of without Full
// Disk Access; a mode-000 folder stands in for that here) is denied as that one call; the turn goes on. It used to
// end the whole turn with `error_during_execution` ("EACCES: permission denied, lstat …"), thrown by the engine's
// identity probe (`probeRule`, outside `evaluate()`'s per-call boundary) resolving the call's path. No deny lists:
// the built-in baseline rules are enough to reach that probe. Real engine, scripted model on a loopback endpoint.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@waifucave/clover-agent-sdk";
import { createMemoryCredentialStore } from "@waifucave/clover-provider-runtime";
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

for (const mode of ["default", "bypassPermissions"] as const) {
  test(`${mode}: a Read and a Write inside a folder the process can't read are each denied; the next call runs; the turn ends normally`, async () => {
    const model = "anthropic/claude-opus-5-5";
    const home = mkdtempSync(join(tmpdir(), "winter-unreadable-home-"));
    const mail = join(home, "Library", "Mail");
    mkdirSync(join(mail, "V10"), { recursive: true });
    writeFileSync(join(mail, "V10", "inbox.mbox"), "mail");
    mkdirSync(join(home, "Desktop"), { recursive: true });
    writeFileSync(join(home, "Desktop", "a.md"), "DESKTOP-NOTE");
    chmodSync(mail, 0o000);
    cleanups.push(() => { chmodSync(mail, 0o755); rmSync(home, { recursive: true, force: true }); });
    const calls: FakeBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: join(mail, "V10", "inbox.mbox") } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: join(mail, "new.md"), content: "x" } },
      { type: "tool_use", id: "t3", name: "Read", input: { file_path: join(home, "Desktop", "a.md") } },
    ];
    const fake = await startAnthropicFake((_r, i) => (i < calls.length ? { blocks: [calls[i]!], stopReason: "tool_use" } : { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" }));
    cleanups.push(() => fake.close());
    const catalog = fakeAnthropicCatalog(fake.url, [model]);
    const config = {
      sessionId: `unreadable-${mode}`, cwd: home, model, winterHome: join(home, ".sdk-home"), persistSession: false,
      permissionMode: mode, allowDangerouslySkipPermissions: true,
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
    // Every scripted call got its answer and the model was asked again after each: four requests.
    expect(fake.requests.filter((r) => r.path === "/v1/messages")).toHaveLength(4);
    const results = new Map<string, Block>();
    for (const f of frames) {
      const content = ((f as { message?: { message?: { content?: unknown } } }).message?.message?.content);
      if (Array.isArray(content)) for (const b of content as Block[]) if (b["type"] === "tool_result") results.set(String(b["tool_use_id"]), b);
    }
    for (const id of ["t1", "t2"]) {
      expect(String(results.get(id)?.["content"])).toContain("couldn't read a path the call names (EACCES");
    }
    expect(JSON.stringify(results.get("t3")?.["content"])).toContain("DESKTOP-NOTE");
    const result = frames.map((f) => (f as { message?: { type?: string; subtype?: string } }).message).find((m) => m?.type === "result");
    expect(result?.subtype).toBe("success");
  }, 30_000);
}
