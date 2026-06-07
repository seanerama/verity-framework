// Verity adapter / installer — the Runtime Adapter layer (framework-spec.md §4b).
// Claude Code is the reference harness; other harnesses (Codex, OpenCode, Gemini)
// are added later by transforming the same command sources into their formats.
//
// Installs into the harness config dir:
//   commands/verity/*.md  — the role commands (slash commands in Claude Code)
//   verity/               — the engine internals, so commands are self-contained
//     (the command can call `verity` on PATH, or fall back to the installed copy)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PKG_ROOT = path.join(__dirname, '..', '..', '..');

function claudeDir(opts) {
  return opts.target || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function installClaude(opts = {}) {
  const target = claudeDir(opts);
  const installed = [];

  // 1. Role command files → <target>/commands/verity/
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const destCommands = path.join(target, 'commands', 'verity');
  fs.mkdirSync(destCommands, { recursive: true });
  for (const name of fs.readdirSync(srcCommands)) {
    if (!name.endsWith('.md')) {
      continue;
    }
    fs.copyFileSync(path.join(srcCommands, name), path.join(destCommands, name));
    installed.push(path.join('commands', 'verity', name));
  }

  // 2. Engine internals → <target>/verity/ (self-contained fallback for the CLI)
  fs.cpSync(path.join(PKG_ROOT, 'verity'), path.join(target, 'verity'), {
    recursive: true,
  });
  installed.push('verity/');

  return { harness: 'claude', target, installed };
}

function dispatch(_args, flags) {
  if (flags.codex || flags.opencode || flags.gemini) {
    throw new Error(
      'only the Claude Code adapter is implemented in this slice (build order: Claude reference first)',
    );
  }
  return installClaude({ target: flags.target });
}

module.exports = { installClaude, dispatch, claudeDir, PKG_ROOT };
