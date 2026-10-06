#!/usr/bin/env python3
"""CSF interchange + play-function harness + spec-vs-render divergence gate.

Phase queereye-02-component-specs (run queereye-style-guide).

- CSF is the proven open-standard shape for pairing a component with its
  states as data (args) rather than prose [VERIFIED: 60c8c31d]: every story
  carries a ``component`` field (required for autodocs prop-tables) plus
  named args per state.
- Play functions execute assertions against the rendered story without user
  interaction [VERIFIED: 60c8c31d]: the harness below runs assertion
  callables against rendered exemplars headlessly and reports a snippet
  pass-rate.
- The visual-regression pattern is rebuilt clean-room (hash-compare of
  rendered bytes + threshold note), never vendored.
- The CI spec-vs-render check requires: slots filled, downgrade rows per
  state, pinned-ref freshness.

Zero runtime dependencies (stdlib only). No network ingest.
"""

import hashlib
import json
import re

#: Zero-width set Python strip() misses (ZWSP/WJ/BOM family).
_ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u00ad"

#: Marker pattern for paired snippet linkage (web/tui markers are metadata,
#: never outer-tag bytes for the component assertion).
_MARKER_RE = re.compile(r"<!--(?:web|tui):.*?-->", re.DOTALL)


def _strip_hardened(value):
    """Strip whitespace + zero-width chars (ZWSP/WJ/BOM family)."""
    if not isinstance(value, str):
        return value
    cleaned = value
    for _ch in _ZERO_WIDTH_CHARS:
        if _ch in cleaned:
            cleaned = cleaned.replace(_ch, "")
    return cleaned.strip()


def _strip_markers(frame):
    """Remove ``<!--web:...-->`` / ``<!--tui:...-->`` markers from a frame."""
    if not isinstance(frame, str):
        return frame
    return _MARKER_RE.sub("", frame)


#: CSF meta fields this harness understands. ``component`` is REQUIRED:
#: autodocs prop-tables generate from it [VERIFIED: 60c8c31d].
CSF_REQUIRED_FIELDS = ("component",)
CSF_OPTIONAL_FIELDS = ("title", "args", "play")

#: Story ids shipped per exemplar (states as data, not prose).
EXEMPLAR_STORIES = {
    "button": [
        {
            "id": "button--default",
            "component": "Button",
            "args": {"variant": "default", "size": "default", "label": "Save"},
        },
        {
            "id": "button--loading",
            "component": "Button",
            "args": {"variant": "default", "size": "default", "loading": True},
        },
        {
            "id": "button--destructive",
            "component": "Button",
            "args": {"variant": "destructive", "size": "sm", "label": "Delete"},
        },
    ],
    "dialog": [
        {"id": "dialog--closed", "component": "Dialog", "args": {"open": False}},
        {
            "id": "dialog--open",
            "component": "Dialog",
            "args": {"open": True, "title": "Title"},
        },
    ],
    "form-input": [
        {"id": "form-input--empty", "component": "FormInput", "args": {"value": ""}},
        {
            "id": "form-input--error",
            "component": "FormInput",
            "args": {"value": "x", "invalid": True},
        },
    ],
}


def validate_csf_meta(meta):
    """Validate one CSF story meta. Returns error list (empty = valid)."""
    errors = []
    story = meta.get("id", "<unnamed>") if isinstance(meta, dict) else "<unnamed>"
    if not isinstance(meta, dict):
        return ["csf story must be an object"]
    # `component` is REQUIRED for autodocs [VERIFIED: 60c8c31d]: whitespace
    # "   " and zero-width-only must FAIL (hardened strip, not truthiness).
    component = meta.get("component")
    for field in CSF_REQUIRED_FIELDS:
        value = meta.get(field)
        if not isinstance(value, str) or not _strip_hardened(value):
            errors.append(
                f"csf {story}: {field!r} field required for autodocs "
                "[VERIFIED: 60c8c31d]"
            )
    # Story `id` is REQUIRED: missing/blank/non-string FAILs (no
    # `if not None` exemption — missing id must not pass).
    story_id = meta.get("id")
    if not isinstance(story_id, str) or not _strip_hardened(story_id):
        errors.append(f"csf {story}: 'id' must be a stripped non-empty string")
    _ = component
    args = meta.get("args", {})
    if "args" in meta and not isinstance(args, dict):
        errors.append(f"csf {story}: args must be an object (states as data)")
    return errors


def validate_all_stories(stories=None):
    """Validate every exemplar story. Returns ``{id: errors}``."""
    stories = (
        stories
        if stories is not None
        else [story for group in EXEMPLAR_STORIES.values() for story in group]
    )
    return {s.get("id", "<unnamed>"): validate_csf_meta(s) for s in stories}


def _find_spec_for_component(component):
    """Find the exemplar spec whose ``csf.component`` names ``component``.

    Returns the spec dict or ``None``. Lookup is exact on the
    ``csf.component`` field [VERIFIED: 60c8c31d], with a stripped
    case-insensitive name fallback (``FormInput`` <-> ``form-input``).
    """
    try:
        from runner.queereye import specs as _specs
    except ImportError:
        return None
    target = _strip_hardened(str(component or ""))
    if not target:
        return None
    for spec in _specs.EXEMPLARS.values():
        csf_component = ""
        try:
            csf_component = str((spec.get("csf") or {}).get("component", ""))
        except AttributeError:
            csf_component = ""
        if _strip_hardened(csf_component) == target:
            return spec
    lowered = target.lower().replace("-", "").replace("_", "")
    for spec in _specs.EXEMPLARS.values():
        try:
            csf_component = str((spec.get("csf") or {}).get("component", ""))
        except AttributeError:
            continue
        if csf_component.strip().lower().replace("-", "").replace("_", "") == lowered:
            return spec
        if (
            str(spec.get("name", "")).strip().lower().replace("-", "").replace("_", "")
            == lowered
        ):
            return spec
    return None


def render_story(story, spec=None):
    """Headless render of one story to deterministic text (no user I/O).

    The renderer is intentionally tiny: it stringifies the component +
    sorted args into a canonical frame. Play functions assert against this
    frame — executing assertions against the rendered story without user
    interaction [VERIFIED: 60c8c31d]. The paired spec snippets (web + tui)
    are linked into the frame (as ``<!--web:…-->`` / ``<!--tui:…-->``
    markers) so snippet linkage is asserted, never prose-waved: a story
    whose component has no spec, or whose spec has blank snippets, renders
    without markers and the snippet assertion fails.
    """
    component = (
        story.get("component", "Unknown") if isinstance(story, dict) else "Unknown"
    )
    args = story.get("args", {}) if isinstance(story, dict) else {}
    if not isinstance(args, dict):
        args = {}
    arg_s = " ".join(f'{k}="{args[k]}"' for k in sorted(args))
    inner = story.get("inner", "") if isinstance(story, dict) else ""
    frame = f"<{component} {arg_s}>{inner}</{component}>".strip()
    linked = spec if isinstance(spec, dict) else None
    if linked is None:
        linked = _find_spec_for_component(component)
    if isinstance(linked, dict):
        snippets = linked.get("snippets", {})
        if isinstance(snippets, dict):
            web_snippet = snippets.get("web", "")
            tui_snippet = snippets.get("tui", "")
            if isinstance(web_snippet, str) and _strip_hardened(web_snippet):
                frame += f"<!--web:{_strip_hardened(web_snippet)}-->"
            if isinstance(tui_snippet, str) and _strip_hardened(tui_snippet):
                # Collapse newlines for a single-line deterministic frame.
                tui_one_line = " ".join(_strip_hardened(tui_snippet).split())
                frame += f"<!--tui:{tui_one_line}-->"
    return frame


def _play_assertions_for(story, spec=None):
    """Clean-room play-function assertions for one story (callable list).

    Each assertion takes the rendered frame and returns
    ``(passed: bool, message: str)``. No user interaction, no browser.
    Hardened: ``"" in frame`` tautology refused (component must be stripped
    non-empty and named in the frame), empty ``args`` refused (states as
    data [VERIFIED: 60c8c31d] requires at least one arg), the loading
    ``"True" in frame`` tautology removed (requires the ``loading`` token),
    and the paired spec snippets (web + tui) must be linked in the frame.
    """
    story_dict = story if isinstance(story, dict) else {}
    component = story_dict.get("component", "")
    args = story_dict.get("args", {})
    if not isinstance(args, dict):
        args = {}
    linked = spec if isinstance(spec, dict) else _find_spec_for_component(component)

    def _has_component(frame):
        if not isinstance(component, str) or not _strip_hardened(component):
            return (False, "component must be a stripped non-empty string")
        # Zero-width-only component (ZWSP) is blank, not a name.
        comp = _strip_hardened(component)
        # Strip paired snippet markers before checking: marker bytes
        # (``<!--web:<button>...-->``) previously laundered a lower-case
        # ``button`` against a ``<Button>`` frame (case laundering via
        # in-marker bytes). Check the outer tag only.
        outer = _strip_markers(frame)
        # Exact frame-tag match, not substring: 'utton' is inside 'Button'
        # so a bare `in` check launders it. Require the opening tag
        # "<Comp" plus the closing tag "</Comp>" in the outer frame.
        if f"<{comp}" not in outer or f"</{comp}>" not in outer:
            return (
                False,
                f"frame missing exact tag for {comp!r} in outer frame "
                "(substring refused; in-marker bytes ignored; "
                "require <Comp ...>...</Comp> outside markers)",
            )
        # Case-exact linkage: the story component must equal the linked
        # spec's ``csf.component`` exactly (``button`` != ``Button``).
        # The case-insensitive fallback in ``_find_spec_for_component``
        # links ``button`` to the Button spec, but the play gate refuses
        # the case mismatch here.
        if isinstance(linked, dict):
            try:
                _linked_comp = str((linked.get("csf") or {}).get("component", ""))
            except AttributeError:
                _linked_comp = ""
            if _strip_hardened(_linked_comp) and comp != _strip_hardened(_linked_comp):
                return (
                    False,
                    f"component {comp!r} != linked spec component "
                    f"{_strip_hardened(_linked_comp)!r} (case-exact linkage "
                    "refused; require outer <Button>, not <button>)",
                )
        return (True, f"rendered frame names {comp!r} as exact tag")

    def _args_present(frame):
        if not isinstance(args, dict) or not args:
            return (False, "args must be a non-empty object (states as data)")
        missing = []
        for k in args:
            if not isinstance(k, str) or not _strip_hardened(k):
                missing.append(repr(k))
                continue
            _val = args[k]
            # Whitespace-only values ("   ") and zero-width-only are
            # refused: hardened strip-check arg values. Empty "" stays
            # legitimate (the `empty` state).
            if isinstance(_val, str) and _val != "" and not _strip_hardened(_val):
                missing.append(f"{_strip_hardened(k)}: whitespace value refused")
                continue
            raw_value = str(_val)
            # Empty-string values (the `empty` state, e.g. value="") are
            # legitimate: assert the arg *key* rendered (`value=`), not the
            # `"" in frame` tautology (empty string is in every string).
            if not _strip_hardened(raw_value):
                if (
                    f"{_strip_hardened(k)}=" not in frame
                    and _strip_hardened(k) not in frame
                ):
                    missing.append(k)
                continue
            if raw_value not in frame:
                missing.append(k)
        if missing:
            return (False, f"args missing from frame: {missing}")
        return (True, f"all {len(args)} args present in frame")

    def _loading_or_label(frame):
        if args.get("loading"):
            # Require the loading token itself, not the "True" tautology:
            # any True arg would contain "True", so only "loading" proves
            # the loading state rendered.
            ok = "loading" in frame.lower()
            return (ok, "loading state visible" if ok else "loading state invisible")
        return (True, "non-loading story needs no spinner assertion")

    def _snippets_linked(frame):
        if not isinstance(linked, dict):
            return (False, "no spec linked for snippet assertion")
        snippets = linked.get("snippets", {})
        if not isinstance(snippets, dict):
            return (False, "linked spec has no snippets object")
        web_snippet = snippets.get("web", "")
        tui_snippet = snippets.get("tui", "")
        if not isinstance(web_snippet, str) or not _strip_hardened(web_snippet):
            return (False, "linked spec web snippet blank (linkage refused)")
        if not isinstance(tui_snippet, str) or not _strip_hardened(tui_snippet):
            return (False, "linked spec tui snippet blank (linkage refused)")
        # Snippet-quality: trivial "Button" passes the 40-char probe via the
        # component tag, so require min length + marker linkage, not just
        # substring. Both snippets must be substantive and the frame must
        # carry the paired markers (link to spec, not substring laundering).
        # Hardened: pure repetition (x*20/y*20) passes length + self-contains
        # (probe is the snippet's own prefix), so require a semantic link
        # (snippet references component name/variant/slot) plus entropy
        # (no 10-char repeat run, varied alphabet) [VERIFIED: 60c8c31d].
        try:
            from runner.queereye import specs as _specs_mod
        except ImportError:
            _specs_mod = None
        _MIN_SNIPPET_LEN = 20
        _tui_one_line = " ".join(_strip_hardened(tui_snippet).split())
        if len(_strip_hardened(web_snippet)) < _MIN_SNIPPET_LEN:
            return (
                False,
                f"linked spec web snippet too short (<{_MIN_SNIPPET_LEN} chars; "
                "snippet-quality refused)",
            )
        if len(_tui_one_line) < _MIN_SNIPPET_LEN:
            return (
                False,
                f"linked spec tui snippet too short (<{_MIN_SNIPPET_LEN} chars; "
                "snippet-quality refused)",
            )
        if _specs_mod is not None:
            if _specs_mod._is_low_entropy(web_snippet):
                return (
                    False,
                    "linked spec web snippet low-entropy/repetition refused "
                    "(x*20 self-contains refused; needs varied code)",
                )
            if _specs_mod._is_low_entropy(tui_snippet):
                return (
                    False,
                    "linked spec tui snippet low-entropy/repetition refused "
                    "(y*20 self-contains refused; needs varied code)",
                )
            if not _specs_mod._snippet_has_semantic_link(
                web_snippet, linked, is_tui=False
            ):
                return (
                    False,
                    "linked spec web snippet must reference the component "
                    "(name/variant/slot; length + markers alone refused)",
                )
            if not _specs_mod._snippet_has_semantic_link(
                tui_snippet, linked, is_tui=True
            ):
                return (
                    False,
                    "linked spec tui snippet must reference the component "
                    "(name/variant/slot/TUI vocab; length + markers refused)",
                )
        if "<!--web:" not in frame or "<!--tui:" not in frame:
            return (
                False,
                "snippets not linked in render (markers missing; "
                "substring laundering refused)",
            )
        web_probe = _strip_hardened(web_snippet)[:40]
        tui_probe = _tui_one_line[:40]
        if web_probe not in frame:
            return (False, "web snippet not linked in render")
        if tui_probe not in frame:
            return (False, "tui snippet not linked in render")
        return (True, "paired web+tui snippets linked in render")

    return [_has_component, _args_present, _loading_or_label, _snippets_linked]


def run_play(story, spec=None):
    """Run the play function for one story. Returns ``(passed, failures)``.

    ``passed`` is a list of assertion messages, ``failures`` a list of
    failure messages. Headless: no prompts, no input, no browser.
    ``spec`` optionally supplies the linked spec (default: lookup by
    ``csf.component``); an empty/blank component fails (no ``"" in frame``
    tautology).
    """
    frame = render_story(story, spec=spec)
    passed, failures = [], []
    for assertion in _play_assertions_for(story, spec=spec):
        ok, message = assertion(frame)
        (passed if ok else failures).append(message)
    return (passed, failures)


def run_play_suite(stories=None):
    """Run play functions over every exemplar story.

    Returns ``(results, pass_rate)`` where ``results`` maps story id ->
    ``{"passed": [...], "failures": [...]}`` and ``pass_rate`` is the
    fraction of stories with zero failures.
    """
    stories = (
        stories
        if stories is not None
        else [story for group in EXEMPLAR_STORIES.values() for story in group]
    )
    results = {}
    green = 0
    for story in stories:
        passed, failures = run_play(story)
        results[story.get("id", "<unnamed>")] = {"passed": passed, "failures": failures}
        if not failures:
            green += 1
    rate = (green / len(results)) if results else 1.0
    return (results, rate)


def visual_regression_check(frame_a, frame_b):
    """Clean-room visual-regression pattern: hash-compare rendered frames.

    Returns ``{"equal": bool, "hash_a": ..., "hash_b": ...}``. Identical
    bytes pass; any difference fails with both hashes for the CI log. This
    is a pattern rebuilt clean-room (sha256 compare), not a vendored
    screenshot harness.
    """
    ha = hashlib.sha256(frame_a.encode("utf-8")).hexdigest()
    hb = hashlib.sha256(frame_b.encode("utf-8")).hexdigest()
    return {"equal": ha == hb, "hash_a": ha, "hash_b": hb}


def spec_vs_render_check(spec, rendered_slots=None, webref_fresh=True):
    """CI divergence gate: slots filled, downgrade rows per state, ref fresh.

    - Every slot named in ``spec['slots']`` must appear in
      ``rendered_slots`` (the caller MUST supply the actual render output;
      ``None`` is refused — no default-to-own-slots tautology).
    - Every state in ``spec['states']`` needs a ``tui_rows`` downgrade row
      (delegates to :mod:`runner.queereye.tui` coverage for the full rule).
    - ``webref_fresh`` must be True (pinned-ref freshness age gate).
    Returns error list (empty = in sync).
    """
    from runner.queereye import tui as _tui

    errors = []
    name = spec.get("name", "<unnamed>") if isinstance(spec, dict) else "<unnamed>"
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    if rendered_slots is None:
        errors.append(
            f"spec-vs-render {name}: rendered_slots must be supplied by the "
            "caller (no default pass; pass the actual render output)"
        )
        filled = set()
    else:
        filled = set(rendered_slots)
    expected_slots = set((spec.get("slots") or {}).keys())
    for slot in sorted(expected_slots):
        if slot not in filled:
            errors.append(f"spec-vs-render {name}: slot {slot!r} not filled in render")
    errors.extend(_tui.validate_tui_coverage(spec))
    if webref_fresh is not True:
        errors.append(f"spec-vs-render {name}: pinned webref stale (freshness gate)")
    return errors


def write_csf_manifest(project_root, specs=None):
    """Write ``.queereye/csf.json`` (story inventory + play pass-rate)."""
    from runner.queereye import fs as _fs

    stories = [s for group in EXEMPLAR_STORIES.values() for s in group]
    _results, rate = run_play_suite(stories)
    doc = {
        "stories": stories,
        "play_pass_rate": round(rate, 4),
        "headless": True,
        "evidence": {"csf_standard": "60c8c31d"},
        "specs": sorted((specs or {}).keys()),
    }
    content = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    return _fs.write_queereye_file(project_root, "csf.json", content)


def check_csf_manifest(project_root, specs=None):
    """Drift gate for ``.queereye/csf.json`` + story validation."""
    from runner.queereye import fs as _fs

    errors = []
    for errs in validate_all_stories().values():
        errors.extend(errs)
    _results, rate = run_play_suite()
    if rate < 1.0:
        errors.append(f"csf play-function pass-rate {rate:.2f} < 1.00")
    try:
        target = _fs.resolve_inside(project_root, "csf.json")
    except _fs.QueereyePathError as exc:
        return errors + [str(exc)]
    if not target.is_file():
        return errors + ["drift: csf.json missing (run queereye specs)"]
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        return errors + [f"corrupt csf.json: {exc}"]
    if doc.get("play_pass_rate") != round(rate, 4):
        errors.append("drift: csf.json play_pass_rate differs from harness output")
    if doc.get("stories") != [s for group in EXEMPLAR_STORIES.values() for s in group]:
        errors.append("drift: csf.json stories differ from exemplar inventory")
    return errors
