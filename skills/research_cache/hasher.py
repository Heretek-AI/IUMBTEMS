#!/usr/bin/env python3
"""
Content-Addressed Research Cache & Verbatim Quote Verification Engine.
Handles SHA-256 document hashing, metadata indexing, and substring auditing.
"""

import os
import sys
import json
import hashlib
import re
import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

DEFAULT_RESEARCH_DIR = ".research"
BASE_DIR_HELP = "Base .research directory"


def _log_retrieval(base_dir, kind: str, **fields) -> None:
    """Best-effort retrieval telemetry (see runner/retrieval_log.py)."""
    try:
        root = Path(__file__).resolve().parents[2]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        from runner.retrieval_log import log_event

        log_event(base_dir, kind, **fields)
    except Exception:
        pass


class SourceHasher:
    def __init__(self, base_dir: Optional[Path] = None):
        target = base_dir or Path(DEFAULT_RESEARCH_DIR)
        self.base_dir = Path(os.path.realpath(str(target)))
        self.sources_dir = Path(os.path.realpath(str(self.base_dir / "sources")))
        self.sources_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def compute_sha256(content: str) -> str:
        """Compute standard hex SHA-256 hash of normalized UTF-8 string."""
        normalized = content.strip().encode("utf-8")
        return hashlib.sha256(normalized).hexdigest()

    def store_source(
        self,
        url: str,
        content: str,
        title: Optional[str] = None,
        tier: str = "WEB_DOCUMENT",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Store content and metadata content-addressed by SHA-256."""
        content_hash = self.compute_sha256(content)
        md_path = self.sources_dir / f"{content_hash}.md"
        json_path = self.sources_dir / f"{content_hash}.json"

        # Write clean markdown
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)

        # Write metadata
        meta = {
            "hash": content_hash,
            "url": url,
            "title": title or "Untitled Source",
            "tier": tier,
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "byte_size": len(content.encode("utf-8")),
            "char_count": len(content),
            "custom_metadata": metadata or {},
        }
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

        return content_hash

    def get_source_content(self, content_hash: str) -> Optional[str]:
        """Retrieve stored markdown content by full or prefix hash."""
        target_file = self._resolve_hash_file(content_hash, ".md")
        if target_file and target_file.exists():
            with open(target_file, "r", encoding="utf-8") as f:
                return f.read()
        return None

    def get_source_metadata(self, content_hash: str) -> Optional[Dict[str, Any]]:
        """Retrieve stored metadata by full or prefix hash."""
        target_file = self._resolve_hash_file(content_hash, ".json")
        if target_file and target_file.exists():
            with open(target_file, "r", encoding="utf-8") as f:
                return json.load(f)
        return None

    def _resolve_hash_file(self, hash_prefix: str, extension: str) -> Optional[Path]:
        """Resolves exact or prefix hash to disk path.

        ``hash_prefix`` is untrusted (it arrives from an LLM tool call), so the
        result is required to stay inside ``sources_dir``. Containment is checked
        inline rather than via ``runner.path_safety`` because this module is
        mirrored into the standalone ``research-cache`` plugin, which has no
        ``runner`` package on its path.
        """
        if not re.match(r"^[a-fA-F0-9]+$", hash_prefix):
            return None
        exact_path = Path(
            os.path.realpath(str(self.sources_dir / f"{hash_prefix}{extension}"))
        )
        if exact_path.parent != self.sources_dir:
            return None
        if exact_path.exists():
            return exact_path

        # If prefix match
        matches = list(self.sources_dir.glob(f"{hash_prefix}*{extension}"))
        if len(matches) == 1:
            candidate = Path(os.path.realpath(str(matches[0])))
            if candidate.parent == self.sources_dir:
                return candidate
        return None

    @staticmethod
    def normalize_text_for_search(text: str) -> str:
        """Collapse whitespace and normalize typography for substring matching."""
        # Replace smart quotes and dashes
        text = (
            text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
        )
        text = text.replace("—", "-").replace("–", "-")
        # Collapse all whitespace to single spaces
        return re.sub(r"\s+", " ", text).strip().lower()

    def verify_quote(
        self, content_hash: str, quote: str
    ) -> Tuple[bool, float, Optional[str]]:
        """
        Verifies whether quote exists in cached document.
        Returns: (is_verified, confidence_score, context_match)
        """
        source_text = self.get_source_content(content_hash)
        if not source_text:
            return False, 0.0, f"Source hash '{content_hash}' not found in cache."

        # 1. Exact match test
        if quote.strip() in source_text:
            return True, 1.0, "Exact substring match found."

        # 2. Normalized whitespace match test
        norm_source = self.normalize_text_for_search(source_text)
        norm_quote = self.normalize_text_for_search(quote)
        if norm_quote in norm_source:
            return True, 0.98, "Normalized whitespace match found."

        # 3. Sliding window token overlap test
        quote_words = norm_quote.split()
        if len(quote_words) < 4:
            return False, 0.0, "Quote too short and not found verbatim."

        window_size = len(quote_words)
        source_words = norm_source.split()
        best_score = 0.0

        for i in range(max(1, len(source_words) - window_size + 1)):
            window = source_words[i : i + window_size]
            matches = sum(1 for w1, w2 in zip(quote_words, window) if w1 == w2)
            score = matches / window_size
            if score > best_score:
                best_score = score
                if best_score >= 0.90:
                    break

        if best_score >= 0.88:
            return True, best_score, f"High-confidence fuzzy match ({best_score:.2f})."

        return (
            False,
            best_score,
            f"Verification failed. Highest word overlap: {best_score:.2f}.",
        )


def main():
    parser = argparse.ArgumentParser(
        description="Epistemic Swarm Content Hasher & Quote Verifier"
    )
    subparsers = parser.add_subparsers(dest="command")

    # Cache command
    cache_parser = subparsers.add_parser("cache", help="Cache a document")
    cache_parser.add_argument("--url", required=True, help="Original URL")
    cache_parser.add_argument("--title", default="Untitled", help="Document Title")
    cache_parser.add_argument("--tier", default="WEB_DOCUMENT", help="Source tier")
    cache_parser.add_argument("--content", help="Raw text content (or read from stdin)")
    cache_parser.add_argument("--dir", default=DEFAULT_RESEARCH_DIR, help=BASE_DIR_HELP)

    # Verify command
    verify_parser = subparsers.add_parser("verify", help="Verify a verbatim quote")
    verify_parser.add_argument("--hash", required=True, help="Document SHA-256 hash")
    verify_parser.add_argument("--quote", required=True, help="Verbatim quote to check")
    verify_parser.add_argument(
        "--dir", default=DEFAULT_RESEARCH_DIR, help=BASE_DIR_HELP
    )

    # List command
    list_parser = subparsers.add_parser("list", help="List cached sources")
    list_parser.add_argument("--dir", default=DEFAULT_RESEARCH_DIR, help=BASE_DIR_HELP)

    args = parser.parse_args()
    dir_val = getattr(args, "dir", DEFAULT_RESEARCH_DIR) or DEFAULT_RESEARCH_DIR
    hasher = SourceHasher(base_dir=Path(os.path.realpath(str(dir_val))))

    if args.command == "cache":
        content = args.content
        if not content:
            if not sys.stdin.isatty():
                content = sys.stdin.read()
            else:
                print(
                    "Error: No content provided via --content or stdin.",
                    file=sys.stderr,
                )
                sys.exit(1)
        h = hasher.store_source(
            url=args.url, content=content, title=args.title, tier=args.tier
        )
        print(f"[CACHED] {h} -> {args.title} ({args.url})")
        _log_retrieval(hasher.base_dir, "cache", url=args.url, hash=h, tool="hasher")

    elif args.command == "verify":
        verified, conf, msg = hasher.verify_quote(
            content_hash=args.hash, quote=args.quote
        )
        result = {
            "hash": args.hash,
            "verified": verified,
            "confidence": conf,
            "message": msg,
        }
        print(json.dumps(result, indent=2))
        sys.exit(0 if verified else 1)

    elif args.command == "list":
        sources = list(hasher.sources_dir.glob("*.json"))
        print(f"Total Cached Sources: {len(sources)}")
        for p in sources:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
                print(f"- [{d['hash'][:10]}...] {d['title']} ({d['url']})")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
