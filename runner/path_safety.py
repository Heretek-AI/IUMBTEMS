#!/usr/bin/env python3
"""Canonical path safety and containment helpers.

Trust boundary
--------------
These helpers exist for the real S8707 pattern: an **untrusted relative segment
joined under a trusted base** (a cache key, a scope id, a filename from an LLM).
That is where containment must be enforced.

They are deliberately *not* applied to caller-chosen CLI/tool arguments such as
``pcrb --out``, ``socratic_tree --file`` or ``--key-file``. Those are the
principal's own paths: the user (or the orchestrating agent) is the trust root,
and restricting them would break legitimate use like writing a brief to
``~/reports/``. Those sites canonicalise with ``os.path.realpath`` only. Do not
"tighten" them by routing through :func:`safe_resolve_path` — that is a behavior
change, not a hardening.
"""

import os
from pathlib import Path
from typing import Union


def safe_resolve_path(untrusted_path: Union[str, Path], base_dir: Union[str, Path]) -> Path:
    """Canonicalise a path and require that it stays inside ``base_dir``.

    Accepts either an absolute path or one relative to ``base_dir``. An absolute
    path is allowed only when it already resolves inside the base; ``..``
    segments and symlinks are resolved *before* the containment test, so neither
    can be used to escape.

    Raises ValueError if the resolved path escapes ``base_dir``.
    """
    base = os.path.realpath(str(base_dir))
    raw = str(untrusted_path)
    # os.path.join would silently drop `base` for an absolute second argument,
    # so decide the candidate explicitly.
    candidate = raw if os.path.isabs(raw) else os.path.join(base, raw)
    target = os.path.realpath(candidate)
    base_prefix = base if base.endswith(os.sep) else base + os.sep
    if target != base and not target.startswith(base_prefix):
        raise ValueError(f"Path traversal detected: {untrusted_path!r} escapes {base_dir!r}")
    return Path(target)


def safe_join(base_dir: Union[str, Path], *segments: str) -> Path:
    """Join untrusted *relative* segments under a trusted base, with containment.

    This is the S8707 shape: ``base_dir / f"{user_token}.md"``. Each segment must
    be a bare name — no separators, no ``..`` — and the joined result must still
    resolve inside ``base_dir``.

    Raises ValueError on any segment that could escape.
    """
    for segment in segments:
        if not segment or segment in (".", ".."):
            raise ValueError(f"Unsafe path segment: {segment!r}")
        if os.sep in segment or (os.altsep and os.altsep in segment):
            raise ValueError(f"Path separator in segment: {segment!r}")
        if Path(segment).name != segment:
            raise ValueError(f"Unsafe path segment: {segment!r}")
    return safe_resolve_path(os.path.join(*segments), base_dir)
