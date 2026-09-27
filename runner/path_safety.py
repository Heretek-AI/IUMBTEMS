#!/usr/bin/env python3
"""Canonical path safety and containment helpers for SonarCloud compliance (S8707)."""

import os
from pathlib import Path
from typing import Union


def safe_resolve_path(untrusted_path: Union[str, Path], base_dir: Union[str, Path]) -> Path:
    """Canonicalize a path and verify that it remains within the allowed base directory.

    Prevents path traversal vulnerabilities from untrusted user/LLM input.
    """
    base = os.path.realpath(str(base_dir))
    target = os.path.realpath(os.path.join(base, str(untrusted_path)))
    base_prefix = base if base.endswith(os.sep) else base + os.sep
    if target != base and not target.startswith(base_prefix):
        raise ValueError(f"Path traversal detected: {untrusted_path!r} escapes {base_dir!r}")
    return Path(target)
