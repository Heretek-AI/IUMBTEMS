#!/usr/bin/env python3
"""
Epistemic Swarm: Dialectic Multi-Agent Research Runner.
Executes parallel Claude Code sub-processes (claude -p) for Proponent and Adversary agents,
monitors filesystem IPC scratchpads, and invokes the Epistemic Auditor.
"""

import os
import sys
import json
import shutil
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List, Optional

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from runner.state_machine import ResearchStateMachine, SessionStatus, ScopeStatus
from runner.auditor_engine import EpistemicAuditorEngine
from skills.research_cache.hasher import SourceHasher

class SwarmRunner:
    def __init__(self, base_dir: Optional[Path] = None, mock_mode: bool = False):
        self.base_dir = base_dir or Path(".research")
        self.mock_mode = mock_mode
        self.state_machine = ResearchStateMachine(base_dir=self.base_dir)
        self.auditor = EpistemicAuditorEngine(base_dir=self.base_dir)
        self.hasher = SourceHasher(base_dir=self.base_dir)
        self.prompts_dir = PROJECT_ROOT / "prompts"

    def run_claude_process(self, prompt: str, system_prompt_file: Optional[Path] = None,
                           tools: str = "default") -> str:
        """Executes a headless Claude Code session via `claude -p`."""
        if self.mock_mode:
            return self._mock_claude_response(prompt)

        cmd = ["claude", "-p", prompt, "--tools", tools]
        if system_prompt_file and system_prompt_file.exists():
            cmd.extend(["--system-prompt", str(system_prompt_file)])

        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                cwd=str(PROJECT_ROOT)
            )
            return res.stdout.strip()
        except subprocess.CalledProcessError as e:
            print(f"[ERROR] Claude process failed: {e.stderr}", file=sys.stderr)
            raise RuntimeError(f"Claude execution failed: {e.stderr}")

    def _mock_claude_response(self, prompt: str) -> str:
        """Mock response generator for unit testing without live API keys."""
        if "Orchestrator" in prompt or "manifest.json" in prompt:
            return json.dumps({
                "session_id": "mock-session-001",
                "objective": "Evaluate ZK prover latency",
                "scopes": [
                    {
                        "scope_id": "scope_01_latency",
                        "title": "Hardware Prover Latency Bounds",
                        "objective": "Evaluate Poseidon hash witness generation latency on FPGAs vs GPUs",
                        "dependencies": [],
                        "affirmative_targets": ["Sub-200ms witness generation on 2^20 constraints"],
                        "adversarial_targets": ["PCIe bus bottlenecks during batch streaming"]
                    }
                ]
            })
        return "MOCK_RESPONSE"

    def orchestrate_objective(self, objective: str, frontier_file: Optional[Path] = None) -> List[Dict[str, Any]]:
        """Phase 1: Run Swarm Orchestrator to decompose the research question."""
        print(f"\n🧠 [Phase 1: Orchestration] Decomposing objective: '{objective}'...")
        self.state_machine.init_session(objective)
        self.state_machine.update_session_status(SessionStatus.ORCHESTRATING)

        frontier_context = ""
        if frontier_file and frontier_file.exists():
            with open(frontier_file, "r", encoding="utf-8") as f:
                frontier_data = json.load(f)
                frontier_context = f"\nSETTLED CONSTRAINTS FROM FRONTIER:\n{json.dumps(frontier_data.get('settled_constraints', {}), indent=2)}"

        orchestrator_prompt = f"""
You are the Swarm Orchestrator. Read prompts/orchestrator.md.
Objective: {objective}
{frontier_context}

Output ONLY valid JSON representing the scope decomposition conforming to prompts/orchestrator.md.
"""
        system_prompt = self.prompts_dir / "orchestrator.md"
        raw_output = self.run_claude_process(orchestrator_prompt, system_prompt_file=system_prompt)
        
        # Parse JSON
        try:
            # Handle potential markdown fence blocks
            clean_json = raw_output
            if "```json" in clean_json:
                clean_json = clean_json.split("```json")[1].split("```")[0]
            elif "```" in clean_json:
                clean_json = clean_json.split("```")[1].split("```")[0]
            manifest_data = json.loads(clean_json.strip())
            scopes = manifest_data.get("scopes", [])
        except Exception as e:
            print(f"[WARN] Failed to parse JSON from orchestrator output: {e}. Using fallback decomposition.")
            scopes = [
                {
                    "scope_id": "scope_01_primary_investigation",
                    "title": f"Investigation: {objective[:40]}",
                    "objective": objective,
                    "dependencies": [],
                    "affirmative_targets": ["Find corroborating empirical data"],
                    "adversarial_targets": ["Probe counter-arguments and failure modes"]
                }
            ]

        self.state_machine.set_scopes(scopes)
        print(f"✅ Generated {len(scopes)} decoupled dialectic scopes.")
        return scopes

    def run_agent_alpha(self, scope: Dict[str, Any]):
        """Executes Agent Alpha (Thesis / Proponent) for a scope."""
        scope_id = scope["scope_id"]
        print(f"  [Alpha] 🏛️ Starting Agent Alpha (Thesis) on [{scope_id}]...")

        if self.mock_mode:
            # Create synthetic cached source
            sample_content = "# FPGA Prover Benchmark\nOur FPGA pipeline executes the Poseidon round constraints in 184ms with a peak memory bandwidth of 45 GB/s."
            shash = self.hasher.store_source("https://arxiv.org/abs/2405.0001", sample_content, "FPGA Benchmark")
            
            dossier = {
                "agent": "Agent Alpha (Thesis)",
                "scope_id": scope_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "affirmative_claims": [
                    {
                        "claim_id": "ALPHA-C01",
                        "tag": "VERIFIED",
                        "statement": "FPGA-accelerated Poseidon provers achieve sub-200ms latency on 2^20 constraints.",
                        "source_hash": shash,
                        "source_url": "https://arxiv.org/abs/2405.0001",
                        "verbatim_quote": "Our FPGA pipeline executes the Poseidon round constraints in 184ms with a peak memory bandwidth of 45 GB/s."
                    }
                ],
                "inferred_implications": [
                    {
                        "inference_id": "ALPHA-I01",
                        "tag": "INFERRED",
                        "statement": "Hardware provers satisfy 1-second block finality bounds.",
                        "parent_claims": ["ALPHA-C01"],
                        "deductive_logic": "184ms << 1000ms target."
                    }
                ],
                "negative_knowledge": []
            }
        else:
            prompt = f"Run Agent Alpha for scope: {json.dumps(scope)}. Save findings to {scope_id} scratchpad."
            system_prompt = self.prompts_dir / "agent_alpha_thesis.md"
            self.run_claude_process(prompt, system_prompt_file=system_prompt)
            # Read created dossier from scratchpad
            dossier_path = self.state_machine.get_scope_dir(scope_id) / "alpha_dossier.json"
            with open(dossier_path, "r", encoding="utf-8") as f:
                dossier = json.load(f)

        self.state_machine.record_agent_completion(scope_id, "alpha", dossier)
        print(f"  [Alpha] ✅ Completed Agent Alpha for [{scope_id}].")

    def run_agent_beta(self, scope: Dict[str, Any]):
        """Executes Agent Beta (Antithesis / Red Team) for a scope."""
        scope_id = scope["scope_id"]
        print(f"  [Beta] 🎯 Starting Agent Beta (Red Team) on [{scope_id}]...")

        if self.mock_mode:
            sample_content = "# PCIe Bus Saturation Study\nIn continuous batch streaming, PCIe 4.0 transfers introduce a 650ms delay, yielding total latency > 800ms."
            shash = self.hasher.store_source("https://arxiv.org/abs/2406.9999", sample_content, "PCIe Bottlenecks")

            dossier = {
                "agent": "Agent Beta (Red Team)",
                "scope_id": scope_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "falsification_claims": [
                    {
                        "claim_id": "BETA-C01",
                        "tag": "VERIFIED",
                        "statement": "Batch streaming incurs a 650ms PCIe transfer delay under production loads.",
                        "source_hash": shash,
                        "source_url": "https://arxiv.org/abs/2406.9999",
                        "verbatim_quote": "In continuous batch streaming, PCIe 4.0 transfers introduce a 650ms delay, yielding total latency > 800ms."
                    }
                ],
                "methodological_critiques": [
                    {
                        "target_assertion": "FPGA-accelerated Poseidon provers achieve sub-200ms latency on 2^20 constraints.",
                        "critique": "Benchmark isolates compute kernel and ignores host-to-device PCIe latency in pipelined batches.",
                        "evidence_hash": shash
                    }
                ],
                "negative_knowledge": [
                    {
                        "query": "Zero-latency PCIe streaming ZK provers",
                        "finding": "No architecture eliminates bus transfer overhead without on-chip memory > 128GB."
                    }
                ]
            }
        else:
            prompt = f"Run Agent Beta for scope: {json.dumps(scope)}. Save findings to {scope_id} scratchpad."
            system_prompt = self.prompts_dir / "agent_beta_antithesis.md"
            self.run_claude_process(prompt, system_prompt_file=system_prompt)
            dossier_path = self.state_machine.get_scope_dir(scope_id) / "beta_dossier.json"
            with open(dossier_path, "r", encoding="utf-8") as f:
                dossier = json.load(f)

        self.state_machine.record_agent_completion(scope_id, "beta", dossier)
        print(f"  [Beta] ✅ Completed Agent Beta for [{scope_id}].")

    def execute_scope_dialectic(self, scope: Dict[str, Any]):
        """Dispatches Agent Alpha and Agent Beta concurrently."""
        scope_id = scope["scope_id"]
        print(f"\n⚡ [Swarm Dispatch] Launching Dialectic Pair for [{scope_id}]: '{scope.get('title')}'")
        self.state_machine.update_scope_status(scope_id, ScopeStatus.RUNNING_PARALLEL)
        
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_alpha = executor.submit(self.run_agent_alpha, scope)
            future_beta = executor.submit(self.run_agent_beta, scope)
            
            # Wait for both
            future_alpha.result()
            future_beta.result()

        # Phase 4: Run Epistemic Auditor
        print(f"⚖️ [Auditor] Auditing evidence & computing divergence for [{scope_id}]...")
        audit_report = self.auditor.audit_scope(scope_id)
        summary = audit_report["summary"]
        print(f"  [Audit Result] Score: {summary['epistemic_score']}/1.0 | Divergence: {summary['divergence_score']} | Verified: {summary['verified_passed']} | Rejected: {summary['unverified_rejected']}")

    def run_swarm(self, objective: str, frontier_file: Optional[Path] = None):
        """Full end-to-end execution loop."""
        start_time = datetime.now(timezone.utc)
        print("=" * 70)
        print("🌟 EPISTEMIC SWARM: HIGH-INTEGRITY RESEARCH HARNESS")
        print("=" * 70)

        # 1. Orchestrate
        scopes = self.orchestrate_objective(objective, frontier_file)

        # 2. Execute scopes according to DAG
        while True:
            ready_scopes = self.state_machine.get_ready_scopes()
            if not ready_scopes:
                # Check if all scopes are complete
                manifest = self.state_machine.load_global_manifest()
                all_complete = all(
                    self.state_machine.load_scope_manifest(s["scope_id"]).get("status") == ScopeStatus.COMPLETE.value
                    for s in manifest["scopes"]
                )
                if all_complete:
                    break
                else:
                    print("[ERROR] Deadlock in scope dependency graph.", file=sys.stderr)
                    self.state_machine.update_session_status(SessionStatus.FAILED)
                    return

            for scope in ready_scopes:
                self.execute_scope_dialectic(scope)

        # 3. Master Synthesis Compilation
        print("\n📜 [Phase 5: Master Synthesis] Aggregating scope dossiers...")
        self._compile_master_synthesis(objective)
        self.state_machine.update_session_status(SessionStatus.COMPLETED)
        
        duration = (datetime.now(timezone.utc) - start_time).total_seconds()
        print(f"\n🎉 Research swarm completed in {duration:.1f}s. Report: .research/final_synthesis.md")

    def _compile_master_synthesis(self, objective: str):
        manifest = self.state_machine.load_global_manifest()
        synthesis_lines = [
            f"# Master Epistemic Research Report: {objective}\n",
            f"**Session ID**: `{manifest['session_id']}` | **Generated**: `{manifest['updated_at']}`\n",
            "## Executive Summary",
            "This report was compiled using the Epistemic Swarm dialectic harness. Every factual statement carries an empirical verification pointer backed by a content-addressed raw document cache.\n",
            "## Scope Findings & Dialectic Balance Sheets\n"
        ]

        total_verified = 0
        total_rejected = 0
        all_divergences = []

        for scope in manifest["scopes"]:
            sid = scope["scope_id"]
            scope_dir = self.state_machine.get_scope_dir(sid)
            audit_file = scope_dir / "audit_report.json"
            synth_file = scope_dir / "scope_synthesis.md"

            if audit_file.exists():
                with open(audit_file, "r", encoding="utf-8") as f:
                    ar = json.load(f)
                    total_verified += ar["summary"]["verified_passed"]
                    total_rejected += ar["summary"]["unverified_rejected"]
                    all_divergences.append(ar["summary"]["divergence_score"])

            if synth_file.exists():
                with open(synth_file, "r", encoding="utf-8") as f:
                    synthesis_lines.append(f.read())
                    synthesis_lines.append("\n---\n")

        avg_div = round(sum(all_divergences) / max(1, len(all_divergences)), 2)
        synthesis_lines.append(f"\n## Swarm Epistemic Audit Totals\n")
        synthesis_lines.append(f"- **Total Verified Primary Citations**: `{total_verified}`")
        synthesis_lines.append(f"- **Total Unverified Claims Purged**: `{total_rejected}`")
        synthesis_lines.append(f"- **Mean Swarm Divergence Score**: `{avg_div}`")

        final_path = self.base_dir / "final_synthesis.md"
        with open(final_path, "w", encoding="utf-8") as f:
            f.write("\n".join(synthesis_lines))


def main():
    parser = argparse.ArgumentParser(description="Epistemic Swarm Dialectic Research Runner")
    parser.add_argument("--objective", type=str, required=True, help="Research question or objective")
    parser.add_argument("--frontier", type=str, help="Path to settled frontier.json from /grilling")
    parser.add_argument("--mock-claude", action="store_true", help="Run with synthetic test data without invoking Claude Code")
    parser.add_argument("--dir", default=".research", help="Path to .research workspace")

    args = parser.parse_args()
    frontier_path = Path(args.frontier) if args.frontier else None
    runner = SwarmRunner(base_dir=Path(args.dir), mock_mode=args.mock_claude)
    runner.run_swarm(args.objective, frontier_file=frontier_path)


if __name__ == "__main__":
    main()
