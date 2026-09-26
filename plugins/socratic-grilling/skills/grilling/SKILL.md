---
name: grilling
description: Socratic grilling and assumption-inversion skill for deep research. Uses Matt Pocock-style design trees to explore the problem frontier divergently before committing to search queries.
---

# Socratic Grilling & Divergent Research Framing

Interview the user relentlessly until you reach an airtight, shared understanding of the research scope. Map the problem as a **design tree**: every foundational assumption branches into the technical decisions and empirical hypotheses that hang off it.

## 1. THE FRONTIER METHODOLOGY

1. Work the tree in **rounds**.
2. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask *now* without guessing at answers you haven't heard yet.
3. Ask the whole frontier in one round: number each question and provide your recommended answer.
4. Then wait for the user's answers before moving to the next round.

## 2. FORMATTING A ROUND

```
❓ **Q1 - <Question Title>**: <Question context, premise inversion, trade-offs, multiple options>

➡️ **Recommended**: <Your recommended answer with rationale>

---

❓ **Q2 - <Question Title>**: <Question context, trade-offs>

➡️ **Recommended**: <Your recommended answer with rationale>
```

## 3. FACTUAL VS. DECISIONAL SEPARATION

- **Facts are the agent's job**: When a frontier question hinges on an empirical fact (e.g. library benchmarks, API specs, hardware limits), **DO NOT ASK THE USER**. Dispatch a tool call or subagent to look it up in the codebase or online.
- **Decisions are the user's**: High-level trade-offs, architectural philosophy, threat models, and priority ranking belong to the user. Put each decision to them clearly.

## 4. ASSUMPTION INVERSION TACTICS

Always challenge default premises in Round 1:
- *Inversion*: What if the primary objective is rendered obsolete by a radical alternative?
- *Scale Extremes*: What breaks at 100x scale? What breaks at 0 resources?
- *Adversarial Posture*: How would an intelligent adversary exploit or falsify this design?

## 5. FRONTIER RESOLUTION & FREEZING

When every branch of the design tree has been visited and the frontier is empty:
1. Summarize the settled constraints.
2. Save the settled state to `.research/frontier.json` using `python3 skills/grilling/socratic_tree.py --export`.
3. Hand off the settled frontier to the **Swarm Orchestrator** to begin empirical dialectic execution.
