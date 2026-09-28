#!/usr/bin/env python3
"""Socratic-frontier concurrency regression.

Reproduced live: six parallel `iumbtems_socratic_frontier` adds raced through a
bare `open(path, "w")` in `DesignTree.export_frontier_json` and produced invalid
JSON ("Extra data: line 43 column 2"), which had to be repaired by hand. Frontier
mutations now run as a locked read-modify-write (unique temp + os.replace under a
cross-process advisory lock), so concurrent add/settle calls cannot corrupt the
file or silently drop one another's nodes.

Determinism: the writer processes rendezvous on a start sentinel so they are all
known to be running before any of them reads or writes the frontier. Measured
against the pre-fix tree (`git show HEAD:skills/grilling/socratic_tree.py`):
unpinned on a multi-core host the pre-fix code loses nodes on every trial (0/12
locally, 0/12 in QA); pinned to a single core (`taskset -c 0`) it still passes
some trials (~2/12 locally, ~12/42 in QA), because a barrier cannot force the
read-modify-write to interleave when only one core is available to schedule the
writers. Detection is therefore reliable unpinned and only probabilistic under
single-core pinning.

Point the suite at a specific tree with `SOCRATIC_TREE_UNDER_TEST=/path/to/file`
(e.g. the pre-fix `git show HEAD:skills/grilling/socratic_tree.py`).
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from skills.grilling.socratic_tree import (  # noqa: E402
    DecisionNode,
    DesignTree,
    frontier_transaction,
)

SOCRATIC_TREE = Path(
    os.environ.get("SOCRATIC_TREE_UNDER_TEST")
    or (PROJECT_ROOT / "skills" / "grilling" / "socratic_tree.py")
)

# Child driver: import the tree under test (so import cost is paid BEFORE the
# rendezvous), signal readiness, wait for the shared start sentinel, then invoke
# the real CLI entry point in-process. Running `main()` in the already-warm
# process removes interpreter-startup jitter, so every writer enters the
# read-modify-write at essentially the same instant.
_BARRIER_CHILD = r"""
import importlib.util
import os
import sys
import time

repo, tree_path, ready_path, start_path = sys.argv[1:5]
cli_args = sys.argv[5:]

if repo not in sys.path:
    sys.path.insert(0, repo)

spec = importlib.util.spec_from_file_location("socratic_tree_under_test", tree_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Fully initialised -> signal readiness, then rendezvous with the other writers.
open(ready_path, "w", encoding="utf-8").close()
deadline = time.time() + 30.0
while not os.path.exists(start_path):
    if time.time() > deadline:
        sys.exit(3)
    time.sleep(0.0005)

sys.argv = ["socratic_tree_under_test"] + cli_args
mod.main()
"""


def _run_barrier_writers(tmp: Path, writer_args_for, n: int, timeout: float = 120.0):
    """Launch `n` writer processes that all rendezvous before mutating.

    Every child imports the tree module, publishes `ready/<i>.ready`, then
    busy-waits for `START`. The parent creates `START` only once all `n` children
    are ready, so all writers overlap before any of them touches the frontier.
    Returns a list of (returncode, stdout, stderr).
    """
    child = tmp / "writer_child.py"
    child.write_text(_BARRIER_CHILD, encoding="utf-8")
    ready_dir = tmp / "ready"
    ready_dir.mkdir(exist_ok=True)
    start = tmp / "START"

    procs = []
    for i in range(n):
        procs.append(
            subprocess.Popen(
                [
                    sys.executable,
                    str(child),
                    str(PROJECT_ROOT),
                    str(SOCRATIC_TREE),
                    str(ready_dir / f"{i}.ready"),
                    str(start),
                    *writer_args_for(i),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        )

    deadline = time.time() + timeout
    while len(list(ready_dir.glob("*.ready"))) < n:
        if time.time() > deadline:
            for p in procs:
                p.kill()
            raise AssertionError(f"barrier timed out: not all {n} writers were ready")
        time.sleep(0.01)
    start.write_text("go", encoding="utf-8")

    results = []
    for p in procs:
        out, err = p.communicate(timeout=timeout)
        results.append((p.returncode, out, err))
    return results


class TestFrontierConcurrency(unittest.TestCase):
    def test_parallel_adds_keep_every_node_and_valid_json(self):
        """N overlapping processes adding concurrently must not corrupt or lose."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            frontier = tmp_path / "frontier.json"
            n = 12

            results = _run_barrier_writers(
                tmp_path,
                lambda i: [
                    "--add-node",
                    "--id",
                    f"N{i}",
                    "--question",
                    f"Q{i}?",
                    "--file",
                    str(frontier),
                ],
                n,
            )

            for code, _out, err in results:
                self.assertEqual(code, 0, err)

            # Valid JSON documenting every node the writers added.
            data = json.loads(frontier.read_text(encoding="utf-8"))
            self.assertEqual(set(data["nodes"]), {f"N{i}" for i in range(n)})
            # No stray unique temp files left behind.
            self.assertEqual(list(tmp_path.glob("frontier.json.*.tmp")), [])

    def test_parallel_settles_do_not_lose_updates(self):
        """Concurrent settles must all land (write-only locking would drop some)."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            frontier = tmp_path / "frontier.json"
            n = 12
            tree = DesignTree(objective="settle race")
            for i in range(n):
                tree.add_node(
                    DecisionNode(
                        node_id=f"N{i}",
                        title=f"N{i}",
                        question=f"Q{i}?",
                        recommended="",
                    )
                )
            tree.export_frontier_json(frontier)

            results = _run_barrier_writers(
                tmp_path,
                lambda i: ["--settle", f"N{i}", f"A{i}", "--file", str(frontier)],
                n,
            )
            for code, _out, err in results:
                self.assertEqual(code, 0, err)

            data = json.loads(frontier.read_text(encoding="utf-8"))
            for i in range(n):
                self.assertEqual(data["nodes"][f"N{i}"]["settled_answer"], f"A{i}")

    def test_transaction_holds_the_lock_for_the_whole_cycle(self):
        """Deterministic: a second transaction cannot interleave mid-mutation."""
        with tempfile.TemporaryDirectory() as tmp:
            frontier = Path(tmp) / "frontier.json"
            order = []
            barrier = threading.Barrier(2)

            def worker(tag: str) -> None:
                barrier.wait()
                with frontier_transaction(frontier, "lock race") as tree:
                    order.append(f"in:{tag}")
                    tree.add_node(
                        DecisionNode(
                            node_id=tag,
                            title=tag,
                            question="?",
                            recommended="",
                        )
                    )
                    time.sleep(0.2)  # widen the window a real write would occupy
                    order.append(f"out:{tag}")

            threads = [
                threading.Thread(target=worker, args=(tag,)) for tag in ("a", "b")
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            serialized = [
                ["in:a", "out:a", "in:b", "out:b"],
                ["in:b", "out:b", "in:a", "out:a"],
            ]
            self.assertIn(order, serialized)
            data = json.loads(frontier.read_text(encoding="utf-8"))
            self.assertEqual(set(data["nodes"]), {"a", "b"})

    def test_nested_export_inside_transaction_does_not_deadlock(self):
        """Re-entrant locking: export_frontier_json inside a transaction must not hang."""
        with tempfile.TemporaryDirectory() as tmp:
            frontier = Path(tmp) / "frontier.json"
            done = threading.Event()
            errors = []

            def worker() -> None:
                try:
                    with frontier_transaction(frontier, "nested") as tree:
                        tree.add_node(
                            DecisionNode(
                                node_id="N",
                                title="N",
                                question="?",
                                recommended="",
                            )
                        )
                        # Same thread, second fd on the same lock path: without the
                        # in-process re-entrancy guard this flock self-deadlocks.
                        tree.export_frontier_json(frontier)
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)
                finally:
                    done.set()

            t = threading.Thread(target=worker, daemon=True)
            t.start()
            t.join(timeout=10)
            self.assertTrue(
                done.is_set(),
                "nested export_frontier_json self-deadlocked (no re-entrancy)",
            )
            self.assertEqual(errors, [])
            data = json.loads(frontier.read_text(encoding="utf-8"))
            self.assertIn("N", data["nodes"])

    def test_lock_path_does_not_collide_with_data(self):
        """A frontier literally named `frontier.lock` must not lock its own data."""
        with tempfile.TemporaryDirectory() as tmp:
            frontier = Path(tmp) / "frontier.lock"
            # A fresh run must not have the lock file *be* the data file (which
            # would leave an empty data file for load_from_json to choke on).
            with frontier_transaction(frontier, "collide") as tree:
                tree.add_node(
                    DecisionNode(node_id="N", title="N", question="?", recommended="")
                )

            data = json.loads(frontier.read_text(encoding="utf-8"))
            self.assertEqual(set(data["nodes"]), {"N"})
            # The lock lives at a distinct, appended path.
            self.assertTrue((Path(tmp) / "frontier.lock.lock").exists())


if __name__ == "__main__":
    unittest.main()
