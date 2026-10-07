// Canonical agent spec: every harness adapter compiles these into its native
// agents and permission rules. Seats are what the trust policy reasons about;
// an agent that is not in this registry has no seat and gets only the
// all-agent protections (control files, approval CLIs, state dir).

import { LENSES } from "../brainstorm/lenses.ts"

export type Seat =
  | "factory"
  | "grill"
  | "manager"
  | "programmer"
  | "qa-functional"
  | "qa-adversarial"
  | "research-alpha"
  | "research-beta"
  | "brainstormer"
  | "brainstorm-lens"
  | "brainstorm-critic"
  | "harvester"
  | "designer"
  | "auditor-thesis"
  | "auditor-antithesis"
  | "scout"

/** Where a seat may write with the host's edit tools. */
export type WriteScope = "factory-docs" | "research" | "brainstorm" | "harvest" | "design" | "scout" | "worktree"

export type ModelTier = "fast" | "balanced" | "deep"

export interface AgentSpec {
  readonly id: string
  readonly seat: Seat
  readonly mode: "primary" | "subagent"
  readonly hidden: boolean
  readonly tier: ModelTier
  readonly description: string
  /** Prompt asset id (assets/prompts/<id>.md). */
  readonly prompt: string
  /** Epistemic Swarm tools this seat may call (all others are hidden from it). */
  readonly tools: readonly string[]
  /** Agent IDs this seat may launch through the host's subagent tool. */
  readonly spawns: readonly string[]
  readonly writes: readonly WriteScope[]
  /** Shell runs read-only (bwrap tmp-overlay, else allowlist + diff check). */
  readonly readonlyShell: boolean
  readonly skills: readonly string[]
  readonly mcp: readonly string[]
  /** Language-server tools: "full" includes applying renames, "read" is navigation and diagnostics only. */
  readonly lsp: "full" | "read" | "none"
  /**
   * Web access. "cached": the host's websearch and webfetch are denied, so every
   * web fact comes through es_research_search / es_research_fetch (cached,
   * content-addressed, citable). "host": the host's own tools, unchanged.
   */
  readonly web: "host" | "cached"
}

const SEATS_SPAWNED_BY_FACTORY = [
  "es-manager",
  "es-programmer",
  "es-qa-functional",
  "es-qa-adversarial",
  "es-research-alpha",
  "es-research-beta",
  "es-auditor-thesis",
  "es-auditor-antithesis",
]

/** One fast-tier subagent per built-in lens, addressed as es-lens-<lens>. */
export const LENS_AGENT_PREFIX = "es-lens-"
export const lensAgentId = (lensId: string) => `${LENS_AGENT_PREFIX}${lensId}`

const LENS_SPECS: AgentSpec[] = LENSES.map((lens) => ({
  id: lensAgentId(lens.id),
  seat: "brainstorm-lens",
  mode: "subagent",
  hidden: true,
  tier: "fast",
  description: `${lens.name} lens: ${lens.summary}`,
  prompt: `lens-${lens.id}`,
  tools: [],
  spawns: [],
  writes: [],
  readonlyShell: true,
  skills: [],
  mcp: [],
  lsp: "none",
  web: "host",
}))

export const AGENTS: readonly AgentSpec[] = [
  {
    id: "factory",
    seat: "factory",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description: "Drives the build factory: research, spec, build, QA and release, gated mechanically.",
    prompt: "factory",
    tools: [
      "es_status",
      "es_gates_run",
      "es_request_approval",
      "es_research_complete",
      "es_research_audit",
      "es_spec_validate",
      "es_build_start",
      "es_release",
      "es_audit_open",
    ],
    spawns: SEATS_SPAWNED_BY_FACTORY,
    writes: ["factory-docs"],
    readonlyShell: true,
    skills: ["factory"],
    mcp: [],
    lsp: "read",
    web: "host",
  },
  {
    id: "grill",
    seat: "grill",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description: "Interviews you about an idea until the design tree is settled and the spend ceiling is set.",
    prompt: "grill",
    tools: ["es_status", "es_frontier_write", "es_request_approval"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: ["grill"],
    mcp: [],
    lsp: "none",
    web: "host",
  },
  {
    id: "brainstormer",
    seat: "brainstormer",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description: "Fans out divergent lenses on an idea and returns a diversified shortlist.",
    prompt: "brainstormer",
    tools: ["es_status", "es_brainstorm_plan", "es_brainstorm_record", "es_brainstorm_complete"],
    spawns: ["es-brainstorm-critic", ...LENSES.map((lens) => lensAgentId(lens.id))],
    writes: ["brainstorm"],
    readonlyShell: true,
    skills: ["brainstorm"],
    mcp: [],
    lsp: "none",
    web: "host",
  },
  {
    id: "harvester",
    seat: "harvester",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description: "Tears down competitor projects: profiles, licenses, a feature matrix and clean-room specs.",
    prompt: "harvester",
    tools: [
      "es_status",
      "es_harvest_plan",
      "es_harvest_discover",
      "es_harvest_scan",
      "es_harvest_read",
      "es_harvest_matrix",
      "es_harvest_complete",
      "es_harvest_prior_art",
    ],
    spawns: [],
    writes: ["harvest"],
    readonlyShell: true,
    skills: ["harvest"],
    mcp: [],
    lsp: "none",
    web: "host",
  },
  {
    id: "designer",
    seat: "designer",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description: "Interviews you into a design system: tokens, contrast gates and a generated style guide.",
    prompt: "designer",
    tools: [
      "es_status",
      "es_design_status",
      "es_design_answer",
      "es_design_skip",
      "es_design_complete",
      "es_design_check",
    ],
    spawns: [],
    writes: ["design"],
    readonlyShell: true,
    skills: ["queereye"],
    mcp: [],
    lsp: "none",
    web: "host",
  },
  {
    id: "scout",
    seat: "scout",
    mode: "primary",
    hidden: false,
    tier: "deep",
    description:
      "Finds and vets open-source candidates for a feature: licenses, maintenance, CVEs, clean-room blueprints.",
    prompt: "scout",
    tools: [
      "es_status",
      "es_scout_plan",
      "es_scout_discover",
      "es_scout_scan",
      "es_scout_advisories",
      "es_scout_record",
      "es_scout_complete",
      "es_research_search",
      "es_research_fetch",
    ],
    spawns: [],
    writes: ["scout"],
    readonlyShell: true,
    skills: ["scout"],
    mcp: [],
    lsp: "none",
    web: "cached",
  },
  {
    id: "es-manager",
    seat: "manager",
    mode: "subagent",
    hidden: true,
    tier: "deep",
    description: "Writes the roadmap and GOAL.md specs, replans failed phases, and breaks QA ties.",
    prompt: "manager",
    tools: ["es_status", "es_spec_validate", "es_tiebreak", "es_replan", "es_gates_run"],
    spawns: [],
    writes: ["factory-docs"],
    readonlyShell: true,
    skills: ["factory"],
    mcp: [],
    lsp: "read",
    web: "host",
  },
  {
    id: "es-programmer",
    seat: "programmer",
    mode: "subagent",
    hidden: true,
    tier: "balanced",
    description: "Implements one phase in its git worktree, test first, until the gated complete succeeds.",
    prompt: "programmer",
    tools: ["es_status", "es_gates_run", "es_complete"],
    spawns: [],
    writes: ["worktree"],
    readonlyShell: false,
    skills: [],
    mcp: [],
    lsp: "full",
    web: "host",
  },
  {
    id: "es-qa-functional",
    seat: "qa-functional",
    mode: "subagent",
    hidden: true,
    tier: "balanced",
    description: "Read-only QA: checks the phase against its acceptance criteria.",
    prompt: "qa-functional",
    tools: ["es_status", "es_gates_run", "es_qa_verdict"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: [],
    mcp: [],
    lsp: "read",
    web: "host",
  },
  {
    id: "es-qa-adversarial",
    seat: "qa-adversarial",
    mode: "subagent",
    hidden: true,
    tier: "deep",
    description: "Read-only QA: tries to break the phase (edge cases, security, regressions).",
    prompt: "qa-adversarial",
    tools: ["es_status", "es_gates_run", "es_qa_verdict"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: [],
    mcp: [],
    lsp: "read",
    web: "host",
  },
  {
    id: "es-research-alpha",
    seat: "research-alpha",
    mode: "subagent",
    hidden: true,
    tier: "balanced",
    description: "Research thesis seat: gathers and caches evidence for the design.",
    prompt: "research-alpha",
    tools: ["es_status", "es_research_search", "es_research_fetch", "es_research_audit"],
    spawns: [],
    writes: ["research"],
    readonlyShell: true,
    skills: [],
    mcp: [],
    lsp: "none",
    web: "cached",
  },
  {
    id: "es-research-beta",
    seat: "research-beta",
    mode: "subagent",
    hidden: true,
    tier: "balanced",
    description: "Research antithesis seat: challenges alpha's claims with counter-evidence.",
    prompt: "research-beta",
    tools: ["es_status", "es_research_search", "es_research_fetch", "es_research_audit"],
    spawns: [],
    writes: ["research"],
    readonlyShell: true,
    skills: [],
    mcp: [],
    lsp: "none",
    web: "cached",
  },
  {
    id: "es-auditor-thesis",
    seat: "auditor-thesis",
    mode: "subagent",
    hidden: true,
    tier: "deep",
    description: "Code-audit thesis: maps the target's invariants, every finding pinned to verbatim lines.",
    prompt: "auditor-thesis",
    tools: ["es_status", "es_gates_run", "es_audit_verdict"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: ["code-audit"],
    mcp: [],
    lsp: "read",
    web: "cached",
  },
  {
    id: "es-auditor-antithesis",
    seat: "auditor-antithesis",
    mode: "subagent",
    hidden: true,
    tier: "deep",
    description: "Code-audit antithesis: red-teams the target with CWE-mapped, line-pointed exploits.",
    prompt: "auditor-antithesis",
    tools: ["es_status", "es_gates_run", "es_audit_verdict"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: ["code-audit"],
    mcp: [],
    lsp: "read",
    web: "cached",
  },
  {
    id: "es-brainstorm-critic",
    seat: "brainstorm-critic",
    mode: "subagent",
    hidden: true,
    tier: "deep",
    description: "Scores brainstorm ideas 1-5 against the rubric and records the scores.",
    prompt: "brainstorm-critic",
    tools: ["es_brainstorm_score"],
    spawns: [],
    writes: [],
    readonlyShell: true,
    skills: [],
    mcp: [],
    lsp: "none",
    web: "host",
  },
  ...LENS_SPECS,
]

const byId = new Map(AGENTS.map((agent) => [agent.id, agent]))

export function agentSpec(agentId: string | undefined): AgentSpec | undefined {
  return agentId === undefined ? undefined : byId.get(agentId)
}

export function seatOf(agentId: string | undefined): Seat | undefined {
  return agentSpec(agentId)?.seat
}

/** Every Epistemic Swarm tool name across all seats. */
export const ALL_ES_TOOLS: readonly string[] = [...new Set(AGENTS.flatMap((agent) => agent.tools))].sort((a, b) =>
  a < b ? -1 : a > b ? 1 : 0,
)

export function seatMayUse(agentId: string | undefined, tool: string): boolean {
  return agentSpec(agentId)?.tools.includes(tool) ?? false
}
