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

### Anti-bot "blocked" detection (distinct from no results)

DuckDuckGo Lite sometimes answers with an HTTP-2xx image-selection CAPTCHA (the
"anomaly" interstitial) instead of results. It is **not** an empty result set,
so the script detects it and reports it distinctly:

```bash
# Typed status + actionable hint (status: ok | empty | blocked | error)
python3 skills/epistemic_search/scripts/search.py --status "YOUR QUERY"
```

* `blocked` — DDG served its anti-bot page. Surface the hint, back off, and
  retry later, or switch engines (`.research/config.json` → `search_engine`:
  `firecrawl` / `searxng`), or export a BYO provider key
  (`EXA_API_KEY` / `FIRECRAWL_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY` /
  `TINYFISH_API_KEY`).
* `empty` — a genuine no-hits query.
* `error` — network/HTTP failure.

The default list contract is unchanged: `search_duckduckgo(...)` still returns a
list and returns `[]` when blocked (writing the hint to stderr). Programmatic
callers that must act on a block can use `search_duckduckgo_detailed(...)`
(status dict) or `require_search_duckduckgo(...)`, which raises `SearchBlocked`.
Every query through our path is recorded in `.research/retrieval.jsonl` with
its `status` and `provider`, so a block is no longer indistinguishable from a
zero-hit query — including the metered rungs (exa/firecrawl/parallel/tavily/
tinyfish/searxng/console) executed by the OpenCode `websearch` provider, so a
metered-only run cannot read as `0 searches (~$0.00 est)`.

The preflight reachability probe is deliberately **not** logged (it is not an
agent search), so a zero-search run reports `our-path searches: 0`.

## 2. Verifiable Web Fetch & Automatic Caching

Fetch any web page or documentation:
```bash
python3 skills/epistemic_search/scripts/fetch.py "https://example.com/paper.html"
```

The script outputs clean markdown and automatically persists the raw source into `.research/sources/<sha256>.md`.

Use the resulting SHA-256 hash when making claims:
`[VERIFIED: <first_16_chars_of_hash>]`
Ensure any cited quotes are exact verbatim substrings from the cached document.
