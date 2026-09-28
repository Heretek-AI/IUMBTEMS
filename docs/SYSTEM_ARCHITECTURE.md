# IUMBTEMS (Epistemic Swarm): System Architecture & Technical Specification

## 1. Architectural Mandate & Epistemic Foundations

Modern large language models suffer from severe parametric leakage and sycophancy when executing deep research: models hallucinate nonexistent citations, conflate correlational claims with causal proofs, and smooth over scientific controversies to generate artificially unified prose.

**IUMBTEMS** — shipped as the **Epistemic Swarm** harness — is an autonomous research system that runs across seven agent harnesses (Claude Code, OpenCode V2, Pi, OMP, Gemini CLI, Codex CLI, AntiGravity) on their host-native agent backends, designed around one governing constraint: **Evidentiary Primacy over Parametric Intuition**.

### 1.1 Formal Evidentiary Taxonomy
Every factual assertion, quantitative metric, historical claim, or entity relationship produced by any agent in the harness must carry an explicit, machine-parseable epistemic classification:

| Tag | Formal Definition | Verification Requirement |
| :--- | :--- | :--- |
| `[VERIFIED: <SourceID/Hash>]` | Grounded directly in verbatim text retrieved during the active research session. | Content-addressed SHA-256 hash in `.research/sources/<sha256>.md` with exact substring match. |
| `[INFERRED: <Reasoning Chain>]` | Deductive or inductive conclusion derived logically from one or more verified facts. | Explicit list of parent verified claim IDs ($C_1, C_2 \implies C_{\text{inferred}}$) with step-by-step logic. |
| `[HYPOTHESIS: <Falsification Metric>]` | Plausible hypothesis, speculative mechanism, or open projection requiring testing. | Defined falsification criterion or empirical test that would disprove it. |
| `[NEGATIVE_KNOWLEDGE: <Topic/Query>]` | Explicit declaration that indexed search corpuses returned null or contradictory findings. | Record of search queries, parameters, and negative SERP summaries. |

### 1.2 Mathematical Epistemic Scoring Function
To prevent conversational drift and hallucination, each generated dossier is scored by an Epistemic Auditor using the following objective function:

$$\mathcal{E}(D) = \frac{\alpha \sum_{i=1}^{N_v} \mathcal{V}(c_i) + \beta \sum_{j=1}^{N_n} \mathcal{N}(k_j) - \gamma \sum_{k=1}^{N_u} \mathcal{U}(u_k)}{N_v + N_i + N_h + N_n + N_u}$$

Where:
- $N_v$: Number of verified assertions with valid source hashes.
- $\mathcal{V}(c_i)$: Verification weight proportional to source tier (Peer-reviewed DOI = 1.0, Technical Documentation = 0.8, Primary Press/Filings = 0.7, Secondary Media = 0.4).
- $N_n$: Count of explicit negative knowledge discoveries.
- $\mathcal{N}(k_j)$: Negative knowledge bonus factor ($\beta = 0.5$).
- $N_u$: Count of ungrounded or unverified factual claims.
- $\mathcal{U}(u_k)$: Severe hallucination penalty ($\gamma = 2.5$).
- $N_i, N_h$: Count of inferred claims and open hypotheses.

Any dossier where $\mathcal{E}(D) < 0.65$ is rejected by the auditor and re-queued for empirical retrieval.

---

## 2. Dialectic Multi-Agent Swarm

The system replaces single-threaded LLM research with a decentralized dialectic swarm executed locally on the invoking harness's native backend — `claude -p` on Claude Code, `opencode run` on OpenCode V2 (selected via `IUMBTEMS_HOST`):

```mermaid
flowchart TD
    User([User Research Goal]) --> Grilling[Phase 1: Socratic Grilling & Divergent Ideation]
    Grilling --> SettledFrontier[Settled Problem Frontier & Constraints]
    SettledFrontier --> Orchestrator[Phase 2: Swarm Orchestrator]
    
    Orchestrator -->|Decompose into Scopes| Scope1[Scope 1: Core Technical Mechanism]
    Orchestrator -->|Decompose into Scopes| Scope2[Scope 2: Economic & Scalability Constraints]
    Orchestrator -->|Decompose into Scopes| ScopeN[Scope N: Edge-Case Failure Modes]
    
    subgraph DialecticPair [Dialectic Execution Loop per Scope]
        Scope1 --> Alpha["Agent Alpha: The Proponent\n(Corroboration, Proofs, Primary Citations)"]
        Scope1 --> Beta["Agent Beta: The Adversary\n(Active Falsification, Counter-evidence, Edge Cases)"]
        
        Alpha -->|Writes| AlphaDossier[alpha_dossier.json + Cached Sources]
        Beta -->|Writes| BetaDossier[beta_dossier.json + Cached Sources]
        
        AlphaDossier --> Auditor[Phase 3: Epistemic Auditor]
        BetaDossier --> Auditor
        
        Auditor -->|Calculate Divergence & Verify Quotes| DivergenceMatrix[Divergence Matrix & Verification Pass]
        DivergenceMatrix --> ScopeSynthesis[Scope Synthesis Dossier]
    end
    
    ScopeSynthesis --> FinalSynthesis[Phase 4: Unified Master Synthesis & Executive Brief]
    FinalSynthesis --> Artifacts[.research/final_synthesis.md]
```

### 2.1 Swarm Roles & Postures
1. **Swarm Orchestrator (`orchestrator.md`)**:
   - Parses the initial problem statement and Socratic frontier.
   - Decomposes the inquiry into decoupled, orthogonal sub-scopes.
   - Emits `.research/manifest.json` containing the dependency DAG, sub-scope IDs, required source tiers, and hypothesis lists.

2. **Agent Alpha (The Proponent / Thesis - `agent_alpha_thesis.md`)**:
   - Posture: Constructive, empirical, affirmative.
   - Objective: Search for working implementations, benchmark results, mathematical proofs, peer-reviewed validations, and foundational literature.
   - Mandate: Every affirmative statement must point to an indexed primary source in `.research/sources/<sha256>.md`.

3. **Agent Beta (The Adversary / Antithesis - `agent_beta_antithesis.md`)**:
   - Posture: Hostile auditor, red-teamer, active falsifier.
   - Objective: Probe for failure states, retracted papers, replication crises, confounding variables, edge-case regressions, patent/licensing bottlenecks, and vendor lock-in.
   - Mandate: For every thesis claim in the scope, search deliberately for inverted queries (`"why [claim] fails"`, `"[claim] debunked"`, `"[claim] performance degradation"`).

4. **Epistemic Auditor (The Synthesizer - `epistemic_auditor.md`)**:
   - Posture: Neutral judge, citation verifier, and mathematical synthesizer.
   - Objective:
     1. Read `alpha_dossier.json` and `beta_dossier.json`.
     2. Query the local cache to verify that all cited quote strings exist verbatim in `.research/sources/<sha256>.md`.
     3. Calculate the **Divergence Score** $D_{\alpha\beta} \in [0, 1]$.
     4. Excise any assertion marked `[VERIFIED]` that fails hash verification.
     5. Synthesize conflicting viewpoints into an unvarnished balance sheet of empirical truths.

---

## 3. Filesystem IPC Protocol & State Machine

The swarm uses a zero-external-dependency filesystem IPC protocol rooted at `.research/` within the repository workspace.

```
.research/
├── manifest.json                  # Global session metadata, scope DAG, status
├── sources/                       # Content-addressed raw document cache
│   ├── a1b2c3d4...9f.json         # Metadata: URL, title, HTTP headers, timestamp, query
│   └── a1b2c3d4...9f.md           # Verbatim cleaned Markdown extraction
├── scratchpads/
│   ├── scope_01_mechanisms/
│   │   ├── manifest.json          # Scope status: PENDING | ALPHA_RUNNING | BETA_RUNNING | AUDITING | DONE
│   │   ├── alpha_dossier.json     # Proponent's structured empirical findings
│   │   ├── alpha_dossier.md       # Proponent's narrative brief
│   │   ├── beta_dossier.json      # Adversary's structured counter-evidence
│   │   ├── beta_dossier.md        # Adversary's narrative red-team report
│   │   ├── audit_report.json      # Quote verification log, divergence score, trimmed claims
│   │   └── scope_synthesis.md     # Synthesized consensus for Scope 01
│   └── scope_02_scalability/
│       └── ...
└── final_synthesis.md             # Master synthesized research report with epistemic provenance
```

### 3.1 State Transitions
```
[PENDING]
    │
    ▼ (Dispatch worker thread)
[ALPHA_DISPATCHED] ──┐
    │                 │ (Concurrent execution)
    ▼                 ▼
[ALPHA_RUNNING]    [BETA_DISPATCHED]
    │                 │
    ▼                 ▼
[ALPHA_COMPLETE]   [BETA_RUNNING]
    │                 │
    └────────┬────────┘
             ▼
      [BETA_COMPLETE]
             │
             ▼ (Spawn Epistemic Auditor)
        [AUDITING]
             │ (Verify hashes, check quotes, score divergence)
             ▼
        [SYNTHESIZING]
             │
             ▼
        [COMPLETE]
```

### 3.2 Scratchpad Schema Definitions

#### `manifest.json` (Global Session)
```json
{
  "session_id": "epistemic-swarm-2026-09-26-001",
  "objective": "Evaluate feasibility of sub-millisecond zero-knowledge state updates on L1 rollups",
  "status": "RUNNING",
  "created_at": "2026-09-26T12:00:00Z",
  "scopes": [
    {
      "scope_id": "scope_01_prover_latency",
      "title": "Hardware Prover Latency & Memory Footprint",
      "dependencies": [],
      "status": "IN_PROGRESS"
    },
    {
      "scope_id": "scope_02_recursion_overhead",
      "title": "Recursive SNARK/STARK Verification Overheads",
      "dependencies": ["scope_01_prover_latency"],
      "status": "PENDING"
    }
  ],
  "telemetry": {
    "total_sources_cached": 42,
    "total_claims_verified": 118,
    "unverified_claims_pruned": 7
  }
}
```

#### `alpha_dossier.json` / `beta_dossier.json`
```json
{
  "agent": "Agent Alpha (Thesis)",
  "scope_id": "scope_01_prover_latency",
  "timestamp": "2026-09-26T12:05:30Z",
  "claims": [
    {
      "claim_id": "C-01-001",
      "tag": "VERIFIED",
      "statement": "FPGA-accelerated Poseidon hash provers achieve sub-200ms witness generation on 2^20 constraints.",
      "source_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "source_url": "https://arxiv.org/abs/2405.xxxxx",
      "verbatim_quote": "Our FPGA pipeline executes the Poseidon round constraints in 184ms with a peak memory bandwidth of 45 GB/s."
    }
  ],
  "negative_knowledge": [
    {
      "query": "GPU Poseidon provers < 50ms latency memory bandwidth constraints",
      "finding": "No published benchmark confirms sub-50ms prover latency under consumer PCIe 4.0 bandwidth limitations."
    }
  ]
}
```

---

## 4. Multi-Tier Search & Content Caching Pipeline

The harness integrates four functional tooling layers:

```mermaid
flowchart LR
    subgraph Discovery [Tier 1: Discovery & SERP]
        SearXNG["SearXNG (Metasearch)"]
        Brave["Brave Search API"]
    end
    
    subgraph Extraction [Tier 2: Content Extraction]
        Firecrawl["Firecrawl MCP\n(Clean Markdown, JS Rendering)"]
        Fetch["Local Fetch & Parser"]
    end
    
    subgraph Domain [Tier 3: Domain Verification]
        Scholar["arXiv / Semantic Scholar MCP"]
        DOI["DOI & CrossRef Resolver"]
    end
    
    subgraph Storage [Tier 4: Caching & Audit]
        Hasher["SHA-256 Hasher\n(.research/sources/<hash>.md)"]
        Verifier["Quote Substring Matcher"]
    end
    
    Discovery --> Extraction
    Extraction --> Hasher
    Domain --> Hasher
    Hasher --> Verifier
```

### 4.1 Content-Addressed Caching
Every web page, paper abstract, or document retrieved is immediately ingested by `skills/research_cache/hasher.py`:
1. Strips HTML boilerplate and scripts, converting to clean GitHub-Flavored Markdown.
2. Computes the SHA-256 digest of the normalized text content.
3. Saves `.research/sources/<sha256>.md` and `.research/sources/<sha256>.json` containing retrieval provenance (timestamp, search query, original URL, response code, and HTTP headers).
4. The agent is provided with the `<sha256>` hash.
5. In downstream synthesis, when the agent cites `[VERIFIED: sha256]`, the Epistemic Auditor verifies that `verbatim_quote` is an exact substring within `.research/sources/<sha256>.md`. If substring lookup fails, the claim is rejected.

---

## 5. Socratic Grilling & Divergent-to-Convergent Balance

To prevent prematurely narrowing the scope of research onto biased search terms, the harness implements a mandatory two-phase cognitive workflow:

### Phase 1: Divergent Socratic Exploration (`skills/grilling`)
Based on Matt Pocock's design tree and frontier methodology:
1. **Assumption Inversion**: The agent inverts every default assumption (e.g., *"What if low latency is unnecessary if pipelined throughput is infinite?"*).
2. **Design Tree Mapping**: The inquiry is modeled as a decision DAG where every leaf node is an open prerequisite.
3. **The Frontier**: Questions whose prerequisites are settled are posed in systematic rounds.
4. **Factual Delegation**: When a question depends on an unknown empirical fact, the agent dispatches a research subagent to resolve it autonomously without interrogating the user.
5. **Decisional Resolution**: When a question involves trade-offs or priorities, the agent asks the user and locks the answer into the frontier.

### Phase 2: Convergent Dialectic Falsification
Once the frontier is resolved, the Orchestrator freezes the problem space and transitions to the dialectic multi-agent swarm for empirical retrieval, falsification, and epistemic auditing.

---

## 6. Multi-Harness Runtime & Backends

The harness runs on seven targets from one canonical source. `skills/*` + `prompts/*` are the single source of truth; `runner/mcp_server.py` is the canonical programmatic surface; every other target carries only generated thin stubs.

| Layer | Location |
| :--- | :--- |
| Canonical prose & scripts | `skills/*/SKILL.md`, `prompts/*.md` |
| Canonical programmatic surface | `runner/mcp_server.py` (stdio MCP, `iumbtems_*` tools) |
| Generated stubs (never hand-edit) | `plugins/{antigravity,gemini,codex}/skills/**`, `.agents/skills/**` |
| Generated modular copies | `plugins/{research-cache,socratic-grilling,darkharvest,factory}/skills/**` |
| Generator / CI gate | `scripts/build_adapters.py` (`--check` fails CI on drift) |
| OpenCode V2 plugin | `plugins/opencode/index.js` (transform domains: tool/command/agent/skill) |

### 6.1 Agent Runtime Resolution

Agent processes are spawned on the **host-native backend** by default, resolved in this precedence order:

1. Explicit override (`--backend` on the CLI, `backend` argument on the MCP tools)
2. Environment (`IUMBTEMS_BACKEND_<ROLE>`, `IUMBTEMS_MODEL_<ROLE>`)
3. Config (`.research/config.json` → `agents.<role>.backend` / `agents.<role>.model`)
4. Host-native default (`opencode run` when `IUMBTEMS_HOST=opencode`, else `claude -p`)

### 6.2 Workspace Resolution and Spawn Semantics

The evidence workspace is resolved in this order:

1. Explicit `base_dir` / `dir` argument
2. `IUMBTEMS_PROJECT_DIR` (set by the OpenCode plugin to the session workspace — the V2 web UI targets worktrees)
3. Process cwd (manual CLI runs) — the definitive path

Spawned agents run with their OS cwd **and** `PWD` set to the project root, because some harnesses (OpenCode) resolve their project root from `$PWD` rather than the OS cwd. Both are kept consistent so relative `.research/...` paths and absolute scratchpad paths agree; a mismatch sends evidence into a different tree than the auditor reads.

### 6.2.1 Linked Worktrees and the `external_directory` Trap

`git worktree add` creates a checkout whose **git common dir lives in another directory tree** (the primary clone). Some harnesses derive their project root from `git rev-parse --git-common-dir` / `--show-toplevel` and from `$PWD`, so a spawned agent can consider the primary clone its workspace while the runner reads the worktree. When that happens the runner's absolute scratchpad path is classified `external_directory` and **auto-rejected**, so no dossier is persisted.

Three defenses:

1. Spawn with `cwd` and `PWD` set to the resolved project root (see 6.2), so the child's workspace matches the runner's.
2. Pass `--auto` to `opencode run` (auto-approve permissions that are not explicitly denied), so an `external_directory` write is approved rather than silently dropped. Disable with `IUMBTEMS_OPENCODE_AUTO=0`.
3. On a missing dossier, report the searched path, the spawn cwd/`PWD`, `IUMBTEMS_PROJECT_DIR`, and any copy found in an alternate workspace (`PWD` / git common dir parent) — a workspace mismatch is then self-diagnosing instead of a bare `dossier not found`.

### 6.2.2 Manifest Concurrency

`.research/manifest.json` is written by multiple tools/processes. It is now per mode (`manifest.<mode>.json`; the default/research flow keeps `manifest.json`) so concurrent `brainstorm` and `darkharvest` runs cannot clobber each other's scope DAG. Every manifest write uses a **unique** temp file plus `os.replace`, under an `fcntl` advisory lock at `.research/.manifest.lock`, and read-modify-write helpers (`update_session_status`, `set_scopes`, `record_agent_completion`, `update_scope_status`) hold that lock across the whole operation so concurrent writers cannot lose updates. Mode-agnostic readers resolve with `state_machine.find_any_manifest`.

### 6.2.3 Dossier Contract and Derived Status

Each dialectic agent is given an explicit output contract in its prompt: the absolute path of **its** dossier (`alpha_dossier.json` / `beta_dossier.json`), and an instruction never to write the runner-owned `manifest.json`. The loader (`_load_agent_dossier`) resolves the canonical path first, then a bounded set of mode aliases (`brainstorm` → `brainstorm_dossier.json`) and the scope manifest's `outputs` list, normalizing any hit to the canonical filename (tagged `renamed_from`).

Scope completion is **derived from artifacts on disk** (`ResearchStateMachine.reconcile_scope_status`): `alpha_completed`/`beta_completed` reflect whether the dossier files exist, and the status is recomputed from them. Because agents can write anywhere in the workspace, a stored boolean is not trusted — a hand-edited or agent-written `manifest.json` claiming `DOSSIERS_READY` is corrected on the next reconcile.

### 6.3 Grounding, Retrieval Telemetry & Scoring Contracts

**Retrieval telemetry.** Agents invoke the retrieval skills as subprocesses, so their activity is only visible through a shared append-only log: `search.py`, `hasher.py`, and `webcache.py` append to `.research/retrieval.jsonl` (`query` / `cache` events). Every run prints and records a one-line banner — `retrieval: N queries, M results, K cached` — which makes an ungrounded run obvious instead of inferring it from an empty `sources/`. The runner points agent subprocesses at the workspace via `IUMBTEMS_RESEARCH_DIR`.

**Scoring contracts are per mode.** `compute_epistemic_score_from_claims` (research/audit/scout/darkharvest) credits only quote-verified claims. `compute_brainstorm_score_from_claims` credits *well-formed speculation* — hypotheses carrying a `falsification` criterion, inferences naming their parents — with the usual negative-knowledge bonus, penalizing only rejected `VERIFIED` claims. Brainstorm therefore does not fail a mode whose deliverable is speculative by design.

**Tag counting.** Only structured claim objects (`affirmative_claims`, `falsification_claims`, `inferred_implications`, `hypotheses`, `negative_knowledge`) that carry `source_hash` **and** `verbatim_quote` can be verified. Markdown `[VERIFIED: …]` strings in narrative prose are not counted, and `[VERIFIED: NO …]` honest-negatives are narrative signals rather than verified citations.

**The summary must match the audit.** The master synthesis computes scope totals *before* writing its executive summary and warns (`WARNING_LOW_GROUNDING`) when nothing was verified, instead of asserting that every statement is backed by the source cache.

### 6.3 Configuration Merge & Migration

`load_config` deep-merges the `agents` block one role/key at a time over `DEFAULT_CONFIG`. Configs written before 0.7.6 that pinned `agents.<role>.backend = ["claude", "-p"]` are migrated to `null` on load (unless the top-level `backend` is an explicit `"claude"`), and the migration is persisted by the CLI and `iumbtems_config`.

---

## 7. Living Dossiers (Claim Degradation)

Dossiers are immutable; currency is tracked separately.

- `iumbtems_reindex_claims` rebuilds the derived `claims.sqlite` index from the `.research` flat files (flat files remain the source of truth).
- `iumbtems_report_retraction` records a `RETRACTED`/`REVISED` event against a cached source hash.
- `iumbtems_check_staleness` runs one degradation pass: it joins claims against retraction events, writes `.research/ledger/claim_status.json`, queues affected scopes into `.research/requeue.json`, and never mutates dossiers. Dependent `[VERIFIED]` claims degrade to `STALE` / `SUSPECT`.

---

## 8. Proof-Carrying Research Briefs (PCRB)

A brief is a self-contained, HMAC-signed bundle for external consumers who must not trust the producing model:

- `iumbtems_export_brief` bundles the synthesis, the claim set, per-claim quote witnesses, and the **full text** of every cited source.
- `iumbtems_verify_brief` re-checks manifest integrity, the HMAC signature, and every quote against the bundled sources, with exit-fail semantics.
- The signing key comes from `IUMBTEMS_PCRB_KEY` (or an explicit `key` / `key_file`).

---

## 9. Regulated Domain Packs

`iumbtems_set_domain_pack` swaps in a stricter epistemic constitution (`biopharma`, `quant`, `legal`), adjusting the auditor's acceptance threshold and retraction policy for the session. Pack definitions live in `config/domain_packs/<id>.json`.

---

## 10. Factory & Self-Improvement Loops

The factory is the delivery-side loop that consumes research output:

- Run state lives in `<project>/.factory/`; phase output in `<project>/.roadmap/`; evidence in `.research/`.
- Phase flow: grill-gated brief → programmer spawn (one phase per spawn) → dual QA (`qa-a` functional, `qa-b` adversarial; 3 failures escalate) → explicit sign-off.
- `iumbtems_factory` (and `iumbtems factory <init|phase-add|qa-record|expansion|stop>`) drives state; `.factory/STOP` is a kill-file honored by expansion loops.

