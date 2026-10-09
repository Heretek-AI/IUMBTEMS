// Single source of truth for where factory state lives.
//
// Tracked in git: frontier, roadmap, specs, research, brainstorm, harvest,
// gates config, waivers, approvals. Ignored: runtime/ (state, journal, audit,
// control baseline, pending requests, harvested clones and read ledgers),
// runs/ (gate logs, metrics), worktrees/, STOP.
import { homedir } from "node:os"
import path from "node:path"

export function factoryLayout(root: string) {
  const dir = path.join(root, ".factory")
  const runtime = path.join(dir, "runtime")
  return {
    root,
    dir,
    frontier: path.join(dir, "frontier.json"),
    roadmap: path.join(dir, "roadmap.json"),
    specs: path.join(dir, "specs"),
    spec: (phaseId: string) => path.join(dir, "specs", phaseId, "GOAL.md"),
    dependencies: (phaseId: string) => path.join(dir, "specs", phaseId, "DEPENDENCIES.md"),
    research: path.join(dir, "research"),
    researchReport: path.join(dir, "research", "REPORT.md"),
    researchCoverage: path.join(dir, "research", "coverage.json"),
    researchDossier: path.join(dir, "research", "dossier.json"),
    researchBrief: path.join(dir, "research", "brief.pcrb.json"),
    audits: path.join(dir, "audits"),
    auditDir: (id: string) => path.join(dir, "audits", id),
    auditRecords: (id: string) => path.join(dir, "audits", id, "records.json"),
    auditDossier: (id: string) => path.join(dir, "audits", id, "dossier.json"),
    auditReport: (id: string) => path.join(dir, "audits", id, "REPORT.md"),
    scout: path.join(dir, "scout"),
    scoutPlan: path.join(dir, "scout", "plan.json"),
    scoutAssessments: path.join(dir, "scout", "assessments.json"),
    scoutDossier: path.join(dir, "scout", "dossier.json"),
    scoutResult: path.join(dir, "scout", "scout.json"),
    scoutReport: path.join(dir, "scout", "REPORT.md"),
    scoutProfile: (id: string) => path.join(dir, "scout", id, "profile.json"),
    claims: path.join(dir, "claims"),
    retractions: path.join(dir, "claims", "retractions.json"),
    brainstorm: path.join(dir, "brainstorm"),
    brainstormPlan: path.join(dir, "brainstorm", "plan.json"),
    brainstormIdeas: path.join(dir, "brainstorm", "ideas.json"),
    brainstormScores: path.join(dir, "brainstorm", "scores.json"),
    brainstormResult: path.join(dir, "brainstorm", "brainstorm.json"),
    brainstormReport: path.join(dir, "brainstorm", "BRAINSTORM.md"),
    brainstormRuns: path.join(dir, "brainstorm", "runs"),
    brainstormRun: (runId: string) => path.join(dir, "brainstorm", "runs", runId),
    brainstormRunPlan: (runId: string) => path.join(dir, "brainstorm", "runs", runId, "plan.json"),
    brainstormRunIdeas: (runId: string) => path.join(dir, "brainstorm", "runs", runId, "ideas.json"),
    brainstormRunScores: (runId: string) => path.join(dir, "brainstorm", "runs", runId, "scores.json"),
    brainstormRunResult: (runId: string) => path.join(dir, "brainstorm", "runs", runId, "brainstorm.json"),
    brainstormRunReport: (runId: string) => path.join(dir, "brainstorm", "runs", runId, "BRAINSTORM.md"),
    harvest: path.join(dir, "harvest"),
    harvestPlan: path.join(dir, "harvest", "plan.json"),
    harvestMatrix: path.join(dir, "harvest", "matrix.json"),
    harvestResult: path.join(dir, "harvest", "harvest.json"),
    harvestReport: path.join(dir, "harvest", "HARVEST.md"),
    harvestVendorPlan: path.join(dir, "harvest", "VENDOR-PLAN.md"),
    harvestCleanRoom: path.join(dir, "harvest", "clean-room"),
    harvestRuns: path.join(dir, "harvest", "runs"),
    harvestRun: (runId: string) => path.join(dir, "harvest", "runs", runId),
    harvestRunPlan: (runId: string) => path.join(dir, "harvest", "runs", runId, "plan.json"),
    harvestRunMatrix: (runId: string) => path.join(dir, "harvest", "runs", runId, "matrix.json"),
    harvestRunResult: (runId: string) => path.join(dir, "harvest", "runs", runId, "harvest.json"),
    harvestRunReport: (runId: string) => path.join(dir, "harvest", "runs", runId, "HARVEST.md"),
    harvestRunVendorPlan: (runId: string) => path.join(dir, "harvest", "runs", runId, "VENDOR-PLAN.md"),
    harvestRunCleanRoom: (runId: string) => path.join(dir, "harvest", "runs", runId, "clean-room"),
    harvestRunProfile: (runId: string, id: string) => path.join(dir, "harvest", "runs", runId, id, "profile.json"),
    improve: path.join(dir, "improve"),
    improveProposals: path.join(dir, "improve", "proposals"),
    improveProposal: (id: string) => path.join(dir, "improve", "proposals", id),
    design: path.join(dir, "design"),
    designInterview: path.join(dir, "design", "interview.json"),
    designTokens: path.join(dir, "design", "tokens.json"),
    designCss: path.join(dir, "design", "tokens.css"),
    designProbes: path.join(dir, "design", "probes.json"),
    designGuide: path.join(dir, "design", "STYLE_GUIDE.md"),
    designComponents: path.join(dir, "design", "components"),
    designWebref: path.join(dir, "design", "webref.json"),
    designCsf: path.join(dir, "design", "csf.json"),
    designHarvest: path.join(dir, "design", "harvest.json"),
    designTuiNotes: path.join(dir, "design", "tui-notes.md"),
    gates: path.join(dir, "gates.json"),
    config: path.join(dir, "config.json"),
    waivers: path.join(dir, "waivers"),
    approvals: path.join(dir, "approvals"),
    approval: (stage: string) => path.join(dir, "approvals", `${stage}.json`),
    runtime,
    state: path.join(runtime, "state.json"),
    journal: path.join(runtime, "journal.jsonl"),
    audit: path.join(runtime, "audit.jsonl"),
    control: path.join(runtime, "control.json"),
    pending: path.join(runtime, "pending-approvals.json"),
    seats: path.join(runtime, "seats.json"),
    runs: path.join(dir, "runs"),
    run: (runId: string) => path.join(dir, "runs", runId),
    worktrees: path.join(dir, "worktrees"),
    worktree: (phaseId: string) => path.join(dir, "worktrees", phaseId),
    stop: path.join(dir, "STOP"),
  }
}

export type FactoryLayout = ReturnType<typeof factoryLayout>

/**
 * User-global state outside any project: the approval signing key and the
 * trust store. Agents are denied reads and writes here. `ES_STATE_DIR`
 * overrides it (tests, sandboxes).
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ES_STATE_DIR) return path.resolve(env.ES_STATE_DIR)
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(homedir(), ".local", "state")
  return path.join(base, "epistemic-swarm")
}
