// Dashboard DAG logic (#130, clean-room): the 1.3 status vocabulary in
// words (status is always text, never colour-only) and a columns-by-depth
// node-link layout over the bus snapshot's task deps. Pure: no Solid, no
// DOM, so the layout is unit-tested without a browser.
import type { FleetSnapshot } from "@heretek-ai/es-fleet"

export type Tone = "work" | "wait" | "queue" | "done" | "bad" | "idle"

export interface StatusWord {
  readonly word: string
  readonly tone: Tone
  /** Fill colour for the DAG node; the word is always rendered beside it. */
  readonly colour: string
}

const WORDS: Record<string, StatusWord> = {
  running: { word: "working", tone: "work", colour: "#2f9e6e" },
  "waiting-human": { word: "waiting on you", tone: "wait", colour: "#c07c14" },
  pending: { word: "queued", tone: "queue", colour: "#64748b" },
  ready: { word: "ready", tone: "queue", colour: "#64748b" },
  done: { word: "done", tone: "done", colour: "#3d7a8c" },
  failed: { word: "failed", tone: "bad", colour: "#c0392b" },
  cancelled: { word: "cancelled", tone: "idle", colour: "#8a8a8a" },
}

/** Human words for a bus status; unknown statuses render as their own name. */
export function statusWord(status: string): StatusWord {
  return WORDS[status] ?? { word: status, tone: "idle", colour: "#8a8a8a" }
}

export interface DagNode {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly depth: number
  readonly x: number
  readonly y: number
}

export interface DagEdge {
  readonly from: string
  readonly to: string
}

export interface DagLayout {
  readonly nodes: readonly DagNode[]
  readonly edges: readonly DagEdge[]
  readonly width: number
  readonly height: number
}

const DX = 200
const DY = 72
const PAD = 16

/**
 * Columns by depth: a task sits right of its deepest dep (longest path).
 * Dangling deps are ignored and dependency cycles are cut, so hostile or
 * corrupt snapshots cannot hang the layout.
 */
export function layoutDag(tasks: readonly FleetSnapshot["tasks"][number][]): DagLayout {
  if (tasks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }
  const known = new Set(tasks.map((task) => task.id))
  const depsOf = new Map(tasks.map((task) => [task.id, task.deps.filter((dep) => known.has(dep))]))
  const depth = new Map<string, number>()
  const visit = (id: string, trail: readonly string[]): number => {
    const settled = depth.get(id)
    if (settled !== undefined) return settled
    if (trail.includes(id)) return trail.length // cycle: cut, keep it placed
    const deps = depsOf.get(id) ?? []
    const own = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => visit(dep, [...trail, id]) + 1))
    depth.set(id, own)
    return own
  }
  for (const task of tasks) visit(task.id, [])
  const lanes = new Map<number, number>()
  const nodes: DagNode[] = tasks.map((task) => {
    const taskDepth = depth.get(task.id) ?? 0
    const lane = lanes.get(taskDepth) ?? 0
    lanes.set(taskDepth, lane + 1)
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      depth: taskDepth,
      x: PAD + taskDepth * DX,
      y: PAD + lane * DY,
    }
  })
  const edges: DagEdge[] = []
  for (const task of tasks) for (const dep of depsOf.get(task.id) ?? []) edges.push({ from: dep, to: task.id })
  const width = PAD * 2 + (Math.max(...nodes.map((node) => node.depth)) + 1) * DX
  const height = PAD * 2 + Math.max(...[...lanes.values()]) * DY
  return { nodes, edges, width, height }
}
