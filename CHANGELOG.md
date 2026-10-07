# Changelog

## 1.1.2 (unreleased)

Proof-of-work follow-up to the 1.1.1 security release (#54).

- **`audit.phase: optional|required` (#33).** Default `optional` keeps 1.1.x
  behaviour; `es config set audit.phase required` refuses merges of QA-passed
  phases without a passed or human-dismissed audit. The factory prompt (v6)
  opens the phase audit as the phase enters QA when required.
- **`@@CHILD` testkit directive (#34).** Delegated child sessions receive
  scripted tool calls through the parent's subagent prompt; the parent's
  `@@CALL` script no longer consumes them.
- **Pipeline A.** Deterministic real-host factory loop (grill → research with
  a deferred fact → spec → two phases with build/QA/audit, a QA fail and a
  STOP/resume → release → DONE), with required audits reached through
  delegation; merge-blocking in CI.
- **B eval cases.** research, thesis auditor, programmer, adversarial QA and
  designer cases with staged fixtures and a localhost fixture server
  (`{{SERVE_URL}}`); validated locally, scored nightly.
- **Signed sidecars.** `.factory/runtime/state.json` carries an HMAC sidecar
  under the masked engine key; reads refuse pre-seeded or tampered state and
  only a human re-signs reviewed files (`es reseal --sign`).

## 1.1.1 — 2026-10-07

Security release (#35). The 1.1.0 adversarial audit broke the text-matched
shell policy six ways, forged VERIFIED claims through the shell, and drove
approvals through a stealable service password; 1.1.1 moves that enforcement
into the OS, the crypto and the sandbox. Published 1.1.0 is deprecated.

**Breaking.**
- Re-approve, re-trust and re-waive after `es key seal`: v1 HMAC records
  were MACed with a key agents could read; they are refused with the
  re-record hint.
- Bubblewrap is required for factory seats (refused a shell without it) and
  factory gate runs (halt with `gates/sandbox-missing`); CI, nightly, E2E
  and publish install it and allow unprivileged user namespaces.
- Approvals, waivers, trust and resume happen at a terminal only: the
  approve/trust/resume RPCs no longer exist and the TUI only previews, then
  points at the terminal command.

- **S1: quotes are evidence fragment by fragment (#38, #46, #48).** Every
  ellipsis fragment must be at least 12 characters on its own; code excerpts
  are one contiguous verbatim span of the cited lines (at most 60 lines); a
  thesis pass needs at least one witnessed invariant that holds; the
  audit/scout/harvest fire graders are exact (plants cited within 3 lines,
  no extra or duplicate rows).
- **S2: argv-aware shell policy (#37, #40–#45, #50, #51).** Quotes and escapes
  are stripped before matching, human-only verbs are found behind wrappers,
  git subcommands past global options, and control paths match
  case-insensitively; any `.factory/` mention needs a provably read-only
  command. This is defence in depth and the only layer for the user's own
  agents without bubblewrap — documented as weaker.
- **S3: every agent shell and gate run is sandboxed by bubblewrap.** Kinds:
  `user`, `seat`, `programmer`, `readonly` and `gate`; cached-web seats get
  `--unshare-net`; the private state dir and service credentials are masked
  in every kind. Seats lose Code Mode `execute`; the shell is re-checked by
  the last hook after the hook bridge.
- **S4: passphrase-sealed Ed25519 human key, terminal-only approvals (#39).**
  `es key seal` (asked twice, at least 10 characters) seals the key with
  scrypt + AES-256-GCM; every human action unlocks it with a passphrase at a
  TTY. A wrong or empty passphrase records nothing.
- **#49: no approval RPC for a stolen service password.** Verified: the
  mutating RPC methods are gone (previews still work) and `service.json` is
  masked in every agent sandbox.
- **#52: engine-sealed source cache.** Each entry's metadata carries an
  HMAC-SHA256 seal from a key in the masked state dir; unsealed (planted)
  entries are refused on read.
- **#32: per-file control re-pin.** `es_frontier_write` re-pins only
  `frontier.json` when its baseline matches, so a concurrent hand edit to
  another control file still halts as drift instead of being absorbed.
- **#31: host web caching only for factory seats in a factory project.**
  Without `.factory/`, nothing is cached and no `.factory/` is created;
  the user's agent never caches.
- **M1: eval harness that can pass (#25–#29, #36).** Case caps authoritative
  under a ceiling of 16, `toolsUsed` counts completed calls, spend read from
  `step_finish` cost under `ES_EVAL_MAX_USD`, failed workspaces kept and
  uploaded, nightly evals off push, agent feedback uses PWD.

## 1.1.0 — 2026-10-07

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

### M3: rigor (#23)
- **Domain packs, the full legacy port.** `quant`, `biopharma` and `legal`
  constitutions (tier weights incl. `__default__`, negative-knowledge bonus,
  reject penalty, accept threshold, banned domains, mandatory tags, standard
  or zero-tolerance retraction), selected with `config.domainPack` (for
  example `es config set domainPack biopharma`). With a pack active,
  `es_research_complete` rejects claims that break the constitution — a
  banned source domain, a missing tag, a retracted source — and refuses a
  score below the pack's accept threshold; unknown packs fail closed. Without
  a pack nothing changes. Claims now carry their source URL, and the summary
  shows the active pack during RESEARCH.
- **All five fire suites are merge-blocking.** `grill-fires` (no deleted
  nodes, no silent settled edits, no round regress; deferred facts gate
  research), `factory-gate` (the build starts only through the approvals;
  STOP and the spend ceiling halt, `es_status` stays reportable when halted)
  and `darkharvest-fires` (core keeps `depend` only for verified permissive
  licences, whatever the harvester proposes) join `audit-fires` and
  `scout-fires` on the real host. The same graders score the nightly
  model-backed runs.
- **Drift CI with a canary.** `docs:check` also fails on prompt, skill and
  registry drift: a prompt whose frontmatter id or seat disagrees with the
  registry, an orphaned prompt file or skill directory, a skill without its
  `SKILL.md`, a spawn naming no agent, an unknown `es_*` tool, or a duplicate
  agent id. The canary proves every class is caught.
- **Queereye phases 02 and 03.** The designer seat now renders the full
  design surface under `.factory/design/` (paths adapted from the legacy
  `.queereye/`):
  - `es_design_specs` (phase 02): behaviour-first component specs for
    `button`, `dialog`, `form-input`, `table`, `nav` and `toast`, the pinned
    MIT `webref.json` snapshot, the headless `csf.json` play harness and
    deterministic `tui-notes.md`, with drift, coverage, freshness and
    play-suite gates (`check:true` re-checks only).
  - `es_design_harvest` (phase 03): the full skill-harvest ledger
    (`harvest.json`: rows, SPDX blocks, transitive closure, negative
    knowledge) with the fail-closed MIT/Apache-2.0/BSD-3-Clause/ISC
    whitelist, the skill bundle and the factory cite-gate receipt, which is
    verified against the live tokens and ledger. The bundle check script is
    TypeScript against `es-core`; no Python is vendored.
- **Post-audit hardening (shell control files).** An adversarial audit found
  that a non-seat agent could still write control files through interpreter
  one-liners (`python3 -c`, `node -e`, …), which the shell rule never
  matched. A control-file mention is now allowed in an agent's shell command
  only when the command is provably read-only (allowlisted segments; no
  redirection, here-doc or substitution); seats keep the stricter
  no-mention rule, and the forge test now covers the shell path.
- **Post-audit parity hardening.** A parity audit against 0.7.25 found two
  port drifts, both fixed: `NEGATIVE_KNOWLEDGE` claims keep a full-key hash
  (`nkKey`, sha256 of the cleaned pre-truncate query/finding pair) so
  distinct past-2k rows stay distinct in ids and scoring while the stored
  fields stay capped (legacy R11); and the pack constitution carries the
  legacy structural rules again (VERIFIED needs its hash + quote or a code
  location; INFERRED its reasoning; HYPOTHESIS its falsification; NK query
  and finding). The legacy INFERRED "parents non-empty" rule is documented
  as not applicable to 1.x REPORT.md claims.
- **System architecture doc.** `SYSTEM_ARCHITECTURE.md` now describes the
  pipeline, the seats, the claim flow and the trust invariants in one place.

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
