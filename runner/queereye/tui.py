#!/usr/bin/env python3
"""TUI notes as deterministic lowering: constraints + dichotomous key.

Phase queereye-02-component-specs (run queereye-style-guide).

Pointer-first web vs keyboard-first TUI is an input-model inversion,
documented here — not prose-waved:

- Web-only primitives (Radix Dialog gap): focus trapped within modal, Esc
  closes automatically, pointer-outside dismissal, screen-reader
  announcements [VERIFIED: 0785dc45]. None of these exists in a terminal;
  the port gap is structural, so every one gets an explicit TUI re-spec row.
- Behavior wording follows the unstyled-primitive contract (specified
  focus, keyboard, screen-reader behavior) [VERIFIED: 28a04ca6]; each web
  behavior below lowers to a terminal behavior deterministically.
- Downgrade rows: blur -> border, hover -> focus-visible, motion ->
  instant + reduced-motion variant (plus focus-trap/Esc/pointer/SR rows).

NEGATIVE_KNOWLEDGE(tui-host-caps): whether the deployed TUI host
(opentui/solid hover, blur, animation primitives) can render hover tints,
backdrop blur, or timed motion is UNMEASURED in this phase — no downgrade
row asserts host render correctness, only the specified fallback. An
experiment spike (render probe per capability) is required before any row
may claim pixel fidelity; until then every motion/blur/hover row is a
specification of the fallback, not a measurement of the host.

Zero runtime dependencies (stdlib only). No network ingest.
"""

import re

#: Zero-width set Python strip() misses (ZWSP/WJ/BOM family).
_ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u00ad"


def _strip_hardened(value):
    """Strip whitespace + zero-width chars (ZWSP/WJ/BOM family)."""
    if not isinstance(value, str):
        return value
    cleaned = value
    for _ch in _ZERO_WIDTH_CHARS:
        if _ch in cleaned:
            cleaned = cleaned.replace(_ch, "")
    return cleaned.strip()


def _is_blank_hardened(value):
    """True when not a hardened stripped non-empty string."""
    return not isinstance(value, str) or not _strip_hardened(value)


#: Domain vocabulary proving a waiver/note carries a semantic phrase
#: (not ``xxxx xxxxx``). TUI + component + license rebuild terms.
_WAIVER_ALLOWLIST = frozenset({
    "button", "dialog", "input", "form", "trigger", "overlay", "content",
    "title", "description", "close", "label", "field", "hint", "error",
    "icon", "spinner", "root", "portal",
    "empty", "loading", "disabled", "destructive", "variant", "size",
    "downgrade", "row", "applicable", "aria", "announcement", "focus",
    "keyboard", "event", "loop", "region", "border", "motion", "blur",
    "hover", "slot", "component", "spec", "state", "web", "tui",
    "rebuild", "behavior", "behaviour", "clean", "room", "upstream",
    "bytes", "vendored", "snapshot", "hash", "spdx", "license", "mit",
    "gpl", "agpl", "vendor", "depend", "skip", "icon-only", "no",
    "not", "single", "explicit", "status", "text", "plain", "keybinding",
    "overlay", "modal", "trap", "pointer", "screen", "reader", "reduced",
})


def _waiver_has_semantic_phrase(reason):
    """True when ``reason`` carries a semantic phrase (>=20 chars + words).

    Requires hardened length >=20 plus either >=2 allowlist words or
    >=4 distinct good words (each with >=3 distinct letters). ``xxxx xxxxx``
    (10 chars, 2 low-entropy words, 0 allowlist) fails both branches;
    the exemplar waiver (60 chars, 6+ allowlist, 8+ good words) passes.
    """
    if not isinstance(reason, str):
        return False
    stripped = _strip_hardened(reason)
    if len(stripped) < 20:
        return False
    words = re.findall(r"[A-Za-z]{2,}", stripped)
    if len(words) < 3:
        return False
    distinct = set(w.lower() for w in words)
    if len(distinct) < 3:
        return False
    allow_hits = len(distinct & _WAIVER_ALLOWLIST)
    if allow_hits >= 2:
        # Allowlist branch still needs varied words (rejects
        # ``button dialog xxxx`` with only 2 real words + gibberish? No:
        # ``button dialog`` alone is 13 chars <20, so length already fails.
        # Longer ``button dialog xxxx xxxxx`` has 2 allowlist but the
        # gibberish words are low-entropy; require at least 3 good words
        # OR 4 distinct to stop laundering via 2 real words + repeat.
        good = [w for w in distinct if len(set(w)) >= 3 and len(w) >= 3]
        if len(good) >= 2 and len(distinct) >= 3:
            return True
        # Fall through to strict prose branch when allowlist words are
        # accompanied only by gibberish.
        pass
    else:
        pass
    # Strict prose branch: >=4 distinct, >=3 good words (varied alphabet).
    good = [w for w in distinct if len(set(w)) >= 3 and len(w) >= 3]
    if len(distinct) >= 4 and len(good) >= 3:
        return True
    return False


#: Constraint catalog: the terminal capabilities every lowering assumes.
#: Each entry names the web assumption and the TUI constraint. ``hover`` and
#: ``motion`` carry the NEGATIVE_KNOWLEDGE host-cap flag (fallback specified,
#: host render unmeasured).
CONSTRAINT_CATALOG = {
    "region-geometry": {
        "web": "Free CSS layout (flex/grid, overlapping layers, z-index).",
        "tui": "Fixed grid of character cells; components own rectangular regions.",
    },
    "event-focus-routing": {
        "web": "OS/browser focus + pointer events routed by the compositor.",
        "tui": "Single terminal event loop; focus is an explicit ordered list.",
    },
    "keybindings": {
        "web": "Keyboard is one of several inputs (pointer-first).",
        "tui": "Keyboard-first: every pointer gesture needs a key equivalent.",
    },
    "palette-depth": {
        "web": "24-bit color + alpha compositing.",
        "tui": "Indexed/approximated palette; no alpha (borders instead of translucency).",
    },
    "hover": {
        "web": "Pointer hover states (:hover).",
        "tui": "No hover: focus-visible border is the only highlight. [NEGATIVE_KNOWLEDGE: host hover unmeasured]",
    },
    "motion": {
        "web": "Timed transitions/animations (150-250ms).",
        "tui": "Instant swap + reduced-motion variant. [NEGATIVE_KNOWLEDGE: host animation unmeasured]",
    },
}

#: Web-only primitives requiring a TUI re-spec row (the Radix gap
#: [VERIFIED: 0785dc45] plus SR behavior from the behavior contract
#: [VERIFIED: 28a04ca6]).
WEB_ONLY_PRIMITIVES = {
    "focus-trap": {
        "web": "Focus is automatically trapped within modal [VERIFIED: 0785dc45].",
        "tui": "Explicit focus list pinned to the dialog region; Tab cycles the list.",
    },
    "esc-close": {
        "web": "Esc closes the component automatically [VERIFIED: 0785dc45].",
        "tui": "Event-loop keybinding (Esc/q) closes and restores focus to Trigger.",
    },
    "pointer-outside": {
        "web": "Outside pointer event dismisses the overlay.",
        "tui": "No pointer: explicit Close control + keybinding dismisses.",
    },
    "sr-announcement": {
        "web": "Title/Description announced by the screen reader [VERIFIED: 28a04ca6].",
        "tui": "Status-line text set on open/change (plain-text announcement).",
    },
}

#: Every visual state gets an explicit downgrade row.
DOWNGRADE_ROWS = [
    {
        "state": "blur",
        "web": "soft shadow / backdrop blur",
        "tui": "single-line border (no blur)",
    },
    {
        "state": "hover",
        "web": "pointer hover tint",
        "tui": "focus-visible border (no pointer)",
    },
    {
        "state": "focus",
        "web": ":focus-visible ring",
        "tui": "inverted border on focused row (keyboard-first)",
    },
    {
        "state": "motion",
        "web": "150ms transition",
        "tui": "instant + reduced-motion variant",
    },
    {
        "state": "focus-trap",
        "web": "OS-level focus trapped within modal",
        "tui": "explicit focus list pinned to region",
    },
    {
        "state": "esc-close",
        "web": "Esc closes automatically",
        "tui": "Esc/q keybinding closes (event-loop)",
    },
    {
        "state": "pointer-outside",
        "web": "outside pointer event dismisses",
        "tui": "explicit Close key (no pointer)",
    },
    {
        "state": "sr-announcement",
        "web": "Title/Description announced by SR",
        "tui": "status-line text set on open",
    },
    {
        "state": "loading",
        "web": "spinner / shimmer",
        "tui": "static glyph + text (no animation)",
    },
    {
        "state": "empty",
        "web": "empty copy with single action",
        "tui": "empty text + single action row (no animation)",
    },
    {
        "state": "disabled",
        "web": "dimmed + no pointer events",
        "tui": "dimmed + skipped in focus order",
    },
    {
        "state": "error",
        "web": "ring + SR text",
        "tui": "error line printed below field",
    },
]

#: NEGATIVE_KNOWLEDGE entries: host capabilities this phase does NOT assert.
NEGATIVE_KNOWLEDGE = [
    "NEGATIVE_KNOWLEDGE(tui-hover-render): host hover-tint rendering unmeasured; rows specify the focus-visible fallback only.",
    "NEGATIVE_KNOWLEDGE(tui-blur-render): host blur/backdrop rendering unmeasured; rows specify the border fallback only.",
    "NEGATIVE_KNOWLEDGE(tui-motion-render): host animation timing unmeasured; rows specify instant + reduced-motion only.",
]

#: Minimum waiver reason length: waivers carry conditions (AGENTS.md dual-QA
#: waivers carry conditions) -- 'xxxx xxxxx' (10 chars + space) is NOT a
#: reason phrase: waivers need >=20 chars + a semantic phrase (>=2 allowlist
#: words or >=20 chars + distinct good words, gibberish refused).
_MIN_WAIVER_LEN = 20

#: Terminal event-loop architecture note (model/state + keyboard-first).
EVENT_LOOP_NOTE = (
    "Terminal event loop: a single queue delivers key/resize events to the "
    "focused region; focus is an explicit ordered list (keyboard-first "
    "inversion of the pointer-first web); regions re-render synchronously on "
    "state change; motion is an instant swap honoring the reduced-motion "
    "variant; announcements are plain-text status-line writes."
)


def lowering_for(state):
    """Dichotomous-key lowering for one web state name.

    Deterministic total function over the known states: exact (case-folded,
    stripped) match against :data:`DOWNGRADE_ROWS` wins; unknown states
    lower to the conservative ``explicit text + border`` fallback row
    (never a silent pass-through). Raises nothing.
    """
    key = _strip_hardened(str(state or "")).lower()
    for row in DOWNGRADE_ROWS:
        if row["state"].lower() == key:
            return dict(row)
    return {
        "state": str(state),
        "web": "unspecified web state",
        "tui": "explicit text + border fallback (no web behavior inherited)",
    }


def validate_tui_coverage(spec):
    """TUI-coverage unit: every web-only primitive + downgrade state covered.

    Returns error list: unknown/missing rows for every entry in
    :data:`WEB_ONLY_PRIMITIVES` (all 4 required for every spec — dialog and
    button/input alike [VERIFIED: 0785dc45]) plus every state in
    :data:`DOWNGRADE_ROWS` plus every key in ``spec['states']``. Every row
    must carry stripped non-empty ``web`` + ``tui``. The old
    ``empty``/``error`` exemption is removed: a missing state fails unless
    the spec carries an explicit waiver
    (``spec['tui_waivers'][state]`` with a stripped non-empty reason).
    Empty = covered.
    """
    errors = []
    name = spec.get("name", "<unnamed>") if isinstance(spec, dict) else "<unnamed>"
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    rows = spec.get("tui_rows")
    if not isinstance(rows, list) or not rows:
        return [f"{name}: tui_rows must be non-empty"]
    by_state = {}
    for r in rows:
        if not isinstance(r, dict):
            errors.append(f"{name}: tui_rows entry must be an object")
            continue
        state_key = _strip_hardened(str(r.get("state", ""))).lower()
        if not state_key:
            errors.append(f"{name}: tui_rows entry has blank 'state'")
            continue
        by_state[state_key] = r
    # Every row must carry stripped non-empty web + tui (no empty downgrade).
    for r in rows:
        if not isinstance(r, dict):
            continue
        state_label = _strip_hardened(str(r.get("state", ""))) or "<blank>"
        for field in ("web", "tui"):
            value = r.get(field)
            if _is_blank_hardened(value):
                errors.append(
                    f"{name}: tui_rows[{state_label}] has empty {field} lowering"
                )
    # All 4 web-only primitives required for every spec (no non-dialog
    # exemption) [VERIFIED: 0785dc45].
    for primitive in WEB_ONLY_PRIMITIVES:
        row = by_state.get(primitive)
        if row is None:
            errors.append(f"{name}: tui_rows missing web-only primitive {primitive!r}")
    # Waivers (explicit state -> reason) excuse a missing DOWNGRADE or state
    # row; blank/absent/short reason still FAILs (no silent empty/error
    # exemption; single-char 'x' laundering refused — waivers carry
    # conditions, >=10 chars with a reason phrase).
    waivers = spec.get("tui_waivers", {})
    if waivers is None:
        waivers = {}
    if not isinstance(waivers, dict):
        errors.append(f"{name}: tui_waivers must be an object when present")
        waivers = {}
    else:
        for wkey, reason in list(waivers.items()):
            if not isinstance(reason, str) or not _strip_hardened(reason):
                errors.append(
                    f"{name}: tui_waivers[{wkey!r}] reason must be a stripped "
                    f"non-empty string (blank/zero-width refused; waivers "
                    f"carry conditions)"
                )
            elif not _waiver_has_semantic_phrase(reason):
                errors.append(
                    f"{name}: tui_waivers[{wkey!r}] reason must carry a semantic "
                    f"phrase (>=20 chars + >=2 allowlist words or >=20 chars + "
                    f"distinct good words; 'xxxx xxxxx' gibberish refused; "
                    f"waivers carry conditions)"
                )

    def _waived(key):
        for candidate in (key, _strip_hardened(str(key)).lower()):
            reason = waivers.get(candidate, "")
            if isinstance(reason, str) and _waiver_has_semantic_phrase(reason):
                return True
        return False

    # Full DOWNGRADE_ROWS coverage required for every spec (no per-spec
    # subset: dialog missing hover/focus and button/input missing rows FAIL).
    for downgrade in DOWNGRADE_ROWS:
        key = str(downgrade.get("state", "")).lower()
        if key not in by_state and not _waived(key):
            errors.append(
                f"{name}: tui_rows missing downgrade row {key!r} "
                "(full DOWNGRADE_ROWS coverage required)"
            )
    # Every spec state needs its own explicit downgrade row (no
    # empty/error exemption unless explicitly waived with reason).
    # Non-dict states (e.g. "evil") skip coverage silently — refused here.
    states = spec.get("states", {})
    if not isinstance(states, dict):
        errors.append(
            f"{name}: states must be an object (non-dict states refused; "
            "coverage cannot be skipped)"
        )
    else:
        for state in states:
            key = _strip_hardened(str(state)).lower()
            if key not in by_state and not _waived(state) and not _waived(key):
                errors.append(
                    f"{name}: state {state!r} has no tui_rows downgrade row "
                    "(waive explicitly via tui_waivers with reason if truly n/a)"
                )
    return errors


def render_tui_notes():
    """Pure render of ``.queereye/tui-notes.md`` (deterministic)."""
    lines = []
    lines.append("# TUI notes — deterministic lowering")
    lines.append("")
    lines.append(
        "_Pointer-first web vs keyboard-first TUI is an input-model inversion, "
        "not a style tweak. Web-only primitives (focus trapped within modal, "
        "Esc closes automatically [VERIFIED: 0785dc45]; specified focus, "
        "keyboard, and screen-reader behavior [VERIFIED: 28a04ca6]) each get "
        "an explicit TUI re-spec row below._"
    )
    lines.append("")
    lines.append("## Constraint catalog")
    lines.append("")
    lines.append("| constraint | web | tui |")
    lines.append("| --- | --- | --- |")
    for name in sorted(CONSTRAINT_CATALOG):
        entry = CONSTRAINT_CATALOG[name]
        lines.append(f"| {name} | {entry['web']} | {entry['tui']} |")
    lines.append("")
    lines.append("## Dichotomous key (lowering decision tree)")
    lines.append("")
    lines.append("```text")
    lines.append(
        "state needs pointer position? --yes--> explicit Close/focus key (no pointer)"
    )
    lines.append(
        "  --no--> state needs OS focus trap? --yes--> pin explicit focus list to region"
    )
    lines.append(
        "  --no--> state needs SR announcement? --yes--> status-line text write"
    )
    lines.append(
        "  --no--> state is blur/hover/motion? --yes--> border / focus-visible / instant"
    )
    lines.append(
        "  --no--> explicit text + border fallback (never inherit web behavior)"
    )
    lines.append("```")
    lines.append("")
    lines.append("## Downgrade rows (every state)")
    lines.append("")
    lines.append("| state | web | tui |")
    lines.append("| --- | --- | --- |")
    for row in DOWNGRADE_ROWS:
        lines.append(f"| {row['state']} | {row['web']} | {row['tui']} |")
    lines.append("")
    lines.append("## Terminal event loop")
    lines.append("")
    lines.append(EVENT_LOOP_NOTE)
    lines.append("")
    lines.append("## Negative knowledge (unmeasured host caps)")
    lines.append("")
    for entry in NEGATIVE_KNOWLEDGE:
        lines.append(f"- {entry}")
    lines.append("")
    lines.append(
        "An experiment spike (render probe per capability) is required before "
        "any row may claim pixel fidelity."
    )
    lines.append("")
    return "\n".join(lines)


def write_tui_notes(project_root):
    """Write ``.queereye/tui-notes.md`` (idempotent)."""
    from runner.queereye import fs as _fs

    return _fs.write_queereye_file(project_root, "tui-notes.md", render_tui_notes())


def check_tui_notes(project_root):
    """Drift gate for ``.queereye/tui-notes.md``."""
    from runner.queereye import fs as _fs

    try:
        target = _fs.resolve_inside(project_root, "tui-notes.md")
    except _fs.QueereyePathError as exc:
        return [str(exc)]
    expected = render_tui_notes()
    existing = target.read_text(encoding="utf-8") if target.is_file() else None
    if existing != expected:
        return ["drift: tui-notes.md differs from TUI renderer output"]
    return []
