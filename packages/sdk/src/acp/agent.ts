// The coding agent as an ACP agent (Clover spec §9.3: the inherited coding mode "becomes an ACP agent that bots can
// delegate to like any other"): `serveAcpAgent` speaks the Agent Client Protocol (v1, over NDJSON on stdio) to a
// client such as Clover's agent manager, and runs each ACP session on `query()`.
//
// | ACP                                   | The SDK                                                                    |
// | :------------------------------------ | :------------------------------------------------------------------------- |
// | `session/new` (`cwd`, `mcpServers`)   | a `query()` with that `cwd`, those MCP servers, and a pre-allocated id      |
// | `session/resume`                      | a `query()` with `resume` (no replay: the transcript store holds the past) |
// | `session/prompt`                      | the next input of the session's prompt stream, until its `result`         |
// | `session/update`                      | text and thinking deltas (`stream_event`), tool calls, their results       |
// | `session/request_permission`          | `canUseTool`: `allow_once`, `allow_always` or `reject_once`                 |
// | `session/set_config_option`, `set_mode` | `setModel`, `setEffort`, `setPermissionMode` (`plan` is the read-only mode) |
// | `session/cancel`                      | `interrupt()`                                                              |
// | `session/close`                       | the prompt stream ends                                                     |
//
// The client offers its own `fs` and `terminal`; this agent doesn't use them: its tools run in its own sandbox, as
// every coding agent's do (§9.3). It never authenticates anyone (`authMethods: []`): the SDK uses the host's
// providers as configured. `_meta.systemPrompt.append` at `session/new` is appended to the system prompt, which is
// how a client hands the agent its essentials.
import { RPC_INVALID_PARAMS, RpcError, RpcPeer } from "./jsonrpc.ts";
import { arr, obj, str, type Obj } from "./types.ts";

export const ACP_AGENT_PROTOCOL_VERSION = 1;

/** The parts of the SDK's `Query` this agent drives (a structural type, so tests can stand in for it). */
export interface AcpQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  setEffort?(effort?: string | null): Promise<void>;
  supportedModels?(): Promise<{ value: string; displayName?: string }[]>;
  return?(value?: unknown): Promise<unknown>;
}

export type AcpQueryFn = (args: { prompt: AsyncIterable<string>; options: Record<string, unknown> }) => AcpQuery;

export interface AcpAgentOptions {
  /** The SDK's `query` (or a stand-in). */
  query: AcpQueryFn;
  /** Options every session starts from (model, tools, sandbox…); `cwd`, `mcpServers`, `resume`, `sessionId`,
   *  `canUseTool` and `includePartialMessages` are set per session. */
  options?: Record<string, unknown>;
  agentInfo: { name: string; title?: string; version: string };
  /** One line out (stdout). */
  write(line: string): void;
  log?(line: string): void;
  /** A new session's id; a random UUID by default. */
  newId?(): string;
}

/** The modes offered: the SDK's permission modes a client may choose. `plan` asks before anything that writes. */
export const ACP_MODES = [
  { id: "default", name: "Default", description: "Asks before edits and commands" },
  { id: "acceptEdits", name: "Accept edits", description: "Edits without asking; asks before commands" },
  { id: "plan", name: "Plan", description: "Read-only: plans, and asks before any change" },
] as const;
const MODE_IDS: readonly string[] = ACP_MODES.map((m) => m.id);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

interface Turn {
  resolve(end: { stopReason: string; usage?: { inputTokens: number; outputTokens: number } }): void;
  reject(err: unknown): void;
  cancelled: boolean;
}

interface Session {
  id: string;
  q: AcpQuery;
  inputs: InputQueue;
  turn: Turn | undefined;
  model: string | undefined;
  mode: string;
  effort: string | undefined;
  models: string[];
  /** Tool calls seen, by id, for the updates' kinds. */
  streamed: boolean;
  closed: boolean;
}

/** An async iterable fed one input at a time: the session's prompt stream. */
class InputQueue implements AsyncIterable<string> {
  readonly #items: string[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  push(text: string): void {
    this.#items.push(text);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }
}

/** ACP's tool kinds from the coding agent's tool names. */
export function toolKindOf(name: string): string {
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "PowerShell":
      return "execute";
    case "Grep":
    case "Glob":
    case "LS":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "Think":
      return "think";
    default:
      return "other";
  }
}

function toolTitleOf(name: string, input: Obj | undefined): string {
  const path = str(input?.["file_path"]) ?? str(input?.["path"]) ?? str(input?.["notebook_path"]);
  const command = str(input?.["command"]);
  if (command && toolKindOf(name) === "execute") return command.length > 200 ? `${command.slice(0, 200)}…` : command;
  if (path) return `${name} ${path}`;
  const pattern = str(input?.["pattern"]) ?? str(input?.["url"]) ?? str(input?.["query"]);
  return pattern ? `${name} ${pattern}` : name;
}

function locationsOf(input: Obj | undefined): { path: string }[] {
  const path = str(input?.["file_path"]) ?? str(input?.["notebook_path"]) ?? str(input?.["path"]);
  return path ? [{ path }] : [];
}

/** ACP's MCP server entries as the SDK takes them. */
export function mcpServersOf(list: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of arr(list)) {
    const o = obj(s);
    const name = str(o?.["name"]);
    if (!o || !name) continue;
    const pairs = (v: unknown) => Object.fromEntries(arr(v).flatMap((p) => {
      const kv = obj(p);
      const k = str(kv?.["name"]);
      const val = str(kv?.["value"]);
      return k !== undefined && val !== undefined ? [[k, val]] : [];
    }));
    const type = str(o["type"]);
    if (type === "http" || type === "sse") {
      const url = str(o["url"]);
      if (url) out[name] = { type, url, headers: pairs(o["headers"]) };
    } else {
      const command = str(o["command"]);
      if (command) out[name] = { type: "stdio", command, args: arr(o["args"]).filter((a): a is string => typeof a === "string"), env: pairs(o["env"]) };
    }
  }
  return out;
}

function textOfPrompt(prompt: unknown): string {
  const parts: string[] = [];
  for (const b of arr(prompt)) {
    const o = obj(b);
    if (!o) continue;
    if (o["type"] === "text" && typeof o["text"] === "string") parts.push(o["text"]);
    else if (o["type"] === "resource_link" && typeof o["uri"] === "string") parts.push(`[${str(o["name"]) ?? "file"}](${o["uri"]})`);
    else if (o["type"] === "resource") {
      const r = obj(o["resource"]);
      if (typeof r?.["text"] === "string") parts.push(`<resource uri="${str(r["uri"]) ?? ""}">\n${r["text"]}\n</resource>`);
    }
  }
  return parts.join("\n\n");
}

function textOfToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content).map((c) => (obj(c)?.["type"] === "text" ? str(obj(c)?.["text"]) ?? "" : "")).filter(Boolean).join("\n");
}

export interface AcpAgentServer {
  /** Bytes from the client (stdin). */
  feed(chunk: Uint8Array | string): void;
  /** The client went away: every session's prompt stream ends. */
  close(): Promise<void>;
}

export function serveAcpAgent(o: AcpAgentOptions): AcpAgentServer {
  const sessions = new Map<string, Session>();
  const newId = o.newId ?? (() => crypto.randomUUID());

  const update = (sessionId: string, u: Obj) => peer.notify("session/update", { sessionId, update: u });

  const configOptions = (s: Session): Obj[] => {
    const out: Obj[] = [];
    const models = s.models.length > 0 ? s.models : s.model ? [s.model] : [];
    if (models.length > 0) {
      out.push({ id: "model", name: "Model", category: "model", type: "select", currentValue: s.model ?? models[0], options: models.map((m) => ({ value: m, name: m })) });
    }
    out.push({ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: ACP_MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) });
    if (s.q.setEffort) {
      out.push({ id: "thought_level", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort ?? "medium", options: EFFORTS.map((e) => ({ value: e, name: e })) });
    }
    return out;
  };
  const modesOf = (s: Session) => ({ currentModeId: s.mode, availableModes: ACP_MODES.map((m) => ({ ...m })) });

  const sessionOf = (params: Obj | undefined): Session => {
    const id = str(params?.["sessionId"]);
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.closed) throw new RpcError(RPC_INVALID_PARAMS, `no session ${id ?? "(none)"}`);
    return s;
  };

  const ask = async (s: Session, toolName: string, input: Record<string, unknown>, toolUseID: string, signal: AbortSignal) => {
    const outcome = await Promise.race([
      peer.request("session/request_permission", {
        sessionId: s.id,
        toolCall: { toolCallId: toolUseID, title: toolTitleOf(toolName, input), kind: toolKindOf(toolName), status: "pending", rawInput: input, locations: locationsOf(input) },
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }).then((r) => obj(obj(r)?.["outcome"])),
      new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true })),
    ]).catch(() => undefined);
    const picked = outcome?.["outcome"] === "selected" ? str(outcome["optionId"]) : undefined;
    if (picked === "allow_once" || picked === "allow_always") return { behavior: "allow" as const, updatedInput: input };
    return { behavior: "deny" as const, message: picked === "reject_once" ? "The user refused this." : "The request was cancelled." };
  };

  /** Reads one session's messages for its whole life, turning them into updates and ending each turn at its result. */
  const pump = async (s: Session) => {
    try {
      for await (const raw of s.q) {
        const m = obj(raw);
        if (!m) continue;
        const type = str(m["type"]);
        if (type === "system" && m["subtype"] === "init") {
          s.model = str(m["model"]) ?? s.model;
          const mode = str(m["permissionMode"]);
          if (mode && MODE_IDS.includes(mode)) s.mode = mode;
        } else if (type === "stream_event") {
          const ev = obj(m["event"]);
          const delta = obj(ev?.["delta"]);
          if (ev?.["type"] === "content_block_delta" && delta) {
            if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
              s.streamed = true;
              update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta["text"] } });
            } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
              s.streamed = true;
              update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta["thinking"] } });
            }
          }
        } else if (type === "assistant") {
          for (const b of arr(obj(m["message"])?.["content"])) {
            const block = obj(b);
            if (!block) continue;
            if (block["type"] === "text" && !s.streamed && typeof block["text"] === "string") {
              update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block["text"] } });
            } else if (block["type"] === "thinking" && !s.streamed && typeof block["thinking"] === "string") {
              update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block["thinking"] } });
            } else if (block["type"] === "tool_use") {
              const name = str(block["name"]) ?? "tool";
              const input = obj(block["input"]);
              update(s.id, {
                sessionUpdate: "tool_call", toolCallId: str(block["id"]) ?? "", title: toolTitleOf(name, input), kind: toolKindOf(name),
                status: "pending", rawInput: input ?? {}, locations: locationsOf(input),
              });
            }
          }
          s.streamed = false;
        } else if (type === "user") {
          for (const b of arr(obj(m["message"])?.["content"])) {
            const block = obj(b);
            if (block?.["type"] !== "tool_result") continue;
            const text = textOfToolResult(block["content"]);
            update(s.id, {
              sessionUpdate: "tool_call_update", toolCallId: str(block["tool_use_id"]) ?? "", status: block["is_error"] === true ? "failed" : "completed",
              ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
            });
          }
        } else if (type === "result") {
          const turn = s.turn;
          s.turn = undefined;
          if (!turn) continue;
          const usage = obj(m["usage"]);
          const inTok = Number(usage?.["input_tokens"]);
          const outTok = Number(usage?.["output_tokens"]);
          const sub = str(m["subtype"]);
          const stopReason = turn.cancelled ? "cancelled" : sub === "error_max_turns" ? "max_turn_requests" : sub === "success" ? "end_turn" : "end_turn";
          if (!turn.cancelled && sub !== "success" && sub !== "error_max_turns" && m["is_error"] === true) {
            turn.reject(new RpcError(-32603, str(m["result"]) ?? `the turn failed (${sub ?? "error"})`));
          } else {
            turn.resolve({ stopReason, ...(Number.isFinite(inTok) && Number.isFinite(outTok) ? { usage: { inputTokens: inTok, outputTokens: outTok } } : {}) });
          }
        }
      }
    } catch (err) {
      o.log?.(`acp: session ${s.id} ended: ${err instanceof Error ? err.message : String(err)}`);
    }
    s.closed = true;
    s.turn?.reject(new RpcError(-32603, "the session ended"));
    s.turn = undefined;
  };

  const open = async (params: Obj | undefined, resume: string | undefined): Promise<Session> => {
    const cwd = str(params?.["cwd"]);
    if (!cwd) throw new RpcError(RPC_INVALID_PARAMS, "cwd is required");
    const id = resume ?? newId();
    const inputs = new InputQueue();
    const append = str(obj(obj(params?.["_meta"])?.["systemPrompt"])?.["append"]);
    const base = o.options ?? {};
    const systemPrompt = append === undefined ? base["systemPrompt"] : typeof base["systemPrompt"] === "string"
      ? `${base["systemPrompt"]}\n\n${append}`
      : { type: "preset", preset: "claude_code", ...(obj(base["systemPrompt"]) ?? {}), append };
    let s!: Session;
    const q = o.query({
      prompt: inputs,
      options: {
        ...base,
        cwd,
        mcpServers: { ...(obj(base["mcpServers"]) ?? {}), ...mcpServersOf(params?.["mcpServers"]) },
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(resume ? { resume } : { sessionId: id }),
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool: (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => ask(s, toolName, input, opts.toolUseID, opts.signal),
      },
    });
    s = { id, q, inputs, turn: undefined, model: str(base["model"]), mode: "default", effort: str(base["effort"]), models: [], streamed: false, closed: false };
    sessions.set(id, s);
    void pump(s);
    if (q.supportedModels) s.models = await q.supportedModels().then((ms) => ms.map((m) => m.value), () => []);
    return s;
  };

  const handle = async (method: string, params: unknown): Promise<unknown> => {
    const p = obj(params);
    switch (method) {
      case "initialize":
        return {
          protocolVersion: ACP_AGENT_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { resume: {}, close: {} },
          },
          agentInfo: o.agentInfo,
          authMethods: [],
        };
      case "session/new": {
        const s = await open(p, undefined);
        return { sessionId: s.id, modes: modesOf(s), configOptions: configOptions(s) };
      }
      case "session/resume": {
        const id = str(p?.["sessionId"]);
        if (!id) throw new RpcError(RPC_INVALID_PARAMS, "sessionId is required");
        const old = sessions.get(id);
        if (old && !old.closed) return { modes: modesOf(old), configOptions: configOptions(old) };
        const s = await open(p, id);
        return { modes: modesOf(s), configOptions: configOptions(s) };
      }
      case "session/prompt": {
        const s = sessionOf(p);
        if (s.turn) throw new RpcError(-32602, "a turn is running");
        const text = textOfPrompt(p?.["prompt"]);
        const done = new Promise<{ stopReason: string; usage?: { inputTokens: number; outputTokens: number } }>((resolve, reject) => {
          s.turn = { resolve, reject, cancelled: false };
        });
        s.inputs.push(text);
        return done;
      }
      case "session/set_config_option": {
        const s = sessionOf(p);
        const id = str(p?.["configId"]);
        const value = str(p?.["value"]);
        if (!id || value === undefined) throw new RpcError(RPC_INVALID_PARAMS, "configId and value are required");
        if (id === "model") {
          await s.q.setModel(value);
          s.model = value;
        } else if (id === "mode") {
          if (!MODE_IDS.includes(value)) throw new RpcError(RPC_INVALID_PARAMS, `no mode ${value}`);
          await s.q.setPermissionMode(value);
          s.mode = value;
        } else if (id === "thought_level" && s.q.setEffort) {
          if (!(EFFORTS as readonly string[]).includes(value)) throw new RpcError(RPC_INVALID_PARAMS, `no effort ${value}`);
          await s.q.setEffort(value);
          s.effort = value;
        } else throw new RpcError(RPC_INVALID_PARAMS, `no config option ${id}`);
        return { configOptions: configOptions(s) };
      }
      case "session/set_mode": {
        const s = sessionOf(p);
        const mode = str(p?.["modeId"]);
        if (!mode || !MODE_IDS.includes(mode)) throw new RpcError(RPC_INVALID_PARAMS, `no mode ${mode ?? "(none)"}`);
        await s.q.setPermissionMode(mode);
        s.mode = mode;
        update(s.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
        return {};
      }
      case "session/close": {
        const s = sessionOf(p);
        s.closed = true;
        s.inputs.end();
        await s.q.return?.(undefined).catch(() => {});
        sessions.delete(s.id);
        return {};
      }
      default:
        throw new RpcError(-32601, `no method ${method}`);
    }
  };

  const peer = new RpcPeer({
    write: (line) => o.write(line),
    onRequest: (method, params) => handle(method, params),
    onNotification: (method, params) => {
      if (method !== "session/cancel") return;
      const id = str(obj(params)?.["sessionId"]);
      const s = id ? sessions.get(id) : undefined;
      if (!s?.turn) return;
      s.turn.cancelled = true;
      void s.q.interrupt().catch(() => {});
    },
  });

  return {
    feed: (chunk) => peer.feed(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk),
    close: async () => {
      for (const s of sessions.values()) {
        s.closed = true;
        s.inputs.end();
        await s.q.return?.(undefined).catch(() => {});
      }
      sessions.clear();
      peer.close();
    },
  };
}

/** Runs the agent on this process's stdin and stdout, until the client closes stdin. */
export async function runAcpAgentOnStdio(o: Omit<AcpAgentOptions, "write">): Promise<void> {
  const server = serveAcpAgent({ ...o, write: (line) => void process.stdout.write(line), log: o.log ?? ((line) => void process.stderr.write(`${line}\n`)) });
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (c: Buffer) => server.feed(c));
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
  await server.close();
}
