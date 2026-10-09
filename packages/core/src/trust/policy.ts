// The write/read/shell policy every harness adapter enforces. Decisions are
// pure functions of (root, active worktree, agent, target) so they can be
// tested without a host and applied identically by OpenCode's
// permission.evaluate + tool.execute.before, Claude Code hooks, Pi tool_call
// handlers and the Antigravity PreToolUse hook.
import { agentSpec, type WriteScope } from "../agents/registry.ts"
import { stateDir } from "../layout.ts"
import { BOOLEAN_FLAGS } from "../util/args.ts"
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
    // The factory merges the seats' notes; it alone writes the report (#60).
    ".factory/research/REPORT.md",
    ".factory/notes/**",
    "docs/**",
    "README.md",
  ],
  // One writer per research file: each seat its own notes, never the report.
  "research-alpha": [".factory/research/alpha.md"],
  "research-beta": [".factory/research/beta.md"],
  // The deep-researcher plans in notes/; the synthesizer alone writes the
  // report in research runs (the factory still owns it in build runs, #111).
  "deep-research": [".factory/research/notes/**"],
  "research-report": [".factory/research/REPORT.md"],
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

const words = (command: string) => command.split(/[^\w@./=:-]+/).filter(Boolean)

const ES_BINARY = /^(es|epistemic-swarm|es\.js|es-cli|@heretek-ai\/es-cli(@[\w.-]+)?)$|\/(es|es\.js|epistemic-swarm)$/
/**
 * The fleet daemon binary (#122). It has its own verbs (`start`, `stop`,
 * `status`, `task`, `watch`, `gc`), so it is matched separately: the whole
 * binary is human-only except `status` and `--help`, because a running fleet
 * spends money.
 */
const FLEET_BINARY = /^(es-fleet|es-fleet\.js|@heretek-ai\/es-fleet(@[\w.-]+)?)$|\/es-fleet(\.js)?$/
/** Human-only verbs: the next word(s) after the es binary. Exported for the
 *  argv-parity property test (#97): the CLI grammar lives in core. */
export type HumanVerbRule = readonly [string, ((next: string | undefined) => boolean)?]
export const HUMAN_VERBS: ReadonlyArray<HumanVerbRule> = [
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
  ["research", (next) => next === "retract" || next === "export" || next === "deep"],
  // Audit and scout runs drive a harness CLI: an agent must not start nested headless runs.
  ["audit", (next) => next !== undefined && next !== "verify" && next !== "show"],
  ["scout", (next) => next !== undefined && next !== "show"],
]

/**
 * A single plain `es … --help`: no separators, quoting, escapes, expansions,
 * redirections or wrappers, the es binary first, and a standalone `--help`
 * before any `--`. The CLI prints usage for it before doing anything else, so
 * it is safe for agents (#59); everything else keeps the human-only check.
 */
function isPlainHelp(command: string): boolean {
  if (/[;&|\n()'"`$\\<>{}]/.test(command)) return false
  const argv = command.trim().split(/\s+/)
  if (!ES_BINARY.test(argv[0] ?? "") && !FLEET_BINARY.test(argv[0] ?? "")) return false
  const help = argv.indexOf("--help")
  const end = argv.indexOf("--")
  return help > 0 && (end === -1 || help < end)
}

/** A word position, and whether a `--` before it made every word positional. */
interface Cursor {
  readonly at: number
  readonly literal: boolean
}

/**
 * Where the CLI parser's next positional could be, scanning from `from` (an
 * index past the end means there is none). The parser takes flags anywhere
 * (#88): `--` makes the rest positional, `--flag value` consumes the value
 * unless the flag is boolean, and `--flag=value` never consumes the next word
 * (the value is inline, as in the CLI's parseArgs, #97). A KNOWN boolean (the
 * CLI's BOOLEAN_FLAGS, #97) never consumes, so only the next word is a
 * candidate; an unknown `--flag` counts both ways, since the next word may be
 * its value or the verb.
 */
function nextPositionals(tokens: readonly string[], from: Cursor): Cursor[] {
  const found: Cursor[] = []
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const cursor = stack.pop()!
    const key = `${cursor.at}:${cursor.literal}`
    if (seen.has(key)) continue
    seen.add(key)
    const token = tokens[cursor.at]
    if (token === undefined || cursor.literal || !token.startsWith("--")) found.push(cursor)
    else if (token === "--") stack.push({ at: cursor.at + 1, literal: true })
    else {
      const name = token.slice(2).split("=", 1)[0]!
      const inline = token.includes("=")
      stack.push({ at: cursor.at + 1, literal: false })
      if (!inline && !BOOLEAN_FLAGS.includes(name)) stack.push({ at: cursor.at + 2, literal: false })
    }
  }
  return found
}

/**
 * Whether the fleet binary at `tokens[binary]` runs a human-only verb: every
 * verb except `status` (#122). Resolution is single-path and fail-closed:
 * known booleans (the CLI's BOOLEAN_FLAGS, #97) never consume a word, while
 * every other `--flag` is assumed to take a value, so an unknown flag swallows
 * the next word and the command stays human-only. `--` makes the rest
 * positional, and `--flag=value` never consumes.
 */
function fleetHumanOnlyAfter(tokens: readonly string[], binary: number): boolean {
  let i = binary + 1
  let literal = false
  while (i < tokens.length) {
    const token = tokens[i]!
    if (literal || !token.startsWith("--")) return token !== "status"
    if (token === "--") {
      literal = true
      i += 1
      continue
    }
    const name = token.slice(2).split("=", 1)[0]!
    if (BOOLEAN_FLAGS.includes(name) || token.includes("=")) i += 1
    else i += 2
  }
  // A bare `es-fleet` (or flags alone) can still start work: human-only.
  return true
}

/** Whether the es binary at `tokens[binary]` can run a human-only verb. */
function humanVerbAfter(tokens: readonly string[], binary: number): boolean {
  return nextPositionals(tokens, { at: binary + 1, literal: false }).some((verb) => {
    const rule = HUMAN_VERBS.find(([name]) => name === tokens[verb.at])
    if (rule === undefined) return false
    const [, sub] = rule
    if (sub === undefined) return true
    return nextPositionals(tokens, { at: verb.at + 1, literal: verb.literal }).some((next) => sub(tokens[next.at]))
  })
}

/**
 * Whether the command invokes a human-only es verb, however it is quoted or
 * wrapped. Deliberately quote-blind, so text that only names a verb (a
 * here-doc, a `-m` or `--body` argument) reads as a call too (#86). That false
 * positive is the price of catching `sh -c`, `xargs` and interpreter wrappers;
 * the refusal tells the agent to pass such text by file instead.
 */
export function invokesHumanOnly(command: string): boolean {
  if (isPlainHelp(command)) return false
  const tokens = words(unquoteShell(command))
  return tokens.some(
    (token, index) =>
      (ES_BINARY.test(token) && humanVerbAfter(tokens, index)) ||
      (FLEET_BINARY.test(token) && fleetHumanOnlyAfter(tokens, index)),
  )
}

/**
 * Whether a human-only match is a plain call: no here-doc, and an es binary
 * heading its segment. Anything else may be text that only names the verb.
 */
const calledAtHead = (command: string): boolean =>
  !command.includes("<<") &&
  segments(unquoteShell(command)).some((segment) => {
    const tokens = words(segment)
    return (
      (ES_BINARY.test(tokens[0] ?? "") && humanVerbAfter(tokens, 0)) ||
      (FLEET_BINARY.test(tokens[0] ?? "") && fleetHumanOnlyAfter(tokens, 0))
    )
  })

const HUMAN_ONLY =
  "That command is human-only (approvals, trust, waivers, resume, rebaseline, keys, config set, retractions, exports, audit and scout runs, fleet start/stop); agents cannot run it."
const MENTION_HINT =
  " If it only names the verb in text (a here-doc, a commit message, a `--body` argument), the rule still reads a call: write the text to a file with the edit tool and pass the file (`gh … --body-file`, `git commit -F`)."

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
    return { effect: "deny", reason: calledAtHead(command) ? HUMAN_ONLY : HUMAN_ONLY + MENTION_HINT }
  const privateDir = canonicalPath(context.stateDir ?? stateDir())
  if (plain.includes(privateDir) || /epistemic-swarm\/(key|trust|engine)|state\/epistemic-swarm/i.test(plain))
    return { effect: "deny", reason: "Agents may not access Epistemic Swarm's private state dir." }
  if (spec) {
    if (!options.sandboxAvailable) return { effect: "deny", reason: `Factory seat "${spec.id}": ${SANDBOX_MISSING}` }
    if (CONTROL_MENTION.test(plain))
      return {
        effect: "deny",
        reason:
          "Factory seats may not reference control files from the shell. Inspect them with the read tool (it lists directories too), glob or grep; es_status summarizes the run (seats, research progress, last activity).",
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
