#!/usr/bin/env python3
"""Leonardo-style contrast-ratio-first color gate.

Colors are authored from the desired contrast ratio with the WCAG minimum as
the starting point [VERIFIED: 44295aec]: every text color pair ships a
computed ratio that must hold at least 4.5:1 for body text (3:1 for
large-scale text) [VERIFIED: 9c9c4f32]. The 7:1 AAA enhanced level is
reported (noted, never silently required).
"""

import math
import re

#: WCAG 2.2 SC 1.4.3 Contrast (Minimum) thresholds [VERIFIED: 9c9c4f32].
WCAG_AA_NORMAL = 4.5
WCAG_AA_LARGE = 3.0
#: AAA enhanced level: reported by probes, never a hard gate.
WCAG_AAA_ENHANCED = 7.0

_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


class ContrastError(ValueError):
    """A color pair failed the contrast gate (a compile error)."""


def parse_hex(value):
    """Parse ``#rgb`` / ``#rrggbb`` into an ``(r, g, b)`` 0-255 tuple."""
    if not isinstance(value, str) or not _HEX_RE.match(value.strip()):
        raise ContrastError(f"not a hex color: {value!r}")
    text = value.strip()[1:]
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def _linearize(channel):
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb):
    """WCAG relative luminance of an ``(r, g, b)`` tuple."""
    r, g, b = rgb
    return 0.2126 * _linearize(r) + 0.7152 * _linearize(g) + 0.0722 * _linearize(b)


def contrast_ratio(fg_hex, bg_hex):
    """WCAG contrast ratio of two hex colors (1.0 - 21.0)."""
    lum_fg = relative_luminance(parse_hex(fg_hex))
    lum_bg = relative_luminance(parse_hex(bg_hex))
    lighter = max(lum_fg, lum_bg)
    darker = min(lum_fg, lum_bg)
    return (lighter + 0.05) / (darker + 0.05)


def required_ratio(large_text=False):
    """AA threshold for the text class [VERIFIED: 9c9c4f32]."""
    return WCAG_AA_LARGE if large_text else WCAG_AA_NORMAL


def validate_pair(fg_hex, bg_hex, large_text=False, decorative=False):
    """Gate one text color pair. Returns ``(ratio, required, errors)``.

    A pair claimed as merely decorative is still rejected when it fails the
    threshold: the decorative exemption never excuses a text pair, so a
    decorative-but-inaccessible combination is a compile error, not a
    waiver. ``errors`` is empty exactly when the pair passes.
    """
    ratio = contrast_ratio(fg_hex, bg_hex)
    threshold = required_ratio(large_text)
    errors = []
    if ratio < threshold:
        kind = "large text" if large_text else "body text"
        errors.append(
            f"{fg_hex} on {bg_hex}: {ratio:.2f}:1 below AA {kind} minimum {threshold}:1"
        )
        if decorative:
            errors.append("decorative exemption refused for a text pair")
    return (ratio, threshold, errors)


def ensure_ratio(fg_hex, bg_hex, target=WCAG_AA_NORMAL):
    """Ratio-first generation: nudge ``fg`` until ``target`` holds.

    Mixes the foreground toward black or toward white (whichever reaches the
    target first, preferring the smaller move) so generated palettes start
    from the desired contrast ratio [VERIFIED: 44295aec]. Returns the
    adjusted hex, or the original when it already passes. Raises
    :class:`ContrastError` when no mix reaches the target (unreachable for
    any opaque pair against black/white, so this signals a bad input).
    """
    if contrast_ratio(fg_hex, bg_hex) >= target:
        return fg_hex.lower()
    fg = parse_hex(fg_hex)
    best = None
    for anchor in ((0, 0, 0), (255, 255, 255)):
        lo, hi = 0.0, 1.0
        candidate = None
        for _ in range(24):
            mid = (lo + hi) / 2.0
            mixed = tuple(round(f + (a - f) * mid) for f, a in zip(fg, anchor))
            hexed = "#%02x%02x%02x" % mixed
            if contrast_ratio(hexed, bg_hex) >= target:
                candidate = (mid, hexed)
                hi = mid
            else:
                lo = mid
        if candidate is not None and (best is None or candidate[0] < best[0]):
            best = candidate
    if best is None:
        raise ContrastError(f"no mix of {fg_hex} on {bg_hex} reaches {target}:1")
    return best[1]


def probe_report(pairs):
    """Probe table rows for ``[(name, fg, bg, large_text)]``.

    Each row carries the computed ratio, the AA threshold, the AAA note,
    and pass/fail. Pure data for the guide renderer (no I/O).
    """
    rows = []
    for item in pairs:
        name, fg, bg = item[0], item[1], item[2]
        large = bool(item[3]) if len(item) > 3 else False
        ratio, threshold, errors = validate_pair(fg, bg, large_text=large)
        rows.append(
            {
                "name": name,
                "fg": fg,
                "bg": bg,
                "large_text": large,
                "ratio": round(ratio, 2),
                "aa_threshold": threshold,
                "aaa_enhanced": WCAG_AAA_ENHANCED,
                "aaa_pass": ratio >= WCAG_AAA_ENHANCED,
                "pass": not errors,
                "errors": errors,
            }
        )
    return rows


def gate_pairs(pairs):
    """Fail-fast gate over probe rows: returns failing rows (empty = green)."""
    return [row for row in probe_report(pairs) if not row["pass"]]
