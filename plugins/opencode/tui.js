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

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { createElement, insert, setProp } from '@opentui/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { OPENCODE_COMMANDS } from './index.js';

const PLUGIN_ID = 'heretek.iumbtems.epistemic-swarm.tui';
const REFRESH_MS = 5000;

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
  let entries = [];
  try {
    entries = readdirSync(research);
    status.workspace = true;
  } catch {
    return status;
  }
  const cfg = readJson(path.join(research, 'config.json'));
  if (cfg && typeof cfg === 'object') {
    status.mode = cfg.mode ?? null;
    status.searchEngine = cfg.search_engine ?? null;
    status.maxIterations = cfg.max_iterations ?? null;
  }
  for (const name of [
    'final_synthesis.md',
    'brainstorm_report.md',
    'code_audit_report.md',
    'oss_scout_report.md',
  ]) {
    try {
      const st = statSync(path.join(research, name));
      status.reports.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* absent report */
    }
  }
  const frontier = readJson(path.join(research, 'frontier.json'));
  if (frontier && typeof frontier === 'object') {
    const nodes = Array.isArray(frontier.nodes) ? frontier.nodes : Object.values(frontier.nodes || {});
    const open = nodes.filter((n) => n && n.status !== 'settled' && n.status !== 'closed');
    status.frontierOpen = open.length;
  }
  const ledger = readJson(path.join(research, 'ledger', 'claim_status.json'));
  if (Array.isArray(ledger)) {
    const last = new Map();
    for (const e of ledger) {
      if (e && typeof e.claim_id === 'string') last.set(e.claim_id, e.to_status);
    }
    for (const s of last.values()) {
      if (s === 'STALE') status.stale += 1;
      else if (s === 'SUSPECT') status.suspect += 1;
    }
  }
  const requeue = readJson(path.join(research, 'requeue.json'));
  if (Array.isArray(requeue)) status.requeued = requeue.length;
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

function SwarmSidebar(api, root, sessionID) {
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
  });
  void sessionID;
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
  ];
  // Every slash command gets a palette entry (usage toast; the host has no
  // programmatic slash-invoke API, so discovery + usage guidance is the win).
  for (const cmd of OPENCODE_COMMANDS || []) {
    if (!cmd || !cmd.name) continue;
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

/** TUI setup: sidebar slot + palette command. Never throws. */
export function setupTui(api) {
  try {
    const root = resolveRoot(api);
    const offSidebar = registerSlot(api, 'sidebar.content', (props) =>
      SwarmSidebar(api, root, props?.sessionID)
    );
    const offApp = registerSlot(api, 'app', () => SwarmKeymapLayer(api));
    return () => {
      try { offSidebar(); } catch { /* noop */ }
      try { offApp(); } catch { /* noop */ }
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
