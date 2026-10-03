/**
 * IUMBTEMS coverage + treeshake advisory signals (Phase 04-coverage-treeshake-signals):
 * coverage deltas (existing unittest suites) + esbuild-measured bundle weight
 * (plugin surface) as advisory dossier annotations + audit log.
 *
 * Third hook-bus consumer (after the Phase-02 analysis bridge and the Phase-03
 * dep-health gate): measures (never emits — `metafile:true, write:false`) and
 * reports everything as ADVISORY annotations. This module NEVER returns deny:
 * even a +500% weight blowup allows (pinned by the never-blocks test); the
 * escalation path is a checked-in baseline + explicit user sign-off, deferred
 * to hardening (Gate-0 R5) — there are NO blocking thresholds in this phase.
 *
 * Bundle record shape: `{ tool, eventId, kind, status, entry, bytes, files,
 * topHeaviest, deltaVsBaseline, baselineStale, message }` — every key ALWAYS
 * present (`null` when unknown), reusing the Phase-02 annotation shape
 * `{ tool, eventId, ... }`. Coverage record shape: `{ tool, eventId, kind,
 * status, scope, passedBefore, totalBefore, passedAfter, totalAfter, delta,
 * direction, message }` — likewise always-present. Every record is
 * audit-logged on the bus (one `notification` record per record via the
 * internal audit sink); the toast summarizes counts only (no record text).
 *
 * esbuild missing/failing or malformed metafile degrades to a RECORDED
 * `unavailable` entry and fail-open allow — never throws into the host (same
 * contract as 02-analyzer-missing / 03-offline).
 *
 * Zero runtime dependencies (node builtins only: fs, path, url). esbuild is a
 * pinned devDependency used for measurement only; it is loaded lazily and its
 * absence is a supported state, never an error.
 *
 * Phase evidence (cited per programmer brief):
 * - Plugin host surface (the measured bundle entry)
 *   [VERIFIED: sha256:f42787d2ce436bbd6d55e90a15d45b656290a1a44451fff3318b094a4582ce01
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/index.js`]
 * - Bus contract (six blockable events, tiered enforcement, fail-open,
 *   tool/eventId audit guarantees) — the annotation transport
 *   [VERIFIED: sha256:f2c0843b598ba6f19cc0e208f8d02e0250c70615e3c484474d50635d0b5cdef8
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/hook-bus.js`]
 * - Never-deny advisory bridge precedent ({allowed:true} on every path,
 *   counts-only toast) — the pattern weight-signals reuses
 *   [VERIFIED: sha256:cd66253fec923d8210d2863f98d9c5669662ac70c3a1939f2bd8ea30ed007644
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/analysis-bridge.js`]
 * - Coverage-gate helper precedent (scanned/unavailable/absent reporting,
 *   severities never fail) — the honest-status vocabulary
 *   [VERIFIED: sha256:da194d498bc256f2b619c406015a3fb600712ec5b8c8ab9001fc38f0a6f5c8cc
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/dep-health.js`]
 * - package.json baseline (runtime solid-js + @opentui/solid only; Biome
 *   2.5.15 the sole devDep — esbuild becomes the second approved devDep)
 *   [VERIFIED: sha256:7690b878a654ee4dee2b649b60740bc95d4b746cf786051887153b6f656f2e5e
 *   `file:///home/john/Projects/IUMBTEMS/package.json`]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOW_TIMEOUT_MS } from './hook-bus.js';

/** Tool tag carried on every record and audit entry from this consumer. */
export const WEIGHT_TOOL = 'weight-signals';

/** Bus events this consumer subscribes (programmer commit-time point). */
export const WEIGHT_EVENTS = Object.freeze(['pre-commit']);

/**
 * Build budget: the whole measure must settle inside it. Kept under the
 * slow-tier budget so a hung esbuild can never brick the caller — an overrun
 * degrades to a recorded `unavailable` entry and fail-open allow.
 */
export const WEIGHT_TIMEOUT_MS = Math.min(4000, SLOW_TIMEOUT_MS - 1000);

/** Cap on heaviest-file entries per bundle record (bounds audit fan-out). */
export const TOP_N_HEAVIEST = 5;

/** Marker distinguishing per-record audit entries on `notification`. */
export const WEIGHT_AUDIT_KIND = 'weight-signal';

/**
 * A baseline older than this is `stale-baseline`: still measured against
 * (deltas still compute) but annotated, still allowing. Refresh is an
 * explicit user-confirmed step, never automatic.
 */
export const BASELINE_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASELINE_FILE = path.join(__dirname, 'weight-baseline.json');

/** Default bundle entry: the plugin host surface (the shipped code). */
export const DEFAULT_ENTRY = path.join(__dirname, 'index.js');

function resolveTool(payload) {
  try {
    const v = payload?.tool;
    return typeof v === 'string' && v.trim() ? v : WEIGHT_TOOL;
  } catch {
    return WEIGHT_TOOL;
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

function numOrNull(v) {
  try {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && !v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Normalise one bundle-weight record. Every key is ALWAYS present (`null`
 * when unknown) so audit/dossier consumers can rely on shape — the same
 * guarantee the bus gives `tool`/`eventId` and the bridge gives its seven
 * finding keys. `status` is `scanned` (measured) or `unavailable` (esbuild
 * missing/failed or metafile malformed — a recorded fact, never a throw).
 */
export function toWeightRecord({
  tool, eventId, status, entry, bytes, files,
  topHeaviest, deltaVsBaseline, baselineStale, message,
}) {
  let top = null;
  try {
    if (Array.isArray(topHeaviest)) {
      top = topHeaviest
        .filter((e) => e && typeof e === 'object')
        .slice(0, TOP_N_HEAVIEST)
        .map((e) => ({
          file: typeof e.file === 'string' && e.file ? e.file : null,
          bytes: numOrNull(e.bytes),
        }));
    }
  } catch {
    top = null;
  }
  let delta = null;
  try {
    if (deltaVsBaseline && typeof deltaVsBaseline === 'object') {
      const b = numOrNull(deltaVsBaseline.bytes);
      const p = numOrNull(deltaVsBaseline.pct);
      delta = b === null && p === null ? null : { bytes: b, pct: p };
    }
  } catch {
    delta = null;
  }
  return {
    tool: typeof tool === 'string' && tool ? tool : WEIGHT_TOOL,
    eventId: eventId ?? null,
    kind: 'bundle-weight',
    status: status === 'scanned' ? 'scanned' : 'unavailable',
    entry: typeof entry === 'string' && entry ? entry : null,
    bytes: numOrNull(bytes),
    files: numOrNull(files),
    topHeaviest: top,
    deltaVsBaseline: delta,
    baselineStale: baselineStale === true,
    message: typeof message === 'string' && message ? message : null,
  };
}

/** The eleven always-present bundle-record keys (pinned by the shape test). */
export const WEIGHT_RECORD_KEYS = Object.freeze([
  'tool', 'eventId', 'kind', 'status', 'entry', 'bytes', 'files',
  'topHeaviest', 'deltaVsBaseline', 'baselineStale', 'message',
]);

/**
 * Normalise one coverage-delta record from unittest tallies. `delta` is the
 * pass-rate delta in percentage points (after − before, 2dp); `direction` is
 * `up` | `down` | `flat` (`flat` inside ±0.5pp), or `unknown` when a tally is
 * missing/empty (status `unavailable` — recorded, never a throw).
 */
export function toCoverageRecord({
  tool, eventId, scope, passedBefore, totalBefore,
  passedAfter, totalAfter, message,
}) {
  const pb = numOrNull(passedBefore);
  const tb = numOrNull(totalBefore);
  const pa = numOrNull(passedAfter);
  const ta = numOrNull(totalAfter);
  const usable =
    pb !== null && tb !== null && pa !== null && ta !== null &&
    tb > 0 && ta > 0 && pb >= 0 && pa >= 0 && pb <= tb && pa <= ta;
  let delta = null;
  let direction = 'unknown';
  let status = 'unavailable';
  if (usable) {
    const raw = (pa / ta - pb / tb) * 100;
    delta = Math.round(raw * 100) / 100;
    direction = delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat';
    status = 'scanned';
  }
  return {
    tool: typeof tool === 'string' && tool ? tool : WEIGHT_TOOL,
    eventId: eventId ?? null,
    kind: 'coverage-delta',
    status,
    scope: typeof scope === 'string' && scope ? scope : null,
    passedBefore: pb,
    totalBefore: tb,
    passedAfter: pa,
    totalAfter: ta,
    delta,
    direction,
    message: typeof message === 'string' && message ? message : null,
  };
}

/** The twelve always-present coverage-record keys (pinned by the shape test). */
export const COVERAGE_RECORD_KEYS = Object.freeze([
  'tool', 'eventId', 'kind', 'status', 'scope', 'passedBefore',
  'totalBefore', 'passedAfter', 'totalAfter', 'delta', 'direction', 'message',
]);

/**
 * Coverage delta from unittest count/pass tallies per scope:
 * `{before: {passed, total}, after: {passed, total}, scope}` →
 * `{delta, direction}` inside a full always-present-keys record. Pure, never
 * throws, NEVER denies (advisory only — the record carries `allowed: true`
 * for bus-consumer uniformity).
 */
export function coverageDelta({ before, after, scope, tool, eventId } = {}) {
  try {
    const rec = toCoverageRecord({
      tool: resolveTool({ tool }),
      eventId: eventId ?? null,
      scope,
      passedBefore: before?.passed,
      totalBefore: before?.total,
      passedAfter: after?.passed,
      totalAfter: after?.total,
      message: scope
        ? `coverage ${scope}: ${before?.passed ?? '?'}/${before?.total ?? '?'} → ${after?.passed ?? '?'}/${after?.total ?? '?'} (advisory; action allowed)`
        : null,
    });
    return { allowed: true, delta: rec.delta, direction: rec.direction, record: rec };
  } catch {
    return {
      allowed: true,
      delta: null,
      direction: 'unknown',
      record: toCoverageRecord({}),
    };
  }
}

// ---------------------------------------------------------------------------
// Metafile parsing (pure) + esbuild runner (lazy, fail-open). Never throw.
// ---------------------------------------------------------------------------

/**
 * Parse an esbuild metafile (`metafile:true`) into
 * `{ status: 'ok', bytes, files, topHeaviest }` where `bytes` sums output
 * bytes, `files` counts distinct inputs (import-graph size), and
 * `topHeaviest` lists the `topN` heaviest inputs. Anything else-shaped
 * resolves `{ status: 'malformed' }`. Never throws.
 */
export function parseMetafile(metafile, { topN } = {}) {
  try {
    const n = Number(topN ?? TOP_N_HEAVIEST);
    const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : TOP_N_HEAVIEST;
    if (!metafile || typeof metafile !== 'object' || Array.isArray(metafile)) {
      return { status: 'malformed' };
    }
    const outputs = metafile.outputs;
    const inputs = metafile.inputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
      return { status: 'malformed' };
    }
    let bytes = 0;
    let sawOutput = false;
    for (const out of Object.values(outputs)) {
      if (!out || typeof out !== 'object') continue;
      const b = Number(out.bytes);
      if (!Number.isFinite(b) || b < 0) return { status: 'malformed' };
      bytes += b;
      sawOutput = true;
    }
    if (!sawOutput) return { status: 'malformed' };
    const entries = [];
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      for (const [file, info] of Object.entries(inputs)) {
        const b = Number(info?.bytes);
        entries.push({ file, bytes: Number.isFinite(b) && b >= 0 ? b : 0 });
      }
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    return {
      status: 'ok',
      bytes,
      files: entries.length,
      topHeaviest: entries.slice(0, cap),
    };
  } catch {
    return { status: 'malformed' };
  }
}

/**
 * Default esbuild runner: bundles `entry` with `metafile:true, write:false`
 * (measure, never emit). Resolves `{ status: 'ok', metafile }`,
 * `{ status: 'missing' }` (esbuild not installed — a supported state), or
 * `{ status: 'error', message }`. Never rejects, never throws.
 */
export function defaultRunBuild({ entry, timeoutMs } = {}) {
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs) : WEIGHT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), budget);
    (async () => {
      let esbuild;
      try {
        esbuild = await import('esbuild');
      } catch {
        clearTimeout(timer);
        finish({ status: 'missing' });
        return;
      }
      try {
        const build = esbuild.build ?? esbuild.default?.build;
        if (typeof build !== 'function') {
          clearTimeout(timer);
          finish({ status: 'error', message: 'esbuild module has no build()' });
          return;
        }
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          metafile: true,
          write: false,
          platform: 'node',
          format: 'esm',
          logLevel: 'silent',
          // esbuild is the measuring tool, not shipped code (this module
          // loads it lazily via dynamic import): keep it external so the
          // weight reflects the plugin surface, not the ruler.
          external: ['esbuild'],
        });
        clearTimeout(timer);
        if (result?.metafile) finish({ status: 'ok', metafile: result.metafile });
        else finish({ status: 'error', message: 'esbuild returned no metafile' });
      } catch (err) {
        clearTimeout(timer);
        finish({ status: 'error', message: String(err?.message ?? err) });
      }
    })().catch((err) => {
      clearTimeout(timer);
      finish({ status: 'error', message: String(err?.message ?? err) });
    });
  });
}

/** Race any runner against the build budget. Never rejects. */
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
        resolve(v && typeof v === 'object' ? v : { status: 'error', message: 'malformed build result' });
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
// Baseline (checked in; refresh is user-confirmed only, never automatic).
// ---------------------------------------------------------------------------

/**
 * Load the checked-in baseline: explicit `text` wins, else read
 * `weight-baseline.json` next to this module. Resolves the parsed object or
 * `null` (missing/unparseable — callers record, never throw). Never throws.
 */
export function loadBaseline({ text, file } = {}) {
  try {
    const raw = typeof text === 'string'
      ? text
      : readFileSync(file || BASELINE_FILE, 'utf-8');
    const parsed = JSON.parse(String(raw || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A baseline is stale when its `measuredAt` is older than `maxAgeMs`
 * (default `BASELINE_STALE_AFTER_MS`). A stale baseline still measures
 * against (deltas still compute) — it only adds a `stale-baseline`
 * annotation, still allowing. Missing/unparseable `measuredAt` counts as
 * stale (honest: age unknown). Never throws.
 */
export function isBaselineStale(baseline, { now, maxAgeMs } = {}) {
  try {
    if (!baseline || typeof baseline !== 'object') return true;
    const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0
      ? Number(maxAgeMs) : BASELINE_STALE_AFTER_MS;
    const at = Date.parse(baseline.measuredAt);
    if (!Number.isFinite(at)) return true;
    const t = now !== undefined ? Number(now) : Date.now();
    if (!Number.isFinite(t)) return true;
    return t - at > maxAge;
  } catch {
    return true;
  }
}

function unavailableRecord(tool, eventId, entry, detail) {
  return toWeightRecord({
    tool, eventId, status: 'unavailable', entry,
    bytes: null, files: null, topHeaviest: null, deltaVsBaseline: null,
    baselineStale: false,
    message: `bundle weight unavailable: ${detail} (recorded; action allowed)`,
  });
}

// ---------------------------------------------------------------------------
// measureBundle + assessWeight — the advisory scanners. NEVER deny.
// ---------------------------------------------------------------------------

/**
 * Measure one bundle entry. ALWAYS resolves `{ allowed: true, annotations }`
 * — this function cannot deny (advisory-only per gate C1) and never throws.
 *
 * Inputs (all optional): `entry` (defaults to the plugin host surface),
 * `metafile` (a precomputed esbuild metafile — parsed directly, no build),
 * `runBuild` (injected runner; defaults to the lazy esbuild build),
 * `baseline` (parsed baseline object; explicit wins, else the checked-in
 * file), `timeoutMs`, `topN`, `tool`, `eventId`.
 *
 * `annotations[0]` is always the bundle-weight record (status `scanned` or
 * `unavailable`); a stale baseline appends a `stale-baseline` record — still
 * allowing. `deltaVsBaseline` is `{bytes, pct}` against `baseline.bytes`
 * (null without a numeric baseline). A +500% blowup still allows.
 */
export async function measureBundle(opts = {}) {
  try {
    const tool = resolveTool(opts);
    const eventId = resolveEventId(opts);
    const entry = typeof opts.entry === 'string' && opts.entry
      ? opts.entry
      : DEFAULT_ENTRY;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) >= 0
      ? Number(opts.timeoutMs) : WEIGHT_TIMEOUT_MS;
    const topN = Number.isFinite(Number(opts.topN)) && Number(opts.topN) > 0
      ? Math.floor(Number(opts.topN)) : TOP_N_HEAVIEST;
    const baseline = opts.baseline !== undefined && opts.baseline !== null &&
      typeof opts.baseline === 'object'
      ? opts.baseline
      : loadBaseline({ text: typeof opts.baselineText === 'string' ? opts.baselineText : undefined });

    let parsed = null;
    if (opts.metafile !== undefined && opts.metafile !== null) {
      parsed = parseMetafile(opts.metafile, { topN });
      if (parsed.status !== 'ok') {
        return {
          allowed: true,
          annotations: [unavailableRecord(tool, eventId, entry, 'malformed metafile')],
        };
      }
    } else {
      const runBuild = typeof opts.runBuild === 'function' ? opts.runBuild : defaultRunBuild;
      const res = await runBounded(
        runBuild({ entry, timeoutMs }),
        timeoutMs,
      );
      if (!res || res.status === 'missing') {
        return {
          allowed: true,
          annotations: [unavailableRecord(tool, eventId, entry, 'esbuild not installed')],
        };
      }
      if (res.status === 'timeout') {
        return {
          allowed: true,
          annotations: [unavailableRecord(tool, eventId, entry, `esbuild exceeded the ${timeoutMs}ms budget`)],
        };
      }
      if (res.status !== 'ok') {
        return {
          allowed: true,
          annotations: [unavailableRecord(tool, eventId, entry, res.message || 'esbuild error')],
        };
      }
      parsed = parseMetafile(res.metafile, { topN });
      if (parsed.status !== 'ok') {
        return {
          allowed: true,
          annotations: [unavailableRecord(tool, eventId, entry, 'malformed metafile from esbuild')],
        };
      }
    }

    const baseBytes = numOrNull(baseline?.bytes);
    const deltaVsBaseline = baseBytes !== null && parsed.bytes !== null
      ? {
        bytes: parsed.bytes - baseBytes,
        pct: baseBytes === 0
          ? null
          : Math.round(((parsed.bytes - baseBytes) / baseBytes) * 1000) / 10,
      }
      : null;
    const stale = baseline ? isBaselineStale(baseline, { maxAgeMs: opts.maxAgeMs }) : false;
    const annotations = [toWeightRecord({
      tool, eventId, status: 'scanned', entry,
      bytes: parsed.bytes, files: parsed.files, topHeaviest: parsed.topHeaviest,
      deltaVsBaseline, baselineStale: stale,
      message: `bundle ${entry}: ${parsed.bytes} bytes across ${parsed.files} file(s)` +
        (deltaVsBaseline ? ` (delta ${deltaVsBaseline.bytes >= 0 ? '+' : ''}${deltaVsBaseline.bytes} bytes vs baseline)` : ' (no baseline)') +
        ' (advisory; action allowed)',
    })];
    if (stale) {
      annotations.push(toWeightRecord({
        tool, eventId, status: 'unavailable', entry,
        bytes: null, files: null, topHeaviest: null, deltaVsBaseline: null,
        baselineStale: true,
        message: 'stale-baseline: baseline older than the refresh window; deltas still computed — refresh is user-confirmed only (recorded; action allowed)',
      }));
    }
    return { allowed: true, annotations };
  } catch {
    // Last resort: fail-open allow with a single unavailable record.
    try {
      return {
        allowed: true,
        annotations: [unavailableRecord(WEIGHT_TOOL, null, null, 'internal fault')],
      };
    } catch {
      return { allowed: true, annotations: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Bus consumer: advisory records → audit log + counts-only toast.
// ---------------------------------------------------------------------------

/** Best-effort toast: counts only, never any record text. Never throws. */
export function notifyWeightSummary(opts, summary) {
  try {
    const fn = typeof opts?.notify === 'function' ? opts.notify : defaultWeightHostNotify(opts?.host);
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

function defaultWeightHostNotify(host) {
  if (!host || typeof host !== 'object') return null;
  try {
    const show = host.ui?.toast?.show;
    if (typeof show === 'function') {
      return (s) => show.call(host.ui.toast, {
        title: 'IUMBTEMS weight-signals',
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
        body: { service: 'iumbtems', level: 'info', message: `weight-signals: ${s.message}` },
      });
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Build the bus handler. Never throws into the bus and NEVER returns deny:
 * records → `{ verdict: 'advisory', reason: '<n> record(s)…' }` (each record
 * additionally audit-logged via one `notification` record); clean/unavailable
 * paths still record (an `unavailable` entry is a recorded fact, not a
 * failure) — only a targetless skip (no entry, no coverage) returns
 * fail-open `allow`.
 *
 * Options pass through to `measureBundle` (`entry`, `runBuild`, `metafile`,
 * `baseline`, `timeoutMs`, `topN`) plus `coverage: {before, after, scope}`
 * (or `coverageBefore`/`coverageAfter`/`coverageScope`) for the delta record.
 */
export function createWeightSignalsHandler(bus, opts = {}) {
  const runOpts = { ...opts };
  return async function weightSignalsHandler(payload) {
    try {
      const cov = payload?.coverage && typeof payload.coverage === 'object'
        ? payload.coverage
        : (runOpts.coverage || null);
      const annotations = [];
      const measured = await measureBundle({
        ...runOpts,
        tool: payload?.tool,
        eventId: payload?.eventId,
      });
      if (measured && Array.isArray(measured.annotations)) {
        annotations.push(...measured.annotations);
      }
      const before = cov?.before ?? runOpts.coverageBefore ?? null;
      const after = cov?.after ?? runOpts.coverageAfter ?? null;
      if (before && after) {
        const scope = cov?.scope ?? runOpts.coverageScope ?? null;
        const cd = coverageDelta({
          before, after, scope,
          tool: payload?.tool, eventId: payload?.eventId,
        });
        if (cd?.record) annotations.push(cd.record);
      }
      if (annotations.length === 0) {
        return { verdict: 'allow', reason: 'weight-signals: nothing to measure; skipped' };
      }
      // Every record audit-logged on the bus (one `notification` record
      // each; the audit sink below turns each into exactly one audit entry
      // carrying tool/eventId). Best-effort and awaited.
      if (bus && typeof bus.emit === 'function') {
        for (const a of annotations) {
          try {
            await bus.emit('notification', { ...a, auditKind: WEIGHT_AUDIT_KIND });
          } catch {
            /* one record's audit entry must not drop the rest */
          }
        }
      }
      notifyWeightSummary(runOpts, {
        title: 'IUMBTEMS weight-signals',
        message: `weight-signals: ${annotations.length} record(s) (advisory; action allowed)`,
      });
      return {
        verdict: 'advisory',
        reason: `weight-signals: ${annotations.length} record(s) (advisory; action allowed)`,
      };
    } catch {
      return { verdict: 'allow', reason: 'weight-signals: internal fault; fail-open allow' };
    }
  };
}

/**
 * Internal audit sink on `notification`: turns each per-record entry into
 * exactly one audit entry (fail-open `allow`, so it never blocks anything).
 * Record detail (kind / status / bytes-or-delta, length-capped) rides in the
 * entry's `reason` — `tool`/`eventId` travel in the entry's dedicated keys.
 * Non-weight-signals notifications pass through as plain `allow`.
 */
export function weightSignalsAuditSink(payload) {
  try {
    if (payload && payload.auditKind === WEIGHT_AUDIT_KIND) {
      const kind = typeof payload.kind === 'string' && payload.kind ? payload.kind : '?';
      const status = typeof payload.status === 'string' && payload.status ? payload.status : '?';
      let detail = '';
      if (typeof payload.bytes === 'number') detail = `${payload.bytes} bytes`;
      else if (payload.deltaVsBaseline && typeof payload.deltaVsBaseline === 'object') {
        detail = `delta ${payload.deltaVsBaseline.bytes ?? '?'} bytes`;
      } else if (typeof payload.delta === 'number') {
        detail = `delta ${payload.delta}pp ${payload.direction ?? ''}`.trim();
      }
      let message = typeof payload.message === 'string' ? payload.message : '';
      if (message.length > 300) message = `${message.slice(0, 297)}...`;
      const summary = [kind, status, detail].filter(Boolean).join(' ');
      return { verdict: 'allow', reason: `weight-signal ${summary} ${message}`.trim() };
    }
  } catch {
    /* fall through to plain allow */
  }
  return 'allow';
}

/**
 * Adopt the weight-signals consumer alongside the existing registrations
 * (same adopt/best-effort pattern as `setup` in `index.js`). Subscribes the
 * advisory handler on the commit-time event plus the audit sink on
 * `notification`; attaches the registration to the host for debugging
 * (`host.iumbtemsWeightSignals`, best-effort). Returns a disposable
 * registration; returns null (never throws) when there is no bus to adopt.
 */
export async function registerWeightSignals(host, opts = {}) {
  try {
    const bus = opts.bus || null;
    if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') return null;
    const runOpts = { ...opts, host };
    const handler = createWeightSignalsHandler(bus, runOpts);
    const unsubs = [];
    for (const event of WEIGHT_EVENTS) {
      try {
        unsubs.push(bus.on(event, handler, { tier: 'slow', name: 'weight-signals' }));
      } catch {
        /* one failed subscription must not drop the rest */
      }
    }
    try {
      unsubs.push(bus.on('notification', weightSignalsAuditSink, { tier: 'slow', name: 'weight-signals-audit-sink' }));
    } catch {
      /* sink is best-effort */
    }
    if (unsubs.length === 0) return null;
    try {
      if (host && typeof host === 'object') host.iumbtemsWeightSignals = { bus, events: [...WEIGHT_EVENTS] };
    } catch {
      /* host attach is best-effort */
    }
    let disposed = false;
    return {
      bus,
      events: [...WEIGHT_EVENTS],
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
          if (host && typeof host === 'object' && host.iumbtemsWeightSignals?.bus === bus) {
            delete host.iumbtemsWeightSignals;
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
