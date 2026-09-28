#!/usr/bin/env python3
"""
Zero-API-Key Web Search Engine for IUMBTEMS.
DuckDuckGo HTML/lite parser with domain filtering and Claude Code XML formatting.
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from xml.sax.saxutils import escape as xml_escape

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# ---------------------------------------------------------------------------
# DuckDuckGo anti-bot ("anomaly") detection
# ---------------------------------------------------------------------------
#
# DuckDuckGo Lite answers suspected automation with an HTTP-2xx image-selection
# CAPTCHA instead of results. The page is *not* empty, but it carries no
# ``result-link`` rows, so the parser yielded ``[]`` and callers could not tell
# a block apart from a legitimate no-hits query (they were swallowed as
# ``results: 0`` in ``.research/retrieval.jsonl``).
#
# We deliberately do NOT key off the bare word "anomaly": a normal result
# snippet may legitimately contain it — that is the false positive this phase
# guards against. Detection is anchored to page chrome that only the
# interstitial emits, captured verbatim in the recorded fixture
# ``runner/tests/fixtures/ddg_anomaly_page.html`` (14,213 bytes, HTTP 202):
#
#   * ``id="challenge-form"``                — CAPTCHA submit form
#   * ``id="img-form"``                      — challenge image form
#   * ``assets/anomaly/images/challenge/``   — challenge image asset path
#   * ``anomaly-modal``                      — challenge modal CSS class
#
# Detection additionally requires the page to be free of real ``result-link``
# anchors, so even an (implausible) results page whose snippet embeds one of the
# markers is still treated as a results page.
DDG_ANOMALY_MARKERS: Tuple[str, ...] = (
    'id="challenge-form"',
    'id="img-form"',
    "assets/anomaly/images/challenge/",
    "anomaly-modal",
)

DDG_BLOCKED_HINT = (
    "DuckDuckGo served its anti-bot challenge page (BLOCKED), not results. "
    "Back off and retry later, or fall back to another engine: set "
    "search_engine to firecrawl or searxng in .research/config.json, or "
    "export a BYO key (EXA_API_KEY / FIRECRAWL_API_KEY / PARALLEL_API_KEY / "
    "TAVILY_API_KEY / TINYFISH_API_KEY)."
)

DDG_ERROR_HINT = (
    "DuckDuckGo request failed (network/HTTP error). Retry with backoff or "
    "fall back to firecrawl or searxng."
)


class SearchBlocked(RuntimeError):
    """DuckDuckGo served its anti-bot interstitial instead of results.

    Exposed for callers that want the block to be an error rather than an empty
    list — see :func:`require_search_duckduckgo`. ``hint`` carries the
    actionable fallback/backoff advice.
    """

    def __init__(
        self, message: str = DDG_BLOCKED_HINT, hint: str = DDG_BLOCKED_HINT
    ) -> None:
        super().__init__(message)
        self.hint = hint


def _is_ddg_anomaly_page(html: str) -> bool:
    """True iff *html* is DDG's anti-bot interstitial rather than results.

    Anchored to structural page chrome (see the module comment above), never to
    the bare word "anomaly". An empty body or a page already carrying
    ``result-link`` anchors is a results page and is never flagged.
    """
    if not html:
        return False
    if "result-link" in html:
        return False
    return any(marker in html for marker in DDG_ANOMALY_MARKERS)


def _log_retrieval(kind: str, **fields) -> None:
    """Best-effort retrieval telemetry (see runner/retrieval_log.py)."""
    try:
        from pathlib import Path as _Path

        root = _Path(__file__).resolve().parents[3]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        from runner.retrieval_log import default_base_dir, log_event

        log_event(default_base_dir(), kind, **fields)
    except Exception:
        pass


def _log_ddg_query(
    status: str, effective_query: str, results: int, log: bool = True
) -> None:
    """Record a query event whose ``status`` distinguishes block from empty.

    The plain ``results`` count is kept so ``retrieval_log.summarize`` still
    works, but a block additionally carries ``status: "blocked"`` and
    ``blocked: true`` so the anomaly can no longer masquerade as a normal
    zero-hit query.

    ``log=False`` suppresses telemetry entirely. The preflight/reachability
    probe uses it so its own request is never counted as an agent search and
    never leaks an event into whichever workspace happens to be the process
    cwd (see ``runner/preflight.py:_engine_probe``).
    """
    if not log:
        return
    fields: Dict[str, Any] = {
        "query": effective_query,
        "results": results,
        "status": status,
        "provider": "duckduckgo",
    }
    if status == "blocked":
        fields["blocked"] = True
    _log_retrieval("query", **fields)


class DDGLiteParser(HTMLParser):
    """Linear, non-backtracking HTML parser for DuckDuckGo Lite search results.

    DuckDuckGo Lite emits one table row per result: an ``<a class="result-link">``
    holding the title and a ``<td class="result-snippet">`` holding the summary.
    Results are assembled **per row** so that:

    * a missing link or snippet cannot desynchronise every later result (the old
      ``zip(links, snippets)`` pairing shifted all subsequent rows), and
    * nested markup inside a snippet — including a nested
      ``<a class="result-link">`` — never hijacks capture state (the old parser
      reset its buffer mid-snippet and then never recorded the snippet at all).

    Captured text is stored decoded (``convert_charrefs`` default); escaping is
    done at emit time by :func:`format_xml`.
    """

    def __init__(self):
        super().__init__()
        self.results: List[Dict[str, str]] = []
        self._row_href: Optional[str] = None
        self._row_title: List[str] = []
        self._row_snippet: List[str] = []
        self._capture: Optional[str] = None  # "title" | "snippet" | None
        self._depth = 0  # nesting depth of the tag that opened the capture

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        attr_dict = {k: v or "" for k, v in attrs}
        classes = attr_dict.get("class", "").split()

        if tag == "tr":
            self.flush()
            return

        # While capturing a snippet, nested markup (including a nested
        # result-link) stays inside the snippet. Only track nested <td> so the
        # capture still ends at the *outer* </td>.
        if self._capture == "snippet":
            if tag == "td":
                self._depth += 1
            return

        # Likewise for a title: a nested <a> must not close the capture early.
        if self._capture == "title":
            if tag == "a":
                self._depth += 1
            return

        if tag == "a" and "result-link" in classes:
            # Row-less fallback: a new result-link implies the previous result
            # is complete even if no <tr> ever bounded it.
            if self._row_href is not None:
                self.flush()
            self._capture = "title"
            self._depth = 1
            self._row_href = attr_dict.get("href", "")
            self._row_title = []
        elif tag == "td" and "result-snippet" in classes:
            self._capture = "snippet"
            self._depth = 1
            self._row_snippet = []

    def handle_endtag(self, tag: str):
        if (self._capture == "title" and tag == "a") or (
            self._capture == "snippet" and tag == "td"
        ):
            self._depth -= 1
            if self._depth <= 0:
                self._capture = None
        elif tag == "tr":
            self.flush()

    def handle_data(self, data: str):
        if self._capture == "title":
            self._row_title.append(data)
        elif self._capture == "snippet":
            self._row_snippet.append(data)

    def flush(self):
        """Emit the in-progress row, if any. Call after ``feed()`` completes."""
        if self._row_href is not None:
            self.results.append(
                {
                    "href": self._row_href,
                    "title": "".join(self._row_title).strip(),
                    "snippet": "".join(self._row_snippet).strip(),
                }
            )
        self._row_href = None
        self._row_title = []
        self._row_snippet = []
        self._capture = None
        self._depth = 0


def _build_search_query(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
) -> str:
    effective_query = query.strip()
    if allowed_domains:
        effective_query += " " + " OR ".join(f"site:{d}" for d in allowed_domains)
    if blocked_domains:
        effective_query += " " + " ".join(f"-site:{d}" for d in blocked_domains)
    return effective_query


def _fetch_ddg_html(effective_query: str, timeout: float = 15.0) -> str:
    url = "https://lite.duckduckgo.com/lite/"
    data = urllib.parse.urlencode({"q": effective_query}).encode("utf-8")
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://lite.duckduckgo.com/",
    }
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        sys.stderr.write(
            f"[epistemic-search] Network error fetching search results: {e}\n"
        )
        return ""


def _parse_clean_url(href: str) -> str:
    m = re.search(r"uddg=([^&]+)", href)
    if m:
        return urllib.parse.unquote(m.group(1))
    return href


def _is_domain_allowed(
    hostname: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
) -> bool:
    if allowed_domains and not any(
        hostname == d or hostname.endswith("." + d) for d in allowed_domains
    ):
        return False
    if blocked_domains and any(
        hostname == d or hostname.endswith("." + d) for d in blocked_domains
    ):
        return False
    return True


def _parse_ddg_results(
    html: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10,
) -> List[Dict[str, str]]:
    parser = DDGLiteParser()
    parser.feed(html)
    parser.flush()

    results = []
    for row in parser.results:
        clean_url = _parse_clean_url(row["href"])
        if not clean_url.startswith("http"):
            continue

        parsed_url = urllib.parse.urlparse(clean_url)
        hostname = parsed_url.hostname or ""
        if not _is_domain_allowed(hostname, allowed_domains, blocked_domains):
            continue

        results.append(
            {
                "title": row["title"],
                "url": clean_url,
                "snippet": row["snippet"],
            }
        )
        if len(results) >= max_results:
            break

    return results


def search_duckduckgo_detailed(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10,
    log: bool = True,
    timeout: float = 15.0,
) -> Dict[str, Any]:
    """Search DuckDuckGo Lite and report *why* a run produced no results.

    Returns a typed dict::

        {"status": "ok" | "empty" | "blocked" | "error",
         "results": [...], "hint": "...", "query": "<effective query>"}

    ``"blocked"`` is DDG's anti-bot interstitial (an actionable hint, not an
    empty success). ``"empty"`` is a genuine no-hits query. ``"error"`` is a
    network/HTTP failure. Only this function preserves the distinction;
    :func:`search_duckduckgo` keeps the legacy list contract for callers that
    do not need it. ``timeout`` bounds the HTTP fetch (the preflight probe wires
    its own bound through here instead of the hardcoded default).
    """
    effective_query = _build_search_query(query, allowed_domains, blocked_domains)
    try:
        html = _fetch_ddg_html(effective_query, timeout=timeout)
    except TypeError:
        # An injected/older ``_fetch_ddg_html`` that takes only the query.
        html = _fetch_ddg_html(effective_query)

    if not html:
        results: List[Dict[str, str]] = []
        status = "error"
        hint = DDG_ERROR_HINT
    elif _is_ddg_anomaly_page(html):
        results = []
        status = "blocked"
        hint = DDG_BLOCKED_HINT
    else:
        results = _parse_ddg_results(
            html, allowed_domains, blocked_domains, max_results
        )
        status = "ok" if results else "empty"
        hint = "" if results else "No results parsed for this query."

    _log_ddg_query(status, effective_query, len(results), log=log)
    return {
        "status": status,
        "results": results,
        "hint": hint,
        "query": effective_query,
    }


def search_duckduckgo(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10,
    log: bool = True,
    timeout: float = 15.0,
) -> List[Dict[str, str]]:
    """Execute search query against DuckDuckGo Lite without API keys.

    Preserves the original list contract for callers that only want results.
    When DDG serves its anti-bot interstitial this returns ``[]`` *and* warns on
    stderr; callers that must act on the block should use
    :func:`search_duckduckgo_detailed` or :func:`require_search_duckduckgo`.
    """
    outcome = search_duckduckgo_detailed(
        query, allowed_domains, blocked_domains, max_results, log=log, timeout=timeout
    )
    if outcome["status"] == "blocked":
        sys.stderr.write(f"[epistemic-search] BLOCKED: {outcome['hint']}\n")
    return outcome["results"]


def require_search_duckduckgo(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10,
    log: bool = True,
    timeout: float = 15.0,
) -> List[Dict[str, str]]:
    """Like :func:`search_duckduckgo` but raises :class:`SearchBlocked`.

    Use when an anti-bot page is an error condition (fall back to another
    engine, then retry) rather than an empty success.
    """
    outcome = search_duckduckgo_detailed(
        query, allowed_domains, blocked_domains, max_results, log=log, timeout=timeout
    )
    if outcome["status"] == "blocked":
        raise SearchBlocked(outcome["hint"], hint=outcome["hint"])
    return outcome["results"]


def format_xml(results: List[Dict[str, str]]) -> str:
    """Format results as Claude Code <search_results> XML.

    Every field is XML-escaped at emit time. The parser stores decoded text, so
    without this a snippet like ``A &amp; B`` becomes ``A & B`` and produces
    malformed markup (bare ``&``); URLs containing query strings have the same
    problem.
    """
    lines = ["<search_results>"]
    for r in results:
        lines.append("  <result>")
        lines.append(f"    <title>{xml_escape(r['title'])}</title>")
        lines.append(f"    <url>{xml_escape(r['url'])}</url>")
        lines.append(f"    <snippet>{xml_escape(r['snippet'])}</snippet>")
        lines.append("  </result>")
    lines.append("</search_results>")
    return "\n".join(lines)


def _read_stdin_payload() -> Tuple[str, Optional[List[str]], Optional[List[str]]]:
    if sys.stdin.isatty():
        return "", None, None
    try:
        data = sys.stdin.read().strip()
        if not data:
            return "", None, None
        try:
            payload = json.loads(data)
            return (
                payload.get("query", ""),
                payload.get("allowed_domains"),
                payload.get("blocked_domains"),
            )
        except json.JSONDecodeError:
            return data, None, None
    except Exception:
        return "", None, None


def _parse_cli_args(
    args: List[str],
    default_query: str = "",
    default_allowed: Optional[List[str]] = None,
    default_blocked: Optional[List[str]] = None,
) -> Tuple[str, Optional[List[str]], Optional[List[str]], bool, bool]:
    query = default_query
    allowed = default_allowed
    blocked = default_blocked
    output_json = False
    output_status = False
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--json":
            output_json = True
        elif arg == "--status":
            output_status = True
        elif arg == "--allowed-domain" and idx + 1 < len(args):
            allowed = (allowed or []) + [args[idx + 1]]
            idx += 1
        elif arg == "--blocked-domain" and idx + 1 < len(args):
            blocked = (blocked or []) + [args[idx + 1]]
            idx += 1
        elif not query and not arg.startswith("--"):
            query = arg
        idx += 1
    return query, allowed, blocked, output_json, output_status


def main():
    std_query, std_allowed, std_blocked = _read_stdin_payload()
    query, allowed, blocked, output_json, output_status = _parse_cli_args(
        sys.argv[1:], std_query, std_allowed, std_blocked
    )

    if not query:
        sys.stderr.write(
            'Usage: search.py [options] <query>\nOr pipe JSON: echo \'{"query":"..."}\' | search.py\n'
            "Options: --json (results as JSON), --status (typed status + hint),\n"
            "         --allowed-domain D, --blocked-domain D\n"
        )
        sys.exit(1)

    outcome = search_duckduckgo_detailed(
        query=query,
        allowed_domains=allowed,
        blocked_domains=blocked,
    )

    if outcome["status"] in ("blocked", "error"):
        sys.stderr.write(
            f"[epistemic-search] {outcome['status'].upper()}: {outcome['hint']}\n"
        )

    if output_status:
        print(
            json.dumps(
                {
                    "status": outcome["status"],
                    "query": outcome["query"],
                    "results": len(outcome["results"]),
                    "hint": outcome["hint"],
                },
                indent=2,
            )
        )
    elif output_json:
        print(json.dumps(outcome["results"], indent=2))
    else:
        print(format_xml(outcome["results"]))


if __name__ == "__main__":
    main()
