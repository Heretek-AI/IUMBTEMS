#!/usr/bin/env python3
"""
Derived claim index over the .research/ flat-file record.

INVIOLABLE: .research/**/*.json|md stays the source of truth. This sqlite
DB is a rebuildable index for cross-session dedup, degradation queries, and
provenance joins. If it ever drifts: delete it and `--reindex`. Never
"fix the DB" in place.

Tables:
  claims        one row per ClaimWitness
  sources       one row per content hash (from .research/sources/<hash>.json)
  claim_sources join (claim_id -> source_hash)
  status_events append-only degradation log (Stream C mirrors into here)

Zero external deps: stdlib sqlite3. FTS5 over `statement` when compiled in,
else a LIKE scan. An `embedding BLOB` column is reserved for the vector half
of the dual-layer design; embeddings are deliberately NOT built here (they
need an API call and are out of this phase's scope).
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from runner.claim_witness import ClaimWitness, claims_from_dossier  # noqa: E402

SCHEMA_VERSION = 1

DOSIER_NAMES = ("alpha_dossier.json", "beta_dossier.json")


def _has_fts5(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)")
        conn.execute("DROP TABLE _fts5_probe")
        return True
    except sqlite3.OperationalError:
        return False


class ClaimStore:
    def __init__(self, base_dir: Path, db_path: Optional[Path] = None):
        self.base_dir = Path(os.path.realpath(str(base_dir)))
        self.db_path = Path(os.path.realpath(str(db_path))) if db_path else (self.base_dir / "claims.sqlite")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.fts5 = _has_fts5(self.conn)
        self._create_schema()

    def _create_schema(self) -> None:
        cur = self.conn.cursor()
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sources (
                source_hash TEXT PRIMARY KEY,
                url TEXT,
                title TEXT,
                tier TEXT,
                byte_size INTEGER,
                char_count INTEGER
            );
            CREATE TABLE IF NOT EXISTS claims (
                claim_id TEXT NOT NULL,
                scope_id TEXT,
                dossier TEXT,
                kind TEXT,
                tag TEXT,
                statement TEXT,
                source_hash TEXT,
                source_url TEXT,
                verbatim_quote TEXT,
                parent_claims TEXT,
                deductive_logic TEXT,
                falsification TEXT,
                query TEXT,
                finding TEXT,
                severity TEXT,
                tier TEXT,
                confidence REAL,
                status TEXT,
                embedding BLOB,
                PRIMARY KEY (scope_id, dossier, claim_id)
            );
            CREATE TABLE IF NOT EXISTS claim_sources (
                scope_id TEXT,
                dossier TEXT,
                claim_id TEXT,
                source_hash TEXT,
                PRIMARY KEY (scope_id, dossier, claim_id, source_hash)
            );
            CREATE TABLE IF NOT EXISTS status_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id TEXT,
                claim_id TEXT,
                from_status TEXT,
                to_status TEXT,
                reason TEXT,
                at TEXT
            );
            """
        )
        cur.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
        if self.fts5:
            cur.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts
                USING fts5(claim_id, statement, content='claims', content_rowid='rowid')
                """
            )
        self.conn.commit()

    # ---- indexing -------------------------------------------------------

    def index_dossier(
        self, scope_id: str, dossier_name: str, dossier: Dict[str, Any]
    ) -> int:
        """Index one dossier dict. Idempotent: re-indexing replaces rows."""
        claims = claims_from_dossier(dossier)
        cur = self.conn.cursor()
        cur.execute(
            "DELETE FROM claims WHERE scope_id = ? AND dossier = ?",
            (scope_id, dossier_name),
        )
        cur.execute(
            "DELETE FROM claim_sources WHERE scope_id = ? AND dossier = ?",
            (scope_id, dossier_name),
        )
        for c in claims:
            self._upsert_claim(cur, scope_id, dossier_name, c)
        self.conn.commit()
        self._sync_fts()
        return len(claims)

    def _upsert_claim(
        self, cur: sqlite3.Cursor, scope_id: str, dossier: str, c: ClaimWitness
    ) -> None:
        cur.execute(
            """
            INSERT OR REPLACE INTO claims (
                claim_id, scope_id, dossier, kind, tag, statement,
                source_hash, source_url, verbatim_quote, parent_claims,
                deductive_logic, falsification, query, finding,
                severity, tier, confidence, status
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                c.claim_id,
                scope_id,
                dossier,
                c.kind,
                c.tag,
                c.statement,
                c.source_hash,
                c.source_url,
                c.verbatim_quote,
                json.dumps(c.parent_claims),
                c.deductive_logic,
                c.falsification,
                c.query,
                c.finding,
                c.severity,
                c.tier,
                c.confidence,
                c.status,
            ),
        )
        if c.source_hash:
            cur.execute(
                """
                INSERT OR IGNORE INTO claim_sources (scope_id, dossier, claim_id, source_hash)
                VALUES (?,?,?,?)
                """,
                (scope_id, dossier, c.claim_id, c.source_hash),
            )

    def _sync_fts(self) -> None:
        """Rebuild the FTS index from `claims` (content= external table).

        Must run after any write batch: the external-content FTS5 table does
        not auto-populate on INSERT into the content table.
        """
        if not self.fts5:
            return
        self.conn.execute("INSERT INTO claims_fts(claims_fts) VALUES('rebuild')")
        self.conn.commit()

    def index_source_meta(self, source_hash: str, meta: Dict[str, Any]) -> None:
        self.conn.execute(
            """
            INSERT OR REPLACE INTO sources (source_hash, url, title, tier, byte_size, char_count)
            VALUES (?,?,?,?,?,?)
            """,
            (
                source_hash,
                meta.get("url"),
                meta.get("title"),
                meta.get("tier"),
                meta.get("byte_size"),
                meta.get("char_count"),
            ),
        )
        self.conn.commit()

    def record_status_event(
        self,
        scope_id: str,
        claim_id: str,
        from_status: str,
        to_status: str,
        reason: str,
        at: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO status_events (scope_id, claim_id, from_status, to_status, reason, at)
            VALUES (?,?,?,?,?,?)
            """,
            (scope_id, claim_id, from_status, to_status, reason, at),
        )
        self.conn.commit()

    # ---- queries --------------------------------------------------------

    def search_statements(self, text: str, limit: int = 50) -> List[Dict[str, Any]]:
        if self.fts5:
            rows = self.conn.execute(
                """
                SELECT c.* FROM claims c
                JOIN claims_fts f ON f.rowid = c.rowid
                WHERE claims_fts MATCH ? LIMIT ?
                """,
                (text, limit),
            ).fetchall()
            if rows:
                return [dict(r) for r in rows]
        rows = self.conn.execute(
            "SELECT * FROM claims WHERE statement LIKE ? LIMIT ?",
            (f"%{text}%", limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def claims_citing(self, source_hash: str) -> List[Dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM claims WHERE source_hash = ?", (source_hash,)
        ).fetchall()
        return [dict(r) for r in rows]

    def content_fingerprint(self) -> str:
        """Deterministic hash of the claims+sources payload (idempotency probe)."""
        rows = self.conn.execute(
            """
            SELECT claim_id, scope_id, dossier, kind, tag, statement, source_hash, status
            FROM claims ORDER BY scope_id, dossier, claim_id
            """
        ).fetchall()
        payload = "|".join(
            f"{r['scope_id']}:{r['dossier']}:{r['claim_id']}:{r['tag']}:{r['status']}"
            for r in rows
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def close(self) -> None:
        self.conn.close()


# ---- reindex (lossless from flat files) ---------------------------------


def reindex(base_dir: Path, store: Optional[ClaimStore] = None) -> Dict[str, Any]:
    """Rebuild the index entirely from .research/**/alpha|beta_dossier.json
    plus .research/sources/*.json. Idempotent and lossless by contract.
    """
    base_dir = Path(base_dir)
    own_store = store is None
    if store is None:
        store = ClaimStore(base_dir)

    dossier_files = sorted(base_dir.glob("scratchpads/*/alpha_dossier.json")) + sorted(
        base_dir.glob("scratchpads/*/beta_dossier.json")
    )
    # Also accept flat scratchpad layouts used by tests
    if not dossier_files:
        dossier_files = sorted(base_dir.glob("**/alpha_dossier.json")) + sorted(
            base_dir.glob("**/beta_dossier.json")
        )

    n_claims = 0
    for path in dossier_files:
        scope_id = path.parent.name
        try:
            with open(path, "r", encoding="utf-8") as f:
                dossier = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        n_claims += store.index_dossier(scope_id, path.name, dossier)

    n_sources = 0
    for meta_path in sorted((base_dir / "sources").glob("*.json")):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        source_hash = meta.get("hash") or meta_path.stem
        store.index_source_meta(source_hash, meta)
        n_sources += 1

    if own_store:
        fingerprint = store.content_fingerprint()
        store.close()
    else:
        fingerprint = store.content_fingerprint()

    return {
        "dossiers_indexed": len(dossier_files),
        "claims_indexed": n_claims,
        "sources_indexed": n_sources,
        "fingerprint": fingerprint,
        "db_path": str(store.db_path),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="IUMBTEMS derived claim index")
    parser.add_argument("--dir", default=".research", help="Path to .research workspace")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("reindex", help="Rebuild claims.sqlite from flat files")
    search_p = sub.add_parser("search", help="Search claim statements")
    search_p.add_argument("text")
    args = parser.parse_args(argv)

    base = Path(os.path.realpath(str(args.dir)))
    if args.command == "reindex" or args.command is None:
        print(json.dumps(reindex(base), indent=2))
        return 0
    if args.command == "search":
        store = ClaimStore(base)
        rows = store.search_statements(args.text)
        store.close()
        print(json.dumps(rows, indent=2, default=str))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
