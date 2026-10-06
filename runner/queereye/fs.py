#!/usr/bin/env python3
"""``.queereye/`` filesystem contract: hard error outside, idempotent writes.

- Anything outside ``.queereye/`` is a hard error (:class:`QueereyePathError`).
- Writes are append-only + idempotent: content-hash compared, file written
  only when bytes change.
- User-customized files are never overwritten: a versioned backup
  (``<name>.bak.<short-hash>``) is written and a conflict note returned
  instead of overwriting.
- ``.queereye/tokens.json`` is written incrementally per axis so killed
  sessions resume via ``.queereye/interview.json``.
- All writes are atomic (unique temp file + ``os.replace`` under an
  ``fcntl`` advisory lock, per manifest invariant §6.2.2): a kill
  mid-write never leaves a truncated file.
- Corrupt JSON (truncated ``tokens.json`` / ``interview.json``) raises
  :class:`QueereyeCorruptError` with an actionable message, never a raw
  traceback.
"""

import hashlib
import json
import os
import sys
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

try:  # POSIX advisory locking; no-op where unavailable
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - non-POSIX
    _fcntl = None

QUEEREYE_DIRNAME = ".queereye"

#: Machine-owned files the renderer/compile path may overwrite on change.
#: Phase 02 adds the component-spec surface (components/*.md + webref.json +
#: tui-notes.md + csf.json); the directory entry covers the spec folder.
#: Phase 03 adds the harvest surface (harvest.json + skill bundle dir +
#: Claude overlay dir + cite-gate demo receipt).
MACHINE_FILES = frozenset(
    {
        "tokens.json",
        "tokens.css",
        "probes.json",
        "STYLE_GUIDE.md",
        "interview.json",
        "components",
        "webref.json",
        "tui-notes.md",
        "csf.json",
        "harvest.json",
        "skill",
        "skill-claude",
        "cite-gate-demo.md",
    }
)


class QueereyePathError(ValueError):
    """A write was attempted outside ``.queereye/`` (hard error)."""


class QueereyeCorruptError(ValueError):
    """A ``.queereye/`` JSON file is truncated or otherwise unreadable."""


@contextmanager
def _fallback_file_lock(lock_path: Path):
    """Self-contained cross-process advisory lock; no-op without fcntl."""
    if _fcntl is None:
        yield
        return
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as fh:
        _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
        try:
            yield
        finally:
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)


# Reuse the runner's cross-process lock primitive (see
# runner/state_machine.py) rather than re-implementing it here. The import
# is OPTIONAL: standalone mirrors ship no ``runner/`` package, so we fall
# back to the self-contained primitive above, mirroring the try/except
# precedent in skills/grilling/socratic_tree.py.
try:
    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    from runner.state_machine import _file_lock as _runner_file_lock  # noqa: E402

    _file_lock = _runner_file_lock
except ImportError:  # pragma: no cover - standalone mirror
    _file_lock = _fallback_file_lock

#: In-process guard so concurrent threads in one process serialize writes.
_WRITE_LOCK = threading.Lock()


def _lock_path_for(path: Path) -> Path:
    """Sibling lock file for an atomic write (``<name>.lock``)."""
    return Path(str(path) + ".lock")


def _atomic_write_bytes(path, raw: bytes) -> None:
    """Write ``raw`` bytes atomically: unique temp + ``os.replace`` under lock.

    The original file is never truncated in place: bytes land in a unique
    sibling temp file and ``os.replace`` swaps it into place, so a kill
    mid-write leaves the original intact and no stray ``*.tmp`` survives a
    failed swap (cleanup on exception).
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = _lock_path_for(target)
    with _WRITE_LOCK, _file_lock(lock_path):
        fd, tmp = tempfile.mkstemp(
            dir=str(target.parent), prefix=target.name + ".", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def queereye_dir(project_root):
    """Absolute ``.queereye/`` directory for a project root."""
    return Path(project_root).resolve() / QUEEREYE_DIRNAME


def resolve_inside(project_root, rel):
    """Resolve ``rel`` inside ``.queereye/`` or raise :class:`QueereyePathError`.

    ``rel`` may be a bare filename (``tokens.json``) or a relative path.
    Absolute paths must already live inside ``.queereye/``. Anything else
    (``..``, ``/tmp/x``, ``other/dir``) is a hard error.
    """
    root = queereye_dir(project_root)
    candidate = (
        (root / str(rel)).resolve()
        if not os.path.isabs(str(rel))
        else Path(str(rel)).resolve()
    )
    try:
        candidate.relative_to(root)
    except ValueError:
        raise QueereyePathError(f"refusing write outside .queereye/: {rel!r}")
    if candidate == root:
        raise QueereyePathError(f"refusing write to .queereye/ itself: {rel!r}")
    return candidate


def content_hash(data: bytes) -> str:
    """SHA-256 hex of raw bytes (idempotency comparison)."""
    return hashlib.sha256(data).hexdigest()


def write_if_changed(path, content, user_owned=False):
    """Write ``content`` (str or bytes) only when bytes differ.

    Returns ``(wrote: bool, backup: Path|None, note: str|None)``.

    - Missing parent dirs are created.
    - Identical bytes -> ``(False, None, None)`` (no write, resume-safe).
    - Machine-owned + changed -> atomically overwrite, ``(True, None, None)``.
    - User-owned + changed -> NEVER overwrite: write a versioned backup
      ``<name>.bak.<short-hash-of-existing>`` next to the file and return
      ``(False, backup, conflict-note)``.
    - All actual writes are atomic (unique temp + ``os.replace`` under an
      advisory lock): a crash mid-write leaves the original intact.
    """
    raw = content.encode("utf-8") if isinstance(content, str) else bytes(content)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        existing = path.read_bytes()
        if content_hash(existing) == content_hash(raw):
            return (False, None, None)
        if user_owned:
            short = content_hash(existing)[:12]
            backup = path.with_name(path.name + f".bak.{short}")
            if not backup.is_file():
                _atomic_write_bytes(backup, existing)
            note = (
                f"conflict: {path.name} is user-customized; left untouched, "
                f"existing bytes preserved in {backup.name}"
            )
            return (False, backup, note)
    else:
        if user_owned:
            # New user file: just write it (atomically).
            _atomic_write_bytes(path, raw)
            return (True, None, None)
    _atomic_write_bytes(path, raw)
    return (True, None, None)


def write_queereye_file(project_root, rel, content, user_owned=False):
    """Write a file inside ``.queereye/`` (hard error outside).

    ``user_owned`` marks user-customized files (never overwritten; versioned
    backup + conflict note instead). Machine files overwrite on change.
    Callers must pass ``user_owned=True`` for user-customized notes; the
    default ``False`` means machine-owned (overwrite on change).
    """
    target = resolve_inside(project_root, rel)
    return write_if_changed(target, content, user_owned=user_owned)


def save_interview_state(project_root, loop):
    """Persist ``interview.json`` + incremental ``tokens.json`` for resume.

    Called after every settled axis: ``interview.json`` holds the slot
    values/skipped sets (the resume source), ``tokens.json`` holds the
    derived token tree from settled values + defaults (so a killed session
    resumes with tokens present). Both writes are idempotent + atomic.
    """
    from runner.queereye import tokens as _tokens

    root = queereye_dir(project_root)
    root.mkdir(parents=True, exist_ok=True)
    state = {
        "values": {axis: dict(vals) for axis, vals in loop.values.items()},
        "skipped": {axis: sorted(sk) for axis, sk in loop.skipped.items()},
    }
    state_bytes = json.dumps(state, indent=2, sort_keys=True) + "\n"
    write_queereye_file(project_root, "interview.json", state_bytes)
    tree = loop.to_tokens()
    errs = _tokens.validate_tokens(tree)
    if errs:
        # Partial interviews still persist: validation errors are recorded
        # in the state file rather than blocking the incremental write, so
        # a kill never loses progress. The compile gate enforces validity.
        state["token_errors"] = errs
        state_bytes = json.dumps(state, indent=2, sort_keys=True) + "\n"
        write_queereye_file(project_root, "interview.json", state_bytes)
    token_bytes = json.dumps(tree, indent=2, sort_keys=True) + "\n"
    return write_queereye_file(project_root, "tokens.json", token_bytes)


def load_interview_state(project_root, loop):
    """Restore ``loop`` values/skipped from ``interview.json`` (resume-safe).

    Returns True when state existed, False on fresh start. Missing file is
    not an error (fresh interview). Truncated/corrupt JSON raises
    :class:`QueereyeCorruptError` with an actionable message (never a raw
    ``JSONDecodeError`` traceback).
    """
    target = queereye_dir(project_root) / "interview.json"
    if not target.is_file():
        return False
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise QueereyeCorruptError(
            f"corrupt interview.json at {target}: cannot read ({exc}); "
            "restore from backup or delete it to restart the interview"
        ) from exc
    try:
        state = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise QueereyeCorruptError(
            f"corrupt interview.json at {target}: {exc}; "
            "restore from backup or delete it to restart the interview"
        ) from exc
    if not isinstance(state, dict):
        raise QueereyeCorruptError(
            f"corrupt interview.json at {target}: expected a JSON object; "
            "restore from backup or delete it to restart the interview"
        )
    values = state.get("values") or {}
    skipped = state.get("skipped") or {}
    if not isinstance(values, dict) or not isinstance(skipped, dict):
        raise QueereyeCorruptError(
            f"corrupt interview.json at {target}: 'values'/'skipped' must be "
            "objects; restore from backup or delete it to restart the interview"
        )
    for axis in loop.values:
        loop.values[axis] = dict(values.get(axis) or {})
        loop.skipped[axis] = set(skipped.get(axis) or [])
    return True
