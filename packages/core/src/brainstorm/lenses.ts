// The built-in divergent lenses. A lens is a way of thinking, not a topic:
// each one is run by its own fast-tier subagent (es-lens-<id>) so ideas do not
// converge on the orchestrator's frame. The registry is data: packs may add
// lenses, and the plan picks six by default.
import type { BrainstormBrief, BrainstormPlan } from "../schema/brainstorm.ts"

export interface Lens {
  readonly id: string
  readonly name: string
  /** One-line summary (used in agent descriptions and plans). */
  readonly summary: string
  /** What the lens agent must do, in its own words. */
  readonly instruction: string
}

export const LENSES: readonly Lens[] = [
  {
    id: "inversion",
    name: "Inversion",
    summary: "What if the opposite of the core assumption were true?",
    instruction:
      "Take the brief's core assumption and negate it. If the product adds something, imagine it removes it; if it centralizes, imagine it distributes; if it requires an account, imagine it is anonymous. Generate ideas that only make sense under the inverted premise, then note what the inversion teaches even if the idea stays impractical.",
  },
  {
    id: "constraint-removal",
    name: "Constraint removal",
    summary: "Drop the binding constraint and see what becomes possible.",
    instruction:
      "List the brief's strongest constraints (budget, latency, regulation, physics, team size, backward compatibility) and remove one at a time. For each removal, generate the best idea that is impossible today but obvious once the constraint is gone, then say which half of it survives if the constraint returns at a lower strength.",
  },
  {
    id: "scamper",
    name: "SCAMPER",
    summary: "Substitute, combine, adapt, modify, repurpose, eliminate, reverse.",
    instruction:
      "Run the SCAMPER checklist explicitly against the brief: Substitute a component, Combine two capabilities, Adapt a mechanism from elsewhere, Modify or magnify an attribute, Put it to another use, Eliminate a part, Reverse the order or the roles. Produce one concrete idea per prompt that fits the brief's domain; skip prompts that produce nothing worth keeping.",
  },
  {
    id: "cross-domain",
    name: "Cross-domain analogy",
    summary: "Borrow a working mechanism from a different field.",
    instruction:
      "Pick three fields far from the brief's domain (say: logistics, immunology, music, aviation, games, publishing, emergency medicine). For each, name a mechanism that works there, then transplant it: what is the analogous mechanism for this brief, and what would it concretely look like? Prefer mechanisms with a track record over metaphors.",
  },
  {
    id: "extreme-user",
    name: "Extreme user",
    summary: "Design for the most demanding or most unusual user.",
    instruction:
      "Invent three extreme users of the brief's product: a total novice under time pressure, a world expert who hits the ceiling, and an adversarial or non-human user (scraper, auditor, regulator, offline device). What would the product have to do for that user? Convert the requirements into ideas for features or defaults that serve everyone better.",
  },
  {
    id: "scale-shift",
    name: "Scale shift",
    summary: "Shift scale by a thousand times up or down.",
    instruction:
      "Imagine the brief succeeds or shrinks by three orders of magnitude: a thousand times the users/data/requests, or a thousandth. What breaks first at each extreme, and which ideas absorb that shift cheaply? Favor ideas that change the architecture rather than ones that just buy bigger hardware.",
  },
  {
    id: "failure-first",
    name: "Failure first",
    summary: "Assume a catastrophic failure and invent backwards from it.",
    instruction:
      "Assume it is two years from now and the brief's product failed publicly and expensively. Write the three most plausible headlines or postmortems, then invent the mechanism that would have prevented each one. Each prevention is an idea; keep the ones that are cheap to adopt now.",
  },
  {
    id: "adjacent-possible",
    name: "Adjacent possible",
    summary: "Ideas that are one or two years out, not yet mainstream.",
    instruction:
      "Name capabilities that became possible in the last two years and are not yet widely used in this domain (new model abilities, protocols, hardware, pricing shifts, regulations). For each, generate the idea it unlocks for this brief and state the smallest experiment that would show whether it works.",
  },
]

/** Lenses run when none are chosen explicitly. */
export const DEFAULT_LENSES = 6 as const

export const DEFAULT_IDEAS_PER_LENS = 5 as const
export const DEFAULT_MAX_IDEA_CHARS = 600 as const
export const DEFAULT_SHORTLIST_SIZE = 7 as const
export const DEFAULT_DEDUPE_THRESHOLD = 0.5 as const

const byId = new Map(LENSES.map((lens) => [lens.id, lens]))

export const lensById = (id: string): Lens | undefined => byId.get(id)

export interface PlanOptions {
  readonly lenses?: readonly string[]
  readonly ideasPerLens?: number
  readonly shortlistSize?: number
  readonly dedupeThreshold?: number
  readonly maxIdeaChars?: number
  readonly now?: Date
}

export interface PlanBuild {
  readonly lenses: readonly Lens[]
  readonly plan: BrainstormPlan
}

/** Choose the lens set and freeze the caps. Unknown ids throw. */
export function buildPlan(brief: BrainstormBrief, options: PlanOptions = {}): PlanBuild {
  const chosen = options.lenses?.length
    ? [...new Set(options.lenses)]
    : LENSES.slice(0, DEFAULT_LENSES).map((lens) => lens.id)
  const lenses = chosen.map((id) => {
    const lens = lensById(id)
    if (!lens) throw new Error(`unknown lens "${id}" (built-ins: ${LENSES.map((item) => item.id).join(", ")})`)
    return lens
  })
  return {
    lenses,
    plan: {
      version: 1,
      brief,
      lenses: lenses.map((lens) => lens.id),
      ideasPerLens: clampInt(options.ideasPerLens ?? DEFAULT_IDEAS_PER_LENS, 1, 10),
      maxIdeaChars: clampInt(options.maxIdeaChars ?? DEFAULT_MAX_IDEA_CHARS, 120, 2_000),
      shortlistSize: clampInt(options.shortlistSize ?? DEFAULT_SHORTLIST_SIZE, 2, 12),
      dedupeThreshold: clampFloat(options.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD, 0.5, 0.95),
      createdAt: (options.now ?? new Date()).toISOString(),
    },
  }
}

const clampInt = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(value)))
const clampFloat = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
