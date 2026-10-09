// Fleet package entrypoint (#122): daemon lifecycle, state, and (from later
// tickets) the scheduler, worktree coordinator, workers and telemetry bus.
export { VERSION } from "./bin.ts"
export {
  assertHumanStart,
  FleetError,
  type FleetHandle,
  type FleetStatus,
  fleetStatus,
  isPidAlive,
  type StartOptions,
  startFleet,
  stopFleet,
} from "./lifecycle.ts"
export { acquireSocket, SocketBusyError, type SocketGuard } from "./socket-guard.ts"
export {
  FLEET_STATE_VERSION,
  type FleetPaths,
  type FleetState,
  FleetStateSchema,
  fleetDir,
  fleetPaths,
  persistFleetState,
  readFleetState,
  stoppedState,
  writeFleetState,
} from "./state.ts"
