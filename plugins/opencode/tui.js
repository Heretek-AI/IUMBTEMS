/**
 * IUMBTEMS Epistemic Swarm — OpenCode TUI surface (Phase B visibility).
 *
 * Sidebar status panel + command-palette entry. Read-only: pure `fs` reads of
 * the `.research` workspace (config, report inventory, frontier open nodes,
 * claim-status ledger). Never spawns processes, never writes. Every read is
 * defensive — an absent workspace renders as "no swarm state", never throws.
 *
 * Host API mirrors @prevalentware/opencode-goal-plugin's V2 TUI usage:
 * `ui.slot({append, render})`, `ui.toast.show`, `ui.router.current`,
 * `keymap.layer` (inside a component scope), `api.theme`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, insert, setProp } from '@opentui/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import {
  buildSettingRows,
  configHash,
  displayCell,
  formatSettingsText,
  isConfigMalformed,
  loadConfig,
  readRawConfig,
  saveConfig,
  validateConfig,
} from './config-io.js';
import { gatePreCommit } from './hook-bus.js';
import { OPENCODE_COMMANDS, SettingsRpc, hookBus as sharedHookBus } from './index.js';

const PLUGIN_ID = 'heretek.iumbtems.epistemic-swarm.tui';
const REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// Phase 03 (opencode-settings-menu): RPC-preferred reads/writes, `changed`
// subscription, UI-only prefs.
//
// The server plugin's `iumbtems.settings` RPC domain is the preferred path:
// `api.client.rpc(SettingsRpc)` (the v2 TUI context carries `client:
// OpenCodeClient`). When absent — or when an RPC call fails with a transport
// error — the wizard/panel fall back to the direct-fs `config-io.js` path
// with a visible degraded-path toast. Both paths share validation and the
// expected-hash guard. Live refresh subscribes to the `changed` event; the
// existing 5s mtime poll stays as the floor.
//
// UI preferences live in `api.storage.store(...)` (durable, synced across TUI
// instances) and are NEVER run-affecting: only dialog conveniences such as
// the last-save timestamp. Effective values always come from the RPC snapshot
// or `.research/config.json`.
// ---------------------------------------------------------------------------

/** Live-refresh floor: the sidebar poll interval, in ms (unchanged). */
export const SETTINGS_POLL_MS = REFRESH_MS;

/** UI-only preferences key (TUI storage; never run-affecting). */
export const UI_PREFS_KEY = 'iumbtems.ui.prefs';

// Invariant (phase-03 R4c): UI prefs are write-only conveniences (e.g. the
// last-save timestamp). NO read path — wizard, panel, or otherwise — consults
// them when computing effective settings: effective values come exclusively
// from the RPC snapshot or `.research/config.json`. `TestUiPrefsBoundary`
// pins this: prefs deliberately named like config keys never surface in the
// panel body or on disk. No behavior change by this comment.

/**
 * RPC subclient for the settings domain, or null when the host has no
 * `client.rpc` (degraded direct-fs path). Never throws.
 */
export function getSettingsRpcClient(api) {
  try {
    const rpc = api?.client?.rpc;
    if (typeof rpc !== 'function') return null;
    return rpc.call(api.client, SettingsRpc);
  } catch {
    return null;
  }
}

/**
 * Subscribe to the server `changed` event for live refresh. Returns the
 * unsubscribe function, or null when the host has no RPC events (the 5s poll
 * remains the floor). Never throws.
 */
export function subscribeSettingsChanged(api, onChanged) {
  try {
    const client = getSettingsRpcClient(api);
    if (!client || !client.events || typeof client.events.on !== 'function') {
      return null;
    }
    const unsub = client.events.on('changed', (event) => {
      try {
        if (typeof onChanged === 'function') onChanged(event);
      } catch {
        /* refresh callbacks are best-effort */
      }
    });
    return typeof unsub === 'function' ? unsub : () => {};
  } catch {
    return null;
  }
}

/**
 * Phase 01-hook-bus-spec fix round (QA-B FAIL 1): `pre-commit` gate for the
 * TUI direct-fs fallback leg (`saveConfig(draft, baseDir, guard)` in
 * `openSettingsWizard`). The RPC leg already gates in
 * `createSettingsHandlers().set`; without this the fallback wrote with zero
 * `pre-commit` emit and zero audit entry.
 *
 * Emits `pre-commit` through the bus and maps the verdict per the tier table
 * (deny blocks, bus faults fail open). The stale-write guard is NOT replaced
 * — the caller still passes `guard` to `saveConfig`, which enforces
 * `CONFIG_STALE` downstream. On RPC-null hosts the bus remains the
 * enforcement point: pass `opts.hookBus` (or a host carrying the adopted
 * `host.iumbtemsHookBus`); a null bus fails open with `{ allowed: true }`.
 * The emit itself audit-logs the decision, so a denied fallback write always
 * leaves an audit entry. Never throws.
 *
 * Narrow fix round (qa-b bypass): the shipped TUI path previously called
 * `openSettingsWizard(api, root)` with no opts on an api that carried no
 * `iumbtemsHookBus`, so the fallback gate resolved null and failed open past
 * a denying pre-commit handler. `resolveHookBus` closes that wiring gap: the
 * shared bus (`hookBus` from `index.js`, same instance the settings-RPC leg
 * gates on [VERIFIED: sha256:52ac5b4d26062cfc6093440faa415ab152f8acd0d18c4496eb0087ed18a27d76])
 * is the final fallback, so the shipped configuration never resolves a null
 * bus. Fail-open remains only for genuine bus faults (null/non-emit bus
 * passed EXPLICITLY to `gateDirectFsPreCommit`), not for missing wiring.
 */
export async function gateDirectFsPreCommit(bus, { draft, baseDir, guard } = {}) {
  try {
    if (!bus || typeof bus.emit !== 'function') return { allowed: true };
    const expected = guard?.expected_hash ?? guard?.expectedHash ?? null;
    return await gatePreCommit(bus, {
      updates: draft ?? {},
      root: baseDir ?? null,
      ...(expected !== null && expected !== undefined ? { expected_hash: expected } : {}),
    });
  } catch {
    return { allowed: true };
  }
}

/**
 * Resolve the pre-commit bus for the wizard fallback leg. Precedence:
 * explicit `opts.hookBus` > adopted `host.iumbtemsHookBus` > shared bus.
 * The shared-bus fallback is what keeps the shipped TUI path (slash command
 * + palette, both RPC-null) from resolving a null bus. Never throws.
 */
export function resolveHookBus(host, opts) {
  try {
    const explicit = opts && opts.hookBus;
    if (explicit && typeof explicit.emit === 'function') return explicit;
    const adopted = host && host.iumbtemsHookBus;
    if (adopted && typeof adopted.emit === 'function') return adopted;
    if (sharedHookBus && typeof sharedHookBus.emit === 'function') return sharedHookBus;
    return null;
  } catch {
    try {
      if (sharedHookBus && typeof sharedHookBus.emit === 'function') return sharedHookBus;
    } catch {
      /* fall through */
    }
    return null;
  }
}

/** Read UI-only prefs ({} when the host has no TUI storage). Never throws. */
export function readUiPrefs(api) {
  try {
    const store = api?.storage?.store;
    if (typeof store !== 'function') return {};
    const [state] = store.call(api.storage, UI_PREFS_KEY, { initial: {} });
    return { ...(state || {}) };
  } catch {
    return {};
  }
}

/**
 * Merge UI-only prefs (never run-affecting; false when the host has no TUI
 * storage). Never throws.
 */
export async function writeUiPrefs(api, patch) {
  try {
    const store = api?.storage?.store;
    if (typeof store !== 'function') return false;
    const parts = store.call(api.storage, UI_PREFS_KEY, { initial: {} });
    const mutate = parts && parts[1];
    if (typeof mutate !== 'function') return false;
    await mutate((draft) => {
      Object.assign(draft, patch || {});
    });
    return true;
  } catch {
    return false;
  }
}

/** Visible toast marking the degraded direct-fs path. */
function degradedRpcToast(host, reason) {
  wizardToast(
    host,
    'IUMBTEMS settings',
    `Server RPC ${reason} — using direct file write (degraded path). ` +
      'Changes still validate and apply to the next swarm run.'
  );
}

/** Human-readable settings text for already-loaded rows (the RPC path). */
function formatSettingRows(rows) {
  try {
    if (!rows || rows.length === 0) return 'IUMBTEMS settings: no schema available.';
    const lines = rows.map((row) => {
      const restartNote =
        row.restart === 'next-run'
          ? 'applies to next swarm run'
          : `restart: ${row.restart}`;
      const stale = row.deprecated ? ' (deprecated, display-only)' : '';
      return `- ${row.label} (${row.key}): ${displayCell(row)} [${row.source}] — ${restartNote}${stale}`;
    });
    return ['IUMBTEMS settings (effective values):', ...lines].join('\n');
  } catch {
    return 'IUMBTEMS settings: unavailable (workspace unreadable).';
  }
}

/**
 * Effective settings body: RPC snapshot when available, direct-fs text
 * otherwise. Never throws.
 */
async function effectiveSettingsBody(host, baseDir, env) {
  let body = null;
  const rpc = getSettingsRpcClient(host);
  if (rpc) {
    try {
      const snap = await rpc.get();
      if (snap && snap.config && typeof snap.config === 'object') {
        // Provenance comes from the ON-DISK `raw`, not the merged effective
        // `config` (every key is present there, which made every row `file`).
        const rows = buildSettingRows({ ...snap.config }, snap.raw, env);
        if (rows.length > 0) body = formatSettingRows(rows);
      }
    } catch {
      /* fall through to the direct-fs read */
    }
  }
  if (body === null) body = formatSettingsText(baseDir, env);
  // R10: a malformed file must not render as silent defaults. Advisory local-fs
  // check (the same rule the wizard warns on); surfaced in the panel body —
  // never throws, never writes.
  try {
    if (isConfigMalformed(baseDir)) {
      body = `⚠️ Could not parse ${baseDir}/config.json — showing defaults.\n\n${body}`;
    }
  } catch {
    /* advisory only — a failed check must not break the panel */
  }
  return body;
}

/** Palette command opening the read-only settings status panel. */
export const SETTINGS_PANEL_COMMAND_ID = 'iumbtems.swarm-settings';
/** Palette command opening the settings dialog wizard. */
export const SETTINGS_WIZARD_COMMAND_ID = 'iumbtems.swarm-config';
/** Slash command opening the settings dialog wizard. */
export const SETTINGS_WIZARD_SLASH = 'swarm-config';

function element(tag, props = {}, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) insert(node, child);
  }
  return node;
}

function text(props, children) {
  return element('text', props, children);
}

function box(props, children = []) {
  return element('box', props, children);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed;
  } catch {
    return undefined;
  }
}

/** Config-derived status fields; nulls when config is absent/invalid. */
function configFields(research) {
  const out = { mode: null, searchEngine: null, maxIterations: null };
  const cfg = readJson(path.join(research, 'config.json'));
  if (cfg && typeof cfg === 'object') {
    out.mode = cfg.mode ?? null;
    out.searchEngine = cfg.search_engine ?? null;
    out.maxIterations = cfg.max_iterations ?? null;
  }
  return out;
}

const REPORT_NAMES = [
  'final_synthesis.md',
  'brainstorm_report.md',
  'code_audit_report.md',
  'oss_scout_report.md',
];

/** Report files present in the workspace, with mtimes. */
function presentReports(research) {
  const reports = [];
  for (const name of REPORT_NAMES) {
    try {
      const st = statSync(path.join(research, name));
      reports.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* absent report */
    }
  }
  return reports;
}

/** Count of frontier nodes not yet settled/closed, or null when absent. */
function openFrontierCount(research) {
  const frontier = readJson(path.join(research, 'frontier.json'));
  if (!frontier || typeof frontier !== 'object') return null;
  const nodes = Array.isArray(frontier.nodes)
    ? frontier.nodes
    : Object.values(frontier.nodes || {});
  return nodes.filter((n) => n && n.status !== 'settled' && n.status !== 'closed').length;
}

/** Degraded-claim counts from the ledger + requeue sidecar. */
function degradedCounts(research) {
  const out = { stale: 0, suspect: 0, requeued: 0 };
  const ledger = readJson(path.join(research, 'ledger', 'claim_status.json'));
  if (Array.isArray(ledger)) {
    const last = new Map();
    for (const e of ledger) {
      if (e && typeof e.claim_id === 'string') last.set(e.claim_id, e.to_status);
    }
    for (const s of last.values()) {
      if (s === 'STALE') out.stale += 1;
      else if (s === 'SUSPECT') out.suspect += 1;
    }
  }
  const requeue = readJson(path.join(research, 'requeue.json'));
  if (Array.isArray(requeue)) out.requeued = requeue.length;
  return out;
}

/**
 * Snapshot the workspace status. Pure fs reads; safe on missing workspace.
 * Exported for tests.
 */
export function readSwarmStatus(root) {
  const research = path.join(root || process.cwd(), '.research');
  const status = {
    workspace: false,
    mode: null,
    searchEngine: null,
    maxIterations: null,
    reports: [],
    frontierOpen: null,
    stale: 0,
    suspect: 0,
    requeued: 0,
  };
  try {
    readdirSync(research);
    status.workspace = true;
  } catch {
    return status;
  }
  Object.assign(status, configFields(research));
  status.reports = presentReports(research);
  status.frontierOpen = openFrontierCount(research);
  Object.assign(status, degradedCounts(research));
  return status;
}

function themeFg(theme) {
  try {
    const t = theme ?? {};
    const pick = (...paths) => {
      for (const p of paths) {
        let cur = t;
        for (const k of p) {
          if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
          cur = cur[k];
        }
        if (cur && typeof cur === 'object' && 'default' in cur) cur = cur.default;
        if (cur !== undefined && cur !== null) return cur;
      }
      return undefined;
    };
    return {
      text: pick(['text', 'default'], ['text']),
      muted: pick(['text', 'subdued'], ['textMuted']),
      warn: pick(['text', 'feedback', 'warning'], ['warning']),
    };
  } catch {
    return {};
  }
}

function summarize(status) {
  if (!status.workspace) return 'IUMBTEMS: no swarm state';
  const bits = [];
  if (status.mode) bits.push(status.mode);
  bits.push(`${status.reports.length} reports`);
  if (status.frontierOpen !== null) bits.push(`${status.frontierOpen} open frontier`);
  if (status.stale > 0 || status.suspect > 0) bits.push(`${status.stale} STALE/${status.suspect} SUSPECT`);
  if (status.requeued > 0) bits.push(`${status.requeued} requeued`);
  return `IUMBTEMS: ${bits.join(' · ')}`;
}

function SwarmSidebar(api, root) {
  const colors = themeFg(api?.theme);
  const [snapshot, setSnapshot] = createSignal(readSwarmStatus(root));
  createEffect(() => {
    const timer = setInterval(() => {
      try {
        setSnapshot(readSwarmStatus(root));
      } catch {
        /* keep last snapshot */
      }
    }, REFRESH_MS);
    onCleanup(() => clearInterval(timer));
    // Live refresh on the server `changed` event; the poll above is the floor.
    let unsub = null;
    try {
      unsub = subscribeSettingsChanged(api, () => {
        try {
          setSnapshot(readSwarmStatus(root));
        } catch {
          /* keep last snapshot */
        }
      });
    } catch {
      /* poll remains the floor */
    }
    onCleanup(() => {
      try {
        if (typeof unsub === 'function') unsub();
      } catch {
        /* unsubscribe is best-effort */
      }
    });
  });
  return box({}, [
    () => {
      const s = snapshot();
      const degraded = s.stale > 0 || s.suspect > 0;
      return text({ fg: degraded ? colors.warn : colors.muted }, [summarize(s)]);
    },
  ]);
}

function SwarmKeymapLayer(api) {
  const toast = (title, message) => {
    try {
      api.ui.toast.show({ title, message, variant: 'info', duration: 4000 });
    } catch {
      /* toast is best-effort */
    }
  };
  const commands = [
    {
      id: 'iumbtems.swarm-status',
      title: 'Swarm status',
      description: 'Show IUMBTEMS workspace status (mode, reports, frontier, STALE claims)',
      group: 'IUMBTEMS',
      palette: true,
      run: () => {
        const root = resolveRoot(api);
        toast('IUMBTEMS', summarize(readSwarmStatus(root)));
      },
    },
    {
      id: SETTINGS_WIZARD_COMMAND_ID,
      title: '/swarm-config (settings wizard)',
      description:
        'Edit IUMBTEMS settings in a dialog wizard (validates input, writes atomically)',
      group: 'IUMBTEMS',
      palette: true,
      run: () => openSettingsWizard(api, resolveRoot(api), { hookBus: resolveHookBus(api, null) }),
    },
    {
      id: SETTINGS_PANEL_COMMAND_ID,
      title: 'IUMBTEMS settings status',
      description:
        'Show effective IUMBTEMS settings with source badges (read-only; changes apply to the next swarm run)',
      group: 'IUMBTEMS',
      palette: true,
      run: () => openSettingsPanel(api, resolveRoot(api)),
    },
  ];
  // Every slash command gets a palette entry (usage toast; the host has no
  // programmatic slash-invoke API, so discovery + usage guidance is the win).
  for (const cmd of OPENCODE_COMMANDS || []) {
    if (!cmd?.name) continue;
    commands.push({
      id: `iumbtems.command.${cmd.name}`,
      title: `/${cmd.name}`,
      description: cmd.description || cmd.name,
      group: 'IUMBTEMS',
      palette: true,
      run: () => {
        toast(
          `IUMBTEMS /${cmd.name}`,
          `${cmd.usage || cmd.description || ''} — type /${cmd.name} in the prompt to run.`
        );
      },
    });
  }
  api.keymap.layer(() => ({
    mode: 'global',
    commands,
  }));
  return null;
}

function resolveRoot(api) {
  try {
    return (
      api?.directory ??
      api?.project?.directory ??
      api?.cwd ??
      process.cwd()
    );
  } catch {
    return process.cwd();
  }
}

function registerSlot(api, name, render) {
  const slot = api?.ui?.slot;
  if (typeof slot !== 'function') return () => {};
  try {
    const dispose =
      slot.length <= 1 ? slot({ append: name, render }) : slot(name, render);
    return typeof dispose === 'function' ? dispose : () => {};
  } catch {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// Settings dialog wizard + read-only status panel (phase 02).
//
// Host shapes modelled on the real V2 API: dialogs return promises; select
// options carry title/value/description/disabled. Every host call is
// feature-detected and the wizard/panel never throw — without `ui.dialog`
// the wizard degrades to toast guidance, and without `ui.panel` (or
// `session.panel`) the status panel degrades to toast guidance.
// ---------------------------------------------------------------------------

const WIZARD_SAVE_VALUE = '__iumbtems_save__';
const WIZARD_CANCEL_VALUE = '__iumbtems_cancel__';
const WIZARD_KEEP_VALUE = '__iumbtems_keep__';

function wizardToast(host, title, message) {
  try {
    const toast = host?.ui?.toast;
    const show = toast?.show;
    if (typeof show !== 'function') return false;
    show.call(toast, { title, message, variant: 'info', duration: 6000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 07 (H8): keyed advisory dedup window for the repeating R4 advisories.
//
// Editing an env-shadowed or deprecated row fires its advisory on EVERY edit,
// so a multi-edit wizard session spams one toast per row visit. `warnOnce`
// collapses repeats of the SAME advisory key inside a TTL window: the first
// shows, repeats within the window are suppressed (counted), expiry re-shows
// (annotated with the suppressed count), and distinct keys stay independent.
//
// SAFETY: only the two repeating R4 advisories route here. Degraded-path,
// malformed-config, validation-error, stale, and save-failure toasts call
// `wizardToast` directly and are NEVER deduped (missed-action safety).
// Durations are preserved: wizard advisories stay 6000ms via `wizardToast`
// (the 4000ms keymap usage toast is untouched).
// ---------------------------------------------------------------------------

/** Dedup window for repeating R4 advisories, in ms. Exported for tests. */
export const ADVISORY_DEDUP_MS = 30000;

/** key -> { ts, suppressed }: last show time + repeats collapsed since. */
const advisorySeen = new Map();

/**
 * Show a keyed advisory toast at most once per `ttlMs` window.
 * Returns true when a toast was actually delivered, false when collapsed
 * or when delivery failed (failed deliveries never arm the window).
 * `opts.now` injects the clock (tests); `opts.ttlMs` overrides the window.
 * Session scope: each `openSettingsWizard` call resets the window (fresh
 * wizard session always warns at least once); repeats within one session
 * still collapse. Never throws.
 */
export function warnOnce(host, key, title, message, opts = {}) {
  try {
    const ttl =
      opts && opts.ttlMs !== undefined && opts.ttlMs !== null
        ? Number(opts.ttlMs)
        : ADVISORY_DEDUP_MS;
    const now =
      opts && opts.now !== undefined && opts.now !== null
        ? Number(opts.now)
        : Date.now();
    const entry = advisorySeen.get(key);
    if (entry && Number.isFinite(ttl) && ttl > 0) {
      const dt = now - entry.ts;
      if (Number.isFinite(dt) && dt >= 0 && dt < ttl) {
        entry.suppressed += 1;
        return false;
      }
      // dt < 0 (clock moved backwards) or dt >= ttl (expiry) fall through
      // to reshow — a backwards clock must never suppress indefinitely.
    }
    let text = message;
    if (entry && entry.suppressed > 0) {
      text += ` (repeated ${entry.suppressed + 1}× since last notice)`;
    }
    // Arm the window ONLY on actual delivery: a failed toast (missing/broken
    // host) leaves state untouched so the next real warning still delivers.
    const delivered = wizardToast(host, title, text);
    if (!delivered) return false;
    advisorySeen.set(key, { ts: now, suppressed: 0 });
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget all dedup state. Never throws. */
export function _resetAdvisoryDedup() {
  try {
    advisorySeen.clear();
  } catch {
    /* never throw */
  }
}

/** Test hook: suppressed-repeat count pending for `key`. Never throws. */
export function _advisorySuppressed(key) {
  try {
    const entry = advisorySeen.get(key);
    return entry ? entry.suppressed : 0;
  } catch {
    return 0;
  }
}

/** The dialog cluster, or null when the host has no dialog UI. */
function dialogOf(host) {
  try {
    const dialog = host?.ui?.dialog;
    if (
      !dialog ||
      typeof dialog.select !== 'function' ||
      typeof dialog.prompt !== 'function' ||
      typeof dialog.confirm !== 'function'
    ) {
      return null;
    }
    return dialog;
  } catch {
    return null;
  }
}

function researchDirOf(host, root) {
  try {
    return path.join(root || resolveRoot(host), '.research');
  } catch {
    return path.join(process.cwd(), '.research');
  }
}

function shortValue(value, max = 42) {
  let text;
  try {
    text = JSON.stringify(value);
    if (text === undefined) text = String(value);
  } catch {
    text = String(value);
  }
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/**
 * Wizard display cell for a row: env-shadowed rows render masked
 * (`~~file value~~ (set via environment) [env-override]`) — the file value
 * is never presented bare as the effective value, and the env value itself
 * is never rendered. Shares the config-io masking rule with the panel.
 */
function wizardCell(row) {
  try {
    return displayCell(row, (v) => shortValue(v));
  } catch {
    return shortValue(row ? row.value : undefined);
  }
}

/** Consecutive row-edit errors before the wizard aborts back to the menu. */
export const MAX_ROW_ERRORS = 3;

function rowErrorNote(attempt) {
  return ` (${attempt} of ${MAX_ROW_ERRORS} attempts before this edit is abandoned)`;
}

/** True when the raw file still carries a stale pre-0.7.6 backend pin. */
function rawHasLegacyPin(raw, backend) {
  try {
    if (String(backend || 'auto').trim().toLowerCase() === 'claude') return false;
    const agents = raw && raw.agents;
    if (!agents || typeof agents !== 'object') return false;
    return ['alpha', 'beta'].some((role) => {
      const pin = agents[role] && agents[role].backend;
      return (
        Array.isArray(pin) &&
        pin.length === 2 &&
        pin[0] === 'claude' &&
        pin[1] === '-p'
      );
    });
  } catch {
    return false;
  }
}

/**
 * Assign a candidate and keep it only when the whole draft still validates;
 * problems scoped to `key` are reported with the structured message and the
 * caller re-prompts. Returns true when the value stuck.
 */
function tryAssignDraft(draft, key, value) {
  const hadKey = Object.prototype.hasOwnProperty.call(draft, key);
  const old = draft[key];
  draft[key] = value;
  let scoped = [];
  try {
    const prefixDot = `${key}.`;
    const prefixIdx = `${key}[`;
    const prefixMsg = `${key}:`;
    scoped = validateConfig(draft).filter(
      (p) =>
        p === key ||
        p.startsWith(prefixDot) ||
        p.startsWith(prefixIdx) ||
        p.startsWith(prefixMsg)
    );
  } catch {
    scoped = [];
  }
  if (scoped.length > 0) {
    if (hadKey) draft[key] = old;
    else {
      try {
        delete draft[key];
      } catch {
        draft[key] = old;
      }
    }
    return scoped;
  }
  return [];
}

/** Prompt loop for one scalar row. Returns true when a value was stored. */
async function editScalarRow(dialog, host, draft, row, parse) {
  let errors = 0;
  for (;;) {
    let answer = null;
    try {
      answer = await dialog.prompt({
        title: `${row.label} (current: ${wizardCell(row)})`,
        description: row.description || row.key,
        defaultValue:
          row.value === null || row.value === undefined
            ? ''
            : String(row.value),
      });
    } catch {
      return false;
    }
    if (answer === null || answer === undefined) return false; // dismissed
    let parsed;
    try {
      parsed = parse(String(answer));
    } catch (err) {
      errors += 1;
      if (errors >= MAX_ROW_ERRORS) {
        wizardToast(
          host,
          'Too many invalid attempts',
          `Abandoning this edit after ${MAX_ROW_ERRORS} invalid attempts — ` +
            'returning to the settings menu. Nothing was written.'
        );
        return false;
      }
      wizardToast(host, 'Invalid value', `${err?.message || err} — try again.${rowErrorNote(errors)}`);
      continue;
    }
    if (parsed && parsed.cancel) return false;
    const problems = tryAssignDraft(draft, row.key, parsed.value);
    if (problems.length === 0) {
      row.value = parsed.value;
      return true;
    }
    errors += 1;
    if (errors >= MAX_ROW_ERRORS) {
      wizardToast(
        host,
        'Too many invalid attempts',
        `Abandoning this edit after ${MAX_ROW_ERRORS} invalid attempts — ` +
          'returning to the settings menu. Nothing was written.'
      );
      return false;
    }
    wizardToast(host, 'Invalid value', `${problems[0]} — try again.${rowErrorNote(errors)}`);
  }
}

function parseNumberRow(row, text) {
  const types = Array.isArray(row.schema.type) ? row.schema.type : [row.schema.type];
  const nullable = types.includes('null');
  const trimmed = text.trim();
  if (trimmed === '') {
    if (nullable) return { value: null };
    throw new Error('empty value is not accepted for this field');
  }
  if (types.includes('integer') && !/^-?\d+$/.test(trimmed)) {
    throw new Error(`expected an integer, got ${JSON.stringify(text)}`);
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new Error(`expected a number, got ${JSON.stringify(text)}`);
  }
  return { value: num };
}

function parseStringRow(row, text) {
  const types = Array.isArray(row.schema.type) ? row.schema.type : [row.schema.type];
  if (text === '' && nullableType(types)) return { value: null };
  return { value: text };
}

function nullableType(types) {
  return (Array.isArray(types) ? types : [types]).includes('null');
}

/** Enum / boolean rows go through select; everything else through prompt. */
async function editRow(dialog, host, draft, row) {
  try {
    const sub = row.schema || {};
    // R4 advisories (never block the edit; the write still proceeds):
    // an env-shadowed value is not effective while the override is set, and
    // a deprecated key is ignored at runtime. Both route through the keyed
    // dedup window (per-key repeats collapse); every other toast stays
    // un-deduped so no error or degraded-path notice is ever swallowed.
    if (row.source === 'env-override') {
      warnOnce(
        host,
        `env:${row.key}`,
        'Environment override',
        `The environment shadows '${row.key}' — the file value is not ` +
          'effective while the override is set and has no runtime effect ' +
          'until the override is unset. The edited value is still stored ' +
          'on save (cancel writes nothing).'
      );
    }
    if (row.deprecated) {
      warnOnce(
        host,
        `deprecated:${row.key}`,
        'Deprecated field',
        `'${row.key}' is deprecated and ignored — it has no runtime ` +
          'effect. The edited value is still stored on save for reference, ' +
          'but changes nothing (cancel writes nothing).'
      );
    }
    const types = Array.isArray(sub.type) ? sub.type : [sub.type];
    const nullable = nullableType(types);

    if (Array.isArray(sub.enum)) {
      const options = sub.enum.map((v) => ({
        title: `${String(v)}${v === row.value ? ' (current)' : ''}`,
        value: v,
        description: `${row.label}: one of ${sub.enum.join(', ')}.`,
      }));
      options.push({
        title: '(keep current)',
        value: WIZARD_KEEP_VALUE,
        description: 'Leave this field unchanged.',
      });
      let picked = null;
      try {
        picked = await dialog.select({ title: row.label, options });
      } catch {
        return false;
      }
      if (picked === null || picked === undefined || picked === WIZARD_KEEP_VALUE) {
        return false;
      }
      if (!sub.enum.includes(picked)) return false;
      const problems = tryAssignDraft(draft, row.key, picked);
      if (problems.length > 0) {
        wizardToast(host, 'Invalid value', problems[0]);
        return false;
      }
      row.value = picked;
      return true;
    }

    if (types.includes('boolean')) {
      const options = [
        { title: `true${row.value === true ? ' (current)' : ''}`, value: true },
        { title: `false${row.value === false ? ' (current)' : ''}`, value: false },
      ];
      if (nullable) {
        options.push({
          title: `clear (null)${row.value === null ? ' (current)' : ''}`,
          value: null,
          description: 'Follow the default policy.',
        });
      }
      options.push({ title: '(keep current)', value: WIZARD_KEEP_VALUE });
      let picked = WIZARD_KEEP_VALUE;
      let pickedSet = false;
      try {
        picked = await dialog.select({
          title: row.label,
          options,
        });
        pickedSet = true;
      } catch {
        return false;
      }
      if (!pickedSet || picked === WIZARD_KEEP_VALUE) return false;
      if (picked !== true && picked !== false && !(nullable && picked === null)) {
        return false;
      }
      const problems = tryAssignDraft(draft, row.key, picked);
      if (problems.length > 0) {
        wizardToast(host, 'Invalid value', problems[0]);
        return false;
      }
      row.value = picked;
      return true;
    }

    if (types.includes('integer') || types.includes('number')) {
      return editScalarRow(dialog, host, draft, row, (text) =>
        parseNumberRow(row, text)
      );
    }

    if (types.includes('array')) {
      return editScalarRow(dialog, host, draft, row, (text) => {
        if (text.trim() === '') return { value: [] };
        return {
          value: text
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        };
      });
    }

    if (types.includes('object')) {
      if (row.key === 'verify') {
        const current =
          row.value && typeof row.value === 'object'
            ? row.value.min_fuzzy_confidence
            : null;
        let verifyErrors = 0;
        for (;;) {
          let answer = null;
          try {
            answer = await dialog.prompt({
              title: `Min Fuzzy Confidence (current: ${wizardCell({ value: current, source: row.source })})`,
              description: 'Number between 0 and 1.',
              defaultValue: current === null || current === undefined ? '' : String(current),
            });
          } catch {
            return false;
          }
          if (answer === null || answer === undefined) return false;
          const num = Number(String(answer).trim());
          if (!Number.isFinite(num)) {
            verifyErrors += 1;
            if (verifyErrors >= MAX_ROW_ERRORS) {
              wizardToast(
                host,
                'Too many invalid attempts',
                `Abandoning this edit after ${MAX_ROW_ERRORS} invalid attempts — ` +
                  'returning to the settings menu. Nothing was written.'
              );
              return false;
            }
            wizardToast(host, 'Invalid value', `expected a number — try again.${rowErrorNote(verifyErrors)}`);
            continue;
          }
          const next = {
            ...(row.value && typeof row.value === 'object' ? row.value : {}),
            min_fuzzy_confidence: num,
          };
          const problems = tryAssignDraft(draft, row.key, next);
          if (problems.length === 0) {
            row.value = next;
            return true;
          }
          verifyErrors += 1;
          if (verifyErrors >= MAX_ROW_ERRORS) {
            wizardToast(
              host,
              'Too many invalid attempts',
              `Abandoning this edit after ${MAX_ROW_ERRORS} invalid attempts — ` +
                'returning to the settings menu. Nothing was written.'
            );
            return false;
          }
          wizardToast(host, 'Invalid value', `${problems[0]} — try again.${rowErrorNote(verifyErrors)}`);
        }
      }
      if (row.key === 'agents') {
        return editAgentsRow(dialog, host, draft, row);
      }
      // Unknown object block: JSON edit, validated before it sticks.
      return editScalarRow(dialog, host, draft, row, (text) => {
        if (text.trim() === '') {
          if (nullable) return { value: null };
          throw new Error('empty value is not accepted for this field');
        }
        try {
          return { value: JSON.parse(text) };
        } catch {
          throw new Error('expected a JSON object');
        }
      });
    }

    return editScalarRow(dialog, host, draft, row, (text) =>
      parseStringRow(row, text)
    );
  } catch {
    return false;
  }
}

const AGENT_EDIT_KEYS = ['backend', 'model', 'opencode_agent'];

/** Role -> key -> value drill-down for the `agents` block. */
async function editAgentsRow(dialog, host, draft, row) {
  const current =
    row.value && typeof row.value === 'object' ? row.value : {};
  const roles = Array.from(new Set(['alpha', 'beta', ...Object.keys(current)]));
  let role = null;
  try {
    role = await dialog.select({
      title: 'Agent role',
      options: [
        ...roles.map((r) => ({ title: r, value: r })),
        { title: '(keep current)', value: WIZARD_KEEP_VALUE },
      ],
    });
  } catch {
    return false;
  }
  if (!role || role === WIZARD_KEEP_VALUE) return false;
  let field = null;
  try {
    field = await dialog.select({
      title: `agents.${role}`,
      options: [
        ...AGENT_EDIT_KEYS.map((k) => ({
          title: `${k} (current: ${wizardCell({ value: current[role] && current[role][k], source: row.source })})`,
          value: k,
          description:
            k === 'backend'
              ? 'Argv list as JSON (e.g. ["opencode","run"]); empty clears to null.'
              : 'String value; empty clears to null.',
        })),
        { title: '(keep current)', value: WIZARD_KEEP_VALUE },
      ],
    });
  } catch {
    return false;
  }
  if (!field || field === WIZARD_KEEP_VALUE || !AGENT_EDIT_KEYS.includes(field)) {
    return false;
  }
  let answer = null;
  try {
    const existing = current[role] && current[role][field];
    answer = await dialog.prompt({
      title: `agents.${role}.${field} (current: ${wizardCell({ value: existing, source: row.source })})`,
      description:
        field === 'backend'
          ? 'JSON array of strings, or empty to clear.'
          : 'String, or empty to clear (null).',
      defaultValue: '',
    });
  } catch {
    return false;
  }
  if (answer === null || answer === undefined) return false;
  const trimmed = String(answer).trim();
  let parsed;
  if (trimmed === '') {
    parsed = null;
  } else if (field === 'backend') {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      wizardToast(host, 'Invalid value', 'backend must be a JSON array of strings — try again.');
      return false;
    }
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      wizardToast(host, 'Invalid value', 'backend must be a JSON array of strings — try again.');
      return false;
    }
  } else {
    parsed = String(answer);
  }
  const next = {
    ...current,
    [role]: { ...(current[role] && typeof current[role] === 'object' ? current[role] : {}), [field]: parsed },
  };
  const problems = tryAssignDraft(draft, row.key, next);
  if (problems.length > 0) {
    wizardToast(host, 'Invalid value', problems[0]);
    return false;
  }
  row.value = next;
  return true;
}

/**
 * Schema-driven dialog wizard: reads the effective config, explains sources,
 * validates every edit against the canonical schema (errors re-prompt with
 * the structured message), and writes atomically on confirm. Cancel (or a
 * dismissed dialog) writes nothing — zero files. Never throws.
 */
export async function openSettingsWizard(host, root, opts = {}) {
  try {
    // R1 session scope: a fresh wizard session always warns at least once.
    // The keyed R4 window collapses repeats WITHIN one session only; reset
    // the boundary here so a prior session (same key, <30s ago) never leaks
    // into the new session. Never throws.
    try {
      advisorySeen.clear();
    } catch {
      /* dedup reset is best-effort */
    }
    const dialog = dialogOf(host);
    const baseDir = researchDirOf(host, root);
    const env = (opts && opts.env) || process.env;
    if (!dialog) {
      wizardToast(
        host,
        'IUMBTEMS settings',
        'The settings wizard needs the dialog UI (ui.dialog select/prompt/confirm). ' +
          'Inspect read-only values with /swarm-config or the iumbtems_config tool instead — ' +
          'changes apply to the next swarm run.'
      );
      return { ok: false, reason: 'no-dialog', written: false };
    }
    // Preferred path: the server RPC snapshot. Absent `client.rpc` (or a
    // failed RPC read) falls back to the direct-fs path with a visible toast.
    let rpc = getSettingsRpcClient(host);
    if (!rpc) degradedRpcToast(host, 'unavailable');
    let raw;
    let draft;
    let startHash;
    if (rpc) {
      try {
        const snap = await rpc.get();
        if (!snap || typeof snap.config !== 'object') throw new Error('empty snapshot');
        // R1: provenance uses the RPC's on-disk `raw` (null/absent -> {}),
        // never the merged effective `config`.
        raw = snap.raw && typeof snap.raw === 'object' ? snap.raw : {};
        draft = JSON.parse(JSON.stringify(snap.config));
        startHash = typeof snap.hash === 'string' ? snap.hash : null;
      } catch {
        degradedRpcToast(host, 'read failed');
        rpc = null;
      }
    }
    // B2 (phase-03 R6): the malformed-config warning fires on the RPC path
    // too — the server snapshot degrades to defaults for a corrupt file, and
    // silent defaults are not B2-compliant. Local fs read, advisory only.
    if (rpc && isConfigMalformed(baseDir)) {
      wizardToast(
        host,
        'IUMBTEMS settings',
        `Could not parse ${baseDir}/config.json — showing defaults. ` +
          'Saving will replace the malformed file; cancel writes nothing.'
      );
    }
    if (!rpc) {
      raw = readRawConfig(baseDir);
      if (isConfigMalformed(baseDir)) {
        wizardToast(
          host,
          'IUMBTEMS settings',
          `Could not parse ${baseDir}/config.json — showing defaults. ` +
            'Saving will replace the malformed file; cancel writes nothing.'
        );
      }
      startHash = configHash(baseDir);
      draft = loadConfig(baseDir);
    }
    if (raw && rawHasLegacyPin(raw, draft.backend)) {
      wizardToast(
        host,
        'IUMBTEMS settings',
        "Migrated a legacy ['claude', '-p'] agent backend pin to the host-native " +
          'default (applies on save).'
      );
    }

    for (;;) {
      const rows = buildSettingRows(draft, raw, env);
      const options = rows.map((row) => ({
        title: `${row.label}: ${wizardCell(row)} [${row.source}]`,
        value: row.key,
        description: `${row.description || row.key} — applies to next swarm run.`,
      }));
      options.push({
        title: 'Save & exit',
        value: WIZARD_SAVE_VALUE,
        description: 'Validate and write .research/config.json atomically.',
      });
      options.push({
        title: 'Cancel (write nothing)',
        value: WIZARD_CANCEL_VALUE,
        description: 'Discard all edits; no files are written.',
      });
      let choice = null;
      let chose = false;
      try {
        choice = await dialog.select({
          title: 'IUMBTEMS settings (applies to next swarm run)',
          options,
        });
        chose = true;
      } catch {
        return { ok: false, reason: 'dialog-error', written: false };
      }
      if (!chose || choice === null || choice === undefined || choice === WIZARD_CANCEL_VALUE) {
        return { ok: true, written: false, cancelled: true };
      }
      if (choice === WIZARD_SAVE_VALUE) {
        let confirmed = false;
        try {
          confirmed = await dialog.confirm({
            title: 'Save settings?',
            message:
              'Write .research/config.json atomically? ' +
              'Changes apply to the next swarm run.',
          });
        } catch {
          return { ok: false, reason: 'dialog-error', written: false };
        }
        if (!confirmed) continue;
        // Preferred write path: the server RPC (validates + hash-guards
        // server-side, mirrors storage, emits `changed`). Transport failures
        // fall back to the direct-fs write below.
        if (rpc) {
          try {
            const rpcInput = { updates: draft };
            if (opts && opts.expected_hash !== undefined) {
              rpcInput.expected_hash = opts.expected_hash;
            }
            if (opts && opts.expectedHash !== undefined) {
              rpcInput.expectedHash = opts.expectedHash;
            }
            if (rpcInput.expected_hash === undefined && rpcInput.expectedHash === undefined) {
              rpcInput.expectedHash = startHash;
            }
            const res = await rpc.set(rpcInput);
            wizardToast(
              host,
              'IUMBTEMS settings',
              'Saved via server RPC — applies to the next swarm run.'
            );
            try {
              await writeUiPrefs(host, { lastSavedAt: new Date().toISOString() });
            } catch {
              /* UI prefs are best-effort */
            }
            return { ok: true, written: true, hash: (res && res.hash) || null };
          } catch (err) {
            if (err && (err.type === 'stale' || (err.data && err.data.current_hash !== undefined))) {
              wizardToast(
                host,
                'IUMBTEMS settings',
                'Config changed on disk since it was read; refusing the stale write. ' +
                  'Re-open the wizard for a fresh snapshot — nothing was written.'
              );
              return { ok: false, reason: 'stale', written: false };
            }
            const failure = err && (err.rpcType || err.type);
            if (failure === 'invalid' || failure === 'conflict') {
              wizardToast(
                host,
                'IUMBTEMS settings',
                `Save failed: ${(err && err.message) || err} — nothing was written.`
              );
              return { ok: false, reason: 'save-failed', written: false };
            }
            degradedRpcToast(host, 'write failed');
            rpc = null;
          }
        }
        const guard =
          opts && (opts.expected_hash !== undefined || opts.expectedHash !== undefined)
            ? { expected_hash: opts.expected_hash, expectedHash: opts.expectedHash }
            : { expectedHash: startHash };
        // Phase 01-hook-bus-spec fix round (QA-B FAIL 1): the direct-fs
        // fallback is gated by `pre-commit` too — a tier-table deny blocks
        // the write (toast + `{ ok: false, reason: 'pre-commit-denied' }`,
        // nothing written, decision audit-logged on the bus). Bus faults
        // fail open; the stale-write guard below (`saveConfig` raising
        // `CONFIG_STALE`) is preserved unchanged.
        try {
          // Narrow fix round (qa-b bypass): resolve via the shared-bus
          // fallback so the shipped RPC-null path never gates on null.
          const fsBus = resolveHookBus(host, opts);
          const fsGate = await gateDirectFsPreCommit(fsBus, {
            draft,
            baseDir,
            guard,
          });
          if (fsGate && fsGate.allowed === false) {
            wizardToast(
              host,
              'IUMBTEMS settings',
              'Save denied by pre-commit hook — nothing was written.'
            );
            return { ok: false, reason: 'pre-commit-denied', written: false };
          }
        } catch {
          /* gate faults fail open; the write below still runs */
        }
        try {
          const res = saveConfig(draft, baseDir, guard);
          wizardToast(
            host,
            'IUMBTEMS settings',
            `Saved ${res.path} — applies to the next swarm run.`
          );
          try {
            await writeUiPrefs(host, { lastSavedAt: new Date().toISOString() });
          } catch {
            /* UI prefs are best-effort */
          }
          return { ok: true, written: true, hash: res.hash };
        } catch (err) {
          if (err && err.code === 'CONFIG_STALE') {
            wizardToast(
              host,
              'IUMBTEMS settings',
              'Config changed on disk since it was read; refusing the stale write. ' +
                'Re-open the wizard for a fresh snapshot — nothing was written.'
            );
            return { ok: false, reason: 'stale', written: false };
          }
          wizardToast(
            host,
            'IUMBTEMS settings',
            `Save failed: ${(err && err.message) || err} — nothing was written.`
          );
          return { ok: false, reason: 'save-failed', written: false };
        }
      }
      const row = rows.find((r) => r.key === choice);
      if (!row) continue;
      await editRow(dialog, host, draft, row);
    }
  } catch {
    return { ok: false, reason: 'error', written: false };
  }
}

/**
 * Read-only status panel: effective rows with source badges and the honest
 * next-run note. Uses `ui.panel` (falling back to `session.panel`) when the
 * host offers it; otherwise degrades to toast guidance. Never throws.
 */
export async function openSettingsPanel(host, root, opts = {}) {
  try {
    const baseDir = researchDirOf(host, root);
    const env = (opts && opts.env) || process.env;
    const body = await effectiveSettingsBody(host, baseDir, env);
    let show = null;
    try {
      if (typeof host?.ui?.panel === 'function') show = host.ui.panel.bind(host.ui);
      else if (typeof host?.session?.panel === 'function') {
        show = host.session.panel.bind(host.session);
      }
    } catch {
      show = null;
    }
    if (show) {
      try {
        await show({ title: 'IUMBTEMS settings', body });
        return { ok: true, degraded: false };
      } catch {
        /* fall through to toast guidance */
      }
    }
    const preview = String(body).split('\n').slice(0, 10).join('\n');
    wizardToast(
      host,
      'IUMBTEMS settings',
      `${preview}\n…(status panel unavailable — edit via /swarm-config; changes apply to the next swarm run.)`
    );
    return { ok: true, degraded: true };
  } catch {
    return { ok: false, degraded: true };
  }
}

/**
 * Slash command `swarm-config` opening the dialog wizard. Feature-detected:
 * without `command.transform` there is nothing to register (the palette
 * entries from the keymap layer still work). Never throws.
 */
export async function registerWizardSlashCommand(api, opts = {}) {
  try {
    if (typeof api?.command?.transform !== 'function') return null;
    let existing = new Set();
    try {
      if (typeof api.command.list === 'function') {
        const listed = await api.command.list();
        existing = new Set((listed?.data || []).map((c) => c?.name));
      }
    } catch {
      /* assume an empty registry */
    }
    const registration = await api.command.transform((draft) => {
      try {
        if (!draft || typeof draft.add !== 'function') return;
        if (existing.has(SETTINGS_WIZARD_SLASH)) return;
        draft.add({
          name: SETTINGS_WIZARD_SLASH,
          description:
            'Inspect or update Epistemic Swarm parameters in a dialog wizard (validates + writes atomically)',
          execute: async () => {
            try {
              // Narrow fix round (qa-b bypass): thread the bus on the shipped
              // path — explicit opt > adopted host bus > shared bus — so the
              // fallback gate never resolves null here.
              await openSettingsWizard(api, resolveRoot(api), {
                ...(opts || {}),
                hookBus: resolveHookBus(api, opts),
              });
            } catch {
              /* the wizard never throws into the host */
            }
          },
        });
      } catch {
        /* never throw into the host transform */
      }
    });
    try {
      if (typeof api.command.reload === 'function') await api.command.reload();
    } catch {
      /* reload is best-effort */
    }
    return registration || null;
  } catch {
    return null;
  }
}

/** TUI setup: sidebar slot + palette command. Never throws. */
export function setupTui(api, opts = {}) {
  try {
    // Narrow fix round (qa-b bypass): adopt the shared bus onto the TUI api
    // so `opts.hookBus || host.iumbtemsHookBus` never resolves null on the
    // shipped path. Best-effort; never throws. The shared instance is the
    // same one the settings-RPC leg gates on.
    try {
      if (api && typeof api === 'object' && !(api.iumbtemsHookBus && typeof api.iumbtemsHookBus.emit === 'function')) {
        const bus = (opts && opts.hookBus) || sharedHookBus || null;
        if (bus && typeof bus.emit === 'function') api.iumbtemsHookBus = bus;
      }
    } catch {
      /* host attach is best-effort */
    }
    const root = resolveRoot(api);
    const offSidebar = registerSlot(api, 'sidebar.content', () =>
      SwarmSidebar(api, root)
    );
    const offApp = registerSlot(api, 'app', () => SwarmKeymapLayer(api));
    // Slash command for the wizard (feature-detected; a bare TUI api without
    // the command domain keeps the palette entries only). Fire-and-forget so
    // setup stays synchronous; the handle lands when the host resolves it.
    let slashRegistration = null;
    try {
      Promise.resolve(registerWizardSlashCommand(api, opts))
        .then((reg) => {
          slashRegistration = reg;
        })
        .catch(() => {});
    } catch {
      /* registration is best-effort */
    }
    return () => {
      try { offSidebar(); } catch { /* noop */ }
      try { offApp(); } catch { /* noop */ }
      try {
        if (
          slashRegistration &&
          typeof slashRegistration.dispose === 'function'
        ) {
          slashRegistration.dispose();
        }
      } catch { /* noop */ }
    };
  } catch {
    return () => {};
  }
}

const plugin = {
  id: PLUGIN_ID,
  tui: true,
  setup: setupTui,
};

export default plugin;
