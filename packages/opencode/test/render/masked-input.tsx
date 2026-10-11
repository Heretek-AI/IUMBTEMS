// Renders the PRODUCTION MaskedInput headlessly with OpenTUI's test
// renderer (run by masked-input.test.ts in a subprocess with the Solid
// transform preloaded) and prints the captured frames plus outcomes as JSON.
//
// Probe secrets must appear in NONE of the frames: keystrokes render only
// as bullets, and the buffer is zeroed on submit/cancel.
//
// Synchronization is deliberately scheduler-free: fixed settles let the
// mock-PTY parser run, frames come from captureCharFrame (current state),
// and submit/cancel are observed by polling the callback flags — the
// renderer's waitFor* helpers break when the loop idles, which is exactly
// the dialog's settled state.
import { testRender } from "@opentui/solid"
import { MaskedInput } from "../../src/masked-input.tsx"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const bullets = (n: number) => `Passphrase: ${"•".repeat(n)}`

async function scenario(
  run: (mock: {
    typeText: (text: string) => Promise<void>
    pressBackspace: () => void
    pressEnter: () => void
    pressEscape: () => void
    pasteBracketedText: (text: string) => Promise<void>
    frame: () => string
  }) => Promise<string[]>,
): Promise<{ frames: string[]; submitted?: string; cancelled: boolean; refLength?: number }> {
  let submitted: string | undefined
  let submittedRef: string[] | undefined
  let cancelled = false
  let done = false
  const setup = await testRender(
    () => (
      <MaskedInput
        title="Unlock"
        onSubmit={(codepoints) => {
          submitted = codepoints.join("")
          submittedRef = codepoints
          done = true
        }}
        onCancel={() => {
          cancelled = true
          done = true
        }}
      />
    ),
    { width: 60, height: 8 },
  )
  const line = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((l) => l.includes("Passphrase:")) ?? "<none>"
  try {
    await sleep(400)
    const frames = [setup.captureCharFrame()]
    if (!frames[0]!.includes("Passphrase:")) throw new Error(`mount frame missing prompt: ${line()}`)
    const mid = await run({
      typeText: (text) => setup.mockInput.typeText(text),
      pressBackspace: () => setup.mockInput.pressBackspace(),
      pressEnter: () => setup.mockInput.pressEnter(),
      pressEscape: () => setup.mockInput.pressEscape(),
      pasteBracketedText: (text) => setup.mockInput.pasteBracketedText(text),
      frame: () => setup.captureCharFrame(),
    })
    frames.push(...mid)
    const deadline = Date.now() + 5_000
    while (!done) {
      if (Date.now() > deadline) throw new Error(`settle never fired; last: ${line()}`)
      await sleep(50)
    }
    await sleep(300)
    frames.push(setup.captureCharFrame())
    return { frames, submitted, cancelled, refLength: submittedRef?.length }
  } finally {
    setup.renderer.destroy()
  }
}

const expectLine = (frame: string, want: string, what: string) => {
  if (!frame.includes(want)) throw new Error(`${what}: missing ${JSON.stringify(want)} in ${JSON.stringify(frame)}`)
  return frame
}

// A: the spike sequence — type 8, backspace to 7, type to 8, Enter submits.
const a = await scenario(async (mock) => {
  await mock.typeText("s3cr3t-p")
  await sleep(400)
  const f1 = expectLine(mock.frame(), bullets(8), "type-8")
  mock.pressBackspace()
  await sleep(400)
  const f2 = expectLine(mock.frame(), bullets(7), "backspace-7")
  await mock.typeText("P")
  await sleep(400)
  const f3 = expectLine(mock.frame(), bullets(8), "retype-8")
  mock.pressEnter()
  return [f1, f2, f3]
})

// B: bracketed paste with an embedded newline submits atomically, stripped.
const b = await scenario(async (mock) => {
  await mock.pasteBracketedText("pasted-pass\nphrase-99")
  await sleep(400)
  const f1 = expectLine(mock.frame(), bullets(20), "paste-20")
  mock.pressEnter()
  return [f1]
})

// C: typing then Esc cancels with no submit.
const c = await scenario(async (mock) => {
  await mock.typeText("cancel-me-zz9")
  await sleep(400)
  const f1 = expectLine(mock.frame(), bullets(13), "cancel-type-13")
  mock.pressEscape()
  return [f1]
})

process.stdout.write(`${JSON.stringify({ a, b, c })}\n`)
process.exit(0)
