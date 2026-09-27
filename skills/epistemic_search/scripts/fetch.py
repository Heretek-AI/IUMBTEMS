#!/usr/bin/env python3
"""
Zero-API-Key Web Content Fetcher with Automatic Content-Addressed SHA-256 Caching.
Fetches web content, cleans HTML to readable Markdown, and persists directly into
.research/sources/<sha256>.md for epistemic auditability.
"""

import sys
import os
import re
import json
import urllib.request
import urllib.parse
from html.parser import HTMLParser

# Add project root to sys.path to import SourceHasher
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PKG_ROOT not in sys.path:
    sys.path.insert(0, PKG_ROOT)

try:
    from skills.research_cache.hasher import SourceHasher
except ImportError:
    SourceHasher = None

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

class HTMLToMarkdownExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_script_or_style = False
        self.title = ""
        self.in_title = False
        self.text_chunks = []
        self.headings = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg", "header", "footer", "nav"):
            self.in_script_or_style = True
        elif tag == "title":
            self.in_title = True
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.text_chunks.append(f"\n\n{'#' * int(tag[1])} ")
        elif tag in ("p", "div", "article", "section"):
            self.text_chunks.append("\n\n")
        elif tag == "li":
            self.text_chunks.append("\n- ")
        elif tag == "br":
            self.text_chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "header", "footer", "nav"):
            self.in_script_or_style = False
        elif tag == "title":
            self.in_title = False
        elif tag in ("p", "div", "article", "section"):
            self.text_chunks.append("\n")

    def handle_data(self, data):
        if self.in_script_or_style:
            return
        if self.in_title:
            self.title += data
        else:
            self.text_chunks.append(data)

    def get_markdown(self) -> str:
        raw_text = "".join(self.text_chunks)
        # Clean multiple blank lines
        clean_text = re.sub(r"\n{3,}", "\n\n", raw_text).strip()
        return clean_text

def fetch_and_cache(url: str, research_dir: str = ".research") -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw_bytes = resp.read()
            html = raw_bytes.decode("utf-8", errors="replace")
    except Exception as e:
        sys.stderr.write(f"[epistemic-fetch] Error fetching URL {url}: {e}\n")
        return f"Error fetching {url}: {e}"

    parser = HTMLToMarkdownExtractor()
    parser.feed(html)
    page_title = parser.title.strip() or url
    body_markdown = parser.get_markdown()

    # Cache into .research/sources/<sha256>.md
    sha256_hash = "uncached"
    cache_file = "not saved"
    if SourceHasher:
        from pathlib import Path
        hasher = SourceHasher(base_dir=Path(research_dir))
        sha256_hash = hasher.store_source(
            url=url,
            title=page_title,
            content=body_markdown
        )
        cache_file = str(hasher.sources_dir / f"{sha256_hash}.md")
    else:
        import hashlib
        sha256_hash = hashlib.sha256(body_markdown.encode("utf-8")).hexdigest()

    output = []
    output.append(f"<!-- EPISTEMIC_SOURCE_HASH: {sha256_hash} -->")
    output.append(f"<!-- CACHED_AT: {cache_file} -->")
    output.append(f"# {page_title}\n")
    output.append(f"**Source URL:** {url}")
    output.append(f"**Content SHA-256:** `{sha256_hash}`")
    output.append(f"**Verification Tag:** `[VERIFIED: {sha256_hash[:16]}]`\n")
    output.append(body_markdown)

    return "\n".join(output)

def main():
    url = ""
    research_dir = ".research"

    if not sys.stdin.isatty():
        try:
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                try:
                    payload = json.loads(stdin_data)
                    url = payload.get("url", "")
                    research_dir = payload.get("research_dir", research_dir)
                except json.JSONDecodeError:
                    url = stdin_data
        except Exception:
            pass

    args = sys.argv[1:]
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--dir" and idx + 1 < len(args):
            research_dir = args[idx + 1]
            idx += 1
        elif not url and not arg.startswith("--"):
            url = arg
        idx += 1

    if not url:
        sys.stderr.write("Usage: fetch.py [options] <url>\nOr pipe JSON: echo '{\"url\":\"https://...\"}' | fetch.py\n")
        sys.exit(1)

    result = fetch_and_cache(url=url, research_dir=research_dir)
    print(result)

if __name__ == "__main__":
    main()
