// The OS sandbox every agent shell and every gate run goes through (1.1.1).
// Text rules cannot stop arbitrary shell, so enforcement is a bubblewrap mount
// namespace built from the agent's seat:
//   - user:       the user's own agents. The project stays writable; .factory/
//                 is read-only; secrets are masked; git and gh keep working.
//   - seat:       a factory seat with a normal shell. As user, plus host and
//                 git config read-only and push credentials masked.
//   - programmer: everything read-only except its phase worktree (and a
//                 private /tmp); credentials masked.
//   - readonly:   QA, auditors, research: nothing writable (writes in the cwd
//                 land in a throwaway overlay when bwrap supports one).
//   - gate:       a gate command (it runs agent-written tests): only the gate's
//                 directory is writable, as for the programmer.
// Every kind masks Epistemic Swarm's private state dir (signing and engine
// keys) and the OpenCode server password. Seats with web:"cached" get no
// network. Mount order matters: bwrap applies them in sequence.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type SandboxKind = "user" | "seat" | "programmer" | "readonly" | "gate"

export interface SandboxSpec {
  readonly kind: SandboxKind
  /** The project root (canonical). */
  readonly root: string
  readonly cwd: string
  /** The one writable directory for programmer and gate kinds (worktree or gate dir). */
  readonly writable?: string
  /** Epistemic Swarm's private state dir, masked for every kind. */
  readonly stateDir: string
  /** Home directory whose secrets are masked (default: the real home). */
  readonly home?: string
  /** No network (seats whose web access is "cached"). */
  readonly offline?: boolean
}

export interface SandboxProbe {
  readonly exists: (file: string) => boolean
  /** bwrap supports --overlay-src/--tmp-overlay (0.10+). */
  readonly overlay: boolean
  readonly uid?: number
}

/** Project paths no agent shell may change, relative to the root and to a phase worktree. */
const PROTECTED_ALWAYS = [".factory"]
const PROTECTED_FOR_SEATS = [
  ".git/config",
  ".git/hooks",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
  ".claude/settings.json",
  ".claude/settings.local.json",
]
/** Inside a phase worktree, .git is a pointer file the programmer must not retarget. */
const PROTECTED_IN_WORKTREE = [".git"]

/** Secrets masked for every agent (relative to home). */
const SECRET_FILES = [".config/opencode/service.json"]
/** Credentials masked for factory seats and gates (relative to home). */
const CREDENTIAL_DIRS = [".ssh", ".config/gh", ".gnupg", ".docker"]
const CREDENTIAL_FILES = [
  ".git-credentials",
  ".config/git/credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
]
const SECRET_ENV = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]
const CREDENTIAL_ENV = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "CARGO_REGISTRY_TOKEN",
  "TWINE_PASSWORD",
]

const inside = (dir: string, file: string) => file === dir || file.startsWith(`${dir}${path.sep}`)

/** The bwrap argv that runs `command` under `spec`. Pure given `probe` (tests pass a fake one). */
export function sandboxArgv(
  spec: SandboxSpec,
  command: readonly string[],
  probe: SandboxProbe = liveProbe(),
): string[] {
  const home = spec.home ?? os.homedir()
  const user = spec.kind === "user"
  const writableRoot = spec.kind === "user" || spec.kind === "seat"
  const writable = spec.kind === "programmer" || spec.kind === "gate" ? spec.writable : undefined
  const protectedRel = user ? PROTECTED_ALWAYS : [...PROTECTED_ALWAYS, ...PROTECTED_FOR_SEATS]
  const protectedIn = (dir: string, names: readonly string[]) =>
    names.map((name) => path.join(dir, name)).filter((file) => probe.exists(file))
  const args: string[] = ["bwrap", writableRoot ? "--bind" : "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
  const roBind = (file: string) => args.push("--ro-bind", file, file)

  // Overlays first: later binds (sources resolved on the host) land on top of them.
  if (!writableRoot) {
    // A private /tmp; projects and homes that live under /tmp are bound back in.
    args.push("--tmpfs", "/tmp")
    // Tool caches under home stay usable; writes there are thrown away.
    if (probe.overlay && probe.exists(home)) args.push("--overlay-src", home, "--tmp-overlay", home)
    else if (inside("/tmp", home) && probe.exists(home)) roBind(home)
    if (inside("/tmp", spec.root) && !(probe.overlay && inside(home, spec.root))) roBind(spec.root)
  }
  // Project control paths are read-only.
  for (const file of protectedIn(spec.root, protectedRel)) roBind(file)
  // The one writable directory, then re-protect what lies inside it.
  if (writable) {
    args.push("--bind", writable, writable)
    for (const file of protectedIn(spec.root, protectedRel))
      if (inside(writable, file) && file !== writable) roBind(file)
    if (spec.kind === "programmer")
      for (const file of protectedIn(writable, [...PROTECTED_IN_WORKTREE, ...protectedRel])) roBind(file)
  }
  // A read-only seat's writes in its cwd land in a throwaway layer (when bwrap can).
  if (spec.kind === "readonly" && probe.overlay) args.push("--overlay-src", spec.cwd, "--tmp-overlay", spec.cwd)

  // Secrets, for every kind.
  if (probe.exists(spec.stateDir)) args.push("--tmpfs", spec.stateDir)
  for (const file of SECRET_FILES.map((name) => path.join(home, name)))
    if (probe.exists(file)) args.push("--ro-bind", "/dev/null", file)
  for (const name of SECRET_ENV) args.push("--unsetenv", name)
  // Credentials, for everything that is not the user's own agent.
  if (!user) {
    for (const dir of CREDENTIAL_DIRS.map((name) => path.join(home, name)))
      if (probe.exists(dir)) args.push("--tmpfs", dir)
    for (const file of CREDENTIAL_FILES.map((name) => path.join(home, name)))
      if (probe.exists(file)) args.push("--ro-bind", "/dev/null", file)
    const runtime = probe.uid === undefined ? undefined : `/run/user/${probe.uid}`
    if (runtime && probe.exists(runtime)) args.push("--tmpfs", runtime)
    for (const name of CREDENTIAL_ENV) args.push("--unsetenv", name)
  }
  // Tells the es CLI it runs in an agent sandbox (the state dir is masked), so
  // it can point at the es_status tool instead of reporting a forged seal (#59).
  args.push("--setenv", "ES_SANDBOX", spec.kind)
  if (spec.offline) args.push("--unshare-net")
  // The user's agent may leave servers running in the background; seats and gates may not.
  if (!user) args.push("--unshare-pid", "--die-with-parent")
  args.push("--chdir", spec.cwd, "--", ...command)
  return args
}

let overlayCache: boolean | undefined
/** Whether this bwrap supports --tmp-overlay (Ubuntu 24.04 ships 0.9, which does not). */
export function bwrapOverlay(): boolean {
  if (overlayCache !== undefined) return overlayCache
  try {
    // bwrap is resolved from PATH by design (it may be absent).
    const probe = spawnSync(
      // NOSONAR
      "bwrap",
      ["--ro-bind", "/", "/", "--dev", "/dev", "--overlay-src", "/tmp", "--tmp-overlay", "/tmp", "--", "true"],
      { timeout: 5000 },
    )
    overlayCache = probe.status === 0
  } catch {
    overlayCache = false
  }
  return overlayCache
}

function liveProbe(): SandboxProbe {
  return { exists: existsSync, overlay: bwrapOverlay(), uid: process.getuid?.() }
}

/** For tests: forget the cached overlay probe. */
export const resetOverlayProbe = () => {
  overlayCache = undefined
}

/** Why a sandbox cannot run here, for refusal messages. */
export const SANDBOX_MISSING =
  "bubblewrap (bwrap) is required to sandbox factory seats and gate runs, and it is not available here. Install bubblewrap; on Ubuntu 24.04+ also allow unprivileged user namespaces (sysctl kernel.apparmor_restrict_unprivileged_userns=0)."
