// Fleet store (#130): the dashboard's reactive state. A snapshot or any
// event counts as data (clears the stale flag); the event tail is bounded
// and reordered/duplicated deliveries are dropped by sequence number.

import type { BusEvent, FleetSnapshot } from "@heretek-ai/es-fleet"
import { createStore } from "solid-js/store"

/** Without data for this long, the UI shows the stale banner. */
export const STALE_AFTER_MS = 5_000
/** Recent-event tail per view (the bus replays the full backlog on demand). */
export const MAX_EVENTS = 50

export interface FleetStoreOptions {
  readonly now?: () => number
}

export interface FleetStore {
  readonly state: {
    readonly snapshot: FleetSnapshot | undefined
    readonly events: readonly BusEvent[]
  }
  setSnapshot(snapshot: FleetSnapshot): void
  pushEvent(event: BusEvent): void
  isStale(at?: number): boolean
}

const wellFormed = (event: BusEvent): boolean =>
  Number.isInteger(event.seq) &&
  event.seq > 0 &&
  typeof event.at === "string" &&
  (event.type === "changed" || event.type === "liveness") &&
  typeof event.payload === "object" &&
  event.payload !== null

export function createFleetStore(options: FleetStoreOptions = {}): FleetStore {
  const now = options.now ?? (() => Date.now())
  const [state, setState] = createStore<{ snapshot: FleetSnapshot | undefined; events: BusEvent[]; lastSync: number }>({
    snapshot: undefined,
    events: [],
    lastSync: now(),
  })
  return {
    state,
    setSnapshot: (snapshot) => setState({ snapshot, lastSync: now() }),
    pushEvent: (event) => {
      if (!wellFormed(event)) return
      const tip = state.events.at(-1)?.seq ?? 0
      if (event.seq <= tip) return
      setState({ events: [...state.events, event].slice(-MAX_EVENTS), lastSync: now() })
    },
    isStale: (at) => (at ?? now()) - state.lastSync > STALE_AFTER_MS,
  }
}
