#!/usr/bin/env python3
"""DTCG-shaped token schema: validation, alias resolution, reuse accounting.

The token dialect is deliberately NOT invented here: tokens are plain nested
JSON with ``$value`` / ``$type`` / ``$description`` plus ``{dotted.alias}``
references, which is the Style-Dictionary-compat input shape
[VERIFIED: e3ecfe46] carrying the W3C DTCG generic-token methodology
[VERIFIED: 7f369895]. The spec reserves ``$value`` (an object with a
``$value`` property is a token) and defines aliasing [VERIFIED: 12c70178].

Snapshot pin: the module records the DTCG snapshot this shape targets
(``DTCG_SNAPSHOT``). Tokens themselves stay plain Style-Dictionary-compat
JSON (no rival ``$meta`` dialect is required); provenance is rendered into
``probes.json`` / ``STYLE_GUIDE.md`` headers instead.
"""

import re

#: DTCG snapshot the schema shape is pinned to (phase dossier §2).
DTCG_SNAPSHOT = "2025.10"

#: ``{group.sub.name}`` alias references (DTCG aliasing [VERIFIED: 12c70178]).
ALIAS_PATTERN = re.compile(r"\{([A-Za-z0-9_][A-Za-z0-9_.\-]*)\}")

#: Allowlisted primitive domains: the only top-level token groups that may
#: mint raw values under ``<domain>.primitive.<name>``. Derived from the
#: SlotLoop axes (interview forms [VERIFIED: eb45e3dd]): color->color,
#: type->type, layout->space/radius, effects->motion, dark_light->modes;
#: brand/a11y emit no primitives. Case-sensitive exact: "Primitive",
#: "", " ", unicode lookalikes, and arbitrary "evil" domains are NOT
#: exempt and are flagged as one-offs.
PRIMITIVE_DOMAINS = frozenset({"color", "type", "space", "radius", "motion", "modes"})


#: Allowlisted ``$`` keys: the DTCG-shaped dialect only defines
#: ``$value`` / ``$type`` / ``$description``. Any other ``$``-prefixed key
#: (notably a rival ``$meta`` dialect) is refused — never silently skipped.
ALLOWED_DOLLAR_KEYS = frozenset({"$value", "$type", "$description"})


class CircularAliasError(ValueError):
    """Raised when an alias chain resolves back to itself (MUST-error)."""


class UnknownAliasError(ValueError):
    """Raised when an alias reference names a path that does not exist."""


def is_token(node):
    """True when ``node`` is a token: an object with a ``$value`` property."""
    return isinstance(node, dict) and "$value" in node


def is_alias_value(value):
    """True when ``$value`` is a pure alias: a single ``{dotted.ref}`` with
    optional surrounding whitespace only (fullmatch).

    Mixed raw + alias values (``"#ff0000 {alias}"``, ``"{alias} suffix"``,
    ``"prefix-{alias}"``) are NOT aliases: they return False here so the
    one-off gate flags them. Uses ``fullmatch`` on the stripped value, not
    ``search`` (``search`` previously laundered ``"#ff0000 {alias}"`` past
    :func:`find_one_offs`).
    """
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    if not stripped:
        return False
    return bool(ALIAS_PATTERN.fullmatch(stripped))


def is_mixed_alias_value(value):
    """True when ``$value`` embeds an alias plus raw text (mixed).

    Contains at least one ``{ref}`` but is not a pure alias: prefix, suffix,
    or hyphen-affixed raw text around the braces. Mixed values must be
    flagged as one-off / invalid, never silently compiled.
    """
    return (
        isinstance(value, str)
        and bool(ALIAS_PATTERN.search(value))
        and not is_alias_value(value)
    )


def alias_refs(value):
    """Dotted alias paths referenced by a ``$value`` (empty for raw values)."""
    if not isinstance(value, str):
        return []
    return ALIAS_PATTERN.findall(value)


def resolve_type(node, inherited=None):
    """Type-resolution order: token ``$type`` wins, else group ``$type``."""
    own = node.get("$type") if isinstance(node, dict) else None
    if isinstance(own, str) and own.strip():
        return own
    return inherited


def iter_tokens(tree, prefix=(), inherited_type=None):
    """Yield ``(path, node, resolved_type)`` for every token in ``tree``."""
    # Lists are traversed so list-smuggled tokens cannot hide (dicts-only
    # traversal previously laundered them).
    if isinstance(tree, list):
        for _idx, _item in enumerate(tree):
            _p = prefix + (f"[{_idx}]",)
            if is_token(_item):
                yield (_p, _item, resolve_type(_item, inherited_type))
            elif isinstance(_item, (dict, list)):
                yield from iter_tokens(_item, _p, inherited_type)
        return
    if not isinstance(tree, dict):
        return
    group_type = (
        tree.get("$type") if isinstance(tree.get("$type"), str) else inherited_type
    )
    for key, child in tree.items():
        if isinstance(key, str) and key.startswith("$"):
            continue
        if is_token(child):
            yield (prefix + (key,), child, resolve_type(child, group_type))
        elif isinstance(child, dict):
            yield from iter_tokens(child, prefix + (key,), group_type)
        elif isinstance(child, list):
            yield from iter_tokens(child, prefix + (key,), group_type)


def _walk_path(root, ref):
    node = root
    for segment in ref.split("."):
        if not isinstance(node, dict) or segment not in node:
            raise UnknownAliasError(
                f"alias {{{ref}}} does not resolve: missing {segment!r}"
            )
        node = node[segment]
    return node


def resolve_alias(root, ref, _seen=None):
    """Follow one alias reference through chains to its raw value.

    Raises :class:`CircularAliasError` on cycles and
    :class:`UnknownAliasError` on dangling references.
    """
    seen = tuple(_seen or ())
    if ref in seen:
        raise CircularAliasError(
            "circular alias chain: " + " -> ".join(["{%s}" % s for s in seen + (ref,)])
        )
    target = _walk_path(root, ref)
    value = target.get("$value") if is_token(target) else target
    if is_alias_value(value):
        refs = alias_refs(value)
        if len(refs) == 1 and value.strip() == "{%s}" % refs[0]:
            return resolve_alias(root, refs[0], seen + (ref,))
        resolved = value
        for sub in refs:
            resolved = resolved.replace(
                "{%s}" % sub, str(resolve_alias(root, sub, seen + (ref,)))
            )
        return resolved
    if is_token(target):
        return target.get("$value")
    return target


def validate_tokens(tree):
    """Validate a token tree against the DTCG-shaped schema.

    Returns a list of error strings (empty = valid). Checks:
    - every token resolves a non-empty ``$type`` (token-level or inherited
      from the nearest group carrying ``$type``);
    - ``$description``, when present, is a string;
    - every alias reference resolves (dangling and circular chains are
      errors, never warnings);
    - mixed raw + alias values (``"#ff0000 {alias}"``) are invalid: the
      value must be a pure ``{dotted.ref}`` alias (fullmatch, optional
      surrounding whitespace only);
    - unknown ``$``-prefixed keys (notably a rival ``$meta`` dialect) are
      refused, never silently skipped (only
      ``$value``/``$type``/``$description`` allowed).
    """
    errors = []
    if not isinstance(tree, dict):
        return ["tokens root must be an object"]
    errors.extend(_unknown_dollar_errors(tree, ()))
    for path, node, resolved in iter_tokens(tree):
        dotted = ".".join(path)
        if not isinstance(resolved, str) or not resolved.strip():
            errors.append(
                f"{dotted}: missing $type (no token $type and no group $type)"
            )
        desc = node.get("$description")
        if desc is not None and not isinstance(desc, str):
            errors.append(f"{dotted}: $description must be a string")
        value = node.get("$value")
        if is_mixed_alias_value(value):
            errors.append(
                f"{dotted}: mixed raw + alias $value {value!r} "
                "must be a pure '{dotted.ref}' alias (optional surrounding "
                "whitespace only)"
            )
        for ref in alias_refs(value):
            try:
                resolve_alias(tree, ref)
            except (CircularAliasError, UnknownAliasError) as exc:
                errors.append(f"{dotted}: {exc}")
    return errors


def _unknown_dollar_errors(node, prefix):
    """Unknown ``$``-key errors under ``node`` (rival ``$meta`` refused)."""
    errors = []
    # Lists are traversed so list-smuggled $ keys cannot hide (dicts-only
    # traversal previously laundered [{"$meta": ...}]).
    if isinstance(node, list):
        for _idx, _item in enumerate(node):
            if isinstance(_item, (dict, list)):
                errors.extend(_unknown_dollar_errors(_item, prefix + (f"[{_idx}]",)))
        return errors
    if not isinstance(node, dict):
        return errors
    for key in node:
        if isinstance(key, str) and key.startswith("$"):
            if key not in ALLOWED_DOLLAR_KEYS:
                dotted = ".".join(prefix) if prefix else "<root>"
                errors.append(
                    f"{dotted}: unknown $ key {key!r} refused "
                    "(only $value/$type/$description allowed; "
                    "$meta dialect not required)"
                )
    for key, child in node.items():
        _is_dollar = isinstance(key, str) and key.startswith("$")
        # Dict-valued $value ({"$value": {"$meta": "x"}}) must be visited
        # inside for $ keys: only $value is traversed, other $ keys skipped.
        if _is_dollar and key != "$value":
            continue
        _child_prefix = prefix + (key,) if isinstance(key, str) else prefix
        if isinstance(child, dict):
            errors.extend(_unknown_dollar_errors(child, _child_prefix))
        elif isinstance(child, list):
            for _idx, _item in enumerate(child):
                if isinstance(_item, (dict, list)):
                    errors.extend(
                        _unknown_dollar_errors(_item, _child_prefix + (f"[{_idx}]",))
                    )
    return errors


def _is_primitive_path(path):
    """Raw values may only live under a ``<domain>.primitive.<name>`` group.

    Exempt shape is exactly depth-3 ``(domain, "primitive", name)`` with
    ``domain`` in the allowlisted :data:`PRIMITIVE_DOMAINS` set
    (case-sensitive exact, e.g. ``color.primitive.brand-500``), matching the
    Style-Dictionary primitive -> semantic -> component layering
    [VERIFIED: e3ecfe46]. A top-level ``primitive.<name>`` group (depth-2,
    domain == ``primitive``) is NOT exempt: it previously laundered raw
    values past :func:`find_one_offs`. Arbitrary domains (``evil``,
    ``""``, ``"Primitive"``, ``" "``, unicode lookalikes) are NOT exempt:
    the old ``domain != "primitive"`` blocklist allowed any domain; the
    allowlist refuses everything outside the known axes-derived set.
    Deeper nesting (depth != 3) is also refused so
    ``primitive.primitive.x`` or ``color.primitive.nested.deep`` cannot
    smuggle raw values.
    """
    if len(path) != 3:
        return False
    domain, layer, _name = path
    return layer == "primitive" and domain in PRIMITIVE_DOMAINS


def find_one_offs(tree):
    """Tokens with raw ``$value`` outside ``primitive`` groups.

    A one-off mint is a compile error, not a review note (phase dossier §2):
    every semantic/component token must alias a primitive. Mixed raw + alias
    values (``is_mixed_alias_value``) are always one-offs — even under a
    primitive path — with a mixed-specific reason; any domain outside
    :data:`PRIMITIVE_DOMAINS` is NOT exempt so ``evil.primitive.*`` raws
    are flagged.
    """
    one_offs = []
    for path, node, _resolved in iter_tokens(tree):
        value = node.get("$value")
        dotted = ".".join(path)
        if is_mixed_alias_value(value):
            one_offs.append(
                (
                    dotted,
                    "mixed raw + alias $value must be a pure '{dotted.ref}' alias",
                )
            )
        elif not is_alias_value(value) and not _is_primitive_path(path):
            one_offs.append((dotted, "raw $value outside a primitive group"))
    return one_offs


def alias_reuse_ratio(tree):
    """``(aliased, total, ratio)`` over all tokens in ``tree``."""
    total = 0
    aliased = 0
    for _path, node, _resolved in iter_tokens(tree):
        total += 1
        if is_alias_value(node.get("$value")):
            aliased += 1
    ratio = (aliased / total) if total else 1.0
    return (aliased, total, ratio)


def count_tokens(tree):
    """Total token count (primitives + aliases)."""
    return sum(1 for _ in iter_tokens(tree))
