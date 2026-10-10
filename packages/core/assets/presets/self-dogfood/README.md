# self-dogfood preset

The factory builds this repository: an issue becomes a run in an isolated
worktree under the real merge gate, and the release stage opens a draft PR
a human reviews.

- `config.json` — project layer: `audit.phase: required`, PR opener `gh`.
  Models come from the human's global config (the preset pins none).
- `gates.json` — the real merge gate: `bun install --frozen-lockfile`,
  `bun run check`, `bun run docs:check`. Trust them with `es trust`.
- `idea-from-issue.sh` — pulls the issue body as the run idea.
- Base branch: `rewrite`, never `main`. `es factory init` seeds
  `.factory/roadmap.json` with `baseBranch: rewrite`; keep that field when
  the grill rewrites the roadmap.
- Spend ceiling: $15 default, set on the frontier during the grill; the
  runtime cap is mandatory. See `docs/SELF-DOGFOOD.md`.
