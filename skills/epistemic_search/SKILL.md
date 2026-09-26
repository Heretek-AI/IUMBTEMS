---
name: epistemic_search
description: High-integrity web search and document fetch skill with automatic SHA-256 content caching. Use when searching the web, retrieving primary sources, or fetching documentation while enforcing epistemic integrity.
---

# Epistemic Search & Verifiable Source Fetching

This skill provides zero-API-key web search (DuckDuckGo Lite) and content-addressed source fetching.
Every fetched web page is automatically saved with its SHA-256 fingerprint into `.research/sources/<sha256>.md` for mathematical auditability.

## 1. Web Search (No API Key Required)

Run search with a query:
```bash
python3 skills/epistemic_search/scripts/search.py "YOUR SEARCH QUERY"
```
Or with JSON piping:
```bash
echo '{"query": "zk-SNARK hardware benchmarks", "allowed_domains": ["arxiv.org", "eprint.iacr.org"]}' | python3 skills/epistemic_search/scripts/search.py
```

Outputs `<search_results>` XML containing title, URL, and snippets.

## 2. Verifiable Web Fetch & Automatic Caching

Fetch any web page or documentation:
```bash
python3 skills/epistemic_search/scripts/fetch.py "https://example.com/paper.html"
```

The script outputs clean markdown and automatically persists the raw source into `.research/sources/<sha256>.md`.

Use the resulting SHA-256 hash when making claims:
`[VERIFIED: <first_16_chars_of_hash>]`
Ensure any cited quotes are exact verbatim substrings from the cached document.
