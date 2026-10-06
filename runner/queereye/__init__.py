#!/usr/bin/env python3
"""Queereye interview core: 7-axis style rounds emitting DTCG tokens.

Phase queereye-01-interview-core. Zero runtime dependencies (stdlib only).

Submodules:
- tokens: DTCG ``$value``/``$type``/``$description`` schema, alias chains,
  group-level ``$type`` inheritance, alias-reuse ratio.
- contrast: Leonardo-style contrast-ratio-first gate (WCAG AA 4.5:1 / 3:1).
- slots: Rasa-style ``required_slots`` turn loop with ``validate_<form>``
  repair hooks over the 7 axes.
- fs: ``.queereye/`` filesystem contract (hard error outside, idempotent,
  versioned backups for user-customized files).
- render: Style-Dictionary-compat CSS-var compile + pure-render STYLE_GUIDE.
- cli: ``compile`` / ``render`` / ``check`` (``--check`` drift gate) commands.
- specs: generic component spec template (anatomy/props/cva-matrix/slots +
  keyboard/focus/scroll/usage/states/snippets/csf/tui_rows) + 3 exemplars.
- webref: single MIT shadcn-style snapshot (hash + SPDX) + transform-group
  registry + license/freshness gates (never a live URL).
- tui: deterministic lowering (constraint catalog + dichotomous key +
  downgrade rows + event-loop note + NEGATIVE_KNOWLEDGE host caps).
- csf: CSF interchange (``component`` required) + headless play-function
  harness + visual-regression pattern + spec-vs-render divergence gate.
- harvest: permissive-only harvest ledger (machine rows + SPDX + transitive
  closure) + anthropics SKILL.md bundle + Claude overlay + cite-gate.

Phase evidence (full quotes in the phase dossier):
- DTCG generic tokens [VERIFIED: 7f369895]
- WCAG contrast 4.5:1 / 3:1 [VERIFIED: 9c9c4f32]
- Rasa required_slots loop [VERIFIED: eb45e3dd]
- Leonardo contrast-first generation [VERIFIED: 44295aec]
- Style Dictionary single-source compile [VERIFIED: e3ecfe46]
- DTCG $value + aliasing [VERIFIED: 12c70178]
- OpenCode V2 plural commands key [VERIFIED: 8223a719]

Phase queereye-02-component-specs adds (full quotes in its phase dossier):
- shadcn-style prop-driven pin [VERIFIED: dc656fd4]
- Radix focus-trap/Esc/pointer-outside/SR gap [VERIFIED: 0785dc45]
- cva variant/size matrix [VERIFIED: c24a9c9c]
- unstyled behavior-first contract [VERIFIED: 28a04ca6]
- CSF args-shape + play functions [VERIFIED: 60c8c31d]
"""

from runner.queereye import (
    cli,
    contrast,
    csf,
    fs,
    harvest,
    render,
    slots,
    specs,
    tokens,
    tui,
    webref,
)

__all__ = [
    "cli",
    "contrast",
    "csf",
    "fs",
    "harvest",
    "render",
    "slots",
    "specs",
    "tokens",
    "tui",
    "webref",
]
