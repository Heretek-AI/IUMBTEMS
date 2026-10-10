# ADR 0003: Web control plane framework (SolidJS)

- **Status:** Accepted (SolidJS, per the Phase 4 plan direction; the human re-confirms at the #134 release review).
- **Date:** 2026-10-09
- **Epic:** #94 · **Milestone:** Phase 4 · Web control plane · 1.5.0
- **Ticket:** #129 (scaffold; features follow in #130–#133)

## Context

`packages/web` is the fourth surface: the fleet dashboard, browser approvals,
config editor and evidence explorer, served by the fleet daemon on loopback
behind a single-use ticket exchange (#129). The build must be fully local
(no runtime CDN — the daemon's CSP is `script-src 'self'`), small, and
consistent with the surfaces that already exist. The TUI (`packages/opencode`)
renders with Solid (`solid-js` 1.9.15 plus `@opentui/solid`).

Prior art consulted (clean-room: concepts only, no code taken): the
single-use web-token plus loopback-origin pattern of local-first web UIs,
the one-time-URL session bootstrap of device-pairing flows, and the DAG and
evidence-graph layouts of the orchestrator UIs named in #130/#131/#133.

## Options

- *React + Vite.* The mature choice for graph work: React Flow is the
  reference DAG library #130 and #133 would otherwise need to re-approach.
  Cost: a second reactive model in the repo, a larger baseline bundle, and a
  new lockfile subtree with no sharing against the TUI.
- *SolidJS + Vite (chosen).* The same signals model the TUI already uses,
  the same `solid-js` lockfile entry (1.9.15, shared with the TUI — no new
  subtree), and a smaller baseline: the #129 hello page builds to 15 kB of
  JS. Cost: thinner off-the-shelf DAG/graph libraries than React Flow.

## Decision

Adopt **SolidJS with Vite** for `packages/web`:

1. The framework shares the TUI's reactive vocabulary (signals, resources),
   so dashboard code and TUI panels stay mutually readable.
2. The bundle stays small enough to serve from the daemon without caching
   tricks (15 kB hello page, measured in #129).
3. The graph gap is handled by **clean-room SVG rendering** in #130/#133,
   not by vendoring a React graph stack: the DAG and claim-graph layouts
   are simple node-link views over data the bus already shapes, and the
   repo constitution forbids copying either way. If a Solid graph library
   is adopted later, it gets its own scout verdict first.
4. No runtime CDN, ever: `vite build` emits `packages/web/dist/`, served
   from the workspace path in dev and from an embedded asset map once
   fleet publishes.

## Consequences

- `packages/web` is private and never published (ADR 0001); it declares
  boundaries in `scripts/deps.ts` (nothing imports web; web imports nothing
  at runtime except the fleet API's schema types) and gets a path-filtered
  CI job (`.github/workflows/web.yml`).
- Serving stays on the bus port with the #126 token/Host/Origin defences
  plus the #129 ticket→cookie exchange and strict CSP.
- **Revisit when** a feature needs a graph interaction (pan/zoom/layout)
  that hand-rolled SVG cannot carry cleanly — with a scout verdict before
  any new dependency.
