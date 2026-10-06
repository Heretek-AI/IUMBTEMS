#!/usr/bin/env python3
"""Generic component spec template: anatomy + props/variants/slots + a11y.

Phase queereye-02-component-specs (run queereye-style-guide).

Specs are behavior-first WHATWG/Radix-grade contracts portable across web
and terminal, with CSF as the interchange shape and copy-own distribution:

- shadcn-style prop-driven API surface is the ideal pin target for specs
  because variant/size props already drive generic markup [VERIFIED: dc656fd4].
- The cva variant/size API matrix is variant
  default/outline/ghost/destructive/secondary/link x size
  default/xs/sm/lg/icon [VERIFIED: c24a9c9c].
- The behavior-first contract is unstyled primitives with specified focus,
  keyboard, and screen-reader behavior [VERIFIED: 28a04ca6].
- CSF is the proven open-standard shape for pairing a component with its
  states as data (args) rather than prose [VERIFIED: 60c8c31d].

Zero runtime dependencies (stdlib only). No network ingest: specs are local
clean-room data structures rendered deterministically to
``.queereye/components/<name>.md`` (byte-match + ``--check`` drift gate,
mirroring the phase-01 STYLE_GUIDE pattern).
"""

import json
import re

#: cva variant axis [VERIFIED: c24a9c9c].
CVA_VARIANTS = (
    "default",
    "outline",
    "ghost",
    "destructive",
    "secondary",
    "link",
)

#: cva size axis [VERIFIED: c24a9c9c].
CVA_SIZES = ("default", "xs", "sm", "lg", "icon")

#: Canonical part names. Dialog carries the full Radix Dialog anatomy
#: (Root/Trigger/Portal/Overlay/Content/Title/Description/Close); button and
#: form-input use the applicable subset. The keyboard/focus gap those parts
#: imply in a terminal (pointer-outside, OS focus trap, SR announcements) is
#: re-specified per target in :mod:`runner.queereye.tui`
#: [VERIFIED: 0785dc45].
DIALOG_ANATOMY = (
    "Root",
    "Trigger",
    "Portal",
    "Overlay",
    "Content",
    "Title",
    "Description",
    "Close",
)

BUTTON_ANATOMY = ("Root", "Label", "Icon", "Spinner")

INPUT_ANATOMY = ("Root", "Label", "Field", "Hint", "Error")

#: States every spec must address (loading/empty/error/disabled).
REQUIRED_STATES = ("loading", "empty", "error", "disabled")

#: Top-level keys every spec dict must carry. ``csf`` holds the CSF
#: interchange meta (``component`` field required for autodocs prop-tables
#: [VERIFIED: 60c8c31d]); ``tui_rows`` holds the per-state deterministic
#: lowering rows (see :mod:`runner.queereye.tui`).
REQUIRED_SPEC_KEYS = (
    "name",
    "anatomy",
    "props",
    "variants",
    "slots",
    "keyboard",
    "focus",
    "scroll",
    "usage",
    "states",
    "snippets",
    "csf",
    "tui_rows",
)


#: Zero-width / invisible characters Python str.strip() misses (ZWSP/WJ/BOM
#: family). Blank checks must remove these before stripping, otherwise
#: "\u200b" (single ZWSP) launders as non-blank.
_ZERO_WIDTH_CHARS = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u00ad"

#: Spec names this phase ships (A1: button, dialog, form-input). Unknown
#: names (e.g. "evil") previously skipped full-anatomy enforcement
#: (``_expected is None``); they are now refused outright [VERIFIED: 0785dc45].
KNOWN_SPEC_NAMES = frozenset({"button", "dialog", "form-input"})


def _err(spec_name, msg):
    return f"{spec_name}: {msg}"


def _strip_hardened(value):
    """Strip whitespace + zero-width chars (ZWSP/WJ/BOM family).

    ``str.strip()`` leaves ``\\u200b``/``\\u2060``/``\\ufeff`` intact, so a
    value of pure zero-width launders as non-blank. Remove the invisible
    set first, then strip.
    """
    if not isinstance(value, str):
        return value
    cleaned = value
    for _ch in _ZERO_WIDTH_CHARS:
        if _ch in cleaned:
            cleaned = cleaned.replace(_ch, "")
    return cleaned.strip()


def _is_blank(value):
    """True when ``value`` is not a stripped non-empty string.

    Hardened: zero-width-only (``\\u200b``/``\\u2060``/``\\ufeff`` family)
    counts as blank.
    """
    return not isinstance(value, str) or not _strip_hardened(value)


def _has_placeholder(value):
    """True when ``value`` carries a prose-wave placeholder (todo/tbd/fixme)."""
    lowered = str(value or "").lower()
    return ("todo" in lowered) or ("tbd" in lowered) or ("fixme" in lowered)


#: Minimum prose length for per-target re-specs (rejects "x" waves).
_MIN_RESPEC_LEN = 20

#: Keywords proving the keyboard-first/event-loop inversion is documented
#: in ``focus.tui`` (not prose-waved) [VERIFIED: 0785dc45].
_FOCUS_TUI_KEYWORDS = ("keyboard-first", "event-loop", "event loop", "focus list")

#: Keywords proving scroll re-specs carry layout/scroll meaning
#: (not gibberish): every scroll.web/tui must name scroll/layout semantics.
_SCROLL_KEYWORDS = (
    "scroll",
    "region",
    "overflow",
    "lock",
    "frozen",
    "pinned",
    "clip",
    "sticky",
    "footer",
    "content",
    "viewport",
    "layout",
    "width",
    "horizontal",
    "vertical",
)

#: Repeat-run + low-entropy probe: any char repeated 10+ consecutively
#: (``x*100``) or a tiny alphabet dominating a long string is gibberish,
#: even with a keyword prefix.
_REPEAT_RUN_RE = re.compile(r"([A-Za-z0-9])\1{9,}")

#: Minimum snippet length: trivial ``Button`` (6 chars) passes a 40-char
#: probe via the component tag, so snippets must be substantive
#: [VERIFIED: 60c8c31d].
_MIN_SNIPPET_LEN = 20

#: TUI vocabulary accepted as a semantic link for ``snippets.tui`` only
#: (web snippets must reference the component/variant/slot itself).
#: The button exemplar tui (``[ Save ] (focused: ... inverted border)``)
#: carries no literal ``button`` token, so focus/border/region terms count
#: as the TUI lowering link; pure repetition (``y*20``) still fails.
_TUI_SNIPPET_VOCAB = (
    "focus",
    "border",
    "region",
    "keyboard",
    "event-loop",
    "event loop",
    "inverted",
    "caret",
    "status",
    "row",
    "cell",
    "grid",
    "scroll",
    "hover",
    "motion",
)


def _distinct_keyword_hits(text_lower, keywords):
    """Count distinct keywords present as substrings in ``text_lower``."""
    return sum(1 for kw in keywords if kw in text_lower)


def _is_low_entropy(text):
    """True when ``text`` is repetition-dominated gibberish.

    Catches ``x*20``/``y*20`` (single-char alphabet), ``scroll + x*100``
    (keyword + repeat run), and single-char-dominated long strings, while
    exemplar prose (many distinct alphanumerics, no 10-run) passes.
    """
    if not isinstance(text, str) or not text:
        return True
    if _REPEAT_RUN_RE.search(text):
        return True
    alnum = re.sub(r"[^a-z0-9]", "", text.lower())
    if not alnum:
        return True
    if len(alnum) >= 10 and len(set(alnum)) <= 2:
        return True
    if len(alnum) >= 20:
        most = 0
        for _ch in set(alnum):
            _c = alnum.count(_ch)
            if _c > most:
                most = _c
        if most / len(alnum) > 0.5:
            return True
    return False


def _meets_prose_bar(text, min_words=4, min_distinct=3):
    """True when ``text`` carries real prose (not keyword + gibberish).

    Requires ``min_words`` alpha words with ``min_distinct`` distinct,
    plus no low-entropy dominance. ``scroll + x*100`` (2 words, 10-run)
    fails; exemplar re-specs (8+ words, varied alphabet) pass.
    """
    if not isinstance(text, str):
        return False
    words = re.findall(r"[A-Za-z]{2,}", text)
    if len(words) < min_words:
        return False
    if len(set(w.lower() for w in words)) < min_distinct:
        return False
    if _is_low_entropy(text):
        return False
    return True


def _spec_semantic_tokens(spec):
    """Lowercased tokens a snippet must reference (component/variant/slot).

    Union of spec-name parts (``form-input`` -> ``form``/``input``), CSF
    component camel parts (``FormInput`` -> ``form``/``input``), slot names,
    anatomy parts, and the cva variant/size axes [VERIFIED: c24a9c9c].
    """
    toks = set()
    try:
        _name = str(spec.get("name", "") or "")
    except AttributeError:
        _name = ""
    for _part in re.split(r"[^A-Za-z0-9]+", _name):
        if len(_part) >= 3:
            toks.add(_part.lower())
    _norm_name = _name.strip().lower().replace("-", "").replace("_", "")
    if len(_norm_name) >= 3:
        toks.add(_norm_name)
    try:
        _comp = str((spec.get("csf") or {}).get("component", "") or "")
    except AttributeError:
        _comp = ""
    for _part in re.findall(r"[A-Za-z]{3,}", _comp):
        toks.add(_part.lower())
    _norm_comp = _comp.strip().lower().replace("-", "").replace("_", "")
    if len(_norm_comp) >= 3:
        toks.add(_norm_comp)
    try:
        _slots = spec.get("slots") or {}
        if isinstance(_slots, dict):
            for _s in _slots:
                if isinstance(_s, str) and len(_s.strip()) >= 2:
                    toks.add(_s.strip().lower())
    except AttributeError:
        pass
    try:
        _anat = spec.get("anatomy") or []
        if isinstance(_anat, list):
            for _a in _anat:
                if isinstance(_a, str) and len(_a.strip()) >= 2:
                    toks.add(_a.strip().lower())
    except AttributeError:
        pass
    for _v in list(CVA_VARIANTS) + list(CVA_SIZES):
        toks.add(str(_v).lower())
    toks.discard("")
    return {t for t in toks if len(t) >= 2}


def _snippet_has_semantic_link(code, spec, is_tui=False):
    """True when ``code`` references the spec (not just length + markers).

    Web snippets must contain a spec token (component name part, CSF
    component part, slot, anatomy, or cva value). Tui snippets additionally
    accept TUI lowering vocabulary (focus/border/region/...) since the
    button tui carries ``focused ... inverted border`` instead of a literal
    ``button`` token. Pure repetition (``x*20``) contains none and fails.
    """
    if not isinstance(code, str):
        return False
    lower = code.lower()
    for _tok in _spec_semantic_tokens(spec):
        if _tok and _tok in lower:
            return True
    if is_tui:
        for _voc in _TUI_SNIPPET_VOCAB:
            if _voc in lower:
                return True
    return False


def validate_spec(spec):
    """Validate one spec dict. Returns a list of error strings (empty = valid).

    Completeness gate (spec-completeness unit): a spec missing
    variants/slots/a11y (keyboard+focus)/snippet FAILs — every section is
    required, never advisory.
    """
    errors = []
    name = spec.get("name", "<unnamed>") if isinstance(spec, dict) else "<unnamed>"
    if not isinstance(spec, dict):
        return ["spec must be an object"]
    for key in REQUIRED_SPEC_KEYS:
        if key not in spec:
            errors.append(_err(name, f"missing required section {key!r}"))
    if errors:
        return errors

    # -- anatomy ---------------------------------------------------------
    anatomy = spec["anatomy"]
    if not isinstance(anatomy, list) or not anatomy:
        errors.append(_err(name, "anatomy must be a non-empty list of part names"))
    else:
        # Type-guard first: reject non-string entries with a structured
        # error (a dict entry must not raise TypeError from set()).
        for part in anatomy:
            if not isinstance(part, str):
                errors.append(
                    _err(
                        name,
                        f"anatomy part {part!r} must be a string "
                        "(non-string entry refused)",
                    )
                )
            elif _is_blank(part):
                errors.append(
                    _err(name, "anatomy part names must be stripped non-empty")
                )
                break
        # Uniqueness with hashability guard (unhashable -> structured error).
        try:
            if len(set(anatomy)) != len(anatomy):
                errors.append(_err(name, "anatomy part names must be unique"))
        except TypeError:
            errors.append(
                _err(
                    name,
                    "anatomy part names must be hashable strings "
                    "(unhashable entry refused)",
                )
            )
        # Full-anatomy enforcement per component (dialog + button + input):
        # truncated ["X"] must FAIL for every known spec, not just dialog.
        # Unknown names (e.g. "evil") previously skipped enforcement via
        # ``_expected is None``; they are now refused outright (no None skip)
        # [VERIFIED: 0785dc45].
        _expected = None
        _norm_name = _strip_hardened(name) if isinstance(name, str) else name
        if _norm_name == "dialog":
            _expected = DIALOG_ANATOMY
        elif _norm_name == "button":
            _expected = BUTTON_ANATOMY
        elif _norm_name == "form-input":
            _expected = INPUT_ANATOMY
        else:
            errors.append(
                _err(
                    name,
                    f"unknown spec name {name!r} (must be one of "
                    f"{sorted(KNOWN_SPEC_NAMES)}; anatomy skip refused) "
                    "[VERIFIED: 0785dc45]",
                )
            )
        if _expected is not None:
            _label = (
                "DIALOG_ANATOMY"
                if name == "dialog"
                else ("BUTTON_ANATOMY" if name == "button" else "INPUT_ANATOMY")
            )
            missing_parts = [p for p in _expected if p not in anatomy]
            if missing_parts:
                errors.append(
                    _err(
                        name,
                        f"{name} anatomy must include full {_label} "
                        f"{list(_expected)}; missing {missing_parts} "
                        "[VERIFIED: 0785dc45]",
                    )
                )
            # Smuggled extras (e.g. ["Root", ..., "X"]) refused: every
            # string part must belong to the expected set.
            unknown_parts = [
                p for p in anatomy if isinstance(p, str) and p not in _expected
            ]
            if unknown_parts:
                errors.append(
                    _err(
                        name,
                        f"{name} anatomy has unknown part {unknown_parts} "
                        "(must be a member of the expected anatomy) "
                        "[VERIFIED: 0785dc45]",
                    )
                )

    # -- props ------------------------------------------------------------
    props = spec["props"]
    if not isinstance(props, dict) or not props:
        errors.append(_err(name, "props must be a non-empty object"))
    else:
        for prop, decl in props.items():
            if not isinstance(decl, dict) or _is_blank(decl.get("type")):
                errors.append(
                    _err(name, f"prop {prop!r} must declare a non-empty 'type'")
                )
                continue
            if "values" in decl:
                values = decl["values"]
                if not isinstance(values, list) or not values:
                    errors.append(
                        _err(name, f"prop {prop!r} 'values' must be a non-empty list")
                    )
                else:
                    for value in values:
                        if _is_blank(value):
                            errors.append(
                                _err(
                                    name,
                                    f"prop {prop!r} 'values' entries must be "
                                    "stripped non-empty",
                                )
                            )
                            break
                    # Props cva smuggle refused: variant/size prop values must
                    # be a subset of the cva axes even when the variants axis
                    # itself is intact [VERIFIED: c24a9c9c]. Prop-name match
                    # is case-insensitive: ``Variant`` == ``variant``
                    # (capital smuggle refused).
                    _prop_lower = prop.lower() if isinstance(prop, str) else prop
                    if _prop_lower == "variant":
                        unknown_prop = [v for v in values if v not in CVA_VARIANTS]
                        if unknown_prop:
                            errors.append(
                                _err(
                                    name,
                                    f"prop {prop!r} values {unknown_prop} not in "
                                    "cva variant axis (smuggle refused) "
                                    "[VERIFIED: c24a9c9c]",
                                )
                            )
                    elif _prop_lower == "size":
                        unknown_prop = [v for v in values if v not in CVA_SIZES]
                        if unknown_prop:
                            errors.append(
                                _err(
                                    name,
                                    f"prop {prop!r} values {unknown_prop} not in "
                                    "cva size axis (smuggle refused) "
                                    "[VERIFIED: c24a9c9c]",
                                )
                            )
                    if _prop_lower in ("variant", "size") and "default" in decl:
                        default_val = decl["default"]
                        if isinstance(default_val, str) and default_val not in values:
                            errors.append(
                                _err(
                                    name,
                                    f"prop {prop!r} default {default_val!r} "
                                    "not in cva axis values "
                                    "[VERIFIED: c24a9c9c]",
                                )
                            )
            # Non-string defaults refused (structured error): string/enum
            # props need str, boolean props need strict bool, numbers need
            # int/float; dict/list/None never valid. Rejects 123 on a string
            # prop while keeping exemplar "" / False green.
            if "default" in decl:
                _default_val = decl["default"]
                _decl_type = decl.get("type")
                if _decl_type in ("string", "enum"):
                    if not isinstance(_default_val, str):
                        errors.append(
                            _err(
                                name,
                                f"prop {prop!r} default {_default_val!r} must be "
                                "a string (non-string default refused)",
                            )
                        )
                elif _decl_type == "boolean":
                    if type(_default_val) is not bool:
                        errors.append(
                            _err(
                                name,
                                f"prop {prop!r} default {_default_val!r} must be "
                                "a boolean (non-boolean default refused)",
                            )
                        )
                elif _decl_type in ("number", "integer"):
                    if isinstance(_default_val, bool) or not isinstance(
                        _default_val, (int, float)
                    ):
                        errors.append(
                            _err(
                                name,
                                f"prop {prop!r} default {_default_val!r} must be "
                                "a number (non-number default refused)",
                            )
                        )
                else:
                    if isinstance(_default_val, (dict, list)) or _default_val is None:
                        errors.append(
                            _err(
                                name,
                                f"prop {prop!r} default {_default_val!r} must be "
                                "a string/boolean/number (non-string default refused)",
                            )
                        )
                    elif not isinstance(_default_val, (str, bool, int, float)):
                        errors.append(
                            _err(
                                name,
                                f"prop {prop!r} default {_default_val!r} must be "
                                "a string/boolean/number (non-string default refused)",
                            )
                        )

    # -- variants: cva matrix ---------------------------------------------
    variants = spec["variants"]
    if not isinstance(variants, dict):
        errors.append(_err(name, "variants must be an object with variant/size axes"))
    else:
        for axis, expected in (("variant", CVA_VARIANTS), ("size", CVA_SIZES)):
            values = variants.get(axis)
            if not isinstance(values, list) or not values:
                errors.append(_err(name, f"variants.{axis} must be a non-empty list"))
            else:
                for value in values:
                    if _is_blank(value):
                        errors.append(
                            _err(
                                name,
                                f"variants.{axis} entries must be stripped non-empty",
                            )
                        )
                        break
                missing = [v for v in expected if v not in values]
                if missing:
                    errors.append(
                        _err(
                            name,
                            f"variants.{axis} missing cva entries {missing} "
                            "[VERIFIED: c24a9c9c]",
                        )
                    )
                # Evil smuggled values ("evil") must FAIL: every entry must
                # be a member of the cva axis [VERIFIED: c24a9c9c].
                unknown = [v for v in values if v not in expected]
                if unknown:
                    errors.append(
                        _err(
                            name,
                            f"variants.{axis} has unknown cva entry {unknown} "
                            "(must be a member of the cva axis) "
                            "[VERIFIED: c24a9c9c]",
                        )
                    )
        if "default" not in variants:
            errors.append(_err(name, "variants must declare a 'default' selection"))
        else:
            default_sel = variants["default"]
            if not isinstance(default_sel, dict):
                errors.append(_err(name, "variants.default must be an object"))
            else:
                for axis, expected in (
                    ("variant", CVA_VARIANTS),
                    ("size", CVA_SIZES),
                ):
                    if axis in default_sel and default_sel[axis] not in expected:
                        errors.append(
                            _err(
                                name,
                                f"variants.default.{axis} {default_sel[axis]!r} "
                                "not in cva axis "
                                "[VERIFIED: c24a9c9c]",
                            )
                        )

    # -- slots --------------------------------------------------------------
    slots = spec["slots"]
    if not isinstance(slots, dict) or not slots:
        errors.append(_err(name, "slots must be a non-empty object"))
    else:
        for slot, decl in slots.items():
            if not isinstance(slot, str) or _is_blank(slot):
                errors.append(
                    _err(
                        name,
                        f"slot name {slot!r} must be a stripped non-empty "
                        "string (blank slot refused)",
                    )
                )
            if not isinstance(decl, dict) or _is_blank(decl.get("description")):
                errors.append(
                    _err(
                        name,
                        f"slot {slot!r} must carry a stripped non-empty 'description'",
                    )
                )

    # -- keyboard (a11y) ------------------------------------------------------
    keyboard = spec["keyboard"]
    if not isinstance(keyboard, list) or not keyboard:
        errors.append(_err(name, "keyboard table must be non-empty (a11y required)"))
    else:
        for i, row in enumerate(keyboard):
            if (
                not isinstance(row, dict)
                or _is_blank(row.get("keys"))
                or _is_blank(row.get("action"))
            ):
                errors.append(
                    _err(
                        name,
                        f"keyboard row {i} must carry stripped non-empty "
                        "'keys' + 'action'",
                    )
                )

    # -- focus / scroll re-specified per target -------------------------------
    for section in ("focus", "scroll"):
        node = spec[section]
        if not isinstance(node, dict):
            errors.append(_err(name, f"{section} must be an object"))
        else:
            for target in ("web", "tui"):
                value = node.get(target)
                if _is_blank(value):
                    errors.append(
                        _err(name, f"{section} must re-specify per target ({target!r})")
                    )
                else:
                    stripped = _strip_hardened(value)
                    if len(stripped) < _MIN_RESPEC_LEN:
                        errors.append(
                            _err(
                                name,
                                f"{section}.{target} must be >= {_MIN_RESPEC_LEN} "
                                "chars (prose-wave refused)",
                            )
                        )
                    if _has_placeholder(value):
                        errors.append(
                            _err(
                                name,
                                f"{section}.{target} contains placeholder "
                                "('todo'/'tbd' refused)",
                            )
                        )
                    # Prose/entropy bar for every re-spec: keyword + repeat
                    # (``scroll + x*100``) passes length + substring, so
                    # require real prose (words + varied alphabet, no 10-run).
                    if isinstance(value, str) and _strip_hardened(value):
                        if _is_low_entropy(value):
                            errors.append(
                                _err(
                                    name,
                                    f"{section}.{target} low-entropy/repetition "
                                    "refused (keyword + gibberish refused; "
                                    "needs varied prose, no 10-char repeat run)",
                                )
                            )
                        elif not _meets_prose_bar(value):
                            errors.append(
                                _err(
                                    name,
                                    f"{section}.{target} must carry prose "
                                    "(>=4 words, >=3 distinct; keyword + "
                                    "gibberish refused)",
                                )
                            )
            # Keyboard-first/event-loop inversion must be documented in
            # focus.tui, not prose-waved [VERIFIED: 0785dc45].
            if section == "focus":
                tui_value = node.get("tui")
                if isinstance(tui_value, str) and _strip_hardened(tui_value):
                    lowered = _strip_hardened(tui_value).lower()
                    if not any(kw in lowered for kw in _FOCUS_TUI_KEYWORDS):
                        errors.append(
                            _err(
                                name,
                                "focus.tui must document the keyboard-first/"
                                "event-loop inversion (needs one of "
                                f"{list(_FOCUS_TUI_KEYWORDS)}) "
                                "[VERIFIED: 0785dc45]",
                            )
                        )
                    else:
                        # Single-keyword + repeat (``keyboard-first + x*100``)
                        # launders the substring check: the prose/entropy bar
                        # above already fails it, but surface a focused error
                        # when only the keyword is present without prose.
                        pass
            # Scroll must carry layout/scroll meaning like focus carries
            # keyboard-first: gibberish "x"*20 / "y"*20 passes length-only
            # so both web and tui require scroll/layout keywords PLUS prose.
            if section == "scroll":
                for _target in ("web", "tui"):
                    _val = node.get(_target)
                    if isinstance(_val, str) and _strip_hardened(_val):
                        _lowered = _strip_hardened(_val).lower()
                        _hits = _distinct_keyword_hits(_lowered, _SCROLL_KEYWORDS)
                        if _hits == 0:
                            errors.append(
                                _err(
                                    name,
                                    f"scroll.{_target} must name scroll/layout "
                                    "semantics (needs one of "
                                    f"{list(_SCROLL_KEYWORDS)}; gibberish refused)",
                                )
                            )
                        elif _hits < 2:
                            errors.append(
                                _err(
                                    name,
                                    f"scroll.{_target} needs >=2 distinct "
                                    "scroll/layout keywords "
                                    f"(got {_hits}; single-keyword + repeat "
                                    "refused; gibberish refused)",
                                )
                            )

    # -- usage do/don't ---------------------------------------------------------
    usage = spec["usage"]
    if not isinstance(usage, dict):
        errors.append(_err(name, "usage must be an object"))
    else:
        for key in ("do", "dont"):
            items = usage.get(key)
            if not isinstance(items, list) or not items:
                errors.append(_err(name, f"usage.{key} must be a non-empty list"))
            else:
                for i, item in enumerate(items):
                    if _is_blank(item):
                        errors.append(
                            _err(
                                name,
                                f"usage.{key}[{i}] must be a stripped non-empty string",
                            )
                        )

    # -- states ---------------------------------------------------------------
    states = spec["states"]
    if not isinstance(states, dict):
        errors.append(_err(name, "states must be an object"))
    else:
        for state in REQUIRED_STATES:
            value = states.get(state)
            if _is_blank(value):
                errors.append(
                    _err(
                        name,
                        f"states must address {state!r} with a stripped "
                        "non-empty string (loading/empty/error/disabled)",
                    )
                )

    # -- snippets (paired web + tui) --------------------------------------------
    snippets = spec["snippets"]
    if not isinstance(snippets, dict):
        errors.append(_err(name, "snippets must be an object"))
    else:
        for target in ("web", "tui"):
            code = snippets.get(target)
            if not isinstance(code, str) or _is_blank(code):
                errors.append(
                    _err(name, f"snippets.{target} must be a non-empty code string")
                )
            else:
                _stripped = _strip_hardened(code)
                if len(_stripped) < _MIN_SNIPPET_LEN:
                    errors.append(
                        _err(
                            name,
                            f"snippets.{target} too short (<{_MIN_SNIPPET_LEN} "
                            "chars; snippet-quality refused) "
                            "[VERIFIED: 60c8c31d]",
                        )
                    )
                elif _is_low_entropy(code):
                    errors.append(
                        _err(
                            name,
                            f"snippets.{target} low-entropy/repetition refused "
                            "(pure repetition x*20/y*20 refused; needs varied "
                            "code, no 10-char repeat run) "
                            "[VERIFIED: 60c8c31d]",
                        )
                    )
                elif not _snippet_has_semantic_link(
                    code, spec, is_tui=(target == "tui")
                ):
                    errors.append(
                        _err(
                            name,
                            f"snippets.{target} must reference the component "
                            "(name/variant/slot/anatomy"
                            + ("/TUI vocab" if target == "tui" else "")
                            + "; length + markers alone refused, gibberish "
                            "refused) [VERIFIED: 60c8c31d]",
                        )
                    )

    # -- csf interchange ----------------------------------------------------------
    csf = spec["csf"]
    if not isinstance(csf, dict) or _is_blank(csf.get("component")):
        errors.append(
            _err(name, "csf.component field required for autodocs [VERIFIED: 60c8c31d]")
        )

    # -- tui_rows -------------------------------------------------------------------
    tui_rows = spec["tui_rows"]
    if not isinstance(tui_rows, list) or not tui_rows:
        errors.append(_err(name, "tui_rows must be non-empty (every state lowered)"))
    else:
        for i, row in enumerate(tui_rows):
            if (
                not isinstance(row, dict)
                or _is_blank(row.get("state"))
                or _is_blank(row.get("web"))
                or _is_blank(row.get("tui"))
            ):
                errors.append(
                    _err(
                        name,
                        f"tui_rows[{i}] must carry stripped non-empty "
                        "'state' + 'web' + 'tui'",
                    )
                )
    return errors


# -- exemplar specs ------------------------------------------------------------
#
# Three exemplars (button, dialog, form-input), each complete per template so
# prop-tables generate from the ``csf.component`` field. Variant/size axes are
# the cva matrix [VERIFIED: c24a9c9c]; the dialog anatomy is the Radix Dialog
# part list whose web-only primitives (focus trap, Esc, pointer-outside, SR)
# each get a TUI re-spec row [VERIFIED: 0785dc45]; behavior wording follows
# the unstyled-primitive contract [VERIFIED: 28a04ca6]; distribution is
# copy-own (no live URLs, vendored snapshot lives in webref.json).

_BUTTON_KEYBOARD = [
    {"keys": "Tab / Shift+Tab", "action": "Move focus to / from the button"},
    {"keys": "Enter / Space", "action": "Activate the button (click)"},
    {"keys": "Escape", "action": "No-op while focused (no menu to dismiss)"},
]

_DIALOG_KEYBOARD = [
    {"keys": "Tab / Shift+Tab", "action": "Cycle focus within the modal content"},
    {"keys": "Escape", "action": "Close the dialog and restore focus to Trigger"},
    {"keys": "Enter", "action": "Activate the focused control inside Content"},
]

_INPUT_KEYBOARD = [
    {"keys": "Tab / Shift+Tab", "action": "Move focus into / out of the field"},
    {"keys": "Printable keys", "action": "Insert text at the caret"},
    {"keys": "Escape", "action": "TUI: clear-and-blur per lowering; web: blur only"},
    {"keys": "Enter", "action": "Submit the enclosing form (when present)"},
]


def _button_spec():
    return {
        "name": "button",
        "anatomy": list(BUTTON_ANATOMY),
        "props": {
            "variant": {
                "type": "enum",
                "values": list(CVA_VARIANTS),
                "default": "default",
            },
            "size": {"type": "enum", "values": list(CVA_SIZES), "default": "default"},
            "disabled": {"type": "boolean", "default": False},
            "loading": {"type": "boolean", "default": False},
            "label": {"type": "string", "default": ""},
        },
        "variants": {
            "variant": list(CVA_VARIANTS),
            "size": list(CVA_SIZES),
            "default": {"variant": "default", "size": "default"},
        },
        "slots": {
            "label": {
                "description": "Visible text (required unless icon-only with aria-label)."
            },
            "icon": {
                "description": "Optional leading/trailing glyph; hidden while loading."
            },
            "spinner": {
                "description": "Loading indicator; replaces icon when loading."
            },
        },
        "keyboard": [dict(r) for r in _BUTTON_KEYBOARD],
        "focus": {
            "web": "Visible focus ring on :focus-visible; pointer hover never replaces focus.",
            "tui": "Selected row/button drawn with inverted border; focus follows the explicit focus list (keyboard-first).",
        },
        "scroll": {
            "web": "Button never scrolls content; sticky footers keep it in view.",
            "tui": "Button pinned to the region footer; region scrolls under it.",
        },
        "usage": {
            "do": [
                "Use variant=default for the primary action, ghost/link for tertiary.",
                "Render <a> with buttonVariants for navigation instead of role-breaking Button-as-link.",
            ],
            "dont": [
                "Do not disable without an adjacent reason (error/hint text).",
                "Do not use motion-only feedback; pair with a label change.",
            ],
        },
        "states": {
            "loading": "Spinner replaces icon; label unchanged; activation ignored.",
            "empty": "Icon-only buttons require aria-label; label slot empty is an error.",
            "error": "Destructive variant; error text adjacent, never color-only.",
            "disabled": "aria-disabled + no activation; contrast of label still gated.",
        },
        "snippets": {
            "web": '<button class="btn" data-variant="default" data-size="default">Save</button>',
            "tui": "[ Save ]  (focused: >[ Save ]< with inverted border)",
        },
        "csf": {"component": "Button", "title": "Queereye/Button"},
        "tui_rows": [
            {
                "state": "hover",
                "web": "pointer hover tint",
                "tui": "focus-visible border (no pointer)",
            },
            {
                "state": "focus",
                "web": ":focus-visible ring",
                "tui": "inverted border on focused row",
            },
            {
                "state": "focus-trap",
                "web": "n/a single control (no trap)",
                "tui": "focus list includes button row (no trap needed)",
            },
            {
                "state": "esc-close",
                "web": "Esc is a no-op (no menu to dismiss)",
                "tui": "Esc is a no-op (event-loop keeps focus)",
            },
            {
                "state": "pointer-outside",
                "web": "n/a (no overlay)",
                "tui": "n/a (no overlay; Tab moves on)",
            },
            {
                "state": "sr-announcement",
                "web": "label exposed as accessible name",
                "tui": "label text drawn adjacent (plain-text name)",
            },
            {
                "state": "motion",
                "web": "150ms press scale",
                "tui": "instant + reduced-motion variant",
            },
            {
                "state": "blur",
                "web": "soft shadow blur",
                "tui": "single-line border (no blur)",
            },
            {
                "state": "loading",
                "web": "spinner + label",
                "tui": "spinner glyph + label (no animation)",
            },
            {
                "state": "empty",
                "web": "icon-only empty label with aria-label",
                "tui": "empty text + aria-label row (no icon-only gap)",
            },
            {
                "state": "error",
                "web": "destructive ring + adjacent error text",
                "tui": "error line printed below button (no color-only)",
            },
            {
                "state": "disabled",
                "web": "dimmed + no pointer",
                "tui": "dimmed + skipped in focus order",
            },
        ],
    }


def _dialog_spec():
    return {
        "name": "dialog",
        "anatomy": list(DIALOG_ANATOMY),
        "props": {
            "open": {"type": "boolean", "default": False},
            "modal": {"type": "boolean", "default": True},
            "variant": {
                "type": "enum",
                "values": list(CVA_VARIANTS),
                "default": "default",
            },
            "size": {"type": "enum", "values": list(CVA_SIZES), "default": "default"},
            "title": {"type": "string", "default": ""},
        },
        "variants": {
            "variant": list(CVA_VARIANTS),
            "size": list(CVA_SIZES),
            "default": {"variant": "default", "size": "default"},
        },
        "slots": {
            "trigger": {
                "description": "Element that opens the dialog; focus returns here on close."
            },
            "overlay": {"description": "Modal scrim; pointer-outside dismiss on web."},
            "content": {
                "description": "Dialog panel; focus trapped here while open (web)."
            },
            "title": {"description": "Accessible name; announced on open."},
            "description": {
                "description": "Optional supporting text; announced with title."
            },
            "close": {"description": "Explicit dismiss control; always rendered."},
        },
        "keyboard": [dict(r) for r in _DIALOG_KEYBOARD],
        "focus": {
            "web": "Focus trapped within modal; Esc closes; focus restored to Trigger.",
            "tui": "Focus list pinned to dialog region; Esc/q closes; focus restored to trigger row (no OS trap).",
        },
        "scroll": {
            "web": "Body scroll locked while modal open; Content scrolls internally.",
            "tui": "Background region frozen; dialog region scrolls; no scroll-lock API needed.",
        },
        "usage": {
            "do": [
                "Always render Title + Close; Title names the dialog for SR.",
                "Return focus to Trigger on close on both targets.",
            ],
            "dont": [
                "Do not nest modal dialogs; stack is a single explicit region.",
                "Do not rely on pointer-outside alone; always offer Close.",
            ],
        },
        "states": {
            "loading": "Content shows skeleton rows; Close stays enabled.",
            "empty": "Title + empty-copy + single action; never a bare overlay.",
            "error": "Error block inside Content; focus moved to Error on open.",
            "disabled": "Trigger disabled explains why; open dialog never disables Close.",
        },
        "snippets": {
            "web": "<div data-dialog-root><button data-dialog-trigger>Open</button><div data-dialog-overlay></div><div data-dialog-content><h2 data-dialog-title>Title</h2><button data-dialog-close>Close</button></div></div>",
            "tui": "+--[ Title ]------+\n| region content  |\n| [ Close ]       |\n+-----------------+",
        },
        "csf": {"component": "Dialog", "title": "Queereye/Dialog"},
        "tui_rows": [
            {
                "state": "hover",
                "web": "pointer hover tint on Trigger/Close",
                "tui": "focus-visible border (no pointer)",
            },
            {
                "state": "focus",
                "web": ":focus-visible ring inside Content",
                "tui": "inverted border on focused row (keyboard-first)",
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
                "state": "blur",
                "web": "overlay backdrop blur",
                "tui": "border (no blur)",
            },
            {
                "state": "motion",
                "web": "overlay fade 150ms",
                "tui": "instant + reduced-motion variant",
            },
            {
                "state": "loading",
                "web": "skeleton rows in Content",
                "tui": "static skeleton rows as text (no shimmer)",
            },
            {
                "state": "empty",
                "web": "Title + empty-copy + single action",
                "tui": "empty text + single action row (no bare overlay)",
            },
            {
                "state": "error",
                "web": "error block in Content with SR text",
                "tui": "error text row + focus list moves to error",
            },
            {
                "state": "disabled",
                "web": "Trigger dimmed; open dialog keeps Close enabled",
                "tui": "trigger row dimmed + skipped; Close stays in focus list",
            },
        ],
    }


def _input_spec():
    return {
        "name": "form-input",
        "anatomy": list(INPUT_ANATOMY),
        "props": {
            "variant": {
                "type": "enum",
                "values": list(CVA_VARIANTS),
                "default": "outline",
            },
            "size": {"type": "enum", "values": list(CVA_SIZES), "default": "default"},
            "value": {"type": "string", "default": ""},
            "placeholder": {"type": "string", "default": ""},
            "invalid": {"type": "boolean", "default": False},
            "disabled": {"type": "boolean", "default": False},
        },
        "variants": {
            "variant": list(CVA_VARIANTS),
            "size": list(CVA_SIZES),
            "default": {"variant": "outline", "size": "default"},
        },
        "slots": {
            "label": {
                "description": "Associated label; always rendered (never placeholder-only)."
            },
            "field": {"description": "Text entry box; caret + value."},
            "hint": {"description": "Helper text; replaced by Error when invalid."},
            "error": {
                "description": "Validation message; linked via aria-describedby."
            },
        },
        "keyboard": [dict(r) for r in _INPUT_KEYBOARD],
        "focus": {
            "web": "Caret in Field; :focus-visible ring; error announced via aria-describedby.",
            "tui": "Field row focused with inverted border; error line printed below (no SR); keyboard-first: field in explicit focus list, event-loop drives caret.",
        },
        "scroll": {
            "web": "Field scrolls horizontally for overflow; page scroll unaffected.",
            "tui": "Field clips to region width with horizontal scroll keys (Left/Right).",
        },
        "usage": {
            "do": [
                "Always pair Field with a visible Label.",
                "Surface errors as text in the Error slot, never color-only.",
            ],
            "dont": [
                "Do not use placeholder as the label.",
                "Do not clear user input on blur without confirmation.",
            ],
        },
        "states": {
            "loading": "Field readonly with hint 'Loading…'; value preserved.",
            "empty": "Placeholder shown; Label still visible; no error.",
            "error": "Error slot filled; invalid ring; focus stays in Field.",
            "disabled": "Field readonly + dimmed; value preserved; skipped in Tab order.",
        },
        "snippets": {
            "web": '<label>Name<input data-input-field placeholder="Ada" /></label><p data-input-hint>First name</p>',
            "tui": "Name: [Ada______]  (focused: >Name: [Ada______]<)\n      hint: First name",
        },
        "csf": {"component": "FormInput", "title": "Queereye/FormInput"},
        "tui_rows": [
            {
                "state": "hover",
                "web": "pointer hover border tint",
                "tui": "focus-visible border (no pointer)",
            },
            {
                "state": "focus",
                "web": ":focus-visible ring + caret",
                "tui": "inverted border + block caret",
            },
            {
                "state": "focus-trap",
                "web": "n/a single field (no trap)",
                "tui": "field stays in form focus list (no trap)",
            },
            {
                "state": "esc-close",
                "web": "blur only (no dismiss)",
                "tui": "clear-and-blur keybinding (event-loop)",
            },
            {
                "state": "pointer-outside",
                "web": "n/a (no overlay)",
                "tui": "n/a (no overlay; Tab moves on)",
            },
            {
                "state": "motion",
                "web": "caret blink + 150ms ring fade",
                "tui": "static caret + reduced-motion variant",
            },
            {
                "state": "blur",
                "web": "soft outer glow",
                "tui": "single-line border (no blur)",
            },
            {
                "state": "sr-announcement",
                "web": "error announced via aria-describedby",
                "tui": "error line printed below field",
            },
            {
                "state": "loading",
                "web": "skeleton shimmer",
                "tui": "static 'Loading…' hint (no shimmer)",
            },
            {
                "state": "empty",
                "web": "placeholder + visible Label (no error)",
                "tui": "placeholder text row + Label (no error)",
            },
            {
                "state": "error",
                "web": "invalid ring + SR error text",
                "tui": "error line printed below field (no color-only)",
            },
            {
                "state": "disabled",
                "web": "dimmed + readonly + removed from Tab order",
                "tui": "dimmed + readonly + skipped in focus list",
            },
        ],
    }


#: The three exemplar specs (A1: button, dialog, form-input).
EXEMPLARS = {
    "button": _button_spec(),
    "dialog": _dialog_spec(),
    "form-input": _input_spec(),
}


def validate_all(specs=None):
    """Validate every exemplar (default all three). Returns ``{name: errors}``."""
    specs = specs if specs is not None else EXEMPLARS
    return {name: validate_spec(spec) for name, spec in specs.items()}


def spec_filename(name):
    """``components/<name>.md`` relative path inside ``.queereye/``."""
    safe = "".join(ch if (ch.isalnum() or ch in ("-", "_")) else "-" for ch in name)
    return f"components/{safe}.md"


def render_spec_md(spec):
    """Pure render of one spec to markdown (deterministic, sorted keys)."""
    lines = []
    name = spec.get("name", "unknown")
    csf = spec.get("csf", {})
    lines.append(f"# Component — {name}")
    lines.append("")
    lines.append(
        "_Behavior-first contract (what, not how): unstyled primitives with "
        "specified focus, keyboard, and screen-reader behavior "
        "[VERIFIED: 28a04ca6]. Variant/size surface is prop-driven "
        "[VERIFIED: dc656fd4] over the cva matrix "
        "[VERIFIED: c24a9c9c]; states pair as CSF args data, not prose "
        "[VERIFIED: 60c8c31d]._"
    )
    lines.append("")
    lines.append("## Anatomy")
    lines.append("")
    for part in spec.get("anatomy", []):
        lines.append(f"- `{part}`")
    lines.append("")
    lines.append("## Props")
    lines.append("")
    lines.append("| prop | type | default | values |")
    lines.append("| --- | --- | --- | --- |")
    for prop in sorted(spec.get("props", {})):
        decl = spec["props"][prop]
        values = ",".join(decl.get("values", [])) if isinstance(decl, dict) else ""
        lines.append(
            f"| {prop} | {decl.get('type', '')} | {decl.get('default', '')} | {values} |"
        )
    lines.append("")
    lines.append("## Variants x Size (cva matrix [VERIFIED: c24a9c9c])")
    lines.append("")
    variants = spec.get("variants", {})
    lines.append(f"- variant: {', '.join(variants.get('variant', []))}")
    lines.append(f"- size: {', '.join(variants.get('size', []))}")
    lines.append(
        f"- default: `{json.dumps(variants.get('default', {}), sort_keys=True)}`"
    )
    lines.append("")
    lines.append("## Slots")
    lines.append("")
    for slot in sorted(spec.get("slots", {})):
        lines.append(f"- `{slot}`: {spec['slots'][slot].get('description', '')}")
    lines.append("")
    lines.append("## Keyboard")
    lines.append("")
    lines.append("| keys | action |")
    lines.append("| --- | --- |")
    for row in spec.get("keyboard", []):
        lines.append(f"| {row.get('keys', '')} | {row.get('action', '')} |")
    lines.append("")
    lines.append("## Focus / Scroll (per-target re-spec)")
    lines.append("")
    for section in ("focus", "scroll"):
        node = spec.get(section, {})
        lines.append(f"- {section}.web: {node.get('web', '')}")
        lines.append(f"- {section}.tui: {node.get('tui', '')}")
    lines.append("")
    lines.append("## Usage")
    lines.append("")
    lines.append("Do:")
    for item in spec.get("usage", {}).get("do", []):
        lines.append(f"- {item}")
    lines.append("Don't:")
    for item in spec.get("usage", {}).get("dont", []):
        lines.append(f"- {item}")
    lines.append("")
    lines.append("## States (loading / empty / error / disabled)")
    lines.append("")
    for state in sorted(spec.get("states", {})):
        lines.append(f"- {state}: {spec['states'][state]}")
    lines.append("")
    lines.append("## Snippets (paired)")
    lines.append("")
    snippets = spec.get("snippets", {})
    lines.append("```html (web)")
    lines.append(snippets.get("web", ""))
    lines.append("```")
    lines.append("```text (tui)")
    lines.append(snippets.get("tui", ""))
    lines.append("```")
    lines.append("")
    lines.append("## CSF interchange")
    lines.append("")
    lines.append(
        f"- component: `{csf.get('component', '')}` (required for autodocs "
        "[VERIFIED: 60c8c31d])"
    )
    lines.append(f"- title: `{csf.get('title', '')}`")
    lines.append("")
    lines.append("## TUI lowering (deterministic rows)")
    lines.append("")
    lines.append("| state | web | tui |")
    lines.append("| --- | --- | --- |")
    for row in spec.get("tui_rows", []):
        lines.append(
            f"| {row.get('state', '')} | {row.get('web', '')} | {row.get('tui', '')} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_specs(project_root, specs=None):
    """Write every spec to ``.queereye/components/<name>.md`` (idempotent).

    Returns ``[(rel, wrote, backup, note)]`` via :mod:`runner.queereye.fs`.
    """
    from runner.queereye import fs as _fs

    specs = specs if specs is not None else EXEMPLARS
    results = []
    for name in sorted(specs):
        rel = spec_filename(name)
        content = render_spec_md(specs[name])
        wrote, backup, note = _fs.write_queereye_file(project_root, rel, content)
        results.append((rel, wrote, backup, note))
    return results


def check_specs(project_root, specs=None):
    """Drift gate: rendered bytes must byte-match committed files."""
    from runner.queereye import fs as _fs

    specs = specs if specs is not None else EXEMPLARS
    errors = []
    for name in sorted(specs):
        spec_errors = validate_spec(specs[name])
        for err in spec_errors:
            errors.append(f"spec {err}")
        rel = spec_filename(name)
        try:
            target = _fs.resolve_inside(project_root, rel)
        except _fs.QueereyePathError as exc:
            errors.append(str(exc))
            continue
        expected = render_spec_md(specs[name])
        existing = target.read_text(encoding="utf-8") if target.is_file() else None
        if existing != expected:
            errors.append(f"drift: {rel} differs from spec renderer output")
    return errors
