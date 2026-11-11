// An unexpected filesystem error inside a tool (a path that changed under it) is the call's error, returned to the
// model; it never leaves the executor as a throw that ends the turn. Anything else still throws.
import { afterEach, expect, test } from "bun:test";
import { buildRegistryToolExecutor, getRegisteredTool, replaceExecutor, type RegistryToolExecutorDeps, type ToolExecutor } from "./registry.ts";
import "./impl/index.ts";

const original = getRegisteredTool("Read")!.executor!;
afterEach(() => replaceExecutor("Read", original));

const deps = { sessionId: "s", home: "/tmp/h", getCwd: () => "/tmp", probeReadAccess: () => "silent", emitFrame: () => {}, getTempDir: () => "/tmp" } as unknown as RegistryToolExecutorDeps;

test("a tool that throws a filesystem error: an error result, not a throw", async () => {
  const throwing: ToolExecutor = { execute: async () => { throw Object.assign(new Error("EINVAL: invalid argument, lstat '/tmp/x'"), { code: "EINVAL" }); } };
  replaceExecutor("Read", throwing);
  const r = await buildRegistryToolExecutor(deps).execute({ id: "c1", name: "Read", input: { file_path: "/tmp/x" } });
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("EINVAL");
});

test("a tool that throws anything else: still thrown", async () => {
  replaceExecutor("Read", { execute: async () => { throw new Error("a bug"); } });
  await expect(buildRegistryToolExecutor(deps).execute({ id: "c2", name: "Read", input: { file_path: "/tmp/x" } })).rejects.toThrow("a bug");
});
