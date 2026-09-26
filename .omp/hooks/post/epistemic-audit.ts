import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

/**
 * OMP post-tool hook: remind the agent to keep the epistemic audit trail.
 * Every [VERIFIED:<hash>] quote must exist verbatim in .research/sources/<sha256>.md.
 */
export async function postTool(api: HookAPI) {
  api.on("tool:after", (event) => {
    if (event?.ok === false) {
      // Surface failures as negative knowledge, never parametric guesses.
      event.note?.(
        "Record tool failures as [NEGATIVE_KNOWLEDGE:<query>] with the exact query — do not hallucinate a substitute answer."
      );
    }
  });
}
