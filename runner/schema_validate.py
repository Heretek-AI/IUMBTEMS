#!/usr/bin/env python3
"""Dependency-free JSON Schema subset validator.

The package must not pull in `jsonschema` (no auto-installing deps), so this
supports the subset `runner/schemas.py` actually uses: `type` (incl. unions),
`required`, `properties`, `items`, `enum`, `additionalProperties`,
`minimum`, `maximum`, `minLength`, `pattern`. Unknown keys are allowed on
purpose — contracts evolve and a new optional field must not fail a run.

Range checks reject non-finite floats explicitly: Python's `json` module accepts
bare `NaN`/`Infinity` literals, and a NaN would otherwise slip past ordinary
comparisons.

Validation is advisory: `_load_agent_dossier` warns and keeps going (#6 item 2.1).
`skills/swarm_config/configure.py` uses it as the save-time gate, where it is
enforced.

`pattern` strings stay ECMA-anchored (`$`, never `\\Z`): the same strings ship
in `schemas/*.schema.json` and `plugins/opencode/*`, where JS `new
RegExp(pattern).test()` interprets them — and in JS `\\Z` is an identity
escape matching a literal "Z", so a `\\Z` in the shared string would break
the JS side. Python's `re` `$` instead also matches before a trailing
newline ("https://example.com\n" would pass Python but fail JS), so at
match time `_ecma_to_python_pattern` rewrites each unescaped `$` outside
`[...]` to `\\Z` (JS `$` without the `m` flag == Python `\\Z`). Schema
strings are untouched; `gen_schemas --check` stays green by construction.
"""

import math
import re
from typing import Any, Dict, List

_TYPE_MAP = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "number": (int, float),
    "integer": int,
    "null": type(None),
}


def _type_matches(value: Any, expected: str) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    py = _TYPE_MAP.get(expected)
    return py is not None and isinstance(value, py)


def _ecma_to_python_pattern(pattern: str) -> str:
    """Rewrite ECMA `$` anchors to Python `\\Z` for JS-identical verdicts.

    Neither side uses multiline: JS `$` (no `m` flag) matches only at the
    true end of input, while Python `$` also matches before a trailing
    newline. Rewriting preserves `re.search` (JSON Schema `pattern` is an
    unanchored search, like JS `RegExp.test`) and leaves the stored schema
    string untouched. Escaped `\\$` and `$` inside `[...]` classes pass
    through unchanged.
    """
    out: List[str] = []
    escaped = False
    in_class = False
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if escaped:
            out.append(ch)
            escaped = False
        elif ch == "\\":
            out.append(ch)
            escaped = True
        elif ch == "[" and not in_class:
            out.append(ch)
            in_class = True
        elif ch == "]" and in_class:
            out.append(ch)
            in_class = False
        elif ch == "$" and not in_class:
            out.append("\\Z")
        else:
            out.append(ch)
        i += 1
    if escaped:
        out.append("\\")
    return "".join(out)


def validate(data: Any, schema: Dict[str, Any], path: str = "") -> List[str]:
    """Return human-readable violations (dotted paths). Empty list == valid."""
    if not isinstance(schema, dict):
        return []
    problems: List[str] = []

    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_type_matches(data, t) for t in types):
            return [
                f"{path or '<root>'}: expected {'|'.join(types)}, got {type(data).__name__}"
            ]

    if isinstance(data, dict):
        for key in schema.get("required", []):
            if key not in data:
                problems.append(f"{path or '<root>'}: missing required key '{key}'")
        for key, subschema in (schema.get("properties") or {}).items():
            if key in data:
                child = f"{path}.{key}" if path else key
                problems.extend(validate(data[key], subschema, child))
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            known = set((schema.get("properties") or {}).keys())
            for key, value in data.items():
                if key not in known:
                    child = f"{path}.{key}" if path else key
                    problems.extend(validate(value, additional, child))
        enum = schema.get("enum")
        if enum is not None and data not in enum:
            problems.append(f"{path or '<root>'}: value {data!r} not in enum {enum}")

    if isinstance(data, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(data):
            problems.extend(validate(item, schema["items"], f"{path}[{i}]"))

    if not isinstance(data, (dict, list)):
        enum = schema.get("enum")
        if enum is not None and data not in enum:
            problems.append(f"{path or '<root>'}: value {data!r} not in enum {enum}")

    if isinstance(data, (int, float)) and not isinstance(data, bool):
        if isinstance(data, float) and not math.isfinite(data):
            # Python's json accepts bare NaN/Infinity literals; a non-finite
            # number can never satisfy a bounded contract.
            problems.append(f"{path or '<root>'}: value {data!r} is not finite")
        else:
            # WAIVER W22 (F2, Phase 06 `06-parity` REWORK retry 2/3, manager
            # tiebreak binding): `{data!r}` here is CPython shortest-repr
            # (`1e-05`, `1e+16`), while the JS side renders via `String()`
            # (`0.00001`, `10000000000000000`) — the exponential float
            # rendering class diverges on BOTH paths by repr SELECTION
            # thresholds, not just padding, so the JS side must NOT pad
            # (whack-a-mole per second opinion ses_f0b4aa769ffeE0zpoe9la477dw).
            # Pinned by `test_w22_exponential_rendering_waiver`. TRIGGER:
            # revisit only via a port of CPython shortest-repr switching,
            # and only if exponential config values occur
            # (see .roadmap/06-parity/waivers.md W22).
            minimum = schema.get("minimum")
            if minimum is not None and data < minimum:
                problems.append(
                    f"{path or '<root>'}: value {data!r} is below minimum {minimum!r}"
                )
            maximum = schema.get("maximum")
            if maximum is not None and data > maximum:
                problems.append(
                    f"{path or '<root>'}: value {data!r} is above maximum {maximum!r}"
                )

    if isinstance(data, str):
        min_length = schema.get("minLength")
        if min_length is not None and len(data) < min_length:
            problems.append(
                f"{path or '<root>'}: string shorter than minLength {min_length!r}"
            )
        pattern = schema.get("pattern")
        if (
            isinstance(pattern, str)
            and re.search(_ecma_to_python_pattern(pattern), data) is None
        ):
            problems.append(
                f"{path or '<root>'}: value {data!r} does not match pattern {pattern!r}"
            )

    return problems


def validate_named(name: str, data: Any) -> List[str]:
    """Validate against a named schema from runner/schemas.py."""
    from runner.schemas import SCHEMAS

    schema = SCHEMAS.get(name)
    if schema is None:
        return []
    return [f"{name}: {p}" for p in validate(data, schema)]


def check_dossier(dossier: Any, role: str) -> List[str]:
    name = "alpha_dossier" if role.lower().startswith("alpha") else "beta_dossier"
    return validate_named(name, dossier)
