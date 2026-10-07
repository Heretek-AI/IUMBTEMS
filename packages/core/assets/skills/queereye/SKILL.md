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

## Outputs
`.factory/design/`: `interview.json` (resume source), `tokens.json` (DTCG-shaped), `tokens.css` (Style-Dictionary-compat CSS vars), `probes.json` (contrast rows), `STYLE_GUIDE.md` (pure render).

## Rules
- Tokens are primitive → semantic → component alias chains; only primitives carry raw values.
- The contrast gate is a compile error, never a review note; decorative never excuses inaccessible text.
- The guide is generated; hand-edits are drift and fail `es_design_check`.
