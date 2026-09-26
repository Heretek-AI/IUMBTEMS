import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

/**
 * OMP pre-tool hook: redirect unverified web tools into the epistemic pipeline.
 * Mirrors hooks/hooks.json (Claude Code) for the omp.sh hook layout.
 */
export async function preTool(api: HookAPI) {
  api.on("tool:before", (event) => {
    const name = String(event?.tool ?? "").toLowerCase();
    if (name.includes("websearch") || name.includes("web_search")) {
      event.redirect?.(
        'Use epistemic search instead: python3 skills/epistemic_search/scripts/search.py "<query>" (SHA-256 cached, verifiable).'
      );
    }
    if (name.includes("webfetch") || name.includes("web_fetch")) {
      event.redirect?.(
        'Use epistemic fetch instead: python3 skills/epistemic_search/scripts/fetch.py "<url>" (content-addressed into .research/sources/).'
      );
    }
  });
}
