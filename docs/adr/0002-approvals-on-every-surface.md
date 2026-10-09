# ADR 0002: Approvals on every surface (TUI, CLI, browser)

- **Status:** Proposed (acceptance needs the user's I8 confirmation; see "To accept").
- **Date:** 2026-10-09
- **Epic:** #92 · **Milestone:** Phase 2 · Approvals everywhere · 1.3.0
- **Ticket:** #116 (threat model and checklist included; no separate file)
- **Supersedes:** decision 20 on #35, for approvals only.

## Context

Decision 20 on #35 kept passphrase entry in a terminal: the OpenCode TUI
previewed an approval and then told the human to run `es approve <stage>` at a
terminal, where `confirmHuman` reads the passphrase with echo off and unlocks
the sealed Ed25519 human key. Terminal-only existed for one reason: the
passphrase is the only thing an agent must never reach, and a terminal prompt
with echo off was the only input the project trusted.

On 2026-10-08 the user reversed that decision **for approvals only**:
"Approve should be in the OpenCode interface, CLI, and web browser."
Trust, waivers, resume, `key seal`, `config set` and research export stay
terminal-only.

This ADR records the new decision, the threat model, the normative invariants
every surface must satisfy, the inventory of terminal-only enforcement points
with their dispositions, and the adversarial-review checklist that gates the
TUI build (#119) and the browser build (#131).

The key security observation, stated in the epic: the passphrase protects
approvals, not the terminal. The plugin's server process already runs
unsandboxed on the human's machine and can read the sealed key file
(`ensureEngineKey` runs at setup). What was never exposed — and must stay
unexposed — is the passphrase itself, plus the act of signing without a live
human typing it.

Prior art consulted (clean-room: concepts only, no code taken): the
single-use ticket hashes bound to subject hashes already in this repo's RPC
layer, the durable-approvals pattern of single-use TTL-bound tickets, and the
loopback-only plus origin-check pattern for local approval servers.

## Decision

Frontier and spec approvals work on three surfaces — the CLI (as today), the
OpenCode TUI (#119), and the browser (#131, Phase 4) — under invariants
I1–I8 below. Everything else human-only stays terminal-only (I7). The shared
approval side effects move into one core service, `approveStage` (#117), so no
surface copies the record → clear-pending → begin-research sequence.

Browser key handling follows option (b): the sealed key never leaves the
machine's state dir; the passphrase travels only over loopback to the local
server. This is a recommendation (I8) awaiting user confirmation before this
ADR is marked accepted.

## Options considered

- **(a) Terminal-only (status quo).** Keep decision 20. Rejected: the user
  explicitly reversed it for approvals, and the TUI preview-then-terminal
  round trip is the worst of both worlds — the human reviews in one place
  and signs in another.
- **(b) Server-side unlock in the plugin or fleet process (recommended).**
  The passphrase is typed into a human-facing input on the machine (TUI
  dialog, localhost page) and travels at most over loopback to the local
  server process, which unlocks the sealed key, signs, and zeroizes. The
  sealed key file never leaves the state dir and the private key never
  crosses a network boundary. The existing server already reads the state
  dir, so this grants it no new reach — only the passphrase, transiently.
- **(c) Client-side unlock in the browser, sealed key blob sent to the page.**
  The page fetches the sealed blob, decrypts with a passphrase typed in the
  page, and signs there (or returns the signature). Rejected as the default:
  it moves the sealed blob across an HTTP boundary into a JavaScript context
  shared with page scripts, widening what a compromised dependency in
  `packages/web` (actor 5) can steal from "transient passphrase" to "the
  sealed key itself, for offline attack at leisure". scrypt slows guessing
  but a stolen blob can be attacked forever, on any hardware.

## Threat model

Actors and what they can reach, with mitigations. "Agent with shell" means a
prompt-injected agent acting through a seat or user-agent shell.

1. **A prompt-injected agent with a shell (sandboxed; unsandboxed as the
   fallback).** Can run anything its sandbox allows, including driving a PTY.
   Mitigations: the passphrase is never echoed and never lands in files the
   agent can read (I1); signing needs the live-typed passphrase, which a PTY
   recording cannot recover — watching dots is not the passphrase; mutating
   approval endpoints are unreachable from agent contexts (I6); attempts are
   throttled (I4); `HUMAN_VERBS` keeps `approve` denied in every agent shell.
2. **An agent holding the OpenCode server password.** Can call any RPC the
   server exposes. Mitigations: there is no approve/trust/resume RPC and
   there never will be — the TUI signs in its own process through core, not
   over RPC (#119 design), so the #49 property ("no mutating approval RPC")
   still holds; preview tickets are single-use, TTL-bound (≤ 120 s) and tied
   to `hashJson(subject)`, and redeeming one without the dialog path buys
   nothing (I3, I6).
3. **A malicious web page in the same browser (CSRF / DNS rebinding against
   a localhost server).** Can make the browser send requests to loopback.
   Mitigations for the browser path (#131): the local server binds
   loopback-only, checks `Host` and `Origin`, and requires a one-time URL
   token issued by a human-only verb; it refuses to run under `ES_SANDBOX`
   (I6). Rebinding a DNS name to 127.0.0.1 still fails the `Host`/`Origin`
   checks.
4. **A shoulder-surfer.** Sees the screen. Mitigations: masked input shows
   only bullets (I1); the CLI equivalent is echo-off input.
5. **A compromised npm dependency in `packages/web`.** Runs script in the
   approval page's context. Mitigations: under option (b) the page sees only
   the passphrase transiently (still bad — hence the recommendation is
   necessary, not sufficient), and never the sealed blob or the private key
   (I2); under the rejected option (c) it would see the sealed blob. The
   browser ticket (#131) must additionally scope page scripts (lockfile,
   SRI/CSP) — listed in the checklist.

## Invariants (normative)

- **I1** The passphrase is collected only by a human-facing input that masks
  keystrokes, and is held only in a local variable for the unlock. It never
  enters reactive state, logs, telemetry, RPC events or model context.
- **I2** The private key is decrypted only in the process that signs, and
  zeroized after signing (best effort in JS: overwrite the Buffer). It never
  crosses a network boundary.
- **I3** Every surface signs only what it previewed. A single-use ticket
  (TTL ≤ 120 s) binds the preview to `hashJson(subject)`, and signing
  re-derives the subject and refuses a mismatch.
- **I4** Attempts are limited: at most N wrong passphrases per M minutes per
  surface (recommended 5 per 10 min), then a lockout and an audit entry.
- **I5** The channel is recorded (`cli`, `tui` or `web`) and audited.
- **I6** Mutating approval endpoints are unreachable from agent contexts: no
  agent tool and no MCP tool; the TUI path requires the TUI process's dialog;
  the web path requires a localhost-only server started by a human-only verb,
  which refuses under `ES_SANDBOX`, checks origin and Host, and needs a
  one-time URL token.
- **I7** Trust, waive, resume, key seal, config set and export stay
  terminal-only.
- **I8** Browser key handling follows option (b): the sealed key never leaves
  the machine's state dir; the passphrase travels only over loopback to the
  local server. **Recommended (b); awaiting user confirmation.**

## Inventory of terminal-only enforcement points

"Keep" means unchanged. "Change" names the ticket that changes it. Verified
against the tree on 2026-10-09 (branch `integration/phase-2`, at Phase 1
HEAD `477d607`); line numbers are approximate.

| # | Point | Disposition |
|---|---|---|
| 1 | `packages/cli/src/tty.ts` (`NotInteractive`, echo-off `readSecret`, `confirmHuman`) | Keep: the CLI path still needs a TTY and masked input. |
| 2 | `packages/cli/src/key.ts` (`es key seal` messaging) | Keep: key seal stays terminal-only (I7). |
| 3 | `packages/cli/src/main.ts` (TTY refusal, exit codes) | Keep: CLI human verbs still refuse without a TTY. |
| 4 | `packages/opencode/src/rpc-def.ts` header (no approve/trust/resume RPC) | Change wording in #119: approvals join the TUI but still never cross RPC; the no-mutating-RPC property stays and its test stays. |
| 5 | `packages/opencode/src/rpc.ts` header + `issue`/`redeem` (120 s TTL, `hashJson(subject)` binding; only `lspInstall` redeems) | Keep the mechanism; reword the header in #119. #119 adds no approve RPC. |
| 6 | `packages/opencode/src/tui.tsx` header + approve alert (`:72`) | Change in #119: approve completes in the TUI via the masked dialog and `approveStage`. |
| 7 | `packages/opencode/src/tui.tsx` trust (`:82`) and resume (`:103`) alerts | Keep: trust and resume stay terminal-only (I7). |
| 8 | `HUMAN_VERBS` + `HUMAN_ONLY` (`packages/core/src/trust/policy.ts`) | Keep: `approve` stays a human-only shell verb; the TUI path does not go through a shell. |
| 9 | `packages/core/src/approval/record.ts` header ("Only the CLI calls recordApproval") | Change in #117: the core service owns the sequence; every surface calls it. |
| 10 | `verifyApproval` / `signatureProblem` messages (`record.ts`, `keystore.ts`) | Change in #119 where they say "at a terminal" for re-approval; keep the `es key seal` wording (I7). |
| 11 | `packages/core/src/factory/liveness.ts` waiting lines | Change in #119 where they say approvals happen "in a terminal". |
| 12 | `packages/core/src/ops/tools.ts` (`esTools` waiting line, `es_request_approval` reply) | Keep: both already name `/es-approve` first; re-check in #119. |
| 13 | `packages/cli/src/mcp.ts` header (no approve/trust/waive/resume tool) | Keep (I6). |
| 14 | `packages/opencode/src/server.ts` setup + research/audit/resume messages | Keep: research, audit and resume paths are out of scope. |
| 15 | `packages/opencode/src/panels.tsx` pending-approvals footer | Change in #119: approve in the TUI, not only in a terminal. |
| 16 | Prompts `grill.md`, `factory.md`, skill `factory/SKILL.md` | Change in #119: both already name `/es-approve`; drop "terminal-only" framing for approvals, keep it for trust/waive/resume. |
| 17 | Tests `plugin.test.ts` #49 block (no approve RPC) | Keep: the property still holds after #119. |
| 18 | Tests `plugin.test.ts` + `fires-gates.test.ts` copied approve steps | Change in #117: call `approveStage` instead. |
| 19 | Tests `tui.test.ts` (preview → terminal alert) | Change in #119: preview → masked dialog → record. |
| 20 | Tests `cli.test.ts` (TTY + passphrase approval tests) | Keep: CLI behaviour is unchanged. |
| 21 | Tests `policy.test.ts` (human-only denials) | Keep. |
| 22 | Docs `AGENTS.md` invariant 1, `SYSTEM_ARCHITECTURE.md` §4 item 1 | Change in #116 (this ticket): reference this ADR; behaviour lands in #119. |
| 23 | Docs `README.md`, `docs/DOGFOOD.md` approval steps | Change in #119. |
| 24 | `CHANGELOG.md` 1.1.1 entries | Keep: history. |
| 25 | Waiver channel copies (`schema/waiver.ts`, `gates/waivers.ts`) | Change in #117: one shared channel schema incl. `"web"`. |

## Adversarial-review checklist (gates #119 and #131)

Each probe must be run against the built surface and its result posted on the
ticket before merge. All probes apply to both surfaces unless marked.

1. Approve from an agent shell (sandboxed seat and plain user agent): refused,
   nothing signed, nothing recorded.
2. Approve through `es mcp` (pinned adapter identity): no approve tool
   exists; the call fails.
3. Approve through an RPC call without the dialog: no mutating approval RPC
   exists (#49 test still green); a bare preview token redeems nothing.
4. Replay a ticket: redeeming the same preview token twice fails; an expired
   (> 120 s) ticket fails.
5. Change an artifact after the preview: signing re-derives the subject and
   refuses on hash mismatch (I3).
6. Brute-force the passphrase: 5 wrong attempts per 10 min lock out the
   surface with an audit entry (I4); scrypt cost unchanged.
7. Read the passphrase from logs, state, telemetry or UI snapshots: the
   passphrase appears nowhere but the masked input's local variable (I1).
   Grep the state dir, logs and test snapshots for the probe passphrase.
8. CSRF against the web server (#131 only): a cross-origin form/POST without
   the one-time URL token is refused; wrong `Origin`/`Host` refused.
9. DNS rebinding (#131 only): a request resolving to loopback under a foreign
   `Host` is refused.
10. Remote-attach TUI (#119 only): a TUI that cannot see the project root and
    state dir keeps the "approve in a terminal" alert instead of signing
    anywhere else.

## Consequences

- `ApprovalChannelSchema` gains `"tui"` usage (already defined) and `"web"`
  (#117); every record carries its channel (I5).
- The TUI plugin links core's approval service directly and signs in-process;
  no new RPC, no passphrase on the wire anywhere except loopback for the
  browser path.
- Attempt-limit state lives per surface (a small file in the state dir for
  the TUI/CLI; server memory plus audit for the web path).
- Docs and messages stop saying approvals are terminal-only, while trust,
  waive, resume, key seal, config set and export keep saying it.

## Revisit when

- The host gains a first-party masked input (the #118 spike's fallback
  analysis may already obsolete the custom component).
- WebAuthn / platform-keystore signing becomes available in the supported
  hosts (could remove passphrase-over-loopback for the browser path).
- A second approver or quorum is requested (record schema v3; new ADR).

## To accept

The author recommends I8 option (b) for the reasons under "Options
considered". **Before marking this ADR accepted, the user must confirm the
I8 choice; quote the confirmation here and flip the status to Accepted.**
Until then, #117 and #118 proceed (they need only I1–I7), while #119 and
#131 must not merge.

**Status note (2026-10-09):** a Stage-3 cascade step briefly marked this
ADR Accepted without the required user I8 confirmation; reverted to
Proposed. The merging human flips to Accepted only after quoting the
user's verbatim I8 option-(b) confirmation here.
