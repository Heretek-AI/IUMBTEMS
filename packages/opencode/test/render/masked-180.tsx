// Renders the production MaskedInput headlessly with OpenTUI's test
// renderer (run by approval-180.test.ts in a subprocess with the Solid
// transform preloaded, the same harness as test/render/panels.tsx) and
// prints the captured frames as JSON. No new harness.
import { testRender } from "@opentui/solid"
import { MaskedInput } from "../../src/masked-input.tsx"

const probe = "probe-180-mask-must-never-render-xyz"
const frames: string[] = []
let delivered = ""

const setup = await testRender(
  () => (
    <MaskedInput
      title="Approve frontier as tester"
      onSubmit={(codepoints) => {
        delivered = codepoints.join("")
      }}
      onCancel={() => {}}
    />
  ),
  { width: 80, height: 10 },
)
await setup.flush()
frames.push(setup.captureCharFrame())
await setup.mockInput.typeText(probe)
await setup.flush()
frames.push(setup.captureCharFrame())
setup.mockInput.pressEnter()
await setup.flush()
frames.push(setup.captureCharFrame())
setup.renderer.destroy()

process.stdout.write(`${JSON.stringify({ frames, delivered, probe })}\n`)
process.exit(0)
