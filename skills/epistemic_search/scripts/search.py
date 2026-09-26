#!/usr/bin/env python3
"""
Zero-API-Key Web Search Engine for IUMBTEMS.
DuckDuckGo HTML/lite parser with domain filtering and Claude Code XML formatting.
"""

import sys
import json
import re
import urllib.request
import urllib.parse
from typing import List, Dict, Optional

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def search_duckduckgo(
    query: str,
    allowed_domains: Optional[List[str]] = None,
    blocked_domains: Optional[List[str]] = None,
    max_results: int = 10
) -> List[Dict[str, str]]:
    """Execute search query against DuckDuckGo Lite without API keys."""
    effective_query = query.strip()
    if allowed_domains:
        domain_filters = " " + " OR ".join(f"site:{d}" for d in allowed_domains)
        effective_query += domain_filters
    if blocked_domains:
        domain_filters = " " + " ".join(f"-site:{d}" for d in blocked_domains)
        effective_query += domain_filters

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
            html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        sys.stderr.write(f"[epistemic-search] Network error fetching search results: {e}\n")
        return []

    # Parse result links and snippets from DuckDuckGo Lite table rows
    links = re.findall(
        r"<a[^>]*href=['\"]([^'\"]+)['\"][^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>",
        html,
        re.DOTALL
    )
    snippets = re.findall(
        r"<td[^>]+class=['\"]result-snippet['\"][^>]*>(.*?)</td>",
        html,
        re.DOTALL
    )

    results = []
    for (href, title_html), snip_html in zip(links, snippets):
        # Unwrap DuckDuckGo redirect if present
        m = re.search(r"uddg=([^&]+)", href)
        if m:
            clean_url = urllib.parse.unquote(m.group(1))
        else:
            clean_url = href

        if not clean_url.startswith("http"):
            continue

        clean_title = re.sub(r"<[^>]+>", "", title_html).strip()
        clean_snippet = re.sub(r"<[^>]+>", "", snip_html).strip()

        # Check domain filtering manually in case DDG syntax didn't catch all
        parsed_url = urllib.parse.urlparse(clean_url)
        hostname = parsed_url.hostname or ""
        if allowed_domains and not any(hostname == d or hostname.endswith("." + d) for d in allowed_domains):
            continue
        if blocked_domains and any(hostname == d or hostname.endswith("." + d) for d in blocked_domains):
            continue

        results.append({
            "title": clean_title,
            "url": clean_url,
            "snippet": clean_snippet
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

def main():
    query = ""
    allowed_domains = None
    blocked_domains = None
    output_json = False

    # Check stdin first
    if not sys.stdin.isatty():
        try:
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                try:
                    payload = json.loads(stdin_data)
                    query = payload.get("query", "")
                    allowed_domains = payload.get("allowed_domains")
                    blocked_domains = payload.get("blocked_domains")
                except json.JSONDecodeError:
                    query = stdin_data
        except Exception:
            pass

    # Command line args override
    args = sys.argv[1:]
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--json":
            output_json = True
        elif arg == "--allowed-domain" and idx + 1 < len(args):
            allowed_domains = allowed_domains or []
            allowed_domains.append(args[idx + 1])
            idx += 1
        elif arg == "--blocked-domain" and idx + 1 < len(args):
            blocked_domains = blocked_domains or []
            blocked_domains.append(args[idx + 1])
            idx += 1
        elif not query and not arg.startswith("--"):
            query = arg
        idx += 1

    if not query:
        sys.stderr.write("Usage: search.py [options] <query>\nOr pipe JSON: echo '{\"query\":\"...\"}' | search.py\n")
        sys.exit(1)

    results = search_duckduckgo(
        query=query,
        allowed_domains=allowed_domains,
        blocked_domains=blocked_domains
    )

    if output_json:
        print(json.dumps(results, indent=2))
    else:
        print(format_xml(results))

if __name__ == "__main__":
    main()
