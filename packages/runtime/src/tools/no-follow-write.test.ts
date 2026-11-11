// 0.0.77: every writer behind tools/no-follow-write.ts against the race it closes -- a link at the path,
// a link swapped in between the check and the write, a folder above it swapped for a link, a hard link --
// plus the ordinary writes (content, mode, inode) and the opt-in write roots. The swaps are driven
// deterministically through the module's test seam, called between the plan (and its checks) and the
// open. On macOS the open refuses a link anywhere in the path (`O_NOFOLLOW_ANY`); on Linux the
// post-open check catches a swapped folder. Both must leave the outside file exactly as it was.
//
// Windows is not covered here: there is no `O_NOFOLLOW`, the writer lstat's the leaf right before the open
// instead, and the remaining gap is stated in no-follow-write.ts's header.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState, type SessionReadState } from "./read-state.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolCallPermission } from "./registry.ts";
import type { SandboxSettings } from "../sandbox/profile.ts";
import { _setNoFollowWriteSeamForTests, planWrite, readInFolder, writeInFolder, writeNewFileUnder } from "./no-follow-write.ts";
import { configureBackgroundTaskRoot, createBackgroundTask, openTaskOutputStream, resetBackgroundTaskRootForTest } from "./background-tasks.ts";
import { runCommand } from "../sandbox/spawn.ts";
import { buildRunCommandOptions } from "./impl/bash.ts";
import { readCheckpointIndex, sessionCheckpointDir } from "../checkpoint/file-history.ts";
import { capMcpOutput } from "../mcp/output-cap.ts";
import { quarantinePlanted } from "../sandbox/linux-runs.ts";
import { saveBlobToTempDir } from "./impl/read-mcp-resource-tool.ts";
import { createFileCheckpointSink } from "../checkpoint/sink.ts";
import "./impl/write.ts";
import "./impl/edit.ts";
import "./impl/notebook-edit.ts";

const SECRET = "the outside file, untouched\n";
let base = "";
let root = ""; // the session's write root (cwd)
let outside = ""; // a folder outside every root
let secret = ""; // the file a link must never reach

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "winter-no-follow-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  secret = join(outside, "secret.txt");
  writeFileSync(secret, SECRET);
});
afterEach(() => {
  _setNoFollowWriteSeamForTests(undefined);
  rmSync(base, { recursive: true, force: true });
});

function makeCtx(opts: { readState?: SessionReadState; settings?: SandboxSettings; permission?: ToolCallPermission } = {}): ToolExecutionContext {
  return {
    cwd: root,
    home: "/home/test",
    sessionId: "test-session",
    readState: opts.readState ?? createSessionReadState({ cwd: root }),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(base, "session-tmp"),
    sandboxSettings: opts.settings ?? {},
    ...(opts.permission !== undefined ? { permission: opts.permission } : {}),
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [root], getPermissionMode: () => "default", getSessionRoot: () => root, setSessionRoot() {} },
  } as ToolExecutionContext;
}
const ENFORCED: SandboxSettings = { filesystem: { enforceWriteRootsInFileTools: true } };

const NOTEBOOK = JSON.stringify({ cells: [{ id: "c1", cell_type: "code", source: "hello", metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });

/** One row per writing tool: how to fill a file it can edit, and how to call it on a path. */
interface Writer {
  name: "Write" | "Edit" | "NotebookEdit";
  /** Content an in-root file starts with, so the tool's own call is valid on it. */
  seed: string;
  input(path: string): Record<string, unknown>;
  /** The content the call leaves, for a positive check. */
  expected: (before: string) => string;
}
const WRITERS: Writer[] = [
  { name: "Write", seed: "hello\n", input: (p) => ({ file_path: p, content: "written\n" }), expected: () => "written\n" },
  { name: "Edit", seed: "hello\n", input: (p) => ({ file_path: p, old_string: "hello", new_string: "edited" }), expected: () => "edited\n" },
  {
    name: "NotebookEdit",
    seed: NOTEBOOK,
    input: (p) => ({ notebook_path: p, cell_id: "c1", new_source: "edited", edit_mode: "replace" }),
    expected: () => JSON.stringify({ ...JSON.parse(NOTEBOOK), cells: [{ ...JSON.parse(NOTEBOOK).cells[0], source: "edited" }] }, null, 1),
  },
];

async function run(writer: Writer, path: string, ctx: ToolExecutionContext) {
  const tool = getRegisteredTool(writer.name);
  if (!tool?.executor) throw new Error(`${writer.name} executor not registered`);
  return tool.executor.execute(writer.input(path), ctx);
}

/** Record a complete read of `path` (as the model's Read would), so the read-before-edit ladder lets the call through. */
function readFully(state: SessionReadState, path: string): void {
  state.recordRead(path, { complete: true, mtimeMs: statSync(path).mtimeMs });
}

/** The outside file, and the outside folder, exactly as they were. */
function expectOutsideUntouched(extra: string[] = []): void {
  expect(readFileSync(secret, "utf8")).toBe(SECRET);
  expect(statSync(secret).nlink).toBeGreaterThanOrEqual(1);
  expect(readdirSync(outside).sort()).toEqual(["secret.txt", ...extra].sort());
}

for (const writer of WRITERS) {
  describe(`${writer.name} -- no-follow writes`, () => {
    // Write to the outside file's own name, through a link at the path.
    const outsideLinkCall = async (settings: SandboxSettings | undefined, permission?: ToolCallPermission) => {
      writeFileSync(secret, writer.name === "NotebookEdit" ? NOTEBOOK : writer.seed);
      const link = join(root, "link.txt");
      symlinkSync(secret, link);
      const state = createSessionReadState({ cwd: root });
      readFully(state, link);
      const result = await run(writer, link, makeCtx({ readState: state, ...(settings ? { settings } : {}), ...(permission ? { permission } : {}) }));
      return { link, result };
    };

    test("a link at the path to a file outside the roots: refused under the write roots, the error naming the real file", async () => {
      const before = writer.name === "NotebookEdit" ? NOTEBOOK : writer.seed;
      const { link, result } = await outsideLinkCall(ENFORCED);
      expect(result.isError).toBe(true);
      expect(result.output).toContain(secret);
      expect(result.output).toContain("outside this session's write roots");
      expect(readFileSync(secret, "utf8")).toBe(before);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    test("a link at the path, approved by canUseTool: still refused (the approved name was not the real file)", async () => {
      const before = writer.name === "NotebookEdit" ? NOTEBOOK : writer.seed;
      const { result } = await outsideLinkCall(ENFORCED, { explicitApproval: "prompt" });
      expect(result.isError).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe(before);
    });

    test("a link at the path with the write roots off: the write lands on the real file it was checked as (as before 0.0.77), the link stays a link", async () => {
      const { link, result } = await outsideLinkCall(undefined);
      expect(result.isError).toBeUndefined();
      expect(readFileSync(secret, "utf8")).toBe(writer.expected(writer.name === "NotebookEdit" ? NOTEBOOK : writer.seed));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    test("a link at the path to a file inside the roots: written, to that file, under the write roots", async () => {
      const real = join(root, "real.txt");
      writeFileSync(real, writer.seed);
      const link = join(root, "alias.txt");
      symlinkSync(real, link);
      const state = createSessionReadState({ cwd: root });
      readFully(state, link);
      const result = await run(writer, link, makeCtx({ readState: state, settings: ENFORCED }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(real, "utf8")).toBe(writer.expected(writer.seed));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    for (const settings of [undefined, ENFORCED]) {
      const label = settings ? "under the write roots" : "with the write roots off";
      test(`a link swapped in between the check and the write: refused, the outside file unchanged (${label})`, async () => {
        const file = join(root, "f.txt");
        writeFileSync(file, writer.seed);
        const state = createSessionReadState({ cwd: root });
        readFully(state, file);
        let swapped = false;
        _setNoFollowWriteSeamForTests((stage) => {
          if (stage !== "beforeOpen" || swapped) return;
          swapped = true;
          rmSync(file);
          symlinkSync(secret, file);
        });
        const result = await run(writer, file, makeCtx({ readState: state, ...(settings ? { settings } : {}) }));
        expect(swapped).toBe(true);
        expect(result.isError).toBe(true);
        expectOutsideUntouched();
      });

      test(`a folder above the file swapped for a link between the check and the write: refused, the outside file unchanged (${label})`, async () => {
        const sub = join(root, "sub");
        mkdirSync(sub);
        const file = join(sub, "secret.txt"); // the same name as the outside file, so a redirected open would find it
        writeFileSync(file, writer.seed);
        writeFileSync(secret, writer.seed);
        const state = createSessionReadState({ cwd: root });
        readFully(state, file);
        let swapped = false;
        _setNoFollowWriteSeamForTests((stage) => {
          if (stage !== "beforeOpen" || swapped) return;
          swapped = true;
          renameSync(sub, join(root, "sub-old"));
          symlinkSync(outside, sub);
        });
        const result = await run(writer, file, makeCtx({ readState: state, ...(settings ? { settings } : {}) }));
        expect(swapped).toBe(true);
        expect(result.isError).toBe(true);
        expect(readFileSync(secret, "utf8")).toBe(writer.seed);
        expect(readdirSync(outside)).toEqual(["secret.txt"]);
      });
    }

    test("a hard link to an outside file: refused under the write roots", async () => {
      writeFileSync(secret, writer.seed);
      const hard = join(root, "hard.txt");
      linkSync(secret, hard);
      const state = createSessionReadState({ cwd: root });
      readFully(state, hard);
      const result = await run(writer, hard, makeCtx({ readState: state, settings: ENFORCED }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("hard links");
      expect(readFileSync(secret, "utf8")).toBe(writer.seed);
    });

    test("a hard link: written when the host allows hard links, and with the write roots off (as before 0.0.77)", async () => {
      for (const settings of [{ filesystem: { enforceWriteRootsInFileTools: true, allowHardLinkWrites: true } }, undefined]) {
        writeFileSync(secret, writer.seed);
        const hard = join(root, "hard.txt");
        rmSync(hard, { force: true });
        linkSync(secret, hard);
        const state = createSessionReadState({ cwd: root });
        readFully(state, hard);
        const result = await run(writer, hard, makeCtx({ readState: state, ...(settings ? { settings } : {}) }));
        expect(result.isError).toBeUndefined();
        expect(readFileSync(secret, "utf8")).toBe(writer.expected(writer.seed));
      }
    });

    test("an ordinary edit in place: content right, the same file (inode) and its mode kept", async () => {
      const file = join(root, "plain.txt");
      writeFileSync(file, writer.seed);
      chmodSync(file, 0o640);
      const inode = statSync(file).ino;
      const state = createSessionReadState({ cwd: root });
      readFully(state, file);
      const result = await run(writer, file, makeCtx({ readState: state, settings: ENFORCED }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(writer.expected(writer.seed));
      expect(statSync(file).ino).toBe(inode);
      expect(statSync(file).mode & 0o777).toBe(0o640);
    });

    test("a FIFO at the path is refused (regular files only), for every host", async () => {
      const fifo = join(root, "pipe");
      execFileSync("mkfifo", [fifo]);
      const result = await run(writer, fifo, makeCtx());
      expect(result.isError).toBe(true);
    });

    test("outside the roots with no link: refused under the write roots, written when canUseTool allowed this call", async () => {
      writeFileSync(secret, writer.seed);
      const state = createSessionReadState({ cwd: root });
      readFully(state, secret);
      const refused = await run(writer, secret, makeCtx({ readState: state, settings: ENFORCED }));
      expect(refused.isError).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe(writer.seed);
      const allowed = await run(writer, secret, makeCtx({ readState: state, settings: ENFORCED, permission: { explicitApproval: "prompt" } }));
      expect(allowed.isError).toBeUndefined();
      expect(readFileSync(secret, "utf8")).toBe(writer.expected(writer.seed));
    });
  });
}

describe("Write -- new files", () => {
  const write = (path: string, ctx = makeCtx()) => run(WRITERS[0]!, path, ctx);

  test("a new file in new folders: content right, mode from the umask, the folders made", async () => {
    const path = join(root, "a", "b", "c.txt");
    const result = await write(path, makeCtx({ settings: ENFORCED }));
    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("written\n");
    const umask = process.umask();
    expect(statSync(path).mode & 0o777).toBe(0o666 & ~umask);
    expect(statSync(join(root, "a", "b")).isDirectory()).toBe(true);
  });

  test("a full overwrite of an existing file keeps its inode and mode", async () => {
    const path = join(root, "o.txt");
    writeFileSync(path, "old content that is longer than the new one\n");
    chmodSync(path, 0o600);
    const inode = statSync(path).ino;
    const state = createSessionReadState({ cwd: root });
    readFully(state, path);
    const result = await write(path, makeCtx({ readState: state }));
    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("written\n");
    expect(statSync(path).ino).toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a new file whose folder is swapped for a link before the open: refused, nothing created outside", async () => {
    const sub = join(root, "sub");
    mkdirSync(sub);
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeOpen" || swapped) return;
      swapped = true;
      renameSync(sub, join(root, "sub-old"));
      symlinkSync(outside, sub);
    });
    const result = await write(join(sub, "new.txt"));
    expect(swapped).toBe(true);
    expect(result.isError).toBe(true);
    expectOutsideUntouched();
  });

  test("a folder swapped for a link while new folders are made: refused, no folder left outside", async () => {
    const sub = join(root, "sub");
    mkdirSync(sub);
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeMkdir" || swapped) return;
      swapped = true;
      renameSync(sub, join(root, "sub-old"));
      symlinkSync(outside, sub);
    });
    const result = await write(join(sub, "new", "deeper", "f.txt"));
    expect(swapped).toBe(true);
    expect(result.isError).toBe(true);
    expectOutsideUntouched();
  });

  test("a new file appearing at the path between the check and the open: refused, the file that appeared unchanged", async () => {
    const path = join(root, "late.txt");
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage === "beforeOpen") symlinkSync(secret, path);
    });
    const result = await write(path);
    expect(result.isError).toBe(true);
    expectOutsideUntouched();
  });

  test("a dangling link at the path: the new file is made where the link points, which the roots check judges", async () => {
    const link = join(root, "dangling.txt");
    const target = join(outside, "made.txt");
    symlinkSync(target, link);
    const refused = await write(link, makeCtx({ settings: ENFORCED }));
    expect(refused.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
    const inside = join(root, "made-inside.txt");
    const link2 = join(root, "dangling2.txt");
    symlinkSync(inside, link2);
    const written = await write(link2, makeCtx({ settings: ENFORCED }));
    expect(written.isError).toBeUndefined();
    expect(readFileSync(inside, "utf8")).toBe("written\n");
  });
});

describe("the plan resolves once", () => {
  test("the real file is checked and opened, the given name is kept for the result", () => {
    const real = join(root, "r.txt");
    writeFileSync(real, "x");
    const link = join(root, "l.txt");
    symlinkSync(real, link);
    const plan = planWrite(link, { followLeafLink: true, createParents: false });
    expect(plan.lexicalPath).toBe(link);
    expect(plan.realPath).toBe(real);
    expect(plan.throughLink).toBe(true);
    expect(() => planWrite(link, { followLeafLink: false, createParents: false })).toThrow("symbolic link");
  });
});

describe("ReadMcpResource's blob saver", () => {
  test("a link planted at the session temp folder's mcp-resources: refused, nothing saved outside", () => {
    const tempDir = join(base, "session-tmp");
    mkdirSync(tempDir);
    symlinkSync(outside, join(tempDir, "mcp-resources"));
    expect(() => saveBlobToTempDir(tempDir, Buffer.from("blob").toString("base64"), "image/png")).toThrow();
    expectOutsideUntouched();
  });

  test("the folder swapped for a link between the plan and the open: refused, nothing saved outside", () => {
    const tempDir = join(base, "session-tmp");
    mkdirSync(join(tempDir, "mcp-resources"), { recursive: true });
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeOpen" || swapped) return;
      swapped = true;
      renameSync(join(tempDir, "mcp-resources"), join(tempDir, "old"));
      symlinkSync(outside, join(tempDir, "mcp-resources"));
    });
    expect(() => saveBlobToTempDir(tempDir, Buffer.from("blob").toString("base64"), "image/png")).toThrow();
    expect(swapped).toBe(true);
    expectOutsideUntouched();
  });

  test("an ordinary save: the bytes, in a new file under the temp folder", () => {
    const tempDir = join(base, "session-tmp");
    const path = saveBlobToTempDir(tempDir, Buffer.from("blob").toString("base64"), "image/png");
    expect(readFileSync(path, "utf8")).toBe("blob");
    expect(path.startsWith(join(tempDir, "mcp-resources"))).toBe(true);
  });
});

describe("checkpoint rewind", () => {
  test("a link swapped in after rewind's own checks: the restore does not write through it", async () => {
    const home = join(base, "home");
    mkdirSync(home);
    const file = join(root, "a.ts");
    writeFileSync(file, "original\n");
    const sink = createFileCheckpointSink({ home, cwd: root, sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\n");
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeOpen" || swapped) return;
      swapped = true;
      rmSync(file);
      symlinkSync(secret, file);
    });
    const result = await sink.rewind("u-1");
    expect(swapped).toBe(true);
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([]);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });

  test("an ordinary rewind still restores the file", async () => {
    const home = join(base, "home");
    mkdirSync(home);
    const file = join(root, "a.ts");
    writeFileSync(file, "original\n");
    const sink = createFileCheckpointSink({ home, cwd: root, sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\n");
    const result = await sink.rewind("u-1");
    expect(result.filesChanged).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });
});

describe("checkpoint rewind's delete (a file that didn't exist at the checkpoint)", () => {
  async function checkpointed(file: string) {
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    const sink = createFileCheckpointSink({ home, cwd: root, sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    return sink;
  }

  test("a normal delete still removes the file the session created", async () => {
    const file = join(root, "new.ts");
    const sink = await checkpointed(file);
    writeFileSync(file, "made after the checkpoint\n");
    const result = await sink.rewind("u-1");
    expect(result.filesChanged).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  test("the folder swapped for a link after rewind's own checks: skipped and counted, the outside file of the same name untouched", async () => {
    const sub = join(root, "sub");
    mkdirSync(sub);
    const file = join(sub, "secret.txt"); // the outside file's own name, so a followed delete would remove it
    const sink = await checkpointed(file);
    writeFileSync(file, "made after the checkpoint\n");
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeRemove" || swapped) return;
      swapped = true;
      renameSync(sub, join(root, "sub-old"));
      symlinkSync(outside, sub);
    });
    const result = await sink.rewind("u-1");
    expect(swapped).toBe(true);
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([]);
    expectOutsideUntouched();
    expect(readFileSync(join(root, "sub-old", "secret.txt"), "utf8")).toBe("made after the checkpoint\n");
  });

  test("a link at the name: skipped, the link and its target untouched", async () => {
    const file = join(root, "new.ts");
    const sink = await checkpointed(file);
    symlinkSync(secret, file);
    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });

  test("a link swapped in at the name after rewind's own checks: skipped, the link's target untouched", async () => {
    const file = join(root, "new.ts");
    const sink = await checkpointed(file);
    writeFileSync(file, "made after the checkpoint\n");
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeRemove" || swapped) return;
      swapped = true;
      rmSync(file);
      symlinkSync(secret, file);
    });
    const result = await sink.rewind("u-1");
    expect(swapped).toBe(true);
    expect(result.skippedLinks).toBe(1);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });
});

describe("the runtime's own new files in the session temp folder (Bash's overflow output, the MCP output spill)", () => {
  test("a link planted where the folder should be: refused, nothing written outside", () => {
    const tempDir = join(base, "session-tmp");
    mkdirSync(tempDir);
    symlinkSync(outside, join(tempDir, "bash-output"));
    expect(() => writeNewFileUnder(tempDir, ["bash-output", "x-stdout.txt"], "output")).toThrow();
    expectOutsideUntouched();
  });

  test("the MCP spill: a planted link leaves the result an excerpt with no saved file, nothing outside", () => {
    const tempDir = join(base, "session-tmp");
    mkdirSync(tempDir);
    symlinkSync(outside, join(tempDir, "mcp-output"));
    const result = capMcpOutput("word ".repeat(5000), 10, { sessionDir: () => tempDir, serverName: "srv", toolName: "tool" });
    expect(result.truncated).toBe(true);
    expect(result.persistedPath).toBeUndefined();
    expectOutsideUntouched();
  });

  test("an ordinary spill is saved under the temp folder", () => {
    const tempDir = join(base, "session-tmp");
    const text = "word ".repeat(5000);
    const result = capMcpOutput(text, 10, { sessionDir: () => tempDir, serverName: "srv", toolName: "tool" });
    expect(result.persistedPath?.startsWith(join(tempDir, "mcp-output"))).toBe(true);
    expect(readFileSync(result.persistedPath!, "utf8")).toBe(text);
  });
});

describe("the Linux quarantine of a planted protected path (sandbox/linux-runs.ts)", () => {
  test("a folder above it swapped for a link before the removal: nothing outside is removed", () => {
    const planted = join(root, "a", "b", "hook");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(planted, "planted\n");
    mkdirSync(join(outside, "b"));
    writeFileSync(join(outside, "b", "hook"), SECRET);
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeRemove" || swapped) return;
      swapped = true;
      renameSync(join(root, "a"), join(root, "a-old"));
      symlinkSync(outside, join(root, "a"));
    });
    quarantinePlanted([{ path: planted, anchor: root }], undefined);
    expect(swapped).toBe(true);
    expect(readFileSync(join(outside, "b", "hook"), "utf8")).toBe(SECRET);
    expect(readdirSync(join(outside, "b"))).toEqual(["hook"]);
  });

  test("an ordinary planted file is removed, and a planted link is removed as a link (its target untouched)", () => {
    const planted = join(root, "a", "hook");
    mkdirSync(join(root, "a"));
    writeFileSync(planted, "planted\n");
    const link = join(root, "a", "hook2");
    symlinkSync(secret, link);
    const removed = quarantinePlanted([{ path: planted, anchor: root }, { path: link, anchor: root }], undefined);
    expect(removed.sort()).toEqual([planted, link].sort());
    expect(existsSync(planted)).toBe(false);
    expect(() => lstatSync(link)).toThrow();
    expectOutsideUntouched();
  });
});

describe("background-task output files (<session temp>/tasks/<id>.output)", () => {
  function sessionTemp() {
    const sessionRoot = join(base, "session");
    mkdirSync(join(sessionRoot, "scratchpad"), { recursive: true });
    configureBackgroundTaskRoot(() => ({ root: sessionRoot, scratchpad: join(sessionRoot, "scratchpad"), tasks: join(sessionRoot, "tasks") }));
    return sessionRoot;
  }
  afterEach(() => resetBackgroundTaskRootForTest());

  // Settles whether `tasks/` is a sandboxed command's to rename: the session temp folder (its ROOT, not just the
  // scratchpad) is the tools' `tempDir`, and `tempDir` is a write root of every sandboxed command.
  test.skipIf(process.platform !== "darwin")("macOS, the real sandbox profile: a sandboxed command CAN rename tasks/ and put a link in its place", async () => {
    const sessionRoot = sessionTemp();
    const { outputPath } = createBackgroundTask("bash");
    const tasks = join(sessionRoot, "tasks");
    expect(outputPath.startsWith(tasks)).toBe(true);
    const ctx = { ...makeCtx(), tempDir: sessionRoot } as ToolExecutionContext;
    const { signal: _s, ...opts } = buildRunCommandOptions({ command: "true" } as never, ctx) as Record<string, unknown>;
    const result = await runCommand({ ...(opts as unknown as Parameters<typeof runCommand>[0]), command: `mv "${tasks}" "${join(sessionRoot, "t2")}" && ln -s "${outside}" "${tasks}"`, timeoutMs: 8000 });
    expect(result.exitCode).toBe(0);
    expect(lstatSync(tasks).isSymbolicLink()).toBe(true);
    // ...and the output's open refuses the swapped folder, so nothing is created where the link points.
    expect(() => openTaskOutputStream(outputPath)).toThrow("not the folder it was made as");
    expectOutsideUntouched();
  });

  test("tasks/ swapped for a link before the open (the seam): refused, nothing created outside", () => {
    const sessionRoot = sessionTemp();
    const { outputPath } = createBackgroundTask("bash");
    const tasks = join(sessionRoot, "tasks");
    _setNoFollowWriteSeamForTests(() => undefined);
    renameSync(tasks, join(sessionRoot, "t2"));
    symlinkSync(outside, tasks);
    expect(() => openTaskOutputStream(outputPath)).toThrow();
    expect(() => writeInFolder(outputPath, "stub", "replace")).toThrow();
    expectOutsideUntouched();
  });

  test("tasks/ swapped for a link between the folder check and the open: refused, nothing created outside", () => {
    const sessionRoot = sessionTemp();
    const { outputPath } = createBackgroundTask("bash");
    const tasks = join(sessionRoot, "tasks");
    let swapped = false;
    _setNoFollowWriteSeamForTests((stage) => {
      if (stage !== "beforeOpen" || swapped) return;
      swapped = true;
      renameSync(tasks, join(sessionRoot, "t2"));
      symlinkSync(outside, tasks);
    });
    expect(() => openTaskOutputStream(outputPath)).toThrow();
    expect(swapped).toBe(true);
    expectOutsideUntouched();
  });

  test("a link planted at the output file itself: TaskOutput's read refuses it (a secret is never read back)", () => {
    const sessionRoot = sessionTemp();
    const { outputPath } = createBackgroundTask("bash");
    symlinkSync(secret, outputPath);
    expect(() => readInFolder(outputPath)).toThrow();
    expect(() => openTaskOutputStream(outputPath)).toThrow();
    expectOutsideUntouched();
    void sessionRoot;
  });

  test("a normal output: written once through the descriptor, appended, and read back", async () => {
    sessionTemp();
    const { outputPath } = createBackgroundTask("bash");
    const stream = openTaskOutputStream(outputPath);
    await new Promise<void>((done) => {
      stream.write("line one\n");
      stream.end("line two\n", () => done());
    });
    writeInFolder(outputPath, "appended\n", "append");
    expect(readInFolder(outputPath).toString("utf8")).toBe("line one\nline two\nappended\n");
  });
});

describe("the checkpoint's pre-image never copies a file through a link", () => {
  test("a link at the path: no bytes in the store, and a later rewind restores nothing there", async () => {
    const home = join(base, "home");
    mkdirSync(home);
    const x = join(root, "x");
    symlinkSync(secret, x);
    const sink = createFileCheckpointSink({ home, cwd: root, sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: x, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    const records = readCheckpointIndex(home, "sess-1");
    expect(records).toHaveLength(1);
    expect(records[0]!.linked).toBe("symbolic-link");
    for (const name of readdirSync(sessionCheckpointDir(home, "sess-1"))) {
      expect(readFileSync(join(sessionCheckpointDir(home, "sess-1"), name, ...[]), "utf8")).not.toContain(SECRET.trim());
    }
    // The command removes the link and leaves a file of its own; the rewind must not fill it with the secret.
    rmSync(x);
    writeFileSync(x, "the command's own file\n");
    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([]);
    expect(readFileSync(x, "utf8")).toBe("the command's own file\n");
  });

  test("a hard link at the path: the same", async () => {
    const home = join(base, "home");
    mkdirSync(home);
    const x = join(root, "x");
    linkSync(secret, x);
    const sink = createFileCheckpointSink({ home, cwd: root, sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: x, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    expect(readCheckpointIndex(home, "sess-1")[0]!.linked).toBe("hard-link");
    rmSync(x);
    writeFileSync(x, "the command's own file\n");
    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(readFileSync(x, "utf8")).toBe("the command's own file\n");
    expectOutsideUntouched();
  });
});
