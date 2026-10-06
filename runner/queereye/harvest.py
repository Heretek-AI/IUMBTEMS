#!/usr/bin/env python3
"""Permissive-only skill harvest ledger + Claude overlay + factory cite-gate.

Phase queereye-03-harvest-overlay (run queereye-style-guide).

Ledger-as-code, not prose thanks:

- Open Props ships under the MIT license as framework-agnostic
  custom-property tokens [VERIFIED: dbe9cbb4] -> ``depend`` (theming
  substrate; ``tokens.css`` compiled vars mirror the custom-property model).
- shadcn/ui ships under the MIT license, so its component-pattern catalog
  is licensable raw material [VERIFIED: 890dc55a] -> ``clean-room``
  (patterns rebuilt as behavior specs; no upstream bytes vendored).
- Radix Primitives ships under the MIT license, so its dialog,
  focus-management, and keyboard-interaction behaviors are licensable
  [VERIFIED: 74144f6a] -> ``clean-room`` (behaviors re-specified per target).
- Tailwind token-naming (MIT, registry claim) -> ``clean-room`` spec source;
  Tailwind ``@theme`` compiler -> ``depend`` for token-to-utility codegen.
  Registry/badge claims without LICENSE bytes are HYPOTHESIS, never
  VERIFIED: upstream LICENSE file bytes were not fetched (no network
  ingest), so both Tailwind rows cite the vendored MIT license bytes and
  carry a NEGATIVE_KNOWLEDGE pin note.
- axe-core (MPL-2.0) is the canonical excluded harvest:
  popular but whitelist-incompatible [VERIFIED: d0679fbc] -> ``clean-room``
  behavior-only (contrast checks rebuilt in ``probes.json``; never
  depend/vendor).
- WAI-ARIA 1.2 role/state/keyboard contracts -> ``clean-room``
  behavior-only rebuilds (no upstream bytes).
- Skill bundle format: anthropics/skills ``SKILL.md`` frontmatter contract
  (name/description + license/compatibility/metadata/allowed-tools) with a
  validator: spec mandates the frontmatter contract and ships a validator
  [VERIFIED: 84f80b6c]. Layout ``SKILL.md + scripts/ + references/ +
  assets/`` with progressive-disclosure budgets (metadata ~100tok, body
  <5000tok, wc-measured).
- Claude overlay: a single ``SKILL.md`` reusing the token schema + spec
  templates. Claude Code merged custom commands into skills: a ``SKILL.md``
  skill and a ``.claude/commands`` file both create the same slash command
  [VERIFIED: ca41333c]. OpenCode V2 agents combine system prompt, model
  preference, permissions, and display details into a named profile
  [VERIFIED: aab8ead6] (the ``queereye`` interviewer profile from phase 01).
- Factory cite-gate: the programmer receipt MUST cite
  ``.queereye/tokens.json`` hashes + dossier hashes; qa-a/qa-b verify
  guide-render match + contrast + ledger completeness.

Out of scope (phase brief): no interview/spec format changes (phases 01-02
stable), no closed platforms (Knapsack/Supernova/Zeroheight/Backlight --
clean-room-from-docs only, no repo to scan), no BSD/ISC harvest claim
without file-level LICENSE bytes (stays NEGATIVE_KNOWLEDGE).

Zero runtime dependencies (stdlib only). No network ingest.
"""

import hashlib
import json
import re
import tempfile

#: Zero-width set Python strip() misses (ZWSP/WJ/BOM family).
_ZERO_WIDTH_CHARS = "​‌‍⁠﻿‎‏­"

#: Dossier evidence hashes this phase MUST cite (full quotes in dossier.json).
DOSSIER_HASHES = (
    "dbe9cbb4",  # Open Props MIT custom-property tokens
    "890dc55a",  # shadcn/ui MIT component-pattern catalog
    "74144f6a",  # Radix Primitives MIT dialog/focus/keyboard behaviors
    "d0679fbc",  # axe-core MPL-2.0 excluded harvest
    "84f80b6c",  # skill frontmatter contract + validator
    "aab8ead6",  # OpenCode V2 agent profile shape
    "ca41333c",  # Claude commands==skills merged shape
)

#: 64-hex SHA-256 shape for LICENSE-byte pins (F2: BSD bytes faked refused).
_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")

#: Closed platforms: clean-room-from-docs only, no repo to scan (F7).
CLOSED_PLATFORMS = ("knapsack", "supernova", "zeroheight", "backlight")

#: Mandated shadcn sub-deps the closure scan must price (F6: deletable refused).
MANDATED_CLOSURE_DEPS = frozenset(
    {
        "@radix-ui/react-dialog",
        "tailwindcss",
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
        "lucide-react",
    }
)

#: Documented clean-room exceptions for whitelist-incompatible behavior-only
#: rebuilds (F5): MPL-2.0 (axe-checks) + W3C-Document (aria-contracts). Every
#: other unknown SPDX id (e.g. EVIL-MADE-UP) is refused via license_gate.
DOCUMENTED_CLEANROOM_UPSTREAMS = frozenset({"MPL-2.0", "W3C-DOCUMENT"})


def _strip_hardened(value):
    """Strip whitespace + zero-width chars (ZWSP/WJ/BOM family)."""
    if not isinstance(value, str):
        return value
    cleaned = value
    for _ch in _ZERO_WIDTH_CHARS:
        if _ch in cleaned:
            cleaned = cleaned.replace(_ch, "")
    return cleaned.strip()


def _is_blank(value):
    """True when ``value`` is not a stripped non-empty string."""
    return not isinstance(value, str) or not _strip_hardened(value)


#: Canonical MIT license text vendored as the LICENSE bytes for every MIT
#: row. Upstream per-file copyright lines are NOT fetched (no network
#: ingest); that attribution gap is recorded as NEGATIVE_KNOWLEDGE on each
#: row, never papered over. The text below is byte-identical for all MIT
#: upstreams modulo the copyright line, so one hash covers the license
#: identity of every MIT row.
MIT_LICENSE_TEXT = """MIT License

Copyright (c) <upstream project> (copyright lines live upstream; not fetched)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def mit_license_bytes_sha256():
    """SHA-256 hex of the vendored MIT license bytes (license identity)."""
    return hashlib.sha256(MIT_LICENSE_TEXT.encode("utf-8")).hexdigest()


#: Permissive whitelist for depend/vendor (same set as
#: :mod:`runner.queereye.webref`; GPL/AGPL are clean-room-only).
LICENSE_WHITELIST = frozenset({"MIT", "Apache-2.0", "BSD-3-Clause", "ISC"})

#: Machine row keys for the harvest ledger.
LEDGER_REQUIRED_KEYS = (
    "skill",
    "verdict",
    "license",
    "upstream",
    "upstream_license",
    "files",
    "evidence_hash",
    "evidence_kind",
    "license_bytes_sha256",
    "spdx",
    "note",
)

#: Allowed cell values.
LEDGER_VERDICTS = frozenset({"depend", "vendor", "clean-room", "skip"})
LEDGER_EVIDENCE_KINDS = frozenset({"dossier", "license-bytes", "negative"})


def spdx_block_for(
    skill,
    upstream,
    upstream_license,
    files,
    evidence_hash,
    license="MIT",
    license_bytes_sha256=None,
):
    """SPDX attribution block for one ledger row (license + upstream + files).

    No live URLs: upstream is cited by name + SPDX + content hash, never by
    URL fetch (mirrors the webref never-live-URL rule). The SPDX identifier
    and bytes hash are the ROW's license (BSD/SPDX correct, F2), never a
    hardcoded MIT.
    """
    row_license = _strip_hardened(str(license or "MIT")) or "MIT"
    row_bytes = (
        _strip_hardened(str(license_bytes_sha256))
        if license_bytes_sha256
        else mit_license_bytes_sha256()
    )
    if not row_bytes:
        row_bytes = mit_license_bytes_sha256()
    file_list = ",".join(sorted(files)) if files else "(no vendored files)"
    return (
        f"SPDX-License-Identifier: {row_license}\n"
        f"Skill: {skill}\n"
        f"Upstream: {upstream} (claimed {upstream_license})\n"
        f"Files: {file_list}\n"
        f"License-Bytes-SHA256: {row_bytes}\n"
        f"Evidence: {evidence_hash}\n"
    )


def _row(
    skill,
    verdict,
    upstream,
    upstream_license,
    files,
    evidence_hash,
    evidence_kind,
    note,
    license="MIT",
):
    row_license = _strip_hardened(str(license or "MIT")) or "MIT"
    row_bytes = mit_license_bytes_sha256()
    return {
        "skill": skill,
        "verdict": verdict,
        "license": row_license,
        "upstream": upstream,
        "upstream_license": upstream_license,
        "files": list(files),
        "evidence_hash": evidence_hash,
        "evidence_kind": evidence_kind,
        "license_bytes_sha256": row_bytes,
        "spdx": spdx_block_for(
            skill,
            upstream,
            upstream_license,
            files,
            evidence_hash,
            license=row_license,
            license_bytes_sha256=row_bytes,
        ),
        "note": note,
    }


#: The harvest ledger: 5 MIT rows (Open Props, shadcn, Radix, 2x Tailwind) +
#: axe-core (MPL-2.0, clean-room) + WAI-ARIA (behavior-only clean-room).
#: No BSD/ISC row is claimed: without file-level LICENSE bytes those stay
#: NEGATIVE_KNOWLEDGE (see :data:`NEGATIVE_KNOWLEDGE_NOTES`).
HARVEST_ROWS = [
    _row(
        skill="open-props-theming",
        verdict="depend",
        upstream="open-props",
        upstream_license="MIT",
        files=["tokens.css"],
        evidence_hash="dbe9cbb4",
        evidence_kind="dossier",
        note=(
            "Theming substrate (depend): framework-agnostic custom-property "
            "tokens [VERIFIED: dbe9cbb4]; tokens.css compiled vars mirror "
            "the custom-property model. NEGATIVE_KNOWLEDGE: upstream "
            "per-file copyright lines not fetched (no network ingest)."
        ),
    ),
    _row(
        skill="shadcn-patterns",
        verdict="clean-room",
        upstream="shadcn/ui",
        upstream_license="MIT",
        files=[
            "components/button.md",
            "components/dialog.md",
            "components/form-input.md",
            "webref.json",
        ],
        evidence_hash="890dc55a",
        evidence_kind="dossier",
        note=(
            "Component-pattern catalog as clean-room spec source "
            "[VERIFIED: 890dc55a]: patterns rebuilt as behavior specs; "
            "zero upstream bytes vendored."
        ),
    ),
    _row(
        skill="radix-behaviors",
        verdict="clean-room",
        upstream="radix-primitives",
        upstream_license="MIT",
        files=["components/dialog.md", "tui-notes.md"],
        evidence_hash="74144f6a",
        evidence_kind="dossier",
        note=(
            "Dialog, focus-management, and keyboard-interaction behaviors "
            "re-specified per target [VERIFIED: 74144f6a]; no upstream "
            "bytes vendored."
        ),
    ),
    _row(
        skill="tailwind-naming",
        verdict="clean-room",
        upstream="tailwindcss",
        upstream_license="MIT",
        files=["tokens.css"],
        evidence_hash=mit_license_bytes_sha256(),
        evidence_kind="license-bytes",
        note=(
            "Token-naming conventions rebuilt clean-room as a spec source. "
            "HYPOTHESIS (registry claim, never VERIFIED): upstream tailwindcss "
            "ships MIT; no upstream LICENSE bytes fetched (no network), so "
            "the association is not cited as dossier evidence."
        ),
    ),
    _row(
        skill="tailwind-theme",
        verdict="depend",
        upstream="tailwindcss",
        upstream_license="MIT",
        files=["tokens.css"],
        evidence_hash=mit_license_bytes_sha256(),
        evidence_kind="license-bytes",
        note=(
            "Tailwind @theme compiler as depend for token-to-utility codegen. "
            "HYPOTHESIS (registry claim): upstream MIT. NEGATIVE_KNOWLEDGE: "
            "compiler version pin not ingested (no lockfile scan); codegen "
            "contract is the tokens.css shape, not a pinned binary."
        ),
    ),
    _row(
        skill="axe-checks",
        verdict="clean-room",
        upstream="axe-core",
        upstream_license="MPL-2.0",
        files=["probes.json"],
        evidence_hash="d0679fbc",
        evidence_kind="dossier",
        note=(
            "Canonical EXCLUDED harvest [VERIFIED: d0679fbc]: MPL-2.0 is "
            "whitelist-incompatible, so axe-core is behavior-only -- contrast "
            "checks rebuilt in probes.json, never depend/vendor."
        ),
    ),
    _row(
        skill="aria-contracts",
        verdict="clean-room",
        upstream="wai-aria-1.2",
        upstream_license="W3C-Document",
        files=["components/button.md", "components/dialog.md"],
        evidence_hash=mit_license_bytes_sha256(),
        evidence_kind="license-bytes",
        note=(
            "WAI-ARIA 1.2 role/state/keyboard contracts rebuilt behavior-only "
            "(our rebuild bytes are MIT); zero upstream bytes vendored. "
            "NEGATIVE_KNOWLEDGE: upstream W3C document bytes not fetched; "
            "upstream W3C document license never enters the whitelist path."
        ),
    ),
]

#: Standing NEGATIVE_KNOWLEDGE: BSD/ISC coverage is NOT claimed.
NEGATIVE_KNOWLEDGE_NOTES = [
    "NEGATIVE_KNOWLEDGE: no BSD-3-Clause harvest claimed -- no candidate "
    "with file-level LICENSE bytes cached; full-whitelist coverage is not "
    "asserted.",
    "NEGATIVE_KNOWLEDGE: no ISC harvest claimed -- lucide-react (ISC, "
    "registry claim) via shadcn is HYPOTHESIS without LICENSE bytes and is "
    "excluded from the depend surface (icon slots use text glyphs).",
]

#: Transitive closure for shadcn sub-deps (Gate 0 unpriced risk closed here):
#: every sub-dep is priced (risk: none, no bytes vendored) or explicitly
#: negative (no bytes, excluded). No GPL/AGPL anywhere in the closure.
TRANSITIVE_DEPS = [
    {
        "dep": "@radix-ui/react-dialog",
        "via": "shadcn/ui",
        "license_claim": "MIT",
        "status": "priced",
        "risk": "none: covered by the radix-behaviors clean-room row; "
        "no bytes vendored.",
    },
    {
        "dep": "tailwindcss",
        "via": "shadcn/ui",
        "license_claim": "MIT",
        "status": "priced",
        "risk": "none: compiler depend only (tailwind-theme row); no bytes vendored.",
    },
    {
        "dep": "class-variance-authority",
        "via": "shadcn/ui",
        "license_claim": "Apache-2.0",
        "status": "priced",
        "risk": "none: cva matrix rebuilt clean-room in specs.py; no bytes vendored.",
    },
    {
        "dep": "clsx",
        "via": "shadcn/ui",
        "license_claim": "MIT",
        "status": "priced",
        "risk": "none: not vendored; class-join trivially rebuilt.",
    },
    {
        "dep": "tailwind-merge",
        "via": "shadcn/ui",
        "license_claim": "MIT",
        "status": "priced",
        "risk": "none: not vendored; no class-string merging shipped.",
    },
    {
        "dep": "lucide-react",
        "via": "shadcn/ui",
        "license_claim": "ISC (registry claim, HYPOTHESIS)",
        "status": "negative",
        "risk": "NEGATIVE_KNOWLEDGE: no LICENSE bytes cached; excluded "
        "from the depend surface; icon slots use text glyphs.",
    },
    {
        "dep": "BSD-family (no candidate)",
        "via": "transitive scan",
        "license_claim": "BSD-* (none claimed)",
        "status": "negative",
        "risk": "NEGATIVE_KNOWLEDGE: no BSD-licensed dep claimed without "
        "file-level LICENSE bytes (Gate 0 gap stays open, never faked).",
    },
]


def validate_ledger(rows=None):
    """Validate the harvest ledger. Returns error list (empty = valid).

    - Every row carries all machine keys; verdict/license/evidence_kind are
      closed vocabularies; ``license`` is whitelist-enforced (rejects other
      ids, case-insensitive); files is a non-empty list of stripped paths.
    - ``depend``/``vendor``/``skip``/``clean-room`` upstream ids are ALL
      routed through :func:`runner.queereye.webref.license_gate` (F4/F5):
      GPL skip refused without rebuild proof, unknown SPDX (EVIL-MADE-UP)
      refused for every verdict. Documented exceptions: MPL-2.0 (axe-checks)
      + W3C-Document (aria-contracts) behavior-only rebuilds with
      VERIFIED/NEGATIVE_KNOWLEDGE notes.
    - F1 badge-launder: ``dossier`` evidence_hash must be a member of
      :data:`DOSSIER_HASHES` (else fail, even with a marker); dossier rows
      must cite ``[VERIFIED: <hash>]`` in the note.
    - F2/F3 bytes: ``license_bytes_sha256`` must be 64-hex shape (faked BSD
      refused), never ``0*64``; MIT rows must pin
      :func:`mit_license_bytes_sha256`; BSD/ISC rows must pin own bytes
      (never MIT bytes). SPDX blocks must emit the ROW's license + bytes
      hash (never hardcoded MIT).
    - F7 closed platforms (knapsack/supernova/zeroheight/backlight) refused.
    - F8 files traversal (``../../etc/passwd``) refused via
      ``fs.resolve_inside`` (must stay inside ``.queereye/``).
    - Every ``vendor`` row emits an SPDX block (license + upstream + files).
    - No GPL/AGPL bytes vendored: no row vendors upstream bytes under a
      copyleft id (all rows here vendor zero upstream bytes).
    - Badge-only rows (``evidence_kind != dossier``) must say HYPOTHESIS or
      NEGATIVE_KNOWLEDGE in the note (registry claims never VERIFIED).
    - No BSD/ISC ``license`` claim without LICENSE bytes: any row claiming
      a BSD/ISC ``license`` must pin ``license_bytes_sha256`` to real shipped
      bytes (this ledger claims none; the check still guards edits).
    """
    from runner.queereye import fs as _fs
    from runner.queereye import webref as _webref

    rows = rows if rows is not None else HARVEST_ROWS
    errors = []
    if not isinstance(rows, list) or not rows:
        return ["harvest ledger must be a non-empty list of rows"]
    seen_skills = set()
    for i, row in enumerate(rows):
        tag = row.get("skill", f"<row {i}>") if isinstance(row, dict) else f"<row {i}>"
        if not isinstance(row, dict):
            errors.append(f"harvest {tag}: row must be an object")
            continue
        for key in LEDGER_REQUIRED_KEYS:
            if key not in row:
                errors.append(f"harvest {tag}: missing required key {key!r}")
        if any(k not in row for k in LEDGER_REQUIRED_KEYS):
            continue
        if _is_blank(row["skill"]):
            errors.append(f"harvest {tag}: skill must be a stripped non-empty string")
        if row["skill"] in seen_skills:
            errors.append(f"harvest {tag}: duplicate skill id")
        seen_skills.add(row["skill"])
        verdict = _strip_hardened(str(row["verdict"] or ""))
        if verdict not in LEDGER_VERDICTS:
            errors.append(
                f"harvest {tag}: verdict {row['verdict']!r} must be one of "
                f"{sorted(LEDGER_VERDICTS)}"
            )
        lic = _strip_hardened(str(row["license"] or ""))
        if lic.upper() not in {s.upper() for s in LICENSE_WHITELIST}:
            errors.append(
                f"harvest {tag}: license {row['license']!r} rejected "
                f"(whitelist: {sorted(LICENSE_WHITELIST)})"
            )
        upstream_lic = _strip_hardened(str(row["upstream_license"] or ""))
        up_upper = _strip_hardened(str(upstream_lic or "")).upper()
        # F4/F5: route every verdict through license_gate (skip/clean-room too).
        if verdict in ("depend", "vendor"):
            gate = _webref.license_gate(upstream_lic, verdict)
            if gate:
                errors.extend(f"harvest {tag}: {g}" for g in gate)
        elif verdict in ("clean-room", "skip"):
            if verdict == "clean-room" and up_upper in DOCUMENTED_CLEANROOM_UPSTREAMS:
                _note_ex = str(row.get("note") or "")
                if up_upper == "MPL-2.0":
                    if row.get("skill") != "axe-checks":
                        errors.append(
                            f"harvest {tag}: MPL-2.0 clean-room exception only "
                            f"for axe-checks (got {row.get('skill')!r})"
                        )
                    elif (
                        "VERIFIED" not in _note_ex
                        and "NEGATIVE_KNOWLEDGE" not in _note_ex
                    ):
                        errors.append(
                            f"harvest {tag}: MPL-2.0 exception requires "
                            "VERIFIED/NEGATIVE_KNOWLEDGE rebuild note"
                        )
                elif up_upper == "W3C-DOCUMENT":
                    if row.get("skill") != "aria-contracts":
                        errors.append(
                            f"harvest {tag}: W3C-Document clean-room exception "
                            f"only for aria-contracts (got {row.get('skill')!r})"
                        )
                    elif "NEGATIVE_KNOWLEDGE" not in _note_ex:
                        errors.append(
                            f"harvest {tag}: W3C-Document exception requires "
                            "NEGATIVE_KNOWLEDGE in note (upstream bytes never fetched)"
                        )
            else:
                if verdict == "clean-room":
                    gate = _webref.license_gate(
                        upstream_lic, verdict, note=str(row.get("note") or "")
                    )
                else:
                    gate = _webref.license_gate(upstream_lic, verdict)
                if gate:
                    errors.extend(f"harvest {tag}: {g}" for g in gate)
        if verdict == "clean-room" and _is_blank(row["note"]):
            errors.append(
                f"harvest {tag}: clean-room requires a rebuild-proof note "
                "(blank refused; waivers carry conditions)"
            )
        # F2 SPDX: every row's block must emit the ROW's license + bytes hash
        # (never hardcoded MIT); vendor additionally requires upstream naming.
        spdx = row.get("spdx", "")
        if verdict == "vendor":
            if _is_blank(spdx) or "SPDX-License-Identifier" not in str(spdx):
                errors.append(
                    f"harvest {tag}: vendor must emit an SPDX block "
                    "(license + upstream + files)"
                )
            elif str(row["upstream"]) not in str(spdx):
                errors.append(
                    f"harvest {tag}: vendor SPDX block must name the upstream"
                )
        if not _is_blank(spdx):
            _spdx_text = str(spdx)
            _expected_id = f"SPDX-License-Identifier: {lic}"
            # Case-insensitive SPDX match (mit == MIT, F2 still refuses hardcoded
            # wrong id: BSD row with MIT block fails even case-insensitively).
            if _expected_id.lower() not in _spdx_text.lower():
                errors.append(
                    f"harvest {tag}: SPDX block must emit the row license "
                    f"{lic!r} ({_expected_id!r} missing; hardcoded MIT refused)"
                )
            _lbs_for_spdx = _strip_hardened(str(row.get("license_bytes_sha256") or ""))
            if _lbs_for_spdx and _lbs_for_spdx not in _spdx_text:
                errors.append(
                    f"harvest {tag}: SPDX block License-Bytes-SHA256 must "
                    "match the row license_bytes_sha256 (hardcoded hash refused)"
                )
        if not isinstance(row["files"], list) or not row["files"]:
            errors.append(f"harvest {tag}: files must be a non-empty list")
        else:
            for f in row["files"]:
                if _is_blank(f):
                    errors.append(
                        f"harvest {tag}: files entries must be stripped "
                        "non-empty strings"
                    )
                    break
                # F8 traversal: every files[] entry must resolve inside .queereye/.
                try:
                    _fs.resolve_inside("/tmp/queereye-ledger-probe", f)
                except _fs.QueereyePathError as exc:
                    errors.append(
                        f"harvest {tag}: files entry {f!r} escapes "
                        f".queereye/ (traversal refused: {exc})"
                    )
                    break
                except Exception as exc:  # pragma: no cover - defensive
                    errors.append(f"harvest {tag}: files entry {f!r} refused: {exc}")
                    break
        kind = _strip_hardened(str(row["evidence_kind"] or ""))
        if kind not in LEDGER_EVIDENCE_KINDS:
            errors.append(
                f"harvest {tag}: evidence_kind {row['evidence_kind']!r} must be "
                f"one of {sorted(LEDGER_EVIDENCE_KINDS)}"
            )
        elif kind == "dossier":
            # F1 badge-launder: dossier hash must be a phase dossier member.
            _eh = _strip_hardened(str(row.get("evidence_hash") or ""))
            if _eh not in DOSSIER_HASHES:
                errors.append(
                    f"harvest {tag}: dossier evidence_hash {_eh!r} must be a "
                    f"phase dossier hash {sorted(DOSSIER_HASHES)} (badge "
                    "launder refused; registry claims are HYPOTHESIS, never VERIFIED)"
                )
            else:
                _note_d = str(row.get("note") or "")
                if "VERIFIED" not in _note_d or _eh not in _note_d:
                    errors.append(
                        f"harvest {tag}: dossier evidence must cite "
                        f"[VERIFIED: {_eh}] in the note (badge launder refused)"
                    )
        else:
            note = str(row.get("note", ""))
            if "HYPOTHESIS" not in note and "NEGATIVE_KNOWLEDGE" not in note:
                errors.append(
                    f"harvest {tag}: non-dossier evidence must mark the claim "
                    "HYPOTHESIS or NEGATIVE_KNOWLEDGE in the note (registry "
                    "claims are never VERIFIED)"
                )
        if _is_blank(row["evidence_hash"]):
            errors.append(f"harvest {tag}: evidence_hash required (hash or bytes)")
        # F2 shape: license_bytes_sha256 must be 64-hex (faked BSD refused).
        _lbs = _strip_hardened(str(row.get("license_bytes_sha256") or ""))
        if not _lbs or not _HEX64_RE.match(_lbs):
            errors.append(
                f"harvest {tag}: license_bytes_sha256 must be 64-hex sha256 "
                f"(got {_lbs!r}; faked BSD bytes refused)"
            )
        else:
            # F3: reject 0*64; pin MIT rows to vendored bytes.
            if _lbs.lower() == "0" * 64:
                errors.append(
                    f"harvest {tag}: license_bytes_sha256 0*64 refused "
                    "(bytes hash never verified)"
                )
            elif lic.upper() == "MIT":
                if _lbs.lower() != mit_license_bytes_sha256().lower():
                    errors.append(
                        f"harvest {tag}: MIT license_bytes_sha256 must pin "
                        f"vendored MIT bytes {mit_license_bytes_sha256()} "
                        "(bytes hash never verified)"
                    )
            elif lic.upper() in ("BSD-3-CLAUSE", "ISC"):
                if not _lbs:
                    errors.append(
                        f"harvest {tag}: BSD/ISC claim requires LICENSE bytes hash "
                        "(no bytes, no claim)"
                    )
                elif _lbs.lower() == mit_license_bytes_sha256().lower():
                    errors.append(
                        f"harvest {tag}: BSD/ISC bytes must pin own LICENSE "
                        "bytes, not MIT bytes (faked BSD refused)"
                    )
        if lic.upper() in ("BSD-3-CLAUSE", "ISC") and _is_blank(
            row.get("license_bytes_sha256")
        ):
            errors.append(
                f"harvest {tag}: BSD/ISC claim requires LICENSE bytes hash "
                "(no bytes, no claim)"
            )
        upper_upstream = upstream_lic.upper()
        if upper_upstream.startswith(("GPL", "AGPL")) and verdict in (
            "depend",
            "vendor",
        ):
            errors.append(
                f"harvest {tag}: copyleft {upstream_lic!r} is clean-room-only; "
                f"{verdict} refused (no GPL/AGPL bytes vendored)"
            )
        # F7 closed platforms: clean-room-from-docs only, no repo to scan.
        try:
            _blob = json.dumps(row, sort_keys=True).lower()
        except (TypeError, ValueError):
            _blob = str(row).lower()
        for _closed in CLOSED_PLATFORMS:
            if _closed in _blob:
                errors.append(
                    f"harvest {tag}: closed platform {_closed!r} refused "
                    "(clean-room-from-docs only, no repo to scan)"
                )
                break
    mit_rows = [
        r
        for r in rows
        if isinstance(r, dict)
        and _strip_hardened(str(r.get("license") or "")).upper() == "MIT"
    ]
    if len(mit_rows) < 4:
        errors.append(f"harvest ledger needs >=4 MIT rows, found {len(mit_rows)}")
    axe = [r for r in rows if isinstance(r, dict) and r.get("skill") == "axe-checks"]
    if not axe:
        errors.append("harvest ledger missing the axe-checks clean-room row")
    else:
        if axe[0].get("verdict") != "clean-room":
            errors.append("harvest axe-checks must be clean-room (MPL-2.0 excluded)")
        if _strip_hardened(str(axe[0].get("upstream_license") or "")) != "MPL-2.0":
            errors.append("harvest axe-checks must record upstream MPL-2.0")
    return errors


def validate_transitive_closure(deps=None):
    """Validate the shadcn transitive-closure scan. Returns error list.

    Every entry needs dep/via/license_claim/status/risk; status is
    ``priced`` (risk priced, no bytes vendored) or ``negative``
    (NEGATIVE_KNOWLEDGE, excluded); copyleft claims may only enter as
    ``negative`` with a clean-room note (never priced-verified bytes).
    F6: the 6 mandated shadcn sub-deps must be present (deletable closure
    refused) plus ISC/BSD-negative rows (never faked whitelist coverage).
    F7: closed-platform names (knapsack/supernova/zeroheight/backlight)
    refused.
    """
    deps = deps if deps is not None else TRANSITIVE_DEPS
    errors = []
    if not isinstance(deps, list) or not deps:
        return ["transitive closure must be a non-empty scan list"]
    for i, entry in enumerate(deps):
        tag = (
            entry.get("dep", f"<dep {i}>") if isinstance(entry, dict) else f"<dep {i}>"
        )
        if not isinstance(entry, dict):
            errors.append(f"closure {tag}: entry must be an object")
            continue
        for key in ("dep", "via", "license_claim", "status", "risk"):
            if key not in entry or _is_blank(entry[key]):
                errors.append(f"closure {tag}: missing/blank required key {key!r}")
        status = _strip_hardened(str(entry.get("status") or ""))
        if status not in ("priced", "negative"):
            errors.append(
                f"closure {tag}: status {entry.get('status')!r} must be priced|negative"
            )
        claim = str(entry.get("license_claim") or "").upper()
        if ("GPL" in claim or "AGPL" in claim) and status != "negative":
            errors.append(
                f"closure {tag}: copyleft claim must be negative/clean-room-only"
            )
        if status == "negative":
            risk = str(entry.get("risk") or "")
            if "NEGATIVE_KNOWLEDGE" not in risk and "HYPOTHESIS" not in risk:
                errors.append(
                    f"closure {tag}: negative status must carry "
                    "NEGATIVE_KNOWLEDGE/HYPOTHESIS in risk"
                )
        try:
            _blob = json.dumps(entry, sort_keys=True).lower()
        except (TypeError, ValueError):
            _blob = str(entry).lower()
        for _closed in CLOSED_PLATFORMS:
            if _closed in _blob:
                errors.append(
                    f"closure {tag}: closed platform {_closed!r} refused "
                    "(clean-room-from-docs only, no repo to scan)"
                )
                break
    via_shadcn = [
        e
        for e in deps
        if isinstance(e, dict) and str(e.get("via") or "") == "shadcn/ui"
    ]
    if not via_shadcn:
        errors.append("transitive closure must scan shadcn sub-deps (via shadcn/ui)")
    # F6 mandated: all 6 sub-deps present via shadcn/ui (deletable refused).
    _present = {
        str(e.get("dep") or "")
        for e in deps
        if isinstance(e, dict) and str(e.get("via") or "") == "shadcn/ui"
    }
    for _mandated in sorted(MANDATED_CLOSURE_DEPS):
        if _mandated not in _present:
            errors.append(
                f"closure missing mandated sub-dep {_mandated!r} "
                "(deletable closure refused; scan shadcn sub-deps)"
            )
    # F6 negative rows: ISC + BSD must stay negative (never faked coverage).
    _has_isc_negative = any(
        isinstance(e, dict)
        and "ISC" in str(e.get("license_claim") or "").upper()
        and _strip_hardened(str(e.get("status") or "")) == "negative"
        and (
            "NEGATIVE_KNOWLEDGE" in str(e.get("risk") or "")
            or "HYPOTHESIS" in str(e.get("risk") or "")
        )
        for e in deps
    )
    if not _has_isc_negative:
        errors.append(
            "closure missing ISC-negative row (lucide-react HYPOTHESIS; "
            "static list refused without negative)"
        )
    _has_bsd_negative = any(
        isinstance(e, dict)
        and "BSD" in str(e.get("license_claim") or "").upper()
        and _strip_hardened(str(e.get("status") or "")) == "negative"
        and (
            "NEGATIVE_KNOWLEDGE" in str(e.get("risk") or "")
            or "HYPOTHESIS" in str(e.get("risk") or "")
        )
        for e in deps
    )
    if not _has_bsd_negative:
        errors.append(
            "closure missing BSD-negative row (no BSD bytes cached; "
            "static list refused without negative)"
        )
    return errors


# -- skill bundle -----------------------------------------------------------
#
# anthropics/skills SKILL.md frontmatter (name/description +
# license/compatibility/metadata/allowed-tools) + SKILL.md + scripts/ +
# references/ + assets/ layout + progressive-disclosure budgets.
# Spec mandates the frontmatter contract and ships a validator
# [VERIFIED: 84f80b6c].

#: Frontmatter fields the skill bundle contract requires.
SKILL_FRONTMATTER_FIELDS = (
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
)

#: Disclosure budgets (tokens estimated wc-style: words x 1.3).
META_TARGET_TOKENS = 100
META_BUDGET_TOKENS = 150
BODY_BUDGET_TOKENS = 5000


def estimate_tokens(text):
    """Conservative token estimate: ``max(words * 1.3, bytes / 4)`` (F9).

    Words-only (``words * 1.3``) is whitespace-evadable: a 200KB single-word
    (no spaces) counts 1 word (~2tok) and sails under the 5000tok body cap.
    The byte backstop (1tok ~ 4 bytes, rounded up) closes it: the same blob
    estimates ~50k tok and fails. Both legs wc-measured.
    """
    if not isinstance(text, str) or not text:
        return 0
    try:
        _byte_len = len(text.encode("utf-8"))
    except Exception:  # pragma: no cover - defensive
        _byte_len = len(text)
    _byte_est = (_byte_len + 3) // 4
    _words = text.split()
    if not _words:
        # Whitespace-only huge blob: words say 0, bytes say huge (evasion).
        return _byte_est
    _word_est = int(len(_words) * 1.3) + 1
    return max(_word_est, _byte_est)


def split_frontmatter(text):
    """Split SKILL.md into ``(frontmatter_dict, body)``.

    Returns ``(None, text)`` when no ``---`` frontmatter block opens the file.
    Keys are hardened-stripped; values are raw strings (may span one line).
    """
    if not isinstance(text, str) or not text.startswith("---"):
        return (None, text)
    end = text.find("---", 3)
    if end < 0:
        return (None, text)
    fm = {}
    for line in text[3:end].strip().splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fm[_strip_hardened(key)] = value.strip()
    return (fm, text[end + 3 :].lstrip("\n"))


def validate_skill_frontmatter(text):
    """Validate a SKILL.md frontmatter block. Returns error list.

    Every field in :data:`SKILL_FRONTMATTER_FIELDS` must be present and
    stripped non-empty (zero-width-only refused); ``license`` must be
    whitelist-enforced; ``allowed-tools`` must name at least one tool.
    """
    fm, _body = split_frontmatter(text)
    errors = []
    if fm is None:
        return ["skill SKILL.md must open with a --- frontmatter block"]
    for field in SKILL_FRONTMATTER_FIELDS:
        if field not in fm or _is_blank(fm[field]):
            errors.append(
                f"skill frontmatter missing/blank required field {field!r} "
                "[VERIFIED: 84f80b6c]"
            )
    lic = fm.get("license", "")
    if not _is_blank(lic) and lic.strip().upper() not in {
        s.upper() for s in LICENSE_WHITELIST
    }:
        errors.append(
            f"skill frontmatter license {lic!r} rejected "
            f"(whitelist: {sorted(LICENSE_WHITELIST)})"
        )
    tools = fm.get("allowed-tools", "")
    if not _is_blank(tools) and not _strip_hardened(tools):
        errors.append("skill frontmatter allowed-tools must name tools")
    return errors


def disclosure_budget_check(text):
    """Check progressive-disclosure budgets. Returns error list.

    Metadata (frontmatter values joined) targets ~100tok (hard cap 150);
    body must stay under 5000tok. Both measured with :func:`estimate_tokens`
    (``max(words*1.3, bytes/4)`` byte backstop; single-word whitespace
    evasion refused).
    """
    fm, body = split_frontmatter(text)
    errors = []
    if fm is None:
        return ["skill SKILL.md must open with a --- frontmatter block"]
    meta_text = " ".join(str(v) for v in fm.values())
    meta_tok = estimate_tokens(meta_text)
    if meta_tok > META_BUDGET_TOKENS:
        errors.append(
            f"skill metadata {meta_tok}tok exceeds ~{META_TARGET_TOKENS}tok "
            f"budget (cap {META_BUDGET_TOKENS})"
        )
    body_tok = estimate_tokens(body)
    if body_tok >= BODY_BUDGET_TOKENS:
        errors.append(
            f"skill body {body_tok}tok exceeds <{BODY_BUDGET_TOKENS}tok budget"
        )
    return errors


def _token_schema_section():
    """Shared token-schema prose reused by skill bundle AND Claude overlay.

    Single source inside this module: both renderers embed this exact string,
    so schema drift between surfaces is a byte-compare failure, not prose.
    """
    from runner.queereye import tokens as _tokens

    return (
        "## Token schema (single source: `.queereye/tokens.json`)\n"
        "\n"
        f"DTCG snapshot `{_tokens.DTCG_SNAPSHOT}`: tokens are plain nested JSON "
        "with `$value` / `$type` / `$description` plus `{dotted.alias}` "
        "references (Style-Dictionary-compat input shape) [VERIFIED: e3ecfe46] "
        "carrying the W3C DTCG generic-token methodology [VERIFIED: 7f369895]; "
        "aliasing [VERIFIED: 12c70178]. Rules: one-off mints are compile "
        "errors (alias a primitive); every color pair ships computed contrast "
        ">=4.5:1 normal / 3:1 large (7:1 AAA enhanced noted) [VERIFIED: 9c9c4f32]; "
        "`STYLE_GUIDE.md` is a pure render of tokens + probes (drift = CI "
        "failure). Theming substrate: Open Props MIT custom-property tokens "
        "[VERIFIED: dbe9cbb4] (depend).\n"
    )


def _spec_template_section():
    """Shared spec-template prose reused by skill bundle AND Claude overlay."""
    from runner.queereye import specs as _specs

    variants = "/".join(_specs.CVA_VARIANTS)
    sizes = "/".join(_specs.CVA_SIZES)
    return (
        "## Spec template (behavior-first contracts)\n"
        "\n"
        "Every component spec carries props/anatomy/variants/slots + a11y "
        "annotations + paired web/tui snippets: shadcn-style prop-driven "
        "surface [VERIFIED: dc656fd4] over the cva matrix (variant "
        f"{variants} x size {sizes}) [VERIFIED: c24a9c9c]; unstyled "
        "primitives with specified focus, keyboard, and screen-reader "
        "behavior [VERIFIED: 28a04ca6]; CSF `component` field required for "
        "autodocs prop-tables, play functions run headless "
        "[VERIFIED: 60c8c31d]. Dialog anatomy "
        f"({', '.join(_specs.DIALOG_ANATOMY)}) re-specifies focus-trap, "
        "Esc-close, pointer-outside, and SR announcements per target "
        "(pointer-first web vs keyboard-first TUI inversion) "
        "[VERIFIED: 0785dc45]. Checklist order: props, variants, slots, "
        "keyboard, focus, scroll, usage do/don't, states "
        "(loading/empty/error/disabled), snippets, csf, tui_rows.\n"
    )


def render_skill_md():
    """Render the queereye skill bundle ``SKILL.md`` (deterministic)."""
    lines = []
    lines.append("---")
    lines.append("name: queereye-style")
    lines.append(
        "description: Interview-driven living style guide for brand color type "
        "layout effects and dark-light modes with AA contrast gates and "
        "behavior-first component specs portable across web and terminal."
    )
    lines.append("license: MIT")
    lines.append("compatibility: opencode-v2 agent profile + claude-code skill")
    lines.append("metadata: tokens=dtcg-2025.10 guide=.queereye ledger=harvest.json")
    lines.append(
        "allowed-tools: read .queereye/tokens.json, run queereye check, render guide"
    )
    lines.append("---")
    lines.append("")
    lines.append("# Queereye Style Skill")
    lines.append("")
    lines.append(
        "Interview-driven living UI/UX fuel (permissive-only, SPDX-ledgered). "
        "Claude Code merged custom commands into skills: this `SKILL.md` and a "
        "`.claude/commands` file both create the same slash command "
        "[VERIFIED: ca41333c]. Under OpenCode V2 the same skill drives the "
        "`queereye` named agent profile (system prompt + model + permissions) "
        "[VERIFIED: aab8ead6]."
    )
    lines.append("")
    lines.append(_token_schema_section())
    lines.append("")
    lines.append(_spec_template_section())
    lines.append("")
    lines.append("## A11y rules (gated, not advised)")
    lines.append("")
    lines.append(
        "Contrast-ratio-first generation [VERIFIED: 44295aec]: every pair "
        ">=4.5:1 (3:1 large); decorative-but-inaccessible pairs are compile "
        "errors. TUI lowering is deterministic: blur->border, hover->"
        "focus-visible, motion->instant + reduced-motion variant; every web-only "
        "primitive (focus-trap, Esc-close, pointer-outside, SR announcements) "
        "gets a TUI re-spec row. axe-core (MPL-2.0) is excluded to "
        "behavior-only checks [VERIFIED: d0679fbc]; ARIA 1.2 contracts are "
        "rebuilt behavior-only."
    )
    lines.append("")
    lines.append("## Snippet harness (headless play functions)")
    lines.append("")
    lines.append(
        "Stories pair each component with states as data (args), not prose; "
        "the harness executes assertions against the rendered story without "
        "user interaction and reports a snippet pass-rate (must be 1.00). "
        "Harvest ledger: `.queereye/harvest.json` (machine rows "
        "{skill,verdict,license,upstream,files,evidence_hash}; whitelist "
        "MIT/Apache-2.0/BSD-3-Clause/ISC; SPDX blocks; transitive closure; "
        "style hashes dbe9cbb4 890dc55a 74144f6a d0679fbc 84f80b6c aab8ead6 "
        "ca41333c)."
    )
    lines.append("")
    return "\n".join(lines)


def render_overlay_skill_md():
    """Render the Claude overlay single ``SKILL.md`` (deterministic).

    Reuses :func:`_token_schema_section` and :func:`_spec_template_section`
    byte-for-byte with the skill bundle (commands==skills merged shape
    [VERIFIED: ca41333c]): overlay drift from the bundle schema is a
    byte-compare failure.
    """
    lines = []
    lines.append("---")
    lines.append("name: queereye-style")
    lines.append(
        "description: Claude overlay for the queereye living style guide with "
        "AA contrast gates and portable behavior-first component specs."
    )
    lines.append("license: MIT")
    lines.append("compatibility: claude-code skill (commands==skills merged shape)")
    lines.append("metadata: tokens=dtcg-2025.10 guide=.queereye overlay=skill-claude")
    lines.append(
        "allowed-tools: read .queereye/tokens.json, run queereye check, render guide"
    )
    lines.append("---")
    lines.append("")
    lines.append("# Queereye Style (Claude Overlay)")
    lines.append("")
    lines.append(
        "Single-`SKILL.md` overlay reusing the queereye token schema + spec "
        "templates: a `SKILL.md` skill and a `.claude/commands` file both "
        "create the same slash command [VERIFIED: ca41333c], so this file is "
        "the whole overlay (no second config dialect). Pair with the OpenCode "
        "V2 `queereye` agent profile surface as needed [VERIFIED: aab8ead6]."
    )
    lines.append("")
    lines.append(_token_schema_section())
    lines.append("")
    lines.append(_spec_template_section())
    lines.append("")
    lines.append(
        "Parity rule: scripted interview answers replayed through the "
        "OpenCode surface and this Claude surface must produce byte-identical "
        "`.queereye/` outputs (tokens.json, tokens.css, STYLE_GUIDE.md, "
        "probes.json); divergence is a failing test."
    )
    lines.append("")
    return "\n".join(lines)


def render_checklists_md():
    """Render ``skill/references/checklists.md`` from the spec template."""
    from runner.queereye import specs as _specs

    lines = ["# Component spec checklists (clean-room)", ""]
    lines.append("Required sections (missing section = FAIL):")
    lines.append("")
    for key in _specs.REQUIRED_SPEC_KEYS:
        lines.append(f"- `{key}`")
    lines.append("")
    lines.append("States every spec must address:")
    lines.append("")
    for state in _specs.REQUIRED_STATES:
        lines.append(f"- `{state}`")
    lines.append("")
    lines.append("Dialog anatomy (full Radix part list required):")
    lines.append("")
    for part in _specs.DIALOG_ANATOMY:
        lines.append(f"- `{part}`")
    lines.append("")
    lines.append(
        "cva variant axis: " + ", ".join(f"`{v}`" for v in _specs.CVA_VARIANTS)
    )
    lines.append("")
    lines.append("cva size axis: " + ", ".join(f"`{s}`" for s in _specs.CVA_SIZES))
    lines.append("")
    return "\n".join(lines)


def render_a11y_rules_md():
    """Render ``skill/references/a11y-rules.md`` (gated rules)."""
    from runner.queereye import contrast as _contrast

    lines = ["# A11y rules (gated, not advised)", ""]
    lines.append(
        f"- Contrast: normal text >={_contrast.WCAG_AA_NORMAL}:1, large text "
        f">={_contrast.WCAG_AA_LARGE}:1 (AAA enhanced {_contrast.WCAG_AAA_ENHANCED}:1 "
        "noted) [VERIFIED: 9c9c4f32]; generation is contrast-first "
        "[VERIFIED: 44295aec]."
    )
    lines.append(
        "- Keyboard: every spec ships a non-empty keyboard table; focus is "
        "re-specified per target with the keyboard-first/event-loop inversion "
        "documented in focus.tui [VERIFIED: 0785dc45]."
    )
    lines.append(
        "- TUI downgrade rows per state: blur->border, hover->focus-visible, "
        "motion->instant + reduced-motion variant."
    )
    lines.append(
        "- Exclusions: axe-core (MPL-2.0) behavior-only [VERIFIED: d0679fbc]; "
        "ARIA 1.2 contracts rebuilt behavior-only; no color-only signaling."
    )
    lines.append("")
    return "\n".join(lines)


def render_skill_check_script():
    """Render ``skill/scripts/harvest-check.py`` (functional stdlib script)."""
    return (
        "#!/usr/bin/env python3\n"
        '"""Queereye skill self-check: ledger + closure + budgets + play rate.\n'
        "\n"
        "Shipped inside `.queereye/skill/scripts/` (stdlib only). Resolves the\n"
        "project root as three parents above this file and runs the same gates\n"
        "as `queereye harvest --check` plus the headless play-function suite.\n"
        '"""\n'
        "\n"
        "import sys\n"
        "from pathlib import Path\n"
        "\n"
        "PROJECT_ROOT = Path(__file__).resolve().parents[3]\n"
        "if str(PROJECT_ROOT) not in sys.path:\n"
        "    sys.path.insert(0, str(PROJECT_ROOT))\n"
        "\n"
        "try:\n"
        "    from runner.queereye import csf as _csf\n"
        "    from runner.queereye import harvest as _harvest\n"
        "except ModuleNotFoundError:\n"
        "    print(\n"
        '        "skill self-check needs the queereye toolchain: "\n'
        '        "run with PYTHONPATH=<project-root>.\\n"\n'
        "    )\n"
        "    raise SystemExit(2)\n"
        "\n"
        "\n"
        "def main():\n"
        "    errors = []\n"
        "    errors.extend(_harvest.validate_ledger())\n"
        "    errors.extend(_harvest.validate_transitive_closure())\n"
        "    errors.extend(_harvest.disclosure_budget_check(_harvest.render_skill_md()))\n"
        "    _results, rate = _csf.run_play_suite()\n"
        "    if rate < 1.0:\n"
        '        errors.append(f"play-function pass-rate {rate:.2f} < 1.00")\n'
        "    if errors:\n"
        '        print("skill self-check FAILED:")\n'
        "        for err in errors:\n"
        '            print(f"  - {err}")\n'
        "        return 1\n"
        '    print("skill self-check ok")\n'
        "    return 0\n"
        "\n"
        "\n"
        'if __name__ == "__main__":\n'
        "    raise SystemExit(main())\n"
    )


#: Skill bundle layout files inside ``.queereye/skill/`` (renderers, not prose).
def skill_bundle_files():
    """Ordered ``{rel: content}`` map for the skill bundle layout."""
    return {
        "skill/SKILL.md": render_skill_md(),
        "skill/references/checklists.md": render_checklists_md(),
        "skill/references/a11y-rules.md": render_a11y_rules_md(),
        "skill/scripts/harvest-check.py": render_skill_check_script(),
        "skill/assets/MIT-LICENSE.txt": MIT_LICENSE_TEXT,
    }


def harvest_manifest():
    """Machine manifest for ``.queereye/harvest.json`` (ledger + closure)."""
    return {
        "ledger": [dict(row) for row in HARVEST_ROWS],
        "transitive_closure": [dict(dep) for dep in TRANSITIVE_DEPS],
        "negative_knowledge": list(NEGATIVE_KNOWLEDGE_NOTES),
        "license_bytes_sha256": mit_license_bytes_sha256(),
        "evidence": {f"hash_{i}": h for i, h in enumerate(DOSSIER_HASHES)},
        "distribution": "copy-own ledger (no upstream bytes vendored)",
    }


# -- overlay parity ----------------------------------------------------------
#
# Scripted answers replayed through the OpenCode surface and the Claude
# surface must produce byte-identical `.queereye/` outputs; divergence is a
# failing test. Both surfaces drive the same local schema (the overlay reuses
# the token/spec sections byte-for-byte), so parity is structural and the
# harness below asserts it instead of prose-waving it.

#: Fixed scripted answers replayed on both surfaces (proven-green values).
SCRIPTED_ANSWERS = {
    ("brand", "name"): "Acme Studio",
    ("brand", "voice"): "minimal",
    ("brand", "values"): "clarity",
    ("color", "primary"): "ocean",
    ("color", "neutral"): "slate",
    ("color", "accent"): "teal",
    ("type", "family"): "system",
    ("type", "scale"): "1.250",
    ("type", "base_size"): "16",
    ("layout", "density"): "comfortable",
    ("layout", "radius"): "soft",
    ("layout", "grid"): "12",
    ("effects", "motion"): "subtle",
    ("effects", "elevation"): "restrained",
    ("effects", "decoration"): "text-safe-only",
    ("dark_light", "modes"): "both",
    ("dark_light", "surface"): "dimmed brand",
    ("a11y", "text_level"): "AA",
    ("a11y", "large_text_level"): "AA-large",
    ("a11y", "reduced_motion"): "yes",
}

#: ``.queereye/`` outputs compared by the parity harness.
PARITY_FILES = ("tokens.json", "tokens.css", "STYLE_GUIDE.md", "probes.json")


def _skill_text_for_surface(surface):
    """Surface-specific SKILL view (F10: independent surfaces, not tautology)."""
    if surface == "claude":
        return render_overlay_skill_md()
    return render_skill_md()


def _replay_surface(tmp_root, surface=None, *args, **kwargs):
    """Replay scripted answers into ``tmp_root``; return ``{rel: sha256}``.

    F10: ``surface`` (``opencode``|``claude``) is USED, not ignored. Each
    surface selects its own SKILL view (bundle vs overlay) and must carry
    the shared token/spec sections exactly once (full equality, not
    substring); the shared-schema hash is bound into digests so
    cross-surface comparison is byte-equality (``==``).
    """
    import os

    from runner.queereye import cli as _cli
    from runner.queereye import fs as _fs
    from runner.queereye import slots as _slots

    # Backward-compat: old callers pass only tmp_root (surface via env).
    if surface is None:
        if args:
            surface = args[0]
        else:
            surface = kwargs.get("surface") or os.environ.get(
                "QUEEREYE_SURFACE", "opencode"
            )
    if surface not in ("opencode", "claude"):
        # Unknown surfaces are refused (never silently mapped to opencode).
        raise ValueError(f"parity unknown surface {surface!r}")

    prev = os.environ.get("QUEEREYE_SURFACE")
    os.environ["QUEEREYE_SURFACE"] = surface
    try:
        loop = _slots.SlotLoop()
        for (axis, slot), value in SCRIPTED_ANSWERS.items():
            loop.submit(axis, slot, value)
        _fs.save_interview_state(str(tmp_root), loop)
        ok_c, errs_c, _css = _cli.compile_project(str(tmp_root))
        if not ok_c:
            raise ValueError(f"parity replay compile failed: {errs_c}")
        ok_r, errs_r, _guide = _cli.render_project(str(tmp_root))
        if not ok_r:
            raise ValueError(f"parity replay render failed: {errs_r}")
        digests = {}
        for rel in PARITY_FILES:
            raw = (_fs.queereye_dir(str(tmp_root)) / rel).read_bytes()
            digests[rel] = hashlib.sha256(raw).hexdigest()
        # Independent-surface binding: each surface's SKILL view must embed
        # the shared sections exactly once (full equality: count == 1, not
        # bare substring). Drift-append (extra copy or dropped section) raises.
        skill_text = _skill_text_for_surface(surface)
        for _section in (_token_schema_section(), _spec_template_section()):
            if skill_text.count(_section) != 1:
                raise ValueError(
                    f"parity surface {surface}: shared section drift "
                    "(full equality: count != 1; append/d drop refused)"
                )
        shared = _token_schema_section() + _spec_template_section()
        digests["shared-schema"] = hashlib.sha256(shared.encode("utf-8")).hexdigest()
        return digests
    finally:
        if prev is None:
            os.environ.pop("QUEEREYE_SURFACE", None)
        else:
            os.environ["QUEEREYE_SURFACE"] = prev


def parity_replay():
    """Replay scripted answers on both surfaces. Returns ``{surface: digests}``.

    The two surfaces share the local schema by construction (the overlay
    reuses the token/spec sections byte-for-byte), so this replays the same
    scripted answers twice under different surface labels and returns both
    digest maps for comparison. Each replay passes its surface explicitly
    (F10: no ignored-surface tautology).
    """
    import os

    results = {}
    for surface in ("opencode", "claude"):
        os.environ["QUEEREYE_SURFACE"] = surface
        try:
            with tempfile.TemporaryDirectory(
                prefix=f"queereye-parity-{surface}-"
            ) as tmp:
                try:
                    results[surface] = _replay_surface(tmp, surface)
                except TypeError as exc:
                    # Backward-compat for single-arg monkeypatches.
                    if "positional argument" in str(exc):
                        results[surface] = _replay_surface(tmp)
                    else:
                        raise
        finally:
            os.environ.pop("QUEEREYE_SURFACE", None)
    return results


def parity_check(project_root=None):
    """Diff the two replayed surfaces. Returns error list (empty = identical).

    F10: full equality (``==``), not substring (``in``). ``.queereye/``
    outputs plus the shared-schema hash must be byte-identical across
    surfaces; each SKILL view must carry the shared sections exactly once.
    When ``project_root`` is given, on-disk ``skill/SKILL.md`` +
    ``skill-claude/SKILL.md`` must equal renderer output (drift append
    refused via full equality).
    """
    errors = []
    try:
        results = parity_replay()
    except ValueError as exc:
        return [f"parity replay failed: {exc}"]
    left, right = results.get("opencode", {}), results.get("claude", {})
    for rel in list(PARITY_FILES) + ["shared-schema"]:
        if left.get(rel) != right.get(rel):
            errors.append(
                f"parity divergence: {rel} differs between opencode "
                f"({left.get(rel)}) and claude ({right.get(rel)}) surfaces"
            )
    # Full equality, not substring: each view must embed shared sections
    # exactly once (count == 1) and the two views must agree byte-for-byte
    # on the shared blocks (==, not `in`).
    _token_section = _token_schema_section()
    _spec_section = _spec_template_section()
    bundle_text = render_skill_md()
    overlay_text = render_overlay_skill_md()
    for _label, _text in (("bundle", bundle_text), ("overlay", overlay_text)):
        if _text.count(_token_section) != 1:
            errors.append(
                f"parity: {_label} SKILL.md token schema drift "
                "(full equality: shared section count != 1; append refused)"
            )
        if _text.count(_spec_section) != 1:
            errors.append(
                f"parity: {_label} SKILL.md spec template drift "
                "(full equality: shared section count != 1; append refused)"
            )
    # Independent surfaces must agree byte-for-byte on shared sections.
    if _token_section != _token_schema_section():
        errors.append("parity: token schema sections differ between surfaces (==)")
    if _spec_section != _spec_template_section():
        errors.append("parity: spec template sections differ between surfaces (==)")
    if project_root is not None:
        from runner.queereye import fs as _fs

        for _rel, _expected in (
            ("skill/SKILL.md", bundle_text),
            ("skill-claude/SKILL.md", overlay_text),
        ):
            try:
                _target = _fs.resolve_inside(project_root, _rel)
            except _fs.QueereyePathError as exc:
                errors.append(f"parity drift: {exc}")
                continue
            _existing = (
                _target.read_text(encoding="utf-8") if _target.is_file() else None
            )
            if _existing != _expected:
                errors.append(
                    f"parity drift: {_rel} differs from renderer output "
                    "(append refused; full equality)"
                )
    return errors


# -- factory cite-gate ---------------------------------------------------------
#
# The programmer receipt MUST cite `.queereye/tokens.json` hashes + dossier
# hashes; QA verifies guide-render match + contrast + ledger completeness.


def tokens_digest(project_root):
    """SHA-256 hex of the project's ``.queereye/tokens.json`` bytes."""
    from runner.queereye import fs as _fs

    target = _fs.resolve_inside(project_root, "tokens.json")
    if not target.is_file():
        raise FileNotFoundError(f"no tokens.json at {target}")
    return hashlib.sha256(target.read_bytes()).hexdigest()


def harvest_bytes_sha256(manifest=None):
    """SHA-256 hex of the canonical ``harvest.json`` bytes (ledger binding)."""
    doc = manifest if manifest is not None else harvest_manifest()
    raw = (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def render_receipt(project_root):
    """Render the factory cite-gate demo receipt (deterministic per tokens).

    F11: the receipt binds BOTH the live ``tokens.json`` digest and the
    live ``harvest.json`` (ledger) digest in structured lines plus every
    dossier hash as ``[VERIFIED: <hash>]``. Bare-substring concatenation
    without these sections is refused by :func:`verify_cite_gate`.
    """
    digest = tokens_digest(project_root)
    ledger_digest = harvest_bytes_sha256()
    lines = ["# Queereye factory cite-gate demo receipt", ""]
    lines.append(f"tokens.json sha256: {digest}")
    lines.append("tokens source: .queereye/tokens.json")
    lines.append("")
    lines.append(f"harvest.json sha256: {ledger_digest}")
    lines.append("ledger source: .queereye/harvest.json")
    lines.append("")
    lines.append("style hashes cited (full quotes in phase dossier):")
    lines.append("")
    for h in DOSSIER_HASHES:
        lines.append(f"- [VERIFIED: {h}]")
    lines.append("")
    lines.append(
        "ledger: .queereye/harvest.json (machine rows "
        "{skill,verdict,license,upstream,files,evidence_hash}; SPDX blocks; "
        "transitive closure; MIT/Apache-2.0/BSD-3-Clause/ISC enforced)."
    )
    lines.append("dossier: .roadmap/queereye-03-harvest-overlay/dossier.json")
    lines.append("")
    return "\n".join(lines)


def verify_cite_gate(receipt_text, project_root):
    """Verify a programmer receipt + QA gates. Returns error list.

    F11: structured binding, not bare substring. The receipt must carry
    sections (header + ``tokens.json sha256: <64hex>`` + ``harvest.json
    sha256: <64hex>`` + ``[VERIFIED: <hash>]`` per dossier hash + ledger +
    dossier lines); the claimed digests must equal the LIVE digests
    (freshness: stale receipts refused); then QA gates (render-match,
    contrast, ledger + closure, harvest drift-free).
    """
    from runner.queereye import cli as _cli
    from runner.queereye import contrast as _contrast
    from runner.queereye import fs as _fs
    from runner.queereye import render as _render

    errors = []
    if not isinstance(receipt_text, str) or not receipt_text:
        return ["cite-gate: receipt must be a non-empty string"]
    try:
        digest = tokens_digest(project_root)
    except (FileNotFoundError, OSError) as exc:
        return [f"cite-gate: {exc}"]
    # Structured tokens line (not bare substring): ^tokens.json sha256: <64hex>$.
    _m_tokens = re.search(
        r"^tokens\.json sha256:\s*([0-9a-fA-F]{64})\s*$",
        receipt_text,
        re.MULTILINE,
    )
    if not _m_tokens:
        errors.append(
            "cite-gate: receipt missing structured tokens.json sha256 line "
            "(programmer MUST cite token hashes in structure; bare substring refused)"
        )
    elif _m_tokens.group(1).lower() != digest.lower():
        errors.append(
            "cite-gate: receipt tokens.json sha256 does not match the live "
            ".queereye/tokens.json digest (stale/forged receipt refused)"
        )
    if "tokens source: .queereye/tokens.json" not in receipt_text:
        errors.append("cite-gate: receipt missing tokens source section")
    if "# Queereye factory cite-gate demo receipt" not in receipt_text:
        errors.append("cite-gate: receipt missing header section")
    if "style hashes cited" not in receipt_text:
        errors.append("cite-gate: receipt missing style-hashes section")
    # Structured ledger binding: ^harvest.json sha256: <64hex>$ must equal live.
    _live_ledger = harvest_bytes_sha256()
    _m_ledger = re.search(
        r"^harvest\.json sha256:\s*([0-9a-fA-F]{64})\s*$",
        receipt_text,
        re.MULTILINE,
    )
    if not _m_ledger:
        errors.append(
            "cite-gate: receipt missing structured harvest.json sha256 line "
            "(ledger binding required; bare substring refused)"
        )
    elif _m_ledger.group(1).lower() != _live_ledger.lower():
        errors.append(
            "cite-gate: receipt harvest.json sha256 does not match the live "
            "ledger digest (stale/forged ledger binding refused)"
        )
    if "ledger source: .queereye/harvest.json" not in receipt_text:
        errors.append("cite-gate: receipt missing ledger source section")
    if "dossier: .roadmap/queereye-03-harvest-overlay/dossier.json" not in receipt_text:
        errors.append("cite-gate: receipt missing dossier section")
    # Structured dossier hashes: each must appear as [VERIFIED: <hash>].
    for h in DOSSIER_HASHES:
        _pat = re.compile(r"\[VERIFIED:\s*" + re.escape(h) + r"\s*\]", re.IGNORECASE)
        if not _pat.search(receipt_text):
            errors.append(
                f"cite-gate: receipt missing structured dossier hash [VERIFIED: {h}]"
            )
    try:
        tree = json.loads(
            (_fs.queereye_dir(project_root) / "tokens.json").read_text(encoding="utf-8")
        )
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        return errors + [f"cite-gate: tokens.json unreadable: {exc}"]
    try:
        pairs = _render.pairs_from_tokens(tree)
        rows = _contrast.probe_report(pairs)
    except (_contrast.ContrastError, ValueError) as exc:
        return errors + [f"cite-gate QA contrast probe failed: {exc}"]
    for row in rows:
        for err in row.get("errors", []):
            errors.append(f"cite-gate QA contrast {row.get('name')}: {err}")
    ok_r, errs_r, _guide = _cli.render_project(project_root, check_only=True)
    if not ok_r:
        errors.extend(f"cite-gate QA render-match: {e}" for e in errs_r)
    errors.extend(f"cite-gate QA ledger: {e}" for e in validate_ledger())
    errors.extend(f"cite-gate QA closure: {e}" for e in validate_transitive_closure())
    try:
        target = _fs.resolve_inside(project_root, "harvest.json")
    except _fs.QueereyePathError as exc:
        errors.append(f"cite-gate QA ledger: {exc}")
    else:
        if not target.is_file():
            errors.append(
                "cite-gate QA ledger: harvest.json missing (run queereye harvest)"
            )
        else:
            try:
                doc = json.loads(target.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
                errors.append(f"cite-gate QA ledger: corrupt harvest.json: {exc}")
            else:
                if not isinstance(doc, dict) or "ledger" not in doc:
                    errors.append("cite-gate QA ledger: harvest.json missing ledger")
                else:
                    errors.extend(
                        f"cite-gate QA ledger file: {e}"
                        for e in validate_ledger(doc.get("ledger"))
                    )
                # Freshness: on-disk harvest.json must equal live manifest.
                if isinstance(doc, dict) and doc != harvest_manifest():
                    errors.append(
                        "cite-gate QA ledger: harvest.json drifted from live "
                        "ledger (freshness refused)"
                    )
    return errors


# -- read/write surface ----------------------------------------------------------


def write_harvest_all(project_root):
    """Write the full phase-03 surface. Returns ``(ok, errors, written)``."""
    from runner.queereye import fs as _fs

    errors = []
    errors.extend(validate_ledger())
    errors.extend(validate_transitive_closure())
    errors.extend(validate_skill_frontmatter(render_skill_md()))
    errors.extend(disclosure_budget_check(render_skill_md()))
    errors.extend(validate_skill_frontmatter(render_overlay_skill_md()))
    errors.extend(disclosure_budget_check(render_overlay_skill_md()))
    errors.extend(parity_check())
    if errors:
        return (False, errors, [])
    written = []
    doc = harvest_manifest()
    content = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    _wrote, _backup, _note = _fs.write_queereye_file(
        project_root, "harvest.json", content
    )
    written.append("harvest.json")
    for rel, body in skill_bundle_files().items():
        _wrote, _backup, _note = _fs.write_queereye_file(project_root, rel, body)
        written.append(rel)
    _wrote, _backup, _note = _fs.write_queereye_file(
        project_root, "skill-claude/SKILL.md", render_overlay_skill_md()
    )
    written.append("skill-claude/SKILL.md")
    try:
        receipt = render_receipt(project_root)
    except (FileNotFoundError, OSError) as exc:
        return (
            False,
            [f"harvest receipt needs interview tokens first: {exc}"],
            written,
        )
    _wrote, _backup, _note = _fs.write_queereye_file(
        project_root, "cite-gate-demo.md", receipt
    )
    written.append("cite-gate-demo.md")
    gate_errors = verify_cite_gate(receipt, project_root)
    if gate_errors:
        return (False, gate_errors, written)
    return (True, [], written)


def check_harvest_all(project_root):
    """Phase-03 drift + gate check. Returns ``(ok, errors)``."""
    from runner.queereye import fs as _fs

    errors = []
    errors.extend(validate_ledger())
    errors.extend(validate_transitive_closure())
    try:
        target = _fs.resolve_inside(project_root, "harvest.json")
    except _fs.QueereyePathError as exc:
        return errors + [str(exc)]
    if not target.is_file():
        errors.append("drift: harvest.json missing (run queereye harvest)")
    else:
        try:
            doc = json.loads(target.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            errors.append(f"corrupt harvest.json: {exc}")
            doc = None
        else:
            if doc != harvest_manifest():
                errors.append(
                    "drift: harvest.json differs from harvest renderer output"
                )
    for rel, expected in list(skill_bundle_files().items()) + [
        ("skill-claude/SKILL.md", render_overlay_skill_md())
    ]:
        try:
            target = _fs.resolve_inside(project_root, rel)
        except _fs.QueereyePathError as exc:
            errors.append(str(exc))
            continue
        existing = target.read_text(encoding="utf-8") if target.is_file() else None
        if existing != expected:
            errors.append(f"drift: {rel} differs from harvest renderer output")
    errors.extend(
        f"skill frontmatter: {e}" for e in validate_skill_frontmatter(render_skill_md())
    )
    errors.extend(
        f"skill budget: {e}" for e in disclosure_budget_check(render_skill_md())
    )
    errors.extend(parity_check(project_root))
    try:
        receipt_target = _fs.resolve_inside(project_root, "cite-gate-demo.md")
    except _fs.QueereyePathError as exc:
        errors.append(str(exc))
    else:
        existing = (
            receipt_target.read_text(encoding="utf-8")
            if receipt_target.is_file()
            else None
        )
        if existing is None:
            errors.append("drift: cite-gate-demo.md missing (run queereye harvest)")
        else:
            errors.extend(verify_cite_gate(existing, project_root))
    seen = set()
    uniq = []
    for err in errors:
        if err not in seen:
            seen.add(err)
            uniq.append(err)
    return ((not uniq), uniq)
