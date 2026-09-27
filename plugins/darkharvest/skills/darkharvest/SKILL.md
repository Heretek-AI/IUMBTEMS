---
name: darkharvest
description: Product-level competitor teardown and clean-room harvest engine. Use when user wants to compete with or learn from existing products (e.g. Paseo, OpenChambers). Seed with inspiration URLs plus prompt, auto-expand to adjacents, clone-scan competitors, compare product plus code, and emit per-feature depend/vendor/clean-room/skip verdicts with SPDX attribution. Never copies GPL/AGPL code or UI assets.
---

# Darkharvest — Competitor Teardown & Clean-Room Harvest

Product-level teardown, not library scouting. `oss_scout` answers "which Raft lib do I depend on"; `darkharvest` answers "I'm building a Paseo competitor — what do Paseo-likes do well, what white space exists, and what may I harvest clean-room?"

## 1. Invocation

```bash
# Full dialectic teardown swarm (mock = zero token cost)
python3 runner/research_swarm.py --mode darkharvest --objective "Paseo-class agent harness competitor" --mock-claude

# Competitor fetch helper (read-only scan, allowlisted, capped)
python3 skills/darkharvest/scripts/harvest.py --repo https://github.com/owner/repo --show-context

# Via CLI
iumbtems darkharvest "Paseo-class agent harness competitor" --seeds https://github.com/a/b,https://github.com/c/d --max-repos 6 --mock-claude
```

In OpenCode V2: `iumbtems_darkharvest` tool. Slash: `/darkharvest <objective>`.
In Pi / OMP: `/darkharvest <objective>`. In Gemini: skill auto-activates on competitor-teardown intent.

## 2. Input contract (hybrid, merged)

1. Seeds: GitHub/GitLab URLs plus free-text prompt guidance. Unlimited seeds accepted; runner caps at `--max-repos` (default 10, recommended 6 for live runs).
2. Local baseline: full `brainstorm.py` domain model (tree + README + stack + TODOs + git log/status). Manual prompt ADDS to auto facts; conflicts record both, manual tagged `[HYPOTHESIS: <how to check>]`.
3. Gaps: open-loops + user wishlist combined.

## 3. Discovery (seed + expand)

- Seeds + 5–8 auto adjacents; direct competitors and adjacent inspirations SPLIT in the report.
- Similarity: hybrid pre-filter (README topics + feature keywords + dep overlap) then LLM rerank. Never LLM-vibe alone.
- Rank relevance first, stars second. Any stack allowed with porting-effort note. Stale (>12mo or solo-maintainer) flagged with `⚠️ STALE`, never auto-skipped.

## 4. Fetch & scan budgets (defaults, all flag-overridable)

- Defaults: `--max-repos 10 --depth 3 --per-repo-mb 100 --per-repo-timeout 300s`. Prefer `--max-repos 6 --depth 2` for live runs.
- `harvest.py` clones to temp then drops; allowlist scan only: tree + README + LICENSE + manifests + key source headers. Skips `.git, node_modules, dist, build, target, .next, .venv, .research`. Caps file count and bytes — full dump without caps will OOM and is banned.
- Closed or non-cloneable targets: try Firecrawl/docs fetch; when unavailable emit metadata-only row + `[NEGATIVE_KNOWLEDGE: <query>]`, never fail the run.
- Evidence: every matrix cell needs a SHA-256 cached source (`.research/sources/<sha256>.md`) with verbatim quote, or a `file://<path>#L<start>-L<end>` pointer. Unverified cells are purged to NEGATIVE_KNOWLEDGE.

## 5. Dialectic roles (one scope per competitor)

- Orchestrator decomposes the candidate list into one scope per competitor (DAG default, auction optional).
- Alpha (harvest proponent): what competitor does well + per-feature harvest proposals.
- Beta (red-team): license contamination, transitive bloat, CVE/takeover surface, staleness, both-ways missing (white space).
- Auditor: enforces strict-cells bar, warn-only gates surface as inline `⚠️ LICENSE/CVE/STALE` badges plus a risks section.

## 6. Legal guardrails (final)

- Permissive only (MIT / Apache-2.0 / BSD / ISC) may be `depend` or `vendor`.
- GPL / AGPL / unknown license → `clean-room-rebuild` spec only, never copy.
- Workflows clonable; copy-text, UI assets, brand never copied.
- Every vendored item emits an SPDX attribution block (license + upstream URL + files).

## 7. Output

- `.research/darkharvest_report.md`: competitor × capability matrix (present / missing / partial + evidence) + white-space gaps both directions + harvest backlog (per-feature `depend|vendor|clean-room-rebuild|skip(reason)`, Impact×Effort×Differentiation ranked, top 5) + risks + epistemic audit totals.
- Machine dossier: `.research/darkharvest_dossier.json` for rerun diffs (changed cells + new/removed candidates).
- Errors: structured log + NEGATIVE_KNOWLEDGE, never silent. Writes only under `.research/`.

## 8. Anti-patterns (hard bans)

- No auto-install of dependencies, no writes outside `.research/`.
- No pixel-level UX cloning, no GPL/AGPL vendoring.
- No parametric repo claims as `[VERIFIED]` — metadata suffices only for rank hints, never for harvest verdicts.
- No unbounded expansion: seeds + expansion must respect `--max-repos` and per-repo caps.
