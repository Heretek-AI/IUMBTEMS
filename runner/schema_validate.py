#!/usr/bin/env python3
"""Dependency-free JSON Schema subset validator.

The package must not pull in `jsonschema` (no auto-installing deps), so this
supports the subset `runner/schemas.py` actually uses: `type` (incl. unions),
`required`, `properties`, `items`, `enum`. Unknown keys are allowed on purpose —
contracts evolve and a new optional field must not fail a run.

Validation is advisory: `_load_agent_dossier` warns and keeps going (#6 item 2.1).
"""

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
