// 0.0.80: the read-before-edit rule by model class, through the real Read, Edit, Write and NotebookEdit executors.
// strong / medium: no read needed, a partial read is enough, a change on disk is shown and the edit proceeds.
// weak: the lines an edit changes must have been read since the file last changed; a change on disk is shown and
// those lines count as read; otherwise refused with the lines to read.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState, type SessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import type { EditStrength } from "./read-ladder.ts";
import "./read.ts";
import "./edit.ts";
import "./write.ts";
import "./notebook-edit.ts";

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function fixture(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "clover-edit-strength-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, LINES);
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxOf(cwd: string, strength: EditStrength | undefined, readState: SessionReadState, probe: ReadAccessProbe = "silent"): ToolExecutionContext {
  return {
    cwd, home: "/home/test", sessionId: "s", readState, emitFrame: () => {},
    permissions: { probeReadAccess: () => probe }, tempDir: "/unused", sandboxSettings: {},
    ...(strength !== undefined ? { editStrength: strength } : {}),
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  } as ToolExecutionContext;
}

const run = (tool: string, input: unknown, ctx: ToolExecutionContext) => getRegisteredTool(tool)!.executor!.execute(input, ctx);
const edit = (ctx: ToolExecutionContext, file: string, from: string, to: string, replaceAll = false) => run("Edit", { file_path: file, old_string: from, new_string: to, replace_all: replaceAll }, ctx);
const read = (ctx: ToolExecutionContext, file: string, offset?: number, limit?: number) => run("Read", { file_path: file, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }, ctx);
/** A change made outside the file tools (a `sed` in the shell). */
const sed = (file: string, from: string, to: string) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

for (const strength of ["strong", "medium"] as const) {
  describe(`${strength}: the three cases need no read`, () => {
    test("edits a file it never read", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const r = await edit(ctxOf(dir, strength, createSessionReadState({ cwd: dir })), file, "line 5\n", "LINE FIVE\n");
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file, "utf8")).toContain("LINE FIVE");
      } finally { cleanup(); }
    });

    test("edits a line outside the part it read", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const ctx = ctxOf(dir, strength, createSessionReadState({ cwd: dir }));
        expect((await read(ctx, file, 1, 2)).isError).toBeFalsy();
        const r = await edit(ctx, file, "line 9\n", "LINE NINE\n");
        expect(r.isError).toBeFalsy();
      } finally { cleanup(); }
    });

    test("after a change made in the shell, it is handed the changed lines and the edit goes through", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const ctx = ctxOf(dir, strength, createSessionReadState({ cwd: dir }));
        await read(ctx, file);
        sed(file, "line 3\n", "line three (by sed)\n");
        const r = await edit(ctx, file, "line 7\n", "LINE SEVEN\n");
        expect(r.isError).toBeFalsy();
        const out = JSON.parse(r.output) as { note?: string };
        expect(out.note).toContain("changed on disk since you last saw it");
        expect(out.note).toContain("3\tline three (by sed)");
        expect(readFileSync(file, "utf8")).toContain("line three (by sed)\nline 4");
        expect(readFileSync(file, "utf8")).toContain("LINE SEVEN");
      } finally { cleanup(); }
    });

    test("after a change in the shell, an old_string that no longer matches is reported with the changed lines", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const ctx = ctxOf(dir, strength, createSessionReadState({ cwd: dir }));
        await read(ctx, file);
        sed(file, "line 3\n", "line three\n");
        const r = await edit(ctx, file, "line 3\n", "x\n");
        expect(r.isError).toBe(true);
        expect(r.output).toContain("old_string not found");
        expect(r.output).toContain("3\tline three");
      } finally { cleanup(); }
    });

    test("Write over a file it never read", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const r = await run("Write", { file_path: file, content: "new\n" }, ctxOf(dir, strength, createSessionReadState({ cwd: dir })));
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file, "utf8")).toBe("new\n");
      } finally { cleanup(); }
    });

    test("the one gate stays: a path whose Read would ask still needs the Read first", async () => {
      const { dir, file, cleanup } = fixture();
      try {
        const r = await edit(ctxOf(dir, strength, createSessionReadState({ cwd: dir }), "prompt"), file, "line 5\n", "x\n");
        expect(r.isError).toBe(true);
        expect(r.output).toContain("has not been read in this session");
        expect(readFileSync(file, "utf8")).toBe(LINES);
      } finally { cleanup(); }
    });
  });
}

describe("weak: the lines an edit changes must have been read", () => {
  test("a file never read: refused, naming the line to read", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const r = await edit(ctxOf(dir, "weak", createSessionReadState({ cwd: dir })), file, "line 5\n", "x\n");
      expect(r.isError).toBe(true);
      expect(r.output).toContain("this edit changes line 5");
      expect(r.output).toContain("Read line 5 first (offset 5, limit 1)");
      expect(readFileSync(file, "utf8")).toBe(LINES);
    } finally { cleanup(); }
  });

  test("a partial read that covers the lines is enough; one that doesn't is refused with the range", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const ctx = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      await read(ctx, file, 4, 3);
      expect((await edit(ctx, file, "line 5\n", "LINE FIVE\n")).isError).toBeFalsy();
      const r = await edit(ctx, file, "line 9\nline 10\n", "x\n");
      expect(r.isError).toBe(true);
      expect(r.output).toContain("this edit changes lines 9-10");
      expect(r.output).toContain("Read lines 9-10 first (offset 9, limit 2)");
    } finally { cleanup(); }
  });

  test("two partial reads add up", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const ctx = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      await read(ctx, file, 1, 4);
      await read(ctx, file, 5, 4);
      expect((await edit(ctx, file, "line 4\nline 5\n", "x\n")).isError).toBeFalsy();
    } finally { cleanup(); }
  });

  test("after a change in the shell, the changed lines are handed over and count as read; other lines need a Read", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const ctx = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      await read(ctx, file);
      sed(file, "line 3\n", "line three\n");
      // An unchanged line it read before the change: the change came after, so that read no longer counts.
      const refused = await edit(ctx, file, "line 8\n", "x\n");
      expect(refused.isError).toBe(true);
      expect(refused.output).toContain("this edit changes line 8");
      expect(refused.output).toContain("3\tline three");
      // The changed line it was just handed counts as read.
      const ok = await edit(ctx, file, "line three\n", "LINE THREE\n");
      expect(ok.isError).toBeFalsy();
      expect(readFileSync(file, "utf8")).toContain("LINE THREE");
    } finally { cleanup(); }
  });

  test("its own edit keeps what it read, moved to the lines' new places", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const ctx = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      await read(ctx, file, 1, 10);
      expect((await edit(ctx, file, "line 2\n", "a\nb\nc\n")).isError).toBeFalsy();
      // "line 9" moved from line 9 to line 11, and it was read.
      expect((await edit(ctx, file, "line 9\n", "LINE NINE\n")).isError).toBeFalsy();
      // "line 12" was never read.
      expect((await edit(ctx, file, "line 12\n", "x\n")).isError).toBe(true);
    } finally { cleanup(); }
  });

  test("Write over an existing file needs every line read", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const ctx = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      await read(ctx, file, 1, 5);
      const refused = await run("Write", { file_path: file, content: "new\n" }, ctx);
      expect(refused.isError).toBe(true);
      expect(refused.output).toContain("Write replaces the whole file");
      await read(ctx, file);
      expect((await run("Write", { file_path: file, content: "new\n" }, ctx)).isError).toBeFalsy();
    } finally { cleanup(); }
  });

  test("no class at all reads as weak", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      expect((await edit(ctxOf(dir, undefined, createSessionReadState({ cwd: dir })), file, "line 5\n", "x\n")).isError).toBe(true);
    } finally { cleanup(); }
  });
});

describe("NotebookEdit", () => {
  const notebook = JSON.stringify({ cells: [{ cell_type: "code", id: "c1", source: ["a = 1"], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  test("strong edits a notebook it never read; weak needs a read of it first", async () => {
    const { dir, cleanup } = fixture();
    try {
      const nb = join(dir, "n.ipynb");
      writeFileSync(nb, notebook);
      const input = { notebook_path: nb, cell_id: "c1", new_source: "a = 2", edit_mode: "replace" };
      const weak = ctxOf(dir, "weak", createSessionReadState({ cwd: dir }));
      expect((await run("NotebookEdit", input, weak)).isError).toBe(true);
      expect((await run("NotebookEdit", input, ctxOf(dir, "strong", createSessionReadState({ cwd: dir })))).isError).toBeFalsy();
      await read(weak, nb);
      expect((await run("NotebookEdit", { ...input, new_source: "a = 3" }, weak)).isError).toBeFalsy();
    } finally { cleanup(); }
  });
});

describe("the rule follows the model of each call (a model switch mid-session)", () => {
  test("one session's read state: strong edits an unread file, then weak is held to what it read", async () => {
    const { dir, file, cleanup } = fixture();
    try {
      const state = createSessionReadState({ cwd: dir });
      expect((await edit(ctxOf(dir, "strong", state), file, "line 5\n", "LINE FIVE\n")).isError).toBeFalsy();
      // After the switch to a weak model: line 5 was written by the session (counts), line 9 was never read.
      expect((await edit(ctxOf(dir, "weak", state), file, "LINE FIVE\n", "line five\n")).isError).toBeFalsy();
      expect((await edit(ctxOf(dir, "weak", state), file, "line 9\n", "x\n")).isError).toBe(true);
      // And back to strong: no read needed again.
      expect((await edit(ctxOf(dir, "strong", state), file, "line 9\n", "LINE NINE\n")).isError).toBeFalsy();
    } finally { cleanup(); }
  });
});
