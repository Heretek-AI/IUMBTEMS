// Hello page (#129): proves the ticket → cookie → RPC loop end to end by
// rendering `fleet.status`. Ticket #130 grows this into the fleet
// dashboard; the passphrase never appears on any page (see #131).
import { createResource, For, Match, Show, Switch } from "solid-js"
import { render } from "solid-js/web"
import { fetchStatus, type RpcError } from "./api.ts"

function Status() {
  const [snapshot] = createResource(fetchStatus)
  return (
    <Switch>
      <Match when={snapshot.error !== undefined}>
        <p role="alert">The bus refused the call: {(snapshot.error as RpcError).message}</p>
      </Match>
      <Match when={snapshot.loading}>
        <p>Asking the daemon…</p>
      </Match>
      <Match when={snapshot() !== undefined}>
        <Show when={snapshot()!.daemon.running} fallback={<p>The fleet is stopped. Start it with `es-fleet start`.</p>}>
          <p>
            Fleet ceiling ${snapshot()!.daemon.maxUsd} · spend ${snapshot()!.spendUsd.toFixed(2)} ·{" "}
            {snapshot()!.tasks.length} task(s)
          </p>
          <ul>
            <For each={snapshot()!.tasks}>
              {(task) => (
                <li>
                  {task.id} — {task.status} — ${task.spendUsd.toFixed(2)} of ${task.ceilingUSD.toFixed(2)}
                </li>
              )}
            </For>
          </ul>
          <Show when={snapshot()!.pending.length > 0}>
            <p>
              Waiting on you:{" "}
              {snapshot()!
                .pending.map((item) => item.taskId)
                .join(", ")}
            </p>
          </Show>
        </Show>
      </Match>
    </Switch>
  )
}

function App() {
  return (
    <main>
      <h1>Epistemic Swarm</h1>
      <Status />
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")
render(App, root)
