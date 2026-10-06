#!/usr/bin/env python3
"""Queereye CLI: ``compile`` / ``render`` / ``check`` (``--check`` drift gate).

- ``compile``: validate tokens (DTCG-shaped schema, one-off gate, contrast
  gate) then emit ``.queereye/tokens.css`` from the single source
  [VERIFIED: e3ecfe46]. One-off mints and sub-AA pairs are compile errors.
- ``render``: pure-render ``.queereye/STYLE_GUIDE.md`` from ``tokens.json`` +
  contrast-probe output (+ ``probes.json`` sidecar). Byte-match enforced.
- ``check``: drift gate — fails when ``tokens.css`` / ``STYLE_GUIDE.md`` /
  ``probes.json`` differ from renderer output. ``--strict`` additionally
  fails on any schema / one-off / contrast / alias-reuse violation (the
  50-edit simulation target: 0 contradictions). When the project has
  adopted the phase-02 surface (``components/`` or webref/tui/csf files),
  ``check`` additionally enforces the spec gates (adoption-guarded, so
  interview-only projects stay green).
- ``specs``: write (default) or ``--check`` the phase-02 surface —
  ``components/<name>.md`` + ``webref.json`` + ``tui-notes.md`` +
  ``csf.json`` (spec-completeness, TUI-coverage, snapshot-freshness,
  license, play-function, spec-vs-render gates).
- ``harvest``: write (default) or ``--check`` the phase-03 surface —
  ``harvest.json`` + ``skill/`` bundle + ``skill-claude/SKILL.md`` +
  ``cite-gate-demo.md`` (ledger, transitive closure, frontmatter/budget,
  overlay parity, cite-gate gates).

All paths stay inside ``.queereye/`` (hard error outside).
Corrupt ``tokens.json`` / ``interview.json`` (truncated JSON) is a
structured gate failure (``queereye <cmd> FAILED`` + non-zero rc with an
actionable message), never a traceback.
Zero runtime dependencies (stdlib only).
"""

import argparse
import json
import sys
from pathlib import Path

from runner.queereye import contrast as _contrast
from runner.queereye import csf as _csf
from runner.queereye import fs as _fs
from runner.queereye import harvest as _harvest
from runner.queereye import render as _render
from runner.queereye import specs as _specs
from runner.queereye import tokens as _tokens
from runner.queereye import tui as _tui
from runner.queereye import webref as _webref


def _read_tokens(project_root):
    path = _fs.queereye_dir(project_root) / "tokens.json"
    if not path.is_file():
        raise FileNotFoundError(f"no tokens.json at {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise _fs.QueereyeCorruptError(
            f"corrupt tokens.json at {path}: cannot read ({exc}); "
            "restore from backup or re-run the interview to regenerate"
        ) from exc
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise _fs.QueereyeCorruptError(
            f"corrupt tokens.json at {path}: {exc}; "
            "restore from backup or re-run the interview to regenerate"
        ) from exc
    return data, path


def _interview_errors(project_root):
    """Structured errors for a corrupt ``interview.json`` (empty when ok)."""
    path = _fs.queereye_dir(project_root) / "interview.json"
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [
            f"corrupt interview.json at {path}: cannot read ({exc}); "
            "restore from backup or delete it to restart the interview"
        ]
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return [
            f"corrupt interview.json at {path}: {exc}; "
            "restore from backup or delete it to restart the interview"
        ]
    if not isinstance(data, dict):
        return [
            f"corrupt interview.json at {path}: expected a JSON object; "
            "restore from backup or delete it to restart the interview"
        ]
    return []


def compile_project(project_root, check_only=False):
    """Validate + compile tokens to CSS vars. Returns ``(ok, errors, css)``."""
    try:
        tree, _path = _read_tokens(project_root)
    except FileNotFoundError as exc:
        return (False, [str(exc)], None)
    except _fs.QueereyeCorruptError as exc:
        return (False, [str(exc)], None)
    errors = list(_tokens.validate_tokens(tree))
    for path, reason in _tokens.find_one_offs(tree):
        errors.append(f"{path}: one-off mint refused ({reason}); alias a primitive")
    pairs = _render.pairs_from_tokens(tree)
    if not pairs:
        errors.append("no color pairs derivable from color.primitive")
    else:
        try:
            rows = _contrast.probe_report(pairs)
        except (_contrast.ContrastError, ValueError) as exc:
            errors.append(f"contrast probe failed: {exc}")
            rows = None
        else:
            for row in rows:
                for err in row["errors"]:
                    errors.append(f"contrast {row['name']}: {err}")
    if errors:
        return (False, errors, None)
    try:
        css = _render.compile_to_css_vars(tree)
    except ValueError as exc:
        return (False, [f"compile refused mixed value: {exc}"], None)
    if not check_only:
        _fs.write_queereye_file(project_root, "tokens.css", css)
    else:
        target = _fs.queereye_dir(project_root) / "tokens.css"
        existing = target.read_text(encoding="utf-8") if target.is_file() else None
        if existing != css:
            return (False, ["drift: tokens.css differs from compile output"], css)
    return (True, [], css)


def render_project(project_root, check_only=False):
    """Render STYLE_GUIDE.md + probes.json. Returns ``(ok, errors, guide)``."""
    try:
        tree, _path = _read_tokens(project_root)
    except FileNotFoundError as exc:
        return (False, [str(exc)], None)
    except _fs.QueereyeCorruptError as exc:
        return (False, [str(exc)], None)
    pairs = _render.pairs_from_tokens(tree)
    try:
        rows = _contrast.probe_report(pairs)
    except (_contrast.ContrastError, ValueError) as exc:
        return (False, [f"contrast probe failed: {exc}"], None)
    try:
        guide = _render.render_guide(tree, rows)
    except ValueError as exc:
        return (False, [f"render refused mixed value: {exc}"], None)
    probes_doc = {
        "dtcg_snapshot": _tokens.DTCG_SNAPSHOT,
        "aa_normal": _contrast.WCAG_AA_NORMAL,
        "aa_large": _contrast.WCAG_AA_LARGE,
        "aaa_enhanced": _contrast.WCAG_AAA_ENHANCED,
        "rows": rows,
    }
    probes_bytes = json.dumps(probes_doc, indent=2, sort_keys=True) + "\n"
    if not check_only:
        _fs.write_queereye_file(project_root, "probes.json", probes_bytes)
        _fs.write_queereye_file(project_root, "STYLE_GUIDE.md", guide)
        return (True, [], guide)
    errors = []
    for rel, expected in (("probes.json", probes_bytes), ("STYLE_GUIDE.md", guide)):
        target = _fs.queereye_dir(project_root) / rel
        existing = target.read_text(encoding="utf-8") if target.is_file() else None
        if existing != expected:
            errors.append(f"drift: {rel} differs from renderer output")
    # tokens.css drift is part of the check gate too.
    try:
        css = _render.compile_to_css_vars(tree)
    except ValueError as exc:
        errors.append(f"render refused mixed value: {exc}")
        return (False, errors, guide)
    css_target = _fs.queereye_dir(project_root) / "tokens.css"
    css_existing = (
        css_target.read_text(encoding="utf-8") if css_target.is_file() else None
    )
    if css_existing != css:
        errors.append("drift: tokens.css differs from compile output")
    return ((not errors), errors, guide)


def _specs_adopted(project_root):
    """True when the project uses the phase-02 spec surface.

    Backward-compat guard for phase 01: ``check`` only enforces spec gates
    when the project already carries spec outputs (components dir or
    webref/tui/csf files). Fresh interview-only projects never see spec
    errors here — they use ``queereye specs`` to adopt.
    """
    root = _fs.queereye_dir(project_root)
    if (root / "components").is_dir():
        return True
    for rel in ("webref.json", "tui-notes.md", "csf.json"):
        if (root / rel).is_file():
            return True
    return False


def specs_write_all(project_root):
    """Write the full phase-02 surface. Returns ``(ok, errors, written)``."""
    errors = []
    for name, errs in _specs.validate_all().items():
        errors.extend([f"spec {e}" for e in errs])
    for story_id, errs in _csf.validate_all_stories().items():
        errors.extend(errs)
    errors.extend(_webref.verify_snapshot(_webref.webref_manifest()))
    errors.extend(_webref.license_gate("MIT", "vendor"))
    if errors:
        return (False, errors, [])
    written = []
    for rel, wrote, _backup, _note in _specs.write_specs(project_root):
        written.append(rel)
    _wrote, _backup, _note = _webref.write_webref(project_root)
    written.append("webref.json")
    _wrote, _backup, _note = _tui.write_tui_notes(project_root)
    written.append("tui-notes.md")
    _wrote, _backup, _note = _csf.write_csf_manifest(project_root)
    written.append("csf.json")
    return (True, [], written)


def specs_check_all(project_root):
    """Phase-02 drift + gate check. Returns ``(ok, errors)``."""
    errors = []
    errors.extend(_specs.check_specs(project_root))
    errors.extend(_webref.check_webref(project_root))
    errors.extend(_tui.check_tui_notes(project_root))
    errors.extend(_csf.check_csf_manifest(project_root))
    for name, spec in _specs.EXEMPLARS.items():
        for err in _tui.validate_tui_coverage(spec):
            if err not in errors:
                errors.append(err)
        gate_errs = _csf.spec_vs_render_check(
            spec,
            rendered_slots=sorted((spec.get("slots") or {}).keys()),
            webref_fresh=_webref.is_fresh(),
        )
        for err in gate_errs:
            if err not in errors:
                errors.append(err)
    _results, rate = _csf.run_play_suite()
    if rate < 1.0:
        errors.append(f"specs play-function pass-rate {rate:.2f} < 1.00")
    errors.extend(_webref.license_gate("MIT", "vendor"))
    seen = set()
    uniq = []
    for err in errors:
        if err not in seen:
            seen.add(err)
            uniq.append(err)
    return ((not uniq), uniq)


def _harvest_adopted(project_root):
    """True when the project uses the phase-03 harvest surface.

    Backward-compat guard for phases 01-02: ``check`` only enforces harvest
    gates when the project already carries harvest outputs (harvest.json or
    the skill/skill-claude bundle dirs). Interview-only and specs-only
    projects never see harvest errors here -- they use ``queereye harvest``
    to adopt.
    """
    root = _fs.queereye_dir(project_root)
    if (root / "harvest.json").is_file():
        return True
    for rel in ("skill", "skill-claude", "cite-gate-demo.md"):
        if (root / rel).exists():
            return True
    return False


def harvest_write_all(project_root):
    """Write the full phase-03 surface. Returns ``(ok, errors, written)``."""
    return _harvest.write_harvest_all(project_root)


def harvest_check_all(project_root):
    """Phase-03 drift + gate check. Returns ``(ok, errors)``."""
    return _harvest.check_harvest_all(project_root)


def check_project(project_root, strict=False):
    """Drift gate (+ strict gates). Returns ``(ok, errors)``."""
    errors = []
    try:
        tree, _ = _read_tokens(project_root)
    except FileNotFoundError as exc:
        return (False, [str(exc)])
    except _fs.QueereyeCorruptError as exc:
        return (False, [str(exc)])
    # A truncated interview.json is a structured gate failure too (resume
    # source unreadable): report it alongside drift, never traceback.
    errors.extend(_interview_errors(project_root))
    try:
        ok_r, errs_r, _guide = render_project(project_root, check_only=True)
    except (_fs.QueereyeCorruptError, FileNotFoundError) as exc:
        errs_r = [str(exc)]
        ok_r = False
    errors.extend(errs_r)
    try:
        ok_c, errs_c, _css = compile_project(project_root, check_only=True)
    except (_fs.QueereyeCorruptError, FileNotFoundError) as exc:
        errs_c = [str(exc)]
        ok_c = False
    # compile check_only already reports drift; schema/one-off/contrast
    # errors surface as drift-adjacent failures too — keep both lists.
    for err in errs_c:
        if err not in errors:
            errors.append(err)
    if strict:
        schema_errs = _tokens.validate_tokens(tree)
        errors.extend([f"strict schema: {e}" for e in schema_errs])
        for path, reason in _tokens.find_one_offs(tree):
            errors.append(f"strict one-off: {path} ({reason})")
        pairs = _render.pairs_from_tokens(tree)
        try:
            probe_rows = _contrast.probe_report(pairs)
        except (_contrast.ContrastError, ValueError) as exc:
            errors.append(f"strict contrast probe failed: {exc}")
            probe_rows = []
        for row in probe_rows:
            for err in row["errors"]:
                errors.append(f"strict contrast {row['name']}: {err}")
        aliased, total, ratio = _tokens.alias_reuse_ratio(tree)
        # Alias-reuse is reported; strict requires at least half the tokens
        # alias a primitive (the interview always satisfies this: every
        # semantic/component value is an alias, so ratio ~= 0.6+).
        if total and (aliased / total) < 0.5:
            errors.append(
                f"strict alias-reuse: {aliased}/{total} = {ratio:.2f} below 0.50"
            )
    # Phase-02 adoption guard: spec gates only fire when the project
    # already carries spec outputs (never for interview-only projects).
    if _specs_adopted(project_root):
        _ok_s, errs_s = specs_check_all(project_root)
        errors.extend(errs_s)
    # Phase-03 adoption guard: harvest gates only fire when the project
    # already carries harvest outputs (never for interview/spec-only projects).
    if _harvest_adopted(project_root):
        _ok_h, errs_h = harvest_check_all(project_root)
        errors.extend(errs_h)
    # De-duplicate while preserving order.
    seen = set()
    uniq = []
    for err in errors:
        if err not in seen:
            seen.add(err)
            uniq.append(err)
    _ = (ok_r, ok_c)
    return ((not uniq), uniq)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="queereye", description="Queereye interview core CLI"
    )
    parser.add_argument(
        "--project-dir", default=".", help="Project root (contains .queereye/)"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("compile", "render", "check", "specs", "harvest"):
        child = sub.add_parser(name, help=f"queereye {name}")
        child.add_argument(
            "--strict", action="store_true", help="strict gates (check only)"
        )
        child.add_argument(
            "--check",
            action="store_true",
            help="drift check: do not write, fail on drift",
        )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    root = args.project_dir
    if args.command == "compile":
        if args.check:
            ok, errors, _css = compile_project(root, check_only=True)
        else:
            ok, errors, _css = compile_project(root, check_only=False)
        if not ok:
            print("queereye compile FAILED:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print("queereye compile ok")
        return 0
    if args.command == "render":
        if args.check:
            ok, errors, _guide = render_project(root, check_only=True)
        else:
            ok, errors, _guide = render_project(root, check_only=False)
        if not ok:
            print("queereye render FAILED:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print("queereye render ok")
        return 0
    if args.command == "check":
        ok, errors = check_project(root, strict=bool(args.strict))
        if not ok:
            print("queereye check FAILED:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print("queereye check ok" + (" (strict)" if args.strict else ""))
        return 0
    if args.command == "specs":
        if args.check:
            ok, errors = specs_check_all(root)
        else:
            ok, errors, _written = specs_write_all(root)
        if not ok:
            print("queereye specs FAILED:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print("queereye specs ok" + (" (check)" if args.check else ""))
        return 0
    if args.command == "harvest":
        if args.check:
            ok, errors = harvest_check_all(root)
        else:
            ok, errors, _written = harvest_write_all(root)
        if not ok:
            print("queereye harvest FAILED:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print("queereye harvest ok" + (" (check)" if args.check else ""))
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
