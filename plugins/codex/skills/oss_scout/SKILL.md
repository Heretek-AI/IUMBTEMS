---
name: oss-scout
description: Open-source software discovery, dependency vetting, and clean-room implementation scouting. Evaluates GitHub repositories, package ecosystems, licenses, and architecture to discover code to adopt or borrow.
---

# Open Source Scout & Clean-Room Harvesting Engine

Scout the open-source software ecosystem to discover mature libraries, reference implementations, and algorithms for research-based development.
The scout deploys a **Discovery Scout (Thesis)** to find high-performance implementations and a **Licensing & Bloat Red-Teamer (Antithesis)** to protect your project against viral copyleft, unmaintained abandonware, and security CVEs.

## 1. Invoking an Open Source Scout

Search for open-source solutions to implement a feature:
```bash
iumbtems scout "Find high-throughput zero-dependency Raft consensus implementations in Rust or Go"
```
Or via npx:
```bash
npx @heretek-ai/epistemic-swarm scout "Scout vector database indexing algorithms with MIT or Apache-2.0 license"
```
Or directly with the python runner:
```bash
python3 runner/research_swarm.py --mode scout --objective "Explore clean-room alternatives to AGPL licensed search engines"
```

## 2. Dialectic Evaluation Workflow

1. **Discovery (Alpha)**
   - Explores GitHub, GitLab, crates.io, PyPI, npm, and Go packages.
   - Compares star velocity, release frequency, benchmark throughput, and API design.
   - Automatically caches repository documentation into `.research/sources/<sha256>.md`.

2. **Adversarial Red-Teaming (Beta)**
   - **License Contamination**: Flags AGPL/GPL requirements that could compromise proprietary or permissive codebases.
   - **Maintenance Health**: Detects abandonware, stagnant commit logs, unresponsive PR queues, and solo maintainer risks.
   - **Dependency Weight**: Audits transitive dependency explosion and bundle size.
   - **Security Surface**: Scans for known CVEs and malicious package takeover vulnerabilities.

3. **Synthesis & Clean-Room Blueprints**
   - Synthesizes findings into `.research/oss_scout_report.md` and `.research/oss_scout_dossier.json`.
   - Produces a **Clean-Room Blueprint**: an algorithmic breakdown allowing in-tree implementation of the core feature without licensing entanglement.

## 3. Supported Package Ecosystems
- GitHub & GitLab Repositories
- Rust (crates.io)
- Python (PyPI)
- TypeScript / Node.js (npm)
- Go Modules
- C / C++ header-only libraries
