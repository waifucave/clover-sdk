// The HISTORY RENDERER: what each earlier assistant message carries into the request built for the
// model that runs NOW.
//
// THE WHOLE RULE: reasoning from an earlier turn reaches the target only in its NATIVE form, and only
// where the target accepts that form as it is. Per message:
//
//   same continuation domain, or the same model  -> EXACT native replay: its opaque state and its
//                                                   in-dialect thinking blocks ride unchanged;
//   anything else (another model, another provider,
//   or an origin nobody recorded)                -> every reasoning carrier is REMOVED (`nativeState`,
//                                                   and the Anthropic-family `thinking` /
//                                                   `redacted_thinking` blocks in the content), and
//                                                   NOTHING is put in its place.
//
// NOTHING IS GLUED IN. There is no text tag, no pasted summary, no "prior model's reasoning" note and
// no replay of another provider's sidecar state. The visible conversation -- text, tool calls, tool
// results -- crosses untouched; only the reasoning is left out. Until 2026-11 a cross-model message
// carried its source's summary or exposed reasoning as a `<recovered_reasoning>` text block; that is
// gone, and so is the `decoration` field it rode on: the renderer drops any `decoration` it is handed,
// on every role, so no annotation of any kind reaches an adapter.
//
// THE STORED TRANSCRIPT IS NOT TOUCHED. This builds a request; the session's own record of every turn's
// reasoning (the transcript and its provider-state sidecar) keeps it, and a switch BACK to the model
// that produced it replays it natively again -- each message answers only for itself, so arbitrary
// multi-hop chains compose from this one rule.
//
// WHY PER MESSAGE AND NOT PER SESSION: the returning model's own native state lights up again on the
// hop back while the intervening models' messages carry only what everyone can read.

import type { ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, MessageOrigin, ProviderMessageLike, ProviderNativeState } from "../types.ts";
import { createEndpointResolver, sameDomain, sameModel, type ReadableState } from "./domains.ts";

/** The target of THIS request. Structurally the `target` argument of the runtime's frozen `HistoryRenderer` seam. */
export interface HistoryTarget {
  family: string;
  continuationDomain?: string;
  readableState: ReadableState;
  /**
   * WS-23 (reasoning-state, decision 9): whether the target reads images and documents. `false` turns each
   * one into a short note that it was there (the switch review warns about exactly this) instead of a
   * request the adapter refuses outright. Absent: it does (the pre-WS-23 behaviour).
   */
  readsImages?: boolean;
  /**
   * The target model's OWN identity -- the resolved provider id and catalog key (runtime `bridge.ts`
   * passes `resolved.providerId`/`resolved.modelKey`). Read only by `sameModel`: a message produced by
   * this exact provider and model is the model's own prior turn, replayed exactly, even when the
   * catalog gives the row no continuation domain. Absent means "unknown", which never matches.
   */
  providerId?: string;
  modelKey?: string;
}

/** One assistant entry's folded sidecar records, as far as the renderer reads them. Structurally a subset of `ContinuationLink` from the runtime's `store/provider-state.ts`. */
export interface ContinuationLinkLike {
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  /** The turn's captured readable summary. Part of a real chain's shape; the renderer NEVER reads it (it is not sent to any model). */
  summary?: string;
}

/** What the renderer needs of a chain: a lookup by anchor uuid. `Map<string, ContinuationLink>` -- the runtime's `ContinuationChain` -- satisfies it exactly. */
export interface ContinuationChainLike {
  get(anchorUuid: string): ContinuationLinkLike | undefined;
}

/** What one render did. Counts only: nothing here can carry reasoning text or a payload. */
export interface RenderReport {
  /** Messages replayed with their native state intact (same domain, or the same model). */
  replayedNatively: number;
  /** Messages whose native state was left out because the target is another model. */
  droppedNativeState: number;
  /** In-dialect `thinking` / `redacted_thinking` blocks left out of a message's content. */
  strippedInDialectBlocks: number;
  /** Messages left out of the request entirely: another model's assistant turn whose only content was reasoning. */
  droppedEmptyMessages: number;
}

export interface HistoryRendererOptions {
  /** Called with every render's report. The frozen seam returns only messages; this is the side channel. */
  onReport?: (report: RenderReport) => void;
}

/**
 * The renderer.
 *
 * `render` is deliberately GENERIC over the message type rather than typed against the engine's
 * `ProviderMessage`: this package must never import the runtime (R6-4's cycle rule), and a generic
 * whose constraint is `ProviderMessageLike` is instantiated at `M = ProviderMessage` when this object
 * is assigned to the runtime's frozen `HistoryRenderer` seam.
 */
export interface WinterHistoryRenderer {
  render<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): M[];
  renderWithReport<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): { messages: M[]; report: RenderReport };
}

export function createHistoryRenderer(registry: ProviderRegistry, options: HistoryRendererOptions = {}): WinterHistoryRenderer {
  const resolveEndpoint = createEndpointResolver(registry);

  function renderWithReport<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): { messages: M[]; report: RenderReport } {
    const report: RenderReport = { replayedNatively: 0, droppedNativeState: 0, strippedInDialectBlocks: 0, droppedEmptyMessages: 0 };

    const out: M[] = [];
    for (const message of messages) {
      // An OFFICIAL-written (claude binary) assistant entry has no sidecar record at all, so
      // `message.origin` and the chain lookup are both absent for one; what it does carry is claude's
      // own `message.model`, read structurally (`ProviderMessageLike` has no `model` field).
      const structuralModel = message.role === "assistant" ? (message as { model?: unknown }).model : undefined;
      const origin =
        message.origin ??
        (message.uuid !== undefined ? chain.get(message.uuid)?.origin : undefined) ??
        (typeof structuralModel === "string" && structuralModel.length > 0 ? { providerId: "anthropic", modelKey: structuralModel, family: "anthropic" } : undefined);

      const native = origin !== undefined && replaysNatively(resolveEndpoint(origin), target);

      if (native) {
        // EXACT REPLAY. Native state and in-dialect blocks ride unchanged. `sameModel` is the SELF case:
        // a model's own previous step is its own even on a row the catalog gives no continuation domain.
        // What rides back is only what the adapter chose to capture for its own model (Responses keeps
        // reasoning items carrying `encrypted_content`; the chat adapter keeps `reasoning_content` for a
        // `plaintext` row and OpenRouter's `reasoning_details` for an `opaque-provider-state` one).
        if (message.nativeState !== undefined) report.replayedNatively++;
        out.push(withoutDecoration(message));
        continue;
      }

      // ANOTHER MODEL, or provenance nobody recorded (the worst-informed case, never waved through):
      // every reasoning carrier comes off, in BOTH carriers, and nothing replaces it.
      const { nativeState, content, strippedBlocks } = stripOpaque(message);
      if (nativeState !== undefined) report.droppedNativeState++;
      report.strippedInDialectBlocks += strippedBlocks;
      // A turn whose ONLY content was its reasoning has nothing left any model can read. Sending it as
      // an empty assistant message is refused by some surfaces, so it is left out of this request (the
      // transcript keeps it). A message that still carries anything -- text, a tool call -- always stays.
      if (message.role === "assistant" && (nativeState !== undefined || strippedBlocks > 0) && isEmptyContent(content)) {
        report.droppedEmptyMessages++;
        continue;
      }
      if (nativeState === undefined && strippedBlocks === 0 && message.decoration === undefined) {
        out.push(message); // nothing to remove: by identity
        continue;
      }
      const { nativeState: _dropped, decoration: _gone, ...rest } = message;
      // THE ONE CAST. A spread of `M` plus a narrowed `content` is structurally `M`, but TypeScript cannot
      // prove that for an unresolved generic.
      out.push({ ...rest, content } as unknown as M);
    }

    // WS-23 (reasoning-state, decisions 8 and 9): what the target cannot represent becomes TEXT, never a
    // silent drop and never a request the adapter must refuse -- another vendor's server-tool blocks, and
    // images/documents for a model that cannot read them. This is visible conversation, not reasoning.
    const representable = out.map((message) => representableFor(message, target));
    options.onReport?.(report);
    return { messages: representable, report };
  }

  return {
    render(messages, chain, target) {
      return renderWithReport(messages, chain, target).messages;
    },
    renderWithReport,
  };
}

/**
 * THE ONE TEST for "this earlier message's reasoning is sent to the target natively": the same
 * continuation domain, or the same model. Exported so every estimate of what a request carries (the
 * engine's fit check, the switch review's) charges exactly the native state this renderer will send --
 * one rule, never two copies of it. Anything this answers `false` for has its reasoning left out.
 */
export function replaysNatively(source: { providerId?: string; modelKey?: string; continuationDomain?: string } | undefined, target: { providerId?: string; modelKey?: string; continuationDomain?: string } | undefined): boolean {
  return sameDomain(source, target) || sameModel(source, target);
}

/** The message with any `decoration` removed (by identity when it has none). */
function withoutDecoration<M extends ProviderMessageLike>(message: M): M {
  if (message.decoration === undefined) return message;
  const { decoration: _gone, ...kept } = message;
  return kept as unknown as M;
}

function isEmptyContent(content: string | readonly ContentBlockLike[]): boolean {
  return typeof content === "string" ? content.length === 0 : content.length === 0;
}

/**
 * WS-23 (reasoning-state, decision 8): an Anthropic SERVER tool's own block -- its call (`server_tool_use`)
 * or any of its results (`web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`,
 * ...). Only a claude-written transcript carries them (Winter's own WebSearch returns an ordinary
 * `tool_result`), and no other vendor has a shape for them.
 */
export function isServerToolBlockType(type: string): boolean {
  return type === "server_tool_use" || (type.endsWith("_tool_result") && type !== "tool_result");
}

const SERVER_TOOL_TEXT_CAP = 4_000;

/** One server-tool block as the text another vendor's model reads. Titles and URLs for a search; the rest capped. */
function serverToolText(block: Record<string, unknown>): string {
  const type = String(block["type"]);
  if (type === "server_tool_use") return `[server tool call: ${String(block["name"] ?? "tool")} ${capped(JSON.stringify(block["input"] ?? {}))}]`;
  const content = block["content"];
  if (Array.isArray(content) && content.every((r) => typeof r === "object" && r !== null && typeof (r as { url?: unknown }).url === "string")) {
    const lines = content.map((r) => `- ${String((r as { title?: unknown }).title ?? "")} (${String((r as { url: string }).url)})`);
    return capped(`[${type.replace(/_tool_result$/, "").replace(/_/g, " ")} results]\n${lines.join("\n")}`);
  }
  return capped(`[${type.replace(/_/g, " ")}] ${typeof content === "string" ? content : JSON.stringify(content ?? {})}`);
}

function capped(text: string): string {
  return text.length > SERVER_TOOL_TEXT_CAP ? `${text.slice(0, SERVER_TOOL_TEXT_CAP)}...` : text;
}

const IMAGE_NOTE = "[an image was here; this model cannot read images]";
const DOCUMENT_NOTE = "[a document was here; this model cannot read documents]";

/** The message with every block the target cannot represent turned into text (by identity when nothing changes). */
function representableFor<M extends ProviderMessageLike>(message: M, target: HistoryTarget): M {
  if (typeof message.content === "string") return message;
  const flattenServer = target.family !== "anthropic";
  const dropMedia = target.readsImages === false;
  if (!flattenServer && !dropMedia) return message;
  let changed = false;
  const mapBlocks = (blocks: readonly ContentBlockLike[]): ContentBlockLike[] =>
    blocks.map((block): ContentBlockLike => {
      const type = (block as { type: string }).type;
      if (flattenServer && isServerToolBlockType(type)) {
        changed = true;
        return { type: "text", text: serverToolText(block as unknown as Record<string, unknown>) };
      }
      if (dropMedia && (type === "image" || type === "document")) {
        changed = true;
        return { type: "text", text: type === "image" ? IMAGE_NOTE : DOCUMENT_NOTE };
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = mapBlocks(block.content);
        return inner.some((b, i) => b !== (block.content as ContentBlockLike[])[i]) ? { ...block, content: inner } : block;
      }
      return block;
    });
  const content = mapBlocks(message.content);
  return changed ? ({ ...message, content } as unknown as M) : message;
}

/**
 * Removes every reasoning carrier from a message going to a model that cannot take it natively.
 *
 * TWO CARRIERS, and missing the second is the subtle half: `nativeState.items` is the obvious one,
 * but Anthropic-family `thinking.signature` and `redacted_thinking.data` ride IN THE CONTENT, as
 * in-dialect blocks, because the dialect defines them. A renderer that dropped only `nativeState`
 * would hand a target another provider's signed blocks verbatim -- which is exactly what §12.4's
 * "the target never receives the source opaque state" forbids.
 *
 * EXPORTED (micro-round Minor 2) so `winter-agent-runtime`'s much simpler T3-era identity renderer
 * (`bridge.ts`'s `createIdentityHistoryRenderer`) can delegate to the SAME stripping logic for its
 * own no-origin fail-closed fix, rather than reimplementing the two-carrier rule a second time and
 * risking the two copies drifting apart on what counts as opaque.
 */
export function stripOpaque(message: ProviderMessageLike): { nativeState?: ProviderNativeState; content: string | ContentBlockLike[]; strippedBlocks: number } {
  const nativeState = message.nativeState;
  if (typeof message.content === "string") {
    return { ...(nativeState !== undefined ? { nativeState } : {}), content: message.content, strippedBlocks: 0 };
  }
  const kept = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
  return {
    ...(nativeState !== undefined ? { nativeState } : {}),
    content: kept.length === message.content.length ? message.content : kept,
    strippedBlocks: message.content.length - kept.length,
  };
}

