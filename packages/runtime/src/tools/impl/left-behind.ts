// What a shell command left running when it ended, adopted as a background task of the session. Shared by Bash
// (foreground and background) and Monitor's command half, so the same doors reach them: TaskStop, the session's end
// and a host's `stopTask`.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { ToolExecutionContext } from "../registry.ts";
import { createBackgroundTask } from "../background-tasks.ts";
import type { LeftBehind } from "../../sandbox/spawn.ts";
import { startTracking, updateTask, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";

/** What the result and the task say about a process that got out from under the holder. */
const ESCAPED_NOTE = "one of them got out from under the process holder (it disclaimed its responsibility and started a session of its own): it stays inside the sandbox, but task_stop cannot stop it, only let go of its output";

/**
 * What a command left running when it ended (`(cmd) &`, `nohup … &`, and under the host's process holder setsid'd
 * and double-forked processes too): adopted as a background task of the session, so TaskStop, the session's end and a
 * host's `stopTask` stop them like any background command. They are not killed when the call ends (a `nohup server &`
 * is meant to outlive it). The task ends when the last of them does; its output file takes what they write from now on.
 */
export function adoptLeftBehind(left: LeftBehind, input: { command: string; description: string }, ctx: ToolExecutionContext): { taskId: string; outputPath: string; escaped: boolean } {
  let taskId: string;
  let outputPath: string;
  try {
    ({ taskId, outputPath } = createBackgroundTask("bash"));
  } catch {
    // No task root configured (a bare engine): a row without an output file still lets TaskStop reach them.
    taskId = randomUUID();
    outputPath = "";
  }
  const out = outputPath !== "" ? createWriteStream(outputPath, { flags: "a" }) : undefined;
  left.onOutput((chunk) => out?.write(chunk));
  const escaped = left.escaped === true;
  const description = `Left running by: ${input.description}${escaped ? " (one escaped the process holder)" : ""}`;
  const emitter = { emitFrame: ctx.emitFrame, sessionId: ctx.sessionId };
  startTracking({
    taskId, kind: "bash", outputPath, description, command: input.command, isBackgrounded: true, adopted: true,
    stopOwnedProcess: () => left.stop(),
    ...(ctx.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
    ...(ctx.agentId !== undefined ? { ownerAgentId: ctx.agentId } : {}),
    emitter,
  });
  const changed = () => {
    try {
      ctx.emitFrame({ type: "system", subtype: "background_tasks_changed", tasks: listRunningTasks().map(toBackgroundTasksChangedEntry), uuid: randomUUID(), session_id: ctx.sessionId });
    } catch {
      /* a torn-down session's emitFrame must never throw out of here */
    }
  };
  try {
    ctx.emitFrame({
      type: "system", subtype: "task_started", task_id: taskId,
      ...(ctx.toolUseId !== undefined ? { tool_use_id: ctx.toolUseId } : {}),
      description, is_backgrounded: true, task_type: "local_bash", uuid: randomUUID(), session_id: ctx.sessionId,
    });
  } catch {
    /* as above */
  }
  changed();
  void left.done.then(() => {
    out?.end();
    if (getTask(taskId)?.status !== "running") return; // stopped first: its own door already said so
    // An escape the holder saw only later (once everything it could stop had ended) is said here.
    const tail = left.escaped === true && !escaped ? `; ${ESCAPED_NOTE}` : "";
    updateTask(taskId, { status: "completed", endTime: Date.now(), notification: { summary: `${description}: every process it left has ended${tail}` } });
    changed();
  });
  return { taskId, outputPath, escaped };
}

/** The line a call's result carries when it left processes running. */
export function leftBehindNote(adopted: { taskId: string; outputPath: string; escaped: boolean }): string {
  return `Processes this command started are still running. They are background task ${adopted.taskId}${adopted.outputPath !== "" ? ` (output_file: ${adopted.outputPath})` : ""}; task_stop stops them.${adopted.escaped ? ` Note: ${ESCAPED_NOTE}.` : ""}`;
}
