// Config editor browser apply (#145, ADR 0002 I7 narrow): after a
// successful project-config preview the editor offers a masked passphrase
// input + Apply that submits exactly the previewed content. Gates panes
// never offer it. The passphrase lives in one local between the input read
// and the submit — never in a signal, the store, logs or the DOM after
// submit (I1). These run with `bun --conditions=browser`.
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { ConfigPlan, ConfigView } from "../src/api.ts"
import { ConfigEditor } from "../src/config.ts"
import { installDom } from "../src/test-dom.ts"

const setup = () => void installDom()

const view: ConfigView = {
  config: { licenseWhitelist: ["MIT"] },
  configHash: "oldhash-config-00000000000000000000000000000001",
  gates: { topN: 5 },
  gatesHash: "oldhash-gates-00000000000000000000000000000002",
  drift: { clean: true, violations: [], hasBaseline: false },
  forbidden: ["embeddings", "estimate"],
}

const okPlan: ConfigPlan = {
  ok: true,
  errors: [],
  oldHash: view.configHash,
  newHash: "newhash-config-00000000000000000000000000000009",
  changedKeys: ["licenseWhitelist"],
  commands: ['es config set licenseWhitelist ["MIT","Apache-2.0"]'],
}

const hooks = () => {
  const calls: Array<{ ticket: string; csrf: string; passphrase: string; file: string; content: unknown }> = []
  return {
    calls,
    requestTicket: async (_file: "config" | "gates", _content: unknown) => ({
      ticket: "ticket-hex",
      csrf: "csrf-hex",
      newHash: okPlan.newHash!,
    }),
    submitApply: async (
      ticket: string,
      csrf: string,
      passphrase: string,
      file: "config" | "gates",
      content: unknown,
    ) => {
      calls.push({ ticket, csrf, passphrase, file, content })
      return { ok: true as const, newHash: okPlan.newHash! }
    },
  }
}

const show = (
  apply?: Pick<Parameters<typeof ConfigEditor>[0], "requestTicket" | "submitApply">,
  preview: (file: "config" | "gates", content: unknown) => Promise<ConfigPlan> = async () => okPlan,
) => {
  render(
    () =>
      ConfigEditor({
        view: () => view,
        error: () => undefined,
        preview,
        ...(apply ?? {}),
      }) as unknown as Node,
    document.body,
  )
}

const clickPreview = async (): Promise<void> => {
  const buttons = [...document.body.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Preview"),
  )
  expect(buttons).toHaveLength(1)
  buttons[0]!.click()
  await Bun.sleep(0)
  await Bun.sleep(0)
}

const clickApply = async (): Promise<void> => {
  const buttons = [...document.body.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Apply"),
  )
  expect(buttons).toHaveLength(1)
  buttons[0]!.click()
  await Bun.sleep(0)
  await Bun.sleep(0)
}

describe("config browser apply", () => {
  test("no apply control without the apply hooks (terminal-only shell)", async () => {
    setup()
    show()
    await clickPreview()
    const labels = [...document.body.querySelectorAll("button")].map((button) => button.textContent ?? "")
    expect(labels.some((label) => /apply/i.test(label))).toBe(false)
  })

  test("a project-config preview offers the passphrase input + Apply", async () => {
    setup()
    const apply = hooks()
    show(apply)
    await clickPreview()
    expect(document.body.querySelector('input[type="password"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/apply/i)
  })

  test("apply submits exactly the previewed content, then clears the passphrase with no trace (I1)", async () => {
    setup()
    const apply = hooks()
    let previewed: unknown
    show(apply, async (_file, content) => {
      previewed = content
      return okPlan
    })
    const area = document.body.querySelector("textarea")
    expect(area).not.toBeNull()
    area!.value = JSON.stringify({ licenseWhitelist: ["MIT", "Apache-2.0"] })
    await clickPreview()
    // Edit again after the preview: the apply must still send the preview.
    area!.value = JSON.stringify({ licenseWhitelist: ["MIT", "TAMPERED"] })
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input?.getAttribute("autocomplete")).toBe("off")
    input!.value = "the-human-passphrase"
    await clickApply()
    expect(apply.calls).toHaveLength(1)
    expect(apply.calls[0]?.ticket).toBe("ticket-hex")
    expect(apply.calls[0]?.csrf).toBe("csrf-hex")
    expect(apply.calls[0]?.passphrase).toBe("the-human-passphrase")
    expect(apply.calls[0]?.file).toBe("config")
    expect(apply.calls[0]?.content).toEqual(previewed)
    expect(apply.calls[0]?.content).toEqual({ licenseWhitelist: ["MIT", "Apache-2.0"] })
    // I1: cleared before the request leaves, and no DOM trace remains.
    expect(input!.value).toBe("")
    expect(document.body.innerHTML).not.toContain("the-human-passphrase")
    expect(document.body.textContent).toMatch(/applied/i)
  })

  test("the gates pane never offers browser apply (terminal-only)", async () => {
    setup()
    const apply = hooks()
    show(apply)
    const tabs = [...document.body.querySelectorAll("button")].filter((button) =>
      ["Project config", "Gates"].includes(button.textContent ?? ""),
    )
    tabs[1]!.click()
    await Bun.sleep(0)
    await clickPreview()
    const labels = [...document.body.querySelectorAll("button")].map((button) => button.textContent ?? "")
    expect(labels.some((label) => /apply in (the )?browser|apply$/i.test(label))).toBe(false)
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    expect(document.body.textContent).toMatch(/terminal/i)
  })

  test("an apply refusal renders the message with no preview loss and no passphrase trace", async () => {
    setup()
    const apply = hooks()
    const probe = "refusal-probe-phrase-13579"
    show(
      {
        requestTicket: apply.requestTicket,
        submitApply: async () => {
          const error = new Error("wrong passphrase") as Error & { code?: number; details?: Record<string, unknown> }
          error.code = 403
          error.details = { remaining: 3 }
          throw error
        },
      },
      async () => okPlan,
    )
    const area = document.body.querySelector("textarea")
    area!.value = JSON.stringify({ licenseWhitelist: ["MIT", "Apache-2.0"] })
    await clickPreview()
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    input!.value = probe
    await clickApply()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/wrong passphrase/)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/3/)
    expect(input!.value).toBe("")
    expect(document.body.innerHTML).not.toContain(probe)
    // The preview survives: no re-preview round-trip needed.
    expect(document.body.textContent).toContain("licenseWhitelist")
  })
})
