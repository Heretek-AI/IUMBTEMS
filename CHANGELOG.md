# Changelog

## 1.1.0 — unreleased

"Dialectic Restoration" (#20) brings back the best of the 0.7 research
harness, ported to TypeScript inside the 1.x trust model. Milestones: M1
foundation (#21), M2 seats (#22), M3 rigor (#23).

**Breaking, no migration.** The frontier schema moves from 1.0 to 1.1. 1.0.x
frontiers are **not** migrated: a 1.0 `.factory/frontier.json` is refused with
the fresh-run instruction, so 1.1 needs fresh runs.

### M1: foundation (#21)
- **Security: cached evidence is tool-only.** Before this release, a research
  or factory seat could write `.factory/research/sources/<sha256>.md` with made-up
  text. The cache's only tamper check is "content hashes to the file name",
  which a forgery passes by construction, so the seat could then cite its own
  text as VERIFIED. The source cache, `coverage.json`, the research dossier,
  the signed brief and `.factory/claims/` are now control files: no agent may
  write them, and seats may not mention them from the shell.
- **Claim stack** (`packages/core/src/claims/`):
  - Claims have content-hash ids and both an epistemic tag and a lifecycle
    status.
  - The witness re-checks every VERIFIED quote against the cache, and every
    code location (file, line range and verbatim excerpt) against the file on
    disk.
  - Dossiers refuse any claim whose witness fails.
    `es_research_complete` now writes `.factory/research/dossier.json`.
  - Retracted sources make their claims STALE, and revised ones SUSPECT
    (`es research retract`, human-only).
  - `ClaimStore` indexes the dossiers.
  - A deterministic, lexicographic ranker orders rival claims and dossiers.
- **Proof-carrying research brief.** `es research export` writes a signed
  `.factory/research/brief.pcrb.json`, and `es research verify-brief` checks
  source identity, the manifest (it notices deleted members), the signature
  and the quotes.
- **Design tree (frontier 1.1).** Nodes gain `kind` (decision or fact),
  `recommended` and `round`. `es_frontier_write` checks each save against the
  previous one:
  - no deleted nodes;
  - no silent edits to settled answers (reopen first);
  - no going back a round.

  It also returns the next round's questions. `<factory-state>` gains a tree
  progress line, and the factory panel shows it too.
- **Facts versus decisions.** The grill settles repo facts itself and defers
  web facts as `kind: "fact"` nodes. `es_research_complete` refuses until
  every deferred fact is answered on a grounded claim line marked
  `(fact:<id>)`.
- **Prompts.** `grill` goes from v1 to v2: frontier rounds, round-1 premise
  inversion, the freeze procedure. `factory` goes from v3 to v4: deferred
  facts and research depth. The 1.0.5 no-run routing is kept.
- **Search as policy.** Research seats no longer get the host `websearch`
  or `webfetch` tools; every web fact goes through `es_research_search` and
  `es_research_fetch`. Fetches are keyed by canonical URL (ported exactly from
  the 0.7 webcache), and a fresh full-page snapshot is served from the cache.
  The freshness window is 7 days, or 30 for documentation hosts;
  `refresh: true` refetches.
- **Configure.**
  - New `research.depth` (1–4, advisory), `research.cacheTtlDays`,
    `research.searchTimeoutS` and `research.searxngUrl` (global only).
  - `es config set <key> <value> [--global]` is human-only, validated against
    the schema and confirmed with a typed code. It refuses to accept drift in
    other control files, and it re-pins the project config.
- The research auditor's `ClaimStatus` type is renamed `ClaimAuditStatus`.

### M2: seats (#22)
- **Breaking:** the factory state goes from version 1 to version 2. 1.0.x run
  states are refused with the fresh-run instruction; there is no migration.
- **Code-audit pair.** The hidden `es-auditor-thesis` seat maps invariants and
  the hidden `es-auditor-antithesis` seat red-teams them with CWE ids.
  - **The line-pointer law:** `es_audit_verdict` checks every finding against
    the file on disk (it must exist inside the target, the lines must be in
    range, the excerpt must be verbatim). A hallucinated reference refuses the
    whole verdict.
  - **Audits block.** A phase audit holds the merge until it passes, and a
    failed one sends the phase back to the programmer. An open or failed path
    audit refuses the next stage transition.
  - Splits go to the manager: `es_tiebreak` gains `audit`. Only a human can
    dismiss an audit (`es audit dismiss`).
  - Each round writes `.factory/audits/<id>/{records,dossier}.json` and a
    deterministic `REPORT.md`.
- **OSS scout (`/scout`).** The scout plans, discovers (sharing darkharvest's
  search), scans (darkharvest's fail-closed license detection), checks OSV
  advisories (the responses are cached and cited) and records witnessed
  assessments. Core recomputes every verdict, keeping `adopt` only for a
  verified, whitelisted, permissive license, flags severe advisories, ranks the
  candidates and writes `.factory/scout/REPORT.md`. Adoption stays a human
  decision.
- **CLI:** `es audit <target>` (plus `show` and `dismiss`), and
  `es scout "<feature>"` (plus `show`). Both are headless, honour STOP and the
  spend ceiling, and, with no run, start one at a terminal with `--max-usd N`.
  Agents cannot launch them from a shell.
- **A halted run now stops every seat tool except `es_status`.** Previously a
  seat's own `es_*` tools kept running after a halt.
- **Fires.** The deterministic `audit-fires` and `scout-fires` suites run on
  the real host in CI. The same graders score the nightly model runs
  (`evals/cases/*-fires.json`; cases can now seed files).
- New ENFORCED capability rows: `claims`, `audit`, `scout`. Prompts:
  `auditor-thesis` and `auditor-antithesis` v1, `scout` v1, `factory` v4 → v5,
  `manager` v1 → v2.
- When research completes, pruning the cache keeps every source that any
  dossier cites.

## 1.0.5 — 2026-10-07

Run-lifecycle gaps from dogfooding 1.0.4 (#19):

- `es … --help` is now side-effect free on every subcommand: it prints usage
  and exits 0 without minting runs or writing files. Previously
  `es factory begin --help` minted a phantom `run-…` GRILL state.
- `/factory` with no run no longer dead-ends the agent: the command itself
  replies "No factory run here yet — run /grill first."
- A missing or unsettled frontier now points at the recording step instead of
  a bare "missing artifact" error: `approvalSubject` and
  `es_request_approval` direct the human to `/grill`
  (or `es factory begin` + grill flow). No new write path: agents stay
  deny-write on `frontier.json`, approvals stay human-only.
- `factory` prompt v2 → v3: stop and route to `/grill` when `<factory-state>`
  reports no run.

## 1.0.4 — 2026-10-07

The 1.0 cutover replaces the Python research harness with the TypeScript
**Epistemic Swarm** monorepo (`@heretek-ai/es-core`, `@heretek-ai/es-cli`,
`@heretek-ai/epistemic-swarm`). This is a **breaking, one-way** change:

- **No migration.** Python-era `.research/` and `.factory/` state is **not**
  imported. The legacy harness is preserved at the `legacy-final` tag
  (v0.7.25) and receives **no further support** after cutover.
- The product is now an **AI build factory**: grill → research → spec → build
  ⇄ QA → release, enforced by a code state machine, hash-pinned gates, a
  signed audit chain, a mandatory spend ceiling and a `.factory/STOP` kill
  switch. Approvals, waivers and trust are human-only.
- Delivery is **OpenCode v2 first**; the Claude Code (1.1), Pi (1.2) and
  Antigravity (1.3) adapters follow, each publishing capability-matrix rows
  with smoke tests.
- Platform: Linux, Node ≥ 22 or Bun. No Python.
- Darkharvest licence verdicts are fail-closed: permissive only on a full-text
  SPDX template match, every licence file and SPDX header counted, harvested
  content never executed and confined to the project for agents.
- Packages publish from `bun pm pack` tarballs (real versions, no `workspace:`)
  that `scripts/pack-smoke.sh` installs and runs first.
