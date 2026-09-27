#!/usr/bin/env python3
"""
Socratic Tree & Decision Frontier Engine for Epistemic Swarm.
Implements Matt Pocock-style design tree traversal to isolate the active decision frontier.
"""

import sys
import os
import json
import argparse
from pathlib import Path
from typing import Dict, List, Optional, Any

class DecisionNode:
    def __init__(self, node_id: str, title: str, question: str, 
                 recommended: str, options: Optional[List[str]] = None,
                 prerequisites: Optional[List[str]] = None):
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
            "settled_answer": self.settled_answer
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'DecisionNode':
        node = cls(
            node_id=data["node_id"],
            title=data["title"],
            question=data["question"],
            recommended=data["recommended"],
            options=data.get("options", []),
            prerequisites=data.get("prerequisites", [])
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
        return len(self.compute_frontier()) == 0 and all(n.is_settled() for n in self.nodes.values())

    def export_frontier_json(self, output_path: Path):
        safe_path = Path(os.path.realpath(str(output_path)))
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "objective": self.objective,
            "is_complete": self.is_complete(),
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "settled_constraints": {
                k: v.settled_answer for k, v in self.nodes.items() if v.is_settled()
            }
        }
        with open(safe_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load_from_json(cls, file_path: Path) -> 'DesignTree':
        safe_path = Path(os.path.realpath(str(file_path)))
        with open(safe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tree = cls(objective=data["objective"])
        for k, v in data.get("nodes", {}).items():
            tree.add_node(DecisionNode.from_dict(v))
        return tree


def _display_frontier(tree: DesignTree, frontier: list) -> None:
    print(f"\n🎯 Objective: {tree.objective}")
    print(f"📊 Total Nodes: {len(tree.nodes)} | Settled: {sum(1 for n in tree.nodes.values() if n.is_settled())}")
    if not frontier:
        if tree.nodes and tree.is_complete():
            print("✅ Frontier is EMPTY. All prerequisite branches are fully settled!")
        else:
            print("ℹ️ No active frontier nodes. Define new decision nodes to begin grilling.")
    else:
        print(f"\n⚡ Current Active Frontier ({len(frontier)} questions ready):")
        for idx, node in enumerate(frontier, 1):
            print(f"\n❓ Q{idx} [{node.node_id}] - {node.title}")
            print(f"   {node.question}")
            print(f"   ➡️ Recommended: {node.recommended}")


def main():
    parser = argparse.ArgumentParser(description="Epistemic Swarm Socratic Decision Tree")
    parser.add_argument("--objective", type=str, help="Research objective")
    parser.add_argument("--file", type=str, default=".research/frontier.json", help="Path to frontier.json")
    parser.add_argument("--show-frontier", action="store_true", help="Print the current decision frontier")
    parser.add_argument("--settle", nargs=2, metavar=("NODE_ID", "ANSWER"), help="Settle a decision node")

    args = parser.parse_args()
    frontier_path = Path(os.path.realpath(str(args.file)))

    if frontier_path.exists():
        tree = DesignTree.load_from_json(frontier_path)
    else:
        objective = args.objective or "Epistemic Swarm Research Objective"
        tree = DesignTree(objective=objective)

    if args.settle:
        node_id, answer = args.settle
        tree.settle_node(node_id, answer)
        tree.export_frontier_json(frontier_path)
        print(f"Settled {node_id} -> {answer}")

    frontier = tree.compute_frontier()
    if args.show_frontier or not args.settle:
        _display_frontier(tree, frontier)


if __name__ == "__main__":
    main()
