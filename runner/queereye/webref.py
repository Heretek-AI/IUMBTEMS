#!/usr/bin/env python3
"""Web reference pin: single MIT snapshot + transform-group registry.

Phase queereye-02-component-specs (run queereye-style-guide).

- The pin target is shadcn-style prop-driven markup: variant/size props
  over generic markup are the ideal spec pin [VERIFIED: dc656fd4], with the
  cva variant/size matrix variant
  default/outline/ghost/destructive/secondary/link x size
  default/xs/sm/lg/icon [VERIFIED: c24a9c9c].
- The snapshot is vendored content-addressed (sha256 + SPDX) and is NEVER a
  live URL: a rot probe mutating any URL-shaped string must leave the
  snapshot hash unchanged (snapshot immune by construction).
- The transform-group registry mirrors the Style-Dictionary config model
  (named groups of transforms: css-vars / scss / android-style), carrying
  attribution instead of vendored upstream bytes beyond the clean-room
  snapshot.
- License gate: permissive-only depend/vendor (MIT/Apache-2.0/BSD-3-Clause/
  ISC enforced); GPL/AGPL are clean-room-only (spec-rebuild, never bytes).

Zero runtime dependencies (stdlib only). No network ingest.
"""

import hashlib
import json
import re
from datetime import date

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


#: Domain vocabulary for rebuild-proof notes (mirrors tui allowlist).
_NOTE_ALLOWLIST = frozenset({
    "button", "dialog", "input", "form", "trigger", "overlay", "content",
    "title", "description", "close", "label", "field", "hint", "error",
    "icon", "spinner", "root", "portal",
    "empty", "loading", "disabled", "downgrade", "row", "applicable",
    "aria", "announcement", "focus", "keyboard", "event", "loop", "region",
    "border", "motion", "blur", "hover", "slot", "component", "spec",
    "state", "web", "tui", "rebuild", "rebuilt", "behavior", "behaviour",
    "clean", "room", "upstream", "bytes", "vendored", "snapshot", "hash",
    "spdx", "license", "mit", "gpl", "agpl", "vendor", "depend", "skip",
    "no", "not", "single", "explicit", "status", "text", "plain",
    "keybinding", "modal", "trap", "pointer", "screen", "reader", "reduced",
    "proof", "note", "spec-rebuild", "never",
})


def _note_has_semantic_phrase(note):
    """True when a rebuild-proof note carries a semantic phrase."""
    if not isinstance(note, str):
        return False
    stripped = _strip_hardened(note)
    if len(stripped) < 20:
        return False
    words = re.findall(r"[A-Za-z]{2,}", stripped)
    if len(words) < 3:
        return False
    distinct = set(w.lower() for w in words)
    if len(distinct) < 3:
        return False
    allow_hits = len(distinct & _NOTE_ALLOWLIST)
    if allow_hits >= 2:
        good = [w for w in distinct if len(set(w)) >= 3 and len(w) >= 3]
        if len(good) >= 2 and len(distinct) >= 3:
            return True
    good = [w for w in distinct if len(set(w)) >= 3 and len(w) >= 3]
    if len(distinct) >= 4 and len(good) >= 3:
        return True
    return False


#: Permissive whitelist for depend/vendor (phase-03 harvest uses the same
#: set; GPL/AGPL are clean-room-only and rejected here as vendor inputs).
LICENSE_WHITELIST = frozenset({"MIT", "Apache-2.0", "BSD-3-Clause", "ISC"})

#: Upper-cased view for case-insensitive SPDX matching (mit == MIT).
_WHITELIST_UPPER = frozenset(s.upper() for s in LICENSE_WHITELIST)

#: Copyleft ids that may only enter as clean-room behavior specs, never bytes.
COPYLEFT_IDS = frozenset(
    {"GPL-2.0-only", "GPL-3.0-only", "AGPL-3.0-only", "GPL", "AGPL"}
)

#: Upper-cased copyleft view for case-insensitive matching.
_COPYLEFT_UPPER = frozenset(s.upper() for s in COPYLEFT_IDS)

#: Snapshot pin date (ISO). Freshness gate compares ``today - pinned_on``.
WEBREF_PINNED_ON = "2026-10-05"

#: Freshness budget in days (snapshot older than this fails ``--strict``).
WEBREF_MAX_AGE_DAYS = 180

#: Snapshot display name (shadcn-style, prop-driven [VERIFIED: dc656fd4]).
WEBREF_NAME = "queereye-webref-button"

#: Live-URL pattern: the snapshot must never contain one (vendored bytes
#: only; upstream cited by name + SPDX, not by URL fetch). Case-insensitive
#: (HTTPS:// bypass refused) plus protocol-relative (//evil bypass refused);
#: the `//` alternative requires a non-space tail so `// comment` lines with
#: a space after `//` do not false-positive.
_LIVE_URL_RE = re.compile(r"(?:https?://|//)[^\s\"'<>]+", re.IGNORECASE)

#: Clean-room snapshot files: a minimal prop-driven button (variant/size
#: props over generic markup [VERIFIED: dc656fd4]) rebuilt from the cva
#: matrix [VERIFIED: c24a9c9c]. Upstream behavior cited, bytes authored here.
SNAPSHOT_FILES = {
    "button-variants.js": (
        "// SPDX-License-Identifier: MIT\n"
        "// Clean-room prop-driven variant map (cva matrix [VERIFIED: c24a9c9c]).\n"
        "// Upstream behavior: shadcn-style buttonVariants [VERIFIED: dc656fd4].\n"
        "export const buttonVariants = {\n"
        '  variant: ["default","outline","ghost","destructive","secondary","link"],\n'
        '  size: ["default","xs","sm","lg","icon"],\n'
        '  defaultVariant: "default",\n'
        '  defaultSize: "default",\n'
        "};\n"
    ),
    "button.html": (
        "<!-- SPDX-License-Identifier: MIT -->\n"
        '<button class="btn" data-variant="default" data-size="default">Save</button>\n'
    ),
}

#: Transform-group registry mirroring the Style-Dictionary config model:
#: named groups of ordered transforms with platform + attribution. No
#: upstream config bytes vendored; group names + transform lists rebuilt
#: clean-room from the documented model.
TRANSFORM_GROUPS = {
    "css-vars": {
        "platform": "css",
        "transforms": ["attribute/cti", "name/kebab", "color/css", "size/px"],
        "attribution": "Style-Dictionary transform-group model (config-shape reference)",
    },
    "scss": {
        "platform": "scss",
        "transforms": ["attribute/cti", "name/snake", "color/css", "size/px"],
        "attribution": "Style-Dictionary transform-group model (config-shape reference)",
    },
    "android-style": {
        "platform": "android",
        "transforms": ["attribute/cti", "name/snake", "color/hex8", "size/dp"],
        "attribution": "Style-Dictionary transform-group model (config-shape reference)",
    },
}


def snapshot_bytes(files=None):
    """Deterministic snapshot bytes: sorted ``name + \\n + content`` join."""
    files = files if files is not None else SNAPSHOT_FILES
    if not isinstance(files, dict):
        raise TypeError("webref snapshot files must be an object (non-dict refused)")
    chunks = []
    for name in sorted(files):
        content = files[name]
        if not isinstance(content, str):
            raise TypeError(
                f"webref {name!r} snapshot content must be a string "
                "(non-string refused; type-guard)"
            )
        chunks.append(f"=== {name} ===\n")
        chunks.append(content)
        if not content.endswith("\n"):
            chunks.append("\n")
    return "".join(chunks).encode("utf-8")


def snapshot_hash(files=None):
    """SHA-256 hex of the canonical snapshot bytes (content address)."""
    return hashlib.sha256(snapshot_bytes(files)).hexdigest()


def spdx_block():
    """SPDX attribution block for the vendored snapshot (MIT)."""
    return (
        f"SPDX-License-Identifier: MIT\n"
        f"Snapshot: {WEBREF_NAME}\n"
        f"Content-SHA256: {snapshot_hash()}\n"
        f"Pinned-On: {WEBREF_PINNED_ON}\n"
        "Upstream-Behavior: shadcn-style prop-driven variants [VERIFIED: dc656fd4]\n"
        "Distribution: copy-own snapshot (vendored bytes, never a live URL)\n"
    )


def webref_manifest(files=None):
    """Machine manifest for ``.queereye/webref.json`` (hash + SPDX)."""
    files = files if files is not None else SNAPSHOT_FILES
    return {
        "name": WEBREF_NAME,
        "license": "MIT",
        "spdx": "MIT",
        "snapshot_hash": snapshot_hash(files),
        "pinned_on": WEBREF_PINNED_ON,
        "max_age_days": WEBREF_MAX_AGE_DAYS,
        "files": sorted(files),
        "transform_groups": sorted(TRANSFORM_GROUPS),
        "distribution": "copy-own snapshot (never a live URL)",
        "evidence": {"shadcn_pin": "dc656fd4", "cva_matrix": "c24a9c9c"},
    }


def license_gate(license_id, action, note=None):
    """License gate for one (license, action) pair. Returns error list.

    ``vendor``/``depend`` require the permissive whitelist (case-insensitive:
    ``mit`` == ``MIT``); GPL/AGPL are clean-room-only so ``vendor``/``depend``
    /``skip`` refuse them; unknown SPDX ids (e.g. ``EVIL``) are refused for
    ALL actions including ``clean-room``/``skip`` (known SPDX required);
    ``clean-room`` passes for known ids with a spec-rebuild note (when a
    ``note`` is supplied it must carry a semantic phrase (>=20 chars +
    allowlist/distinct words; 'xxxx xxxxx' gibberish refused).
    Empty and ``PROPRIETARY`` as ``clean-room``/``skip`` is refused (rebuild
    proof required, never silent).
    """
    lic = _strip_hardened(str(license_id or ""))
    act = _strip_hardened(str(action or "")).lower()
    if not lic:
        return [f"license gate: empty license refused for {act or action!r}"]
    if lic.upper() == "PROPRIETARY" and act in ("clean-room", "skip"):
        return [
            f"license gate: {lic!r} is never clean-room/skip "
            "(proprietary bytes require rebuild proof; refused)"
        ]
    lic_upper = lic.upper()
    is_allowlisted = lic_upper in _WHITELIST_UPPER
    is_copyleft = lic_upper in _COPYLEFT_UPPER or lic_upper.startswith(("GPL", "AGPL"))
    is_known = is_allowlisted or is_copyleft
    if act == "clean-room":
        if not is_known:
            return [
                f"license gate: unknown license {lic!r} refused for clean-room "
                "(known SPDX required; rebuild proof refused)"
            ]
        if note is not None:
            if not isinstance(note, str) or not _strip_hardened(note):
                return [
                    f"license gate: clean-room {lic!r} requires rebuild proof "
                    "note (blank/zero-width refused; waivers carry conditions)"
                ]
            if not _note_has_semantic_phrase(note):
                return [
                    f"license gate: clean-room {lic!r} requires rebuild proof "
                    "note (>=20 chars + semantic phrase; 'xxxx xxxxx' "
                    "gibberish refused; waivers carry conditions)"
                ]
        return []
    if act in ("vendor", "depend"):
        if is_allowlisted:
            return []
        if is_copyleft:
            return [
                f"license gate: {lic!r} is clean-room-only; "
                f"{act} refused (permissive-only: {sorted(LICENSE_WHITELIST)})"
            ]
        return [f"license gate: unknown license {lic!r} refused for {act}"]
    if act == "skip":
        if is_allowlisted:
            return []
        if is_copyleft:
            return [
                f"license gate: {lic!r} is clean-room-only; "
                f"skip refused (use clean-room with rebuild proof)"
            ]
        return [f"license gate: unknown license {lic!r} refused for skip"]
    return [f"license gate: unknown action {action!r}"]


def verify_snapshot(manifest, files=None):
    """Verify a webref manifest against local bytes. Returns error list.

    Checks: snapshot files object with string contents (type-guard: non-string
    values are structured errors, never AttributeError), hash matches
    recomputed snapshot, SPDX MIT, file list matches, no live URL inside
    snapshot bytes (rot-immune by construction).
    """
    errors = []
    files = files if files is not None else SNAPSHOT_FILES
    if not isinstance(manifest, dict):
        return ["webref manifest must be an object"]
    if not isinstance(files, dict):
        return ["webref snapshot files must be an object (non-dict refused)"]
    # Type-guard snapshot values before hashing (non-string -> structured
    # error, never AttributeError from .endswith/.search).
    for _sname, _content in list(files.items()):
        if not isinstance(_sname, str) or not _strip_hardened(_sname):
            errors.append(
                f"webref snapshot file name {_sname!r} must be a stripped "
                "non-empty string"
            )
        if not isinstance(_content, str):
            errors.append(
                f"webref {_sname!r} snapshot content must be a string "
                "(non-string refused; type-guard)"
            )
    if any(not isinstance(_c, str) for _c in files.values()):
        # Still surface SPDX/file-list gates alongside the type error, but
        # skip hash/live-URL compares that would crash on non-strings.
        if manifest.get("spdx") != "MIT" or manifest.get("license") != "MIT":
            errors.append("webref must carry SPDX MIT (spdx + license fields)")
        try:
            _file_keys = sorted(files)
        except TypeError:
            errors.append("webref file list contains unorderable keys")
        else:
            if sorted(manifest.get("files", [])) != _file_keys:
                errors.append("webref file list differs from vendored snapshot")
        return errors
    expected = snapshot_hash(files)
    if manifest.get("snapshot_hash") != expected:
        errors.append(
            f"webref snapshot_hash mismatch: manifest {manifest.get('snapshot_hash')!r} "
            f"!= recomputed {expected!r}"
        )
    if manifest.get("spdx") != "MIT" or manifest.get("license") != "MIT":
        errors.append("webref must carry SPDX MIT (spdx + license fields)")
    if sorted(manifest.get("files", [])) != sorted(files):
        errors.append("webref file list differs from vendored snapshot")
    for name, content in files.items():
        if _LIVE_URL_RE.search(content):
            errors.append(
                f"webref {name} contains a live URL (snapshot must be bytes-only)"
            )
    return errors


def snapshot_age_days(today=None, pinned_on=None):
    """Age of the pin in days (``today`` ISO or date; default today)."""
    pinned = date.fromisoformat(pinned_on or WEBREF_PINNED_ON)
    if today is None:
        today_d = date.today()
    elif isinstance(today, date):
        today_d = today
    else:
        today_d = date.fromisoformat(str(today))
    return (today_d - pinned).days


def is_fresh(today=None, max_age_days=None):
    """True when the pin age is within budget (freshness gate).

    The budget is capped to :data:`WEBREF_MAX_AGE_DAYS`: a forged
    ``max_age_days=99999`` is capped to the pin (stale stays stale).
    """
    if max_age_days is None:
        limit = WEBREF_MAX_AGE_DAYS
    else:
        try:
            limit = min(int(max_age_days), WEBREF_MAX_AGE_DAYS)
        except (TypeError, ValueError):
            limit = WEBREF_MAX_AGE_DAYS
    return 0 <= snapshot_age_days(today=today) <= limit


def write_webref(project_root):
    """Write ``.queereye/webref.json`` (manifest + SPDX block + snapshot).

    Returns ``(wrote, backup, note)`` via :mod:`runner.queereye.fs`.
    """
    from runner.queereye import fs as _fs

    doc = dict(webref_manifest())
    doc["spdx_block"] = spdx_block()
    doc["snapshot"] = dict(SNAPSHOT_FILES)
    doc["transform_groups_detail"] = {
        name: dict(TRANSFORM_GROUPS[name]) for name in sorted(TRANSFORM_GROUPS)
    }
    content = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    return _fs.write_queereye_file(project_root, "webref.json", content)


def check_webref(project_root, today=None):
    """Drift + freshness gate for ``.queereye/webref.json``.

    Forge-hardened: the snapshot hash is recomputed from the file's own
    ``snapshot`` bytes (not the ``SNAPSHOT_FILES`` constant), so tampering
    the vendored bytes (e.g. injecting a ``<script>`` tag) mismatches.
    Freshness is pinned to the :data:`WEBREF_PINNED_ON` /
    :data:`WEBREF_MAX_AGE_DAYS` constants: manifest ``pinned_on`` /
    ``max_age_days`` forges are ignored for the decision (and reported),
    ``max_age_days=99999`` is capped to the pin, and a future ``pinned_on``
    fails.
    """
    from runner.queereye import fs as _fs

    try:
        target = _fs.resolve_inside(project_root, "webref.json")
    except _fs.QueereyePathError as exc:
        return [str(exc)]
    if not target.is_file():
        return ["drift: webref.json missing (run queereye specs)"]
    try:
        manifest = json.loads(target.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        return [f"corrupt webref.json: {exc}"]
    # Hash the file's own snapshot bytes (rot-immune by construction):
    # mutating file bytes must change the hash (rot probe mutates bytes).
    # Missing/empty snapshot is refused outright (no fallback to the
    # constant — hash the file bytes, fail if missing).
    file_snapshot = manifest.get("snapshot")
    errors = []
    if not isinstance(file_snapshot, dict) or not file_snapshot:
        errors.append(
            "webref snapshot missing or empty (vendored bytes required; "
            "hash file bytes, fail if missing)"
        )
        files_for_verify = (
            dict(file_snapshot) if isinstance(file_snapshot, dict) else {}
        )
        # Still run the type-guarded verifier so SPDX/file-list gates surface
        # alongside the missing error (verifier handles {} without crashing).
        errors.extend(verify_snapshot(manifest, files_for_verify))
        # Manifest snapshot must byte-match the clean-room pin (tamper => drift).
        # Missing snapshot already fails above; skip the per-file drift loop
        # when there is nothing to compare.
    else:
        files_for_verify = dict(file_snapshot)
        errors = verify_snapshot(manifest, files_for_verify)
        # Manifest snapshot must byte-match the clean-room pin (tamper => drift).
        for name in sorted(set(file_snapshot) | set(SNAPSHOT_FILES)):
            if file_snapshot.get(name) != SNAPSHOT_FILES.get(name):
                errors.append(
                    f"webref snapshot drift: {name!r} differs from vendored pin "
                    "(tamper detected; hash the file bytes, not the constant)"
                )
                break
    # Freshness pinned to constants (manifest dates ignored for decision).
    manifest_pinned = manifest.get("pinned_on", WEBREF_PINNED_ON)
    manifest_max_raw = manifest.get("max_age_days", WEBREF_MAX_AGE_DAYS)
    try:
        manifest_max = int(manifest_max_raw)
    except (TypeError, ValueError):
        manifest_max = None
    if manifest_pinned != WEBREF_PINNED_ON:
        errors.append(
            f"webref pinned_on forge: manifest {manifest_pinned!r} != pin "
            f"{WEBREF_PINNED_ON!r} (manifest dates ignored)"
        )
    if manifest_max != WEBREF_MAX_AGE_DAYS:
        errors.append(
            f"webref max_age_days forge: manifest {manifest_max_raw!r} != pin "
            f"{WEBREF_MAX_AGE_DAYS} (capped to pin; manifest budget ignored)"
        )
    # Reject a future pinned_on (manifest or pin).
    try:
        age_manifest = snapshot_age_days(today=today, pinned_on=manifest_pinned)
    except ValueError as exc:
        errors.append(f"webref pinned_on unparsable: {exc}")
        age_manifest = None
    else:
        if age_manifest is not None and age_manifest < 0:
            errors.append("webref pinned_on is in the future")
    try:
        age_pin = snapshot_age_days(today=today, pinned_on=WEBREF_PINNED_ON)
    except ValueError as exc:
        return errors + [f"webref pin date unparsable: {exc}"]
    if age_pin < 0:
        errors.append("webref pinned_on is in the future")
    elif age_pin > WEBREF_MAX_AGE_DAYS:
        errors.append(
            f"webref snapshot stale: age {age_pin}d exceeds "
            f"{WEBREF_MAX_AGE_DAYS}d budget"
        )
    return errors
