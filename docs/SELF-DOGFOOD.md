# Self-dogfood runbook: the factory builds this repo

The strongest proof the factory works is that it improves itself: take an
issue from this repo, build it in an isolated worktree under the full gate
suite, and open a draft PR a human reviews. This runbook is that loop.

## Prerequisites

- A machine where bubblewrap works (`bwrap --version`; some local
  containers have a broken overlay — CI has bwrap 0.9). Without it the
  programmer seat refuses to run.
- `gh` authenticated (`gh auth status`) — the release stage opens a draft
  PR through it.
- A sealed human key (`es key seal` once); approvals, trust and resume all
  need the passphrase.
- Work on `rewrite`, with a clean tree.

## The flow

1. **Seed the run** (human-only; agents cannot write factory control files):
   `es factory init --preset self-dogfood --issue <n>`.
   This writes `.factory/config.json` (`audit.phase: required`), the
   self-dogfood `.factory/gates.json` (`bun install --frozen-lockfile`,
   `bun run check`, `bun run docs:check`), a `.factory/roadmap.json` seed
   pinning `baseBranch: rewrite`, and the issue body as
   `.factory/notes/idea-<n>.md`.
2. **Trust the gates**: `es trust` (human-only). The gate commands run
   project code; review the hashes before trusting.
3. **Grill**: `/grill` (or `es factory begin` plus the grill flow) with a
   **$15 spend ceiling** (the preset default; raise deliberately). Keep
   `baseBranch: rewrite` when the grill rewrites the roadmap — the factory
   never pushes `main` or `rewrite` itself.
4. **Approve the frontier and the spec** (`es approve frontier`, then
   `es approve spec`) — on any Phase 2/4 surface: terminal, TUI or browser.
5. **Build ⇄ QA** runs in the phase worktree under bwrap; the runtime cap
   is mandatory and `.factory/STOP` halts the run at its next step.
6. **Release**: the merge gate runs in full; on green the factory pushes
   only its run branch and opens a **draft PR against `rewrite`**.
   A human reviews and merges. Auto-merge never happens.

## Reviewing the PR

- Check the base is `rewrite` and the head is a `factory/…` branch.
- Read the gate logs under `.factory/runs/<run>/gates/` and the spend
  against the $15 ceiling.
- Merge only when every check — including CodeRabbit and SonarCloud —
  is green.

## Aborting

Write `.factory/STOP` (or `es factory stop <reason>`); the run halts at
its next step. `es factory resume` clears the halt (human-only).

## Validation sessions

The first human-run session on a small, low-risk issue is recorded on
#137: run id, draft PR link, spend and gate results. Later sessions go
on their own issues.
