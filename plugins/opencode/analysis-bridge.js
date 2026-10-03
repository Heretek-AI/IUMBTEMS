/**
 * IUMBTEMS analysis bridge (Phase 02-lsp-bridge): first hook-bus consumer.
 *
 * CLI-invocation bridge (no persistent LSP servers): subscribes to the
 * Phase-01 six-event bus for `pre-tool-use`, `post-tool-use`, and
 * `pre-commit` with `*.js`/`*.ts` targets, runs the pinned analyzer CLI
 * inside the fast-tier budget, and reports findings as ADVISORY annotations
 * `{ allowed: true, annotations: [...] }`. The bridge NEVER returns deny —
 * even severe findings allow (all-advisory per gate L2; pinned by
 * `test_analysis_bridge.py::TestNeverDeny`).
 *
 * Findings shape: `{ tool, eventId, rule, file, line, message, severity }`.
 * Every finding is audit-logged on the bus (one `notification` record per
 * finding via the internal audit sink, each carrying `tool`/`eventId`); the
 * toast summarizes counts only (no finding text, no log spam).
 *
 * Analyzer-missing (devDep not installed, e.g. fresh checkout): single audit
 * entry (the handler's own fail-open `allow`) + silent skip — never throws,
 * never blocks, no toast.
 *
 * Zero runtime dependencies (node builtins only); the single analyzer is a
 * pinned devDependency (Biome, single dep, zero-config, lint+format JS/TS).
 *
 * Phase evidence (cited per programmer brief):
 * - Bus contract (six events, 3 host-enforced / 1 advisory / 2 bus-level,
 *   tiered enforcement, fail-open, tool/eventId audit guarantees)
 *   [VERIFIED: sha256:f2c0843b598ba6f19cc0e208f8d02e0250c70615e3c484474d50635d0b5cdef8
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/hook-bus.js`]
 * - Host emit points (pre/post-tool-use own-tools scope, pre-commit both
 *   legs, session-start advisory; stop/notification bus-level-only)
 *   [VERIFIED: sha256:640ab94a0408cef8cc14fb2cbf52f041021a1ce012590b41e8063075a21b2c8f
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/index.js`]
 * - Parity table (ENFORCED vs BUS-LEVEL-ONLY split; `tool.execute.before`
 *   gap)
 *   [VERIFIED: sha256:69cacc4b62c2c1fccd5f5f3cf4d78398eb7310ceeb36e9ef423868e530771d90
 *   `file:///home/john/Projects/IUMBTEMS/docs/HOOK_BUS_PARITY.md`]
 * - package.json baseline (no devDependencies; the single approved delta)
 *   [VERIFIED: sha256:2b08ae78a2475e7d3b3427ba089542f8bd76635b87ab397066af8c0355651fbd
 *   `file:///home/john/Projects/IUMBTEMS/package.json`]
 * - Consumer contract inherited (scoped bus tests incl. shipped-path
 *   threading, fallback tags, audit key guarantees, emit-latency bound)
 *   [VERIFIED: sha256:7cbceba66852b3d8405d78833d0ce1dad7a25423af59cbacdea2790ba83e4b2a
 *   `file:///home/john/Projects/IUMBTEMS/runner/tests/test_hook_bus.py`]
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_TIMEOUT_MS } from './hook-bus.js';

/** Tool tag carried on every finding and audit record from this bridge. */
export const BRIDGE_TOOL = 'analysis-bridge';

/** Bus events this bridge consumes (gate L2/L3: advisory JS/TS analysis). */
export const BRIDGE_EVENTS = Object.freeze([
  'pre-tool-use',
  'post-tool-use',
  'pre-commit',
]);

/**
 * Analyzer budget: the fast-tier budget. The analyzer must settle inside it;
 * an overrun degrades to a single `analysis-bridge/timeout` annotation and
 * the caller stays unblocked (fail-open allow).
 */
export const ANALYZER_TIMEOUT_MS = FAST_TIMEOUT_MS;

/** Cap on findings returned per analysis (bounds audit + toast fan-out). */
export const MAX_FINDINGS = 50;

/** Cap on target files per analysis (bounds CLI argv + runtime). */
export const MAX_TARGET_FILES = 20;

/** Marker distinguishing per-finding audit records on `notification`. */
export const AUDIT_KIND = 'analysis-finding';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');

/** JS/TS targets: .js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts (case-insensitive). */
export function isJsTsFile(p) {
  return typeof p === 'string' && /\.(m|c)?[jt]sx?$/i.test(p.trim());
}

function pushCandidate(out, seen, v, root, skipped) {
  if (typeof v !== 'string') return;
  const t = v.trim();
  if (!t || t.includes('\0') || t.startsWith('-')) return;
  if (!isJsTsFile(t)) return;
  const resolvedRoot = root ? path.resolve(root) : process.cwd();
  const abs = path.resolve(resolvedRoot, t);
  const rel = path.relative(resolvedRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    if (skipped) skipped.push(t);
    return;
  }
  try {
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      const realRoot = realpathSync(resolvedRoot);
      const realRel = path.relative(realRoot, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        if (skipped) skipped.push(t);
        return;
      }
    }
  } catch {
    /* fail safe */
  }
  if (seen.has(t)) return;
  seen.add(t);
  out.push(t);
}

/**
 * Collect `*.js`/`*.ts` target paths from a bus payload. Inspects the
 * conventional locator fields (`file`, `files`, `path`, `paths`,
 * `filename`, `filenames`) plus a one-level scan of `args` values (plain
 * strings or arrays of strings, e.g. an edit tool's file argument).
 * Confines targets to the project root, rejects option-like flags (`-x`),
 * de-duplicates, and caps at `MAX_TARGET_FILES`. Never throws.
 */
export function collectTargets(payload, opts = {}) {
  try {
    const out = [];
    const seen = new Set();
    const skipped = Array.isArray(opts?.skipped) ? opts.skipped : null;
    const root = opts?.root || opts?.cwd || process.cwd();
    if (!payload || typeof payload !== 'object') return out;
    for (const key of ['file', 'files', 'path', 'paths', 'filename', 'filenames']) {
      const v = payload[key];
      if (Array.isArray(v)) {
        for (const item of v) pushCandidate(out, seen, item, root, skipped);
      } else {
        pushCandidate(out, seen, v, root, skipped);
      }
    }
    const args = payload.args;
    if (args && typeof args === 'object') {
      for (const v of Object.values(args)) {
        if (Array.isArray(v)) {
          for (const item of v) pushCandidate(out, seen, item, root, skipped);
        } else {
          pushCandidate(out, seen, v, root, skipped);
        }
      }
    }
    return out.slice(0, MAX_TARGET_FILES);
  } catch {
    return [];
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

function resolveTool(payload) {
  try {
    const v = payload?.tool;
    return typeof v === 'string' && v.trim() ? v : BRIDGE_TOOL;
  } catch {
    return BRIDGE_TOOL;
  }
}

/**
 * Normalise one finding. Every key is ALWAYS present (`file`/`line` are
 * `null` when unknown, e.g. timeout annotations) so audit consumers can
 * rely on shape — the same guarantee the bus gives `tool`/`eventId`.
 */
export function toFinding({ tool, eventId, rule, file, line, message, severity }) {
  return {
    tool: typeof tool === 'string' && tool ? tool : BRIDGE_TOOL,
    eventId: eventId ?? null,
    rule: typeof rule === 'string' && rule ? rule : 'analysis-bridge/unknown',
    file: typeof file === 'string' && file ? file : null,
    line: Number.isFinite(Number(line)) && Number(line) > 0 ? Number(line) : null,
    message: typeof message === 'string' && message ? message : '',
    severity: typeof severity === 'string' && severity ? severity.toLowerCase() : 'info',
  };
}

function timeoutFinding(tool, eventId, targets, timeoutMs) {
  return toFinding({
    tool,
    eventId,
    rule: 'analysis-bridge/timeout',
    file: targets.length > 0 ? targets[0] : null,
    line: null,
    message: `analyzer exceeded the ${timeoutMs}ms fast-tier budget; skipped (advisory, action allowed)`,
    severity: 'info',
  });
}

function errorFinding(tool, eventId, targets, message) {
  return toFinding({
    tool,
    eventId,
    rule: 'analysis-bridge/error',
    file: targets.length > 0 ? targets[0] : null,
    line: null,
    message: `analyzer error: ${message} (advisory, action allowed)`,
    severity: 'info',
  });
}

/** Locate the Biome binary: project devDep first, then repo devDep, then PATH fallback. */
export function findAnalyzerBin(root) {
  try {
    if (root) {
      const projectLocal = path.join(root, 'node_modules', '.bin', 'biome');
      if (existsSync(projectLocal)) return projectLocal;
    }
  } catch {
    /* fall through */
  }
  try {
    const local = path.join(PKG_ROOT, 'node_modules', '.bin', 'biome');
    if (existsSync(local)) return local;
  } catch {
    /* fall through to PATH lookup */
  }
  return 'biome';
}

function parseBiomeJson(stdout, tool, eventId) {
  const findings = [];
  try {
    const parsed = JSON.parse(String(stdout || ''));
    const diags = Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [];
    for (const d of diags) {
      if (!d || typeof d !== 'object') continue;
      findings.push(toFinding({
        tool,
        eventId,
        rule: typeof d.category === 'string' && d.category ? d.category : 'biome/unknown',
        file: d.location?.path ?? null,
        line: d.location?.start?.line ?? null,
        message: typeof d.message === 'string' ? d.message : '',
        severity: typeof d.severity === 'string' ? d.severity : 'info',
      }));
      if (findings.length >= MAX_FINDINGS) break;
    }
  } catch {
    /* unparseable output: no findings (never throws) */
  }
  return findings;
}

/**
 * Default analyzer: `biome lint --reporter=json` over the target files.
 * Resolves `{ status: 'ok', findings }`, `{ status: 'missing' }` (binary
 * absent), `{ status: 'timeout' }` (overrun; child killed), or
 * `{ status: 'error', message }`. Never rejects, never throws.
 */
export function defaultRunAnalyzer(files, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? ANALYZER_TIMEOUT_MS);
  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : ANALYZER_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(
        findAnalyzerBin(opts.root || opts.cwd),
        [
          'lint',
          '--reporter=json',
          '--max-diagnostics=50',
          '--diagnostic-level=info',
          '--colors=off',
          '--files-ignore-unknown=true',
          '--',
          ...files,
        ],
        { cwd: opts.cwd || process.cwd() },
      );
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
      const code = err?.code;
      if (code === 'ENOENT') {
        finish({ status: 'missing' });
      } else {
        finish({ status: 'error', message: String(err?.message ?? err) });
      }
    });
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.on('close', () => {
      if (done) return;
      clearTimeout(timer);
      finish({ status: 'ok', stdout });
    });
  });
}

/** Race any runner against the fast-tier budget. Never rejects. */
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
        resolve(v && typeof v === 'object' ? v : { status: 'error', message: 'malformed analyzer result' });
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

/**
 * Analyze one bus payload. ALWAYS resolves `{ allowed: true, annotations }`
 * — this function cannot deny (all-advisory per gate L2) and never throws:
 * internal faults degrade to a single `analysis-bridge/error` annotation.
 * `annotations` are findings in `{ tool, eventId, rule, file, line, message,
 * severity }` shape; empty when clean, targetless, or analyzer-missing
 * (missing is a silent skip — no annotation, no toast; the handler's own
 * fail-open `allow` is the single audit entry).
 */
export async function analyzePayload(payload, opts = {}) {
  try {
    const tool = resolveTool(payload);
    const eventId = resolveEventId(payload);
    const root = opts.root || opts.cwd || process.cwd();
    const skipped = [];
    const targets = collectTargets(payload, { root, skipped });
    const skippedAnnotations = skipped.slice(0, 10).map((s) => toFinding({
      tool,
      eventId,
      rule: 'analysis-bridge/skipped-target',
      file: s,
      line: null,
      message: `target path outside project root or invalid: ${s} (skipped)`,
      severity: 'info',
    }));

    if (targets.length === 0) return { allowed: true, annotations: skippedAnnotations };
    const timeoutMs = Number(opts.timeoutMs ?? ANALYZER_TIMEOUT_MS);
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : ANALYZER_TIMEOUT_MS;
    const runAnalyzer = typeof opts.runAnalyzer === 'function' ? opts.runAnalyzer : defaultRunAnalyzer;
    const res = await runBounded(
      runAnalyzer(targets, { timeoutMs: budget, cwd: opts.cwd, root }),
      budget,
    );
    if (!res || typeof res !== 'object') {
      return { allowed: true, annotations: [...skippedAnnotations, errorFinding(tool, eventId, targets, 'malformed analyzer result')] };
    }
    if (res.status === 'missing') return { allowed: true, annotations: skippedAnnotations };
    if (res.status === 'timeout') {
      return { allowed: true, annotations: [...skippedAnnotations, timeoutFinding(tool, eventId, targets, budget)] };
    }
    if (res.status === 'error') {
      return { allowed: true, annotations: [...skippedAnnotations, errorFinding(tool, eventId, targets, res.message || 'unknown error')] };
    }
    if (res.status === 'ok' && Array.isArray(res.findings)) {
      const findings = res.findings
        .filter((f) => f && typeof f === 'object' && !Array.isArray(f))
        .slice(0, MAX_FINDINGS)
        .map((f) => toFinding({ ...f, tool: f?.tool ?? tool, eventId: f?.eventId ?? eventId }));
      return { allowed: true, annotations: [...skippedAnnotations, ...findings] };
    }
    if (typeof res.stdout === 'string') {
      // Default-runner raw form: parse Biome JSON reporter output here so
      // injected mocks may return either parsed findings or raw stdout.
      return { allowed: true, annotations: [...skippedAnnotations, ...parseBiomeJson(res.stdout, tool, eventId)] };
    }
    return { allowed: true, annotations: [...skippedAnnotations, errorFinding(tool, eventId, targets, 'malformed analyzer result')] };
  } catch (err) {
    // Last resort: fail-open allow with a single error annotation.
    try {
      return {
        allowed: true,
        annotations: [toFinding({
          tool: BRIDGE_TOOL,
          eventId: null,
          rule: 'analysis-bridge/error',
          file: null,
          line: null,
          message: `analyzer error: ${String(err?.message ?? err)} (advisory, action allowed)`,
          severity: 'info',
        })],
      };
    } catch {
      return { allowed: true, annotations: [] };
    }
  }
}

/**
 * Best-effort toast: counts only (`N finding(s) in M file(s)`), never any
 * finding text. Resolves the notifier from `opts.notify`, else from the
 * host (`ui.toast.show` → `client.app.log`), else a no-op. Never throws.
 */
export function notifySummary(opts, summary) {
  try {
    const fn = typeof opts?.notify === 'function' ? opts.notify : defaultHostNotify(opts?.host);
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

function defaultHostNotify(host) {
  if (!host || typeof host !== 'object') return null;
  try {
    const show = host.ui?.toast?.show;
    if (typeof show === 'function') {
      return (s) => show.call(host.ui.toast, {
        title: 'IUMBTEMS analysis',
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
        body: { service: 'iumbtems', level: 'info', message: `analysis: ${s.message}` },
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
 * clean/targetless/missing → fail-open `allow` (missing carries a
 * `reason` so the single audit entry identifies the skip; no toast).
 */
export function createBridgeHandler(bus, opts = {}) {
  const runOpts = { ...opts };
  return async function analysisBridgeHandler(payload) {
    try {
      const result = await analyzePayload(payload, runOpts);
      const annotations = Array.isArray(result?.annotations) ? result.annotations : [];
      if (annotations.length === 0) {
        const targets = collectTargets(payload, runOpts);
        if (targets.length === 0) {
          return { verdict: 'allow', reason: 'analysis-bridge: no js/ts targets; skipped' };
        }
        return { verdict: 'allow', reason: 'analysis-bridge: analyzer unavailable or no findings; skipped' };
      }
      // Every finding audit-logged on the bus (one `notification` record
      // each; the audit sink below turns each into exactly one audit entry
      // carrying tool/eventId). Best-effort and awaited: the sink settles
      // synchronously, so this costs microseconds per finding.
      if (bus && typeof bus.emit === 'function') {
        for (const f of annotations) {
          try {
            await bus.emit('notification', {
              tool: f.tool,
              eventId: f.eventId,
              rule: f.rule,
              file: f.file,
              line: f.line,
              message: f.message,
              severity: f.severity,
              auditKind: AUDIT_KIND,
            });
          } catch {
            /* one finding's audit record must not drop the rest */
          }
        }
      }
      const nonSkipped = annotations.filter((f) => f.rule !== 'analysis-bridge/skipped-target');
      if (nonSkipped.length > 0) {
        const files = new Set(nonSkipped.map((f) => f.file).filter(Boolean));
        notifySummary(runOpts, {
          title: 'IUMBTEMS analysis',
          message: `analysis-bridge: ${nonSkipped.length} finding(s) in ${files.size} file(s) (advisory; action allowed)`,
        });
        return {
          verdict: 'advisory',
          reason: `analysis-bridge: ${nonSkipped.length} finding(s) in ${files.size} file(s) (advisory; action allowed)`,
        };
      }
      return {
        verdict: 'allow',
        reason: `analysis-bridge: ${annotations.length} target(s) skipped (advisory; action allowed)`,
      };
    } catch {
      return { verdict: 'allow', reason: 'analysis-bridge: internal fault; fail-open allow' };
    }
  };
}

/**
 * Internal audit sink on `notification`: turns each per-finding record into
 * exactly one audit entry (fail-open `allow`, so it never blocks anything).
 * The bus persists only fixed audit fields, so the finding detail (rule /
 * file / line / severity / message, length-capped) rides in the entry's
 * `reason` — `tool`/`eventId` travel in the entry's dedicated keys.
 * Non-bridge notifications pass through as plain `allow` (no reason added).
 * Named distinctly so the ledger stays readable.
 */
export function analysisBridgeAuditSink(payload) {
  try {
    if (payload && payload.auditKind === AUDIT_KIND) {
      const rule = typeof payload.rule === 'string' && payload.rule ? payload.rule : 'analysis-bridge/unknown';
      const file = typeof payload.file === 'string' && payload.file ? payload.file : '?';
      const line = Number.isFinite(Number(payload.line)) && Number(payload.line) > 0 ? Number(payload.line) : '?';
      const severity = typeof payload.severity === 'string' && payload.severity ? payload.severity : 'info';
      let message = typeof payload.message === 'string' ? payload.message : '';
      if (message.length > 300) message = `${message.slice(0, 297)}...`;
      return { verdict: 'allow', reason: `analysis-finding ${rule} ${file}:${line} [${severity}] ${message}` };
    }
  } catch {
    /* fall through to plain allow */
  }
  return 'allow';
}

/**
 * Adopt the bridge alongside the existing registrations (same
 * adopt/best-effort pattern as `setup` in `index.js`). Subscribes the
 * advisory handler on the three analysis events plus the audit sink on
 * `notification`; attaches the registration to the host for debugging
 * (`host.iumbtemsAnalysisBridge`, best-effort). Returns a disposable
 * registration; returns null (never throws) when there is no bus to adopt.
 */
export async function registerAnalysisBridge(host, opts = {}) {
  try {
    const bus = opts.bus || null;
    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') return null;
    const runOpts = { ...opts, host };
    const handler = createBridgeHandler(bus, runOpts);
    const unsubs = [];
    for (const event of BRIDGE_EVENTS) {
      try {
        unsubs.push(bus.on(event, handler, { tier: 'fast', name: 'analysis-bridge' }));
      } catch {
        /* one failed subscription must not drop the rest */
      }
    }
    try {
      unsubs.push(bus.on('notification', analysisBridgeAuditSink, { tier: 'fast', name: 'analysis-bridge-audit-sink' }));
    } catch {
      /* sink is best-effort */
    }
    if (unsubs.length === 0) return null;
    try {
      if (host && typeof host === 'object') host.iumbtemsAnalysisBridge = { bus, events: [...BRIDGE_EVENTS] };
    } catch {
      /* host attach is best-effort */
    }
    let disposed = false;
    return {
      bus,
      events: [...BRIDGE_EVENTS],
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
          if (host && typeof host === 'object' && host.iumbtemsAnalysisBridge?.bus === bus) {
            delete host.iumbtemsAnalysisBridge;
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
