// The runtime's command sandbox, as a public subpath: `@waifucave/clover-agent-runtime/sandbox`.
//
// WHY. A host that runs a command for someone other than a session (MOSS runs another computer's Bash on this one)
// should run it under the SAME sandbox a session's Bash gets, not a second implementation that drifts from it. On
// Linux that is the part a host can't easily rebuild: the deny patterns walked under every write root on one budget
// per command, failing closed past it (a root the walk can't finish isn't writable that run); the protected folders
// made before the run so a mount holds them; what the command made at a protected path moved aside at its end, its
// parent checked against the walk's identity (`quarantinePlanted`); and every held match's identity taken at the start,
// so an entry swapped in at a held path (the rename) is moved aside at the end whatever the mounts held (`swappedHeld`).
// A host that hands a command one folder can also ask for that folder to be SWEPT at the end (`sweepRoots`): every new
// match of the deny patterns there moved aside whole, never deleted, and what couldn't be read through or moved said
// as data (`unswept`, `notMoved`) for the host to tell its caller (`movedAsideNote` words it; `notePath` escapes a path).
//
// WHAT. `runCommand` here is the HOST's run: it never hands the command to a host Code broker bound in the calling
// thread (a session realm's door; the host is the trusted parent), and it always runs as `requireSandboxed` (refused,
// before anything starts, when the settings would run it plain: disabled, excluded, an override). The inputs come from
// the host's own `SandboxSettings` (`buildHostSandboxRunInputs`: the write roots it names, the deny lists split into
// paths and glob regexes the way Bash's own are). No network unless the settings allow it (`network` undefined: none).
// `sweepLinuxRuns` is for the host's exit, as `winter` and the embedded host call it.
//
// LIGHT ON PURPOSE, like `./mcp-client`: this entry reaches the sandbox modules and the deny-path splitter only --
// never the engine, the tool registry or anything else with session state -- so a host can import it on its main
// thread.
import { runCommandLocally, type RunCommandOptions, type RunCommandResult } from "./sandbox/spawn.ts";

/** The host's command under the sandbox: always local (never a bound broker), always required to be sandboxed. */
export function runCommand(opts: Omit<RunCommandOptions, "requireSandboxed" | "dangerouslyDisableSandbox">): Promise<RunCommandResult> {
  return runCommandLocally({ ...opts, requireSandboxed: true });
}

export {
  linuxSandboxReady,
  commandSandboxAvailable,
  isSandboxAvailable,
  sandboxUnavailableMessage,
  sweepLinuxRuns,
  movedAsideNote,
  notePath,
  notWritableLine,
  SandboxUnavailableError,
  type RunCommandOptions,
  type RunCommandResult,
} from "./sandbox/spawn.ts";
export { buildHostSandboxRunInputs, computeDenyPaths, type HostSandboxRunInputs, type SandboxRunInputs } from "./tools/sandbox-run-inputs.ts";
export { splitDenyPathsByGlobShape, globDenyEntriesOf, type GlobDenyEntry } from "./permissions/file-rules.ts";
export type { SandboxSettings, SandboxBrand } from "./sandbox/profile.ts";
