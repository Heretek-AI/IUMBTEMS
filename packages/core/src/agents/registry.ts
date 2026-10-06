// Canonical agent spec: every harness adapter compiles these into its native
// agents and permission rules. Seats are what the trust policy reasons about;
// an agent that is not in this registry has no seat and gets only the
// all-agent protections (control files, approval CLIs, state dir).

export type Seat =
  | "factory"
  | "grill"
  | "manager"
  | "programmer"
  | "qa-functional"
  | "qa-adversarial"
  | "research-alpha"
  | "research-beta"

/** Where a seat may write with the host's edit tools. */
export type WriteScope = "factory-docs" | "research" | "worktree"

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
}

const SEATS_SPAWNED_BY_FACTORY = [
  "es-manager",
  "es-programmer",
  "es-qa-functional",
  "es-qa-adversarial",
  "es-research-alpha",
  "es-research-beta",
]

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
    ],
    spawns: SEATS_SPAWNED_BY_FACTORY,
    writes: ["factory-docs"],
    readonlyShell: true,
    skills: ["factory"],
    mcp: [],
    lsp: "read",
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
  },
]

const byId = new Map(AGENTS.map((agent) => [agent.id, agent]))

export function agentSpec(agentId: string | undefined): AgentSpec | undefined {
  return agentId === undefined ? undefined : byId.get(agentId)
}

export function seatOf(agentId: string | undefined): Seat | undefined {
  return agentSpec(agentId)?.seat
}

/** Every Epistemic Swarm tool name across all seats. */
export const ALL_ES_TOOLS: readonly string[] = [...new Set(AGENTS.flatMap((agent) => agent.tools))].sort()

export function seatMayUse(agentId: string | undefined, tool: string): boolean {
  return agentSpec(agentId)?.tools.includes(tool) ?? false
}
