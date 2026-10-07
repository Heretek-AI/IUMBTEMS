# M6a spike: nightly CI against OpenCode v2 HEAD + docs drift plumbing

Date: 2026-10-06. All commands run against the real upstream repository and
this worktree; nothing here is inferred.

## Findings

1. **Where v2 lives.** `github.com/anomalyco/opencode` default/dev branches are
   the **v1 line** (`@opencode-ai/plugin` 1.18.x). The v2 rewrite lives on
   `refs/heads/v2` (a `2.0` branch also exists). The plan's "nightly CI against
   v2 HEAD" therefore tracks `refs/heads/v2`, not the default branch.
   - `v2` HEAD at spike time: `369aad3` (2026-10-06 19:55:05 -0500), version
     `2.0.24` in `packages/sdk` and `packages/plugin`.
   - `dev` HEAD: `ecc4916` (v1.18.35). `2.0` HEAD: `7a6ce05`.

2. **No build step needed.** `packages/sdk` and `packages/plugin` export raw
   TypeScript (`"." -> ./src/index.ts`), and their workspace deps
   (`@opencode/client`, `@opencode/core`, `@opencode/schema`, …) resolve inside
   the clone. A shallow clone + `bun install` is enough.

3. **Relink works.** Replacing the `@opencode/sdk` and `@opencode/plugin`
   entries in each workspace `node_modules` with symlinks to the checkout makes
   our real-host tests run against HEAD without touching our source or lockfile.
   `bun install` restores the published links afterwards.

4. **Results against HEAD `369aad3`** (fresh clone, cold):
   - `packages/opencode/test/plugin.test.ts`: 10/10 pass (10s)
   - full `packages/opencode`: **34/34 pass** (21s)
   - cold end-to-end via `scripts/v2-head.sh` (clone + install + relink + run):
     **29s**
   No drift observed at spike time.

5. **Docs plumbing.** Zod 4.6.5 `z.toJSONSchema` converts all **37** exported
   schemas in `packages/core/src/schema/` (0 failures). `scripts/docs.ts`
   writes `schemas/*.schema.json` (37 files) + `docs/SCHEMAS.md`; `--check`
   detects drift and stale files and exits 1. A root devDependency on `zod`
   (exact `4.6.5`, the same pin as core) lets the root-level generator import
   it under Bun's isolated installs.

## Artifacts

- `scripts/v2-head.sh` — clone/fetch `v2`, install, relink, run tests
  (default `packages/opencode`). Used by `nightly.yml`; `bun install` restores
  the published links after a local run.
- `.github/workflows/ci.yml` — push/PR: `bun install --frozen-lockfile`,
  `bun run check`, `bun run docs:check`. Verified green on `rewrite`
  (run 37558318390 failed once on an environment-dependent sandbox test — the
  runner has no bwrap, so the allowlist refuses the command instead; the test
  now accepts either mechanism and CI is green).
- `.github/workflows/nightly.yml` — schedule + manual: `scripts/v2-head.sh
  packages/opencode` (the compatibility signal when the host drifts).
  Operational note: GitHub only runs scheduled workflows (and registers
  `workflow_dispatch`) from the default branch, so the nightly activates at
  the 1.0 cutover; until then the same mechanics are verified locally via
  `scripts/v2-head.sh`.
- `scripts/docs.ts` + `docs:gen` / `docs:check` root scripts.
- `schemas/*.schema.json` + `docs/SCHEMAS.md` (first generated batch; the
  capability matrix and config docs join this pipeline in M6c/M6d).

## Decisions and carry-overs

- Nightly tracks `refs/heads/v2`; if upstream moves v2 elsewhere, the branch is
  configurable via `V2_HEAD_BRANCH` / `V2_HEAD_REPO`.
- Eval jobs (cost-capped, never in the default run) are not wired yet; they
  join `nightly.yml` in M6e if the dogfood run needs them.
- Known testkit limitation carried from M5: `command.list()` does not surface
  transform-registered commands, so slash-command smoke coverage lands with the
  M6c panel/TUI work or the M6d capability rows.
