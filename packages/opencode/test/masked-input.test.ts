// Production MaskedInput, rendered for real (#222.1): OpenTUI's headless
// test renderer drives the shipped component from test/render/masked-input.tsx
// (run in a subprocess so the Solid transform preload stays out of the
// real-host tests that share this process). Keystrokes render only as
// bullets, submit delivers the exact code points, the buffer is zeroed,
// and no captured frame contains any probe secret.
import { expect, test } from "bun:test"
import path from "node:path"

const pkg = path.resolve(import.meta.dir, "..")

interface Scenario {
  readonly frames: string[]
  readonly submitted?: string
  readonly cancelled: boolean
  readonly refLength?: number
}

test("MaskedInput masks, submits exactly, zeroes and never leaks a frame", async () => {
  const proc = Bun.spawn(
    ["bun", "--conditions=browser", "--preload", "@opentui/solid/preload", "test/render/masked-input.tsx"],
    { cwd: pkg, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
  const { a, b, c } = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<"a" | "b" | "c", Scenario>

  // A: type 8, backspace to 7, retype to 8, Enter submits exactly s3cr3t-P.
  expect(a.frames[1]).toContain("Passphrase: ••••••••")
  expect(a.frames[2]).toContain("Passphrase: •••••••")
  expect(a.frames[3]).toContain("Passphrase: ••••••••")
  expect(a.submitted).toBe("s3cr3t-P")
  expect(a.refLength).toBe(0)
  // The buffer is cleared on screen too: a bare prompt, no bullets.
  expect(a.frames.at(-1)).toContain("Passphrase:")
  expect(a.frames.at(-1)).not.toContain("•")

  // B: bracketed paste with an embedded newline submits atomically, stripped.
  expect(b.frames[1]).toContain(`Passphrase: ${"•".repeat(20)}`)
  expect(b.submitted).toBe("pasted-passphrase-99")
  expect(b.refLength).toBe(0)

  // C: typing then Esc cancels with no submit.
  expect(c.frames[1]).toContain(`Passphrase: ${"•".repeat(13)}`)
  expect(c.cancelled).toBe(true)
  expect(c.submitted).toBeUndefined()
  expect(c.frames.at(-1)).toContain("Cancelled.")

  // No captured frame contains any probe secret (typed, pasted or cancelled).
  const probes = ["s3cr3t-P", "s3cr3t-p", "pasted-passphrase-99", "pasted-pass", "cancel-me-zz9"]
  for (const scenario of [a, b, c])
    for (const frame of scenario.frames) for (const probe of probes) expect(frame).not.toContain(probe)
}, 120_000)
