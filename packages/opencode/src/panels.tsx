// The four TUI panels: factory dashboard, LSP manager, hook inspector and
// brainstorm board. Each is a session.panel slot contribution (the host
// renders the one whose name is open) and reads structured state from the
// server plugin over RPC — the same human-only channel the dialogs use.
import { createResource, For, Show } from "solid-js"

export type PanelCall = (method: string, input?: unknown) => Promise<any>

const Frame = (props: { title: string; children?: any }) => (
  <box flexDirection="column" padding={1} gap={1}>
    <text>{props.title}</text>
    {props.children}
  </box>
)

const FactoryPanel = (props: { call: PanelCall }) => {
  const [state] = createResource(() => props.call("factoryState"))
  return (
    <Frame title="Factory dashboard">
      <Show when={state()} fallback={<text>Loading factory state…</text>}>
        {(data: () => any) => (
          <>
            <text>
              Stage: {data().stage}
              {data().runId ? ` · ${data().runId}` : ""}
            </text>
            <text>
              Spend: ${data().spend.usd.toFixed(2)}
              {data().spend.ceilingUSD ? ` / $${data().spend.ceilingUSD}` : ""}
              {data().spend.estimated ? " (estimated)" : ""}
            </text>
            <Show when={data().halt}>
              <text>HALTED: {data().halt}</text>
            </Show>
            <Show when={data().release}>
              <text>PR: {data().release}</text>
            </Show>
            <Show when={data().pending.length}>
              <text>Waiting on human: {data().pending.join(", ")}</text>
            </Show>
            <text>Phases:</text>
            <For each={data().phases}>
              {(phase: any) => (
                <text>
                  {phase.id === data().activePhase ? "▶ " : "  "}
                  {phase.id} · {phase.status} · failures {phase.failures}
                </text>
              )}
            </For>
          </>
        )}
      </Show>
    </Frame>
  )
}

const LspPanel = (props: { call: PanelCall }) => {
  const [state] = createResource(() => props.call("lspState"))
  return (
    <Frame title="Language servers">
      <Show when={state()} fallback={<text>Loading language servers…</text>}>
        {(data: () => any) => (
          <>
            <text>{data().enabled ? "LSP is on." : "LSP is disabled (lsp: false)."}</text>
            <For each={data().servers}>
              {(server: any) => (
                <text>
                  {server.available ? "●" : "○"} {server.id} [{server.extensions.join(" ")}]
                  {server.running ? ` · ${server.running} running` : ""}
                  {server.available ? "" : " — not installed"}
                </text>
              )}
            </For>
            <For each={data().diagnostics}>{(diagnostic: string) => <text>! {diagnostic}</text>}</For>
          </>
        )}
      </Show>
    </Frame>
  )
}

const HooksPanel = (props: { call: PanelCall }) => {
  const [state] = createResource(() => props.call("hooksState"))
  return (
    <Frame title="Hook bridge">
      <Show when={state()} fallback={<text>Loading hooks…</text>}>
        {(data: () => any) => (
          <>
            <text>
              {data().handlers} handler(s) · {data().projectHandlers} from the project ·{" "}
              {data().projectHandlers === 0 ? "nothing to trust" : data().trusted ? "trusted" : "NOT trusted"}
            </text>
            <For each={data().projectLines}>{(line: string) => <text>{line}</text>}</For>
            <Show when={data().loss.length}>
              <text>Capability loss (advisory rows):</text>
              <For each={data().loss}>
                {(item: any) => (
                  <text>
                    ! {item.event} · {item.handler} — {item.support}: {item.reason}
                  </text>
                )}
              </For>
            </Show>
            <For each={data().diagnostics}>{(item: string) => <text>! {item}</text>}</For>
            <For each={data().recent}>{(item: string) => <text>recent error: {item}</text>}</For>
          </>
        )}
      </Show>
    </Frame>
  )
}

const BrainstormPanel = (props: { call: PanelCall }) => {
  const [state] = createResource(() => props.call("brainstormState"))
  return (
    <Frame title="Brainstorm board">
      <Show when={state()} fallback={<text>Loading brainstorm…</text>}>
        {(data: () => any) => (
          <Show when={data().active} fallback={<text>No brainstorm in .factory/brainstorm yet. Run /brainstorm.</text>}>
            <text>Brief: {data().brief}</text>
            <text>
              {data().ideas} idea(s) · {data().duplicates} duplicate(s) · {data().scored} scored ·{" "}
              {data().complete ? "complete" : "in progress"}
            </text>
            <text>
              Coverage:{" "}
              {data()
                .lenses.map((lens: string) => `${lens} ${data().coverage[lens] ?? 0}`)
                .join(" · ")}
            </text>
            <Show when={data().gaps.length}>
              <text>Gaps: {data().gaps.join(", ")}</text>
            </Show>
            <Show when={data().shortlist.length}>
              <text>Shortlist:</text>
              <For each={data().shortlist}>
                {(entry: any) => (
                  <text>
                    {entry.outlier ? "◇" : "◆"} {entry.id} ({entry.total}/20) — {entry.title}
                    {entry.outlier ? " (forced outlier)" : ""}
                  </text>
                )}
              </For>
            </Show>
          </Show>
        )}
      </Show>
    </Frame>
  )
}

const PANELS: ReadonlyArray<{ name: string; render: (call: PanelCall) => any }> = [
  { name: "factory", render: (call) => <FactoryPanel call={call} /> },
  { name: "lsp", render: (call) => <LspPanel call={call} /> },
  { name: "hooks", render: (call) => <HooksPanel call={call} /> },
  { name: "brainstorm", render: (call) => <BrainstormPanel call={call} /> },
]

/** Claim the session.panel slot once per panel; each claim filters by name. */
export function registerPanels(context: any, call: PanelCall): () => void {
  const disposers = PANELS.map((panel) =>
    context.slot({
      append: "session.panel",
      render: (input: { name: string }) => (input.name === panel.name ? panel.render(call) : null),
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export const PANEL_NAMES = PANELS.map((panel) => panel.name)
