// The deterministic part of brainstorming: word-trigram similarity, duplicate
// collapsing, rubric totals, and the diversified shortlist with a forced
// outlier slot. No model calls here; given the same ideas and scores the
// output is identical every time.
import type { BrainstormIdea, BrainstormScore, BrainstormShortlistEntry } from "../schema/brainstorm.ts"

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "on",
  "with",
  "is",
  "are",
  "it",
  "this",
  "that",
  "be",
  "as",
  "at",
  "by",
  "from",
  "we",
  "you",
  "can",
  "could",
  "would",
  "should",
  "will",
  "not",
  "no",
  "but",
  "if",
  "then",
  "than",
  "so",
  "its",
  "into",
  "over",
  "under",
  "more",
  "less",
  "most",
  "least",
  "very",
  "just",
  "also",
  "make",
  "makes",
  "made",
  "using",
  "use",
  "used",
  "new",
  "when",
  "where",
  "which",
  "who",
  "them",
  "they",
  "our",
  "your",
  "their",
  "one",
  "two",
  "all",
  "any",
  "each",
  "both",
  "own",
  "via",
])

/** Content words of a text (lowercased, stop words and 1-2 letter words dropped). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
}

/** Word n-gram shingles; short texts fall back to unigrams. Default: bigrams. */
export function shingles(text: string, size = 2): Set<string> {
  const list = words(text)
  const out = new Set<string>()
  if (list.length < size) {
    for (const word of list) out.add(word)
    return out
  }
  for (let index = 0; index + size <= list.length; index++) out.add(list.slice(index, index + size).join(" "))
  return out
}

/** Jaccard similarity over word shingles, 0..1. */
export function similarity(a: string, b: string, size = 2): number {
  const left = shingles(a, size)
  const right = shingles(b, size)
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const shingle of left) if (right.has(shingle)) overlap++
  return overlap / (left.size + right.size - overlap)
}

const ideaText = (idea: Pick<BrainstormIdea, "title" | "text">) => `${idea.title}. ${idea.text}`

export interface DuplicateHit {
  readonly id: string
  readonly duplicateOf: string
  readonly similarity: number
}

/**
 * Ideas at or above `threshold` similarity to an earlier one are duplicates of
 * it. The first idea of a cluster is the canonical one; order is preserved.
 */
export function collapseDuplicates(ideas: readonly BrainstormIdea[], threshold: number, size = 2): DuplicateHit[] {
  const hits: DuplicateHit[] = []
  const kept: BrainstormIdea[] = []
  for (const idea of ideas) {
    let best: DuplicateHit | undefined
    for (const prior of kept) {
      const score = similarity(ideaText(idea), ideaText(prior), size)
      if (score >= threshold && (!best || score > best.similarity))
        best = { id: idea.id, duplicateOf: prior.id, similarity: Number(score.toFixed(3)) }
    }
    if (best) hits.push(best)
    else kept.push(idea)
  }
  return hits
}

export const rubricTotal = (score: BrainstormScore): number =>
  score.novelty + score.upside + score.feasibility + score.fit

export interface RankedIdea {
  readonly id: string
  readonly total: number
}

export function rankIdeas(
  ideas: readonly BrainstormIdea[],
  scores: ReadonlyMap<string, BrainstormScore>,
): RankedIdea[] {
  return ideas
    .map((idea) => ({ id: idea.id, total: rubricTotal(scores.get(idea.id)!) }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
}

/** How strongly diversity counts against a rubric gap (totals span 4-20). */
const DIVERSITY_WEIGHT = 4
/** Below this maximum similarity to the shortlist, an idea counts as an outlier. */
export const OUTLIER_THRESHOLD = 0.35

/**
 * Greedy diversified selection: quality plus distance from what is already
 * picked. The last slot is forced to an outlier — the best idea whose maximum
 * similarity to the shortlist is below the outlier threshold, or the most
 * dissimilar idea when none is far enough.
 */
export function selectShortlist(
  ranked: readonly RankedIdea[],
  texts: ReadonlyMap<string, string>,
  size: number,
  outlierThreshold = OUTLIER_THRESHOLD,
): BrainstormShortlistEntry[] {
  const count = Math.min(size, ranked.length)
  if (!count) return []
  const picked: BrainstormShortlistEntry[] = []
  const remaining = () => ranked.filter((item) => !picked.some((entry) => entry.id === item.id))
  const similarityTo = (id: string) =>
    picked.length ? Math.max(...picked.map((entry) => similarity(texts.get(id) ?? "", texts.get(entry.id) ?? ""))) : 0
  const outlierSlot = count >= 2 && ranked.length >= 2
  const diverseSlots = outlierSlot ? count - 1 : count
  while (picked.length < diverseSlots) {
    let best: RankedIdea | undefined
    let bestScore = Number.NEGATIVE_INFINITY
    for (const candidate of remaining()) {
      const score = candidate.total + DIVERSITY_WEIGHT * (1 - similarityTo(candidate.id))
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }
    if (!best) break
    picked.push({ id: best.id, total: best.total, outlier: false })
  }
  if (outlierSlot && picked.length < count) {
    const rest = remaining().map((item) => ({ item, maxSim: similarityTo(item.id) }))
    const dissimilar = rest.filter((entry) => entry.maxSim < outlierThreshold)
    const [pick] = (dissimilar.length ? dissimilar : rest).sort((a, b) =>
      dissimilar.length
        ? b.item.total - a.item.total || a.maxSim - b.maxSim
        : a.maxSim - b.maxSim || b.item.total - a.item.total,
    )
    if (pick)
      picked.push({
        id: pick.item.id,
        total: pick.item.total,
        outlier: true,
        reason: `forced outlier: maximum similarity to the shortlist is ${pick.maxSim.toFixed(2)}`,
      })
  }
  return picked
}
