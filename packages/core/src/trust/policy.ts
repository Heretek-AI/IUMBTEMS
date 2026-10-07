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

export type ShellDecision =
  | { readonly effect: "allow"; readonly mode: "normal" | "readonly-sandbox" | "readonly-checked" }
  | { readonly effect: "deny"; readonly reason: string }

const HUMAN_ONLY_CLI =
  /(^|[\s;&|(`'"/])(es|epistemic-swarm)\s+(approve|trust|waive|resume|rebaseline|factory\s+(resume|pr)|gates\s+install-git|lsp\s+install|config\s+set|research\s+retract)\b/
/** Human-launched jobs that drive a harness CLI: an agent must not start nested headless runs. */
const HUMAN_ONLY_JOBS = /(^|[\s;&|(`'"/])(es|epistemic-swarm)\s+(audit\s+(?!(verify|show)\b)\S|scout\s+(?!show\b)\S)/
const CONTROL_MENTION =
  /\.factory\/(gates\.json|config\.json|frontier\.json|waivers|approvals|runtime|STOP|git-hooks|claims\b|audits\b|research\/(sources\b|(coverage|dossier|brief\.pcrb)\.json)|(brainstorm|harvest|design|scout)\/[^\s'"]*\.json)|\.git\/(config|hooks)|\.opencode\/(hooks\.json|plugins|opencode\.jsonc?)|\.claude\/settings|opencode\.jsonc?\b/
const MUTATING =
  /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bln\b|\btruncate\b|\bchmod\b|\bchown\b|\btouch\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bdd\b|\binstall\b|\bgit\s+(checkout|restore|rm|mv|reset|clean|apply|am|stash))/
const SEAT_FORBIDDEN_GIT =
  /\bgit\s+(push|reset\s+--hard|clean\b|branch\s+-D|worktree\b|filter-branch|update-ref|config\b)/

/** Commands a read-only seat may run when bubblewrap is unavailable (each pipeline segment). */
const READONLY_ALLOW = [
  /^git\s+(status|log|diff|show|blame|grep|ls-files|rev-parse|branch(\s+--list)?|describe)\b/,
  /^(ls|cat|head|tail|wc|grep|rg|stat|file|tree|pwd|echo|which|sort|uniq|cut|tr|diff|basename|dirname|realpath|env|date|true)\b/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|fprint)\b)/,
  /^(bun\s+test|npx\s+(vitest|jest)|vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test|bun\s+run\s+test|python3?\s+-m\s+pytest)\b/,
  /^(tsc|npx\s+tsc|bunx\s+tsc|biome\s+(check|lint|format)|npx\s+biome|bunx\s+biome|ruff\s+(check|format\s+--check)|mypy|eslint|npx\s+eslint)\b/,
]

function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function evaluateShell(
  context: PolicyContext,
  agentId: string | undefined,
  command: string,
  options: { readonly sandboxAvailable: boolean },
): ShellDecision {
  const spec = agentSpec(agentId)
  if (HUMAN_ONLY_CLI.test(command) || HUMAN_ONLY_JOBS.test(command))
    return {
      effect: "deny",
      reason:
        "That command is human-only (approvals, trust, waivers, resume, rebaseline, config set, retractions, audit and scout runs); agents cannot run it.",
    }
  const privateDir = canonicalPath(context.stateDir ?? stateDir())
  if (command.includes(privateDir) || /epistemic-swarm\/(key|trust)/.test(command))
    return { effect: "deny", reason: "Agents may not access Epistemic Swarm's private state dir." }
  if (CONTROL_MENTION.test(command) && (spec || MUTATING.test(command)))
    return {
      effect: "deny",
      reason: spec
        ? "Factory seats may not reference control files from the shell; use the read tool to inspect them."
        : "Modifying factory control files from the shell is not allowed.",
    }
  if (!spec) return { effect: "allow", mode: "normal" }
  if (SEAT_FORBIDDEN_GIT.test(command))
    return {
      effect: "deny",
      reason: "Factory seats may not push, rewrite refs, manage worktrees or change git config.",
    }
  if (!spec.readonlyShell) return { effect: "allow", mode: "normal" }
  if (options.sandboxAvailable) return { effect: "allow", mode: "readonly-sandbox" }
  if (/`|\$\(/.test(command))
    return { effect: "deny", reason: "Command substitution is not allowed in a read-only seat without bubblewrap." }
  const blocked = segments(command).find((segment) => !READONLY_ALLOW.some((pattern) => pattern.test(segment)))
  if (blocked)
    return {
      effect: "deny",
      reason: `Read-only seat "${spec.id}" may not run "${blocked}" (bubblewrap unavailable, allowlist enforced).`,
    }
  return { effect: "allow", mode: "readonly-checked" }
}

/** Quote one argument for POSIX sh. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}
