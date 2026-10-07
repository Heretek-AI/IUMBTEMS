// Tool-name and input canonicalisation between host harnesses and Claude
// Code's hook payloads. Hooks always see Claude names and Claude-shaped
// input (absolute file_path, snake_case keys); updatedInput maps back.
import path from "node:path"

export interface CanonicalTool {
  /** Claude Code tool name (hook payload `tool_name`). */
  readonly name: string
  /** Names a matcher or `if` rule may use: canonical first, then host-native. */
  readonly aliases: readonly string[]
  readonly input: Record<string, unknown>
}

type Mapper = {
  readonly name: string
  readonly toClaude: (input: Record<string, any>, cwd: string) => Record<string, unknown>
  readonly fromClaude: (
    input: Record<string, any>,
    cwd: string,
    original: Record<string, any>,
  ) => Record<string, unknown>
}

const abs = (file: unknown, cwd: string) => (typeof file === "string" ? path.resolve(cwd, file) : file)
const pick = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T

export function patchFiles(patchText: string): string[] {
  return [...patchText.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to):(.*)$/gm)].map((match) =>
    match[1]!.trim(),
  )
}

/** OpenCode v2 built-in tools. */
const OPENCODE: Record<string, Mapper> = {
  read: {
    name: "Read",
    toClaude: (input, cwd) => pick({ file_path: abs(input.path, cwd), offset: input.offset, limit: input.limit }),
    fromClaude: (input) => pick({ path: input.file_path, offset: input.offset, limit: input.limit }),
  },
  write: {
    name: "Write",
    toClaude: (input, cwd) => pick({ file_path: abs(input.path, cwd), content: input.content }),
    fromClaude: (input) => pick({ path: input.file_path, content: input.content }),
  },
  edit: {
    name: "Edit",
    toClaude: (input, cwd) =>
      pick({
        file_path: abs(input.path, cwd),
        old_string: input.oldString,
        new_string: input.newString,
        replace_all: input.replaceAll,
      }),
    fromClaude: (input) =>
      pick({
        path: input.file_path,
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all,
      }),
  },
  patch: {
    name: "Edit",
    toClaude: (input, cwd) => {
      const files = patchFiles(String(input.patchText ?? "")).map((file) => path.resolve(cwd, file))
      return pick({ file_path: files[0], file_paths: files, patch: input.patchText })
    },
    fromClaude: (input, _cwd, original) => pick({ patchText: input.patch ?? original.patchText }),
  },
  shell: {
    name: "Bash",
    toClaude: (input) =>
      pick({ command: input.command, timeout: input.timeout, run_in_background: input.background, cwd: input.workdir }),
    fromClaude: (input) =>
      pick({ command: input.command, timeout: input.timeout, background: input.run_in_background, workdir: input.cwd }),
  },
  glob: {
    name: "Glob",
    toClaude: (input, cwd) => pick({ pattern: input.pattern, path: abs(input.path, cwd) }),
    fromClaude: (input) => pick({ pattern: input.pattern, path: input.path }),
  },
  grep: {
    name: "Grep",
    toClaude: (input, cwd) =>
      pick({
        pattern: input.pattern,
        path: abs(input.path, cwd),
        glob: input.include,
        "-i": input.caseSensitive === false ? true : undefined,
      }),
    fromClaude: (input) =>
      pick({
        pattern: input.pattern,
        path: input.path,
        include: input.glob,
        caseSensitive: input["-i"] ? false : undefined,
      }),
  },
  webfetch: {
    name: "WebFetch",
    toClaude: (input) => pick({ url: input.url, format: input.format }),
    fromClaude: (input) => pick({ url: input.url, format: input.format }),
  },
  websearch: {
    name: "WebSearch",
    toClaude: (input) => pick({ query: input.query }),
    fromClaude: (input) => pick({ query: input.query }),
  },
  subagent: {
    name: "Agent",
    toClaude: (input) =>
      pick({
        subagent_type: input.agent,
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        run_in_background: input.background,
      }),
    fromClaude: (input, _cwd, original) =>
      pick({
        agent: input.subagent_type,
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        background: input.run_in_background,
        sessionID: original.sessionID,
      }),
  },
  question: {
    name: "AskUserQuestion",
    toClaude: (input) => pick({ questions: input.questions }),
    fromClaude: (input) => pick({ questions: input.questions }),
  },
  skill: {
    name: "Skill",
    toClaude: (input) => pick({ skill: input.id }),
    fromClaude: (input) => pick({ id: input.skill }),
  },
}

/**
 * Canonicalise an OpenCode v2 tool call. MCP tools ("<server>_<tool>" in v2)
 * become "mcp__<server>__<tool>" when the server is known.
 */
export function fromOpenCode(
  tool: string,
  input: unknown,
  cwd: string,
  mcpServers: readonly string[] = [],
): CanonicalTool {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>
  const mapper = OPENCODE[tool]
  if (mapper) return { name: mapper.name, aliases: [mapper.name, tool], input: mapper.toClaude(raw, cwd) }
  const server = [...mcpServers]
    .sort((a, b) => b.length - a.length)
    .find((name) => tool.startsWith(`${name.replace(/[^\w-]/g, "_")}_`))
  if (server) {
    const name = `mcp__${server}__${tool.slice(server.replace(/[^\w-]/g, "_").length + 1)}`
    return { name, aliases: [name, tool], input: raw }
  }
  return { name: tool, aliases: [tool], input: raw }
}

/** Map a hook's Claude-shaped updatedInput back to the OpenCode tool's input. */
export function toOpenCodeInput(
  tool: string,
  updated: Record<string, unknown>,
  cwd: string,
  original: unknown,
): Record<string, unknown> {
  const mapper = OPENCODE[tool]
  const base = (original && typeof original === "object" ? original : {}) as Record<string, any>
  return mapper ? mapper.fromClaude(updated as Record<string, any>, cwd, base) : updated
}

/** Claude tool name for a v2 permission action (PermissionRequest bridging). */
export function permissionActionTool(action: string): string {
  return (
    {
      read: "Read",
      edit: "Edit",
      shell: "Bash",
      glob: "Glob",
      grep: "Grep",
      webfetch: "WebFetch",
      websearch: "WebSearch",
      subagent: "Agent",
      question: "AskUserQuestion",
      skill: "Skill",
    }[action] ?? action
  )
}
