#!/usr/bin/env python3
"""Bet-1 advisory spike: proof-carrying review on a synthetic PR fixture set.

Advisory mode ONLY: findings are formatted as PR comments, never block, and
the process always exits 0. Measures: seeded-defect hit rate (finding cites
seeded file + line within +/-3) and clean-fixture false-positive rate.

  python3 scripts/bet1_advisory_spike.py --generate --dir /tmp/bet1
  python3 scripts/bet1_advisory_spike.py --run --mock --dir /tmp/bet1
  python3 scripts/bet1_advisory_spike.py --run --live --only bet1-01,bet1-02 --dir /tmp/bet1
  python3 scripts/bet1_advisory_spike.py --score --dir /tmp/bet1

Live runs invoke real audits (LLM spend); mock runs exercise dispatch only.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LINE_TOLERANCE = 3

# name -> (filename, lines, seeded_line_1based, description)
FIXTURES = {
    "hardcoded-secret-1": (
        "auth.py",
        [
            'API_KEY = "sk-live-51H7x9Q2mZ4v8K3n"  # production key',
            "",
            "def headers():",
            '    return {"Authorization": f"Bearer {API_KEY}"}',
        ],
        1,
        "hardcoded production secret",
    ),
    "hardcoded-secret-2": (
        "config.py",
        [
            "import os",
            "",
            'DB_PASSWORD = "P@ssw0rd-2024-prod"',
            "",
            "def dsn():",
            '    return f"postgres://admin:{DB_PASSWORD}@db:5432/app"',
        ],
        3,
        "hardcoded database password",
    ),
    "sqli-concat-1": (
        "users.py",
        [
            "import sqlite3",
            "",
            "def get_user(db, username):",
            "    conn = sqlite3.connect(db)",
            "    cur = conn.cursor()",
            '    query = "SELECT * FROM users WHERE name = \'" + username + "\'"',
            "    cur.execute(query)",
            "    return cur.fetchall()",
        ],
        6,
        "SQL string concatenation with user input",
    ),
    "sqli-concat-2": (
        "orders.py",
        [
            "import sqlite3",
            "",
            "def get_orders(db, status, limit):",
            "    conn = sqlite3.connect(db)",
            "    sql = f\"SELECT * FROM orders WHERE status='{status}' LIMIT {limit}\"",
            "    return conn.execute(sql).fetchall()",
        ],
        5,
        "f-string SQL with user input",
    ),
    "race-counter-1": (
        "counter.py",
        [
            "import threading",
            "",
            "total = 0",
            "",
            "def add(n):",
            "    global total",
            "    total += n",
            "",
            "threads = [threading.Thread(target=add, args=(i,)) for i in range(100)]",
            "[t.start() for t in threads]",
        ],
        7,
        "unsynchronized shared counter across threads",
    ),
    "race-counter-2": (
        "cache.py",
        [
            "import threading",
            "",
            "_cache = {}",
            "",
            "def get_or_load(key, loader):",
            "    if key not in _cache:",
            "        _cache[key] = loader()",
            "    return _cache[key]",
        ],
        7,
        "check-then-act race on shared dict",
    ),
    "auth-bypass-1": (
        "login.py",
        [
            "def is_admin(user):",
            "    return True",
            "",
            "def delete_account(user, target):",
            "    if is_admin(user):",
            "        return db.delete(target)",
            "    raise PermissionError()",
        ],
        2,
        "authorization check always returns True",
    ),
    "auth-bypass-2": (
        "views.py",
        [
            "def admin_panel(request):",
            '    if request.args.get("debug") == "1":',
            "        return render_admin()",
            "    if not request.user or not request.user.is_staff:",
            "        abort(403)",
            "    return render_admin()",
        ],
        2,
        "debug query param bypasses staff check",
    ),
    "off-by-one-1": (
        "paging.py",
        [
            "def page(items, n, size):",
            "    start = n * size",
            "    return items[start:start + size + 1]",
        ],
        3,
        "page slice returns size+1 items",
    ),
    "off-by-one-2": (
        "retry.py",
        [
            "def fetch_with_retry(url, tries=3):",
            "    for i in range(tries + 1):",
            "        try:",
            "            return http_get(url)",
            "        except NetError:",
            "            continue",
            "    raise GiveUp()",
        ],
        2,
        "loop runs tries+1 attempts, not tries",
    ),
    "exec-input-1": (
        "render.py",
        [
            "def render(template_name, context):",
            '    expr = "f\'" + open(template_name).read() + "\'"',
            "    return eval(expr, {}, context)",
        ],
        3,
        "eval on template file content with context",
    ),
    "exec-input-2": (
        "calc.py",
        [
            "def calculate(formula, variables):",
            '    return eval(formula, {"__builtins__": {}}, variables)',
        ],
        2,
        "eval on user-supplied formula string",
    ),
    "weak-crypto-1": (
        "passwords.py",
        [
            "import hashlib",
            "",
            "def store_pw(username, password):",
            "    digest = hashlib.md5(password.encode()).hexdigest()",
            "    db.save(username, digest)",
        ],
        4,
        "MD5 for password hashing, no salt",
    ),
    "weak-crypto-2": (
        "tokens.py",
        [
            "import random",
            "",
            "def new_token():",
            '    return "%016x" % random.getrandbits(64)',
        ],
        4,
        "Mersenne Twister for security tokens",
    ),
    "path-traversal-1": (
        "files.py",
        [
            "import os",
            "",
            'BASE = "/srv/uploads"',
            "",
            "def read_upload(name):",
            "    with open(os.path.join(BASE, name)) as f:",
            "        return f.read()",
        ],
        6,
        "unsanitized join allows ../ escape",
    ),
    "path-traversal-2": (
        "export.py",
        [
            "import os",
            "import shutil",
            "",
            "def export_report(name, dest_dir):",
            '    src = os.path.join("/srv/reports", name)',
            "    return shutil.copy(src, dest_dir)",
        ],
        5,
        "unsanitized report name allows ../ escape",
    ),
}

CLEAN_FIXTURES = {
    "clean-1": (
        "util.py",
        [
            "def clamp(value, lo, hi):",
            "    return max(lo, min(hi, value))",
        ],
        "no defect: pure bounds clamp",
    ),
    "clean-2": (
        "queries.py",
        [
            "import sqlite3",
            "",
            "def get_user(db, username):",
            "    conn = sqlite3.connect(db)",
            "    return conn.execute(",
            '        "SELECT * FROM users WHERE name = ?", (username,)',
            "    ).fetchall()",
        ],
        "no defect: parameterized query",
    ),
    "clean-3": (
        "authn.py",
        [
            "import hashlib",
            "import hmac",
            "import secrets",
            "",
            "def check(password, stored):",
            '    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), stored["salt"], 600_000)',
            '    return hmac.compare_digest(digest, stored["digest"])',
        ],
        "no defect: salted KDF with constant-time compare",
    ),
    "clean-4": (
        "counter_safe.py",
        [
            "import threading",
            "",
            "_lock = threading.Lock()",
            "total = 0",
            "",
            "def add(n):",
            "    global total",
            "    with _lock:",
            "        total += n",
        ],
        "no defect: locked counter",
    ),
}


def generate(root):
    root = Path(root)
    manifest = []
    for fid, (fname, lines, line, desc) in FIXTURES.items():
        d = root / fid
        d.mkdir(parents=True, exist_ok=True)
        d.joinpath(fname).write_text("\n".join(lines) + "\n", encoding="utf-8")
        manifest.append(
            {
                "id": fid,
                "file": fname,
                "line": line,
                "class": fid.rsplit("-", 1)[0],
                "defect": desc,
                "clean": False,
            }
        )
    for fid, (fname, lines, desc) in CLEAN_FIXTURES.items():
        d = root / fid
        d.mkdir(parents=True, exist_ok=True)
        d.joinpath(fname).write_text("\n".join(lines) + "\n", encoding="utf-8")
        manifest.append(
            {
                "id": fid,
                "file": fname,
                "line": None,
                "class": "clean",
                "defect": desc,
                "clean": True,
            }
        )
    root.joinpath("manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"generated {len(manifest)} fixtures in {root}")
    return manifest


def run_audit(target_dir, mock, timeout=600):
    """Invoke the real dispatch path. Advisory: findings only, never blocks."""
    args = {"target": str(target_dir)}
    if mock:
        args["mock_mode"] = True
    proc = subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "runner" / "mcp_server.py"),
            "call",
            "iumbtems_code_audit",
            json.dumps(args),
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(PROJECT_ROOT),
    )
    return proc.stdout + proc.stderr


def advisory_comment(fixture_id, findings):
    return (
        f"### IUMBTEMS advisory review: `{fixture_id}`\n\n"
        f"Automated findings below are **non-blocking**. Verify each cited line before acting.\n\n"
        f"{findings}\n"
    )


LINE_RE = re.compile(r"(?:^|[\s(:\[\"'])(?:line\s+)?L?(\d{1,4})\b", re.IGNORECASE)


def score_fixture(entry, findings):
    """Hit = seeded filename cited with a line number within tolerance."""
    if entry["clean"]:
        cited_own_file = entry["file"] in findings
        return {"hit": False, "false_positive": cited_own_file}
    if entry["file"] not in findings:
        return {"hit": False, "false_positive": False}
    lines = {int(n) for n in LINE_RE.findall(findings)}
    hit = any(abs(n - entry["line"]) <= LINE_TOLERANCE for n in lines)
    return {"hit": hit, "false_positive": False}


def score_all(root):
    manifest = json.loads((Path(root) / "manifest.json").read_text(encoding="utf-8"))
    results = []
    for entry in manifest:
        comment_file = Path(root) / entry["id"] / "advisory.md"
        findings = (
            comment_file.read_text(encoding="utf-8") if comment_file.exists() else ""
        )
        results.append({"id": entry["id"], **score_fixture(entry, findings)})
    defective = [r for r, e in zip(results, manifest) if not e["clean"]]
    clean = [r for r, e in zip(results, manifest) if e["clean"]]
    hits = sum(1 for r in defective if r["hit"])
    fps = sum(1 for r in clean if r["false_positive"])
    return {
        "fixtures": len(manifest),
        "defective": len(defective),
        "hits": hits,
        "hit_rate": round(hits / max(len(defective), 1), 3),
        "false_positives": fps,
        "clean_total": len(clean),
        "misses": [r["id"] for r in defective if not r["hit"]],
        "results": results,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="/tmp/bet1")
    ap.add_argument("--generate", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--score", action="store_true")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args(argv)
    root = Path(args.dir)

    if args.generate or (not args.run and not args.score):
        generate(root)
    if args.run:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        only = {s.strip() for s in args.only.split(",") if s.strip()}
        for entry in manifest:
            if only and entry["id"] not in only:
                continue
            findings = run_audit(root / entry["id"], mock=args.mock and not args.live)
            (root / entry["id"] / "advisory.md").write_text(
                advisory_comment(entry["id"], findings), encoding="utf-8"
            )
            print(f"advisory written: {entry['id']}")
    if args.score:
        summary = score_all(root)
        print(json.dumps(summary, indent=2))
    return 0  # advisory: never blocks


if __name__ == "__main__":
    sys.exit(main())
