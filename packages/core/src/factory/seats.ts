// Seat liveness (1.1.3, #60): which factory seats (host subagent sessions)
// are running, when each last did something, and how each ended. The
// plugin's seat tracker writes it from host session events; `es status`,
// `es_status`, the dashboard and the headless driver read it. Advisory only:
// nothing is gated on it, so it carries no seal (it lives under runtime/, a
// control path agents cannot write).
import { z } from "zod"
import { factoryLayout } from "../layout.ts"
import { readJson, withLock, writeJson } from "../util/fs.ts"

export const SeatStateSchema = z.enum(["running", "completed", "failed", "interrupted"])
export type SeatState = z.infer<typeof SeatStateSchema>

export const SeatRecordSchema = z.object({
  sessionID: z.string().min(1),
  agent: z.string().min(1),
  parentID: z.string().optional(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  /** The last tool the seat called. */
  lastTool: z.string().optional(),
  state: SeatStateSchema,
  endedAt: z.string().optional(),
})
export type SeatRecord = z.infer<typeof SeatRecordSchema>

export const SeatsFileSchema = z.object({ runId: z.string(), seats: z.array(SeatRecordSchema) })

/** The file keeps the newest records only. */
export const MAX_SEAT_RECORDS = 30

/** The run's seat records, oldest first; empty for another run or an unreadable file. */
export async function readSeats(root: string, runId: string | undefined): Promise<SeatRecord[]> {
  if (!runId) return []
  const parsed = SeatsFileSchema.safeParse(await readJson(factoryLayout(root).seats).catch(() => undefined))
  return parsed.success && parsed.data.runId === runId ? parsed.data.seats : []
}

/**
 * Load-modify-save the run's seat records under the file lock. Records from
 * another run are dropped first, and only the newest MAX_SEAT_RECORDS kept.
 */
export async function updateSeats(
  root: string,
  runId: string,
  fn: (seats: SeatRecord[]) => void,
): Promise<SeatRecord[]> {
  const file = factoryLayout(root).seats
  return withLock(file, async () => {
    const seats = await readSeats(root, runId)
    fn(seats)
    const kept = seats.slice(-MAX_SEAT_RECORDS)
    await writeJson(file, { runId, seats: kept })
    return kept
  })
}
