// The runtime's command sandbox, as a public subpath: `@waifucave/clover-agent-runtime/sandbox`.
//
// WHY. A host that runs a command for someone other than a session (MOSS runs another computer's Bash on this one)
// should run it under the SAME sandbox a session's Bash gets, not a second implementation that drifts from it. On
// Linux that is the part a host can't easily rebuild: the deny patterns walked under every write root on one budget
// per command, failing closed past it (a root the walk can't finish isn't writable that run); the protected folders
// made before the run so a mount holds them; and what the command made at a protected path moved aside at its end,
// its parent checked against the walk's identity (`quarantinePlanted`), with a crashed run's leftovers finished first.
//
// WHAT. `runCommand` (sandbox/spawn.ts) with the inputs a host builds from its own `SandboxSettings`
// (`buildHostSandboxRunInputs`: the write roots it names, the deny lists split into paths and glob regexes the way
// Bash's own are), and the readiness checks. No network unless the settings allow it (`network` undefined: none).
// `sweepLinuxRuns` is for the host's own exit, as `winter` and the embedded host call it.
//
// LIGHT ON PURPOSE, like `./mcp-client`: this entry reaches the sandbox modules and the deny-path splitter only --
// never the engine, the tool registry or anything else with session state -- so a host can import it on its main
// thread.
export {
  runCommand,
  linuxSandboxReady,
  commandSandboxAvailable,
  isSandboxAvailable,
  sandboxUnavailableMessage,
  sweepLinuxRuns,
  SandboxUnavailableError,
  type RunCommandOptions,
  type RunCommandResult,
} from "./sandbox/spawn.ts";
export { buildHostSandboxRunInputs, computeDenyPaths, type HostSandboxRunInputs, type SandboxRunInputs } from "./tools/sandbox-run-inputs.ts";
export { splitDenyPathsByGlobShape, globDenyEntriesOf, type GlobDenyEntry } from "./permissions/file-rules.ts";
export type { SandboxSettings, SandboxBrand } from "./sandbox/profile.ts";
