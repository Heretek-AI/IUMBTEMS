---
name: research-cache
description: Content-addressed document caching and quote verification skill. Hashes retrieved web pages and academic papers to SHA-256 for mathematical auditability.
---

# Content-Addressed Research Cache & Verification

To maintain epistemic integrity, every document fetched from the web, arXiv, or technical docs must be cached locally with a content-addressed SHA-256 fingerprint before its claims can be cited.

## 1. CACHING A SOURCE
When you fetch or scrape a URL:
```bash
python3 skills/research-cache/hasher.py cache \
  --url "https://arxiv.org/abs/2407.21783" \
  --title "Llama 3 Herd of Models" \
  --content "$(cat fetched_paper.md)"
```
This prints the content hash:
```
[CACHED] 3f8a9e21... -> .research/sources/3f8a9e21....md
```

## 2. CITING WITH HASHES
In your dossiers and markdown reports, cite the claim using the hash:
`[VERIFIED: 3f8a9e21]`

Ensure that any `verbatim_quote` you provide is an exact substring from the cached markdown document.

## 3. AUDITING A QUOTE
The Epistemic Auditor verifies claims using:
```bash
python3 skills/research-cache/hasher.py verify \
  --hash "3f8a9e21..." \
  --quote "Our FPGA pipeline executes the Poseidon round constraints in 184ms"
```
If the quote does not match, the claim is rejected and flagged as unverified.
