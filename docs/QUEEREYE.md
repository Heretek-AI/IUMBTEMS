# Queereye — living style guide in `.queereye/`

Queereye is the interview-driven living style guide: 7-axis style rounds
emit DTCG-shaped generic tokens, a pure-rendered `STYLE_GUIDE.md`, generic
component specs, and a permissive-only skill harvest. There is exactly one
config dialect (plain Style-Dictionary-compat JSON + markdown renders);
nothing here invents a rival token dialect.

Single source of truth: the `.queereye/` directory in the project root
(created by the interview; never written outside it). The contract:

- `tokens.json` — DTCG `$value`/`$type`/`$description` + alias references
  (snapshot `2025.10`); written incrementally per axis so killed sessions
  resume.
- `tokens.css` / `probes.json` / `STYLE_GUIDE.md` — pure renders of tokens
  + contrast probes; CI `--check` fails on drift.
- `components/` + `webref.json` + `tui-notes.md` + `csf.json` — phase-02
  behavior-first component specs (button, dialog, form-input), the pinned
  MIT webref snapshot, deterministic TUI lowering, and the headless CSF
  play-function harness.
- `harvest.json` — phase-03 machine ledger (`{skill, verdict, license,
  upstream, files, evidence_hash}` rows, whitelist
  `MIT/Apache-2.0/BSD-3-Clause/ISC` enforced, SPDX blocks, transitive
  closure for shadcn sub-deps) with axe-core (MPL-2.0) excluded to
  behavior-only.
- `skill/` — the anthropics-style skill bundle (`SKILL.md` frontmatter +
  `scripts/` + `references/` + `assets/` layout, disclosure budgets
  enforced); `skill-claude/SKILL.md` is the single-file Claude overlay
  reusing the same token schema; `cite-gate-demo.md` is the factory
  cite-gate receipt (programmer cites token + style hashes, QA gates
  render-match + contrast + ledger).

Implementation (stdlib only, no network ingest): `runner/queereye/harvest.py`
(ledger, closure, skill bundle, overlay parity, cite-gate),
`runner/queereye/cli.py` (`compile` / `render` / `check` / `specs` /
`harvest` commands), acceptance in `runner/tests/test_queereye_harvest.py`.
Adapter stubs stay thin pointers via `scripts/build_adapters.py`
(`--check` green in CI).
