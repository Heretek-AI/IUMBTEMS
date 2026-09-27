#!/usr/bin/env python3
"""
Proof-Carrying Research Brief (PCRB) — standalone verifier (Stream D).

Verifies a brief.pcrb.json WITHOUT trusting the LLM that produced it and
WITHOUT the original .research/ workspace: every quote is re-checked against
the sources BUNDLED INSIDE the brief.

Checks (all must pass for exit 0):
  1. source identity  — sha256(source content) == its hash key in the bundle
  2. manifest integrity — every member hash recomputes to the manifest value
  3. signature — HMAC over the manifest (when alg != "none")
  4. quotes — every claim's verbatim_quote re-verified against the bundled
     source text, using the SAME verification stack as the auditor
     (SourceHasher.verify_quote via a throwaway cache directory)

Usage:
  python3 runner/pcrb_verify.py brief.pcrb.json [--json] [--key-file ...]

Exit codes: 0 = all checks passed, 1 = tampering/failure detected,
2 = unreadable bundle.
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Reuse the export-side canonicalization so hashes always agree.
from runner.pcrb import (  # noqa: E402
    ENV_KEY,
    canonical_json,
    member_hash,
    sha256_text,
)


def _check_source_identity(sources: Dict[str, Any]) -> List[Dict[str, str]]:
    failures = []
    for src_hash, meta in sources.items():
        content = meta.get("content") or ""
        actual = sha256_text(content)
        if actual != src_hash:
            failures.append({
                "check": "source_identity",
                "member": src_hash,
                "message": f"bundled source content hashes to {actual}, not its key {src_hash}",
            })
    return failures


def _check_manifest_integrity(
    bundle: Dict[str, Any],
    manifest: Dict[str, Any],
    claims: List[Dict[str, Any]],
    sources: Dict[str, Any],
) -> List[Dict[str, str]]:
    failures = []
    synth_hash = sha256_text(bundle.get("synthesis_markdown") or "")
    if manifest.get("synthesis_markdown") != synth_hash:
        failures.append({
            "check": "manifest_integrity",
            "member": "synthesis_markdown",
            "message": "synthesis_markdown does not match its manifest hash",
        })

    manifest_claims = manifest.get("claims") or {}
    for rec in claims:
        cid = rec.get("claim_id", "UNKNOWN")
        expected = manifest_claims.get(cid)
        actual = member_hash(rec)
        if expected is None:
            failures.append({"check": "manifest_integrity", "member": cid, "message": "claim missing from manifest"})
        elif expected != actual:
            failures.append({
                "check": "manifest_integrity",
                "member": cid,
                "message": f"claim hash mismatch (manifest {expected[:16]}… vs actual {actual[:16]}…)",
            })

    manifest_sources = manifest.get("sources") or {}
    for src_hash, meta in sources.items():
        expected = manifest_sources.get(src_hash)
        actual = sha256_text(meta.get("content") or "")
        if expected is None:
            failures.append({"check": "manifest_integrity", "member": src_hash, "message": "source missing from manifest"})
        elif expected != actual:
            failures.append({
                "check": "manifest_integrity",
                "member": src_hash,
                "message": "source content does not match its manifest hash",
            })
    return failures


def _check_signature(
    signature: Dict[str, Any],
    manifest: Dict[str, Any],
    key: Optional[bytes],
) -> Tuple[str, List[Dict[str, str]]]:
    alg = signature.get("alg") or "none"
    failures = []
    if alg != "hmac-sha256":
        return "unsigned", failures
    if not key:
        failures.append({
            "check": "signature",
            "member": "manifest",
            "message": "brief is HMAC-signed but no key was provided (env IUMBTEMS_PCRB_KEY or --key-file)",
        })
        return "unverifiable", failures

    expected_sig = hmac.new(key, canonical_json(manifest).encode("utf-8"), hashlib.sha256).hexdigest()
    provided = signature.get("sig") or ""
    if not hmac.compare_digest(expected_sig, provided):
        failures.append({
            "check": "signature",
            "member": "manifest",
            "message": "HMAC signature does not match manifest (manifest was rewritten or key differs)",
        })
        return "invalid", failures
    return "valid", failures


def _check_quotes(
    claims: List[Dict[str, Any]],
    sources: Dict[str, Any],
) -> Tuple[int, int, List[Dict[str, str]]]:
    quotes_verified = 0
    quotes_failed = 0
    failures = []
    with tempfile.TemporaryDirectory(prefix="pcrb_verify_") as tmp:
        from skills.research_cache.hasher import SourceHasher

        hasher = SourceHasher(Path(tmp))
        for src_hash, meta in sources.items():
            content = meta.get("content") or ""
            md_path = Path(tmp) / "sources" / f"{src_hash}.md"
            md_path.parent.mkdir(parents=True, exist_ok=True)
            md_path.write_text(content, encoding="utf-8")

        for rec in claims:
            cid = rec.get("claim_id", "UNKNOWN")
            witness = rec.get("witness") or {}
            src_hash = witness.get("source_hash") or rec.get("source_hash")
            quote = witness.get("quote") or rec.get("verbatim_quote")
            if not src_hash or not quote:
                continue
            if src_hash not in sources:
                quotes_failed += 1
                failures.append({
                    "check": "quote",
                    "member": cid,
                    "message": f"claim cites source {src_hash} which is not bundled",
                })
                continue
            passed, conf, msg = hasher.verify_quote(src_hash, quote)
            if passed:
                quotes_verified += 1
            else:
                quotes_failed += 1
                failures.append({
                    "check": "quote",
                    "member": cid,
                    "message": f"quote not found in bundled source (conf={conf}): {msg}",
                })
    return quotes_verified, quotes_failed, failures


def verify_brief(
    bundle: Dict[str, Any],
    key: Optional[bytes] = None,
) -> Dict[str, Any]:
    """Run all checks. Returns a structured report dict."""
    started = time.perf_counter()
    manifest = bundle.get("manifest") or {}
    signature = bundle.get("signature") or {}
    claims = bundle.get("claims") or []
    sources = bundle.get("sources") or {}

    failures: List[Dict[str, str]] = []
    failures.extend(_check_source_identity(sources))
    failures.extend(_check_manifest_integrity(bundle, manifest, claims, sources))
    sig_status, sig_failures = _check_signature(signature, manifest, key)
    failures.extend(sig_failures)
    quotes_verified, quotes_failed, quote_failures = _check_quotes(claims, sources)
    failures.extend(quote_failures)

    elapsed = time.perf_counter() - started
    return {
        "ok": not failures,
        "failures": failures,
        "checks": {
            "source_identity": "pass" if not any(f["check"] == "source_identity" for f in failures) else "fail",
            "manifest_integrity": "pass" if not any(f["check"] == "manifest_integrity" for f in failures) else "fail",
            "signature": sig_status,
            "quotes": "pass" if quotes_failed == 0 else "fail",
        },
        "stats": {
            "claims": len(claims),
            "sources": len(sources),
            "quotes_verified": quotes_verified,
            "quotes_failed": quotes_failed,
            "elapsed_s": round(elapsed, 4),
        },
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Verify a proof-carrying research brief")
    parser.add_argument("brief", help="Path to brief.pcrb.json")
    parser.add_argument("--json", action="store_true", help="Print JSON report")
    parser.add_argument("--key-file", default=None)
    args = parser.parse_args(argv)

    path = Path(os.path.realpath(str(args.brief)))
    if not path.is_file():
        print(f"error: no such brief: {path}", file=sys.stderr)
        return 2
    try:
        bundle = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: unreadable brief: {exc}", file=sys.stderr)
        return 2

    key = None
    if args.key_file:
        key_file_path = Path(os.path.realpath(str(args.key_file)))
        # Fail loudly rather than fall through to an unsigned verification:
        # a typo'd --key-file would otherwise silently verify with no key.
        if not key_file_path.is_file():
            print(f"error: key file is not a readable file: {args.key_file}", file=sys.stderr)
            return 2
        key = key_file_path.read_bytes().strip()
    elif os.environ.get(ENV_KEY):
        key = os.environ[ENV_KEY].encode("utf-8")

    report = verify_brief(bundle, key=key)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        status = "PASS" if report["ok"] else "FAIL"
        print(f"[{status}] {path}")
        for name, st in report["checks"].items():
            print(f"  {name}: {st}")
        for f in report["failures"]:
            print(f"  ✗ [{f['check']}] {f['member']}: {f['message']}")
        s = report["stats"]
        print(f"  quotes verified: {s['quotes_verified']}/{s['claims']} in {s['elapsed_s']}s")

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
