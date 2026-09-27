#!/usr/bin/env node

/**
 * IUMBTEMS CLI: I Use My Brain To Express My Self
 * High-Integrity Dialectic Research Harness for Claude Code, Pi, OMP, OpenCode V2, Gemini CLI, Codex CLI, AntiGravity.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function resolveBinary(name) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir || dir === '.' || dir.startsWith('./') || dir.startsWith('../')) continue;
    const full = path.join(dir, name);
    try {
      // Match Node's own PATH search: skip non-files and non-executables so a
      // directory or a non-executable named `python3` earlier on PATH cannot
      // shadow the real binary.
      if (!fs.statSync(full).isFile()) continue;
      fs.accessSync(full, fs.constants.X_OK);
      return fs.realpathSync(full);
    } catch {
      /* not present, not a file, or not executable — keep searching */
    }
  }
  return name;
}

const PKG_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHelp() {
  console.log(`
🧠 IUMBTEMS: I Use My Brain To Express My Self
🌟 Epistemic Swarm: High-Integrity Research Harness
   Platforms: Claude Code | Pi (pi.dev) | OMP (oh-my-pi) | OpenCode V2 | Gemini CLI | Codex CLI | AntiGravity
   Organization: @heretek-ai | Repository: Heretek-AI/IUMBTEMS

Usage:
  iumbtems <command> [options]
  npx @heretek-ai/epistemic-swarm <command> [options]

Commands:
  config [options]      Inspect or modify swarm parameters (engine, depth, mode)
  audit "<target>"      Run dialectic codebase architectural & security audit
  scout "<feature>"     Scout open-source software, libraries & clean-room blueprints
  run "<objective>"     Run the dialectic multi-agent research swarm
  brainstorm "<prompt>"  Run lateral brainstorming (feature vectors + spikes)
  darkharvest "<arena>"  Product competitor teardown with harvest verdicts
  grill                 Launch interactive Socratic decision tree framing
  adapters              Rebuild harness adapter mirrors (skills -> plugins/*, .agents)
  install               Install skills & MCP servers into ~/.claude/
  marketplace           Show Claude Code marketplace catalog & install commands
  test                  Run test suite for hashing, state machine & auditor
  doctor                Check environment requirements (Claude Code, Pi, OpenCode)
  help                  Show this help message

Platform Extensions:
  Pi (pi.dev):          pi install npm:@heretek-ai/epistemic-swarm
  OMP (oh-my-pi):       omp install npm:@heretek-ai/epistemic-swarm
  OpenCode V2:          add "@heretek-ai/epistemic-swarm" to opencode.json plugins
  Gemini CLI:           gemini extensions install https://github.com/Heretek-AI/IUMBTEMS --path plugins/gemini
  Codex CLI:            copy plugins/codex/skills/* into .agents/skills/
  AntiGravity:          agy plugin install https://github.com/Heretek-AI/IUMBTEMS --path plugins/antigravity
  Claude Code:          npx @heretek-ai/epistemic-swarm install

Options:
  --mock-claude         Run swarm with synthetic mock responses (zero API cost)
  --frontier <file>     Path to settled frontier.json from Socratic grilling
  --mode <mode>         Operating mode (research, audit, scout, hybrid, brainstorm)
  --engine <engine>     Search engine (duckduckgo, brave, firecrawl, searxng)
  --depth <n>           Max dialectic iterations (1-4)
  --dir <path>          Path to .research workspace directory (default: .research)

Examples:
  iumbtems config --engine duckduckgo --depth 3
  iumbtems audit "runner/ and skills/ concurrency & security"
  iumbtems scout "Zero-dependency Raft consensus in Rust"
  iumbtems run "Verify sub-millisecond ZK prover latency"
  iumbtems brainstorm "Where do we go from here?"
  iumbtems darkharvest "Paseo-class agent harness competitor" --seeds https://github.com/a/b,https://github.com/c/d --max-repos 6 --mock-claude
  iumbtems grill --objective "Rollup architecture trade-offs"
  iumbtems doctor
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
  const result = spawnSync(resolveBinary('python3'), finalArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: PKG_ROOT }
  });
  process.exit(result.status !== null ? result.status : 1);
}

function runBash(scriptRelPath, extraArgs = []) {
  const scriptPath = path.join(PKG_ROOT, scriptRelPath);
  const result = spawnSync(resolveBinary('bash'), [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  process.exit(result.status !== null ? result.status : 1);
}

switch (command) {
  case 'config': {
    runPython('skills/swarm_config/configure.py', args.slice(1));
    break;
  }

  case 'audit': {
    const targetObj = args[1] && !args[1].startsWith('--') ? args[1] : 'Full codebase architectural and security audit';
    const restArgs = args[1] && !args[1].startsWith('--') ? args.slice(2) : args.slice(1);
    const forwardArgs = ['--mode', 'audit', '--objective', targetObj, ...restArgs];
    runPython('runner/research_swarm.py', forwardArgs);
    break;
  }

  case 'scout': {
    const objective = args[1];
    if (!objective || objective.startsWith('--')) {
      console.error('Error: Please provide a feature or library to scout.');
      console.error('Example: npx @heretek-ai/epistemic-swarm scout "Zero-dependency Raft in Rust"');
      process.exit(1);
    }
    const forwardArgs = ['--mode', 'scout', '--objective', objective, ...args.slice(2)];
    runPython('runner/research_swarm.py', forwardArgs);
    break;
  }

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

  case 'brainstorm': {
    const objective = args[1];
    if (!objective || objective.startsWith('--')) {
      console.error('Error: Please provide a brainstorm prompt.');
      console.error('Example: npx @heretek-ai/epistemic-swarm brainstorm "Where do we go from here?"');
      process.exit(1);
    }
    const forwardArgs = ['--mode', 'brainstorm', '--objective', objective, ...args.slice(2)];
    runPython('runner/research_swarm.py', forwardArgs);
    break;
  }

  case 'darkharvest': {
    const objective = args[1];
    if (!objective || objective.startsWith('--')) {
      console.error('Error: Please provide a product arena to tear down.');
      console.error('Example: npx @heretek-ai/epistemic-swarm darkharvest "Paseo-class harness" --seeds https://github.com/a/b --max-repos 6');
      process.exit(1);
    }
    const forwardArgs = ['--mode', 'darkharvest', '--objective', objective, ...args.slice(2)];
    runPython('runner/research_swarm.py', forwardArgs);
    break;
  }

  case 'grill': {
    runPython('skills/grilling/socratic_tree.py', args.slice(1));
    break;
  }

  case 'adapters': {
    runPython('scripts/build_adapters.py', args.slice(1));
    break;
  }

  case 'install': {
    runBash('install.sh', args.slice(1));
    break;
  }

  case 'marketplace': {
    const mktPath = path.join(PKG_ROOT, '.claude-plugin', 'marketplace.json');
    if (!fs.existsSync(mktPath)) {
      console.error('Marketplace manifest not found.');
      process.exit(1);
    }
    const mkt = JSON.parse(fs.readFileSync(mktPath, 'utf8'));
    console.log(`\n🏪 CLAUDE CODE MARKETPLACE: ${mkt.name.toUpperCase()}`);
    console.log(`================================================`);
    console.log(`Owner:       ${mkt.owner ? mkt.owner.name : 'Unknown'} <${mkt.owner ? mkt.owner.email : ''}>`);
    console.log(`Description: ${mkt.description}\n`);
    console.log(`🚀 Add this marketplace to Claude Code:`);
    console.log(`   claude plugin marketplace add Heretek-AI/IUMBTEMS\n`);
    console.log(`📦 Available Plugins in Marketplace:`);
    (mkt.plugins || []).forEach((p, idx) => {
      console.log(`   ${idx + 1}. ${p.name} [${p.category || 'plugin'}]`);
      console.log(`      Description: ${p.description}`);
      console.log(`      Install:     claude plugin install ${p.name}@${mkt.name}`);
      console.log(`      Configure:   claude plugin configure ${p.name}@${mkt.name}\n`);
    });
    break;
  }

  case 'test': {
    runPython('-m', ['unittest', 'discover', '-s', 'runner/tests']);
    break;
  }

  case 'doctor': {
    console.log('🔍 Checking Epistemic Swarm Environment:\n');

    let pkgVersion = 'unknown';
    try {
      pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || 'unknown';
    } catch { /* keep 'unknown' */ }
    console.log(`✅ epistemic-swarm: ${pkgVersion}`);

    const claudeCheck = spawnSync(resolveBinary('claude'), ['--version'], { encoding: 'utf-8' });
    if (claudeCheck.status === 0) {
      console.log(`✅ Claude Code: ${claudeCheck.stdout.trim()}`);
    } else {
      console.log('⚠️ Claude Code CLI not found in PATH (Install via npm i -g @anthropic-ai/claude-code)');
    }

    const pyCheck = spawnSync(resolveBinary('python3'), ['--version'], { encoding: 'utf-8' });
    console.log(`✅ Python: ${pyCheck.stdout ? pyCheck.stdout.trim() : 'python3 missing'}`);

    console.log(`✅ Node.js: ${process.version}`);
    console.log(`📁 Package Root: ${PKG_ROOT}`);

    // opencode resolves this package as `@latest` into a per-fetch cache and
    // keeps every generation. A session started against an old generation keeps
    // running the old code until it is refreshed, so report what is cached.
    try {
      const cacheRoot = path.join(process.env.HOME || '', '.cache', 'opencode', 'npm', '@heretek-ai');
      const pkgDir = path.join(cacheRoot, 'epistemic-swarm@latest');
      if (fs.existsSync(pkgDir)) {
        const generations = fs.readdirSync(pkgDir).filter((d) => /^\d+$/.test(d)).sort();
        const newest = generations[generations.length - 1];
        console.log(`\n🧩 OpenCode plugin cache: ${generations.length} generation(s) in ${pkgDir}`);
        for (const g of generations.slice(-5)) {
          const marker = g === newest ? '  <- newest' : '';
          console.log(`   - ${g}${marker}`);
        }
        if (generations.length > 1) {
          console.log('   ⚠️ Multiple generations cached. If slash commands vanish or the plugin');
          console.log('      misbehaves, the running session may hold an older one — refresh with');
          console.log('      `opencode plugin update` (or clear the cache dir) and relaunch.');
        }
      } else {
        console.log('\n🧩 OpenCode plugin cache: not present (plugin not yet fetched)');
      }
    } catch (err) {
      console.log(`\n🧩 OpenCode plugin cache: could not inspect (${err.message})`);
    }
    break;
  }

  case 'help':
  default:
    printHelp();
    break;
}
