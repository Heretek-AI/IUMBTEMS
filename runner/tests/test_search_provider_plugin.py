#!/usr/bin/env python3
"""Phase 03-search-anomaly deliverables 2-4: the OpenCode V2 cached search
provider registered through `websearch.transform`.

Pins the plugin-side contract:

* a provider is `add()`ed, and `default.set(ours)` happens ONLY when the editor
  reports no default at all (never override a deliberate `websearch.provider`),
* the registration is shape-tolerant (no `websearch` domain -> no throw),
* `execute()` resolves the upstream free-first (BYO key -> SearXNG -> DDG ->
  Console) and returns OpenCode `WebSearch.Result` hits,
* snippets are returned as content only; full-page witness caching stays the
  agent's explicit `webfetch` + `hasher.py cache` job (documented in README).

No network: every upstream call is injected via a mock `fetchImpl`.
"""

import json
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def run_node(code):
    return subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
    )


def last_json_object(stdout):
    lines = [l.strip() for l in stdout.strip().split("\n") if l.strip().startswith("{")]
    return json.loads(lines[-1])


class TestProviderLadderInPlugin(unittest.TestCase):
    def test_classification_and_ladder(self):
        res = run_node(
            """
            import { providerClassification, resolveWebsearchUpstream } from "./plugins/opencode/index.js";
            console.log(JSON.stringify({
              free: providerClassification("duckduckgo"),
              free2: providerClassification("searxng"),
              metered: providerClassification("exa"),
              unknown: providerClassification("mystery"),
              def: resolveWebsearchUpstream({}, undefined),
              byo: resolveWebsearchUpstream({TAVILY_API_KEY: "k"}, undefined),
              searx: resolveWebsearchUpstream({SEARXNG_URL: "http://localhost:8080"}, undefined),
              explicit: resolveWebsearchUpstream({EXA_API_KEY: "k"}, "searxng"),
            }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["free"], "free")
        self.assertEqual(d["free2"], "free")
        self.assertEqual(d["metered"], "metered")
        self.assertEqual(d["unknown"], "unknown")
        # BYO -> SearXNG -> DDG, explicit always wins.
        self.assertEqual(d["def"]["provider"], "duckduckgo")
        self.assertEqual(d["byo"]["provider"], "tavily")
        self.assertEqual(d["searx"]["provider"], "searxng")
        self.assertEqual(d["explicit"]["provider"], "searxng")
        self.assertTrue(d["explicit"]["explicit"])


class TestProviderExecute(unittest.TestCase):
    def test_returns_normalized_hits_via_injected_fetch(self):
        res = run_node(
            """
            import { websearchProviderDefinition, WEBSEARCH_PROVIDER_ID } from "./plugins/opencode/index.js";
            const calls = [];
            const fetchImpl = async (url, opts) => {
              calls.push(url);
              return { ok: true, json: async () => ({ results: [
                { title: "T", url: "https://e.example/a", content: "snippet" },
              ] }) };
            };
            const def = websearchProviderDefinition({
              env: { TAVILY_API_KEY: "k" },
              fetchImpl,
            });
            const hits = await def.execute({ query: "hello" }, {});
            console.log(JSON.stringify({ id: def.id, calls, hits }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["id"], "iumbtems-cached")
        self.assertTrue(d["calls"][0].startswith("https://api.tavily.com/search"))
        self.assertEqual(d["hits"][0]["url"], "https://e.example/a")
        self.assertEqual(d["hits"][0]["title"], "T")
        self.assertEqual(d["hits"][0]["content"], "snippet")
        self.assertIsInstance(d["hits"][0]["time"], dict)

    def test_searxng_json_results(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            const fetchImpl = async (url) => ({ ok: true, json: async () => ({ results: [
              { title: "S", url: "https://s.example", content: "c" },
            ] }) });
            const def = websearchProviderDefinition({ env: { SEARXNG_URL: "http://localhost:8080/" }, fetchImpl });
            const hits = await def.execute({ query: "q" }, {});
            console.log(JSON.stringify({ hits }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["hits"][0]["url"], "https://s.example")

    def test_ddg_rung_uses_our_python_path(self):
        # The DDG rung must route through OUR path (anomaly detection +
        # telemetry), not a JS reimplementation.
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            const seen = [];
            const runPythonSearch = async (q) => { seen.push(q); return [{ title: "D", url: "https://d.example", snippet: "s" }]; };
            const def = websearchProviderDefinition({ env: {}, runPythonSearch });
            const hits = await def.execute({ query: "ddg query" }, {});
            console.log(JSON.stringify({ hits, seen }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["seen"], ["ddg query"])
        self.assertEqual(d["hits"][0]["url"], "https://d.example")
        self.assertEqual(d["hits"][0]["content"], "s")

    def test_tinyfish_upstream(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            const calls = [];
            const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ results: [{ title: "F", url: "https://f.example/a", content: "c" }] }) }; };
            const def = websearchProviderDefinition({ env: { TINYFISH_API_KEY: "k" }, fetchImpl });
            const hits = await def.execute({ query: "q" }, {});
            console.log(JSON.stringify({ calls, hits: hits.length }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertTrue(d["calls"][0].startswith("https://api.tinyfish.ai/"))
        self.assertEqual(d["hits"], 1)

    def test_metered_rung_logs_provider_and_status(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                f"""
                import {{ websearchProviderDefinition }} from "./plugins/opencode/index.js";
                import {{ readFileSync, existsSync }} from "node:fs";
                const cwd = {json.dumps(tmp)};
                const fetchImpl = async () => ({{ ok: true, json: async () => ({{ results: [{{ title: "T", url: "https://e.example/a", content: "c" }}] }}) }});
                const def = websearchProviderDefinition({{ env: {{ TAVILY_API_KEY: "k" }}, fetchImpl, cwd }});
                const hits = await def.execute({{ query: "hello" }}, {{}});
                const p = cwd + "/.research/retrieval.jsonl";
                const events = existsSync(p) ? readFileSync(p, "utf8").trim().split("\\n").map(JSON.parse) : [];
                console.log(JSON.stringify({{ hits: hits.length, events }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertEqual(d["hits"], 1)
            self.assertEqual(d["events"][0]["kind"], "query")
            self.assertEqual(d["events"][0]["provider"], "tavily")
            self.assertEqual(d["events"][0]["status"], "ok")
            self.assertEqual(d["events"][0]["results"], 1)

    def test_ddg_rung_is_not_double_logged_by_the_plugin(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                f"""
                import {{ websearchProviderDefinition }} from "./plugins/opencode/index.js";
                import {{ existsSync }} from "node:fs";
                const cwd = {json.dumps(tmp)};
                const runPythonSearch = async () => [{{ title: "D", url: "https://d.example/a", snippet: "s" }}];
                const def = websearchProviderDefinition({{ env: {{}}, runPythonSearch, cwd }});
                await def.execute({{ query: "q" }}, {{}});
                console.log(JSON.stringify({{ logged: existsSync(cwd + "/.research/retrieval.jsonl") }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            # `search.py` owns the DDG event; the plugin must not log a second.
            self.assertFalse(last_json_object(res.stdout)["logged"])

    def test_execute_timeout_is_bounded(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            const never = () => new Promise(() => {});
            const def = websearchProviderDefinition({ env: { TAVILY_API_KEY: "k" }, fetchImpl: never, timeoutMs: 40 });
            const t0 = Date.now();
            const hits = await def.execute({ query: "hang" }, {});
            console.log(JSON.stringify({ hits: hits.length, ms: Date.now() - t0 }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["hits"], 0)
        self.assertLess(d["ms"], 5000)

    def test_pre_aborted_signal_short_circuits(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            let called = 0;
            const def = websearchProviderDefinition({ env: { TAVILY_API_KEY: "k" }, fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ results: [] }) }; } });
            const ac = new AbortController(); ac.abort();
            const hits = await def.execute({ query: "x" }, { signal: ac.signal });
            console.log(JSON.stringify({ hits: hits.length, called }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["hits"], 0)
        self.assertEqual(d["called"], 0)

    def test_upstream_failure_returns_empty_not_throw(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            const fetchImpl = async () => { throw new Error("boom"); };
            const def = websearchProviderDefinition({ env: { EXA_API_KEY: "k" }, fetchImpl });
            const hits = await def.execute({ query: "q" }, {});
            console.log(JSON.stringify({ hits }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(last_json_object(res.stdout)["hits"], [])

    def test_console_only_when_explicit_and_delegates(self):
        res = run_node(
            """
            import { websearchProviderDefinition } from "./plugins/opencode/index.js";
            let delegated = 0;
            const hostQuery = async (input) => { delegated += 1; return { results: [{ title: "C", url: "https://c.example", content: "x" }] }; };
            const def = websearchProviderDefinition({ env: {}, explicit: "console", hostQuery });
            const hits = await def.execute({ query: "q" }, {});
            console.log(JSON.stringify({ delegated, hits }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["delegated"], 1)
        self.assertEqual(d["hits"][0]["url"], "https://c.example")


REGISTER_HOST = """
function makeHost(defaultValue, opts = {}) {
  const reg = { added: [], sets: [] };
  const host = {
    location: { directory: "/tmp/iumbtems-ws" },
    command: { list: async () => ({ data: [] }), transform: async () => ({ dispose: () => {} }), reload: async () => {} },
    agent: { list: async () => ({ data: [] }), transform: async () => ({ dispose: () => {} }), reload: async () => {} },
    skill: { list: async () => ({ data: [] }), transform: async () => ({ dispose: () => {} }), reload: async () => {} },
    tool: { transform: async () => ({ dispose: () => {} }), reload: async () => {} },
  };
  if (opts.noWebsearch !== true) {
    host.websearch = {
      transform: async (fn) => {
        const editor = { add: (p) => reg.added.push(p) };
        if (opts.withDefaultGet !== false) {
          editor.default = { get: () => defaultValue, set: (id) => reg.sets.push(id) };
        }
        fn(editor);
        return { dispose: () => {} };
      },
    };
  }
  return { host, reg };
}
"""


class TestProviderRegistration(unittest.TestCase):
    def _register(self, default_js, opts_js="{}"):
        res = run_node(
            REGISTER_HOST
            + f"""
            import plugin from "./plugins/opencode/index.js";
            const {{ host, reg }} = makeHost({default_js}, {opts_js});
            await plugin.setup(host);
            console.log(JSON.stringify({{ added: reg.added.map(p => p.id), sets: reg.sets }}));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return last_json_object(res.stdout)

    def test_sets_default_only_when_unset(self):
        unset = self._register("undefined")
        self.assertEqual(unset["added"], ["iumbtems-cached"])
        self.assertEqual(unset["sets"], ["iumbtems-cached"])

    def test_never_overrides_explicit_provider(self):
        explicit = self._register('"tavily"')
        self.assertEqual(explicit["added"], ["iumbtems-cached"])
        self.assertEqual(explicit["sets"], [], "must not override websearch.provider")

    def test_host_config_explicit_provider_not_overridden(self):
        # readExplicitWebsearchProvider must read host.config.websearch.provider
        # and suppress our default.set.
        res = run_node(
            REGISTER_HOST
            + """
            import plugin from "./plugins/opencode/index.js";
            const { host, reg } = makeHost(undefined);
            host.config = { websearch: { provider: "tavily" } };
            await plugin.setup(host);
            console.log(JSON.stringify({ added: reg.added.map(p => p.id), sets: reg.sets }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = last_json_object(res.stdout)
        self.assertEqual(d["added"], ["iumbtems-cached"])
        self.assertEqual(d["sets"], [], "explicit host config must not be overridden")

    def test_connected_provider_consulted_from_integration_store(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                REGISTER_HOST
                + f"""
                import plugin from "./plugins/opencode/index.js";
                import {{ existsSync, readFileSync }} from "node:fs";
                const {{ host, reg }} = makeHost(undefined);
                host.location = {{ directory: {json.dumps(tmp)} }};
                host.integration = {{ connection: {{ active: async (id) => id === "firecrawl" ? {{ type: "credential", id: "x", label: "F" }} : undefined }} }};
                await plugin.setup(host);
                const p = {json.dumps(tmp)} + "/.research/websearch-state.json";
                const state = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
                console.log(JSON.stringify({{ sets: reg.sets, state }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            # A /connect-ed provider is a deliberate choice: never default-set.
            self.assertEqual(d["sets"], [])
            self.assertEqual(d["state"]["connected_provider"], "firecrawl")

    def test_disconnect_removes_stale_state_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            res = run_node(
                REGISTER_HOST
                + f"""
                import plugin from "./plugins/opencode/index.js";
                import {{ existsSync }} from "node:fs";
                const {{ host }} = makeHost(undefined);
                host.location = {{ directory: {json.dumps(tmp)} }};
                host.integration = {{ connection: {{ active: async (id) => id === "firecrawl" ? {{ type: "credential", id: "x" }} : undefined }} }};
                await plugin.setup(host);
                const p = {json.dumps(tmp)} + "/.research/websearch-state.json";
                const afterConnect = existsSync(p);
                // Host now reports NO connection: the stale record must go.
                const {{ host: host2 }} = makeHost(undefined);
                host2.location = {{ directory: {json.dumps(tmp)} }};
                await plugin.setup(host2);
                console.log(JSON.stringify({{ afterConnect, afterDisconnect: existsSync(p) }}));
                """
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            d = last_json_object(res.stdout)
            self.assertTrue(d["afterConnect"])
            self.assertFalse(d["afterDisconnect"], "stale state file was not removed")

    def test_respects_disabled_websearch(self):
        disabled = self._register("false")
        self.assertEqual(disabled["sets"], [], "must not override websearch: false")

    def test_unknown_default_is_not_overridden(self):
        unknown = self._register("undefined", "{ withDefaultGet: false }")
        self.assertEqual(unknown["added"], ["iumbtems-cached"])
        self.assertEqual(unknown["sets"], [])

    def test_shape_tolerant_without_domain(self):
        res = run_node(
            REGISTER_HOST
            + """
            import plugin from "./plugins/opencode/index.js";
            const { host } = makeHost(undefined, { noWebsearch: true });
            const cleanup = await plugin.setup(host);
            console.log(JSON.stringify({ cleanupFn: typeof cleanup }));
            """
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(last_json_object(res.stdout)["cleanupFn"], "function")


if __name__ == "__main__":
    unittest.main()
