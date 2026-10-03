/**
 * IUMBTEMS hook bus (Phase 01-hook-bus-spec): six-event hook bus with tiered
 * enforcement (3 enforced on host paths, 1 advisory, 2 bus-level only) + audit log.
 *
 * Zero runtime dependencies; host-agnostic (no OpenCode host import) so the
 * mock-host suites can drive it without a live TUI. Fail-open everywhere:
 * bus-internal faults audit-log and allow — never throw into the host.
 *
 * Phase evidence (cited per programmer brief):
 * - Transform-shaped registrations today: commands via
 *   `host.command.transform` [VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76
 *   `file:///home/john/Projects/IUMBTEMS/plugins/opencode/index.js`:1038-1117],
 *   tools via `host.tool.transform` [VERIFIED: same hash, `:1119-1158`].
 * - Documented asymmetry: no `tool.execute.before` registration point, so host
 *   webfetch/websearch calls cannot be intercepted the way Claude Code's
 *   hooks/hooks.json does [VERIFIED: same hash, `:1121-1126`].
 * - Session hooks are best-effort: compaction via `session.hook("compaction")`
 *   [VERIFIED: same hash, `:1750-1775`], per-role temperature via
 *   `session.hook("context")` [VERIFIED: same hash, `:2615-2710`].
 * - Control-plane precedent: `iumbtems.settings` RPC via `ctx.rpc.register`
 *   [VERIFIED: same hash, `:2072-2510`]; MCP toggles via `ctx.mcp.transform`
 *   [VERIFIED: same hash, `:2579-2610`]; setup adopts all four registrations
 *   [VERIFIED: same hash, `:2714-2750`].
 * - QA home: mock-host harness for the plugin transforms
 *   [VERIFIED: sha256:06fff10d7c9d77a86c42d6f412b22de46a6f6bba89dea23a863075bdd3d98bda
 *   `file:///home/john/Projects/IUMBTEMS/runner/tests/test_opencode_ux.py`].
 * - Gate-0 parents: brainstorm manifest
 *   `08229740d0a7f752b0c388876ec1588e513f2b3bc8130a72771bee9593d92665`,
 *   darkharvest manifest
 *   `131bcb343879bfadcba9a40719ddd0b77540eb21f4cdc937d18b1b2943579afa`.
 */

// ---------------------------------------------------------------------------
// Event registry + tier table.
// ---------------------------------------------------------------------------

/** The six bus events (H1+H5): 3 enforced on host paths, 1 advisory, 2 bus-level only. All six deny-block per tier table at bus.emit. */
export const HOOK_EVENTS = Object.freeze([
  'pre-tool-use',
  'post-tool-use',
  'pre-commit',
  'stop',
  'notification',
  'session-start',
]);

/**
 * Tier timeouts (H2+H6). Fast checks get a short budget and block on deny;
 * slow checks get a longer budget and a deny blocks only when it lands inside
 * that budget — a slow overrun degrades to an advisory annotation (fail-open
 * allow) with an audit entry, so a hung slow check can never brick the fast
 * path.
 */
export const FAST_TIMEOUT_MS = 500;
export const SLOW_TIMEOUT_MS = 5000;

/** Handler tiers. Unknown/missing tier normalises to `slow` (fail-open side). */
export const HOOK_TIERS = Object.freeze(['fast', 'slow']);

/** Max audit entries retained per bus (ring cap; oldest dropped first). */
export const MAX_AUDIT_ENTRIES = 1000;

function normalizeTier(tier) {
  return tier === 'fast' ? 'fast' : 'slow';
}

function timeoutForTier(tier, overrides = {}) {
  if (tier === 'fast') {
    const v = Number(overrides.fastTimeoutMs ?? FAST_TIMEOUT_MS);
    return Number.isFinite(v) && v >= 0 ? v : FAST_TIMEOUT_MS;
  }
  const v = Number(overrides.slowTimeoutMs ?? SLOW_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 0 ? v : SLOW_TIMEOUT_MS;
}

/**
 * Keys a handler may return alongside (or instead of) `verdict` without
 * expressing allow/deny intent. A reason-only object whose keys are all in
 * this set is a recognised allow; any other key (e.g. `allowed`, `deny`,
 * `block`) is unrecognised and tagged — never silently dropped.
 */
const DESCRIPTIVE_KEYS = new Set(['reason', 'message', 'note', 'annotations']);

/**
 * Normalise a handler's return into `allow` | `deny` | `advisory`.
 * `undefined`/`null`/`true` mean allow (non-blocking default); `false` and
 * `'deny'` mean deny; `'advisory'` (or `{verdict:'advisory'}`) annotates
 * without blocking.
 *
 * Fix-round (FAIL 3a): the detailed form reports whether the input was a
 * recognised spelling. Anything unrecognised still degrades to fail-open
 * `allow`, but the caller MUST tag the audit entry with `fallback: true` +
 * a `note` — silent normalisation is what made malformed verdicts invisible.
 */
export function normalizeVerdictEx(value) {
  if (value === undefined || value === null || value === true) {
    return { verdict: 'allow', recognized: true };
  }
  if (value === false) return { verdict: 'deny', recognized: true };
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'deny' || v === 'block') return { verdict: 'deny', recognized: true };
    if (v === 'advisory' || v === 'warn') return { verdict: 'advisory', recognized: true };
    if (v === 'allow' || v === 'ok' || v === '') return { verdict: 'allow', recognized: true };
    // Non-empty unlisted string: fail-open allow (kept as `reason` by the
    // caller), flagged — not silent.
    return { verdict: 'allow', recognized: false };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Narrow fix round (qa-b): the empty object carries no verdict and no
    // reason — it is NOT a reason-only object. Treat it as unrecognized so
    // the caller tags fallback:true + note, consistent with 42/{verdict:BOGUS}/
    // "gibberish"/0/[].
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return { verdict: 'allow', recognized: false };
    }
    const raw = value.verdict;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      // Reason-only object: recognised ONLY when every key is descriptive.
      // `{allowed:false}` / `{deny:true}` / `{block:true}` express intent this
      // bus does not honour; treating them as a plain allow would be a silent
      // fail-open, so they are unrecognised (the caller tags fallback:true).
      return keys.every((k) => DESCRIPTIVE_KEYS.has(k))
        ? { verdict: 'allow', recognized: true }
        : { verdict: 'allow', recognized: false };
    }
    // `verdict` present: reuse the scalar path so the object and string
    // spellings (`'block'`, `'warn'`, `false`, …) can never diverge.
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      return normalizeVerdictEx(raw);
    }
    return { verdict: 'allow', recognized: false };
  }
  return { verdict: 'allow', recognized: false };
}

export function normalizeVerdict(value) {
  return normalizeVerdictEx(value).verdict;
}

function reasonOf(value) {
  if (value && typeof value === 'object' && typeof value.reason === 'string') {
    return value.reason;
  }
  if (typeof value === 'string' && value.trim() && !['allow', 'deny', 'advisory', 'block', 'ok', 'warn'].includes(value.trim().toLowerCase())) {
    return value.trim();
  }
  return null;
}

/**
 * ` (keys: a,b)` for an unrecognised object verdict, else ''. Bounded (8 keys,
 * 24 chars each) and stripped to printable characters so a hostile handler
 * cannot inject control sequences into the audit note. Never throws.
 */
function unrecognizedKeysNote(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const keys = Object.keys(value).slice(0, 8)
      .map((k) => String(k).replace(/[^\x20-\x7e]/g, '?').slice(0, 24));
    return keys.length > 0 ? ` (keys: ${keys.join(',')})` : '';
  } catch {
    return '';
  }
}

/** Run one handler with a timeout bound. Never rejects: resolves a record.
 *
 * Caller-latency contract (GOAL §5/§6 fix-round note): this promise always
 * settles within ~`ms` — the timer fires even for a handler that never
 * settles, so `emit` (tiers concurrent) resolves within
 * max(fastBudget, slowBudget) + scheduling epsilon. A hung slow handler
 * delays the caller by at most the slow budget (default `SLOW_TIMEOUT_MS`),
 * never indefinitely. Pinned by `test_emit_latency_bounded_by_slow_budget`.
 */
function runHandlerBounded(handler, payload, ms) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (record) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...record, latencyMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      finish({ status: 'timeout', verdict: 'allow', fallback: true });
    }, ms);
    // NOTE: intentionally NOT unref'd — an unref'd timer lets a node process
    // drain while a hung handler settles, so the timeout would never fire.
    let result;
    try {
      result = handler(payload);
    } catch (err) {
      finish({ status: 'error', verdict: 'allow', fallback: true, error: String(err?.message ?? err) });
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        const norm = normalizeVerdictEx(value);
        finish({
          status: 'ok',
          verdict: norm.verdict,
          reason: reasonOf(value),
          // FAIL 3a: an unrecognised verdict is NOT silently normalised —
          // the audit entry carries fallback + note (verdict stays fail-open
          // allow).
          ...(norm.recognized ? {} : {
            fallback: true,
            note: `unrecognized verdict${unrecognizedKeysNote(value)}; degraded to fail-open allow`,
          }),
        });
      },
      (err) => finish({ status: 'error', verdict: 'allow', fallback: true, error: String(err?.message ?? err) }),
    );
  });
}

// ---------------------------------------------------------------------------
// Bus.
// ---------------------------------------------------------------------------

/**
 * Create a hook bus. `on(event, handler, {tier})` registers; `emit(event,
 * payload)` runs fast-tier and slow-tier handlers concurrently (slow overruns
 * never brick the fast path) and resolves `{allowed, verdicts, annotations}`.
 * Every handler outcome — allow/deny/timeout/fallback — appends one audit
 * entry. Neither `on` nor `emit` ever throws.
 */
export function createHookBus(opts = {}) {
  const handlers = new Map(HOOK_EVENTS.map((e) => [e, []]));
  const audit = [];
  let seq = 0;
  // FAIL 3c: ring-cap evictions are counted (never silent). `dropped` counts
  // capacity evictions only; `clearAuditLog()` writes a tombstone entry whose
  // note carries the cleared count. Both are surfaced via `getAuditStats()`.
  let droppedAuditEntries = 0;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date().toISOString();
  function safeClock() {
    try {
      const val = clock();
      if (typeof val === 'string' && val.length > 0) return val;
      return new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  function appendAudit(entry) {
    try {
      seq += 1;
      audit.push({ seq, ts: safeClock(), ...entry });
      while (audit.length > MAX_AUDIT_ENTRIES) {
        audit.shift();
        droppedAuditEntries += 1;
      }
    } catch {
      /* audit must never break the bus */
    }
  }

  function on(event, handler, runOpts = {}) {
    try {
      if (!handlers.has(event) || typeof handler !== 'function') {
        appendAudit({
          event: String(event), tier: normalizeTier(runOpts?.tier),
          handler: 'n/a', verdict: 'allow', outcome: 'fallback',
          latencyMs: 0, fallback: true, note: 'on(): unknown event or non-function handler; ignored',
          tool: null, eventId: null, // FAIL 3b: keys always present (null when absent)
        });
        return () => {};
      }
      const tier = normalizeTier(runOpts?.tier);
      const name = runOpts?.name || handler.name || 'anonymous';
      const record = { handler, tier, name };
      handlers.get(event).push(record);
      return () => {
        try {
          const list = handlers.get(event) || [];
          const idx = list.indexOf(record);
          if (idx >= 0) list.splice(idx, 1);
        } catch {
          /* unsubscribe never throws */
        }
      };
    } catch {
      return () => {};
    }
  }

  async function emit(event, payload = {}, emitOpts = {}) {
    const safeGet = (fn) => { try { return fn(); } catch { return null; } };
    const payloadTool = safeGet(() => payload?.tool ?? null);
    const payloadEventId = safeGet(() => payload?.eventId ?? null);

    try {
      if (!handlers.has(event)) {
        appendAudit({
          event: String(event), tier: 'n/a', handler: 'n/a',
          verdict: 'allow', outcome: 'fallback', latencyMs: 0,
          fallback: true, note: 'emit(): unknown event; fail-open allow',
          tool: payloadTool, eventId: payloadEventId, // FAIL 3b: keys always present (null when absent)
        });
        return { allowed: true, verdicts: [], annotations: [{ event, outcome: 'fallback', note: 'unknown event' }] };
      }
      const list = [...(handlers.get(event) || [])];
      if (list.length === 0 && emitOpts?.auditEmpty) {
        appendAudit({
          event: String(event),
          tier: 'n/a',
          handler: 'n/a',
          verdict: 'allow',
          outcome: 'fallback',
          latencyMs: 0,
          fallback: true,
          note: `no handlers registered for ${String(event)} in this process`,
          tool: payloadTool,
          eventId: payloadEventId,
        });
      }
      const fastBudget = timeoutForTier('fast', emitOpts);
      const slowBudget = timeoutForTier('slow', emitOpts);

      // Tiers run concurrently so a slow overrun never bricks the fast path;
      // order is preserved within each tier (registration order).
      const runTier = async (tier) => {
        const out = [];
        for (const h of list.filter((r) => r.tier === tier)) {
          const budget = tier === 'fast' ? fastBudget : slowBudget;
          const rec = await runHandlerBounded(h.handler, payload, budget);
          const outcome = rec.status === 'ok'
            ? (rec.verdict === 'deny' ? 'deny' : rec.verdict === 'advisory' ? 'advisory' : 'allow')
            : rec.status; // 'timeout' | 'error'
          appendAudit({
            event, tier, handler: h.name, verdict: rec.verdict, outcome,
            latencyMs: rec.latencyMs,
            // FAIL 3b: `tool` / `eventId` keys are ALWAYS present (null when
            // the payload carries none) so audit consumers can rely on shape.
            tool: payloadTool,
            eventId: payloadEventId,
            ...(rec.fallback ? { fallback: true } : {}),
            ...(rec.note ? { note: rec.note } : {}),
            ...(rec.error ? { error: rec.error } : {}),
            ...(rec.reason ? { reason: rec.reason } : {}),
          });
          out.push({ tier, handler: h.name, ...rec, outcome });
        }
        return out;
      };

      const [fastRecs, slowRecs] = await Promise.all([runTier('fast'), runTier('slow')]);
      // Report in registration order (fast/slow interleave preserved by seq).
      const ordered = [...fastRecs, ...slowRecs].sort(
        (a, b) => list.findIndex((r) => r.name === a.handler) - list.findIndex((r) => r.name === b.handler),
      );
      const denied = ordered.some((r) => r.outcome === 'deny');
      const annotations = ordered
        .filter((r) => r.outcome === 'advisory' || r.status === 'timeout' || r.status === 'error')
        .map((r) => ({
          event, tier: r.tier, handler: r.handler, outcome: r.outcome,
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.error ? { error: r.error } : {}),
        }));
      return { allowed: !denied, verdicts: ordered, annotations };
    } catch (err) {
      try {
        appendAudit({
          event: String(event), tier: 'n/a', handler: 'n/a',
          verdict: 'allow', outcome: 'fallback', latencyMs: 0,
          fallback: true, error: String(err?.message ?? err),
          tool: payloadTool, eventId: payloadEventId,
        });
      } catch {
        /* last-resort: never throw */
      }
      return { allowed: true, verdicts: [], annotations: [{ event, outcome: 'fallback' }] };
    }
  }

  function getAuditLog() {
    try {
      return audit.map((e) => ({ ...e }));
    } catch {
      return [];
    }
  }

  function clearAuditLog() {
    // FAIL 3c: clearing leaves a tombstone entry (the clear itself is
    // auditable) whose note carries the discarded count. Never throws.
    try {
      const cleared = audit.length;
      audit.length = 0;
      seq += 1;
      audit.push({
        seq,
        ts: safeClock(),
        event: 'audit-clear',
        tier: 'n/a',
        handler: 'n/a',
        verdict: 'allow',
        outcome: 'fallback',
        latencyMs: 0,
        fallback: true,
        note: `audit log cleared; ${cleared} entries discarded`,
        tool: null,
        eventId: null,
      });
    } catch {
      /* never throws */
    }
  }

  /** Ring-cap ledger: live entry count, capacity evictions, cap size. */
  function getAuditStats() {
    try {
      return { entries: audit.length, dropped: droppedAuditEntries, capacity: MAX_AUDIT_ENTRIES };
    } catch {
      return { entries: 0, dropped: 0, capacity: MAX_AUDIT_ENTRIES };
    }
  }

  function handlerCount(event) {
    try {
      if (event === undefined) {
        return [...handlers.values()].reduce((n, l) => n + l.length, 0);
      }
      return (handlers.get(event) || []).length;
    } catch {
      return 0;
    }
  }

  return { on, emit, getAuditLog, clearAuditLog, getAuditStats, handlerCount, events: [...HOOK_EVENTS] };
}

/**
 * Pre-commit gate helper for the settings-RPC write path: emits `pre-commit`
 * and maps the verdict to `{allowed, result}`. Fail-open on any bus fault.
 * Stale-write guards are NOT replaced — the caller still runs the
 * expected-hash check / MCP write after an allow (see `index.js`
 * `createSettingsHandlers().set`).
 */
export async function gatePreCommit(bus, payload = {}, emitOpts = {}) {
  try {
    if (!bus || typeof bus.emit !== 'function') return { allowed: true };
    const opts = { auditEmpty: true, ...emitOpts };
    const res = await bus.emit('pre-commit', payload, opts);
    return res && res.allowed === false ? { allowed: false, result: res } : { allowed: true, result: res };
  } catch {
    return { allowed: true };
  }
}

/**
 * Adopt the bus alongside the existing transform/hook/rpc registrations
 * (same adopt/best-effort pattern as `setup` in `index.js`). Attaches the bus
 * to the host for debugging (`host.iumbtemsHookBus`, best-effort) and returns
 * a disposable registration; returns null (never throws) when there is no
 * bus to adopt.
 */
export async function registerHookBus(host, opts = {}) {
  try {
    const bus = opts.bus || null;
    if (!bus || typeof bus.emit !== 'function' || typeof bus.on !== 'function') return null;
    try {
      if (host && typeof host === 'object') host.iumbtemsHookBus = bus;
    } catch {
      /* host attach is best-effort */
    }
    let disposed = false;
    return {
      bus,
      // Synchronous on purpose: the setup() disposer stays fully synchronous
      // when every adopted disposal is sync, so a non-awaited cleanup() still
      // stops nudge streams before returning (pinned by
      // test_setup_cleanup_aborts_nudge_streams).
      dispose: () => {
        disposed = true;
        try {
          if (host && typeof host === 'object' && host.iumbtemsHookBus === bus) {
            delete host.iumbtemsHookBus;
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
