// A probe model adapter for the interface's own tests: it reports what its context let it do, never a
// secret's value. In process (the bridge tests) and served in a process of its own (`probe-process.ts`).
import { winterUserAgent } from "../../identity.ts";
import { MODEL_ADAPTER_INTERFACE_VERSION, type ModelAdapter } from "../types.ts";

export function createProbeAdapter(): ModelAdapter {
  return {
    interfaceVersion: MODEL_ADAPTER_INTERFACE_VERSION,
    id: "probe",
    version: "1.0.0",
    family: "custom",
    protocol: "openai-chat-completions",
    mapEffort: () => ({ ok: true, value: undefined }),
    capabilities: () => ({ toolCalling: "none", readableState: "none" }),
    async validateCredential(ctx) {
      // A hung check, for the host's deadline.
      if (ctx.connection.headers?.["x-hang"] === "1") await new Promise<never>(() => {});
      const secret = ctx.secrets === undefined ? undefined : await ctx.secrets.get("demo");
      return secret === null || secret === undefined ? { ok: false, code: "missing", message: "no demo secret" } : { ok: true };
    },
    async listModels() {
      return { models: [{ id: "probe-1" }], partial: false, cached: false, warnings: [] };
    },
    async *streamTurn(req, ctx) {
      yield { type: "message_start", model: req.model };
      const prompt = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      if (prompt === "identity") {
        yield { type: "text_delta", text: `ua:${winterUserAgent()}` };
        return;
      }
      if (prompt === "stall") {
        // Waits for the caller's cancel, then says it saw it.
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted === true) resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "text_delta", text: "cancelled" };
        return;
      }
      ctx.log({ kind: "probe.turn", providerId: ctx.connection.providerId });
      const secret = ctx.secrets === undefined ? "absent" : await ctx.secrets.get("demo").then((m) => (m === null ? "none" : `${m.kind}`));
      yield { type: "text_delta", text: `secrets:${secret};` };
      const res = await ctx.fetch(`${ctx.connection.baseUrl}/echo`, { method: "POST", body: "from-adapter" }, ctx.secrets === undefined ? {} : { auth: false });
      yield { type: "text_delta", text: `fetched:${res.status}:${await res.text()};` };
      if (prompt === "escape") {
        const escaped = await fetch(`${ctx.connection.headers?.["x-other"] ?? ""}/echo`).then((r) => `reached:${r.status}`, (e: unknown) => `refused:${(e as { code?: string }).code ?? "error"}`);
        yield { type: "text_delta", text: escaped };
      }
      yield { type: "usage", inputTokens: 1, outputTokens: 2 };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}
