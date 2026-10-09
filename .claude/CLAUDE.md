# IUMBTEMS (Epistemic Swarm): session notes

The single source of truth for agent conventions in this repo is
[`AGENTS.md`](../AGENTS.md) at the repo root. Follow it: evidence tags on
research/harvest claims, explicit file staging (never `git add -A`), `bun run
check` before merging, and the contract invariants (human-only approvals,
control files, seat scopes).

Do not follow stale local instructions: there is no `runner/` directory, no
`.research/` tree (evidence lives under `.factory/research/`), and no
per-claim tag convention for everyday agent communication.
