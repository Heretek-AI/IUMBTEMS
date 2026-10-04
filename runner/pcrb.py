#!/usr/bin/env python3
"""
Proof-Carrying Research Brief (PCRB) — export side (Stream D).

A PCRB is a self-contained signed bundle: the synthesis, every claim with its
quote witness, the full text of every cited source, an integrity manifest, and
an optional HMAC signature. A third party can re-verify everything WITHOUT
trusting the LLM that produced it and WITHOUT access to the original
.research/ workspace — verification runs against the bundled sources.

Bundle shape (brief.pcrb.json):
{
  "pcrb_version": "1.0",
  "objective": ..., "exported_at": ...,
  "synthesis_markdown": ...,
  "claims": [ {claim fields..., "witness": {quote, source_hash, confidence, verified_at}} ],
  "sources": { "<hash>": {"url","title","tier","content"} },
  "manifest": { "synthesis_markdown": sha, "claims": {id: sha}, "sources": {hash: sha} },
  "signature": {"alg": "hmac-sha256" | "none", "key_id": ..., "sig": ...}
}

Member hashes use SourceHasher.compute_sha256 semantics so a bundled source's
member hash equals its cache hash.

Signing: stdlib hmac when a key is provided (env IUMBTEMS_PCRB_KEY or key
file). alg="none" provides integrity (member-vs-manifest) but NOT authenticity
— a coordinated rewrite of content + manifest is undetectable without a key.
Real PKI (ed25519) is a gated follow-on; HMAC is sufficient for the tamper
probe, not for the regulatory story.
"""

import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import claims_from_dossier, load_dossier  # noqa: E402

PCRB_VERSION = "1.0"
ENV_KEY = "IUMBTEMS_PCRB_KEY"


def canonical_json(obj: Any) -> str:
    """Deterministic serialization for hashing/signing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    """SourceHasher.compute_sha256 semantics (strip + utf-8)."""
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def member_hash(obj: Any) -> str:
    """Hash a structured member via canonical JSON."""
    return sha256_text(canonical_json(obj))


def _resolve_key(key: Optional[str], key_path: Optional[Path]) -> Optional[bytes]:
    if key:
        return key.encode("utf-8")
    env = os.environ.get(ENV_KEY)
    if env:
        return env.encode("utf-8")
    if key_path:
        # An explicitly supplied key file that cannot be read must fail loudly.
        # Returning None here would sign the brief with `alg: "none"` and report
        # success — a typo'd path silently produces an unauthenticated bundle.
        canonical_key_path = Path(os.path.realpath(str(key_path)))
        if not canonical_key_path.is_file():
            raise ValueError(
                f"key file is not a readable file: {key_path!r} (resolved {canonical_key_path})"
            )
        return canonical_key_path.read_bytes().strip()
    return None


def sign_manifest(
    manifest: Dict[str, Any], key: Optional[bytes], key_id: str = "local"
) -> Dict[str, Any]:
    if not key:
        return {"alg": "none", "key_id": None, "sig": None}
    sig = hmac.new(
        key, canonical_json(manifest).encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {"alg": "hmac-sha256", "key_id": key_id, "sig": sig}


def _resolve_synthesis(base_dir: Path) -> str:
    final_md = base_dir / "final_synthesis.md"
    if final_md.exists():
        return final_md.read_text(encoding="utf-8")
    parts = sorted((base_dir / "scratchpads").glob("*/scope_synthesis.md"))
    return "\n\n---\n\n".join(p.read_text(encoding="utf-8") for p in parts)


def _witness_for(c, hasher: Any, needed_hashes: set) -> Dict[str, Any]:
    """Build one claim's witness record and track hashes worth bundling.

    R8 (01-nk-hardening tiebreak-2 F1): source_hash/verbatim_quote are
    untrusted-adjacent (hand-built witnesses may carry int/dict/list) —
    isinstance-guard both before hasher/set. Non-string sides degrade to
    reject (confidence None, no bundling), never TypeError via
    `re.match` (hasher) or `set.add` (unhashable dict).
    """
    _sh = getattr(c, "source_hash", None)
    _q = getattr(c, "verbatim_quote", None)
    witness: Dict[str, Any] = {
        "quote": _q,
        "source_hash": _sh,
        "confidence": None,
        "verified_at": None,
    }
    if not isinstance(_sh, str) or not _sh:
        return witness
    if not isinstance(_q, str) or not _q:
        try:
            needed_hashes.add(_sh)
        except TypeError:
            pass
        return witness
    try:
        passed, conf, _msg = hasher.verify_quote(_sh, _q)
    except (TypeError, AttributeError):
        return witness
    try:
        witness["confidence"] = float(conf)
    except (TypeError, ValueError):
        witness["confidence"] = None
    witness["verified_at"] = datetime.now(timezone.utc).isoformat()
    if passed:
        try:
            needed_hashes.add(_sh)
        except TypeError:
            pass
    # Legacy: a present-but-unverified quote bundles nothing (verifier
    # re-checks independently); a missing quote bundles the hash for audit.
    return witness


def _iter_dossier_claims(scope_dirs: List[Path]):
    """Yield claim witnesses from every alpha/beta dossier under scopes."""
    for scope_dir in scope_dirs:
        for dossier_name in ("alpha_dossier.json", "beta_dossier.json"):
            dpath = scope_dir / dossier_name
            if not dpath.exists():
                continue
            for c in claims_from_dossier(load_dossier(dpath)):
                yield c


def _collect_claims(
    scope_dirs: List[Path], hasher: Any
) -> Tuple[List[Dict[str, Any]], set]:
    claim_records: List[Dict[str, Any]] = []
    needed_hashes: set = set()
    for c in _iter_dossier_claims(scope_dirs):
        rec = c.to_dict()
        rec["witness"] = _witness_for(c, hasher, needed_hashes)
        claim_records.append(rec)
    return claim_records, needed_hashes


def _resolve_objective(base_dir: Path, objective: Optional[str]) -> Optional[str]:
    if objective:
        return objective
    from runner.state_machine import find_any_manifest

    manifest_p = find_any_manifest(base_dir)
    if manifest_p is not None and manifest_p.exists():
        try:
            return json.loads(manifest_p.read_text(encoding="utf-8")).get("objective")
        except (OSError, json.JSONDecodeError):
            return None
    return None


def export_brief(
    base_dir: Path,
    out_path: Optional[Path] = None,
    scope_ids: Optional[List[str]] = None,
    objective: Optional[str] = None,
    key: Optional[str] = None,
    key_path: Optional[Path] = None,
    key_id: str = "local",
) -> Path:
    """Assemble a PCRB from a .research workspace. Returns the bundle path."""
    from skills.research_cache.hasher import SourceHasher

    base_dir = Path(os.path.realpath(str(base_dir)))
    hasher = SourceHasher(base_dir)
    synthesis = _resolve_synthesis(base_dir)

    scratch = base_dir / "scratchpads"
    if scope_ids:
        scope_dirs = [scratch / s for s in scope_ids]
    elif scratch.exists():
        scope_dirs = sorted(p for p in scratch.iterdir() if p.is_dir())
    else:
        scope_dirs = []

    claim_records, needed_hashes = _collect_claims(scope_dirs, hasher)

    # --- bundled sources (self-contained: full text in the bundle) ---
    sources: Dict[str, Dict[str, Any]] = {}
    for src_hash in sorted(needed_hashes):
        content = hasher.get_source_content(src_hash)
        meta = hasher.get_source_metadata(src_hash) or {}
        if content is None:
            continue
        sources[src_hash] = {
            "url": meta.get("url"),
            "title": meta.get("title"),
            "tier": meta.get("tier"),
            "content": content,
        }

    # --- manifest (integrity) ---
    manifest: Dict[str, Any] = {
        "synthesis_markdown": sha256_text(synthesis),
        "claims": {rec["claim_id"]: member_hash(rec) for rec in claim_records},
        "sources": {h: sha256_text(s["content"]) for h, s in sources.items()},
    }

    resolved_key = _resolve_key(key, key_path)
    signature = sign_manifest(manifest, resolved_key, key_id=key_id)

    bundle = {
        "pcrb_version": PCRB_VERSION,
        "objective": _resolve_objective(base_dir, objective),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "synthesis_markdown": synthesis,
        "claims": claim_records,
        "sources": sources,
        "manifest": manifest,
        "signature": signature,
    }

    out = (
        Path(os.path.realpath(str(out_path)))
        if out_path
        else (base_dir / "brief.pcrb.json")
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Export a proof-carrying research brief"
    )
    parser.add_argument("--dir", default=".research")
    parser.add_argument("--out", default=None)
    parser.add_argument("--scope", action="append", dest="scope_ids")
    parser.add_argument("--objective", default=None)
    parser.add_argument("--key-file", default=None)
    parser.add_argument("--key-id", default="local")
    args = parser.parse_args(argv)

    canonical_dir = Path(os.path.realpath(str(args.dir)))
    canonical_out = Path(os.path.realpath(str(args.out))) if args.out else None
    canonical_key = (
        Path(os.path.realpath(str(args.key_file))) if args.key_file else None
    )
    path = export_brief(
        canonical_dir,
        out_path=canonical_out,
        scope_ids=args.scope_ids,
        objective=args.objective,
        key_path=canonical_key,
        key_id=args.key_id,
    )
    print(json.dumps({"status": "exported", "path": str(path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
