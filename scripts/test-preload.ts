// Preloaded by every root `bun test` run (bunfig.toml, [test] preload). Web
// provider settings exported in the developer's shell must never reach a
// suite: a real key sends fixture queries to the live API and spends quota
// (#312). A test that needs one sets its own value after this runs.
for (const key of [
  "BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
  "SEARXNG_URL",
  "ES_SCRAPER_SWARM_URL",
  "ES_SCRAPER_SWARM_TOKEN",
])
  delete process.env[key]
