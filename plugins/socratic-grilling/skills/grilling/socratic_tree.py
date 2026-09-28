#!/usr/bin/env python3
"""
Socratic Tree & Decision Frontier Engine for Epistemic Swarm.
Implements Matt Pocock-style design tree traversal to isolate the active decision frontier.
"""

import sys
import os
import json
import argparse
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional, Any

try:  # POSIX advisory locking; no-op where unavailable
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - non-POSIX
    _fcntl = None


def _fallback_atomic_write_json(path: Path, data: Any) -> None:
    """Self-contained atomic JSON write: unique temp file + os.replace.

    Fallback used when `runner.state_machine` is not importable, e.g. the
    generated plugin mirror (plugins/socratic-grilling/) run standalone from an
    arbitrary cwd where no `runner/` package exists.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


@contextmanager
def _fallback_file_lock(lock_path: Path):
    """Self-contained cross-process advisory lock; graceful no-op without fcntl."""
    if _fcntl is None:
        yield
        return
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as fh:
        _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
        try:
            yield
        finally:
            _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)


# Reuse the runner's cross-process lock + atomic-write primitives (see
# runner/state_machine.py) rather than re-implementing them here. The import is
# OPTIONAL: the generated plugin mirror ships no `runner/` package, so it must
# still run standalone from an arbitrary cwd. On ImportError we fall back to the
# self-contained primitives above, mirroring the try/except precedent in
# plugins/research-cache/skills/research_cache/hasher.py.
try:
    PROJECT_ROOT = Path(__file__).resolve().parents[2]
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))
    from runner.state_machine import _atomic_write_json, _file_lock  # noqa: E402
except ImportError:  # pragma: no cover - plugin mirror / standalone
    _atomic_write_json = _fallback_atomic_write_json
    _file_lock = _fallback_file_lock


class DecisionNode:
    def __init__(
        self,
        node_id: str,
        title: str,
        question: str,
        recommended: str,
        options: Optional[List[str]] = None,
        prerequisites: Optional[List[str]] = None,
    ):
        self.node_id = node_id
        self.title = title
        self.question = question
        self.recommended = recommended
        self.options = options or []
        self.prerequisites = prerequisites or []
        self.settled_answer: Optional[str] = None

    def is_settled(self) -> bool:
        return self.settled_answer is not None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "title": self.title,
            "question": self.question,
            "recommended": self.recommended,
            "options": self.options,
            "prerequisites": self.prerequisites,
            "settled_answer": self.settled_answer,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DecisionNode":
        node = cls(
            node_id=data["node_id"],
            title=data["title"],
            question=data["question"],
            recommended=data["recommended"],
            options=data.get("options", []),
            prerequisites=data.get("prerequisites", []),
        )
        node.settled_answer = data.get("settled_answer")
        return node


class DesignTree:
    def __init__(self, objective: str):
        self.objective = objective
        self.nodes: Dict[str, DecisionNode] = {}

    def add_node(self, node: DecisionNode):
        self.nodes[node.node_id] = node

    def compute_frontier(self) -> List[DecisionNode]:
        """
        The frontier is all unsettled nodes whose prerequisites are ALL settled.
        """
        frontier = []
        for node in self.nodes.values():
            if node.is_settled():
                continue
            prereqs_met = True
            for prereq_id in node.prerequisites:
                prereq_node = self.nodes.get(prereq_id)
                if not prereq_node or not prereq_node.is_settled():
                    prereqs_met = False
                    break
            if prereqs_met:
                frontier.append(node)
        return frontier

    def settle_node(self, node_id: str, answer: str):
        if node_id in self.nodes:
            self.nodes[node_id].settled_answer = answer

    def is_complete(self) -> bool:
        return len(self.compute_frontier()) == 0 and all(
            n.is_settled() for n in self.nodes.values()
        )

    def _write_unlocked(self, safe_path: Path) -> None:
        """Serialize to an already-locked path via a unique temp + os.replace.

        Callers must hold the frontier lock (see `frontier_transaction` /
        `export_frontier_json`); nested `flock` on a second fd would deadlock.
        """
        data = {
            "objective": self.objective,
            "is_complete": self.is_complete(),
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "settled_constraints": {
                k: v.settled_answer for k, v in self.nodes.items() if v.is_settled()
            },
        }
        _atomic_write_json(safe_path, data)

    def export_frontier_json(self, output_path: Path):
        safe_path = Path(os.path.realpath(str(output_path)))
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        with _reentrant_file_lock(_lock_path_for(safe_path)):
            self._write_unlocked(safe_path)

    @classmethod
    def load_from_json(cls, file_path: Path) -> "DesignTree":
        safe_path = Path(os.path.realpath(str(file_path)))
        with open(safe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tree = cls(objective=data["objective"])
        for k, v in data.get("nodes", {}).items():
            tree.add_node(DecisionNode.from_dict(v))
        return tree


def _lock_path_for(safe_path: Path) -> Path:
    """Sibling lock file next to the frontier (e.g. `.factory/frontier.json.lock`).

    Append `.lock` rather than `with_suffix(".lock")`: replacing the suffix would
    make a frontier literally named `frontier.lock` use its own data file as the
    lock, which corrupts the data on a fresh run.
    """
    return Path(str(safe_path) + ".lock")


# Re-entrancy guard. `flock` is bound to the open file description, so a second
# open()+flock of the same lock file within one process self-deadlocks with no
# timeout (e.g. calling `export_frontier_json` inside `frontier_transaction`).
# Track the lock keys this *thread* already holds and reuse them; the guard is
# thread-local so distinct threads still contend on the real flock.
_HELD_LOCKS = threading.local()


def _held_lock_keys() -> set:
    keys = getattr(_HELD_LOCKS, "keys", None)
    if keys is None:
        keys = set()
        _HELD_LOCKS.keys = keys
    return keys


@contextmanager
def _reentrant_file_lock(lock_path: Path):
    """`_file_lock` that is re-entrant within a single thread."""
    key = str(os.path.realpath(str(lock_path)))
    keys = _held_lock_keys()
    if key in keys:
        yield  # already held by this thread; reuse it, do not re-flock
        return
    keys.add(key)
    try:
        with _file_lock(lock_path):
            yield
    finally:
        keys.discard(key)


@contextmanager
def frontier_transaction(file_path: Path, objective: str = ""):
    """Cross-process-locked read-modify-write cycle over one frontier file.

    Locking only the final write is not enough: two processes can both read the
    pre-state and then serialize their writes, silently dropping one another's
    nodes. The advisory lock is therefore held across load -> mutate -> atomic
    write, so concurrent `add`/`settle` calls never corrupt or lose data.
    """
    safe_path = Path(os.path.realpath(str(file_path)))
    safe_path.parent.mkdir(parents=True, exist_ok=True)
    with _reentrant_file_lock(_lock_path_for(safe_path)):
        if safe_path.exists():
            tree = DesignTree.load_from_json(safe_path)
        else:
            tree = DesignTree(objective=objective)
        yield tree
        tree._write_unlocked(safe_path)


def _display_frontier(tree: DesignTree, frontier: list) -> None:
    print(f"\n🎯 Objective: {tree.objective}")
    print(
        f"📊 Total Nodes: {len(tree.nodes)} | Settled: {sum(1 for n in tree.nodes.values() if n.is_settled())}"
    )
    if not frontier:
        if tree.nodes and tree.is_complete():
            print("✅ Frontier is EMPTY. All prerequisite branches are fully settled!")
        else:
            print(
                "ℹ️ No active frontier nodes. Define new decision nodes to begin grilling."
            )
    else:
        print(f"\n⚡ Current Active Frontier ({len(frontier)} questions ready):")
        for idx, node in enumerate(frontier, 1):
            print(f"\n❓ Q{idx} [{node.node_id}] - {node.title}")
            print(f"   {node.question}")
            print(f"   ➡️ Recommended: {node.recommended}")


def main():
    parser = argparse.ArgumentParser(
        description="Epistemic Swarm Socratic Decision Tree"
    )
    parser.add_argument("--objective", type=str, help="Research objective")
    parser.add_argument(
        "--file",
        type=str,
        default=".research/frontier.json",
        help="Path to frontier.json",
    )
    parser.add_argument(
        "--show-frontier",
        action="store_true",
        help="Print the current decision frontier",
    )
    parser.add_argument(
        "--settle",
        nargs=2,
        metavar=("NODE_ID", "ANSWER"),
        help="Settle a decision node",
    )
    parser.add_argument(
        "--add-node",
        action="store_true",
        help="Add a decision node (with --id/--question)",
    )
    parser.add_argument("--id", type=str, help="Node id (with --add-node)")
    parser.add_argument("--question", type=str, help="Node question (with --add-node)")
    parser.add_argument(
        "--title", type=str, default="", help="Node title (defaults to --id)"
    )
    parser.add_argument(
        "--recommended", type=str, default="", help="Recommended option"
    )
    parser.add_argument(
        "--depends-on",
        type=str,
        default="",
        help="Comma-separated prerequisite node ids",
    )
    parser.add_argument(
        "--export", action="store_true", help="Write the frontier JSON and exit"
    )

    args = parser.parse_args()
    frontier_path = Path(os.path.realpath(str(args.file)))
    objective = args.objective or "Epistemic Swarm Research Objective"

    # Every mutating action is a locked read-modify-write so concurrent
    # `--add-node`/`--settle` invocations cannot drop nodes or corrupt the file.
    if args.add_node:
        if not args.id or not args.question:
            parser.error("--add-node requires --id and --question")
        prereqs = [p.strip() for p in (args.depends_on or "").split(",") if p.strip()]
        with frontier_transaction(frontier_path, objective) as tree:
            tree.add_node(
                DecisionNode(
                    node_id=args.id,
                    title=args.title or args.id,
                    question=args.question,
                    recommended=args.recommended or "",
                    options=[],
                    prerequisites=prereqs,
                )
            )
        print(f"Added node {args.id} -> {frontier_path}")

    if args.settle:
        node_id, answer = args.settle
        with frontier_transaction(frontier_path, objective) as tree:
            tree.settle_node(node_id, answer)
        print(f"Settled {node_id} -> {answer}")

    if args.export:
        with frontier_transaction(frontier_path, objective):
            pass
        print(f"Exported frontier -> {frontier_path}")

    if frontier_path.exists():
        tree = DesignTree.load_from_json(frontier_path)
    else:
        tree = DesignTree(objective=objective)

    frontier = tree.compute_frontier()
    if args.show_frontier or not (args.settle or args.add_node or args.export):
        _display_frontier(tree, frontier)


if __name__ == "__main__":
    main()
