// `@waifucave/clover-agent-sdk/acp` — the Agent Client Protocol (ACP v1), both sides (Clover plan §4 K-M3).
//
// * The protocol layer: a tolerant JSON-RPC 2.0 peer over NDJSON (`RpcPeer`) and tolerant readers of ACP's shapes
//   (`types.ts`). Clover's agent manager (its ACP client, for Cursor, Antigravity, Claude Code and the rest) and its
//   bridge MCP server use them; they moved here from Clover's `agents/acp/` so the two sides share one wire.
// * The agent side: `serveAcpAgent` runs the SDK's coding agent as an ACP agent, so a bot can delegate to it like
//   to any other coding agent (Clover spec §9.3: the inherited coding mode becomes an ACP agent).
export * from "./jsonrpc.ts";
export * from "./types.ts";
export { ACP_AGENT_PROTOCOL_VERSION, ACP_MODES, mcpServersOf, runAcpAgentOnStdio, serveAcpAgent, toolKindOf, type AcpAgentOptions, type AcpAgentServer, type AcpQuery, type AcpQueryFn } from "./agent.ts";
