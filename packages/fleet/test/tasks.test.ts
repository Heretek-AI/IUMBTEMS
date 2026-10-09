// Task model and DAG validation (#123): unknown deps, self-deps and cycles
// are rejected on add; ids are deterministic.
import { describe, expect, test } from "bun:test"
import { addTask, emptyDag, TaskSchema, validateDag } from "../src/tasks.ts"

const STAMP = "2026-10-09T12:00:00.000Z"
const task = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  kind: "factory-run" as const,
  deps,
  input: { objective: `do ${id}` },
  ceilingUSD: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
})

describe("task schema", () => {
  test("defaults: all_success trigger, fail policy, pending status, zero attempts", () => {
    const parsed = TaskSchema.parse(task("a"))
    expect(parsed.trigger).toBe("all_success")
    expect(parsed.policy).toEqual({ strategy: "fail" })
    expect(parsed.status).toBe("pending")
    expect(parsed.attempts).toBe(0)
  })

  test("bad ids, empty titles and non-positive ceilings are rejected", () => {
    expect(() => TaskSchema.parse(task("Bad ID!"))).toThrow()
    expect(() => TaskSchema.parse(task("a", [], { title: "" }))).toThrow()
    expect(() => TaskSchema.parse(task("a", [], { ceilingUSD: 0 }))).toThrow()
    expect(() => TaskSchema.parse(task("a", [], { ceilingUSD: -1 }))).toThrow()
  })
})

describe("DAG validation", () => {
  test("unknown deps and self-deps are rejected", () => {
    expect(() => validateDag({ v: 1, tasks: { a: TaskSchema.parse(task("a", ["ghost"])) } })).toThrow(/ghost/)
    expect(() => validateDag({ v: 1, tasks: { a: TaskSchema.parse(task("a", ["a"])) } })).toThrow()
  })

  test("cycles are rejected, however long", () => {
    const two = {
      v: 1 as const,
      tasks: { a: TaskSchema.parse(task("a", ["b"])), b: TaskSchema.parse(task("b", ["a"])) },
    }
    expect(() => validateDag(two)).toThrow(/cycle/i)
    const three = {
      v: 1 as const,
      tasks: {
        a: TaskSchema.parse(task("a", ["c"])),
        b: TaskSchema.parse(task("b", ["a"])),
        c: TaskSchema.parse(task("c", ["b"])),
      },
    }
    expect(() => validateDag(three)).toThrow(/cycle/i)
  })

  test("a diamond validates", () => {
    const dag = {
      v: 1 as const,
      tasks: {
        a: TaskSchema.parse(task("a")),
        b: TaskSchema.parse(task("b", ["a"])),
        c: TaskSchema.parse(task("c", ["a"])),
        d: TaskSchema.parse(task("d", ["b", "c"])),
      },
    }
    expect(() => validateDag(dag)).not.toThrow()
  })

  test("addTask validates the result and refuses duplicate ids", () => {
    let dag = emptyDag()
    dag = addTask(dag, task("a"))
    expect(Object.keys(dag.tasks)).toEqual(["a"])
    expect(() => addTask(dag, task("a"))).toThrow(/duplicate/i)
    expect(() => addTask(dag, task("b", ["ghost"]))).toThrow(/ghost/)
  })
})
