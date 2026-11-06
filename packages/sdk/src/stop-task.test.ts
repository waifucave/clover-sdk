// Clover K-M3: `Query.stopTask()` through the WRAPPER, against the real engine over the in-memory process (the
// `setEffort()` tests' pattern): a host whose own TaskStop hides the runtime's passes on a task id, and the
// session's background command stops through the TaskStop tool's own door; an id no task has rejects typed.
import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { WinterRpcError } from "./errors.ts";
import { inMemoryProcess } from "@waifucave/clover-agent-runtime/testing";
import type { Provider } from "@waifucave/clover-agent-runtime";

test("stopTask(): stops the session's own background command and says so; an unknown id rejects with `unknown_task`", async () => {
  let generations = 0;
  const provider: Provider = {
    async generate() {
      return generations++ === 0
        ? { kind: "tool_use", calls: [{ id: "bg-1", name: "Bash", input: { command: "sleep 30", run_in_background: true, description: "a long wait" } }] }
        : { kind: "text", text: "started" };
    },
  };
  let releaseEnd!: () => void;
  const endGate = new Promise<void>((resolve) => (releaseEnd = resolve));
  async function* prompt() {
    yield "start it";
    await endGate;
  }
  const gen = query({
    prompt: prompt(),
    options: { model: "winter-test/echo", allowedTools: ["Bash"], sandbox: { enabled: false }, spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider) },
  });
  let taskId: string | undefined;
  let stopped: Promise<unknown> | undefined;
  let unknown: Promise<unknown> | undefined;
  let again: unknown;
  const frames: { subtype?: string; task_id?: string; status?: string }[] = [];
  for await (const msg of gen) {
    const m = msg as { type: string; subtype?: string; task_id?: string; status?: string };
    if (m.type === "system") frames.push(m);
    if (m.type === "system" && m.subtype === "task_started") taskId = m.task_id;
    // The first turn's end; the stop's own notification then runs one more turn, which ends the second.
    if (m.type === "result" && stopped === undefined) {
      expect(taskId).toBeString();
      // Fired, not awaited: the answer arrives on this same read loop.
      stopped = gen.stopTask!(taskId!);
      unknown = gen.stopTask!("no-such-task").catch((e: unknown) => e);
    } else if (m.type === "result") {
      // A stopped task answers that it already was.
      // Fired, not awaited, for the same reason; the session ends once it is answered.
      again = gen.stopTask!(taskId!);
      void (again as Promise<unknown>).finally(() => releaseEnd());
    }
  }
  expect(await stopped).toMatchObject({ message: `stopped task ${taskId}`, taskId, taskType: "local_bash", command: "sleep 30" });
  const err = await unknown;
  expect(err).toBeInstanceOf(WinterRpcError);
  expect((err as WinterRpcError).code).toBe("unknown_task");
  expect(await again).toMatchObject({ message: `task ${taskId} is already stopped`, taskId });
  expect(frames.some((f) => f.subtype === "task_notification" && f.task_id === taskId && f.status === "stopped")).toBe(true);
});
