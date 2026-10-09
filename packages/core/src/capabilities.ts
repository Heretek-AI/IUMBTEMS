// The capability matrix: what each harness actually enforces, declared once
// and shared by the hook inspector, /status, the generated docs and (later)
// the Claude/Pi/Antigravity adapters. ENFORCED rows must name the proof that
// exercises them on a real harness (a test file);
// ADVISORY rows are best-effort and labelled as such; UNSUPPORTED rows are
// declared gaps, not silently absent.
import type { Harness, Support } from "./hooks/compile.ts"
import { HOOK_CAPABILITIES } from "./hooks/compile.ts"

export type { Harness, Support }

export const CAPABILITIES = [
  "agents",
  "skills",
  "tools",
  "permissions",
  "hooks",
  "question",
  "subagents",
  "compaction",
  "websearch",
  "lsp",
  "panels",
  "research",
  "brainstorm",
  "harvest",
  "design",
  "claims",
  "audit",
  "scout",
] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface CapabilityRow {
  readonly capability: Capability
  readonly support: Support
  readonly detail: string
  /** Repo-relative proof for ENFORCED rows (a real-host or real-render test file). */
  readonly test?: string
}

const opencode = (rows: Record<Capability, Omit<CapabilityRow, "capability">>): CapabilityRow[] =>
  CAPABILITIES.map((capability) => ({ capability, ...rows[capability] }))

const PLUGIN = "packages/opencode/test/plugin.test.ts"

export const CAPABILITY_MATRIX: Readonly<Record<Harness, readonly CapabilityRow[]>> = {
  opencode: opencode({
    agents: {
      support: "enforced",
      detail: "Registered by agent.transform with wildcard-deny scoping; never touches built-ins or defaults.",
      test: PLUGIN,
    },
    skills: {
      support: "enforced",
      detail: "One shared SKILL.md tree registered at runtime; per-agent visibility via skill deny rules.",
      test: PLUGIN,
    },
    tools: {
      support: "enforced",
      detail: "es_* tools registered direct (codemode:false) with a permission action per tool; seat-scoped.",
      test: PLUGIN,
    },
    permissions: {
      support: "enforced",
      detail:
        "permission.evaluate + tool.execute.before enforce the write/read/shell policy; control files (incl. the engine-sealed evidence cache) denied; research seats get no host websearch/webfetch. Every agent shell runs under bubblewrap by seat kind (cached-web seats offline); seats are refused without it and the user's agents fall back to the weaker argv-aware text policy.",
      test: "packages/opencode/test/scoping.test.ts",
    },
    hooks: {
      support: "enforced",
      detail: "Claude hook schema bridged in-process; Stop is emulated after the turn (advisory for plain chat).",
      test: "packages/opencode/test/hooks.test.ts",
    },
    question: {
      support: "enforced",
      detail: "Session forms only humans can answer; primaries may ask, autonomous subagent seats may not.",
      test: "packages/opencode/test/scoping.test.ts",
    },
    subagents: {
      support: "enforced",
      detail:
        "Depth 1; hidden seats are unlisted but invocable by ID, and only from the seats allowed to spawn them. Factory seats are not offered Code Mode execute.",
      test: "packages/opencode/test/scoping.test.ts",
    },
    compaction: {
      support: "enforced",
      detail: "Session compaction injects the compact factory-state block for factory seats.",
      test: PLUGIN,
    },
    websearch: {
      support: "enforced",
      detail:
        "The configured provider registers as the host websearch; results are cached and citable. Research, scout and auditor seats are cached-only (es_research_search/fetch) under an offline (--unshare-net) sandbox; host web caching applies only in a project that already has .factory/, and the cache is engine-sealed (planted entries refused).",
      test: "packages/opencode/test/research.test.ts",
    },
    lsp: {
      support: "enforced",
      detail: "The lsp config key is read and served by our own manager (v2 accepts but does not run it).",
      test: "packages/opencode/test/lsp.test.ts",
    },
    panels: {
      support: "enforced",
      detail:
        "Four session.panel dashboards (factory, LSP, hooks, brainstorm), rendered by OpenTUI and refreshed on server changes; Esc/q closes a panel, f toggles fullscreen. The factory dashboard leads with the run headline, seats and research progress; a prompt-footer indicator shows the stage and the running seat.",
      test: "packages/opencode/test/panels.test.ts",
    },
    research: {
      support: "enforced",
      detail:
        "Engine-sealed cache (#52), fragment-level quote verifier (every ellipsis fragment >= 12 chars; code excerpts one contiguous span of at most 60 lines), auditor, providers and the websearch bridge.",
      test: "packages/core/test/research.test.ts",
    },
    brainstorm: {
      support: "enforced",
      detail:
        "Lens fan-out, record/score/complete tools, dedupe, rubric, shortlist with a forced outlier. Runs are id-scoped (the human's /brainstorm is the default run); the grill and the factory run callable brainstorms at depth 1 and get the shortlist as JSON.",
      test: "packages/opencode/test/brainstorm.test.ts",
    },
    harvest: {
      support: "enforced",
      detail: "Fail-closed SPDX detection, provenance profiles, policy-enforced matrix, clean-room specs.",
      test: "packages/opencode/test/harvest.test.ts",
    },
    design: {
      support: "enforced",
      detail:
        "Queereye interview, DTCG tokens, contrast gate, generated guide and drift check; phase-02 specs/webref/csf/tui renders and the phase-03 ledger bundle with its cite-gate receipt.",
      test: "packages/opencode/test/design.test.ts",
    },
    claims: {
      support: "enforced",
      detail:
        "Witnessed claims and dossiers: the evidence cache, dossiers and the claim ledger are tool-only; planted cache entries are refused (engine seal) and every VERIFIED quote and code span is re-checked against the bytes on disk.",
      test: "packages/core/test/research.test.ts",
    },
    audit: {
      support: "enforced",
      detail:
        "Code-audit pair: only auditor seats record verdicts; every finding is witnessed on disk (a hallucinated line is refused); quote fragments carry >= 12 chars each and a thesis pass needs a witnessed invariant; verdicts block (an opened phase audit holds the merge; audit.phase required also holds a missing one until it passes or a human dismisses it).",
      test: "packages/opencode/test/fires.test.ts",
    },
    scout: {
      support: "enforced",
      detail:
        "OSS scout: cached-only web under an offline (--unshare-net) sandbox, fail-closed license verdicts computed by core (adopt only for verified permissive licenses), OSV advisories cited.",
      test: "packages/opencode/test/fires.test.ts",
    },
  }),
  claude: [
    ...CAPABILITIES.map((capability) => ({
      capability,
      support: "unsupported" as const,
      detail: "The native Claude Code adapter (marketplace plugin, subagent frontmatter, hooks.json) ships in 1.1.",
    })),
  ],
  pi: [
    ...CAPABILITIES.map((capability) => ({
      capability,
      support: "unsupported" as const,
      detail: "The Pi extension (in-process tool_call blocking, sequential pi -p roles) ships in 1.2.",
    })),
  ],
  antigravity: [
    ...CAPABILITIES.map((capability) => ({
      capability,
      support: "unsupported" as const,
      detail: "The Antigravity adapter is rebuilt to the documented hook format and validated in CI in 1.3.",
    })),
  ],
}

export const capabilityRows = (harness: Harness): readonly CapabilityRow[] => CAPABILITY_MATRIX[harness]

/** ADVISORY/UNSUPPORTED rows (what the host cannot fully enforce). */
export const degradedRows = (harness: Harness): readonly CapabilityRow[] =>
  capabilityRows(harness).filter((row) => row.support !== "enforced")

/** ENFORCED rows without a proof reference: a contract error, checked by tests and docs. */
export const enforcedWithoutProof = (harness: Harness): readonly CapabilityRow[] =>
  capabilityRows(harness).filter((row) => row.support === "enforced" && !row.test)

/** The hook-level detail table (format compatibility per harness). */
export const hookCapabilities = (harness: Harness) => HOOK_CAPABILITIES[harness]
