// Dashboard app (#130): hash-routed fleet overview and task pages over the
// read-only bus. No mutation paths exist in this ticket's code: the only
// requests are `fleet.status` / `fleet.task` and the WS subscribe.
// Approving (pending items link to their task page) arrives with #131;
// editing config with #132.

import type { BusEvent, FleetSnapshot } from "@heretek-ai/es-fleet"
import { createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { fetchStatus, fetchTask, RpcError } from "./api.ts"
import { connectBus } from "./bus.ts"
import { Overview, TaskDetail } from "./components.ts"
import { h } from "./dom.ts"
import { createFleetStore } from "./store.ts"

type Route = { name: "overview" } | { name: "task"; id: string }

const routeOf = (hash: string): Route => {
  const task = /^#\/task\/([^/]+)$/.exec(hash)
  return task?.[1] ? { name: "task", id: decodeURIComponent(task[1]) } : { name: "overview" }
}

function App(): Element {
  const store = createFleetStore()
  const [route, setRoute] = createSignal<Route>(routeOf(window.location.hash))
  const [task, setTask] = createSignal<FleetSnapshot["tasks"][number] | undefined>(undefined)
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

  return h("div", null, () => {
    const current = route()
    if (current.name === "task") {
      return TaskDetail({
        task: () => (route().name === "task" ? task() : undefined),
        events: () => store.state.events,
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
