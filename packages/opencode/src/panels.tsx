// The four TUI panels: factory dashboard, LSP manager, hook inspector and
// brainstorm board. Each is a session.panel slot contribution (the host
// renders the one whose name is open) and reads structured state from the
// server plugin over RPC — the same human-only channel the dialogs use. While
// open, a panel refetches on every server `changed` event and every couple of
// seconds, so it follows a running factory.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"

export type PanelCall = (method: string, input?: unknown) => Promise<any>
/** Subscribe to server state changes; returns the unsubscribe function. */
export type PanelSubscribe = (listener: () => void) => () => void

export interface PanelProps {
  readonly call: PanelCall
  readonly subscribe: PanelSubscribe
}

export const PANEL_REFRESH_MS = 2_000

/** Panel data, refetched on change events and on an interval while mounted. */
function usePanelState(props: PanelProps, method: string): { data: () => any; error: () => string | undefined } {
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)
  const unsubscribe = props.subscribe(bump)
  const timer = setInterval(bump, PANEL_REFRESH_MS)
  onCleanup(() => {
    unsubscribe()
    clearInterval(timer)
  })
  const [state] = createResource(
    version,
    (): Promise<{ data?: any; error?: string }> =>
      props.call(method).then(
        (data) => ({ data }),
        (error: any) => ({ error: String(error?.data?.reason ?? error?.message ?? error) }),
      ),
  )
  return { data: () => state.latest?.data, error: () => state.latest?.error }
}

const Frame = (props: { title: string; children?: any }) => (
  <box flexDirection="column" padding={1} gap={1}>
    <text>{props.title}</text>
    {props.children}
  </box>
)

const Failed = (props: { error: () => string | undefined }) => (
  <Show when={props.error()}>
    <text>Could not load: {props.error()}</text>
  </Show>
)

const FactoryPanel = (props: PanelProps) => {
  const state = usePanelState(props, "factoryState")
  return (
    <Frame title="Factory dashboard">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading factory state…"}</text>}>
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

const LspPanel = (props: PanelProps) => {
  const state = usePanelState(props, "lspState")
  return (
    <Frame title="Language servers">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading language servers…"}</text>}>
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

const HooksPanel = (props: PanelProps) => {
  const state = usePanelState(props, "hooksState")
  return (
    <Frame title="Hook bridge">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading hooks…"}</text>}>
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

const BrainstormPanel = (props: PanelProps) => {
  const state = usePanelState(props, "brainstormState")
  return (
    <Frame title="Brainstorm board">
      <Failed error={state.error} />
      <Show when={state.data()} fallback={<text>{state.error() ? "" : "Loading brainstorm…"}</text>}>
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

/** The panel components by panel name (rendered headlessly in tests). */
export const PANEL_COMPONENTS: Readonly<Record<string, (props: PanelProps) => any>> = {
  factory: FactoryPanel,
  lsp: LspPanel,
  hooks: HooksPanel,
  brainstorm: BrainstormPanel,
}

const PANELS = Object.entries(PANEL_COMPONENTS).map(([name, Panel]) => ({
  name,
  render: (props: PanelProps) => <Panel call={props.call} subscribe={props.subscribe} />,
}))

/** Claim the session.panel slot once per panel; each claim filters by name. */
export function registerPanels(context: any, call: PanelCall, subscribe: PanelSubscribe): () => void {
  // Slot entry point moved across host releases: opencode 2.0.x exposes it
  // as context.ui.slot (arity 1 object form or arity 2 name/render form),
  // later hosts as bare context.slot. Without either, panels stay
  // unregistered but setup must not throw (commands keep working).
  const slotFn = typeof context.slot === "function" ? context.slot : context.ui?.slot
  if (typeof slotFn !== "function") return () => {}
  const disposers: Array<() => void> = []
  for (const panel of PANELS) {
    const render = (input: { name: string }) => (input.name === panel.name ? panel.render({ call, subscribe }) : null)
    const dispose = slotFn.length <= 1 ? slotFn({ append: "session.panel", render }) : slotFn("session.panel", render)
    if (typeof dispose === "function") disposers.push(dispose)
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export const PANEL_NAMES = PANELS.map((panel) => panel.name)
