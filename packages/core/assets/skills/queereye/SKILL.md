---
name: queereye
description: Schema-typed design-system interview producing DTCG tokens, WCAG-gated contrast probes and a generated style guide.
---
# Queereye

A design-system interview, run as seven schema-typed axes and distilled into tokens. The interview is short and opinionated; the outputs are mechanical.

## When to use
- The human runs `/design` or asks for a style guide, tokens or a palette.
- Before a grill, when the product needs a visual identity to settle scope.

## The flow (mechanised — follow the repairs)
1. `es_design_status` — resume from `.factory/design/interview.json`.
2. Ask one question per slot; submit with `es_design_answer`. Vague answers return counter-questions, pasted hex/font literals return smuggling repairs, contradictions return a repair instead of agreement. `es_design_skip` defaults a slot.
3. `es_design_complete` — validates the token tree (DTCG-shaped, `$value`/`$type`/`$description` only), requires zero one-off mints outside `<domain>.primitive.<name>`, gates every text color pair at WCAG AA (4.5:1 body, 3:1 large; AAA reported), and writes `tokens.json`, `tokens.css`, `probes.json`, `STYLE_GUIDE.md`.
4. `es_design_check` — byte-compares the guide and CSS against a fresh render; drift fails.
5. `es_design_specs` — phase 02: validates and renders the component specs, webref, csf and tui-notes surfaces; `check:true` re-checks drift, coverage, freshness and the play suite.
6. `es_design_harvest` — phase 03: validates the permissive-only ledger, writes the bundle and the cite-gate receipt, and verifies the receipt against the live tokens and ledger; `check:true` re-checks drift.

## Outputs
`.factory/design/`: `interview.json` (resume source), `tokens.json` (DTCG-shaped), `tokens.css` (Style-Dictionary-compat CSS vars), `probes.json` (contrast rows), `STYLE_GUIDE.md` (pure render).

Phase 02 adds `components/*.md` (button, dialog, form-input, table, nav, toast), `webref.json` (pinned MIT snapshot), `csf.json` (story inventory + play pass-rate), `tui-notes.md` (deterministic lowering).

Phase 03 adds `harvest.json` (ledger + closure + negative knowledge) and the skill bundle: `skill/SKILL.md`, `skill/references/`, `skill/scripts/harvest-check.ts`, `skill/assets/MIT-LICENSE.txt`, `skill-claude/SKILL.md` and `cite-gate-demo.md`.

## Rules
- Tokens are primitive → semantic → component alias chains; only primitives carry raw values.
- The contrast gate is a compile error, never a review note; decorative never excuses inaccessible text.
- The guide is generated; hand-edits are drift and fail `es_design_check`.
- The phase-03 whitelist is exactly MIT, Apache-2.0, BSD-3-Clause and ISC (fail-closed): anything else is clean-room or excluded, never depend/vendor.
