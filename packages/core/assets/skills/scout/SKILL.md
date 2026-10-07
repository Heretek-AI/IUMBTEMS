---
name: scout
description: OSS scouting — discovery axes, license/bloat/CVE red-team and clean-room blueprints. Load when vetting open-source candidates for a feature.
---
# OSS scout

- **Discovery axes:**
  - star velocity;
  - release cadence and last release;
  - benchmark throughput, as exact quotes;
  - API shape;
  - ecosystems: GitHub, GitLab, npm, PyPI, crates.io and Go.
- **Red-team every candidate:**
  - **License:** permissive (MIT, Apache-2.0, BSD, ISC), weak copyleft (LGPL, MPL), strong copyleft (GPL, AGPL, SSPL). The license must come from the LICENSE text. Unknown means clean-room.
  - **Maintenance:** commit and release activity, open issues, bus factor.
  - **Weight and attack surface:** dependency count, size, CVEs (OSV advisories).
  - **Clean-room feasibility:** can the core be rebuilt in-tree?
- **Verdicts are proposals:**
  - Core re-checks `adopt` against the verified license and the whitelist.
  - Adoption is the human's decision; the scout never adds a dependency.
- **Clean-room blueprint:** interfaces, the algorithm in prose, and test fixtures. Never copied code.
