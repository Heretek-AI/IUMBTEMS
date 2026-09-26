#!/usr/bin/env node

/**
 * Epistemic Swarm CLI
 * Multi-agent dialectic research harness for Claude Code.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PKG_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHelp() {
  console.log(`
🌟 Epistemic Swarm: High-Integrity Research Harness for Claude Code
   Organization: @heretek-ai | Repository: Heretek-AI/IUMBTEMS

Usage:
  npx @heretek-ai/epistemic-swarm <command> [options]
  iumbtems <command> [options]

Commands:
  run "<objective>"     Run the dialectic multi-agent research swarm
  grill                 Launch interactive Socratic decision tree framing
  install               Install skills & MCP servers into ~/.claude/
  test                  Run test suite for hashing, state machine & auditor
  doctor                Check environment requirements (Claude Code, Python, Node)
  help                  Show this help message

Options:
  --mock-claude         Run swarm with synthetic mock responses (zero API cost)
  --frontier <file>     Path to settled frontier.json from Socratic grilling
  --dir <path>          Path to .research workspace directory (default: .research)

Examples:
  npx @heretek-ai/epistemic-swarm run "Verify sub-millisecond ZK prover latency"
  npx @heretek-ai/epistemic-swarm grill --objective "Rollup architecture trade-offs"
  npx @heretek-ai/epistemic-swarm install
`);
}

function runPython(scriptRelPath, extraArgs = []) {
  let finalArgs = [];
  if (scriptRelPath === '-m') {
    finalArgs = ['-m', ...extraArgs];
  } else {
    const scriptPath = path.join(PKG_ROOT, scriptRelPath);
    finalArgs = [scriptPath, ...extraArgs];
  }
  const result = spawnSync('python3', finalArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: PKG_ROOT }
  });
  process.exit(result.status !== null ? result.status : 1);
}

function runBash(scriptRelPath, extraArgs = []) {
  const scriptPath = path.join(PKG_ROOT, scriptRelPath);
  const result = spawnSync('bash', [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  process.exit(result.status !== null ? result.status : 1);
}

switch (command) {
  case 'run': {
    const objective = args[1];
    if (!objective || objective.startsWith('--')) {
      console.error('Error: Please provide a research objective string.');
      console.error('Example: npx @heretek-ai/epistemic-swarm run "Evaluate FPGA prover latency"');
      process.exit(1);
    }
    const forwardArgs = ['--objective', objective, ...args.slice(2)];
    runPython('runner/research_swarm.py', forwardArgs);
    break;
  }

  case 'grill': {
    runPython('skills/grilling/socratic_tree.py', args.slice(1));
    break;
  }

  case 'install': {
    runBash('install.sh', args.slice(1));
    break;
  }

  case 'test': {
    runPython('-m', ['unittest', 'discover', '-s', 'runner/tests']);
    break;
  }

  case 'doctor': {
    console.log('🔍 Checking Epistemic Swarm Environment:\n');
    const claudeCheck = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
    if (claudeCheck.status === 0) {
      console.log(`✅ Claude Code: ${claudeCheck.stdout.trim()}`);
    } else {
      console.log('⚠️ Claude Code CLI not found in PATH (Install via npm i -g @anthropic-ai/claude-code)');
    }

    const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
    console.log(`✅ Python: ${pyCheck.stdout ? pyCheck.stdout.trim() : 'python3 missing'}`);

    console.log(`✅ Node.js: ${process.version}`);
    console.log(`📁 Package Root: ${PKG_ROOT}`);
    break;
  }

  case 'help':
  default:
    printHelp();
    break;
}
