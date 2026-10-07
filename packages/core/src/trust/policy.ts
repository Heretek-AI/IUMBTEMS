// The write/read/shell policy every harness adapter enforces. Decisions are
// pure functions of (root, active worktree, agent, target) so they can be
// tested without a host and applied identically by OpenCode's
// permission.evaluate + tool.execute.before, Claude Code hooks, Pi tool_call
// handlers and the Antigravity PreToolUse hook.
import { agentSpec, type WriteScope } from "../agents/registry.ts"
import { stateDir } from "../layout.ts"
import { matchAny } from "../util/glob.ts"
import { controlClass } from "./control.ts"
import { canonicalPath, isInside, relativeTo, resolveTarget } from "./paths.ts"
import { SANDBOX_MISSING, type SandboxKind } from "./sandbox.ts"

export type Decision = { readonly effect: "allow" } | { readonly effect: "deny" | "ask"; readonly reason: string }

export interface PolicyContext {
  readonly root: string
  /** Absolute path of the active phase worktree, when a phase is building. */
  readonly worktree?: string
  /** Override for the user-global state dir (tests). */
  readonly stateDir?: string
}

const allow: Decision = { effect: "allow" }
const deny = (reason: string): Decision => ({ effect: "deny", reason })

const SCOPE_GLOBS: Record<Exclude<WriteScope, "worktree">, readonly string[]> = {
  "factory-docs": [
    ".factory/roadmap.json",
    ".factory/specs/**",
    ".factory/research/**",
    ".factory/notes/**",
    "docs/**",
    "README.md",
  ],
  research: [".factory/research/**"],
  // Engine state under these dirs is a control file (tools only); seats keep notes.
  brainstorm: [".factory/brainstorm/notes/**"],
  harvest: [".factory/harvest/notes/**"],
  design: [".factory/design/notes/**"],
  scout: [".factory/scout/notes/**"],
}

function guardStateDir(context: PolicyContext, absolute: string): Decision | undefined {
  const dir = canonicalPath(context.stateDir ?? stateDir())
  if (isInside(dir, absolute))
    return deny(`"${absolute}" is Epistemic Swarm's private state (signing key, trust store); agents may not touch it.`)
  return undefined
}

/** May `agentId` create, modify or delete `target`? */
export function evaluateWrite(context: PolicyContext, agentId: string | undefined, target: string): Decision {
  const { absolute, relative } = resolveTarget(context.root, target)
  const spec = agentSpec(agentId)
  const state = guardStateDir(context, absolute)
  if (state) return state

  if (relative !== undefined) {
    const control = controlClass(relative)
    if (control === "factory")
      return deny(
        `"${relative}" is a factory control file. Agents cannot write it; approvals, waivers and trust go through the human-only TUI/CLI dialog.`,
      )
    if (control === "config") {
      if (spec) return deny(`"${relative}" is host configuration; factory seats may not change it.`)
      return { effect: "ask", reason: `"${relative}" controls plugins or hooks. Allow this agent to change it?` }
    }
  }

  if (!spec) return allow
  if (relative === undefined) return deny(`Factory seat "${spec.id}" may not write outside the project: ${absolute}`)

  for (const scope of spec.writes) {
    if (scope === "worktree") {
      if (!context.worktree) continue
      const worktree = canonicalPath(context.worktree)
      const inner = relativeTo(worktree, absolute)
      if (inner === undefined || inner === ".") continue
      if (inner === ".git" || inner.startsWith(".git/") || inner === ".factory" || inner.startsWith(".factory/"))
        return deny(`The programmer may not edit "${inner}" inside the phase worktree.`)
      return allow
    }
    if (matchAny(relative, SCOPE_GLOBS[scope])) return allow
  }

  const where =
    spec.writes.length === 0
      ? "is read-only"
      : spec.writes.includes("worktree")
        ? context.worktree
          ? `may only write inside its phase worktree (${relativeTo(canonicalPath(context.root), canonicalPath(context.worktree)) ?? context.worktree})`
          : "has no active phase worktree to write in"
        : `may only write ${spec.writes.map((scope) => (scope === "worktree" ? "its worktree" : SCOPE_GLOBS[scope].join(", "))).join("; ")}`
  return deny(`Seat "${spec.id}" ${where}; refused "${relative}".`)
}

/** Reads are host-governed except Epistemic Swarm's private state dir. */
export function evaluateRead(context: PolicyContext, _agentId: string | undefined, target: string): Decision {
  const { absolute } = resolveTarget(context.root, target)
  return guardStateDir(context, absolute) ?? allow
}

// ------------------------------------------------------------------ shell
//
// Enforcement is the OS sandbox (trust/sandbox.ts): every agent shell runs
// under bubblewrap with control files read-only and secrets masked; factory
// seats are refused outright without it. The text rules below are defence in
// depth with clear refusal messages, and the only layer for the user's own
// agents on hosts without bubblewrap, where they are best effort: arbitrary
// shell can always outwit pattern matching, so that mode is documented as
// weaker.

export type ShellDecision =
  | { readonly effect: "allow"; readonly mode: "sandbox"; readonly kind: SandboxKind; readonly offline: boolean }
  | { readonly effect: "allow"; readonly mode: "unsandboxed" }
  | { readonly effect: "deny"; readonly reason: string }

/** The command with shell quoting and escapes removed, so `es 'approve'` and `.fac""tory` read plainly. */
export const unquoteShell = (command: string) => command.replaceAll(/['"\\]/g, "")

const words = (command: string) => command.split(/[^\w@./-]+/).filter(Boolean)

const ES_BINARY = /^(es|epistemic-swarm|es\.js|es-cli|@heretek-ai\/es-cli(@[\w.-]+)?)$|\/(es|es\.js|epistemic-swarm)$/
/** Human-only verbs: the next word(s) after the es binary. */
const HUMAN_VERBS: ReadonlyArray<readonly [string, ((next: string | undefined) => boolean)?]> = [
  ["approve"],
  ["trust"],
  ["waive"],
  ["resume"],
  ["rebaseline"],
  ["key"],
  ["reseal"],
  ["factory", (next) => next === "resume" || next === "pr"],
  ["gates", (next) => next === "install-git"],
  ["lsp", (next) => next === "install"],
  ["config", (next) => next === "set"],
  ["research", (next) => next === "retract" || next === "export"],
  // Audit and scout runs drive a harness CLI: an agent must not start nested headless runs.
  ["audit", (next) => next !== undefined && next !== "verify" && next !== "show"],
  ["scout", (next) => next !== undefined && next !== "show"],
]

/** Whether the command invokes a human-only es verb, however it is quoted or wrapped. */
export function invokesHumanOnly(command: string): boolean {
  const tokens = words(unquoteShell(command))
  return tokens.some((token, index) => {
    if (!ES_BINARY.test(token)) return false
    const verb = tokens[index + 1]
    const rule = HUMAN_VERBS.find(([name]) => name === verb)
    return rule !== undefined && (rule[1] === undefined || rule[1](tokens[index + 2]))
  })
}

const CONTROL_MENTION =
  /\.factory\/(gates\.json|config\.json|frontier\.json|waivers|approvals|runtime|STOP|git-hooks|claims\b|audits\b|research\/(sources\b|(coverage|dossier|brief\.pcrb)\.json)|(brainstorm|harvest|design|scout)\/[^\s'"]*\.json)|\.git\/(config|hooks)|\.opencode\/(hooks\.json|plugins|opencode\.jsonc?)|\.claude\/settings|opencode\.jsonc?\b/i
/** Any mention of the factory dir (a `cd .factory` reaches control files without naming them). */
const FACTORY_MENTION = /(^|[\s/=:])\.factory(\/|[\s;|&]|$)/i
const MUTATING =
  /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bln\b|\btruncate\b|\bchmod\b|\bchown\b|\btouch\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bdd\b|\binstall\b|\bgit\s+(checkout|restore|rm|mv|reset|clean|apply|am|stash))/

/** Global git options that take a value, skipped to find the subcommand (`git -C . push`). */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
])
const SEAT_FORBIDDEN_GIT = new Set(["push", "config", "worktree", "filter-branch", "update-ref", "clean", "remote"])

/** git subcommands in a command, past global options. */
function gitSubcommands(command: string): Array<{ sub: string; args: string[] }> {
  const found: Array<{ sub: string; args: string[] }> = []
  for (const segment of segments(unquoteShell(command))) {
    const tokens = segment.split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
      if (!/(^|\/)git$/.test(tokens[i]!)) continue
      let j = i + 1
      while (j < tokens.length && tokens[j]!.startsWith("-")) j += GIT_VALUE_OPTIONS.has(tokens[j]!) ? 2 : 1
      if (j < tokens.length) found.push({ sub: tokens[j]!, args: tokens.slice(j + 1) })
    }
  }
  return found
}

const seatForbiddenGit = (command: string) =>
  gitSubcommands(command).find(
    ({ sub, args }) =>
      SEAT_FORBIDDEN_GIT.has(sub) ||
      (sub === "reset" && args.includes("--hard")) ||
      (sub === "branch" && args.some((arg) => /^-[a-zA-Z]*D/.test(arg))),
  )

/**
 * Commands that only read (each pipeline segment). No `env` (it runs any
 * program), and no tool with an output-file option: `sort -o`, `uniq IN OUT`,
 * `tree -o`, `git … --output`, `find -fprint*`/`-fls` all write.
 */
const READONLY_ALLOW = [
  /^git\s+(status|log|diff|show|blame|grep|ls-files|rev-parse|branch(\s+--list)?|describe)\b(?!.*\s--output\b)/,
  /^(ls|cat|head|tail|wc|grep|rg|stat|file|pwd|echo|which|cut|tr|diff|basename|dirname|realpath|date|true)\b/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b)/,
  /^(bun\s+test|npx\s+(vitest|jest)|vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test|bun\s+run\s+test|python3?\s+-m\s+pytest)\b/,
  /^(tsc|npx\s+tsc|bunx\s+tsc|biome\s+(check|lint|format)|npx\s+biome|bunx\s+biome|ruff\s+(check|format\s+--check)|mypy|eslint|npx\s+eslint)\b/,
]

function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n&]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/**
 * A command that cannot write: no redirection, here-doc or command
 * substitution, and every segment on the read-only allowlist. Interpreter
 * one-liners (`python3 -c`, `node -e`, `bun -e`, …) are not on it.
 */
const isProvablyReadOnly = (command: string): boolean =>
  !/[<>`]|\$\(/.test(command) &&
  segments(command).every((segment) => READONLY_ALLOW.some((pattern) => pattern.test(segment)))

export function evaluateShell(
  context: PolicyContext,
  agentId: string | undefined,
  command: string,
  options: { readonly sandboxAvailable: boolean },
): ShellDecision {
  const spec = agentSpec(agentId)
  const plain = unquoteShell(command)
  if (invokesHumanOnly(command))
    return {
      effect: "deny",
      reason:
        "That command is human-only (approvals, trust, waivers, resume, rebaseline, keys, config set, retractions, exports, audit and scout runs); agents cannot run it.",
    }
  const privateDir = canonicalPath(context.stateDir ?? stateDir())
  if (plain.includes(privateDir) || /epistemic-swarm\/(key|trust|engine)|state\/epistemic-swarm/i.test(plain))
    return { effect: "deny", reason: "Agents may not access Epistemic Swarm's private state dir." }
  if (spec) {
    if (!options.sandboxAvailable) return { effect: "deny", reason: `Factory seat "${spec.id}": ${SANDBOX_MISSING}` }
    if (CONTROL_MENTION.test(plain))
      return {
        effect: "deny",
        reason: "Factory seats may not reference control files from the shell; use the read tool to inspect them.",
      }
    const git = seatForbiddenGit(command)
    if (git)
      return {
        effect: "deny",
        reason: `Factory seats may not push, change git config or remotes, rewrite refs or manage worktrees (git ${git.sub}).`,
      }
    const kind: SandboxKind = spec.seat === "programmer" ? "programmer" : spec.readonlyShell ? "readonly" : "seat"
    return { effect: "allow", mode: "sandbox", kind, offline: spec.web === "cached" }
  }
  // The user's own agents: control files and the factory dir only in provably read-only commands.
  if (
    (CONTROL_MENTION.test(plain) || FACTORY_MENTION.test(plain)) &&
    (MUTATING.test(plain) || !isProvablyReadOnly(plain))
  )
    return {
      effect: "deny",
      reason:
        "Epistemic Swarm's .factory/ and control files may only be mentioned in a provably read-only shell command (no interpreters, redirection or substitution); use the read tool otherwise.",
    }
  return options.sandboxAvailable
    ? { effect: "allow", mode: "sandbox", kind: "user", offline: false }
    : { effect: "allow", mode: "unsandboxed" }
}

/** Quote one argument for POSIX sh. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
