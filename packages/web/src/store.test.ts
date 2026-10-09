// Fleet store (#130): snapshot state, recent-event tail, and the stale
// flag (5 s without data). Time is injected so the stale logic is
// deterministic without timers.
import { describe, expect, test } from "bun:test"
import type { BusEvent, FleetSnapshot } from "@heretek-ai/es-fleet"
import { createRoot } from "solid-js"
import { createFleetStore, MAX_EVENTS, STALE_AFTER_MS } from "./store.ts"

const snapshot = (extra: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  daemon: { running: true, pid: 7, maxUsd: 50, concurrency: 2 },
  tasks: [],
  spendUsd: 0,
  pending: [],
  ...extra,
})

const event = (seq: number): BusEvent => ({
  seq,
  at: "2026-10-09T12:00:00.000Z",
  type: "changed",
  payload: { taskId: "a", kind: "started" },
})

describe("fleet store", () => {
  test("it starts empty and fresh", () => {
    createRoot((dispose) => {
      const store = createFleetStore({ now: () => 1_000 })
      expect(store.state.snapshot).toBeUndefined()
      expect(store.state.events).toEqual([])
      expect(store.isStale()).toBe(false)
      dispose()
    })
  })

  test("setting a snapshot clears the stale flag", () => {
    createRoot((dispose) => {
      let now = 1_000
      const store = createFleetStore({ now: () => now })
      store.setSnapshot(snapshot())
      expect(store.isStale()).toBe(false)
      now += STALE_AFTER_MS + 1
      expect(store.isStale()).toBe(true)
      store.setSnapshot(snapshot({ spendUsd: 3 }))
      expect(store.isStale()).toBe(false)
      expect(store.state.snapshot?.spendUsd).toBe(3)
      dispose()
    })
  })

  test("events append in order and the tail is bounded", () => {
    createRoot((dispose) => {
      const store = createFleetStore({ now: () => 1_000 })
      for (let seq = 1; seq <= MAX_EVENTS + 5; seq++) store.pushEvent(event(seq))
      expect(store.state.events).toHaveLength(MAX_EVENTS)
      expect(store.state.events[0]!.seq).toBe(6)
      expect(store.state.events.at(-1)!.seq).toBe(MAX_EVENTS + 5)
      // An event is data too: it clears the stale flag.
      expect(store.isStale()).toBe(false)
      dispose()
    })
  })

  test("stale events (seq at or below the known tip) are dropped", () => {
    createRoot((dispose) => {
      const store = createFleetStore({ now: () => 1_000 })
      store.pushEvent(event(2))
      store.pushEvent(event(2))
      store.pushEvent(event(1))
      expect(store.state.events.map((entry) => entry.seq)).toEqual([2])
      dispose()
    })
  })
})
