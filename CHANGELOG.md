# Changelog

## 1.0.4 (unreleased)

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
