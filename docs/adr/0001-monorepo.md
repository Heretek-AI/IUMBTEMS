# One repository, one npm package per surface

Epistemic Swarm stays a single repository. Core, the CLI, the OpenCode plugin and the testkit live in it, and so will future surfaces: host adapters, `packages/fleet`, and `packages/web` (private, never published to npm). Separation happens at the npm-package level, not the repo level.

The reason is that the trust contract crosses package lines:
- core enforces policy, sidecars and seals;
- the plugin wires that enforcement into the host's permission hook;
- the CLI holds the human side (approve, key, reseal);
- the plugin writes the on-disk state, and the CLI reads and re-signs it, byte for byte.

These pieces must change together. That is why core, CLI and plugin release in lockstep, and why pipeline A tests them on the real host in one merge-blocking `bun run check`. #88 shows the risk: the CLI's argument parser and core's human-only matcher drifted apart, and in one repo it was caught and fixed in a single commit with tests beside both.

**Considered options.**
- *A repo per package.* This would need a compatibility matrix for the shared state format, and cross-repo integration tests that can't block the merge that broke them.
- *Separate plugins for brainstorm, harvest and deep research.* Each needs core's evidence cache and the plugin's permission perimeter. A second plugin would need its own perimeter, and host plugin load order is not a security boundary.

**Consequences.**
- Core must not import the CLI or the plugin, and the CLI must not import the plugin. `scripts/deps.ts` enforces this in `bun run check`.
- New packages get path-filtered CI jobs so core's CI stays fast. They version on their own or stay private; only the trust trio (core, CLI, plugin) releases in lockstep.
- Scraper-Swarm stays its own repository. It is a deployed service on its own toolchain (pnpm plus Python), so core integrates with it over MCP JSON-RPC, with recorded-fixture contract tests here.

**Revisit when** a component:
- gets its own language, toolchain or deploy secrets;
- gains an outside community that needs its own tracker or permissions;
- speaks to the rest over a stable, versioned protocol that no longer needs lockstep releases.
