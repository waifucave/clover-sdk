// Clover K-M3: `Query.stopTask()` through the WRAPPER, against the real engine over the in-memory process (the
// `setEffort()` tests' pattern): a host whose own TaskStop hides the runtime's passes on a task id, and the
// session's background command stops through the TaskStop tool's own door; an id no task of the session has (another
// session's included) rejects typed; a finished task says so; a stop racing the task's own exit notifies once.
import { expect, test } from "bun:test";
import { query, type Query } from "./query.ts";
import { WinterRpcError } from "./errors.ts";
import { inMemoryProcess } from "@waifucave/clover-agent-runtime/testing";
import type { Provider } from "@waifucave/clover-agent-runtime";

type Frame = { type: string; subtype?: string; task_id?: string; status?: string; summary?: string };

/** One session whose first turn starts `command` in the background, drained in the background so the test may await
 *  the control requests. */
function session(command: string) {
  let generations = 0;
  const requests: string[] = [];
  const provider: Provider = {
    async generate(req) {
      requests.push(JSON.stringify(req));
      return generations++ === 0
        ? { kind: "tool_use", calls: [{ id: "bg-1", name: "Bash", input: { command, run_in_background: true, description: "a background command" } }] }
        : { kind: "text", text: "ok" };
    },
  };
  let end!: () => void;
  const endGate = new Promise<void>((resolve) => (end = resolve));
  async function* prompt() {
    yield "start it";
    await endGate;
  }
  const q: Query = query({
    prompt: prompt(),
    options: { model: "winter-test/echo", allowedTools: ["Bash"], sandbox: { enabled: false }, spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider) },
  });
  const frames: Frame[] = [];
  const done = (async () => {
    for await (const msg of q) frames.push(msg as Frame);
  })();
  const waitFor = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
    for (let i = 0; i < 400; i++) {
      const v = fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const taskId = () => waitFor(() => frames.find((f) => f.type === "system" && f.subtype === "task_started")?.task_id, "task_started");
  const notifications = (id: string) => frames.filter((f) => f.type === "system" && f.subtype === "task_notification" && f.task_id === id);
  // A running background command would hold the session open past its last input: it goes first.
  const close = async () => {
    const id = frames.find((f) => f.type === "system" && f.subtype === "task_started")?.task_id;
    if (id !== undefined) await q.stopTask!(id).catch(() => {});
    end();
    await done;
  };
  return { q, frames, requests, waitFor, taskId, notifications, close };
}

test("stopTask(): stops the session's own background command and says so; a second stop says it already was; an unknown id rejects `unknown_task`", async () => {
  const s = session("sleep 30");
  try {
    const id = await s.taskId();
    expect(await s.q.stopTask!(id)).toMatchObject({ message: `stopped task ${id}`, taskId: id, taskType: "local_bash", command: "sleep 30" });
    await s.waitFor(() => s.notifications(id)[0], "the stop's notification");
    expect(s.notifications(id)).toMatchObject([{ status: "stopped" }]);
    // The host stopped it, not the model: the model is told so in the turn the notification starts.
    await s.waitFor(() => s.requests.find((r) => r.includes("was stopped by")), "the notification's turn");
    expect(s.requests.find((r) => r.includes("was stopped by"))).toContain("was stopped by the host");
    expect(await s.q.stopTask!(id)).toMatchObject({ message: `task ${id} is already stopped`, taskId: id });
    const err = await s.q.stopTask!("no-such-task").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WinterRpcError);
    expect((err as WinterRpcError).code).toBe("unknown_task");
    expect(s.notifications(id).length).toBe(1);
  } finally {
    await s.close();
  }
});

test("stopTask(): another session's task is never this one's to stop, even in the same process", async () => {
  const a = session("sleep 30");
  const b = session("sleep 30");
  try {
    const idA = await a.taskId();
    await b.taskId();
    const err = await b.q.stopTask!(idA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WinterRpcError);
    expect((err as WinterRpcError).code).toBe("unknown_task");
    expect(String((err as Error).message)).not.toContain("sleep 30");
    expect(a.notifications(idA)).toEqual([]);
    // Its own session still stops it; a host relaying the model's own TaskStop says the assistant stopped it.
    expect(await a.q.stopTask!(idA, { by: "assistant" })).toMatchObject({ message: `stopped task ${idA}` });
    await a.waitFor(() => a.requests.find((r) => r.includes("was stopped by")), "the notification's turn");
    expect(a.requests.find((r) => r.includes("was stopped by"))).toContain("was stopped by the assistant");
  } finally {
    await a.close();
    await b.close();
  }
});

test("stopTask(): a task that already finished on its own says so and notifies nothing more", async () => {
  const s = session("true");
  try {
    const id = await s.taskId();
    await s.waitFor(() => s.notifications(id)[0], "the task's own notification");
    expect(s.notifications(id)).toMatchObject([{ status: "completed" }]);
    expect(await s.q.stopTask!(id)).toMatchObject({ message: `task ${id} is already completed`, taskId: id });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.notifications(id).length).toBe(1);
  } finally {
    await s.close();
  }
});

test("stopTask(): a stop that races the task's own exit ends it once, stopped or completed", async () => {
  const s = session("sleep 0.05");
  try {
    const id = await s.taskId();
    await new Promise((r) => setTimeout(r, 45));
    const r = await s.q.stopTask!(id);
    expect([`stopped task ${id}`, `task ${id} is already completed`]).toContain(r.message);
    await s.waitFor(() => s.notifications(id)[0], "the notification");
    await new Promise((r2) => setTimeout(r2, 150));
    const n = s.notifications(id);
    expect(n.length).toBe(1);
    expect(["stopped", "completed"].includes(n[0]!.status ?? "")).toBe(true);
  } finally {
    await s.close();
  }
});
