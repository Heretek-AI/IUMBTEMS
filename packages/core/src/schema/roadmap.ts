import { z } from "zod"

export const PHASE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

export const RoadmapPhaseSchema = z.object({
  id: z.string().regex(PHASE_ID, "phase ids are lowercase kebab-case (a-z, 0-9, -), at most 48 chars"),
  title: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
})

export const MAX_PHASES = 20

export const RoadmapSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1),
    /** Branch the run's PR targets. Defaults to the branch checked out when the build starts. */
    baseBranch: z.string().optional(),
    phases: z.array(RoadmapPhaseSchema).min(1).max(MAX_PHASES, `at most ${MAX_PHASES} phases`),
  })
  .superRefine((roadmap, issue) => {
    const ids = new Set<string>()
    roadmap.phases.forEach((phase, index) => {
      if (ids.has(phase.id)) issue.addIssue({ code: "custom", path: ["phases", index, "id"], message: "duplicate id" })
      for (const dep of phase.dependsOn)
        if (!ids.has(dep))
          issue.addIssue({
            code: "custom",
            path: ["phases", index, "dependsOn"],
            message: `"${dep}" must be an earlier phase (phases run in order)`,
          })
      ids.add(phase.id)
    })
  })

export type Roadmap = z.infer<typeof RoadmapSchema>
export type RoadmapPhase = z.infer<typeof RoadmapPhaseSchema>
