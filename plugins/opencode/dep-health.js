/**
 * IUMBTEMS dep-health gate (Phase 03-dep-health-gate): programmer-time
 * outdated/vulnerable-dependency warnings plus a mechanical QA coverage gate.
 *
 * Second hook-bus consumer (after the Phase-02 analysis bridge): runs local
 * `npm outdated --json` + `npm audit --json`, enriches npm/pip packages with
 * a best-effort credential-free OSV.dev lookup, statically scans container
 * base images (compose files + Dockerfiles) and GitHub Actions `uses:` pins —
 * and reports everything as ADVISORY annotations. This module NEVER returns
 * deny: severities never block (pinned by the never-blocks test with a
 * critical-CVE fixture); the QA gate (`depHealthCoverage`) fails only when a
 * check didn't run or findings went unrecorded.
 *
 * Findings shape: `{ tool, eventId, ecosystem, package, installed, wanted,
 * latest, severity, advisory, fixedIn, source }` — every key ALWAYS present
 * (`null` when unknown), reusing the Phase-02 annotation shape `{ tool,
 * eventId, ... }`. Every finding is audit-logged on the bus (one
 * `notification` record per finding via the internal audit sink); the toast
 * summarizes counts only (no finding text, no log spam).
 *
 * Zero runtime dependencies (node builtins only: child_process, fs, path,
 * url, https). Network/OSV failures fail open with a recorded `unavailable`
 * entry — never throws into the host.
 *
 * Phase evidence (cited per programmer brief):
 * - npm surface: package.json + package-lock.json present (Biome 2.5.15
 *   devDep from Phase-02)
 *   [VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e
 *   `file:///home/john/Projects/IUMBTEMS/package.json`]
 *   [VERIFIED: sha256:1fd0c2b8b0d37d553f1f841cea4e4b60d92cdf873257172a726d482954dddf8f
 *   `file:///home/john/Projects/IUMBTEMS/package-lock.json`]
 * - Container surface: config/docker-compose.infra.yml pins
 *   `searxng/searxng:latest` and `mendableai/firecrawl:latest` — floating
 *   tags, canonical advisory fodder
 *   [VERIFIED: sha256:7b62111192e07c73547a125eeab7ff98f2d1305a04149f1ab51c66a41a3e3f95
 *   `file:///home/john/Projects/IUMBTEMS/config/docker-compose.infra.yml`:5,16]
 * - Actions surface: 4 workflows, all `uses:` pinned to majors
 *   (`checkout@v4`, `setup-python@v5`, `setup-node@v4`,
 *   `upload-artifact@v4`) — healthy pattern to assert, not fix
 *   [VERIFIED: sha256:c381a646894ce66669432e847f0afd647ea5ff00ac64a01cf91f325f5515e601
 *   `file:///home/john/Projects/IUMBTEMS/.github/workflows/plugin-evals.yml`]
 * - Dep-health vocabulary precedent: scout weights CVEs + npm-audit warnings
 *   + Dependabot advisories
 *   [VERIFIED: sha256:ae16788a0a85caed3983dbc70455eaa05857827c837a5f5999242ef32b0a16a7
 *   `file:///home/john/Projects/IUMBTEMS/prompts/agent_oss_scout.md`:30]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOW_TIMEOUT_MS } from './hook-bus.js';

/** Tool tag carried on every finding and audit record from this consumer. */
export const DEP_HEALTH_TOOL = 'dep-health';

/** Bus events this consumer subscribes (programmer action-time points). */
export const DEP_HEALTH_EVENTS = Object.freeze(['pre-tool-use', 'pre-commit']);

/** Ecosystems covered, in canonical order. */
export const ECOSYSTEMS = Object.freeze(['npm', 'pip', 'containers', 'actions']);

/**
 * OSV enrichment budget: the whole OSV phase must settle inside it. Kept
 * under the slow-tier budget so a hung feed can never brick the caller —
 * an overrun degrades to best-effort skip (pip falls back to a recorded
 * `unavailable` entry; npm keeps its local signals).
 */
export const OSV_TIMEOUT_MS = Math.min(4000, SLOW_TIMEOUT_MS - 1000);

/** Cap on findings per ecosystem (bounds audit + toast fan-out). */
export const MAX_DEP_FINDINGS = 50;

/** Cap on packages sent to OSV (bounds feed fan-out inside the budget). */
export const MAX_OSV_PACKAGES = 20;

/** Marker distinguishing per-finding audit records on `notification`. */
export const DEP_AUDIT_KIND = 'dep-health-finding';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');

function resolveTool(payload) {
  try {
    const v = payload?.tool;
    return typeof v === 'string' && v.trim() ? v : DEP_HEALTH_TOOL;
  } catch {
    return DEP_HEALTH_TOOL;
  }
}

function resolveEventId(payload) {
  try {
    const v = payload?.eventId ?? payload?.event_id ?? null;
    return typeof v === 'string' || typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Normalise one finding. Every key is ALWAYS present (`null` when unknown)
 * so audit consumers can rely on shape — the same guarantee the bus gives
 * `tool`/`eventId` and the bridge gives its seven finding keys.
 */
export function toDepFinding({
  tool, eventId, ecosystem, package: pkg, installed,
  wanted, latest, severity, advisory, fixedIn, source,
}) {
  const eco = typeof ecosystem === 'string' && ecosystem ? ecosystem : 'npm';
  return {
    tool: typeof tool === 'string' && tool ? tool : DEP_HEALTH_TOOL,
    eventId: eventId ?? null,
    ecosystem: eco,
    package: typeof pkg === 'string' && pkg ? pkg : null,
    installed: typeof installed === 'string' && installed ? installed : null,
    wanted: typeof wanted === 'string' && wanted ? wanted : null,
    latest: typeof latest === 'string' && latest ? latest : null,
    severity: typeof severity === 'string' && severity ? severity.toLowerCase() : 'info',
    advisory: typeof advisory === 'string' && advisory ? advisory : null,
    fixedIn: typeof fixedIn === 'string' && fixedIn ? fixedIn : null,
    source: typeof source === 'string' && source ? source : 'unknown',
  };
}

/** The eleven always-present finding keys (pinned by the shape test). */
export const DEP_FINDING_KEYS = Object.freeze([
  'tool', 'eventId', 'ecosystem', 'package', 'installed', 'wanted',
  'latest', 'severity', 'advisory', 'fixedIn', 'source',
]);

// ---------------------------------------------------------------------------
// Parsers (pure; all four ecosystems). Never throw.
// ---------------------------------------------------------------------------

/** Parse package.json text → [{name, spec}] over dependencies+devDependencies. */
export function parseNpmDeps(packageJsonText) {
  try {
    const pkg = JSON.parse(String(packageJsonText || ''));
    const out = [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = pkg?.[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof name === 'string' && name && typeof spec === 'string') {
          out.push({ name, spec });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parse pip requirement lines (requirements*.txt plus `dependencies = [...]`
 * fragments of pyproject.toml) → [{name, spec}]. Never throws.
 */
export function parsePipDeps(texts) {
  const out = [];
  try {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const text of list) {
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim().replace(/\\#.*$/, '').trim();
        if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('[')) continue;
        // Strip env markers and extras: `name[extra]>=1.0; python_version>"3.8"`.
        const noMarker = line.split(';')[0].trim();
        const m = noMarker.match(/^([A-Za-z0-9_.\-]+(?:\[[^\]]*\])?)\s*(.*)$/);
        if (!m) continue;
        const name = m[1].replace(/\[.*\]$/, '');
        const spec = (m[2] || '').trim().replace(/^[",'\s]+|[",'\s,]+$/g, '');
        if (name) out.push({ name, spec });
      }
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

/** Extract image refs from compose-file / Dockerfile text → [{image, tag, source}]. */
export function parseContainerImages(texts, source = 'compose-scan') {
  const out = [];
  const seen = new Set();
  try {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const text of list) {
      const content = String(text || '');
      // Compose `image:` lines.
      for (const m of content.matchAll(/^\s*image\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/gm)) {
        pushImage(out, seen, m[1], source);
      }
      // Dockerfile `FROM` lines (incl. `FROM img AS base`, `--platform=`).
      for (const m of content.matchAll(/^\s*FROM\s+(?:--\S+\s+)*([^\s#]+)/gim)) {
        if (m[1].toLowerCase() === 'scratch') continue;
        pushImage(out, seen, m[1].split(/\s+AS\s+/i)[0], 'dockerfile-scan');
      }
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

function pushImage(out, seen, ref, source) {
  try {
    const clean = String(ref || '').trim().replace(/^["']|["']$/g, '');
    if (!clean || seen.has(`${source}:${clean}`)) return;
    seen.add(`${source}:${clean}`);
    // Split `registry/org/name:tag[@digest]`.
    const atDigest = clean.includes('@');
    const withoutDigest = atDigest ? clean.split('@')[0] : clean;
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    const tag = lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : null;
    out.push({ image: withoutDigest, tag, digest: atDigest, source });
  } catch {
    /* one bad ref must not drop the rest */
  }
}

/** An image ref is floating when it has no digest and no immutable tag. */
export function isFloatingImage(ref) {
  try {
    if (ref?.digest) return false;
    const tag = ref?.tag;
    if (!tag) return true; // bare `name` == implicit `:latest`
    return tag.toLowerCase() === 'latest';
  } catch {
    return false;
  }
}

/** Parse workflow text `uses:` pins → [{uses, ref, pinned}]. Never throws. */
export function parseActionPins(texts) {
  const out = [];
  try {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const text of list) {
      for (const m of String(text || '').matchAll(/uses\s*:\s*["']?([^\s"'#]+)["']?/g)) {
        const uses = m[1].trim();
        if (!uses || uses.startsWith('./') || uses.startsWith('docker://')) continue;
        const at = uses.lastIndexOf('@');
        const ref = at >= 0 ? uses.slice(at + 1) : null;
        out.push({ uses, ref, pinned: isPinnedRef(ref) });
      }
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

/**
 * A pin counts as healthy when it names an immutable ref: a major/minor
 * version (`v4`, `v5.1`), a full semver, or a 40-hex commit SHA. Branch names
 * (`main`, `master`, `latest`, `head`) and missing refs are unpinned.
 */
export function isPinnedRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return false;
  const r = ref.trim();
  if (/^[0-9a-f]{40}$/i.test(r)) return true;
  if (/^v?\d+(\.\d+){0,2}([\-.+][0-9A-Za-z.\-]+)?$/.test(r)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Local runners (default: real `npm` spawn; injected mocks in tests).
// ---------------------------------------------------------------------------

function spawnJson(bin, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? OSV_TIMEOUT_MS);
  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : OSV_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd || process.cwd() });
    } catch (err) {
      finish({ status: 'error', message: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({ status: 'timeout' });
    }, budget);
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ status: err?.code === 'ENOENT' ? 'missing' : 'error', message: String(err?.message ?? err) });
    });
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.on('close', () => {
      if (done) return;
      clearTimeout(timer);
      finish({ status: 'ok', stdout });
    });
  });
}

/** Default `npm outdated --json` runner. Never rejects. */
export function defaultRunOutdated(opts = {}) {
  return spawnJson('npm', ['outdated', '--json', '--long=false'], opts).then((r) => {
    if (!r || r.status !== 'ok') return r;
    // `npm outdated` exits nonzero when anything is outdated, but stdout
    // still carries the JSON payload — the raw text is what matters here.
    try {
      return { status: 'ok', json: JSON.parse(String(r.stdout || '{}')) };
    } catch {
      return { status: 'ok', json: {} };
    }
  });
}

/** Default `npm audit --json` runner. Never rejects. */
export function defaultRunAudit(opts = {}) {
  return spawnJson('npm', ['audit', '--json'], opts).then((r) => {
    if (!r || r.status !== 'ok') return r;
    try {
      return { status: 'ok', json: JSON.parse(String(r.stdout || '{}')) };
    } catch {
      return { status: 'ok', json: {} };
    }
  });
}

/**
 * Default OSV.dev query (`POST https://api.osv.dev/v1/query`, credential-free).
 * Resolves `{ status: 'ok', vulns }`, `{ status: 'timeout' }`, or
 * `{ status: 'error', message }`. Never rejects, never throws.
 */
export function defaultQueryOsv({ ecosystem, package: pkg, version, timeoutMs }) {
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs) : OSV_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), budget);
    let req;
    try {
      const body = JSON.stringify({
        package: { name: pkg, ecosystem },
        ...(version ? { version } : {}),
      });
      req = https.request(
        'https://api.osv.dev/v1/query',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => { data += String(d); });
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(data || '{}');
              finish({ status: 'ok', vulns: Array.isArray(parsed?.vulns) ? parsed.vulns : [] });
            } catch {
              finish({ status: 'error', message: 'unparseable OSV response' });
            }
          });
        },
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        finish({ status: 'error', message: String(err?.message ?? err) });
      });
      req.on('timeout', () => {
        try { req.destroy(); } catch { /* already closed */ }
        clearTimeout(timer);
        finish({ status: 'timeout' });
      });
      req.setTimeout(budget);
      req.write(body);
      req.end();
    } catch (err) {
      clearTimeout(timer);
      finish({ status: 'error', message: String(err?.message ?? err) });
    }
  });
}

/** Race any runner against a budget. Never rejects. */
function runBounded(runnerPromise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ status: 'timeout' });
    }, timeoutMs);
    Promise.resolve(runnerPromise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v && typeof v === 'object' ? v : { status: 'error', message: 'malformed runner result' });
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: 'error', message: String(err?.message ?? err) });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Finding builders (pure over runner payloads). Never throw.
// ---------------------------------------------------------------------------

function outdatedFindings(outdatedJson, tool, eventId) {
  const out = [];
  try {
    const table = outdatedJson && typeof outdatedJson === 'object' ? outdatedJson : {};
    for (const [name, info] of Object.entries(table)) {
      if (!info || typeof info !== 'object') continue;
      out.push(toDepFinding({
        tool, eventId, ecosystem: 'npm', package: name,
        installed: info.current ?? null, wanted: info.wanted ?? null, latest: info.latest ?? null,
        severity: 'info',
        advisory: `outdated: ${info.current ?? '?'} → wanted ${info.wanted ?? '?'} / latest ${info.latest ?? '?'}`,
        fixedIn: info.wanted ?? info.latest ?? null,
        source: 'npm-outdated',
      }));
      if (out.length >= MAX_DEP_FINDINGS) break;
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

function auditFindings(auditJson, tool, eventId) {
  const out = [];
  try {
    const advisories = auditJson?.advisories && typeof auditJson.advisories === 'object'
      ? Object.values(auditJson.advisories) : [];
    for (const adv of advisories) {
      if (!adv || typeof adv !== 'object') continue;
      out.push(toDepFinding({
        tool, eventId, ecosystem: 'npm',
        package: adv.module_name ?? adv.name ?? null,
        installed: adv.found_by?.version ?? null,
        wanted: null, latest: adv.patched_versions ?? null,
        severity: adv.severity ?? 'info',
        advisory: adv.title ?? adv.url ?? adv.id ?? 'npm audit advisory',
        fixedIn: adv.patched_versions ?? null,
        source: 'npm-audit',
      }));
      if (out.length >= MAX_DEP_FINDINGS) break;
    }
    // npm v7+ audit format: `vulnerabilities` map.
    const vulns = auditJson?.vulnerabilities && typeof auditJson.vulnerabilities === 'object'
      ? Object.entries(auditJson.vulnerabilities) : [];
    for (const [name, v] of vulns) {
      if (!v || typeof v !== 'object') continue;
      const via = Array.isArray(v.via) ? v.via.find((x) => x && typeof x === 'object') : null;
      out.push(toDepFinding({
        tool, eventId, ecosystem: 'npm', package: name,
        installed: v.range ?? null, wanted: null, latest: v.fixAvailable ?? null,
        severity: v.severity ?? 'info',
        advisory: (via && (via.title || via.url)) || `npm audit: ${name} ${v.severity ?? ''}`.trim(),
        fixedIn: typeof v.fixAvailable === 'string' ? v.fixAvailable
          : (v.fixAvailable && v.fixAvailable.version) || null,
        source: 'npm-audit',
      }));
      if (out.length >= MAX_DEP_FINDINGS) break;
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

function osvFindings(vulns, ecosystem, name, installed, tool, eventId) {
  const out = [];
  try {
    for (const v of vulns || []) {
      if (!v || typeof v !== 'object') continue;
      const sev = Array.isArray(v.severity) && v.severity[0]?.score
        ? 'high' : (v.database_specific?.severity ?? 'info');
      let fixedIn = null;
      try {
        for (const aff of v.affected || []) {
          for (const r of aff.ranges || []) {
            const fix = (r.events || []).find((e) => e && e.fixed);
            if (fix?.fixed) { fixedIn = fix.fixed; break; }
          }
          if (fixedIn) break;
        }
      } catch {
        /* fixed lookup is best-effort */
      }
      out.push(toDepFinding({
        tool, eventId, ecosystem, package: name, installed: installed ?? null,
        wanted: null, latest: null,
        severity: typeof sev === 'string' ? sev : 'info',
        advisory: v.summary || v.id || 'OSV advisory',
        fixedIn,
        source: 'osv.dev',
      }));
      if (out.length >= MAX_DEP_FINDINGS) break;
    }
  } catch {
    /* fall through with what we have */
  }
  return out;
}

function unavailableFinding(ecosystem, detail, tool, eventId) {
  return toDepFinding({
    tool, eventId, ecosystem, package: null, installed: null,
    wanted: null, latest: null, severity: 'info',
    advisory: `feed unavailable: ${detail} (recorded; action allowed)`,
    fixedIn: null, source: 'unavailable',
  });
}

// ---------------------------------------------------------------------------
// Manifest discovery (explicit texts win; disk fallback; never throws).
// ---------------------------------------------------------------------------

function readText(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

const PIP_CANDIDATES = ['requirements.txt', 'requirements-dev.txt', 'requirements/prod.txt', 'pyproject.toml', 'Pipfile', 'Pipfile.lock'];
const COMPOSE_CANDIDATES = [
  'config/docker-compose.infra.yml',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'docker-compose.infra.yml', 'config/docker-compose.yml',
];
const DOCKERFILE_CANDIDATES = ['Dockerfile', 'Dockerfile.dev', 'docker/Dockerfile'];

function discoverManifests(root) {
  const found = {
    packageJson: null, pipTexts: [], containerTexts: [], workflowTexts: [],
    pipFiles: [], containerFiles: [], workflowFiles: [],
  };
  try {
    if (!root || typeof root !== 'string') return found;
    const pkg = readText(path.join(root, 'package.json'));
    if (typeof pkg === 'string' && pkg.trim()) found.packageJson = pkg;
    for (const rel of PIP_CANDIDATES) {
      const t = readText(path.join(root, rel));
      if (typeof t === 'string' && t.trim()) {
        found.pipTexts.push(t);
        found.pipFiles.push(rel);
      }
    }
    for (const rel of COMPOSE_CANDIDATES) {
      const t = readText(path.join(root, rel));
      if (typeof t === 'string' && t.trim()) {
        found.containerTexts.push(t);
        found.containerFiles.push(rel);
      }
    }
    for (const rel of DOCKERFILE_CANDIDATES) {
      const t = readText(path.join(root, rel));
      if (typeof t === 'string' && t.trim()) {
        found.containerTexts.push(t);
        found.containerFiles.push(rel);
      }
    }
    try {
      const wfDir = path.join(root, '.github', 'workflows');
      for (const f of readdirSync(wfDir)) {
        if (!/\.(ya?ml)$/i.test(f)) continue;
        const t = readText(path.join(wfDir, f));
        if (typeof t === 'string' && t.trim()) {
          found.workflowTexts.push(t);
          found.workflowFiles.push(`.github/workflows/${f}`);
        }
      }
    } catch {
      /* no workflows dir — actions surface absent */
    }
  } catch {
    /* discovery never throws */
  }
  return found;
}

// ---------------------------------------------------------------------------
// checkDeps — the scanner. ALWAYS resolves; NEVER returns deny.
// ---------------------------------------------------------------------------

/**
 * Scan all four ecosystems. ALWAYS resolves
 * `{ allowed: true, ecosystems: { npm, pip, containers, actions } }` where
 * each ecosystem is `{ status: 'scanned' | 'unavailable' | 'absent',
 * findings: [...] }`. `allowed` is unconditionally `true` and no `deny`
 * verdict appears anywhere — severities never block. Offline/feed failures
 * degrade to a RECORDED `unavailable` entry, never a throw.
 *
 * Options (all optional): `root` (disk discovery), `manifests`
 * (`{ packageJson, pipTexts, containerTexts, workflowTexts }` — explicit
 * texts win over disk), `runOutdated` / `runAudit` / `queryOsv` (injected
 * runners; defaults hit real `npm` / OSV.dev), `osvTimeoutMs`, `cwd`,
 * `tool`, `eventId` (carried onto every finding).
 */
export async function checkDeps(opts = {}) {
  try {
    const tool = resolveTool(opts);
    const eventId = resolveEventId(opts);
    const cwd = opts.cwd || opts.root || process.cwd();
    const osvBudget = Number.isFinite(Number(opts.osvTimeoutMs)) && Number(opts.osvTimeoutMs) >= 0
      ? Number(opts.osvTimeoutMs) : OSV_TIMEOUT_MS;
    const runOutdated = typeof opts.runOutdated === 'function' ? opts.runOutdated : defaultRunOutdated;
    const runAudit = typeof opts.runAudit === 'function' ? opts.runAudit : defaultRunAudit;
    const queryOsv = typeof opts.queryOsv === 'function' ? opts.queryOsv : defaultQueryOsv;

    const discovered = discoverManifests(
      typeof opts.root === 'string' && opts.root ? opts.root : cwd,
    );
    const m = opts.manifests && typeof opts.manifests === 'object' ? opts.manifests : {};
    const packageJson = typeof m.packageJson === 'string' ? m.packageJson : discovered.packageJson;
    const pipTexts = Array.isArray(m.pipTexts) ? m.pipTexts : discovered.pipTexts;
    const containerTexts = Array.isArray(m.containerTexts) ? m.containerTexts : discovered.containerTexts;
    const workflowTexts = Array.isArray(m.workflowTexts) ? m.workflowTexts : discovered.workflowTexts;

    const ecosystems = {};

    // --- npm: local signals primary, OSV best-effort enrichment. ---
    if (packageJson) {
      const findings = [];
      let localOk = false;
      try {
        const [outRes, audRes] = await Promise.all([
          runBounded(runOutdated({ cwd, timeoutMs: osvBudget }), osvBudget),
          runBounded(runAudit({ cwd, timeoutMs: osvBudget }), osvBudget),
        ]);
        if (outRes?.status === 'ok') {
          localOk = true;
          findings.push(...outdatedFindings(outRes.json, tool, eventId));
        }
        if (audRes?.status === 'ok') {
          localOk = true;
          findings.push(...auditFindings(audRes.json, tool, eventId));
        }
      } catch {
        /* local-signal faults degrade below */
      }
      if (!localOk) {
        ecosystems.npm = {
          status: 'unavailable',
          findings: [unavailableFinding('npm', 'npm outdated/audit unreachable', tool, eventId)],
        };
      } else {
        // OSV enrichment is best-effort inside the remaining budget: a feed
        // failure here never flips a scanned ecosystem to unavailable.
        try {
          const deps = parseNpmDeps(packageJson).slice(0, MAX_OSV_PACKAGES);
          const enriched = await runBounded(
            (async () => {
              const extra = [];
              for (const d of deps) {
                const r = await queryOsv({
                  ecosystem: 'npm', package: d.name,
                  version: String(d.spec || '').replace(/^[\^~>=<\s]+/, '').split(' ')[0] || undefined,
                  timeoutMs: osvBudget,
                });
                if (r?.status === 'ok') {
                  extra.push(...osvFindings(r.vulns, 'npm', d.name, d.spec, tool, eventId));
                }
                if (extra.length >= MAX_DEP_FINDINGS) break;
              }
              return { status: 'ok', extra };
            })(),
            osvBudget,
          );
          if (enriched?.status === 'ok' && Array.isArray(enriched.extra)) {
            findings.push(...enriched.extra);
          }
        } catch {
          /* enrichment is best-effort */
        }
        ecosystems.npm = { status: 'scanned', findings: findings.slice(0, MAX_DEP_FINDINGS) };
      }
    } else {
      ecosystems.npm = { status: 'absent', findings: [] };
    }

    // --- pip: manifest parse + OSV (no local scanner); feed failure → unavailable. ---
    const pipDeps = parsePipDeps(pipTexts);
    if (pipTexts.length === 0 && pipDeps.length === 0) {
      ecosystems.pip = { status: 'absent', findings: [] };
    } else {
      let scanned = false;
      const findings = [];
      try {
        const res = await runBounded(
          (async () => {
            const extra = [];
            for (const d of pipDeps.slice(0, MAX_OSV_PACKAGES)) {
              const r = await queryOsv({
                ecosystem: 'PyPI', package: d.name,
                version: String(d.spec || '').replace(/^[=<>!~,\s]+/, '').split(/[;, ]/)[0] || undefined,
                timeoutMs: osvBudget,
              });
              if (r?.status === 'ok') {
                extra.push(...osvFindings(r.vulns, 'pip', d.name, d.spec, tool, eventId));
              }
              if (extra.length >= MAX_DEP_FINDINGS) break;
            }
            return { status: 'ok', extra };
          })(),
          osvBudget,
        );
        if (res?.status === 'ok') {
          scanned = true;
          findings.push(...res.extra);
        }
      } catch {
        /* feed faults degrade below */
      }
      ecosystems.pip = scanned
        ? { status: 'scanned', findings: findings.slice(0, MAX_DEP_FINDINGS) }
        : {
            status: 'unavailable',
            findings: [unavailableFinding('pip', 'OSV.dev unreachable for PyPI lookup', tool, eventId)],
          };
    }

    // --- containers: static scan (always decisive when manifests exist). ---
    if (containerTexts.length === 0) {
      ecosystems.containers = { status: 'absent', findings: [] };
    } else {
      const findings = [];
      for (const ref of parseContainerImages(containerTexts)) {
        if (isFloatingImage(ref)) {
          findings.push(toDepFinding({
            tool, eventId, ecosystem: 'containers', package: ref.image,
            installed: ref.tag ?? '(implicit latest)', wanted: null, latest: null,
            severity: 'info',
            advisory: `floating base image tag \`${ref.tag ?? 'latest'}\`: pin to a digest or immutable tag`,
            fixedIn: null, source: ref.source,
          }));
        }
        if (findings.length >= MAX_DEP_FINDINGS) break;
      }
      ecosystems.containers = { status: 'scanned', findings };
    }

    // --- actions: static `uses:` pin scan (always decisive when workflows exist). ---
    if (workflowTexts.length === 0) {
      ecosystems.actions = { status: 'absent', findings: [] };
    } else {
      const findings = [];
      for (const pin of parseActionPins(workflowTexts)) {
        if (!pin.pinned) {
          findings.push(toDepFinding({
            tool, eventId, ecosystem: 'actions', package: pin.uses,
            installed: pin.ref, wanted: null, latest: null,
            severity: 'info',
            advisory: `unpinned action ref \`${pin.ref ?? '(none)'}\`: pin to a major version or commit SHA`,
            fixedIn: null, source: 'actions-scan',
          }));
        }
        if (findings.length >= MAX_DEP_FINDINGS) break;
      }
      ecosystems.actions = { status: 'scanned', findings };
    }

    return { allowed: true, ecosystems };
  } catch {
    // Last resort: fail-open allow with recorded unavailability everywhere.
    // This path is unreachable by construction (every phase is guarded), but
    // the never-throws contract is pinned, so it stays.
    try {
      const tool = DEP_HEALTH_TOOL;
      const ecosystems = {};
      for (const eco of ECOSYSTEMS) {
        ecosystems[eco] = { status: 'unavailable', findings: [unavailableFinding(eco, 'internal fault', tool, null)] };
      }
      return { allowed: true, ecosystems };
    } catch {
      return { allowed: true, ecosystems: {} };
    }
  }
}

// ---------------------------------------------------------------------------
// depHealthCoverage — the mechanical QA gate. Pure. Never throws.
// ---------------------------------------------------------------------------

/**
 * QA/programmer self-check over per-ecosystem reports. Returns
 * `{ pass, gaps[] }` — fails IFF a present ecosystem lacks a report or
 * findings went unrecorded:
 * - `scanned` + findings array → pass (findings may be empty = clean).
 * - `unavailable` + recorded findings (≥1 entry) → pass (feed outage is a
 *   recorded fact, not a gate failure).
 * - `absent` → pass WITH a note in `gaps[]` (no manifests to check).
 * - missing report (key absent / null) → FAIL.
 * - findings unrecorded (no findings array, or explicit `recorded: false`,
 *   or `unavailable` with zero entries) → FAIL.
 * - unknown status → FAIL.
 *
 * Severities NEVER fail the gate — only missing/unrecorded checks do.
 */
export function depHealthCoverage(reports) {
  try {
    const gaps = [];
    const r = reports && typeof reports === 'object' ? reports : {};
    for (const eco of ECOSYSTEMS) {
      const rep = r[eco];
      if (!rep || typeof rep !== 'object') {
        gaps.push({ ecosystem: eco, reason: 'missing report', fail: true });
        continue;
      }
      if (rep.recorded === false) {
        gaps.push({ ecosystem: eco, reason: 'findings unrecorded', fail: true });
        continue;
      }
      const status = rep.status;
      const findings = rep.findings;
      if (status === 'absent') {
        gaps.push({ ecosystem: eco, reason: 'absent — no manifests (pass-with-note)', fail: false });
      } else if (status === 'scanned') {
        if (!Array.isArray(findings)) {
          gaps.push({ ecosystem: eco, reason: 'findings unrecorded', fail: true });
        }
      } else if (status === 'unavailable') {
        if (!Array.isArray(findings) || findings.length === 0) {
          gaps.push({ ecosystem: eco, reason: 'findings unrecorded', fail: true });
        }
      } else {
        gaps.push({ ecosystem: eco, reason: `unknown status \`${String(status)}\``, fail: true });
      }
    }
    const failures = gaps.filter((g) => g.fail);
    return { pass: failures.length === 0, gaps };
  } catch {
    return { pass: false, gaps: [{ ecosystem: '(all)', reason: 'coverage evaluation fault', fail: true }] };
  }
}

// ---------------------------------------------------------------------------
// Bus consumer: advisory findings → audit log + counts-only toast.
// ---------------------------------------------------------------------------

/** Best-effort toast: counts only, never any finding text. Never throws. */
export function notifyDepSummary(opts, summary) {
  try {
    const fn = typeof opts?.notify === 'function' ? opts.notify : defaultDepHostNotify(opts?.host);
    if (typeof fn !== 'function') return;
    try {
      const r = fn(summary);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* notify is best-effort */
    }
  } catch {
    /* never throws */
  }
}

function defaultDepHostNotify(host) {
  if (!host || typeof host !== 'object') return null;
  try {
    const show = host.ui?.toast?.show;
    if (typeof show === 'function') {
      return (s) => show.call(host.ui.toast, {
        title: 'IUMBTEMS dep-health',
        message: s.message,
        variant: 'info',
        duration: 4000,
      });
    }
  } catch {
    /* fall through */
  }
  try {
    const sink = host.client?.app?.log;
    if (typeof sink === 'function') {
      return (s) => sink.call(host.client.app, {
        body: { service: 'iumbtems', level: 'info', message: `dep-health: ${s.message}` },
      });
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Build the bus handler. Never throws into the bus and NEVER returns deny:
 * findings → `{ verdict: 'advisory', reason: '<n> finding(s)…' }` (each
 * finding additionally audit-logged via one `notification` record);
 * clean/absent → fail-open `allow` (carries a `reason` so the single audit
 * entry identifies the skip; no toast).
 */
export function createDepHealthHandler(bus, opts = {}) {
  const runOpts = { ...opts };
  return async function depHealthHandler(payload) {
    try {
      const res = await checkDeps({ ...runOpts, tool: payload?.tool, eventId: payload?.eventId });
      const ecosystems = (res && res.ecosystems) || {};
      const findings = [];
      for (const eco of ECOSYSTEMS) {
        const rep = ecosystems[eco];
        if (rep && Array.isArray(rep.findings)) findings.push(...rep.findings);
      }
      if (findings.length === 0) {
        return { verdict: 'allow', reason: 'dep-health: no findings; skipped' };
      }
      // Every finding audit-logged on the bus (one `notification` record
      // each; the audit sink below turns each into exactly one audit entry
      // carrying tool/eventId). Best-effort and awaited.
      if (bus && typeof bus.emit === 'function') {
        for (const f of findings) {
          try {
            await bus.emit('notification', { ...f, auditKind: DEP_AUDIT_KIND });
          } catch {
            /* one finding's audit record must not drop the rest */
          }
        }
      }
      const ecos = new Set(findings.map((f) => f.ecosystem).filter(Boolean));
      notifyDepSummary(runOpts, {
        title: 'IUMBTEMS dep-health',
        message: `dep-health: ${findings.length} finding(s) across ${ecos.size} ecosystem(s) (advisory; action allowed)`,
      });
      return {
        verdict: 'advisory',
        reason: `dep-health: ${findings.length} finding(s) across ${ecos.size} ecosystem(s) (advisory; action allowed)`,
      };
    } catch {
      return { verdict: 'allow', reason: 'dep-health: internal fault; fail-open allow' };
    }
  };
}

/**
 * Internal audit sink on `notification`: turns each per-finding record into
 * exactly one audit entry (fail-open `allow`, so it never blocks anything).
 * Finding detail (ecosystem / package / severity, length-capped) rides in
 * the entry's `reason` — `tool`/`eventId` travel in the entry's dedicated
 * keys. Non-dep-health notifications pass through as plain `allow`.
 */
export function depHealthAuditSink(payload) {
  try {
    if (payload && payload.auditKind === DEP_AUDIT_KIND) {
      const eco = typeof payload.ecosystem === 'string' && payload.ecosystem ? payload.ecosystem : '?';
      const pkg = typeof payload.package === 'string' && payload.package ? payload.package : '?';
      const severity = typeof payload.severity === 'string' && payload.severity ? payload.severity : 'info';
      let advisory = typeof payload.advisory === 'string' ? payload.advisory : '';
      if (advisory.length > 300) advisory = `${advisory.slice(0, 297)}...`;
      return { verdict: 'allow', reason: `dep-health-finding ${eco} ${pkg} [${severity}] ${advisory}` };
    }
  } catch {
    /* fall through to plain allow */
  }
  return 'allow';
}

/**
 * Adopt the dep-health consumer alongside the existing registrations (same
 * adopt/best-effort pattern as `setup` in `index.js`). Subscribes the
 * advisory handler on the action-time events plus the audit sink on
 * `notification`; attaches the registration to the host for debugging
 * (`host.iumbtemsDepHealth`, best-effort). Returns a disposable
 * registration; returns null (never throws) when there is no bus to adopt.
 */
export async function registerDepHealth(host, opts = {}) {
  try {
    const bus = opts.bus || null;
    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') return null;
    const runOpts = { ...opts, host };
    const handler = createDepHealthHandler(bus, runOpts);
    const unsubs = [];
    for (const event of DEP_HEALTH_EVENTS) {
      try {
        unsubs.push(bus.on(event, handler, { tier: 'slow', name: 'dep-health' }));
      } catch {
        /* one failed subscription must not drop the rest */
      }
    }
    try {
      unsubs.push(bus.on('notification', depHealthAuditSink, { tier: 'slow', name: 'dep-health-audit-sink' }));
    } catch {
      /* sink is best-effort */
    }
    if (unsubs.length === 0) return null;
    try {
      if (host && typeof host === 'object') host.iumbtemsDepHealth = { bus, events: [...DEP_HEALTH_EVENTS] };
    } catch {
      /* host attach is best-effort */
    }
    let disposed = false;
    return {
      bus,
      events: [...DEP_HEALTH_EVENTS],
      dispose: () => {
        disposed = true;
        for (const unsub of unsubs) {
          try {
            if (typeof unsub === 'function') unsub();
          } catch {
            /* dispose never throws */
          }
        }
        try {
          if (host && typeof host === 'object' && host.iumbtemsDepHealth?.bus === bus) {
            delete host.iumbtemsDepHealth;
          }
        } catch {
          /* dispose never throws */
        }
      },
      get disposed() {
        return disposed;
      },
    };
  } catch {
    return null;
  }
}
