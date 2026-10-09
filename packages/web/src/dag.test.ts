// Dashboard DAG logic (#130): status vocabulary, columns-by-depth layout,
// edges from deps. Pure: no Solid, no DOM.
import { describe, expect, test } from "bun:test"
import type { FleetSnapshot } from "@heretek-ai/es-fleet"
import { layoutDag, statusWord } from "./dag.ts"

const task = (
  id: string,
  status: string,
  deps: string[] = [],
  extra: Record<string, unknown> = {},
): FleetSnapshot["tasks"][number] => ({
  id,
  title: `Task ${id}`,
  status,
  ceilingUSD: 5,
  spendUsd: 0,
  deps,
  ...extra,
})

describe("status vocabulary (1.3: working, waiting, stuck or done)", () => {
  test("every bus status maps to a human word (text, never colour-only)", () => {
    expect(statusWord("running").word).toBe("working")
    expect(statusWord("waiting-human").word).toBe("waiting on you")
    expect(statusWord("pending").word).toBe("queued")
    expect(statusWord("ready").word).toBe("ready")
    expect(statusWord("done").word).toBe("done")
    expect(statusWord("failed").word).toBe("failed")
    expect(statusWord("cancelled").word).toBe("cancelled")
    for (const status of ["pending", "ready", "running", "waiting-human", "done", "failed", "cancelled"])
      expect(statusWord(status).word.length).toBeGreaterThan(0)
  })

  test("unknown statuses render as their own name (fail-open display)", () => {
    expect(statusWord("mystery").word).toBe("mystery")
  })

  test("every status has a colour distinct from plain text", () => {
    const colours = new Set(
      ["pending", "ready", "running", "waiting-human", "done", "failed", "cancelled"].map(
        (status) => statusWord(status).colour,
      ),
    )
    expect(colours.size).toBeGreaterThan(3)
  })
})

describe("dag layout", () => {
  test("roots sit left, dependents right, edges follow deps", () => {
    const { nodes, edges } = layoutDag([task("a", "done"), task("b", "running", ["a"]), task("c", "queued", ["b"])])
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]))
    expect(byId.a!.depth).toBe(0)
    expect(byId.b!.depth).toBe(1)
    expect(byId.c!.depth).toBe(2)
    expect(byId.a!.x).toBeLessThan(byId.b!.x)
    expect(edges).toContainEqual({ from: "a", to: "b" })
    expect(edges).toContainEqual({ from: "b", to: "c" })
    expect(edges).toHaveLength(2)
  })

  test("diamond deps take the longest path (no node left of its deps)", () => {
    const { nodes } = layoutDag([
      task("a", "done"),
      task("b", "done", ["a"]),
      task("c", "done", ["a"]),
      task("d", "running", ["b", "c"]),
    ])
    const depth = Object.fromEntries(nodes.map((node) => [node.id, node.depth]))
    expect(depth.d).toBe(2)
    expect(
      nodes
        .filter((node) => node.depth === 1)
        .map((node) => node.id)
        .sort(),
    ).toEqual(["b", "c"])
  })

  test("dangling deps and cycles never hang the layout", () => {
    const { nodes, edges } = layoutDag([
      task("a", "running", ["ghost"]),
      task("b", "running", ["c"]),
      task("c", "running", ["b"]),
    ])
    expect(nodes).toHaveLength(3)
    // The ghost dep is not a node, so it draws no edge.
    expect(edges.every((edge) => edge.from !== "ghost")).toBe(true)
  })

  test("an empty fleet lays out to nothing", () => {
    expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})
