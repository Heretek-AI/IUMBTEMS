// Masked passphrase input for the OpenCode TUI (#119, from the #118 spike
// verdict GO). A custom dialog.show component: keystrokes are captured with
// no echo and plaintext lives only in a closure-scoped array (never in
// reactive state), zeroed on submit and on cancel. Only the bullet count is
// reactive (screen-equivalent: the bullets are visible anyway).

import { zeroCodepoints } from "@heretek-ai/es-core"
import { useKeyboard, usePaste } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

export interface MaskedInputOptions {
  readonly title: string
  readonly onSubmit: (codepoints: string[]) => void
  readonly onCancel: () => void
}

export function MaskedInput(props: MaskedInputOptions) {
  // The ONLY place plaintext lives: a plain closure array, not reactive state.
  const codepoints: string[] = []
  const [count, setCount] = createSignal(0)
  const [cancelled, setCancelled] = createSignal(false)
  let done = false

  const finish = (submit: boolean) => {
    if (done) return
    done = true
    try {
      if (submit) props.onSubmit(codepoints)
      else props.onCancel()
    } finally {
      zeroCodepoints(codepoints)
      setCount(0)
    }
  }
  onCleanup(() => {
    zeroCodepoints(codepoints)
    setCount(0)
  })

  useKeyboard((key) => {
    if (done) return
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      key.stopPropagation()
      finish(true)
      return
    }
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      key.preventDefault()
      key.stopPropagation()
      setCancelled(true)
      finish(false)
      return
    }
    if (key.name === "backspace") {
      key.preventDefault()
      key.stopPropagation()
      if (codepoints.length > 0) {
        codepoints.pop()
        setCount(codepoints.length)
      }
      return
    }
    // Printable characters only; everything else is consumed so it never
    // reaches the TUI keymap layer underneath the dialog.
    if (!key.ctrl && !key.meta && key.sequence && [...key.sequence].length === 1) {
      key.preventDefault()
      key.stopPropagation()
      for (const point of key.sequence) codepoints.push(point)
      setCount(codepoints.length)
      return
    }
    key.preventDefault()
    key.stopPropagation()
  })

  usePaste((event) => {
    if (done) return
    event.preventDefault()
    event.stopPropagation()
    // Bracketed paste arrives as one event: accept it atomically, strip newlines.
    const text = new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, "")
    if (text) {
      for (const point of text) codepoints.push(point)
      setCount(codepoints.length)
    }
  })

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text>{props.title}</text>
      <text>{cancelled() ? "Cancelled." : `Passphrase: ${"•".repeat(count())}`}</text>
      <text>Enter submits · Esc cancels · paste accepted as one unit</text>
    </box>
  )
}

/** The dialog surface the masked input needs (structural: scriptable in tests). */
export interface MaskedDialog {
  show(render: () => unknown, onClose?: () => void): void
  clear(): void
}

/**
 * Open the masked dialog and resolve to the entered code points, or
 * undefined on cancel. The caller copies, uses and zeroes them; the
 * component zeroes its own buffer on submit/cancel/unmount.
 */
export function readMaskedPassphrase(dialog: MaskedDialog, title: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (codepoints: string[] | undefined) => {
      if (settled) return
      settled = true
      dialog.clear()
      resolve(codepoints === undefined ? undefined : [...codepoints])
    }
    dialog.show(
      () => <MaskedInput title={title} onSubmit={(codepoints) => done(codepoints)} onCancel={() => done(undefined)} />,
      () => done(undefined),
    )
  })
}
