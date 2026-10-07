import { describe, expect, test } from "bun:test"
import type { ChatRequest } from "../src/fake-llm.ts"
import { directiveScript, directives } from "../src/script.ts"

const user = (content: string): ChatRequest => ({
  model: "fake/scripted",
  messages: [
    { role: "system", content: "seat system prompt" },
    { role: "user", content },
  ],
})
const toolResult = (content: string) => ({ role: "tool", content }) as const

describe("directives", () => {
  test("a parent @@CALL keeps working when its subagent prompt embeds @@CHILD JSON (#34)", () => {
    const calls = directives(
      'delegate @@CALL subagent {"agent":"es-qa-functional","description":"qa","prompt":"check it @@CHILD es_status {}@@ done"}@@ tail',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("subagent")
    expect(calls[0]!.args).toEqual({
      agent: "es-qa-functional",
      description: "qa",
      prompt: "check it @@CHILD es_status {}@@ done",
    })
  })

  test("@@CHILD directives parse in order", () => {
    const calls = directives('qa @@CHILD es_status {}@@ then @@CHILD es_qa_verdict {"verdict":"pass"}@@ end', "CHILD")
    expect(calls.map((call) => call.name)).toEqual(["es_status", "es_qa_verdict"])
    expect(calls[1]!.args).toEqual({ verdict: "pass" })
  })
})

describe("directiveScript @@CHILD", () => {
  const childPrompt =
    'You are a subagent spawned by another session.\ncheck it @@CHILD es_status {}@@ then @@CHILD es_qa_verdict {"verdict":"pass"}@@ end'

  test("a child session runs its CHILD calls one per turn, then answers done", () => {
    const first = directiveScript(user(childPrompt))
    expect(first.toolCalls?.map((call) => call.name)).toEqual(["es_status"])
    const second = directiveScript({
      model: "fake/scripted",
      messages: [...user(childPrompt).messages, { role: "assistant" }, toolResult("status-ok")],
    })
    expect(second.toolCalls?.map((call) => call.name)).toEqual(["es_qa_verdict"])
    const third = directiveScript({
      model: "fake/scripted",
      messages: [
        ...user(childPrompt).messages,
        { role: "assistant" },
        toolResult("status-ok"),
        { role: "assistant" },
        toolResult("verdict-recorded"),
      ],
    })
    expect(third.text).toBe("done: status-ok | verdict-recorded")
  })

  test("a child with no CHILD directives answers plainly (existing behaviour)", () => {
    const turn = directiveScript(user("You are a subagent spawned by another session.\nsummarise the roadmap"))
    expect(turn.toolCalls).toBeUndefined()
    expect(turn.text).toContain("plain reply to:")
  })

  test("a parent script ignores CHILD directives and only emits its CALLs", () => {
    const turn = directiveScript(
      user('delegate @@CALL subagent {"agent":"es-manager","prompt":"plan @@CHILD es_status {}@@"}@@'),
    )
    expect(turn.toolCalls?.map((call) => call.name)).toEqual(["subagent"])
  })
})
