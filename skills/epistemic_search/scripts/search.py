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

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


class DDGLiteParser(HTMLParser):
    """Linear, non-backtracking HTML parser for DuckDuckGo Lite search results."""

    def __init__(self):
        super().__init__()
        self.links: List[Tuple[str, str]] = []
        self.snippets: List[str] = []
        self._current_tag: Optional[str] = None
        self._current_href: str = ""
        self._buf: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        attr_dict = {k: v or "" for k, v in attrs}
        classes = attr_dict.get("class", "").split()
        if tag == "a" and "result-link" in classes:
            self._current_tag = "a"
            self._current_href = attr_dict.get("href", "")
            self._buf = []
        elif tag == "td" and "result-snippet" in classes:
            self._current_tag = "td"
            self._buf = []

    def handle_endtag(self, tag: str):
        if tag == "a" and self._current_tag == "a":
            self.links.append((self._current_href, "".join(self._buf).strip()))
            self._current_tag = None
            self._buf = []
        elif tag == "td" and self._current_tag == "td":
            self.snippets.append("".join(self._buf).strip())
            self._current_tag = None
            self._buf = []

    def handle_data(self, data: str):
        if self._current_tag:
            self._buf.append(data)


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
        sys.stderr.write(f"[epistemic-search] Network error fetching search results: {e}\n")
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
    if allowed_domains and not any(hostname == d or hostname.endswith("." + d) for d in allowed_domains):
        return False
    if blocked_domains and any(hostname == d or hostname.endswith("." + d) for d in blocked_domains):
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

    results = []
    for (href, title), snip in zip(parser.links, parser.snippets):
        clean_url = _parse_clean_url(href)
        if not clean_url.startswith("http"):
            continue

        parsed_url = urllib.parse.urlparse(clean_url)
        hostname = parsed_url.hostname or ""
        if not _is_domain_allowed(hostname, allowed_domains, blocked_domains):
            continue

        results.append({
            "title": title,
            "url": clean_url,
            "snippet": snip,
        })
        if len(results) >= max_results:
            break

    return results


def format_xml(results: List[Dict[str, str]]) -> str:
    """Format results as Claude Code <search_results> XML."""
    lines = ["<search_results>"]
    for r in results:
        lines.append("  <result>")
        lines.append(f"    <title>{urllib.parse.quote(r['title'])}</title>")
        lines.append(f"    <url>{r['url']}</url>")
        lines.append(f"    <snippet>{r['snippet']}</snippet>")
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
        sys.stderr.write("Usage: search.py [options] <query>\nOr pipe JSON: echo '{\"query\":\"...\"}' | search.py\n")
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
