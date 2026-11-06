// The ACP v1 wire shapes the client uses, read tolerantly (spike S5 §5 risk 3): agents add fields (Antigravity's
// `name` and `args`), send snake_case duplicates (`load_session`), and leave out fields the schema marks required.
// Every reader here takes `unknown` and never throws; a field that isn't the type it should be reads as absent.
// The protocol is ACP v1 (`protocolVersion: 1`); the v2 draft is out of scope until an agent the suite runs needs it.

export const ACP_PROTOCOL_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Reads `path` (`rawInput.providerIdentifier`) from an object. */
export function at(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const key of path.split(".")) {
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[key];
  }
  return cur;
}

/** A key, or its snake_case twin where the agent sends one (`loadSession` / `load_session`). */
export function either(o: Obj | undefined, camel: string): unknown {
  if (!o) return undefined;
  if (o[camel] !== undefined) return o[camel];
  return o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

/** What `initialize` told us, read tolerantly. */
export interface AgentCaps {
  protocolVersion: number | undefined;
  loadSession: boolean;
  resume: boolean;
  close: boolean;
  list: boolean;
  image: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  authMethods: { id: string; name: string }[];
  agentInfo?: { name?: string; version?: string };
  /** Antigravity's `_meta.antigravity.systemPrompt.append` (S5 edit 3). */
  systemPromptAppend: boolean;
}

/** `{ [key]: value }` when the value is a non-empty string, else nothing (for `exactOptionalPropertyTypes`). */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? ({ [key]: value } as { [P in K]?: string }) : {};
}

export function readCaps(result: unknown): AgentCaps {
  const r = obj(result);
  const caps = obj(either(r, "agentCapabilities"));
  const session = obj(either(caps, "sessionCapabilities"));
  const prompt = obj(either(caps, "promptCapabilities"));
  const mcp = obj(either(caps, "mcpCapabilities"));
  const info = obj(either(r, "agentInfo"));
  return {
    protocolVersion: num(either(r, "protocolVersion")),
    loadSession: either(caps, "loadSession") === true || obj(session?.["load"]) !== undefined,
    resume: obj(session?.["resume"]) !== undefined,
    close: obj(session?.["close"]) !== undefined,
    list: obj(session?.["list"]) !== undefined,
    image: prompt?.["image"] === true,
    mcpHttp: mcp?.["http"] === true,
    mcpSse: mcp?.["sse"] === true,
    authMethods: arr(either(r, "authMethods")).flatMap((m) => {
      const o = obj(m);
      const id = str(o?.["id"]);
      return id ? [{ id, name: str(o?.["name"]) ?? id }] : [];
    }),
    ...(info ? { agentInfo: { ...optional("name", str(info["name"])), ...optional("version", str(info["version"])) } } : {}),
    systemPromptAppend: at(caps, "_meta.antigravity.systemPrompt.append") === true,
  };
}

/** One `select` config option (`session/set_config_option`, categories `model` and `thought_level`). */
export interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  values: string[];
}

export function readConfigOptions(v: unknown): ConfigOption[] | undefined {
  const list = obj(v) ? either(obj(v), "configOptions") : v;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((o) => {
    const c = obj(o);
    const id = str(c?.["id"]);
    if (!id) return [];
    return [{
      id,
      ...optional("category", str(c?.["category"])),
      ...optional("currentValue", str(either(c, "currentValue"))),
      values: arr(c?.["options"]).flatMap((x) => {
        const v = str(obj(x)?.["value"]);
        return v ? [v] : [];
      }),
    }];
  });
}

/** The stdio MCP server entry `session/new` takes (`env` as name/value pairs). */
export interface StdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export const PERMISSION_KINDS: readonly PermissionKind[] = ["allow_once", "allow_always", "reject_once", "reject_always"];

export function readPermissionOptions(v: unknown): { optionId: string; name: string; kind: PermissionKind }[] {
  return arr(v).flatMap((o) => {
    const x = obj(o);
    const optionId = str(either(x, "optionId"));
    const kind = str(x?.["kind"]) as PermissionKind | undefined;
    if (!optionId || !kind || !PERMISSION_KINDS.includes(kind)) return [];
    return [{ optionId, name: str(x?.["name"]) ?? optionId, kind }];
  });
}

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
export function readToolStatus(v: unknown): ToolStatus | undefined {
  return v === "pending" || v === "in_progress" || v === "completed" || v === "failed" ? v : undefined;
}

/** Text from a content block (`{ type: "text", text }`), or from a tool call's `content` entry wrapping one. */
export function textOf(content: unknown): string | undefined {
  const c = obj(content);
  if (!c) return undefined;
  if (c["type"] === "text") return str(c["text"]);
  if (c["type"] === "content") return textOf(c["content"]);
  return undefined;
}

/** The paths a tool call names: its `locations`, and the path-like fields of its input. */
export function pathsOf(toolCall: Obj | undefined, rawInput: unknown): string[] {
  const out = new Set<string>();
  for (const l of arr(toolCall?.["locations"])) {
    const p = str(obj(l)?.["path"]);
    if (p) out.add(p);
  }
  for (const c of arr(toolCall?.["content"])) {
    const o = obj(c);
    if (o?.["type"] === "diff" && str(o["path"])) out.add(str(o["path"])!);
  }
  const input = obj(rawInput);
  for (const key of ["path", "Path", "file_path", "filePath", "target", "TargetFile", "AbsolutePath", "notebook_path", "directory", "cwd", "Cwd"]) {
    const p = str(input?.[key]);
    if (p) out.add(p);
  }
  return [...out];
}

/** Whether an error answer says the agent needs its own sign-in (S5 §7 "Auth required"): ACP's `auth_required`
 *  is -32000; Cursor's names its login command. */
export function isAuthRequired(err: { code?: number; message?: string }, required: { code?: number; messagePattern?: string }): boolean {
  const msg = err.message ?? "";
  if (required.messagePattern !== undefined && new RegExp(required.messagePattern, "i").test(msg)) return true;
  if (required.code !== undefined && err.code === required.code) return true;
  return /auth(entication)? required|not (logged|signed) in/i.test(msg);
}
