// Dashboard app (#130) with the preview-only config editor (#132) and
// browser approvals (#131, ADR 0002 option b): hash-routed fleet overview,
// task, approvals, approve and config pages. The only mutating requests
// are the approval submit (passphrase over loopback, ticket-bound); every
// other request is a read over the bus plus the WS subscribe.

import type { BusEvent, FleetSnapshot } from "@heretek-ai/es-fleet"
import { createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import {
  type ConfigView,
  exportEvidenceDossier,
  fetchApprovePreview,
  fetchConfigView,
  fetchEvidenceClaim,
  fetchEvidenceClaims,
  fetchEvidenceSource,
  fetchStatus,
  fetchTask,
  previewConfigPlan,
  RpcError,
  submitApproval,
} from "./api.ts"
import { ApprovalsPage, ApprovePage } from "./approvals.ts"
import { connectBus } from "./bus.ts"
import { Overview, TaskDetail } from "./components.ts"
import { ConfigEditor } from "./config.ts"
import { h } from "./dom.ts"
import { EvidencePage } from "./evidence.ts"
import { createFleetStore } from "./store.ts"

type Route =
  | { name: "overview" }
  | { name: "task"; id: string }
  | { name: "config" }
  | { name: "approvals" }
  | { name: "approve"; taskId: string; stage: string }
  | { name: "evidence"; runId: string }

const routeOf = (hash: string): Route => {
  if (hash === "#/config") return { name: "config" }
  if (hash === "#/approvals") return { name: "approvals" }
  const evidence = /^#\/evidence\/([^/]+)$/.exec(hash)
  if (evidence?.[1]) return { name: "evidence", runId: decodeURIComponent(evidence[1]) }
  const approve = /^#\/approve\/([^/]+)\/([^/]+)$/.exec(hash)
  if (approve?.[1] && approve?.[2])
    return { name: "approve", taskId: decodeURIComponent(approve[1]), stage: decodeURIComponent(approve[2]) }
  const task = /^#\/task\/([^/]+)$/.exec(hash)
  return task?.[1] ? { name: "task", id: decodeURIComponent(task[1]) } : { name: "overview" }
}

function App(): Element {
  const store = createFleetStore()
  const [route, setRoute] = createSignal<Route>(routeOf(window.location.hash))
  const [task, setTask] = createSignal<FleetSnapshot["tasks"][number] | undefined>(undefined)
  const [configView, setConfigView] = createSignal<ConfigView | undefined>(undefined)
  const [configError, setConfigError] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [tick, setTick] = createSignal(0)

  const refresh = async (): Promise<void> => {
    try {
      const snapshot = await fetchStatus()
      store.setSnapshot(snapshot)
      setError(undefined)
      const current = route()
      if (current.name === "task") {
        try {
          setTask(await fetchTask(current.id))
        } catch {
          setTask(undefined)
        }
      }
      if (current.name === "config") {
        try {
          setConfigView(await fetchConfigView())
          setConfigError(undefined)
        } catch (failure) {
          setConfigError(failure instanceof RpcError ? failure.message : String(failure))
        }
      }
    } catch (failure) {
      setError(failure instanceof RpcError ? failure.message : String(failure))
    }
  }

  const onHash = (): void => {
    setRoute(routeOf(window.location.hash))
    setTask(undefined)
    void refresh()
  }
  window.addEventListener("hashchange", onHash)

  const timer = window.setInterval(() => setTick(tick() + 1), 1_000)
  const disconnect = connectBus({
    url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/fleet/ws`,
    onEvent: (event: BusEvent) => {
      store.pushEvent(event)
      void refresh()
    },
    onConnect: () => {
      void refresh()
    },
  })

  onCleanup(() => {
    window.removeEventListener("hashchange", onHash)
    window.clearInterval(timer)
    disconnect()
  })

  void refresh()

  const nav = h(
    "nav",
    null,
    h("a", { href: "#/" }, "Fleet"),
    " · ",
    h("a", { href: "#/approvals" }, "Approvals"),
    " · ",
    h("a", { href: "#/config" }, "Config"),
  )

  return h("div", null, nav, () => {
    const current = route()
    if (current.name === "task") {
      return TaskDetail({
        task: () => (route().name === "task" ? task() : undefined),
        events: () => store.state.events,
        pendingStages: () =>
          (store.state.snapshot?.pending ?? [])
            .filter((item) => route().name === "task" && item.taskId === (route() as { id: string }).id)
            .map((item) => item.stage),
      })
    }
    if (current.name === "approve") {
      const { taskId, stage } = current
      return ApprovePage({
        taskId,
        stage,
        loadPreview: () => fetchApprovePreview(taskId, stage),
        submit: (ticket, csrf, passphrase) => submitApproval(ticket, csrf, passphrase),
      })
    }
    if (current.name === "approvals") {
      return ApprovalsPage({
        pending: () => store.state.snapshot?.pending ?? [],
        error: () => error(),
      })
    }
    if (current.name === "evidence") {
      const { runId } = current
      return EvidencePage({
        runId,
        loadClaims: (filter) => fetchEvidenceClaims(runId, filter),
        loadClaim: (id) => fetchEvidenceClaim(runId, id),
        loadSource: (sha) => fetchEvidenceSource(runId, sha),
        exportDoc: (format) => exportEvidenceDossier(runId, format),
      })
    }
    if (current.name === "config") {
      return ConfigEditor({
        view: () => configView(),
        error: () => configError(),
        preview: (file, content) => previewConfigPlan(file, content),
      })
    }
    return Overview({
      snapshot: () => store.state.snapshot,
      stale: () => {
        tick()
        return store.isStale()
      },
      error: () => error(),
    })
  })
}

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")
render(App, root)
