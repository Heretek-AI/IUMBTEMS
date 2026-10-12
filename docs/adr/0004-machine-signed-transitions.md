# ADR 0004: Machine-signed stage transitions

- **Status:** Proposed (awaiting human acceptance)
- **Date:** 2026-10-12
- **Epic:** #321 · **Milestone:** Phase 11 · Autonomy wiring · 2.5.0
- **Tickets:** #343 (this record, no code) · #344 (wiring, gated by this ADR)
- **Blocked by:** #331 (machine-key audit; verdicts below are its scope)

## Context

2.3.0 shipped `MachineKeyStore` (`packages/core/src/approval/machine.ts`,
built in #164) as a library with no caller: an in-memory Ed25519 key scoped
to `integration/*` and `factory/*` that signs a stage transition only for a
green `GateProofBundle`. The factory state machine and the headless runner
still require the human passphrase at every stage exit. Phase 11 exit
criterion 1 asks headless runs to move through the allowed stages on staging
branches without a human passphrase at each exit — which changes the
product's first invariant (approvals are human-only, ADR 0002). Before
anything calls the machine key, this record fixes: which transitions, on
which branches, under what proof, and what stays human-only for good.

Audit #331 held on every claim fragment (verdict table on #331) and set two
boundaries #344 must keep, not fix:

- **B1 — signature-bound, not tip-bound.** `proof.commit` is format-checked
  (40-hex) and covered by the signature, but the machine layer has no repo
  access and never checks `proof.commit == branch tip`. Tip binding lives in
  `landOnStaging` (`packages/core/src/factory/staging.ts:100-101`).
  Replay-without-resign is refused (the signature covers the exact commit);
  replay-with-fresh-sign for another in-scope commit would mint. #344 records
  this boundary; tip enforcement for landings arrives with #345.
- **B2 — in-memory only.** Privates live in a module `WeakMap`, never on the
  store object or its JSON. Process exit drops every private: a saved
  `MachineTransitionApproval` still verifies under its saved `publicKeyPem`
  (historical verification works), but a new process mints a new `keyId` and
  cannot extend old signatures. There is no seal file and no resume path
  (unlike the human key). Post-exit minting under an old identity is
  impossible by construction.
- **Spot checks confirmed:** the bundle has no `lint` field (the Phase 7 epic
  asked for proof of zero lint errors; a machine proof therefore vouches for
  tiers, secrets, vulnerabilities and hashes — never for lint, which stays
  with the gate suites), and no export of the module has a functional caller
  (barrel only).

## Decision

A machine key may authorize exactly two stage exits — the two exits the
factory gates on a human approval today — and nothing else:

| # | Transition | Factory method (human path → machine path) | Authorizes |
|---|---|---|---|
| M1 | GRILL → RESEARCH | `beginResearch` → `beginResearchWithMachine` | replaces the frontier-approval check |
| M2 | SPEC → BUILD | `startBuild` → `startBuildWithMachine` | replaces the spec-approval check |

Both are `kind: "stage-transition"` records whose `branch` equals the current
checkout, on branches matching `integration/*` or `factory/*` only. The
machine path keeps every non-approval guard of the human path: audits clear
(an opened or failed audit still blocks, and `audit.phase: required` still
holds a missing one), gate-command trust (`waiting on you: trust` still
refuses untrusted commands), model-diversity refusal, roadmap limits, the
preset base-branch pin, the git-repo requirement, and artifact validation
(`approvalSubject` still validates the roadmap and every `GOAL.md`; the
machine path binds `goalHash` from the validated bytes on disk at build
start instead of from a human approval subject).

### Exact proof required (M1 and M2)

The attached `GateProofBundle` must be green under `proofProblems`, i.e. all
of:

- tiers 1–3 at 100% passing with **non-zero** totals (`passed === total`,
  `total > 0`; a `0/0` tier refuses);
- zero un-waived secrets and zero un-waived dependency vulnerabilities
  (waived findings are the human's waiver path and stay human-only);
- `specsVerified` and `schemasVerified` both true (verified hash integrity
  of specs and schemas);
- `commit` a 40-hex SHA, and `proof.branch` equal to the signed `branch`,
  which must equal the run's current checkout branch;
- `kind` is `"stage-transition"`, `target` is not `main` or `main/*`, and
  `stage` names the exit being authorized (`"GRILL"` for M1, `"SPEC"` for M2).

Additionally:

- **M1 needs a settled frontier and a human-set spend ceiling.** The grill's
  output must exist and be settled (no settled frontier, no machine exit —
  the machine never skips the grill), and the caller must supply
  `ceilingUSD > 0`. The ceiling is human-set (the headless `--max-usd`
  semantics: a human flag, never an agent value); the machine never sets,
  raises, or extends it. The spend ceiling stays mandatory: no ceiling, no
  exit.
- **M2 binds specs from disk.** With no human approval subject, `goalHash`
  comes from the validated on-disk roadmap/`GOAL.md` bytes at build start,
  so any later edit is still caught by the unchanged-artifact check in
  `complete`. The proof's `specsVerified` vouches for the specs; the disk
  hash binds them to the run.
- **Verification is fail-closed at every layer.** `verifyMachineTransition`
  returns false (never throws) for out-of-scope branches, release merges,
  main targets, red proofs and bad signatures; the factory re-checks kind,
  stage, branch and target explicitly before verifying, and refuses on any
  failure. A refusal changes no state.

### Never machine-signable (stay human-only for good)

- **Releases:** `kind: "release-merge"`, `cutRelease`/`openReleasePr` (the
  veto: unsigned cuts never open), `Factory.release` / `recordPr`, and the
  human merge of the draft PR. The factory never merges into the base branch.
- **Anything on or targeting `main`:** branch `main`, targets `main` or
  `main/*`. A headless run on `main` is refused and stays waiting on a human.
- **Trust:** `es trust` and the `isTrusted` gate — M2 keeps the trust refusal
  under a machine signature.
- **Waivers:** `es waive` — an un-waived finding blocks the machine bar; only
  a human waives.
- **Key operations:** `es key seal` / unlock / reset, `es reseal --sign`,
  engine-key handling. A machine `publicKeyPem` never unlocks the human key,
  and a machine record presented as a human approval is malformed and refused.
- **Resume, rebaseline, audit dismissal, and the approvals themselves:**
  `resume`, `rebaseline`, `es audit dismiss`, `recordApproval`/`approveStage`
  all stay passphrase-gated. The machine authorizes stage exits; it never
  mints, clears, or dismisses human authority.
- **Detached checkouts:** a run must be attributable to a branch. A machine
  transition with no current branch (detached HEAD, non-repo root) is refused.

## Threat model

Actors as in ADR 0002 (prompt-injected agents, holders of server credentials,
compromised dependencies), plus the headless runner itself, which holds the
machine key for the run:

1. **A prompt-injected seat during a headless run.** Can call factory tools
   but cannot mint: signing needs a green proof the seat cannot forge
   (tiers, scans and hash verification run outside seat reach), and the
   machine methods are engine code, not seat tools — there is no `es_*` or
   MCP tool that signs or that presents machine records.
2. **A holder of a saved (record, publicKeyPem) pair.** Holds a single-use
   bearer credential at most: the record authorizes exactly one exit (the
   stage moves on, so a second presentation fails `requireStage`), verifies
   only under its own key, and never extends to releases, `main`, trust, or
   waivers. Blast radius ends when the run's key is destroyed at run end.
3. **A stale-proof replayer.** Re-binding a record to another branch, commit,
   kind, target or proof body invalidates the signature (refused at verify).
   Replaying an old record verbatim is bounded by B1/B2: the signature binds
   the exact commit (no silent upgrade to newer code), and a fresh process
   cannot mint under the old identity. Tip-vs-proof equality is enforced at
   staging landings (#345), not here — recorded boundary, not a gap fix.
4. **A compromised proof supplier.** The headless runner takes proofs from a
   caller-supplied builder but never trusts it: `signStageTransition` throws
   on anything but green, and `verifyMachineTransition` re-checks scope,
   target and proof before the factory acts. A lying supplier buys nothing.
5. **A cross-protocol presenter.** Machine records are version 1 with machine
   fields; human approvals are version 2 with a human signature over
   `approvalSubject`. Each verify path refuses the other's shape.

## Adversarial-review checklist (gates #344)

Each probe runs against the built wiring and is posted on #344 before merge.
Machine-layer items (L) live in `packages/core/test/approval-machine.test.ts`
and `audit-keys.test.ts`; factory-layer items (F) in the new
`packages/core/test/factory-machine-sign.test.ts`; headless-layer items (H)
in the new `packages/cli/test/headless-sign.test.ts`.

1. **C1 out-of-scope branch:** sign on `main`/`feature/*` throws; verify on a
   re-bound out-of-scope branch is false; the factory refuses on a `main`
   checkout; the headless attempt refuses on `main`. (L/F/H)
2. **C2 release kind:** `release-merge` throws at sign and is false at verify
   even re-bound under a valid signature; the factory refuses a re-bound
   release record; the headless `RELEASE` attempt refuses without touching
   state. (L/F/H)
3. **C3 main target:** `main`/`main/*` targets throw at sign and are false at
   verify; the factory refuses a re-bound main-target record. (L/F)
4. **C4 red proof, every category:** a failing tier, a zero-total tier, an
   un-waived secret, an un-waived vulnerability, unverified specs/schemas,
   and a non-hex commit each refuse at sign; tampered equivalents are false
   at verify; the factory refuses at least one of each class. (L/F)
5. **C5 forgery:** a record whose proof body was swapped after signing is
   false at verify and refused by the factory and the headless attempt with
   state unchanged. (L/F/H)
6. **C6 cross-branch replay:** proof branch ≠ signed branch throws at sign;
   re-binding a valid signature to another branch is false at verify and
   refused by the factory. (L/F)
7. **C7 cross-commit replay:** re-binding a valid signature to another commit
   is false at verify and refused by the factory. (L/F)
8. **C8 wrong key and key death:** a record is false under another store's
   key; a destroyed store cannot sign; a new store mints a new `keyId` and
   cannot extend old signatures (B2 in code). (L)
9. **C9 cross-protocol:** a machine record planted as a human frontier/spec
   approval fails `verifyApproval`, and the human-only exits still refuse
   without a genuine human approval. (F)
10. **C10 trust preserved:** M2 with untrusted gate commands still refuses
    with the human-trust message under a valid machine record. (F)
11. **C11 audits preserved:** an opened (or failed) audit still blocks both
    machine exits; with `audit.phase: required` a missing phase audit still
    blocks. (F)
12. **C12 ceiling mandatory:** M1 without a positive human-set `ceilingUSD`
    refuses; the machine path never writes any other ceiling. (F/H)
13. **C13 human-only surface untouched:** no machine path exists for release,
    trust, waive, resume, rebaseline, key ops or dismissals; the headless
    runner attempts machine transitions only for frontier/spec waits on
    in-scope branches and otherwise stays waiting on a human. (F/H)
14. **C14 recorded boundaries:** the suite pins B1 (no tip check at this
    layer — a record for an older commit still verifies; tip enforcement
    belongs to `landOnStaging`/#345) and B2 (old records verify only as
    history under the saved public key; new keys cannot extend them) so a
    future change must update this ADR first. (F/L)

## Consequences

- `Factory` gains `beginResearchWithMachine` and `startBuildWithMachine`
  (plus a private record check); the headless runner gains an explicit
  machine attempt plus an opt-in proof supplier on headless runs. Nothing
  existing changes behaviour: without a supplied proof every run behaves as
  today.
- Machine attempts audit as `machine:<keyId>` (`stage.research` /
  `stage.build`), distinct from `human:*`, and clear only the satisfied
  pending entry (`frontier` for M1, `spec` for M2).
- The machine key lives for one attempt (created, signed, verified,
  destroyed) or one run; it is never persisted, sealed, or logged.
- Capability row `machine-key` keeps its proof; the "wiring lands in #344"
  note is retired by the wiring ticket's own commit, which touches no
  capability rows itself (that file is outside its scope).

## Revisit when

- #345 wires staging landings (tip binding meets machine proofs there).
- A real gate-proof builder exists (tiers, secret/vuln scans and hash
  verification assembled from gate runs instead of caller-supplied bundles).
- A second machine scope (e.g. `staging/*`) or quorum signing is requested
  (new ADR; this one's NEVER list does not move by ticket).

## To accept

The author recommends accepting the M1/M2 scope with the NEVER list and the
C1–C14 checklist above. **Before marking this ADR accepted, the human must
confirm in their own words or selection; quote the confirmation here and
flip the status to Accepted.** Until then, #344 must not merge. (The quote
is added by a human — never by the wiring session.)
