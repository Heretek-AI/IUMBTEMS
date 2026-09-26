---
name: brainstorming
description: Lateral creative brainstorming and divergent ideation skill. Use when exploring what-if features, lateral architectures, speculative product directions, or when user invokes /brainstorming. Generates novel feature vectors, paradigm inversions, and falsifiable spike hypotheses instead of bug fixes.
---

# Creative Brainstorming & Lateral Ideation Engine

Trigger with `/brainstorming <ambiguous-prompt>` (alias `/brainstorm`).
This skill inverts the default coding-assistant bias (bug fixes, incremental
refactors) and forces divergent, speculative, lateral thinking.

## 1. Invocation

```bash
# Interactive / single-pass brainstorm (no LLM tokens required for scaffolding)
python3 skills/brainstorming/scripts/brainstorm.py --objective "Where do we go from here?" --show-context

# Full dialectic brainstorm swarm (mock = zero token cost)
python3 runner/research_swarm.py --mode brainstorm --objective "What-if gameplay mechanics for HarborTown" --mock-claude

# Live swarm (invokes Claude Code headless sessions)
python3 runner/research_swarm.py --mode brainstorm --objective "<objective>"

# Via CLI
iumbtems brainstorm "Where do we go from here?"
iumbtems brainstorm "What-if mechanics for HarborTown" --mock-claude
```

In Pi / OMP: `/brainstorming <prompt>`. In OpenCode: `iumbtems_brainstorm` tool.
In Gemini / AntiGravity: skill auto-activates on speculative intent.
In Codex: `$brainstorming <prompt>`.

## 2. Dynamic Context Ingestion (read-only, capped)

Before ideating, the agent MUST ingest (never exceed ~30% of context budget):

1. Project tree: `glob` depth 3 + `README.md`, `AGENTS.md`/`GEMINI.md`/`SYSTEM.md` if present.
2. Architecture docs: `docs/SYSTEM_ARCHITECTURE.md`, `docs/*`, `prompts/*.md` domain hints.
3. Recent history: `git log --oneline -20`, `git status --short`.
4. Open loops: `grep -r "TODO|FIXME|HACK|XXX" --include="*.py" --include="*.ts" --include="*.js" .`
5. Stack fingerprint: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements*.txt`.

Record the result as `domain_model.json`:

```json
{
  "domain": "<game mechanics|data pipeline|compiler toolchain|multi-agent runtime|...>",
  "entities": ["<core entity>"],
  "constraints": ["<hard constraint>"],
  "stack": ["<detected dependency>"],
  "open_loops": ["<TODO>"]
}
```

If context budget is < 40% free, fall back to single-pass mode: skip git
history and full tree, use only README + top-level listing.

## 3. Dialectical Divergence (mandatory)

Run Thesis / Radical Antithesis / Synthesis. Do NOT produce bug-fix lists.

### Thesis — Wild Proponent
Propose the most ambitious affirmative vision: 10x features, new mechanics,
new workflows. No feasibility filter.

### Radical Antithesis — Paradigm Inverter
Invert every Thesis premise:
- *Inversion*: What if the core objective is obsolete? What replaces it?
- *Subtraction*: What if we remove the most "essential" component?
- *Adjacent domains*: What would biology / compilers / markets / games do here?
- *Cutting-edge OSS*: What new dependency, protocol, or model unlocks a shortcut?
- *Counter-intuition*: What deliberately "wrong" optimization wins?

### Synthesis — Portfolio Builder
Output exactly:

1. **Novel Feature Vectors (3-5)**: high-impact "what-if" mechanics or workflows.
   Each: name, one-line pitch, why now, falsification probe.
2. **Lateral Architectural Moves (2-3)**: alternative paradigms, OSS swaps,
   counter-intuitive optimizations. Each: current vs. lateral, trade-off, migration spike.
3. **Experimental Hypotheses (2-3)**: rapid spikes (< 1 day each). Each MUST carry
   `[HYPOTHESIS: <measurable falsification criterion>]`.

## 4. Execution Pipeline & Calibration

| Parameter | Brainstorm value | Research/audit value |
|---|---|---|
| `temperature` | 1.0 – 1.2 | 0.2 – 0.4 |
| `top_p` | 0.92 | 0.9 |
| `max_iterations` | 1 – 2 | 2 – 4 |
| `divergence` | rewarded (target > 0.6) | audited (threshold 0.75) |
| `epistemic bar` | `[HYPOTHESIS]` required, `[VERIFIED]` optional | `[VERIFIED]` required |

Topology: isolated subagent by default. With `--swarm`, dispatch via
`runner/research_swarm.py --mode brainstorm` (Alpha=warm wild proponent,
Beta=radical inverter, Auditor=divergence-rewarding synthesizer).
Write output ONLY to `.research/brainstorm_<timestamp>.md` plus
`scratchpads/brainstorm_<slug>/domain_model.json`.

## 5. Anti-Patterns (hard bans)

- No bug-fix or incremental-refactor lists as "ideas".
- No sycophantic convergence ("all options are great").
- No parametric citations presented as `[VERIFIED]` — speculation MUST be
  tagged `[HYPOTHESIS: <test>]` or `[INFERRED: <parents>]`.
- No writes outside `.research/`.
