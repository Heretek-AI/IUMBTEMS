// Dashboard components (#130, clean-room): fleet overview (DAG + table +
// spend + pending) and task detail, over the read-only bus snapshot. Built
// with the local DOM builders (`dom.ts`, no JSX transform, no runtime
// eval): every dynamic region is an `insert` thunk over accessor props, so
// WS updates re-render without a router or store subscription. Status is
// always words beside a tone class, and every task is a link (the keyboard
// path). Interpolated data goes through text nodes, never HTML parsing
// (probed in components.test.ts): model output is never raw markup.
import type { BusEvent, FleetSnapshot, TaskLiveness } from "@heretek-ai/es-fleet"
import type { ApproveStage } from "./api.ts"
import { layoutDag, statusWord } from "./dag.ts"
import { type Child, h, svgEl } from "./dom.ts"

type Task = FleetSnapshot["tasks"][number]

const money = (value: number): string => `$${value.toFixed(2)}`

const eventKind = (event: BusEvent): string => {
  const kind = (event.payload as Record<string, unknown>).kind
  return typeof kind === "string" ? kind : event.type
}

const NODE_W = 160
const NODE_H = 48

const dagEl = (tasks: readonly Task[]): Element => {
  const dag = layoutDag(tasks)
  const byId = new Map(dag.nodes.map((node) => [node.id, node]))
  return svgEl(
    "svg",
    { width: dag.width, height: dag.height, role: "img", "aria-label": "Task dependency graph" },
    ...dag.edges.map((edge) => {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      return svgEl("line", {
        class: "dag-edge",
        x1: from.x + NODE_W,
        y1: from.y + NODE_H / 2,
        x2: to.x,
        y2: to.y + NODE_H / 2,
        stroke: "#94a3b8",
        "stroke-width": 2,
      })
    }),
    ...dag.nodes.map((node) => {
      const word = statusWord(node.status)
      return svgEl(
        "g",
        { class: "dag-node", transform: `translate(${node.x},${node.y})` },
        svgEl("title", null, `${node.id} — ${node.title}: ${word.word}`),
        svgEl("rect", {
          width: NODE_W,
          height: NODE_H,
          rx: 8,
          fill: word.colour,
          "fill-opacity": 0.18,
          stroke: word.colour,
          "stroke-width": 2,
        }),
        svgEl("text", { x: 10, y: 20, "font-size": 13, "font-weight": "bold" }, `${node.id} — ${node.title}`),
        svgEl("text", { x: 10, y: 38, "font-size": 12 }, word.word),
      )
    }),
  ) as unknown as Element
}

const taskRow = (entry: Task): Element => {
  const word = statusWord(entry.status)
  return h(
    "tr",
    null,
    h("td", null, h("a", { href: `#/task/${entry.id}` }, `${entry.id} — ${entry.title}`)),
    h("td", null, h("span", { class: `tone-${word.tone}`, "aria-hidden": "true" }, "●"), ` ${word.word}`),
    h("td", null, `${money(entry.spendUsd)} of ${money(entry.ceilingUSD)}`),
    h("td", null, entry.reason ?? ""),
  )
}

const tasksEl = (snap: FleetSnapshot): Element => {
  if (snap.tasks.length === 0) return h("p", null, "No tasks yet.")
  return h(
    "div",
    null,
    h("h2", null, "Tasks"),
    dagEl(snap.tasks),
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h("tr", null, h("th", null, "Task"), h("th", null, "Status"), h("th", null, "Spend"), h("th", null, "Detail")),
      ),
      h("tbody", null, ...snap.tasks.map(taskRow)),
    ),
  )
}

const pendingEl = (snap: FleetSnapshot): Child => {
  if (snap.pending.length === 0) return ""
  return h(
    "section",
    null,
    h("h2", null, "Waiting on you"),
    h(
      "ul",
      null,
      ...snap.pending.map((item) =>
        h("li", null, h("a", { href: `#/task/${item.taskId}` }, item.taskId), ` — ${item.reason}`),
      ),
    ),
  )
}

const sectionEl = (snap: FleetSnapshot): Element =>
  h(
    "section",
    null,
    h(
      "p",
      null,
      snap.daemon.running
        ? `Fleet running · spend ${money(snap.spendUsd)} / $${snap.daemon.maxUsd} · ${snap.tasks.length} task(s)`
        : "Fleet stopped.",
    ),
    tasksEl(snap),
    pendingEl(snap),
  )

export interface OverviewProps {
  readonly snapshot: () => FleetSnapshot | undefined
  readonly stale: () => boolean
  readonly error: () => string | undefined
}

export function Overview(props: OverviewProps): Element {
  return h(
    "main",
    null,
    h("h1", null, "Epistemic Swarm"),
    () => (props.error() !== undefined ? h("p", { role: "alert" }, `The bus refused the call: ${props.error()}`) : ""),
    () => (props.stale() ? h("p", { role: "status" }, "Data may be stale — reconnecting…") : ""),
    () => {
      const snap = props.snapshot()
      return snap ? sectionEl(snap) : h("p", null, "Asking the daemon…")
    },
  )
}

export interface TaskDetailProps {
  readonly task: () => Task | undefined
  readonly events: () => readonly BusEvent[]
  /** Stages of this task currently waiting on a human (#131 links). */
  readonly pendingStages?: () => readonly ApproveStage[]
  /** Per-task run liveness from `fleet.task.liveness` (#130, S5 handoff). */
  readonly liveness?: () => TaskLiveness | undefined
}

const livenessEl = (live: TaskLiveness | undefined): Child =>
  h(
    "section",
    null,
    h("h2", null, "Run liveness"),
    live === undefined
      ? h("p", null, "No liveness yet.")
      : h(
          "div",
          null,
          h("p", null, live.headline),
          h("p", null, `Stage ${live.stage}`),
          live.seats.length > 0
            ? h("ul", null, ...live.seats.map((seat) => h("li", null, seat)))
            : h("p", null, "No seats reporting yet."),
          live.research !== undefined ? h("p", null, live.research) : "",
        ),
  )

export function TaskDetail(props: TaskDetailProps): Element {
  return h(
    "main",
    null,
    h("p", null, h("a", { href: "#/" }, "← Fleet"), () => {
      const found = props.task()
      return found ? h("span", null, " · ", h("a", { href: `#/evidence/${found.id}` }, "Evidence")) : ""
    }),
    () => {
      const found = props.task()
      if (!found) return h("p", null, "Unknown task.")
      const word = statusWord(found.status)
      const mine = props.events().filter((event) => (event.payload as Record<string, unknown>).taskId === found.id)
      return h(
        "article",
        null,
        h("h1", null, `${found.id} — ${found.title}`),
        h("p", null, h("span", { class: `tone-${word.tone}`, "aria-hidden": "true" }, "●"), ` ${word.word}`),
        h("p", null, `${money(found.spendUsd)} of ${money(found.ceilingUSD)}`),
        found.reason !== undefined ? h("p", null, found.reason) : "",
        ...(props.pendingStages?.() ?? []).map((stage) =>
          h("p", null, h("a", { href: `#/approve/${found.id}/${stage}` }, `Approve ${stage} in the browser`)),
        ),
        livenessEl(props.liveness?.()),
        found.deps.length > 0
          ? h(
              "section",
              null,
              h("h2", null, "Waits for"),
              h("ul", null, ...found.deps.map((dep) => h("li", null, h("a", { href: `#/task/${dep}` }, dep)))),
            )
          : "",
        h(
          "section",
          null,
          h("h2", null, "Recent events"),
          mine.length > 0
            ? h(
                "ol",
                null,
                ...mine.slice(-10).map((entry) => h("li", null, `#${entry.seq} ${eventKind(entry)} · ${entry.at}`)),
              )
            : h("p", null, "No events yet."),
        ),
      )
    },
  )
}
