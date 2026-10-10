// Config editor (#132, preview-only mode): strict-schema validation with
// exact hash diffs and terminal commands, and no apply path anywhere. The
// preview function is injected, so these tests run without a server; the
// preview-only audit (no mutation endpoint on the bus) lives in
// configview.test.ts.
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { ConfigPlan, ConfigView } from "./api.ts"
import { ConfigEditor } from "./config.ts"
import { installDom } from "./test-dom.ts"

const setup = () => void installDom()

const view: ConfigView = {
  config: { licenseWhitelist: ["MIT"] },
  configHash: "oldhash-config-00000000000000000000000000000001",
  gates: { topN: 5 },
  gatesHash: "oldhash-gates-00000000000000000000000000000002",
  drift: { clean: true, violations: [], hasBaseline: false },
  forbidden: ["embeddings", "estimate"],
}

const show = (preview: (file: "config" | "gates", content: unknown) => Promise<ConfigPlan>) => {
  render(() => ConfigEditor({ view: () => view, error: () => undefined, preview }) as unknown as Node, document.body)
}

const clickPreview = async (): Promise<void> => {
  const buttons = [...document.body.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Preview"),
  )
  expect(buttons).toHaveLength(1)
  buttons[0]!.click()
  await Bun.sleep(0)
}

describe("config editor", () => {
  test("it shows the current layers, hashes and the terminal-only note", async () => {
    setup()
    show(async () => {
      throw new Error("must not preview without a click")
    })
    const text = document.body.textContent ?? ""
    expect(text).toContain("MIT")
    expect(text).toContain("oldhash-config")
    expect(text).toMatch(/terminal/i)
    // The other tab previews the other file.
    const tabs = [...document.body.querySelectorAll("button")].filter((button) =>
      ["Project config", "Gates"].includes(button.textContent ?? ""),
    )
    tabs[1]!.click()
    await Bun.sleep(0)
    expect(document.body.textContent).toContain("topN")
    // Preview-only: there is no apply button, only preview and copy.
    const labels = [...document.body.querySelectorAll("button")].map((button) => button.textContent ?? "")
    expect(labels.some((label) => /apply|submit|save/i.test(label))).toBe(false)
  })

  test("a valid preview shows the exact hash diff, changed keys and commands", async () => {
    setup()
    show(async (_file, _content) => ({
      ok: true,
      errors: [],
      oldHash: view.configHash,
      newHash: "newhash-config-00000000000000000000000000000009",
      changedKeys: ["licenseWhitelist"],
      commands: ['es config set licenseWhitelist ["MIT","Apache-2.0"]'],
    }))
    await clickPreview()
    const text = document.body.textContent ?? ""
    expect(text).toContain("oldhash-config")
    expect(text).toContain("newhash-config")
    expect(text).toContain("licenseWhitelist")
    expect(text).toContain('es config set licenseWhitelist ["MIT","Apache-2.0"]')
    expect(document.body.querySelector("button.copy")).not.toBeNull()
  })

  test("schema errors render inline with no commands", async () => {
    setup()
    show(async () => ({
      ok: false,
      errors: ["noSuchKey: Unrecognized key"],
      oldHash: view.configHash,
      newHash: null,
      changedKeys: [],
      commands: [],
    }))
    await clickPreview()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("noSuchKey")
    expect(document.body.textContent).not.toContain("es config set")
  })

  test("drift violations render a rebaseline warning", () => {
    setup()
    const dirty: ConfigView = {
      ...view,
      drift: {
        clean: false,
        violations: [".factory/config.json changed (expected abc, found def)"],
        hasBaseline: true,
      },
    }
    render(
      () =>
        ConfigEditor({
          view: () => dirty,
          error: () => undefined,
          preview: async () => {
            throw new Error("unreachable")
          },
        }) as unknown as Node,
      document.body,
    )
    const text = document.body.textContent ?? ""
    expect(text).toMatch(/drift/i)
    expect(text).toContain("es rebaseline")
  })

  test("switching tabs previews the other file", async () => {
    setup()
    const seen: string[] = []
    show(async (file, _content) => {
      seen.push(file)
      return { ok: true, errors: [], oldHash: "a", newHash: "a", changedKeys: [], commands: [] }
    })
    const tabs = [...document.body.querySelectorAll("button")].filter((button) =>
      ["Project config", "Gates"].includes(button.textContent ?? ""),
    )
    expect(tabs).toHaveLength(2)
    tabs[1]!.click()
    await clickPreview()
    expect(seen).toEqual(["gates"])
  })

  test("the edited text, not the displayed layer, is what gets previewed", async () => {
    setup()
    let received: unknown
    show(async (_file, content) => {
      received = content
      return { ok: true, errors: [], oldHash: "a", newHash: "b", changedKeys: ["licenseWhitelist"], commands: [] }
    })
    const area = document.body.querySelector("textarea")
    expect(area).not.toBeNull()
    // Preview reads the live DOM value (no input handler to drive).
    area!.value = JSON.stringify({ licenseWhitelist: ["MIT", "ISC"] })
    await clickPreview()
    expect(received).toEqual({ licenseWhitelist: ["MIT", "ISC"] })
  })
})

describe("config editor input handling", () => {
  test("unparseable JSON reports a local error without calling preview", async () => {
    setup()
    let calls = 0
    show(async () => {
      calls += 1
      return { ok: true, errors: [], oldHash: "a", newHash: "a", changedKeys: [], commands: [] }
    })
    const area = document.body.querySelector("textarea")
    expect(area).not.toBeNull()
    area!.value = "{ not json"
    await clickPreview()
    expect(calls).toBe(0)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/json/i)
  })
})
