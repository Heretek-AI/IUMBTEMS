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
from typing import Dict, List, Optional, Tuple
from xml.sax.saxutils import escape as xml_escape

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


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


def _fetch_ddg_html(effective_query: str) -> str:
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
        with urllib.request.urlopen(req, timeout=15) as resp:
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


def search_duckduckgo(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10,
) -> List[Dict[str, str]]:
    """Execute search query against DuckDuckGo Lite without API keys."""
    effective_query = _build_search_query(query, allowed_domains, blocked_domains)
    html = _fetch_ddg_html(effective_query)
    if not html:
        return []

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
) -> Tuple[str, Optional[List[str]], Optional[List[str]], bool]:
    query = default_query
    allowed = default_allowed
    blocked = default_blocked
    output_json = False
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--json":
            output_json = True
        elif arg == "--allowed-domain" and idx + 1 < len(args):
            allowed = (allowed or []) + [args[idx + 1]]
            idx += 1
        elif arg == "--blocked-domain" and idx + 1 < len(args):
            blocked = (blocked or []) + [args[idx + 1]]
            idx += 1
        elif not query and not arg.startswith("--"):
            query = arg
        idx += 1
    return query, allowed, blocked, output_json


def main():
    std_query, std_allowed, std_blocked = _read_stdin_payload()
    query, allowed, blocked, output_json = _parse_cli_args(
        sys.argv[1:], std_query, std_allowed, std_blocked
    )

    if not query:
        sys.stderr.write(
            'Usage: search.py [options] <query>\nOr pipe JSON: echo \'{"query":"..."}\' | search.py\n'
        )
        sys.exit(1)

    results = search_duckduckgo(
        query=query,
        allowed_domains=allowed,
        blocked_domains=blocked,
    )

    if output_json:
        print(json.dumps(results, indent=2))
    else:
        print(format_xml(results))


if __name__ == "__main__":
    main()
