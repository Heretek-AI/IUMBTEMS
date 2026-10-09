// Dashboard components (#130): overview and task pages over fixture data.
// Rendered with the client Solid build under happy-dom; assertions read the
// live DOM, including one reactive update (the WS re-render path) and one
// hostile-content probe (model output is never raw HTML).
import { describe, expect, test } from "bun:test"
import type { FleetSnapshot } from "@heretek-ai/es-fleet"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Overview, TaskDetail } from "./components.ts"
import { installDom } from "./test-dom.ts"

const setup = () => void installDom()

type Task = FleetSnapshot["tasks"][number]

const task = (id: string, status: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status,
  ceilingUSD: 5,
  spendUsd: 1,
  deps: [],
  ...extra,
})

const snapshot = (extra: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
  tasks: [
    task("a", "running", { spendUsd: 1.5, reason: "building the UI" }),
    task("b", "waiting-human", { spendUsd: 0.25, deps: ["a"], reason: "frontier approval" }),
  ],
  spendUsd: 1.75,
  pending: [{ taskId: "b", reason: "frontier approval" }],
  ...extra,
})

const show = (node: Element): void => {
  render(() => node, document.body)
}

describe("overview", () => {
  test("it renders the headline, dag, table, spend and pending list", () => {
    setup()
    const snap = snapshot()
    show(Overview({ snapshot: () => snap, stale: () => false, error: () => undefined }))
    const text = document.body.textContent ?? ""
    expect(text).toContain("Task a")
    expect(text).toContain("working")
    expect(text).toContain("waiting on you")
    expect(text).toContain("$1.75 / $50")
    expect(text).toContain("frontier approval")
    // The DAG draws both nodes and the a→b edge.
    expect(document.body.querySelectorAll("svg .dag-node")).toHaveLength(2)
    expect(document.body.querySelectorAll("svg line.dag-edge")).toHaveLength(1)
    // Keyboard path: every task is a link to its detail page.
    expect(document.body.querySelector('a[href="#/task/a"]')).not.toBeNull()
    expect(document.body.querySelector('a[href="#/task/b"]')).not.toBeNull()
  })

  test("it renders every status in words", () => {
    setup()
    const statuses = ["pending", "ready", "running", "waiting-human", "done", "failed", "cancelled"]
    const snap = snapshot({ tasks: statuses.map((status, index) => task(`t${index}`, status)) })
    show(Overview({ snapshot: () => snap, stale: () => false, error: () => undefined }))
    const text = document.body.textContent ?? ""
    for (const word of ["queued", "ready", "working", "waiting on you", "done", "failed", "cancelled"])
      expect(text).toContain(word)
  })

  test("an empty fleet, the stale banner and errors all render", () => {
    setup()
    const empty = snapshot({ tasks: [], spendUsd: 0, pending: [] })
    show(Overview({ snapshot: () => empty, stale: () => false, error: () => undefined }))
    expect(document.body.textContent).toContain("No tasks yet")
    expect(document.body.querySelector("svg")).toBeNull()

    document.body.innerHTML = ""
    show(Overview({ snapshot: () => empty, stale: () => true, error: () => undefined }))
    const banner = document.body.querySelector('[role="status"]')
    expect(banner?.textContent).toMatch(/stale/i)

    document.body.innerHTML = ""
    show(Overview({ snapshot: () => undefined, stale: () => false, error: () => "boom" }))
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("boom")
  })

  test("a snapshot update re-renders the right node (the WS path)", async () => {
    setup()
    const [snap, setSnap] = createSignal(snapshot())
    show(Overview({ snapshot: () => snap(), stale: () => false, error: () => undefined }))
    expect(document.body.textContent).toContain("working")
    setSnap(snapshot({ tasks: [task("a", "done", { spendUsd: 2 }), task("b", "running", { deps: ["a"] })] }))
    await Bun.sleep(0)
    expect(document.body.textContent).toContain("done")
    expect(document.body.querySelectorAll("svg .dag-node")).toHaveLength(2)
  })

  test("hostile task text renders as text, never as markup", () => {
    setup()
    const evil = task("e", "running", {
      title: "<script>alert(1)</script>",
      reason: "<img src=x onerror=alert(1)>",
    })
    show(
      Overview({
        snapshot: () => snapshot({ tasks: [evil] }),
        stale: () => false,
        error: () => undefined,
      }),
    )
    expect(document.body.querySelector("script")).toBeNull()
    expect(document.body.querySelectorAll("img")).toHaveLength(0)
    expect(document.body.textContent).toContain("<script>alert(1)</script>")
  })
})

describe("task detail", () => {
  const events = [
    { seq: 1, at: "2026-10-09T12:00:00.000Z", type: "changed", payload: { taskId: "a", kind: "started" } },
    { seq: 2, at: "2026-10-09T12:01:00.000Z", type: "changed", payload: { taskId: "b", kind: "report" } },
  ] as const

  test("it shows the task, its spend, deps and only its own events", () => {
    setup()
    const found = task("a", "running", { spendUsd: 1.5, reason: "building the UI" })
    show(TaskDetail({ task: () => found, events: () => events }))
    const text = document.body.textContent ?? ""
    expect(text).toContain("Task a")
    expect(text).toContain("working")
    expect(text).toContain("$1.50 of $5.00")
    expect(text).toContain("building the UI")
    expect(text).toContain("started")
    expect(text).not.toContain("report")
    expect(document.body.querySelector('a[href="#/"]')).not.toBeNull()
  })

  test("an unknown task renders plainly", () => {
    setup()
    show(TaskDetail({ task: () => undefined, events: () => [] }))
    expect(document.body.textContent).toMatch(/unknown task/i)
  })
})
