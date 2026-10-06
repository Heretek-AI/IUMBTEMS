#!/usr/bin/env python3
"""Style-Dictionary-compat CSS-var compile + pure-render STYLE_GUIDE.

The token dialect is NOT invented here: tokens are plain nested JSON with
``$value`` / ``$type`` / ``$description`` plus ``{dotted.alias}`` references,
the Style-Dictionary-compat input shape [VERIFIED: e3ecfe46] carrying the W3C
DTCG generic-token methodology [VERIFIED: 7f369895]. Compilation emits CSS
custom properties from that single source [VERIFIED: e3ecfe46]; the guide is
a pure function of ``tokens.json`` + contrast-probe output, so drift is
impossible by construction (byte-match + ``--check`` gate).
"""

import json
import re

from runner.queereye import tokens as _tokens

ALIAS_RE = re.compile(r"\{([A-Za-z0-9_][A-Za-z0-9_.\-]*)\}")


def var_name(path):
    """``('color','primitive','brand-500')`` -> ``--color-primitive-brand-500``."""
    return "--" + "-".join(str(p) for p in path)


def alias_to_var_ref(value):
    """Rewrite a pure ``{dotted.ref}`` as ``var(--dotted-ref)``.

    Refuses mixed raw + alias values (``"#ff0000 {alias}"``) with a
    structured :class:`ValueError` — never a silent prefix-preserving
    ``sub`` that would ship ``"--x: #ff0000 var(...)"``. Only pure aliases
    (``is_alias_value``: fullmatch, optional surrounding whitespace) are
    accepted.
    """
    if not isinstance(value, str):
        raise ValueError(
            f"alias value must be a string, got {type(value).__name__}: {value!r}"
        )
    if not _tokens.is_alias_value(value):
        if ALIAS_RE.search(value):
            raise ValueError(
                f"mixed raw + alias value refused: {value!r}; "
                "must be a pure '{dotted.ref}' alias (optional surrounding "
                "whitespace only)"
            )
        raise ValueError(f"not a pure alias value: {value!r}; must be '{{dotted.ref}}'")
    stripped = value.strip()
    match = ALIAS_RE.fullmatch(stripped)
    if not match:  # pragma: no cover — is_alias_value already guarantees fullmatch
        raise ValueError(f"not a pure alias value: {value!r}")
    dotted = match.group(1)
    return "var(--%s)" % dotted.replace(".", "-")


def format_raw_value(value):
    """Format a raw (non-alias) ``$value`` as CSS."""
    if isinstance(value, dict) and set(value.keys()) == {"value", "unit"}:
        return f"{value['value']}{value['unit']}"
    if isinstance(value, (int, float)):
        return str(value)
    return str(value)


def iter_declarations(tree, prefix=()):
    """Yield ``(var_name, css_value, token_path, is_alias)`` sorted by path.

    Pure aliases compile to ``var(--...)``; mixed raw + alias values raise a
    structured :class:`ValueError` naming the token path (never a silent
    ``"#ff0000 var(...)"`` prefix-preserving ship).
    """
    rows = []

    def _walk(node, path):
        if not isinstance(node, dict):
            return
        group_type = node.get("$type") if isinstance(node.get("$type"), str) else None
        _ = group_type
        for key in sorted(node.keys()):
            if key.startswith("$"):
                continue
            child = node[key]
            child_path = path + (key,)
            if _tokens.is_token(child):
                raw = child.get("$value")
                if isinstance(raw, str) and ALIAS_RE.search(raw):
                    try:
                        css = alias_to_var_ref(raw)
                    except ValueError as exc:
                        raise ValueError(f"{'.'.join(child_path)}: {exc}") from exc
                    rows.append((var_name(child_path), css, child_path, True))
                else:
                    rows.append(
                        (var_name(child_path), format_raw_value(raw), child_path, False)
                    )
            elif isinstance(child, dict):
                _walk(child, child_path)

    _walk(tree, prefix)
    rows.sort(key=lambda r: r[0])
    return rows


def compile_to_css_vars(tree, snapshot=None):
    """Compile a token tree to ``:root`` CSS custom properties (deterministic)."""
    snap = snapshot or _tokens.DTCG_SNAPSHOT
    lines = [
        "/* Queereye tokens — Style-Dictionary-compat CSS vars */",
        f"/* DTCG snapshot pin: {snap} (shape pin; clean-room schema, no vendored DTCG JSON) */",
        ":root {",
    ]
    for name, css, _path, _alias in iter_declarations(tree):
        lines.append(f"  {name}: {css};")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def pairs_from_tokens(tree):
    """Text color pairs derived from token color primitives (gate input)."""
    try:
        prim = tree["color"]["primitive"]
    except (KeyError, TypeError):
        return []
    pairs = []
    try:
        pairs.append(
            (
                "body on paper",
                prim["neutral-500"]["$value"],
                prim["paper"]["$value"],
                False,
            )
        )
        pairs.append(
            (
                "brand on paper",
                prim["brand-500"]["$value"],
                prim["paper"]["$value"],
                False,
            )
        )
        pairs.append(
            (
                "body on dark",
                prim["dark-ink"]["$value"],
                prim["dark-surface"]["$value"],
                False,
            )
        )
        if "accent-500" in prim:
            pairs.append(
                (
                    "accent large on paper",
                    prim["accent-500"]["$value"],
                    prim["paper"]["$value"],
                    True,
                )
            )
    except KeyError:
        return []
    return pairs


def render_guide(tree, probe_rows, snapshot=None):
    """Pure render of ``STYLE_GUIDE.md`` from tokens + probe output.

    Deterministic: sorted keys, fixed section order, ``\\n`` newlines. The
    ``--check`` gate byte-compares this output against the committed file.
    """
    from runner.queereye import contrast as _contrast

    snap = snapshot or _tokens.DTCG_SNAPSHOT
    aliased, total, ratio = _tokens.alias_reuse_ratio(tree)
    one_offs = _tokens.find_one_offs(tree)
    lines = []
    lines.append("# STYLE_GUIDE — Queereye tokens")
    lines.append("")
    lines.append(
        f"_Generated from `.queereye/tokens.json` (DTCG snapshot pin `{snap}`) + "
        "contrast-probe output. Do not hand-edit: run the renderer. "
        "W3C Design Tokens Community Group defines design tokens as a "
        "platform-agnostic methodology for expressing design decisions "
        "[VERIFIED: 7f369895]; Style Dictionary automatically generates style "
        "definitions across all platforms from a single source "
        "[VERIFIED: e3ecfe46]._"
    )
    lines.append("")
    lines.append("## Provenance")
    lines.append("")
    lines.append(f"- DTCG snapshot pin: `{snap}`")
    lines.append(f"- Tokens: {total} total, {aliased} aliased, reuse ratio {ratio:.2f}")
    lines.append(f"- One-off raw tokens outside primitive: {len(one_offs)}")
    for path, reason in sorted(one_offs):
        lines.append(f"  - `{path}`: {reason}")
    lines.append(
        "- WCAG 2.2 SC 1.4.3 Contrast (Minimum): body text >= 4.5:1, large >= 3:1 "
        "[VERIFIED: 9c9c4f32]; colors authored from the desired contrast ratio "
        "with the WCAG minimum as the starting point [VERIFIED: 44295aec]."
    )
    lines.append(f"- AAA enhanced (7:1) is reported, never required (gate: AA).")
    lines.append("")
    lines.append("## Tokens")
    lines.append("")
    for path, node, resolved in sorted(
        _tokens.iter_tokens(tree), key=lambda t: ".".join(t[0])
    ):
        dotted = ".".join(path)
        raw = node.get("$value")
        if isinstance(raw, dict):
            raw_s = json.dumps(raw, sort_keys=True)
        else:
            raw_s = str(raw)
        desc = node.get("$description") or ""
        lines.append(
            f"- `{dotted}` (`{resolved}`) = `{raw_s}`" + (f" — {desc}" if desc else "")
        )
    lines.append("")
    lines.append("## Contrast probes")
    lines.append("")
    lines.append("| pair | fg on bg | ratio | AA | AAA 7:1 | result |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for row in probe_rows:
        result = "PASS" if row["pass"] else "FAIL"
        aaa = "yes" if row.get("aaa_pass") else "no"
        lines.append(
            f"| {row['name']} | {row['fg']} on {row['bg']} | "
            f"{row['ratio']:.2f}:1 | {row['aa_threshold']}:1 | {aaa} | {result} |"
        )
    lines.append("")
    lines.append("## CSS vars (Style-Dictionary-compat compile)")
    lines.append("")
    lines.append("```css")
    lines.append(compile_to_css_vars(tree, snapshot=snap).rstrip("\n"))
    lines.append("```")
    lines.append("")
    # Threshold constants for auditability.
    lines.append(
        f"<!-- thresholds: AA-normal={_contrast.WCAG_AA_NORMAL} "
        f"AA-large={_contrast.WCAG_AA_LARGE} AAA={_contrast.WCAG_AAA_ENHANCED} -->"
    )
    lines.append("")
    return "\n".join(lines)
