# System architecture

IUMBTEMS ("Epistemic Swarm" is the product name) is an AI build factory for
OpenCode v2: a human grills an idea, the factory researches it with cited
evidence, writes a spec, builds it in gated phases under dual QA and a
code-audit pair, then opens a PR a human merges. Two ideas hold the system
together: **every AI claim is evidence-tagged and mechanically checked**, and
**every irreversible step is human-only or code-enforced**.

This file is hand-maintained. `docs/SCHEMAS.md`, `docs/CAPABILITIES.md` and
`docs/CONFIG.md` are generated from source (`bun run docs:gen`).

## 1. The factory pipeline

```
GRILL ──▶ RESEARCH ──▶ SPEC ──▶ BUILD ⇄ QA ──▶ RELEASE ──▶ DONE
   │           │           │        │  │          │
   │           │           │        │  └─ phase audit pair (any stage, blocking)
   │           │           │        └─ dual QA verdicts (split → manager tiebreak)
   │           │           └─ spec approval (human, signed)
   │           └─ research audit (grounding + deferred facts + domain pack)
   └─ design tree (frontier.json): question rounds, facts deferred to research
```

The state machine lives in `packages/core/src/factory/machine.ts`; every
transition re-checks the artifacts' hashes and refuses out-of-order steps.
Phases run in their own git worktrees (`factory/<run>/integration` receives
passed phases; the base branch is never touched by the factory).

Failure policy: three failed QA attempts, one replan, two more attempts, then
the run halts. `.factory/STOP` halts every seat tool (except `es_status` when
halted by spend/runtime); resuming is human-only. The spend ceiling is
mandatory and raising it is a human act.

## 2. Seats

Seats are what the trust policy reasons about; the registry is
`packages/core/src/agents/registry.ts` and prompts live in
`packages/core/assets/prompts/`.

| Seat(s) | Kind | May write | Notes |
| :--- | :--- | :--- | :--- |
| `factory` | primary | factory docs | drives stages, opens audits |
| `grill` | primary | frontier (via tool) | design tree rounds; facts deferred to research |
| `manager` | subagent | factory docs | specs, replans, QA and audit tiebreaks |
| `programmer` | subagent | its phase worktree | red-test-first completion |
| `qa-functional`, `qa-adversarial` | subagents | nothing | verdicts only, blocking |
| `auditor-thesis`, `auditor-antithesis` | subagents | nothing | line-witnessed findings, blocking |
| `research-alpha`, `research-beta` | subagents | research notes | web facts via cached `es_research_*` only |
| `harvester` | primary | harvest notes | fail-closed licence policy for depend/vendor |
| `scout` | primary | scout notes | core computes adoption verdicts |
| `brainstormer`, `brainstorm-lens` (×8), `brainstorm-critic` | subagents | brainstorm notes | lens fan-out, dedupe, rubric |
| `designer` | primary | design notes | queereye interview → tokens → phase 02/03 artifacts |

Per-seat path scopes and the web policy are in
`packages/core/src/trust/policy.ts` and enforced again on the real host in
`packages/opencode/src/policy.ts` (`permission.evaluate` + `tool.execute.before`).

## 3. Evidence: the claim stack

```
source cache (sha256-named bytes) ──▶ quote verifier ──▶ VERIFIED claims
                                                     │
dossiers (research · code-audit · oss-scout)  ◀──────┤
  ├─ witness re-checks quotes + code locations on load
  ├─ retraction ledger degrades claims (STALE/SUSPECT), zero-tolerance packs reject
  └─ lexicographic ranker orders rival claims and dossiers

signed brief (PCRB export) ──▶ es research verify-brief
domain packs (quant · biopharma · legal) ──▶ banned domains, mandatory tags,
  tier-weighted E(D), accept threshold at completeResearch
```

- Every claim carries one tag: `VERIFIED` (source + verbatim quote, or a code
  location), `INFERRED` (parents + reasoning), `HYPOTHESIS` (falsification) or
  `NEGATIVE_KNOWLEDGE` (query + finding).
- Claims/dossiers live under `.factory/`: `research/`, `claims/`, `audits/`,
  `scout/`, `harvest/`. All are control files: agents may only write them
  through `es_*` tools; hand-edits are refused and hash-checked at gates.
- The design tree (`frontier.json`) is the same shape for humans: nodes are
  decisions or deferred facts, saves are diff-checked (no deletions, no silent
  edits, no round regress), and the tree is the single source for the idea.

## 4. Trust model (non-negotiable invariants)

1. **Approvals, waivers, trust and resume are human-only** — TTY/TUI dialogs,
   signed and hash-bound; agents may request (`es_request_approval`) but never
   grant.
2. **Control files are deny-write for every agent**: gates, config, frontier,
   approvals, waivers, runtime state, the research evidence, claim ledger,
   audit records, scout and harvest state, and the design artifacts
   (`trust/control.ts`).
3. **Gate command sets are trust-pinned by hash**; untrusted commands never run.
4. **Every `.factory/` write is atomic and lock-protected** (`util/fs.ts`).
5. **Search as policy**: research seats, auditor seats, scout and harvester get
   web facts only through the cached, citable `es_research_*` tools.
6. **Generated files are never hand-edited**; `docs:check` fails on drift
   (schemas, capability proofs, config docs, and the prompt/skill/registry
   asset drift checker with its canary).
7. **The factory never pushes the base branch**; release opens a draft PR a
   human merges, and publish runs through OIDC trusted publishing.

## 5. Evaluations

- **Merge-blocking (deterministic):** five fire suites on the real in-process
  host — `grill-fires`, `factory-gate`, `darkharvest-fires`, `audit-fires`,
  `scout-fires` (`packages/opencode/test/fires*.test.ts`), plus the drift
  canary (`packages/core/test/drift.test.ts`).
- **Nightly (model-backed, cost-capped):** `evals/cases/*.json` run against a
  real model with the same graders (`bun run evals`).
- **Capability matrix:** every ENFORCED row names a test or spike that exists;
  `docs:check` and `capabilities.test.ts` fail otherwise.

## 6. Repository map

| Path | Contents |
| :--- | :--- |
| `packages/core/src/factory/` | stage machine, state, tree, summary |
| `packages/core/src/claims/` | claims, witness, dossiers, retraction, ranker, brief, domain packs |
| `packages/core/src/codeaudit/`, `scout/`, `harvest/`, `queereye/`, `brainstorm/`, `research/` | the seat domains |
| `packages/core/src/trust/`, `approval/`, `audit/`, `gates/` | the enforcement layers |
| `packages/core/assets/` | prompts, skills, domain packs (shipped with `es-core`) |
| `packages/opencode/src/` | plugin: agents, policy, tools, commands, panels |
| `packages/cli/src/` | `es` CLI, human-only commands, headless jobs |
| `packages/testkit/` | real-host `boot`, scripted fake model |

The queereye designer domain is `packages/core/src/queereye/`; the
`.factory/design/` tree holds `interview.json`, `tokens.*`, `probes.json`,
`STYLE_GUIDE.md`, `components/`, `webref.json`, `csf.json`, `tui-notes.md`
and the phase-03 `harvest.json` ledger.
