// Browser approvals UI (#131, ADR 0002 option b): the approvals list and
// the approve page. The passphrase lives in one local variable between the
// input read and the submit — never in a signal, the store, logs or the
// DOM after submit (I1, probed below). The preview ticket and CSRF token
// stay in the page closure, never in shared state.
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { ApprovePreview, ApproveResult } from "./api.ts"
import { RpcError } from "./api.ts"
import { ApprovalsPage, ApprovePage } from "./approvals.ts"
import { installDom } from "./test-dom.ts"

const setup = () => void installDom()

const preview: ApprovePreview = {
  ticket: "ticket-hex",
  csrf: "csrf-hex",
  subjectHash: "ab".repeat(32),
  summary: ["Idea: A greeting library", "Decisions settled: 1 (0 deferred)"],
  files: [{ path: ".factory/frontier.json", sha256: "cd".repeat(32) }],
  spendCeilingUSD: 25,
  pending: true,
}

describe("approvals page", () => {
  test("it lists every pending pair with links to its approve page", () => {
    setup()
    render(
      () =>
        ApprovalsPage({
          pending: () => [
            { taskId: "t1", reason: "frontier approval", stage: "frontier" },
            { taskId: "t2", reason: "spec approval", stage: "spec" },
          ],
          error: () => undefined,
        }) as unknown as Node,
      document.body,
    )
    expect(document.body.querySelector('a[href="#/approve/t1/frontier"]')).not.toBeNull()
    expect(document.body.querySelector('a[href="#/approve/t2/spec"]')).not.toBeNull()
    expect(document.body.textContent).toContain("frontier approval")
  })

  test("an empty list and errors render plainly", () => {
    setup()
    render(() => ApprovalsPage({ pending: () => [], error: () => undefined }) as unknown as Node, document.body)
    expect(document.body.textContent).toMatch(/nothing waiting/i)
    document.body.innerHTML = ""
    render(() => ApprovalsPage({ pending: () => [], error: () => "boom" }) as unknown as Node, document.body)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("boom")
  })
})

describe("approve page", () => {
  const show = (
    submit: (ticket: string, csrf: string, passphrase: string) => Promise<ApproveResult>,
    load: () => Promise<ApprovePreview> = async () => preview,
  ) => {
    render(
      () => ApprovePage({ taskId: "t1", stage: "frontier", loadPreview: load, submit }) as unknown as Node,
      document.body,
    )
  }

  test("it previews the subject, its hash and files before asking for a passphrase", async () => {
    setup()
    show(async () => {
      throw new Error("must not submit without a click")
    })
    await Bun.sleep(0)
    const text = document.body.textContent ?? ""
    expect(text).toContain("greeting library")
    expect(text).toContain(preview.subjectHash.slice(0, 16))
    expect(text).toContain(".factory/frontier.json")
    const input = document.body.querySelector('input[type="password"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute("autocomplete")).toBe("off")
  })

  test("submit sends the passphrase once, then clears it and keeps no trace (I1)", async () => {
    setup()
    const bodies: Array<{ ticket: string; csrf: string; passphrase: string }> = []
    show(async (ticket, csrf, passphrase) => {
      bodies.push({ ticket, csrf, passphrase })
      return { ok: true, stage: "frontier", alreadyApproved: false, factoryStage: "RESEARCH" }
    })
    await Bun.sleep(0)
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    input!.value = "the-human-passphrase"
    const button = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Approve"),
    )!
    button.click()
    await Bun.sleep(0)
    // Sent exactly once, over the submit call…
    expect(bodies).toEqual([{ ticket: "ticket-hex", csrf: "csrf-hex", passphrase: "the-human-passphrase" }])
    // …then gone: the input is cleared and no DOM or page state holds it.
    expect(input!.value).toBe("")
    expect(document.body.innerHTML).not.toContain("the-human-passphrase")
    expect(document.body.textContent).toContain("RESEARCH")
  })

  test("a wrong passphrase shows the remaining attempts without clearing the preview", async () => {
    setup()
    show(async () => {
      throw new RpcError(403, "wrong passphrase", { remaining: 3 })
    })
    await Bun.sleep(0)
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    input!.value = "nope"
    const button = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Approve"),
    )!
    button.click()
    await Bun.sleep(0)
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toMatch(/3 attempts left/)
    // The preview survives the failure: no re-preview round-trip needed.
    expect(document.body.textContent).toContain("greeting library")
    expect(input!.value).toBe("")
  })

  test("a lockout shows the retry delay", async () => {
    setup()
    show(async () => {
      throw new RpcError(423, "too many wrong passphrases", { retryAfterSec: 420 })
    })
    await Bun.sleep(0)
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement | null
    input!.value = "nope"
    const button = [...document.body.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Approve"),
    )!
    button.click()
    await Bun.sleep(0)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/420/)
  })

  test("a missing preview renders the bus error, never a passphrase prompt", async () => {
    setup()
    show(
      async () => {
        throw new Error("unreachable")
      },
      async () => {
        throw new Error("unknown run")
      },
    )
    await Bun.sleep(0)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("unknown run")
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
  })
})
