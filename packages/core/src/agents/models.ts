// Heterogeneous multi-model policy (#170): the programmer and QA seats must
// not run on the same model provider/family, or they share systematic blind
// spots. Roles are declared by the registry (ROLE_SEATS); this module
// resolves and enforces them. Build initiation (factory machine.ts) and seat
// launch (plugin seats.ts) refuse violations; unset seats are unverified,
// refused only under models.requireDiversity.
import { type ModelRole, ROLE_SEATS } from "./registry.ts"
/** The models.* map as the diversity check reads it (mirrors EsConfig["models"]; kept structural so core never imports the schema layer). */
export interface SeatModelMap {
  readonly fast?: string
  readonly balanced?: string
  readonly deep?: string
  readonly programmer?: string
  readonly qa?: string
  readonly auditor?: string
  readonly agents?: Readonly<Record<string, string>>
  readonly requireDiversity?: boolean
}

/** Provider part of a "provider/model" ref, lower-cased; undefined when malformed (mirrors parseModelRef, which lives in the schema layer to avoid an import cycle). */
export function modelProvider(ref: string): string | undefined {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1 || /\s/.test(ref)) return undefined
  return ref.slice(0, slash).toLowerCase()
}

/** Resolved model ref per seat agent id (agents override > role key > tier; undefined when unset). */
export function resolveSeatModels(models: SeatModelMap | undefined): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = {}
  for (const role of Object.keys(ROLE_SEATS) as ModelRole[]) {
    const { agents, tier } = ROLE_SEATS[role]
    for (const agent of agents) resolved[agent] = models?.agents?.[agent] ?? models?.[role] ?? models?.[tier]
  }
  return resolved
}

export type DiversityStatus = "diverse" | "violation" | "unverified"

export interface DiversityCheck {
  readonly status: DiversityStatus
  /** Resolved ref per seat (undefined when the seat inherits the session default). */
  readonly seats: Record<string, string | undefined>
  readonly detail: string
}

/**
 * Programmer-vs-QA provider diversity. A violation needs both sides resolved
 * to the same provider (any seat pair counts, so splitting QA seats across
 * providers cannot launder a collision). Anything unset is unverified: the
 * session default may serve both sides, which only `requireDiversity` refuses.
 */
export function checkModelDiversity(models: SeatModelMap | undefined): DiversityCheck {
  const seats = resolveSeatModels(models)
  const programmer = ROLE_SEATS.programmer.agents.map((agent) => seats[agent])
  const qa = ROLE_SEATS.qa.agents.map((agent) => seats[agent])
  const providers = (refs: readonly (string | undefined)[]) => {
    const out = new Map<string, string>()
    for (const ref of refs) {
      if (ref === undefined) continue
      const provider = modelProvider(ref)
      if (provider !== undefined) out.set(provider, ref)
    }
    return out
  }
  const programmerProviders = providers(programmer)
  const qaProviders = providers(qa)
  for (const [provider, ref] of programmerProviders) {
    const qaRef = qaProviders.get(provider)
    if (qaRef !== undefined)
      return {
        status: "violation",
        seats,
        detail:
          `programmer and QA resolve to the same model provider "${provider}" (${ref} vs ${qaRef}): shared weights share blind spots. ` +
          `Set models.programmer and models.qa to different providers with \`es config set\`.`,
      }
  }
  if (programmer.some((ref) => ref === undefined) || qa.some((ref) => ref === undefined))
    return {
      status: "unverified",
      seats,
      detail:
        "programmer or QA model is unset (both may inherit the session default): diversity is unproven. Set models.programmer and models.qa, or models.requireDiversity to refuse unverified builds.",
    }
  return { status: "diverse", seats, detail: "programmer and QA resolve to different model providers." }
}

/** Thrown when a build or seat launch would run programmer and QA on shared weights. */
export class ModelDiversityError extends Error {}

/**
 * Refuse shared-weight builds. Violations always throw; unverified configs
 * throw only under requireDiversity (explicit option or models.requireDiversity).
 */
export function assertModelDiversity(
  models: SeatModelMap | undefined,
  options: { requireDiversity?: boolean } = {},
): void {
  const check = checkModelDiversity(models)
  if (check.status === "violation") throw new ModelDiversityError(check.detail)
  if (check.status === "unverified" && (options.requireDiversity ?? models?.requireDiversity ?? false))
    throw new ModelDiversityError(check.detail)
}
