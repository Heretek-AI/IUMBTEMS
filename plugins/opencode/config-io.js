/**
 * IUMBTEMS Epistemic Swarm — dependency-free config read/validate/format/write.
 *
 * Direct-fs fallback for the settings surface (the phase-03 RPC bridge later
 * keeps this path as its offline fallback). No dependencies beyond
 * node:fs/node:path/node:crypto/node:os.
 *
 * Semantics mirror `skills/swarm_config/configure.py` (phase 01 contract):
 * - Validation is derived from `schemas/config.schema.json` (the generated
 *   artifact): the dependency-free subset type/enum/minimum/maximum/minLength/
 *   pattern (+ required/properties/items/additionalProperties) is interpreted
 *   by a line-for-line port of `runner/schema_validate.py`. Unknown keys are
 *   allowed and preserved; null is accepted only for nullable keys.
 * - `saveConfig` merges over whatever is on disk, validates, and publishes via
 *   a unique temp file + rename. A crash between temp-write and rename leaves
 *   the original byte-identical (the temp is unlinked on failure).
 * - Single-writer discipline over `.research/.config.lock`: O_EXCL create with
 *   a pid+timestamp payload; a live lock is respected (CONFIG_LOCKED, nothing
 *   written); a stale lock (> 5s) is taken over. The lock is released (unlinked
 *   when still ours) after every save attempt, so the steady state is lockless.
 *
 *   RESIDUAL WINDOW (documented, negligible): the Python writer holds its lock
 *   via fcntl.flock on the same path but never writes a pid+timestamp payload
 *   and never unlinks. A lockfile without our payload therefore reads as
 *   foreign/stale and is ADOPTED BY OVERWRITING (never by unlinking) — so a
 *   live Python holder can still be adopted if its write spans the adoption.
 *   Python writes are millisecond-scale read-merge-write cycles under its own
 *   flock (which still serializes Python-side writers), so the window is
 *   negligible; human-paced TUI saves will essentially never land inside it.
 *   `release()` unlinks ONLY when the on-disk payload's pid is our own pid —
 *   a foreign live lock is never removed, and a lock adopted away from us by
 *   a concurrent takeover is left intact.
 * - Optional expected-hash guard (both `expected_hash` and `expectedHash`
 *   spellings; both present must agree after strip+lowercase normalization
 *   or the call is rejected with
 *   CONFLICTING_EXPECTED_HASH). Full SHA-256 or a prefix of at least 8 hex
 *   chars; a mismatch raises CONFIG_STALE with a fresh snapshot and writes
 *   nothing. A malformed guard raises CONFIG_INVALID_EXPECTED_HASH.
 * - Every function is pure/defensive: an absent or malformed workspace never
 *   throws — readers return defaults/null and writers surface structured
 *   errors instead of exceptions from fs reads.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '../..');

export const DEFAULT_RESEARCH_DIR = '.research';
export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_LOCK_NAME = '.config.lock';
/** A lock older than this is taken over (mirrors the documented 5s rule). */
export const LOCK_STALE_MS = 5000;

/** Legacy per-role backend pins (pre-0.7.6 default persisted verbatim). */
export const LEGACY_AGENT_BACKEND_PINS = [['claude', '-p']];
export const AGENT_ROLES = ['alpha', 'beta'];

/**
 * Env vars that override a file value at runtime (effective source becomes
 * `env-override`). Verified against runner/research_swarm.py + preflight.py:
 * SEARXNG_URL, IUMBTEMS_FETCH_TTL_DAYS, IUMBTEMS_SEARCH_TIMEOUT_S,
 * IUMBTEMS_CACHE_RAW_MARKDOWN, IUMBTEMS_OPENCODE_AUTO,
 * IUMBTEMS_BACKEND_<ROLE>, IUMBTEMS_MODEL_<ROLE>.
 */
export const ENV_OVERRIDES = {
  searxng_url: ['SEARXNG_URL'],
  cache_ttl_days: ['IUMBTEMS_FETCH_TTL_DAYS'],
  search_timeout_s: ['IUMBTEMS_SEARCH_TIMEOUT_S'],
  cache_raw_markdown: ['IUMBTEMS_CACHE_RAW_MARKDOWN'],
  opencode_auto: ['IUMBTEMS_OPENCODE_AUTO'],
  agents: [
    'IUMBTEMS_BACKEND_ALPHA',
    'IUMBTEMS_BACKEND_BETA',
    'IUMBTEMS_MODEL_ALPHA',
    'IUMBTEMS_MODEL_BETA',
  ],
};

// ---------------------------------------------------------------------------
// structured errors (mirror configure.py codes/messages)
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    const { code, ...rest } = details || {};
    this.code = code || 'CONFIG_ERROR';
    this.message = message;
    this.details = { ...(rest || {}) };
  }

  toDict() {
    const out = { code: this.code, message: this.message };
    if (this.details && Object.keys(this.details).length > 0) {
      out.details = this.details;
    }
    return out;
  }

  toString() {
    const lines = [`[${this.code}] ${this.message}`];
    for (const problem of this.details.errors || []) {
      lines.push(`  - ${problem}`);
    }
    if (this.details.current_hash) {
      lines.push(`  current_hash: ${this.details.current_hash}`);
    }
    return lines.join('\n');
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(problems) {
    const errors = (problems || []).map(String);
    super(
      `Config validation failed with ${errors.length} violation(s); nothing written.`,
      { errors }
    );
    this.name = 'ConfigValidationError';
    this.code = 'CONFIG_VALIDATION_FAILED';
  }

  get errors() {
    return [...(this.details.errors || [])];
  }
}

export class ConfigStaleError extends ConfigError {
  constructor(expectedHash, currentHash, snapshot = {}) {
    const details = {
      expected_hash: expectedHash,
      current_hash: currentHash,
      written: false,
      ...(snapshot || {}),
    };
    super(
      'Config changed on disk since it was read; refusing the stale write. ' +
        'Re-read the fresh snapshot and retry.',
      details
    );
    this.name = 'ConfigStaleError';
    this.code = 'CONFIG_STALE';
  }
}

export class ConfigHashError extends ConfigError {
  constructor(expectedHash) {
    super(
      'expected_hash must be 8-64 hex characters (a full SHA-256 or a ' +
        'unique prefix of at least 8 hex chars).',
      { expected_hash: String(expectedHash) }
    );
    this.name = 'ConfigHashError';
    this.code = 'CONFIG_INVALID_EXPECTED_HASH';
  }
}

/**
 * A caller-supplied null targets a schema-known non-nullable key (R2).
 * Structural unification: `saveConfig` throws this (NULL_FOR_NON_NULLABLE_KEY)
 * instead of the generic CONFIG_VALIDATION_FAILED, mirroring the Python
 * `save_config`/`_handle_config` pre-check. Scoping: only schema-known paths
 * are reported; nulls under unknown keys/roles stay preserved-verbatim.
 */
export class ConfigNullError extends ConfigError {
  constructor(paths) {
    const names = [...new Set((paths || []).map(String))].sort();
    super(
      'null is not accepted for non-nullable key(s): ' +
        names.join(', ') +
        '; omit the key to leave it unchanged, or pass a valid value',
      { errors: names }
    );
    this.name = 'ConfigNullError';
    this.code = 'NULL_FOR_NON_NULLABLE_KEY';
  }

  get errors() {
    return [...(this.details.errors || [])];
  }
}

/**
 * The config file exists but is not a readable, bounded regular file
 * (phase-08 R2, W17). `saveConfig` throws this fail-closed (nothing written)
 * instead of hanging on a FIFO/special device or silently merging over an
 * unreadable/oversize file — mirroring the Python `ConfigUnreadableError`.
 */
export class ConfigUnreadableError extends ConfigError {
  constructor(message, details = {}) {
    super(message, { written: false, ...(details || {}) });
    this.name = 'ConfigUnreadableError';
    this.code = 'CONFIG_UNREADABLE';
  }
}

/** A live `.config.lock` is held by another writer; nothing was written. */
export class ConfigLockedError extends ConfigError {
  constructor(details = {}) {
    super(
      'Another writer holds .research/.config.lock; refusing to clobber a ' +
        'live write. Retry once it is released (stale locks are taken over ' +
        'automatically after 5s).',
      { written: false, ...(details || {}) }
    );
    this.name = 'ConfigLockedError';
    this.code = 'CONFIG_LOCKED';
  }
}

// ---------------------------------------------------------------------------
// schema loading (derived from the generated artifact, never hand-copied)
// ---------------------------------------------------------------------------

let cachedSchema = null;
let schemaAttempted = false;
/**
 * H7: number lexemes (`0.0` vs `0`) of the canonical schema artifact, keyed
 * by literal schema path (`properties.divergence_threshold.maximum`). Lets
 * bound/enum renderings match Python `{bound!r}` exactly; `null` when the
 * artifact is unreadable.
 */
let cachedSchemaLexemes = null;

function schemaArtifactPath() {
  return path.join(PKG_ROOT, 'schemas', 'config.schema.json');
}

/**
 * The canonical CONFIG schema (generated artifact). Returns null when
 * unreadable — validation then degrades to [] with a warning, mirroring the
 * standalone-skill path in configure.py. Never throws.
 */
export function loadConfigSchema() {
  if (schemaAttempted) return cachedSchema;
  schemaAttempted = true;
  try {
    const raw = readFileSync(schemaArtifactPath(), 'utf-8');
    const parsed = parseJsonWithNumberLexemes(raw);
    if (parsed.value && typeof parsed.value === 'object') {
      cachedSchema = parsed.value;
      cachedSchemaLexemes = parsed.lexemes;
    }
  } catch {
    try {
      console.error(
        '[iumbtems config-io] Warning: schemas/config.schema.json unreadable; ' +
          'skipping canonical validation.'
      );
    } catch {
      /* logging must never throw */
    }
    cachedSchema = null;
    cachedSchemaLexemes = null;
  }
  return cachedSchema;
}

/** Test hook: forget the cached schema so the next load re-reads disk. */
export function _resetSchemaCache() {
  cachedSchema = null;
  schemaAttempted = false;
  cachedSchemaLexemes = null;
}

// ---------------------------------------------------------------------------
// lexeme-preserving JSON parse (H7 verbatim-lexeme policy)
// ---------------------------------------------------------------------------

/**
 * Parse JSON text like `JSON.parse` but also record every number's raw lexeme.
 *
 * Returns `{ value, lexemes }` where `lexemes` maps a literal path to the
 * source text of the number there: object keys join with `.` (`verify.min_fuzzy_confidence`),
 * array indices append `[i]` (`license_whitelist[1]`), and the root is `''`
 * (`[0]` for a root-level array element). Values are identical to
 * `JSON.parse` (same doubles, same strings); only the lexeme table is extra.
 * Throws `SyntaxError` on malformed JSON, mirroring `JSON.parse`.
 */
export function parseJsonWithNumberLexemes(text) {
  const src = String(text);
  const lexemes = new Map();
  let pos = 0;

  const fail = (msg) => {
    throw new SyntaxError(`${msg} at position ${pos}`);
  };
  const skipWs = () => {
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') pos += 1;
      else break;
    }
  };
  const expect = (word) => {
    if (src.startsWith(word, pos)) {
      pos += word.length;
      return;
    }
    fail(`expected ${word}`);
  };
  const parseString = () => {
    const start = pos;
    pos += 1; // opening quote
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '"') {
        pos += 1;
        return JSON.parse(src.slice(start, pos));
      }
      pos += 1;
    }
    fail('unterminated string');
  };
  const parseNumber = (at) => {
    const rest = src.slice(pos);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) fail('expected value');
    pos += match[0].length;
    lexemes.set(at, match[0]);
    return Number(match[0]);
  };
  const parseArray = (at) => {
    pos += 1; // [
    const out = [];
    skipWs();
    if (src[pos] === ']') {
      pos += 1;
      return out;
    }
    let i = 0;
    for (;;) {
      out.push(parseValue(`${at}[${i}]`));
      i += 1;
      skipWs();
      if (src[pos] === ',') {
        pos += 1;
        continue;
      }
      if (src[pos] === ']') {
        pos += 1;
        return out;
      }
      fail('expected , or ]');
    }
  };
  const parseObject = (at) => {
    pos += 1; // {
    const out = {};
    skipWs();
    if (src[pos] === '}') {
      pos += 1;
      return out;
    }
    for (;;) {
      skipWs();
      if (src[pos] !== '"') fail('expected string key');
      const key = parseString();
      skipWs();
      if (src[pos] !== ':') fail('expected colon');
      pos += 1;
      out[key] = parseValue(at ? `${at}.${key}` : String(key));
      skipWs();
      if (src[pos] === ',') {
        pos += 1;
        continue;
      }
      if (src[pos] === '}') {
        pos += 1;
        return out;
      }
      fail('expected , or }');
    }
  };
  const parseValue = (at) => {
    skipWs();
    if (pos >= src.length) fail('unexpected end');
    const ch = src[pos];
    if (ch === '{') return parseObject(at);
    if (ch === '[') return parseArray(at);
    if (ch === '"') return parseString();
    if (ch === 't') {
      expect('true');
      return true;
    }
    if (ch === 'f') {
      expect('false');
      return false;
    }
    if (ch === 'n') {
      expect('null');
      return null;
    }
    return parseNumber(at);
  };

  const value = parseValue('');
  skipWs();
  if (pos !== src.length) fail('unexpected trailing content');
  return { value, lexemes };
};

// ---------------------------------------------------------------------------
// dependency-free validator subset (port of runner/schema_validate.py)
// ---------------------------------------------------------------------------

function typeMatches(value, expected) {
  switch (expected) {
    case 'integer':
      // Object-path rule (lexeme-blind): JSON.parse erases the int/float
      // distinction, so an integral float (`2.0`) passes here while Python
      // rejects it (`got float`). See typeMatchesLex for the text-path rule
      // (R3); distinguishing on the object path would change save-path
      // verdicts on info JS cannot recover, so it stays as is by design.
      // WAIVER W21 (F3, Phase 06 `06-parity` REWORK retry 2/3, manager
      // tiebreak binding): object-path integer verdict lexeme-blindness is
      // KEPT by design — `validateConfig({cache_ttl_days: 2.0})` (live JS
      // number `2`) accepts while Python `validate({"cache_ttl_days": 2.0})`
      // rejects (`expected integer|null, got float`); the text path
      // (`validateConfigText('{"cache_ttl_days": 2.0}')`) is the exact
      // surface and is corpus-pinned. Safety: Python load path stays
      // lenient, next Python write re-validates (low harm). TRIGGER: flip
      // deliberately only via a lexeme-aware save entrypoint threading TUI
      // text to the validator (see .roadmap/06-parity/waivers.md W21).
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      // NaN passes the type check and is rejected by the finiteness check,
      // exactly like the Python port (bool can never reach here in JS).
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Python type() names, so messages match schema_validate.py wording. */
function typeName(value) {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/**
 * R3: lexeme-aware integer typing for the TEXT path (`validateConfigText` /
 * `validateAgainstSchema` with a data-lexeme table). `JSON.parse` erases the
 * int/float distinction (`2.0` and `2` both become the double `2`), while
 * Python's `json` keeps it — so `{"cache_ttl_days": 2.0}` is a float in
 * Python (`expected integer|null, got float`) but looked like an int here.
 * When the raw lexeme marks a float (`2.0`, `2e0`) but the value is
 * integral, the value counts as a float: `integer` no longer matches and the
 * type name renders `float`. With no lexeme (object path: `validateConfig` /
 * `saveConfig` on live JS numbers) behavior is byte-identical to before —
 * the int/float distinction is unrecoverable there (documented boundary;
 * object-path verdicts unchanged by design).
 */
function isFloatLexeme(lexeme) {
  return typeof lexeme === 'string' && /[.eE]/.test(lexeme);
}

function typeMatchesLex(value, expected, lexeme = null) {
  if (expected === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (isFloatLexeme(lexeme)) return false;
    return true;
  }
  return typeMatches(value, expected);
}

/** R3: `float` wins when the lexeme marks an integral value as a float. */
function typeNameLex(value, lexeme = null) {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    isFloatLexeme(lexeme)
  ) {
    return 'float';
  }
  return typeName(value);
}

/** Python repr() for scalars/collections (single quotes, True/None).
 *
 * H7 verbatim-lexeme policy (Python repr wins): JSON.parse erases the
 * int/float distinction (`0.0` and `0` both become the double `0`), while
 * Python's `json` keeps it (`{data!r}` renders `0.0` vs `0`). The optional
 * `lexeme` is the raw JSON number text from `parseJsonWithNumberLexemes`;
 * when it marks a float (`0.0`, `1.0`, `2e0`) but the value is integral,
 * render Python-`repr` style (`0.0`, never `0`). Without a lexeme the
 * fallback is plain `String(value)` — programmatic JS integral numbers
 * correspond to Python ints, so default behavior is byte-identical.
 *
 * Residuals (documented, unavoidable without a lexeme): exponential lexemes
 * render via `String()` (JS `1e-7` vs Python `1e-07`), and integers past
 * 2^53 lose precision in both parsers differently (Python keeps the int).
 * WAIVER W22 (F2, Phase 06 `06-parity` REWORK retry 2/3, manager tiebreak
 * binding, second opinion agrees): the exponential float rendering class
 * is WAIVED on BOTH paths — do NOT pad (whack-a-mole: `1e-5` -> JS
 * `0.00001` vs Python `1e-05`, `1e16` -> JS `10000000000000000` vs Python
 * `1e+16` differ by CPython shortest-repr SELECTION thresholds, not just
 * zero-padding, so padding fixes one instance and breaks the next).
 * Documented divergence pinned by
 * `test_w22_exponential_rendering_waiver`. TRIGGER: revisit only via a
 * port of CPython shortest-repr switching, and only if exponential config
 * values occur (see .roadmap/06-parity/waivers.md W22).
 */
function pyRepr(value, lexeme = null) {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (Array.isArray(value)) return `[${value.map((v) => pyRepr(v)).join(', ')}]`;
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(
      ([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`
    );
    return `{${parts.join(', ')}}`;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    if (
      typeof lexeme === 'string' &&
      /[.eE]/.test(lexeme) &&
      Number.isInteger(value)
    ) {
      if (Object.is(value, -0)) return '-0.0';
      const text = String(value);
      if (text.includes('e') || text.includes('E') || text.includes('.')) {
        return text;
      }
      return `${text}.0`;
    }
  }
  return String(value);
}

function pyReprEnum(values, lexemes = null) {
  const list = values || [];
  return `[${list.map((v, i) => pyRepr(v, lexemes ? lexemes[i] ?? null : null)).join(', ')}]`;
}

/**
 * R2: schema-type-aware DATA rendering for the OBJECT path (`validateConfig`
 * on live JS numbers — the path `saveConfig` uses). Without a lexeme an
 * integral JS number is ambiguous (Python `2` is an int, `2.0` a float), so
 * the schema node decides: a float/`number`-context node renders `2.0`-style
 * (matching Python `{data!r}` for float values, e.g. `divergence_threshold:
 * value 2.0 is above maximum 1.0`), while an integer-context node renders
 * `2`. With a lexeme the verbatim text wins (H7 policy, unchanged).
 * Rendering only — comparisons still use the parsed doubles, so no verdict
 * changes in this fix. Schema-literal minima/maxima/enum keep their
 * `loadConfigSchema` lexemes (never routed here).
 * WAIVER W20 (F1, Phase 06 `06-parity` REWORK retry 2/3, manager tiebreak
 * binding): object-path int-in-number-field message ambiguity is
 * INFORMATION-THEORETIC and KEPT in the R2 float direction — live JS `2`
 * === `2.0` (one double), while Python `int(2)` vs `float(2.0)` render
 * `2` vs `2.0`, so `validateConfig({divergence_threshold: 2})` renders
 * `value 2.0 is above maximum 1.0` where Python-on-int-`2` renders
 * `value 2 is above maximum 1.0` (verdicts agree: both reject). The text
 * path (`validateConfigText('{"divergence_threshold": 2}')` -> `2`,
 * `... 2.0}` -> `2.0`) is the exact surface. Documented behavior pinned
 * by `test_w20_object_path_number_context_float_rendering_waiver` — flip
 * deliberately only via a future lexeme-aware entrypoint (see
 * .roadmap/06-parity/waivers.md W20).
 */
function isFloatContext(schemaNode) {
  const t = schemaNode && schemaNode.type;
  const types = Array.isArray(t) ? t : t === undefined ? [] : [t];
  return types.includes('number') && !types.includes('integer');
}

function pyReprData(value, lexeme, schemaNode) {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (lexeme === null || lexeme === undefined) &&
    isFloatContext(schemaNode)
  ) {
    if (Object.is(value, -0)) return '-0.0';
    const text = String(value);
    if (text.includes('.') || text.includes('e') || text.includes('E')) {
      return text;
    }
    return `${text}.0`;
  }
  return pyRepr(value, lexeme);
}

/**
 * Human-readable violations (dotted paths); [] == valid. Ports
 * `runner/schema_validate.py:validate` keyword for keyword.
 *
 * H7: the optional 4th argument carries number lexemes for Python-`repr`
 * rendering — `{ data, schema, schemaPath }` where `data`/`schema` are
 * `parseJsonWithNumberLexemes` tables (either may be null) and `schemaPath`
 * is the literal path of `schema` within its document root (`''` at the
 * root; recursion extends it with `.properties.<key>` / `.items` /
 * `.additionalProperties`). Number *comparisons* always use the parsed
 * doubles, so verdicts are unchanged with or without lexemes (except the R3
 * int-vs-float typing rule, which needs a data lexeme); only message
 * strings gain the `0.0` style. Omitted (or null) keeps the historical
 * rendering for schema bounds, while DATA numbers without a lexeme render
 * schema-type-aware (R2: `number`-context `2` reads `2.0`, integer-context
 * reads `2`).
 */
export function validateAgainstSchema(data, schema, currentPath = '', lex = null) {
  if (!schema || typeof schema !== 'object') return [];
  const problems = [];
  const at = currentPath || '<root>';
  const schemaPath =
    lex && typeof lex.schemaPath === 'string' ? lex.schemaPath : '';
  const childLex = (childSchemaPath) =>
    lex ? { data: lex.data, schema: lex.schema, schemaPath: childSchemaPath } : null;
  const propSchemaPath = (key) =>
    schemaPath ? `${schemaPath}.properties.${key}` : `properties.${key}`;
  const lookupDataLexeme = (dataPath) => {
    if (!lex || !(lex.data instanceof Map)) return null;
    if (lex.data.has(dataPath)) return lex.data.get(dataPath);
    // Legacy display-prefix fallback: root-level arrays used to display as
    // `<root>[i]` while the lexeme table keys them `[i]` (R4 now renders
    // `[i]` directly, so this only fires for callers holding old paths).
    if (dataPath.startsWith('<root>')) {
      const stripped = dataPath.slice('<root>'.length);
      if (lex.data.has(stripped)) return lex.data.get(stripped);
    }
    return null;
  };
  const lookupSchemaLexeme = (keyword) => {
    if (!lex || !(lex.schema instanceof Map)) return null;
    const key = schemaPath ? `${schemaPath}.${keyword}` : keyword;
    return lex.schema.has(key) ? lex.schema.get(key) : null;
  };
  const lookupEnumLexemes = (count) => {
    if (!lex || !(lex.schema instanceof Map)) return null;
    const base = schemaPath ? `${schemaPath}.enum` : 'enum';
    return Array.from({ length: count }, (_, i) => {
      const key = `${base}[${i}]`;
      return lex.schema.has(key) ? lex.schema.get(key) : null;
    });
  };
  const dataLexeme = lookupDataLexeme(currentPath);

  const expected = schema.type;
  if (expected !== undefined) {
    const types = Array.isArray(expected) ? expected : [expected];
    // R3: lexeme-aware integer typing on the text path (object path passes
    // lexeme null, so its verdicts are unchanged by design).
    if (!types.some((t) => typeMatchesLex(data, t, dataLexeme))) {
      return [`${at}: expected ${types.join('|')}, got ${typeNameLex(data, dataLexeme)}`];
    }
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        problems.push(`${at}: missing required key '${key}'`);
      }
    }
    const props = schema.properties || {};
    for (const key of Object.keys(props)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const child = currentPath ? `${currentPath}.${key}` : key;
        problems.push(
          ...validateAgainstSchema(data[key], props[key], child, childLex(propSchemaPath(key)))
        );
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(props));
      const childSchemaPath = schemaPath
        ? `${schemaPath}.additionalProperties`
        : 'additionalProperties';
      for (const key of Object.keys(data)) {
        if (!known.has(key)) {
          const child = currentPath ? `${currentPath}.${key}` : key;
          problems.push(
            ...validateAgainstSchema(data[key], schema.additionalProperties, child, childLex(childSchemaPath))
          );
        }
      }
    }
    if (schema.enum !== undefined && !(schema.enum || []).includes(data)) {
      problems.push(`${at}: value ${pyReprData(data, dataLexeme, schema)} not in enum ${pyReprEnum(schema.enum, lookupEnumLexemes((schema.enum || []).length))}`);
    }
  }

  if (Array.isArray(data) && schema.items && typeof schema.items === 'object') {
    const childSchemaPath = schemaPath ? `${schemaPath}.items` : 'items';
    for (let i = 0; i < data.length; i += 1) {
      // R4: Python renders root-level indices bare (`[1]`); building from the
      // display prefix gave `<root>[1]`. Build from the DATA path ('' at the
      // root), so top-level arrays agree byte-for-byte; nested paths are
      // unchanged (`tags[0]`, `[0][1]`).
      const child = currentPath ? `${at}[${i}]` : `[${i}]`;
      problems.push(...validateAgainstSchema(data[i], schema.items, child, childLex(childSchemaPath)));
    }
  }

  if (data === null || typeof data !== 'object') {
    if (schema.enum !== undefined && !(schema.enum || []).includes(data)) {
      problems.push(`${at}: value ${pyReprData(data, dataLexeme, schema)} not in enum ${pyReprEnum(schema.enum, lookupEnumLexemes((schema.enum || []).length))}`);
    }
  }

  if (typeof data === 'number') {
    if (!Number.isFinite(data)) {
      problems.push(`${at}: value ${pyReprData(data, dataLexeme, schema)} is not finite`);
    } else {
      if (schema.minimum !== undefined && data < schema.minimum) {
        problems.push(`${at}: value ${pyReprData(data, dataLexeme, schema)} is below minimum ${pyRepr(schema.minimum, lookupSchemaLexeme('minimum'))}`);
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        problems.push(`${at}: value ${pyReprData(data, dataLexeme, schema)} is above maximum ${pyRepr(schema.maximum, lookupSchemaLexeme('maximum'))}`);
      }
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      problems.push(`${at}: string shorter than minLength ${pyRepr(schema.minLength)}`);
    }
    if (typeof schema.pattern === 'string') {
      let matched = false;
      try {
        matched = new RegExp(schema.pattern).test(data);
      } catch {
        matched = true; // an invalid pattern must never fail a valid value
      }
      if (!matched) {
        problems.push(
          `${at}: value ${pyRepr(data, dataLexeme)} does not match pattern ${pyRepr(schema.pattern)}`
        );
      }
    }
  }

  return problems;
}

/** Violations of the canonical CONFIG schema; [] == valid. Never throws. */
export function validateConfig(cfg) {
  try {
    const schema = loadConfigSchema();
    if (!schema) return [];
    const lex =
      cachedSchemaLexemes instanceof Map
        ? { data: null, schema: cachedSchemaLexemes, schemaPath: '' }
        : null;
    return validateAgainstSchema(cfg, schema, '', lex);
  } catch {
    return [];
  }
}

/**
 * H7: validate canonical-CONFIG JSON TEXT with verbatim lexemes.
 *
 * Parses `jsonText` with `parseJsonWithNumberLexemes` so float lexemes
 * (`0.0`) survive erasure and messages match Python `{value!r}` exactly
 * (verdicts are identical to `validateConfig` on the same text). Throws
 * `SyntaxError` on malformed JSON, mirroring `JSON.parse`.
 */
export function validateConfigText(jsonText) {
  const { value, lexemes } = parseJsonWithNumberLexemes(jsonText);
  const schema = loadConfigSchema();
  if (!schema) return [];
  return validateAgainstSchema(value, schema, '', {
    data: lexemes,
    schema: cachedSchemaLexemes,
    schemaPath: '',
  });
}

function schemaAllowsNull(subschema) {
  if (!subschema || typeof subschema !== 'object') return false;
  const t = subschema.type;
  if (Array.isArray(t)) return t.includes('null');
  return t === 'null';
}

/**
 * Dotted paths in caller-supplied `caller` where null is banned (R2).
 * Shared nested-null pre-check: `saveConfig` throws `ConfigNullError` for
 * these paths so ALL writers emit `NULL_FOR_NON_NULLABLE_KEY` for
 * schema-known paths. Only schema-known paths are reported; nulls under
 * unknown top-level keys or unknown roles (e.g. `agents.gamma`) carry no
 * nullability info and are preserved-verbatim. Returns [] when the schema
 * is unreadable. Never throws.
 */
export function findCallerNullViolations(caller) {
  try {
    if (!caller || typeof caller !== 'object' || Array.isArray(caller)) return [];
    const schema = loadConfigSchema();
    if (!schema || !schema.properties) return [];
    const props = schema.properties;
    const found = [];
    const walk = (value, subschema, at) => {
      if (value === null || value === undefined) {
        if (subschema && typeof subschema === 'object' && !schemaAllowsNull(subschema)) {
          found.push(at);
        }
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && subschema && typeof subschema === 'object') {
        const subProps = subschema.properties || {};
        const additional = subschema.additionalProperties;
        for (const [k, child] of Object.entries(value)) {
          if (Object.prototype.hasOwnProperty.call(subProps, k)) {
            walk(child, subProps[k], at ? `${at}.${k}` : String(k));
          } else if (additional && typeof additional === 'object') {
            walk(child, additional, at ? `${at}.${k}` : String(k));
          }
        }
        return;
      }
      if (Array.isArray(value) && subschema && typeof subschema === 'object') {
        const items = subschema.items;
        if (items && typeof items === 'object') {
          for (let i = 0; i < value.length; i += 1) {
            walk(value[i], items, `${at}[${i}]`);
          }
        }
      }
    };
    for (const [key, value] of Object.entries(caller)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (value === null || value === undefined) {
        if (!schemaAllowsNull(props[key])) found.push(String(key));
      } else if (value && typeof value === 'object') {
        walk(value, props[key], String(key));
      }
    }
    return [...new Set(found)].sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// defaults / merging / legacy-pin migration (ports of configure.py)
// ---------------------------------------------------------------------------

function deepCopy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Fallback defaults used ONLY when the schema artifact is unreadable.
 * Pinned equal to runner.schemas.CONFIG_DEFAULTS by the parity suite.
 */
export const FALLBACK_DEFAULTS = {
  search_engine: 'duckduckgo',
  max_iterations: 2,
  divergence_threshold: 0.75,
  mode: 'research',
  backend: 'auto',
  cache_raw_markdown: true,
  cache_ttl_days: null,
  search_timeout_s: null,
  searxng_url: null,
  license_whitelist: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'],
  output_dir: '.research',
  allocation: 'dag',
  domain_pack: null,
  verify: { min_fuzzy_confidence: 0.88 },
  agents: {
    alpha: { backend: null, model: null, opencode_agent: null },
    beta: { backend: null, model: null, opencode_agent: null },
  },
  opencode_auto: null,
  opencode_agent: null,
  mcp_servers: {},
};

/** Effective defaults, derived from the schema `default` keywords. */
export function configDefaults() {
  try {
    const schema = loadConfigSchema();
    if (schema && schema.properties && typeof schema.properties === 'object') {
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (sub && typeof sub === 'object' && 'default' in sub) {
          out[key] = deepCopy(sub.default);
        }
      }
      if (Object.keys(out).length > 0) return out;
    }
  } catch {
    /* fall through to the pinned fallback */
  }
  return deepCopy(FALLBACK_DEFAULTS);
}

/** Recursively merge updates over base (updates win; lists replace). */
export function mergeConfig(base, updates) {
  if (
    !base || typeof base !== 'object' || Array.isArray(base) ||
    !updates || typeof updates !== 'object' || Array.isArray(updates)
  ) {
    return deepCopy(updates);
  }
  const merged = deepCopy(base);
  for (const [key, value] of Object.entries(updates)) {
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      merged[key] !== null && typeof merged[key] === 'object' && !Array.isArray(merged[key])
    ) {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = deepCopy(value);
    }
  }
  return merged;
}

function pinsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Drop stale pre-0.7.6 `["claude", "-p"]` pins in place; returns True when
 * changed. Only fires when the top-level backend is not an explicit "claude".
 */
export function migrateLegacyAgentBackends(cfg) {
  try {
    if (String((cfg && cfg.backend) || 'auto').trim().toLowerCase() === 'claude') {
      return false;
    }
    const agents = cfg && cfg.agents;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return false;
    let changed = false;
    for (const role of AGENT_ROLES) {
      const roleCfg = agents[role];
      if (
        roleCfg && typeof roleCfg === 'object' && !Array.isArray(roleCfg) &&
        LEGACY_AGENT_BACKEND_PINS.some((pin) => pinsEqual(roleCfg.backend, pin))
      ) {
        roleCfg.backend = null;
        changed = true;
      }
    }
    return changed;
  } catch {
    return false;
  }
}

function mergeAgents(defaultAgents, fileAgents) {
  const merged =
    defaultAgents && typeof defaultAgents === 'object' && !Array.isArray(defaultAgents)
      ? deepCopy(defaultAgents)
      : {};
  if (!fileAgents || typeof fileAgents !== 'object' || Array.isArray(fileAgents)) {
    return merged;
  }
  for (const [role, roleCfg] of Object.entries(fileAgents)) {
    if (!roleCfg || typeof roleCfg !== 'object' || Array.isArray(roleCfg)) {
      merged[role] = deepCopy(roleCfg);
      continue;
    }
    const base = merged[role];
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      Object.assign(base, deepCopy(roleCfg));
    } else {
      merged[role] = deepCopy(roleCfg);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// paths + reads (never throw)
// ---------------------------------------------------------------------------

export function getConfigPath(baseDir = DEFAULT_RESEARCH_DIR) {
  return path.join(String(baseDir || DEFAULT_RESEARCH_DIR), CONFIG_FILE_NAME);
}

export function getLockPath(baseDir = DEFAULT_RESEARCH_DIR) {
  return path.join(String(baseDir || DEFAULT_RESEARCH_DIR), CONFIG_LOCK_NAME);
}

/** Cap for any single `config.json` read (mirrors the Python `CONFIG_MAX_BYTES`). */
export const CONFIG_MAX_BYTES = 1024 * 1024;

function readBytes(file, maxBytes = CONFIG_MAX_BYTES) {
  // Phase-08 R2 (W17): a FIFO named `config.json` hung every reader on a
  // plain `readFileSync`. Port of the `runner/preflight.py`
  // `_read_bounded_text` semantics: refuse non-regular paths (`stat` +
  // post-open `fstat`, closing the stat->open race), open `O_NONBLOCK`, and
  // cap the read — so a pathological workspace entry (FIFO, device, socket,
  // directory, runaway file) can never block the TUI/plugin. Returns null
  // when the path is absent, unreadable, non-regular, or over the cap.
  // Symlinks are FOLLOWED (behavior-preserving: the pre-fix reader followed
  // them too); a symlink to a non-regular target is still refused.
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  let fd = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    try {
      if (!fstatSync(fd).isFile()) return null;
    } catch {
      return null;
    }
    const chunks = [];
    let remaining = maxBytes + 1;
    const buf = Buffer.alloc(Math.min(remaining, 65536));
    for (;;) {
      let n;
      try {
        n = readSync(fd, buf, 0, Math.min(remaining, buf.length), null);
      } catch {
        return null;
      }
      if (!n) break;
      chunks.push(buf.subarray(0, n).toString('binary'));
      remaining -= n;
      if (remaining <= 0) break;
    }
    const data = Buffer.from(chunks.join(''), 'binary');
    if (data.length > maxBytes) return null;
    return data;
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* close is best-effort */
    }
  }
}

/** SHA-256 of the config file's exact bytes, or null when absent. */
export function configHash(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    const bytes = readBytes(getConfigPath(baseDir));
    if (!bytes) return null;
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function parseJsonObject(bytes) {
  if (!bytes) return null;
  try {
    const data = JSON.parse(bytes.toString('utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Best-effort raw JSON object on disk (null when absent/malformed). */
export function readRawConfig(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    return parseJsonObject(readBytes(getConfigPath(baseDir)));
  } catch {
    return null;
  }
}

/** True when a config file exists but is not a parseable JSON object. */
export function isConfigMalformed(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    const bytes = readBytes(getConfigPath(baseDir));
    if (!bytes) return false;
    return parseJsonObject(bytes) === null;
  } catch {
    return false;
  }
}

/**
 * Single-read snapshot of the config file (phase-03 R5): the raw bytes are
 * read EXACTLY ONCE; `hash` is computed over those bytes and `raw` is parsed
 * from those bytes, so a config parsed from one era can never pair with a
 * hash of another. `malformed` is true when bytes exist but are not a JSON
 * object. Never throws, never writes, never creates directories.
 */
export function readConfigSnapshot(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    const bytes = readBytes(getConfigPath(baseDir));
    if (!bytes) return { hash: null, raw: null, malformed: false };
    let hash = null;
    try {
      hash = createHash('sha256').update(bytes).digest('hex');
    } catch {
      hash = null;
    }
    const raw = parseJsonObject(bytes);
    return { hash, raw, malformed: raw === null };
  } catch {
    return { hash: null, raw: null, malformed: false };
  }
}

/**
 * Effective config merged over defaults from an already-parsed raw object —
 * the no-reread half of `loadConfig` (identical merge, migration, and
 * fallback semantics; the caller owns the bytes). Never throws.
 */
export function loadConfigFromRaw(raw) {
  try {
    const base = configDefaults();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const merged = { ...base, ...deepCopy(raw) };
    merged.agents = mergeAgents(base.agents, raw.agents);
    if (
      raw.verify && typeof raw.verify === 'object' && !Array.isArray(raw.verify) &&
      base.verify && typeof base.verify === 'object' && !Array.isArray(base.verify)
    ) {
      merged.verify = { ...base.verify, ...deepCopy(raw.verify) };
    }
    migrateLegacyAgentBackends(merged);
    return merged;
  } catch {
    try {
      return deepCopy(FALLBACK_DEFAULTS);
    } catch {
      return {};
    }
  }
}

/**
 * Load config merged over defaults. Pure — never writes. Applies the
 * legacy-pin migration in memory; unknown keys are preserved verbatim.
 * Never throws (malformed workspace falls back to defaults with a warning).
 */
export function loadConfig(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    const raw = readRawConfig(baseDir);
    if (!raw) {
      if (isConfigMalformed(baseDir)) {
        try {
          console.error(
            `[iumbtems config-io] Warning: ${getConfigPath(baseDir)} is not a ` +
              'JSON object. Using defaults.'
          );
        } catch {
          /* logging must never throw */
        }
      }
      return configDefaults();
    }
    return loadConfigFromRaw(raw);
  } catch {
    try {
      return deepCopy(FALLBACK_DEFAULTS);
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// effective sources + settings rows (drive the wizard and the panel)
// ---------------------------------------------------------------------------

function envIsSet(env, name) {
  try {
    return String((env || {})[name] ?? '').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Per-key provenance: `env-override` when a mapped env var is set, `file`
 * when the key is present in the raw file, else `default`. Nested role keys
 * fold into their top-level row (`agents` reports env-override when any
 * IUMBTEMS_BACKEND_/MODEL_<ROLE> var is set).
 */
export function effectiveSources(
  baseDir = DEFAULT_RESEARCH_DIR,
  env = process.env
) {
  const sources = {};
  try {
    const schema = loadConfigSchema();
    const keys = schema && schema.properties
      ? Object.keys(schema.properties)
      : Object.keys(FALLBACK_DEFAULTS);
    const raw = readRawConfig(baseDir) || {};
    for (const key of keys) {
      const mapped = ENV_OVERRIDES[key] || [];
      if (mapped.some((name) => envIsSet(env, name))) {
        sources[key] = 'env-override';
      } else if (Object.prototype.hasOwnProperty.call(raw, key)) {
        sources[key] = 'file';
      } else {
        sources[key] = 'default';
      }
    }
  } catch {
    /* sources stay empty rather than throwing */
  }
  return sources;
}

/**
 * Schema-ordered settings rows: {key, label, value, source, restart,
 * description, deprecated, schema}. Pure; reads disk defensively.
 */
export function describeSettings(
  baseDir = DEFAULT_RESEARCH_DIR,
  env = process.env
) {
  try {
    const schema = loadConfigSchema();
    const props =
      (schema && schema.properties) || {};
    const values = loadConfig(baseDir);
    const raw = readRawConfig(baseDir) || {};
    return buildSettingRows(values, raw, env, props);
  } catch {
    return [];
  }
}

/** Pure row builder over already-loaded values (used by the live wizard). */
export function buildSettingRows(values, raw, env = process.env, props = null) {
  try {
    const properties =
      props ||
      (loadConfigSchema() && loadConfigSchema().properties) ||
      {};
    const safe = values && typeof values === 'object' ? values : {};
    const safeRaw = raw && typeof raw === 'object' ? raw : {};
    const rows = [];
    for (const [key, sub] of Object.entries(properties)) {
      const mapped = ENV_OVERRIDES[key] || [];
      const source = mapped.some((name) => envIsSet(env, name))
        ? 'env-override'
        : Object.prototype.hasOwnProperty.call(safeRaw, key)
          ? 'file'
          : 'default';
      rows.push({
        key,
        label: (sub && sub['x-label']) || key,
        value: Object.prototype.hasOwnProperty.call(safe, key)
          ? deepCopy(safe[key])
          : null,
        source,
        restart: (sub && sub['x-restart']) || 'next-run',
        description: (sub && sub.description) || '',
        deprecated: Boolean(sub && sub.deprecated),
        schema: sub || {},
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function prettyValue(value) {
  if (value === undefined) return 'unset';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * Mask an environment-shadowed cell for display: the file value is struck
 * through and marked `(set via environment)` — it is NEVER presented bare as
 * the effective value, and the env value itself is NEVER rendered (secrets
 * stay in env). Takes already-formatted text so panel (full) and wizard
 * (truncated) titles share one rule.
 */
export function maskEnvCell(text) {
  return `~~${text}~~ (set via environment)`;
}

/** Display text for a settings row: masked when env-shadowed, plain otherwise. */
export function displayCell(row, format = prettyValue) {
  let text;
  try {
    text = format(row ? row.value : undefined);
  } catch {
    text = String(row ? row.value : undefined);
  }
  return row && row.source === 'env-override' ? maskEnvCell(text) : text;
}

/** Human-readable settings text for the read-only panel / confirm screen. */
export function formatSettingsText(baseDir = DEFAULT_RESEARCH_DIR, env = process.env) {
  try {
    const rows = describeSettings(baseDir, env);
    if (rows.length === 0) return 'IUMBTEMS settings: no schema available.';
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

/** Human-readable config block (mirrors configure.py display_config). */
export function formatConfig(cfg) {
  try {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const verify = c.verify && typeof c.verify === 'object' ? c.verify : {};
    const lines = [
      '',
      '⚙️  EPISTEMIC SWARM ACTIVE CONFIGURATION',
      '========================================',
      `  🔍 Primary Search Engine:  ${String(c.search_engine ?? 'duckduckgo').toUpperCase()}`,
      `  🔄 Max Iterations (Depth): ${c.max_iterations ?? 2}`,
      `  ⚖️  Divergence Threshold:  ${c.divergence_threshold ?? 0.75} (advisory)`,
      `  🎯 Operating Mode:         ${String(c.mode ?? 'research').toUpperCase()}`,
      `  🖥️  Agent Backend:         ${String(c.backend ?? 'auto').toUpperCase()} (auto = host-native)`,
      `  💾 Raw Markdown Caching:   ${(c.cache_raw_markdown ?? true) ? 'ENABLED' : 'DISABLED'}`,
      `  📜 License Whitelist:      ${Array.isArray(c.license_whitelist) ? c.license_whitelist.join(', ') : ''}`,
      `  🔬 Min Fuzzy Confidence:   ${verify.min_fuzzy_confidence ?? 0.88}`,
      `  📁 Output Directory:       ${c.output_dir ?? '.research'} (deprecated)`,
      '========================================',
      '',
    ];
    return lines.join('\n');
  } catch {
    return 'Epistemic Swarm configuration: unavailable.';
  }
}

// ---------------------------------------------------------------------------
// expected-hash guard (both spellings, phase-01 semantics)
// ---------------------------------------------------------------------------

/**
 * Validate/normalize an expected-hash guard; null means "no guard". Accepts a
 * full 64-hex SHA-256 or a prefix of at least 8 hex chars. Anything else
 * malformed raises ConfigHashError. Never throws on null/empty.
 */
export function normalizeExpectedHash(expectedHash) {
  if (expectedHash === null || expectedHash === undefined) return null;
  const value = String(expectedHash).trim().toLowerCase();
  if (!value) return null;
  if (!/^[0-9a-f]{8,64}$/.test(value)) {
    throw new ConfigHashError(expectedHash);
  }
  return value;
}

/**
 * Resolve the guard from `expected_hash`/`expectedHash` spellings. Both
 * present must agree AFTER normalization (strip + lowercase, mirroring
 * normalizeExpectedHash — Phase-05 H2) or a CONFLICTING_EXPECTED_HASH
 * ConfigError is raised and nothing is written. Case/whitespace-only
 * differences are one guard; empty/whitespace-only spellings count as absent
 * on both sides (R3: "" never conflicts); the winner is validated by
 * normalizeExpectedHash below (malformed -> ConfigHashError).
 */
export function resolveExpectedHash(opts = {}) {
  const snake = opts ? opts.expected_hash : undefined;
  const camel = opts ? opts.expectedHash : undefined;
  const hasSnake = snake !== null && snake !== undefined && String(snake).trim() !== '';
  const hasCamel = camel !== null && camel !== undefined && String(camel).trim() !== '';
  if (
    hasSnake &&
    hasCamel &&
    String(snake).trim().toLowerCase() !== String(camel).trim().toLowerCase()
  ) {
    throw new ConfigError(
      'expected_hash and expectedHash were both provided with different ' +
        'values; provide one spelling (or two equal values).',
      {
        code: 'CONFLICTING_EXPECTED_HASH',
        written: false,
        expected_hash: String(snake),
        expectedHash: String(camel),
      }
    );
  }
  const chosen = hasSnake ? snake : camel;
  return normalizeExpectedHash(chosen ?? null);
}

function hashMatches(expectedHash, currentHash) {
  if (!expectedHash || !currentHash) return false;
  return String(currentHash).startsWith(expectedHash);
}

// ---------------------------------------------------------------------------
// lockfile discipline (O_EXCL create, pid+timestamp, stale takeover > 5s)
// ---------------------------------------------------------------------------

function readLockPayload(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.ts))) {
      return { pid: parsed.pid, ts: Number(parsed.ts), token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquire the workspace lock. Creates `.config.lock` with O_EXCL; a live lock
 * raises ConfigLockedError; a stale lock (> LOCK_STALE_MS) or a foreign file
 * without our pid+timestamp payload is taken over. Returns {release}.
 */
export function acquireLock(baseDir = DEFAULT_RESEARCH_DIR) {
  const dir = String(baseDir || DEFAULT_RESEARCH_DIR);
  mkdirSync(dir, { recursive: true });
  const lockPath = getLockPath(dir);
  const token = `${process.pid}:${Date.now()}:${randomBytes(4).toString('hex')}`;
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now(), token });

  const takeOver = () => {
    // Adopt by OVERWRITING the payload — never by unlinking. Unlinking a
    // foreign lockfile would delete another writer's liveness signal (and a
    // live Python/flock holder's file, which carries no timestamp at all);
    // overwriting leaves a valid pid+timestamp payload behind that our own
    // release() can later verify as ours before unlinking.
    writeFileSync(lockPath, payload, 'utf-8');
  };

  try {
    writeFileSync(lockPath, payload, { flag: 'wx', encoding: 'utf-8' });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
    const existing = readLockPayload(lockPath);
    if (existing) {
      const age = Date.now() - existing.ts;
      if (age <= LOCK_STALE_MS) {
        throw new ConfigLockedError({ lock_age_ms: age, lock_pid: existing.pid });
      }
    }
    // Stale (> 5s) or foreign (no pid+timestamp payload, e.g. a leftover
    // advisory lockfile from the Python writer, which never unlinks): take
    // over rather than deadlocking. Residual window documented above: a live
    // Python holder can still be adopted here; its writes are
    // millisecond-scale so the window is negligible.
    takeOver();
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Unlink ONLY when the on-disk payload is verifiably ours (pid match):
      // a foreign live lock is never removed, and if a concurrent writer
      // adopted the lock away from us after we acquired it, their payload
      // (different pid, and in-process a different token) keeps the file.
      const current = readLockPayload(lockPath);
      if (
        current &&
        current.pid === process.pid &&
        current.token === token
      ) {
        unlinkSync(lockPath);
      }
    } catch {
      /* release is best-effort */
    }
  };
  return { release, token, lockPath };
}

let tempCounter = 0;

// ---------------------------------------------------------------------------
// atomic save
// ---------------------------------------------------------------------------

/**
 * Atomically persist cfg into `<baseDir>/config.json`.
 *
 * - Merges over whatever is on disk (unknown keys survive); cfg wins.
 * - Caller-supplied null for a schema-known non-nullable key (any depth)
 *   throws ConfigNullError (NULL_FOR_NON_NULLABLE_KEY) with dotted paths
 *   before anything is written — the same code as the Python writer; nulls
 *   under unknown keys/roles stay preserved-verbatim for generic validation.
 * - Validates the merged dict (disable only with validate:false when the
 *   exact dict was already validated); other failures raise
 *   ConfigValidationError and write nothing.
 * - Honors the expected-hash guard (both spellings; empty/whitespace-only
 *   spellings count as absent); mismatches raise
 *   ConfigStaleError with a fresh snapshot (no absolute path, mirroring the
 *   Python R5 rule) and write nothing.
 * - Publishes via a unique temp file + rename; `injectFailure:
 *   'after-temp-write'` is a test-only hook that throws between the two so
 *   failure-injection tests can prove the original stays intact.
 */
export function saveConfig(cfg, baseDir = DEFAULT_RESEARCH_DIR, opts = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ConfigValidationError([
      `<root>: expected object, got ${typeName(cfg)} (config must be a JSON object)`,
    ]);
  }
  const nullPaths = findCallerNullViolations(cfg);
  if (nullPaths.length > 0) {
    throw new ConfigNullError(nullPaths);
  }
  const expected = resolveExpectedHash(opts || {});
  const dir = String(baseDir || DEFAULT_RESEARCH_DIR);
  mkdirSync(dir, { recursive: true });
  const cfgFile = getConfigPath(dir);
  const lock = acquireLock(dir);
  let tmp = null;
  try {
    const existing = readBytes(cfgFile);
    let lexists = false;
    try {
      lstatSync(cfgFile);
      lexists = true;
    } catch {
      lexists = false;
    }
    if (existing === null && lexists) {
      // Phase-08 R2 (W17): fail closed (nothing written) rather than hang
      // on a FIFO/special device or silently merge over an
      // unreadable/oversize file — mirrors the Python save_config guard
      // (which also refuses non-file entries such as directories and
      // dangling symlinks instead of replacing them via os.replace).
      throw new ConfigUnreadableError(
        `${cfgFile} exists but is not a readable, bounded regular file ` +
          '(FIFO, device, directory, dangling symlink, or over the read cap); ' +
          'refusing to merge over it.'
      );
    }
    const currentHash = existing
      ? createHash('sha256').update(existing).digest('hex')
      : null;
    if (expected !== null && !hashMatches(expected, currentHash)) {
      throw new ConfigStaleError(expected, currentHash, {
        exists: existing !== null,
        hash: currentHash,
        config: loadConfig(dir),
      });
    }
    const onDisk = parseJsonObject(existing);
    const merged = mergeConfig(onDisk || {}, cfg);
    if (!opts || opts.validate !== false) {
      const problems = validateConfig(merged);
      if (problems.length > 0) {
        throw new ConfigValidationError(problems);
      }
    }
    tempCounter += 1;
    tmp = path.join(
      dir,
      `${CONFIG_FILE_NAME}.${process.pid}-${tempCounter}-${randomBytes(4).toString('hex')}.tmp`
    );
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    if (opts && opts.injectFailure === 'after-temp-write') {
      throw new Error(
        'injected failure between temp write and rename (test hook)'
      );
    }
    renameSync(tmp, cfgFile);
    tmp = null;
    const written = readBytes(cfgFile);
    return {
      path: cfgFile,
      hash: written ? createHash('sha256').update(written).digest('hex') : null,
      written: true,
    };
  } catch (err) {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp cleanup is best-effort */
      }
    }
    throw err;
  } finally {
    lock.release();
  }
}

/** Fresh read-only snapshot: existence, file hash, effective config. */
export function snapshot(baseDir = DEFAULT_RESEARCH_DIR) {
  try {
    const cfgFile = getConfigPath(baseDir);
    return {
      path: cfgFile,
      exists: existsSync(cfgFile),
      hash: configHash(baseDir),
      config: loadConfig(baseDir),
    };
  } catch {
    return { path: getConfigPath(baseDir), exists: false, hash: null, config: {} };
  }
}
