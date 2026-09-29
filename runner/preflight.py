#!/usr/bin/env python3
"""Preflight / doctor report for a run (Heretek-AI/IUMBTEMS#6 item 3.2).

The plugin knows things the agent currently has to rediscover: which workspace
resolves, which manifest filename is in play, which backend binary will actually
spawn, and whether the search engine works right now. This reports all of it in
one place, prints it at run start, records it in the manifest, and backs the
`iumbtems_doctor` MCP tool.

Everything here is best-effort and offline-safe: the search probe is
timeout-bounded and can be skipped, and no failure raises.

Search provider ladder (free-first)
-----------------------------------
Retrieval must work without surprise spend. The provider that will actually
serve a run is resolved by a free-first ladder:

  0. host-connected provider (`/connect`, integration store)  -> metered
  1. BYO provider key (exa / firecrawl / parallel / tavily / tinyfish) -> metered
  2. self-hosted SearXNG (`SEARXNG_URL`)                      -> free
  3. DuckDuckGo Lite (zero-key default)                       -> free
  4. Console (hosted)                                         -> metered, never implicit

Provider IDs + env vars: [VERIFIED: 7414d12951b5bf3ca0f26853f562e6450dc1f4734e5330763b420fe173e20003]
Console billing ($0.01 per successful search): [VERIFIED: 6301b3c686f9e404b0e2147ec42255c1ab923e030e1f656c90478b54481ebab6]
`websearch.transform` add()/default.set(): [VERIFIED: dc72ef876fa6d90d288597b81806ef5129bc87deec7562081881901764bed2bd]
websearch permission resource is the query: [VERIFIED: 8bde98f3962fef9407abc4622660d9f52f0490de803151fcc0ce0f648f7c0bbe]
"""

import json
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_PROBE_QUERY = "iumbtems preflight probe"

# ---------------------------------------------------------------------------
# Search provider classification + free-first ladder
# ---------------------------------------------------------------------------

# OpenCode V2 ships five provider-backed websearch engines, each keyed by an
# env var [VERIFIED: 7414d12951b5bf3ca0f26853f562e6450dc1f4734e5330763b420fe173e20003].
# `brave` is kept in the classification tables as a legacy explicit-only alias
# (older MCP server configs reference it) but is NOT shipped by OpenCode v2 and
# is never recommended or auto-selected by the ladder.
BYO_PROVIDERS: Dict[str, str] = {
    "exa": "EXA_API_KEY",
    "firecrawl": "FIRECRAWL_API_KEY",
    "parallel": "PARALLEL_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "tinyfish": "TINYFISH_API_KEY",
}

# Zero-key / self-hosted engines that cost nothing to run.
FREE_PROVIDERS = frozenset({"duckduckgo", "ddg", "searxng"})
# Vendor-billed or usage-billed engines. BYO keys count as metered.
METERED_PROVIDERS = frozenset({"brave", "console"}) | frozenset(BYO_PROVIDERS)

# The host may report a provider the user connected through the OpenCode
# integration store (`/connect`). The credential lives in that store rather than
# the process env, so env-var-only detection would miss it and could halt a run
# whose provider is usable. The plugin writes this channel (see
# `plugins/opencode/index.js:readConnectedWebsearchProvider`) and we read it
# honestly instead of silently bypassing it.
CONNECTED_PROVIDER_ENV = "IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER"
CONNECTED_STATE_NAME = "websearch-state.json"

# The workspace state file is host-written but user-writable and never
# invalidated by a disconnect, so it is ADVISORY only: honoured within this TTL
# of its `updated` stamp and never trusted on its own to mark a provider usable
# (a resolvable credential or the host-confirmed env channel is still required).
STATE_CONNECTED_TTL_SECONDS = 24 * 3600

# The advisory state file is a tiny JSON object. Cap the read so a pathological
# path (FIFO, character device, runaway file) can never wedge the runner or the
# doctor; anything larger is refused as "not a state file".
STATE_MAX_BYTES = 64 * 1024

CONSOLE_PROVIDER = "console"
# Console charges $0.01 after a search returns a valid result set
# [VERIFIED: 6301b3c686f9e404b0e2147ec42255c1ab923e030e1f656c90478b54481ebab6].
CONSOLE_COST_PER_SEARCH = 0.01

SEARXNG_URL_ENV = "SEARXNG_URL"

# Modes that cannot produce grounded output without a working search path.
# `hybrid` retrieves like research. `brainstorm` joins them only once strict (it
# is lateral ideation by default).
RETRIEVAL_MODES = frozenset({"research", "scout", "darkharvest", "hybrid"})


def _norm_provider(provider: Optional[str]) -> str:
    return str(provider or "").strip().lower()


# Zero-key engine ids that run the same code path. `ddg` is accepted by the
# free-first ladder and `FREE_PROVIDERS`, so the reachability probe must compare
# against the SAME canonical spelling or an alias skips the probe entirely and
# silently downgrades the fail-fast gate to a warning.
_DUCKDUCKGO_ALIASES = frozenset({"duckduckgo", "ddg"})


def canonical_engine(engine: Optional[str]) -> str:
    """Canonical zero-key engine id (lowercase, trimmed, ``ddg`` folded)."""
    key = _norm_provider(engine)
    return "duckduckgo" if key in _DUCKDUCKGO_ALIASES else key


def provider_classification(provider: Optional[str]) -> str:
    """Return ``"free"``, ``"metered"``, or ``"unknown"`` for a provider id."""
    key = _norm_provider(provider)
    if key in FREE_PROVIDERS:
        return "free"
    if key in METERED_PROVIDERS:
        return "metered"
    return "unknown"


def detect_byo_provider(env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """First BYO provider whose API key is present, in ladder order."""
    env = os.environ if env is None else env
    for provider, var in BYO_PROVIDERS.items():
        if str(env.get(var) or "").strip():
            return provider
    return None


def _state_is_fresh(stamp: str) -> bool:
    """True when an ISO-8601 ``updated`` stamp is within the advisory TTL."""
    if not stamp:
        return False
    try:
        from datetime import datetime, timezone

        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - when).total_seconds()
    except ValueError:
        return False
    return 0 <= age <= STATE_CONNECTED_TTL_SECONDS


def _read_bounded_text(path: Path, max_bytes: Optional[int] = None) -> Optional[str]:
    """Read at most ``max_bytes`` from ``path`` iff it is a regular file.

    Refuses FIFOs, character/block devices, sockets, directories and symlinks
    (``O_NOFOLLOW`` plus an ``S_ISREG`` check on BOTH the pre-open ``lstat`` and
    the post-open ``fstat`` that closes the lstat->open race). The read is
    ``O_NONBLOCK`` and byte-capped, so a pathological workspace entry cannot
    block the runner or the doctor on an unbounded read. Returns ``None`` when
    the path is not a readable, bounded regular file.
    """
    if max_bytes is None:
        max_bytes = STATE_MAX_BYTES
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
    except OSError:
        return None
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    try:
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
        except OSError:
            return None
        chunks = []
        remaining = max_bytes + 1
        while remaining > 0:
            try:
                chunk = os.read(fd, min(remaining, 65536))
            except BlockingIOError:
                break
            except OSError:
                return None
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) > max_bytes:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _read_state_provider(base_dir: Optional[Path]) -> str:
    """Provider attested by ``websearch-state.json`` IF the file is fresh.

    Advisory channel: the host writes it, but it is user-writable and dropped
    runs are never cleaned up, so a missing/invalid/stale ``updated`` stamp makes
    it unknown rather than authoritative. The file is read through
    :func:`_read_bounded_text`, which refuses non-regular paths and bounds the
    read. Returns ``""`` when nothing is known.
    """
    if not base_dir:
        return ""
    text = _read_bounded_text(Path(base_dir) / CONNECTED_STATE_NAME)
    if text is None:
        return ""
    try:
        data = json.loads(text)
    except ValueError:
        return ""
    if not isinstance(data, dict) or not _state_is_fresh(
        str(data.get("updated") or "").strip()
    ):
        return ""
    candidates = [data.get("connected_provider")]
    listed = data.get("connected_providers")
    if isinstance(listed, (list, tuple)):
        candidates.extend(listed)
    for cand in candidates:
        norm = _norm_provider(cand)
        if norm:
            return norm
    return ""


def _host_confirmed_connected_provider(
    config: Dict[str, Any], env: Dict[str, str]
) -> str:
    """Connected provider from the host-confirmed channels (env -> config).

    These are unforgeable by a workspace file: ``IUMBTEMS_CONNECTED_WEBSEARCH_PROVIDER``
    is set by the host plugin in its own process, and the config keys are read
    from the user's own config. Returns ``""`` when none is set.
    """
    from_env = _norm_provider(env.get(CONNECTED_PROVIDER_ENV))
    if from_env:
        return from_env
    ws = config.get("websearch")
    ws = ws if isinstance(ws, dict) else {}
    for cand in (config.get("connected_provider"), ws.get("connected_provider")):
        norm = _norm_provider(cand)
        if norm:
            return norm
    for key in ("connected_providers", "websearch_providers"):
        seq = config.get(key) or ws.get(key)
        if isinstance(seq, (list, tuple)):
            for cand in seq:
                norm = _norm_provider(cand)
                if norm:
                    return norm
    return ""


def read_connected_state(
    base_dir: Optional[Path] = None,
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Tuple[str, bool]:
    """Resolve the connected provider AND its advisory flag in ONE state read.

    Returns ``(provider, advisory)``. The host-confirmed channels (env/config)
    short-circuit before any file is touched; otherwise the workspace state file
    is read exactly once. Returning both values together is what removes the
    TOCTOU: callers can no longer take a provider from one read and an advisory
    verdict from a second read that observed a different file (a fresh claim in
    read #1 plus garbage in read #2 previously marked an advisory claim
    host-confirmed, granting availability with no credential).
    """
    env = os.environ if env is None else env
    config = config or {}
    confirmed = _host_confirmed_connected_provider(config, env)
    if confirmed:
        return confirmed, False
    from_state = _read_state_provider(base_dir)
    return from_state, bool(from_state)


def connected_websearch_provider(
    base_dir: Optional[Path] = None,
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> str:
    """Best-effort id of a provider the HOST reports as connected (`/connect`).

    Priority: host-confirmed env channel -> config keys -> the workspace state
    file the OpenCode plugin writes (``.research/websearch-state.json``), which
    is honoured only while fresh (see :data:`STATE_CONNECTED_TTL_SECONDS`). The
    integration store itself is only reachable from inside the host plugin, so
    these are the channels it uses to tell the runner. Returns ``""`` when
    nothing is known — never guesses.
    """
    return read_connected_state(base_dir, config, env)[0]


def connected_provider_is_advisory(
    base_dir: Optional[Path] = None,
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> bool:
    """True when the only attested connection is the advisory state file.

    Advisory connections are reported for observability but never mark a
    provider available on their own: the resolver requires a resolvable
    credential (env key) before the rung can serve a run.
    """
    return read_connected_state(base_dir, config, env)[1]


def host_websearch_provider(
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """Explicit websearch provider reported by the host (env > config).

    Shared by the run path and ``iumbtems_doctor`` so both surfaces name the
    provider actually in play instead of re-deriving different ones.
    """
    env = os.environ if env is None else env
    config = config or {}
    from_env = str(env.get("IUMBTEMS_WEBSEARCH_PROVIDER") or "").strip()
    if from_env:
        return from_env
    websearch = config.get("websearch")
    if isinstance(websearch, dict) and websearch.get("provider"):
        return str(websearch["provider"]).strip() or None
    provider = config.get("search_provider")
    return str(provider).strip() if provider else None


def _provider_available(
    provider: str,
    env: Dict[str, str],
    explicit: bool,
    connected: bool = False,
) -> bool:
    key = _norm_provider(provider)
    if key in BYO_PROVIDERS:
        if connected:
            # The host resolved a live connection from its integration store;
            # the credential is not required to appear in OUR env.
            return True
        return bool(str(env.get(BYO_PROVIDERS[key]) or "").strip())
    if key == "brave":
        return bool(str(env.get("BRAVE_API_KEY") or "").strip())
    if key == "searxng":
        # A self-hosted SearXNG only exists if its URL is configured. Explicit
        # selection is NOT availability: an explicit searxng with no
        # SEARXNG_URL resolves to an unreachable localhost default and must halt
        # with the fix rather than proceed ungrounded.
        return bool(str(env.get(SEARXNG_URL_ENV) or "").strip())
    if key == CONSOLE_PROVIDER:
        return True
    if key in ("duckduckgo", "ddg"):
        # Zero-key: no credential needed. Reachability is measured by the probe.
        return True
    return False


def resolve_search_provider(
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
    host_provider: Optional[str] = None,
    connected_provider: Optional[str] = None,
    connected_advisory: bool = False,
) -> Dict[str, Any]:
    """Resolve the active search provider under the free-first ladder.

    A *deliberate* choice always wins: an explicit ``websearch.provider`` (as
    reported by the host) or an explicit non-default ``search_engine`` pins the
    provider. Otherwise the ladder runs host-connected -> BYO key -> SearXNG ->
    DuckDuckGo. The stored default ``duckduckgo`` is the ladder's last free rung,
    not a pin. Console is only ever surfaced when explicitly configured or when
    the host tells us it is active; it is never chosen silently.

    A host that knows Console is the *implicit* provider (no
    ``websearch.provider``, Console-backed account) can surface that by setting
    ``console_implicit``/``websearch.console`` in config — preflight then warns
    loudly about the metered billing and never overrides the setting.

    A provider the user connected via the OpenCode integration store (``/connect``)
    is surfaced through ``connected_provider`` / the state file. A host-confirmed
    connection (env/config channel) counts as available without appearing in our
    env; an *advisory* one (state file only, see ``connected_advisory``) does not
    — it must resolve a real credential or it is ignored.
    """
    config = config or {}
    env = os.environ if env is None else env
    websearch = config.get("websearch")
    websearch = websearch if isinstance(websearch, dict) else {}

    explicit_provider = (
        _norm_provider(host_provider)
        or _norm_provider(websearch.get("provider"))
        or _norm_provider(config.get("search_provider"))
    )
    engine = canonical_engine(config.get("search_engine"))
    connected = _norm_provider(connected_provider) or connected_websearch_provider(
        None, config, env
    )
    if connected_provider is None:
        # This path only sees the host-confirmed env/config channels (no
        # base_dir), so whatever it resolves here is trusted.
        connected_advisory = False

    def info(
        provider: str,
        explicit: bool,
        source: str,
        connected_rung: bool = False,
        advisory: bool = False,
    ) -> Dict[str, Any]:
        key = _norm_provider(provider)
        # An advisory (state-file-only) connection never grants availability by
        # itself: only a host-confirmed connection may serve without an env key.
        trusted_connection = bool(connected_rung) and not advisory
        return {
            "provider": key,
            "explicit": bool(explicit),
            "available": _provider_available(
                key, env, explicit, connected=trusted_connection
            ),
            "tier": provider_classification(key),
            "source": source,
            "env_key": BYO_PROVIDERS.get(key),
            "connected": bool(connected_rung),
            "advisory": bool(advisory),
        }

    def advisory_usable(provider: str) -> bool:
        """A state-file claim only serves a run with a resolvable credential."""
        return _provider_available(provider, env, False, connected=False)

    if explicit_provider:
        # An explicit provider that is ALSO `/connect`ed keeps its credential in
        # the host store, so it must not read as unavailable and halt — unless
        # the connection is only advisory, in which case a real key is required.
        explicit_connected = bool(connected) and explicit_provider == connected
        return info(
            explicit_provider,
            True,
            "configured",
            connected_rung=explicit_connected,
            advisory=explicit_connected and connected_advisory,
        )
    # A non-default engine is also a deliberate choice; the zero-key default
    # (duckduckgo, including its `ddg` alias) is treated as unset so the ladder
    # can prefer a free/cheaper rung the user has evidently made available.
    if engine and engine != "duckduckgo":
        engine_connected = bool(connected) and engine == connected
        return info(
            engine,
            True,
            "search_engine",
            connected_rung=engine_connected,
            advisory=engine_connected and connected_advisory,
        )
    # Host-reported connection (integration store) is a usable provider even
    # without an env key, so it must not be skipped by the env-only ladder. An
    # advisory file claim with no resolvable credential is ignored here and the
    # ladder (ultimately the gate) decides — so a forged/stale file can neither
    # suppress a halt nor block a run that has a real key.
    if connected and connected not in (
        "duckduckgo",
        "ddg",
        "searxng",
        CONSOLE_PROVIDER,
    ):
        if not connected_advisory or advisory_usable(connected):
            return info(
                connected,
                False,
                "host-connected",
                connected_rung=True,
                advisory=connected_advisory,
            )
    byo = detect_byo_provider(env)
    if byo:
        return info(byo, False, "byo-env-key")
    if str(env.get(SEARXNG_URL_ENV) or "").strip():
        return info("searxng", False, "searxng-url")
    # Console is only ever surfaced, never selected implicitly by us.
    console_active = bool(
        config.get("console_implicit")
        or config.get("websearch_console")
        or websearch.get("console") is True
    )
    if console_active:
        return info(CONSOLE_PROVIDER, False, "host-console")
    return info("duckduckgo", False, "zero-key-default")


def estimate_search_cost(provider: Optional[str], searches: int) -> Optional[float]:
    """Best-effort cost estimate for ``searches`` on ``provider``.

    Console is a known $0.01/search; free engines are $0.00. Vendor-billed BYO
    keys return ``None`` (we do not guess someone else's price sheet).
    """
    tier = provider_classification(provider)
    if tier == "free":
        return 0.0
    if _norm_provider(provider) == CONSOLE_PROVIDER:
        return round(max(0, int(searches)) * CONSOLE_COST_PER_SEARCH, 4)
    return None


def _cost_basis(provider: Optional[str]) -> str:
    tier = provider_classification(provider)
    if tier == "free":
        return "free"
    if _norm_provider(provider) == CONSOLE_PROVIDER:
        return "console-per-search"
    if tier == "metered":
        return "vendor-billed"
    return "unknown"


def _metered_mode(provider: Optional[str]) -> str:
    tier = provider_classification(provider)
    if tier == "free":
        return "no"
    if tier == "metered":
        return "yes"
    return "unknown"


def count_our_searches(base_dir: Path, since: Optional[int] = None) -> int:
    """Count query events that flowed through OUR retrieval path.

    Only the skill scripts (`search.py` / `hasher.py` / `webcache.py`) append to
    ``.research/retrieval.jsonl``, so this is our path's search count, not the
    host's. Best-effort: a missing log counts zero.
    """
    try:
        from runner.retrieval_log import summarize

        return int(summarize(base_dir, since=since).get("queries", 0))
    except Exception:  # noqa: BLE001 - telemetry must never fail preflight
        return 0


def build_search_report(
    base_dir: Path,
    config: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
    host_provider: Optional[str] = None,
    since: Optional[int] = None,
    connected_provider: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the provider + cost slice of the preflight report.

    ``since`` is a byte offset so a caller can scope the count to one run (the
    run path passes the offset captured at start); a zero-search run reports 0.
    """
    if connected_provider is None:
        # ONE read resolves both values; a second read could disagree with the
        # first and let a fresh advisory claim be treated as host-confirmed.
        connected_provider, connected_advisory = read_connected_state(
            base_dir, config, env
        )
    else:
        connected_advisory = False
    resolved = resolve_search_provider(
        config,
        env=env,
        host_provider=host_provider,
        connected_provider=connected_provider,
        connected_advisory=connected_advisory,
    )
    provider = resolved.get("provider")
    searches = count_our_searches(base_dir, since=since)
    cost = estimate_search_cost(provider, searches)
    report: Dict[str, Any] = {
        **resolved,
        "searches": searches,
        "cost_estimate": cost,
        "cost_basis": _cost_basis(provider),
        "metered": _metered_mode(provider),
        "console_implicit": bool(
            provider == CONSOLE_PROVIDER and not resolved.get("explicit")
        ),
        # Observability for the advisory channel: a state-file-only claim that
        # did not resolve a credential is dropped rather than advertised.
        "advisory_ignored": (
            connected_provider
            if connected_advisory and provider != connected_provider
            else None
        ),
        "estimate_note": "estimate; counts only searches on OUR path (retrieval.jsonl)",
    }
    report["line"] = format_search_line(report)
    return report


def format_search_line(report: Dict[str, Any]) -> str:
    """One-line provider + cost summary (the acceptance-criteria shape)."""
    provider = str(report.get("provider") or "none")
    tier = str(report.get("tier") or "unknown")
    searches = int(report.get("searches") or 0)
    cost = report.get("cost_estimate")
    if cost is None:
        cost_txt = "~$? est" + (
            ", vendor-billed" if report.get("cost_basis") == "vendor-billed" else ""
        )
    else:
        cost_txt = f"~${float(cost):.2f} est"
    return (
        f"search: {provider} ({tier}) | our-path searches: {searches} "
        f"({cost_txt}) | metered-mode: {report.get('metered', 'unknown')}"
    )


def mode_requires_retrieval(
    mode: Optional[str], config: Optional[Dict[str, Any]] = None
) -> bool:
    """True when a mode cannot produce grounded output without a search path.

    research/scout/darkharvest always need retrieval. brainstorm is lateral
    ideation by default (internal), so it only requires retrieval once strict —
    an explicit ``strict``/``brainstorm_strict`` flag or an active regulated
    domain pack.
    """
    config = config or {}
    key = _norm_provider(mode)
    if key in RETRIEVAL_MODES:
        return True
    if key == "brainstorm":
        return bool(
            config.get("strict")
            or config.get("brainstorm_strict")
            or config.get("domain_pack")
        )
    return False


def search_usable(
    search: Optional[Dict[str, Any]], probe: Optional[Dict[str, Any]] = None
) -> Optional[bool]:
    """Tri-state usability of the resolved search path.

    ``True`` usable, ``False`` not usable, ``None`` inconclusive (e.g. the probe
    was skipped or the host is offline). ``None`` must never halt a run: we only
    fail fast on positive evidence of an unusable path.
    """
    search = search or {}
    probe = probe or {}
    provider = _norm_provider(search.get("provider"))
    if not provider or provider == "none":
        return False
    if search.get("available") is False:
        return False
    if provider in BYO_PROVIDERS or provider in ("brave", "searxng", CONSOLE_PROVIDER):
        return bool(search.get("available", True))
    # DuckDuckGo / DDG-lite: usability is exactly what the probe measures.
    if probe.get("skipped"):
        return None
    status = probe.get("status")
    if status == "ok" or status == "empty":
        return True
    if status in ("blocked", "error"):
        return False
    if probe.get("ok") is True:
        return True
    return None


def _no_search_message(
    mode: Optional[str], search: Dict[str, Any], probe: Dict[str, Any]
) -> str:
    provider = search.get("provider") or "none"
    if provider in BYO_PROVIDERS and search.get("available") is False:
        detail = (
            f"provider '{provider}' is configured but {search.get('env_key')} "
            "is not set and the host reports no live connection"
        )
    elif provider == "searxng" and search.get("available") is False:
        detail = "provider 'searxng' is configured but SEARXNG_URL is not set"
    elif probe.get("status") == "blocked":
        detail = "DuckDuckGo served its anti-bot challenge page (BLOCKED)"
    elif probe.get("status") == "error":
        detail = "the DuckDuckGo probe failed (network/HTTP error)"
    else:
        detail = f"no search provider is usable (resolved: {provider})"
    return (
        f"No usable search for mode '{mode}' and {detail}. Fix one of:\n"
        "  (1) BYO provider key: export EXA_API_KEY / FIRECRAWL_API_KEY / "
        "PARALLEL_API_KEY / TAVILY_API_KEY / TINYFISH_API_KEY "
        "(or /connect one in OpenCode);\n"
        "  (2) self-hosted SearXNG: docker compose -f config/docker-compose.infra.yml "
        "up -d && export SEARXNG_URL=http://localhost:8080;\n"
        "  (3) wait out the block and retry DuckDuckGo.\n"
        "Then set search_engine in .research/config.json (iumbtems_config) to the "
        "chosen engine."
    )


def search_gate(
    mode: Optional[str],
    search: Optional[Dict[str, Any]],
    probe: Optional[Dict[str, Any]] = None,
    config: Optional[Dict[str, Any]] = None,
    console_implicit: Optional[bool] = None,
) -> Dict[str, Any]:
    """Mode-aware availability gate. ``action`` is ``ok`` | ``warn`` | ``halt``.

    Retrieval-requiring modes HALT on a positively unusable search; internal
    modes warn and proceed. An implicit Console (metered) always warns loudly
    and is never overridden.
    """
    config = config or {}
    search = search or {}
    probe = probe or {}
    if console_implicit is None:
        console_implicit = bool(search.get("console_implicit"))
    if console_implicit:
        return {
            "action": "warn",
            "reason": "console_metered",
            "message": (
                "Console websearch is active with no explicit provider: every "
                "successful search bills $0.01 (failed/rate-limited searches are "
                "not charged). Configure a BYO key or a self-hosted engine to "
                "control cost; IUMBTEMS will not override your host setting."
            ),
        }
    usable = search_usable(search, probe)
    if usable is False:
        message = _no_search_message(mode, search, probe)
        if mode_requires_retrieval(mode, config):
            return {
                "action": "halt",
                "reason": "no_usable_search",
                "message": (
                    message + " Refusing to spawn agents with no way to ground claims."
                ),
            }
        return {
            "action": "warn",
            "reason": "no_usable_search",
            "message": f"{mode} does not require retrieval; proceeding. {message}",
        }
    if usable is None and mode_requires_retrieval(mode, config):
        return {
            "action": "warn",
            "reason": "search_unknown",
            "message": (
                f"could not verify a usable search for mode '{mode}' (probe "
                "skipped/offline); proceeding without fail-fast. Run "
                "`iumbtems doctor` with a live probe before relying on grounding."
            ),
        }
    return {"action": "ok", "reason": "ok", "message": ""}


def plugin_version() -> Optional[str]:
    try:
        return json.loads(
            (PROJECT_ROOT / "package.json").read_text(encoding="utf-8")
        ).get("version")
    except (OSError, ValueError):
        return None


_plugin_version = plugin_version  # backwards-compatible alias


def _backend_report(base_dir: Path, mock_mode: bool) -> Dict[str, Any]:
    try:
        from runner.research_swarm import (
            SwarmRunner,  # noqa: F401  (ensures module import side effects)
            _default_backend_cmd,
            _opencode_auto,
        )

        runner = SwarmRunner(base_dir=base_dir, mock_mode=mock_mode, mode="research")
        backend, model = runner._resolve_agent_backend("alpha")
        family = backend[0] if backend else "?"
        resolved = shutil.which(family) or family
        return {
            "family": family,
            "argv": backend,
            "model": model,
            "binary": resolved,
            "binary_found": bool(shutil.which(family)),
            "opencode_auto": _opencode_auto(runner.config),
            "default_auto": _default_backend_cmd("auto"),
        }
    except Exception as exc:  # noqa: BLE001 - doctor must never raise
        return {"error": str(exc)}


def _engine_probe(engine: str, probe: bool, timeout: float) -> Dict[str, Any]:
    """Probe DuckDuckGo reachability WITHOUT polluting the retrieval log.

    The probe is not an agent search: logging it made a zero-search run report
    ``our-path searches: 1`` and, because the skill scripts log to
    ``default_base_dir()`` (cwd / IUMBTEMS_RESEARCH_DIR), a run pointed at
    ``--dir /tmp/X/.research`` appended probe events to the *repo's* own
    ``.research/retrieval.jsonl``. We therefore pass ``log=False`` so the probe
    is counted nowhere — no cross-workspace leak and an honest zero.
    """
    if not probe:
        return {"skipped": "probe disabled"}
    # Compare against the canonical engine: the ladder accepts `ddg` (and any
    # case/whitespace variant), so an exact match here would silently skip the
    # probe for those spellings and downgrade the gate to a warning.
    if canonical_engine(engine) != "duckduckgo":
        return {"skipped": f"no zero-key probe for engine '{engine}'"}
    try:
        sys.path.insert(
            0, str(PROJECT_ROOT / "skills" / "epistemic_search" / "scripts")
        )
        import search  # noqa: PLC0415

        # Prefer the typed probe so a DDG anti-bot interstitial is reported as
        # `blocked` and distinguishes itself from a genuine no-hits `empty`.
        detailed = getattr(search, "search_duckduckgo_detailed", None)
        if callable(detailed):
            try:
                outcome = detailed(
                    DEFAULT_PROBE_QUERY, max_results=3, log=False, timeout=timeout
                )
            except TypeError:
                # Older script without a `timeout` kwarg.
                outcome = detailed(DEFAULT_PROBE_QUERY, max_results=3, log=False)
            status = str(outcome.get("status") or "unknown")
            results = outcome.get("results") or []
            payload: Dict[str, Any] = {
                "ok": status == "ok",
                "status": status,
                "results": len(results),
            }
            if outcome.get("hint"):
                payload["hint"] = outcome["hint"]
            return payload
        try:
            results = search.search_duckduckgo(
                DEFAULT_PROBE_QUERY, max_results=3, log=False, timeout=timeout
            )
        except TypeError:
            # Older script without `log`/`timeout`; the probe result still counts
            # nowhere here (its event would be the only leaked one) — surface the
            # probe but never fail preflight over it.
            results = search.search_duckduckgo(DEFAULT_PROBE_QUERY, max_results=3)
        return {
            "ok": bool(results),
            "status": "ok" if results else "empty",
            "results": len(results),
        }
    except Exception as exc:  # noqa: BLE001 - network/offline is not an error
        return {"ok": False, "status": "error", "error": str(exc)}


def _scratchpad_write_test(base_dir: Path) -> Dict[str, Any]:
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
        probe = base_dir / ".preflight-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return {"ok": True, "path": str(base_dir)}
    except OSError as exc:
        return {"ok": False, "path": str(base_dir), "error": str(exc)}


def _resolve_probe_timeout(
    config: Optional[Dict[str, Any]], explicit: Optional[float]
) -> float:
    """Probe timeout: explicit arg > config `search_timeout_s` > 5.0 default.

    The config key is a single knob shared with the search CLI
    (`IUMBTEMS_SEARCH_TIMEOUT_S`); absent/null keeps the historical 5s probe.
    """
    if explicit is not None:
        return explicit
    raw = (config or {}).get("search_timeout_s")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 5.0
    value = float(raw)
    return value if value > 0 else 5.0


def _env_with_config_searxng(
    config: Optional[Dict[str, Any]], env: Optional[Dict[str, str]]
) -> Dict[str, str]:
    """Seed `SEARXNG_URL` from config `searxng_url` when the env does not set it.

    Precedence: the environment wins (file < env), so an exported SEARXNG_URL is
    never overridden; a configured URL makes the in-process preflight/doctor
    path see the same self-hosted engine the spawned children get.
    """
    merged = dict(os.environ) if env is None else dict(env)
    if str(merged.get(SEARXNG_URL_ENV) or "").strip():
        return merged
    value = (config or {}).get("searxng_url")
    if isinstance(value, str) and value.strip():
        merged[SEARXNG_URL_ENV] = value.strip()
    return merged


def preflight(
    base_dir: Path,
    mode: str = "research",
    config: Optional[Dict[str, Any]] = None,
    mock_mode: bool = False,
    probe: bool = True,
    timeout: Optional[float] = None,
    env: Optional[Dict[str, str]] = None,
    host_provider: Optional[str] = None,
    since: Optional[int] = None,
    connected_provider: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the preflight report. Never raises."""
    config = config or {}
    timeout = _resolve_probe_timeout(config, timeout)
    env = _env_with_config_searxng(config, env)
    engine = canonical_engine(config.get("search_engine")) or "duckduckgo"
    report: Dict[str, Any] = {
        "plugin_version": _plugin_version(),
        "python": sys.version.split()[0],
        "node": shutil.which("node") or None,
        "mode": mode,
        "workspace": str(base_dir),
        "manifest": None,
        "project_dir": os.environ.get("IUMBTEMS_PROJECT_DIR") or None,
        "cwd": os.getcwd(),
        "pwd": os.environ.get("PWD") or None,
        "engine": engine,
        "warnings": [],
    }
    try:
        from runner.state_machine import manifest_name_for_mode

        report["manifest"] = manifest_name_for_mode(mode)
    except Exception:  # noqa: BLE001
        pass

    report["backend"] = _backend_report(base_dir, mock_mode)
    report["engine_probe"] = _engine_probe(engine, probe, timeout)
    report["workspace_write"] = _scratchpad_write_test(base_dir)
    report["search"] = build_search_report(
        base_dir,
        config=config,
        env=env,
        host_provider=host_provider,
        since=since,
        connected_provider=connected_provider,
    )
    report["search_gate"] = search_gate(
        mode, report["search"], report["engine_probe"], config=config
    )

    if report["backend"].get("binary_found") is False and not mock_mode:
        report["warnings"].append(
            f"backend binary '{report['backend'].get('family')}' not found on PATH"
        )
    if report["engine_probe"].get("ok") is False:
        status = report["engine_probe"].get("status")
        if status == "blocked":
            report["warnings"].append(
                "search engine probe BLOCKED (DuckDuckGo anti-bot page)"
            )
        else:
            report["warnings"].append("search engine probe returned no results")
    if report["workspace_write"].get("ok") is False:
        report["warnings"].append("workspace is not writable")
    gate = report.get("search_gate") or {}
    if gate.get("action") == "halt":
        report["warnings"].append(f"search gate HALT: {gate.get('message')}")
    elif gate.get("action") == "warn" and gate.get("message"):
        report["warnings"].append(f"search gate: {gate.get('message')}")
    return report


def format_report(report: Dict[str, Any]) -> str:
    backend = report.get("backend", {})
    probe = report.get("engine_probe", {})
    if probe.get("skipped"):
        probe_txt = str(probe.get("skipped"))
    elif probe.get("ok"):
        probe_txt = f"{probe.get('results')} results"
    elif probe.get("status") == "blocked":
        probe_txt = "BLOCKED (anti-bot page)"
    elif probe.get("status") == "error":
        probe_txt = f"FAILED ({probe.get('error', '?')})"
    elif probe.get("status") == "empty":
        probe_txt = "no results"
    else:
        probe_txt = "FAILED"
    lines = [
        f"iumbtems preflight: v{report.get('plugin_version')} | mode={report.get('mode')}",
        f"  workspace : {report.get('workspace')} | manifest: {report.get('manifest')}",
        f"  spawn cwd : {report.get('cwd')} | PWD: {report.get('pwd')}",
        f"  backend   : {backend.get('family')} ({backend.get('binary')})"
        f"{'' if backend.get('binary_found') else '  ⚠️ NOT FOUND'}"
        f"{' | --auto' if backend.get('opencode_auto') else ''}",
        f"  engine    : {report.get('engine')} -> {probe_txt}",
        f"  write test: {'ok' if report.get('workspace_write', {}).get('ok') else 'FAILED'}",
    ]
    search = report.get("search") or {}
    if search.get("line"):
        lines.append(f"  {search['line']}")
    for warning in report.get("warnings", []):
        lines.append(f"  ⚠️ {warning}")
    return "\n".join(lines)
