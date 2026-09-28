#!/usr/bin/env python3
"""Structured, typed errors (Heretek-AI/IUMBTEMS#6 item 3.10).

The 0.7.10 diagnostic was the most valuable output in the reporter's session, so
this generalises it: every actionable failure carries a code, the path that was
searched, where output actually went, the resolved workspace, the spawn cwd, and
a suggested fix. An agent can act on that; it cannot act on `FileNotFoundError`.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional


@dataclass
class SwarmError(Exception):
    """Base typed error with the diagnostic fields an agent needs."""

    code: str
    message: str
    path_searched: Optional[str] = None
    path_written: Optional[str] = None
    workspace: Optional[str] = None
    spawn_cwd: Optional[str] = None
    suggested_fix: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.message)

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v not in (None, {}, "")}

    def __str__(self) -> str:
        lines = [f"[{self.code}] {self.message}"]
        for label, value in (
            ("path_searched", self.path_searched),
            ("path_written", self.path_written),
            ("workspace", self.workspace),
            ("spawn_cwd", self.spawn_cwd),
            ("suggested_fix", self.suggested_fix),
        ):
            if value:
                lines.append(f"  {label}: {value}")
        return "\n".join(lines)


class DossierNotFound(SwarmError, FileNotFoundError):
    """A required role dossier is absent.

    Subclasses FileNotFoundError so existing callers/tests keep working.
    """
