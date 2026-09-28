#!/usr/bin/env python3
"""Gate: the shipped socratic-grilling mirror must run standalone.

`skills/grilling/socratic_tree.py` is byte-mirrored into
`plugins/socratic-grilling/skills/grilling/socratic_tree.py` (see
`scripts/build_adapters.py`), which ships WITHOUT a `runner/` package. The
canonical file is allowed to `import runner` because it lives inside the repo
and can put the repo root on `sys.path`; the mirror cannot, so retry 1 replaced
the hard import with a `try: from runner.state_machine import ...` /
`except ImportError: <self-contained fallback>`.

Nothing executed that shipped copy standalone, so a future hard `runner` import
in the canonical skill would be mirrored byte-identically and CI would stay
green while the plugin CLI died with `ModuleNotFoundError`. This test runs the
mirror as a subprocess from a cwd OUTSIDE the repo with the repo absent from
`PYTHONPATH` and user site-packages disabled, so `import runner` genuinely
fails; exit 0 is required. A hard `runner` import makes the process exit
non-zero at import time.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

CANONICAL = PROJECT_ROOT / "skills" / "grilling" / "socratic_tree.py"
MIRROR = (
    PROJECT_ROOT
    / "plugins"
    / "socratic-grilling"
    / "skills"
    / "grilling"
    / "socratic_tree.py"
)

# Interpreter settings worth preserving for a well-behaved child, but NEVER the
# repository on the import path. Everything else is dropped so the child cannot
# accidentally resolve `runner` from the host environment.
_ALLOWED_ENV = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
)


def _standalone_env() -> dict:
    """A minimal environment with the repo off PYTHONPATH and no user site."""
    env = {key: os.environ[key] for key in _ALLOWED_ENV if key in os.environ}
    env["PYTHONPATH"] = ""  # never inherit a repo path from the parent process
    env["PYTHONNOUSERSITE"] = "1"  # ignore ~/.local site-packages
    env["PYTHONIOENCODING"] = "utf-8"  # the CLI prints emoji to stdout
    return env


class TestShippedMirrorRunsStandalone(unittest.TestCase):
    def test_mirror_is_a_byte_identical_canonical_copy(self):
        self.assertTrue(MIRROR.is_file(), f"missing shipped mirror: {MIRROR}")
        # `build_adapters.py --check` also enforces this; asserting it here means
        # this gate can never pass against a stale or stray mirror.
        self.assertEqual(
            MIRROR.read_bytes(),
            CANONICAL.read_bytes(),
            "shipped mirror drifted from the canonical skill",
        )

    def test_runner_is_unimportable_in_the_standalone_env(self):
        """Fail loudly if the gate is vacuous (e.g. `runner` became installed).

        Without this guard a host that can still import `runner` would let the
        standalone run succeed even after a hard import was reintroduced.
        """
        with tempfile.TemporaryDirectory() as tmp:
            probe = subprocess.run(
                [sys.executable, "-c", "import runner"],
                cwd=tmp,
                env=_standalone_env(),
                capture_output=True,
                text=True,
            )
        self.assertNotEqual(
            probe.returncode,
            0,
            "test is vacuous: `runner` is importable with the repo off "
            f"PYTHONPATH (stdout={probe.stdout!r}, stderr={probe.stderr!r})",
        )
        self.assertIn("runner", probe.stderr)

    def test_mirror_runs_standalone_without_runner(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            frontier = tmp_path / "frontier.json"
            env = _standalone_env()

            # Read-only path: before retry 1 this died at import time with
            # ModuleNotFoundError while resolving `runner.state_machine`.
            show = subprocess.run(
                [
                    sys.executable,
                    str(MIRROR),
                    "--show-frontier",
                    "--file",
                    str(frontier),
                ],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(show.returncode, 0, show.stderr)
            self.assertNotIn("ModuleNotFoundError", show.stderr)

            # Mutating path exercises the self-contained atomic-write + advisory
            # lock fallbacks that replaced the runner primitives.
            add = subprocess.run(
                [
                    sys.executable,
                    str(MIRROR),
                    "--add-node",
                    "--id",
                    "N0",
                    "--question",
                    "Q0?",
                    "--file",
                    str(frontier),
                ],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(add.returncode, 0, add.stderr)

            # The child wrote a real, well-formed frontier under a foreign cwd.
            data = json.loads(frontier.read_text(encoding="utf-8"))
            self.assertIn("N0", data["nodes"])
            self.assertEqual(
                list(tmp_path.glob("frontier.json.*.tmp")), [], "temp file leaked"
            )


if __name__ == "__main__":
    unittest.main()
