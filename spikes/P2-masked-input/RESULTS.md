# Spike: masked passphrase input for the OpenCode TUI (P2, #118)

Date: 2026-10-09. Verdict: **GO** for #119. All commands run in
`.worktrees/ticket-118` (Phase 1 HEAD `477d607` + #116 merge); nothing here
is inferred. The prototype lives on the scratch branch
`spike/P2-masked-input-proto` (commit "Spike prototype: masked passphrase
input (SCRATCH, never merge)"); only this file merges.

## Drift from the ticket's "Current state"

- OpenTUI is **0.5.17**, not 0.5.14 (`packages/opencode/package.json`
  requires `0.5.17`; installed `packages/opencode/node_modules/@opentui/*`
  report `0.5.17`). The APIs below are verified against 0.5.17.
- `@opencode/plugin` is 2.0.24 as stated; `Dialog.show(render, onClose?)`,
  `clear()`, and `DialogPromptOptions` without a mask option are confirmed in
  `dist/tui/context.d.ts`.
- `InputRenderable` (single-line input) **exists** in OpenTUI 0.5.17 but has
  **no mask/password option** (`InputRenderableOptions`: `value`,
  `minLength`, `maxLength`, `placeholder` only) and stores plaintext in its
  text buffer. It cannot be used for passphrases. A custom component is
  required, as the ticket suspected.

## Answers

1. **Can a custom `dialog.show(render)` component capture keys with no echo?
   YES.** The prototype (`spike-masked-input/masked.tsx`) subscribes with
   `useKeyboard` (exported from `@opentui/solid`) and renders only bullets.
   Evidence — captured frames from the headless run
   (`bun --conditions=browser --preload @opentui/solid/preload
   spike-masked-input/proto.tsx`, exit 0):
   - typing `s3cr3t-p`, backspace, `P`, Enter → mid-entry frame shows
     `Passphrase: ••••••••` (8 bullets), submit delivers exactly `s3cr3t-P`;
   - after submit the frame shows a bare `Passphrase:` (buffer cleared);
   - every consumed key calls `preventDefault()` + `stopPropagation()`, so
     nothing reaches the TUI keymap layer underneath the dialog.
2. **Where does each character live? In a closure-scoped `string[]`, never in
   reactive state.** The component's only signals are `count: number` (the
   bullet count, screen-equivalent — the bullets are visible anyway) and
   `cancelled: boolean`. Evidence:
   - a frame audit over all 9 captured frames asserts none contains any of
     the 4 probe secrets (`s3cr3t-P`, `pasted-passphrase-99`, `abc`,
     `hello`): `leakedFrames: []`;
   - the live buffer reference kept by the test is `{length: 0, joined: ""}`
     after submit (zeroed in a `finally`, and again in `onCleanup`);
   - the host dialog holds only the render closure; `onSubmit` receives the
     array, so #119 must copy-then-unlock-then-zero without storing it.
   - Residual, accepted: the bullet count reveals passphrase *length* (the
     CLI's echo-off input reveals nothing). Masking keystrokes satisfies I1;
     length-hiding would cost backspace feedback and is out of scope.
3. **Paste: bracketed paste arrives as ONE `usePaste` event.** Verified with
   `mockInput.pasteBracketedText("line1\nline2-secret")` → a single event
   whose bytes decode to the full text. The prototype accepts it atomically
   (newlines stripped) — pasting `pasted-pass\nphrase-99` renders 20 bullets
   and submits exactly `pasted-passphrase-99`. Refusing paste would be a
   one-line change (`preventDefault` only); accepted-paste is recommended
   for usability, since the bytes never touch reactive state either way.
4. **Backspace, Esc/cancel, resize all work in the test renderer
   (`testRender` + `mockInput`, same harness as `test/render/panels.tsx`).
   - backspace deletes one code point (`pressBackspace` → `name:
     "backspace"`);
   - Esc cancels: `pressEscape()` emits `name: "escape"` **after the
     lone-ESC disambiguation timeout** (~150 ms in the renderer; the real
     host parses the same way, so Esc feels slightly delayed — cosmetic
     only). Outcome `cancelled: true`, frame shows `Cancelled.`, no submit.
     Ctrl-C is also bound to cancel-and-clear (consumed, so the host stays
     alive);
   - `resize(100, 30)` mid-entry keeps the 5-bullet mask.
   - Host retention after `dialog.clear()`: plaintext references exist only
     in the component closure, which `finish`/`onCleanup` zero before the
     dialog closes; after `clear()` the closure is unreferenced and
     GC-eligible. The host retains at most the render function and the
     (already zeroed) outcome. Not dump-verified against the host binary —
     stated as the residual integration probe for #119 (checklist probe 7
     covers it: grep state/logs/snapshots for the probe passphrase).
5. **Limitations; no fallback needed (GO, no degraded path).**
   - Every key must be consumed while the dialog is open, or it leaks to the
     keymap layer below. The prototype consumes all keys, printable or not.
   - The component assumes the host focuses the custom dialog the way it
     focuses built-in ones; #119 must verify focus in the real TUI (new
     probe below).
   - Multi-codepoint sequences are appended per code point; IME composition
     is untested and out of scope (terminal approvals have the same shape).
   - Ctrl-C-as-cancel changes the host's default Ctrl-C meaning while the
     dialog is open; acceptable for a short-lived approval dialog.

## Final API for #119

```tsx
maskedInput({
  title: string,
  onSubmit(codepoints: string[]): void,  // copy, unlock, use, zero — never store
  onCancel(): void,
}): void
```

Implementation: `context.ui.dialog.show(() => <MaskedInput {…} />)`;
`onSubmit`/`onCancel` call `dialog.clear()` after zeroing. Attempt limiting
(I4) wraps this component (counter file in the state dir), it is not part of
the input itself.

## Extra probe for the #119 checklist

- Focus check in the real TUI: open `/es-approve`, type a probe passphrase,
  confirm only bullets render, confirm no keystroke reaches the session
  prompt or command layer underneath, and confirm Esc/Enter behave as above.
