// A JSON-RPC 2.0 peer over newline-delimited JSON, for the Agent Client Protocol's both sides: a client talking to an
// agent over its stdio (Clover's agent manager), the agent side (`serveAcpAgent`), and an MCP server over stdio
// (Clover's bridge). Both ends may send requests, so one class serves either role.
//
// It is tolerant on purpose (spike S5 §5 risk 3): ids may be numbers or strings (Antigravity uses strings), unknown
// fields are kept, and a line that isn't JSON is reported to `onBadLine` and skipped instead of closing the link.
// Every message, both ways, goes to `tap` first, so the transcript is the raw wire.


/** A byte-accurate NDJSON line splitter, safe across UTF-8 chunk boundaries: blank lines are skipped, and a line
 *  longer than `maxLine`, complete or still partial, resets it and throws. */
class LineDecoder {
  #buf: Uint8Array = new Uint8Array(0);
  #len = 0;
  readonly #text = new TextDecoder();
  constructor(private readonly maxLine: number) {}

  #append(bytes: Uint8Array): void {
    const need = this.#len + bytes.length;
    if (need > this.#buf.length) {
      const grown = new Uint8Array(Math.max(need, this.#buf.length * 2, 256));
      grown.set(this.#buf.subarray(0, this.#len));
      this.#buf = grown;
    }
    this.#buf.set(bytes, this.#len);
    this.#len = need;
  }

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(0x0a, start);
    while (nl !== -1) {
      const tail = chunk.subarray(start, nl);
      let line: Uint8Array = tail;
      if (this.#len > 0) {
        this.#append(tail);
        line = this.#buf.subarray(0, this.#len);
      }
      if (line.length > this.maxLine) {
        this.#len = 0;
        this.#buf = new Uint8Array(0);
        throw new Error(`ndjson: line too long (> ${this.maxLine} bytes)`);
      }
      if (line.length > 0) lines.push(this.#text.decode(line));
      if (this.#len > 0) {
        this.#len = 0;
        if (this.#buf.length > 64 * 1024) this.#buf = new Uint8Array(0);
      }
      start = nl + 1;
      nl = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) this.#append(chunk.subarray(start));
    if (this.#len > this.maxLine) {
      this.#len = 0;
      this.#buf = new Uint8Array(0);
      throw new Error(`ndjson: line too long (> ${this.maxLine} bytes)`);
    }
    return lines;
  }
}

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** An error answer from the other side, or one a handler throws to answer with. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** The longest line accepted from the other side: an agent's diffs and images fit well under it. */
export const RPC_MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface RpcPeerOptions {
  /** Writes one encoded line (with its newline). Throws or returns false when the link is gone. */
  write(line: string): void;
  onRequest?(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | unknown;
  onNotification?(method: string, params: unknown): void;
  /** Every message as it crosses, before it is handled (`in`) or after it is encoded (`out`). */
  tap?(dir: "in" | "out", msg: JsonRpcMessage): void;
  onBadLine?(reason: string): void;
  maxLineBytes?: number;
  /** Send request ids as strings (Antigravity does); the default is numbers. */
  stringIds?: boolean;
  /** The link closed: `close()` was called, a write failed, or a line was too long to read. Called once. */
  onClose?(reason: Error): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  readonly #opts: RpcPeerOptions;
  readonly #decoder: LineDecoder;
  readonly #pending = new Map<string, Pending>();
  #nextId = 0;
  #closed: Error | undefined;

  constructor(opts: RpcPeerOptions) {
    this.#opts = opts;
    this.#decoder = new LineDecoder(opts.maxLineBytes ?? RPC_MAX_LINE_BYTES);
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  /** Feeds bytes read from the other side. */
  feed(chunk: Uint8Array | string): void {
    if (this.#closed) return;
    let lines: string[];
    try {
      lines = this.#decoder.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const line of lines) this.#onLine(line);
  }

  request(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const n = this.#nextId++;
    const id: JsonRpcId = this.#opts.stringIds ? String(n) : n;
    return new Promise<unknown>((resolve, reject) => {
      const p: Pending = { method, resolve, reject };
      if (opts.timeoutMs !== undefined) {
        p.timer = setTimeout(() => {
          this.#pending.delete(String(id));
          reject(new RpcError(RPC_INTERNAL_ERROR, `${method} got no answer within ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", () => {
        if (this.#pending.delete(String(id))) {
          if (p.timer) clearTimeout(p.timer);
          reject(opts.signal?.reason ?? new Error("aborted"));
        }
      }, { once: true });
      this.#pending.set(String(id), p);
      this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Ends the link: every request still waiting is rejected with `reason`. */
  close(reason: Error = new Error("the connection closed")): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const [id, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(reason);
    }
    this.#opts.onClose?.(reason);
  }

  #send(msg: JsonRpcMessage): void {
    this.#opts.tap?.("out", msg);
    try {
      this.#opts.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      msg = parsed as JsonRpcMessage;
    } catch (err) {
      this.#opts.onBadLine?.(`a line that isn't a JSON-RPC message (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    this.#opts.tap?.("in", msg);
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        try {
          this.#opts.onNotification?.(msg.method, msg.params);
        } catch (err) {
          this.#opts.onBadLine?.(`the ${msg.method} handler threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      void this.#answer(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      this.#opts.onBadLine?.("a response with no id");
      return;
    }
    const p = this.#pending.get(String(msg.id));
    if (!p) {
      this.#opts.onBadLine?.(`a response to an unknown request ${String(msg.id)}`);
      return;
    }
    this.#pending.delete(String(msg.id));
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }

  async #answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.#opts.onRequest) {
      this.#send({ jsonrpc: "2.0", id, error: { code: RPC_METHOD_NOT_FOUND, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await this.#opts.onRequest(method, params, id);
      if (this.#closed) return;
      this.#send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      if (this.#closed) return;
      const e = err instanceof RpcError ? err : new RpcError(RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      this.#send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } });
    }
  }
}
