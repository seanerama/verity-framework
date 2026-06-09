// Verity adapter / installer — the Runtime Adapter layer (framework-spec.md §4b).
// Same role-command CONTENT, transformed into each harness's format + install
// location. Claude Code is the reference harness; OpenCode is the second adapter.
// Capability differences (no Task sub-agents / no hooks on OpenCode) are handled by
// the commands' own "implement inline" fallback — the content already degrades.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const deployment = require('./deployment.cjs');

const PKG_ROOT = path.join(__dirname, '..', '..', '..');

// Part of setup: seed the user-global deployment-methods catalog (NEVER clobbered).
// It lives in the user's home (~/.verity), independent of the harness target dir.
function seedDeploymentMethods(opts) {
  const seed = deployment.ensure({ home: opts.home });
  return { ...seed, label: `${seed.path}${seed.created ? '' : ' (existing)'}` };
}

function commandFiles(srcCommands) {
  return fs.readdirSync(srcCommands).filter((n) => n.endsWith('.md'));
}

function copyInternals(target) {
  fs.cpSync(path.join(PKG_ROOT, 'verity'), path.join(target, 'verity'), { recursive: true });
}

function claudeDir(opts) {
  return opts.target || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function installClaude(opts = {}) {
  const target = claudeDir(opts);
  const installed = [];

  // 1. Role command files → <target>/commands/verity/ (Claude Code uses them as-is)
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const destCommands = path.join(target, 'commands', 'verity');
  fs.mkdirSync(destCommands, { recursive: true });
  for (const name of commandFiles(srcCommands)) {
    fs.copyFileSync(path.join(srcCommands, name), path.join(destCommands, name));
    installed.push(path.join('commands', 'verity', name));
  }

  // 2. Engine internals → <target>/verity/ (self-contained fallback for the CLI)
  copyInternals(target);
  installed.push('verity/');

  // 3. Seed the global deployment-methods catalog (setup step).
  const deploymentMethods = seedDeploymentMethods(opts);
  installed.push(deploymentMethods.label);

  return { harness: 'claude', target, installed, deploymentMethods };
}

// --- OpenCode adapter ---

function openCodeDir(opts) {
  return (
    opts.target || process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode')
  );
}

// Transform a Claude command .md into OpenCode's command format:
// - frontmatter reduced to `description:` (OpenCode's per-command field; the
//   Claude-only `allowed-tools` allowlist + `name` are dropped — OpenCode manages
//   permissions globally and derives the command id from the filename)
// - the Claude-specific CLI fallback path is rewritten to the OpenCode config dir
function transformForOpenCode(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return content;
  }
  const description = (m[1].match(/^description:\s*(.+)$/m) || [])[1] || '';
  const body = m[2].replace(
    /\$HOME\/\.claude\/verity/g,
    '${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/verity',
  );
  return `---\ndescription: ${description}\n---\n${body}`;
}

function installOpenCode(opts = {}) {
  const target = openCodeDir(opts);
  const installed = [];

  // Role commands → <target>/command/, flattened to verity-<name>.md (invoked /verity-<name>)
  const srcCommands = path.join(PKG_ROOT, 'commands', 'verity');
  const destCommands = path.join(target, 'command');
  fs.mkdirSync(destCommands, { recursive: true });
  for (const name of commandFiles(srcCommands)) {
    const out = `verity-${name}`;
    const transformed = transformForOpenCode(fs.readFileSync(path.join(srcCommands, name), 'utf8'));
    fs.writeFileSync(path.join(destCommands, out), transformed);
    installed.push(path.join('command', out));
  }

  copyInternals(target);
  installed.push('verity/');

  const deploymentMethods = seedDeploymentMethods(opts);
  installed.push(deploymentMethods.label);

  return { harness: 'opencode', target, installed, deploymentMethods };
}

function dispatch(_args, flags) {
  if (flags.opencode) {
    return installOpenCode({ target: flags.target, home: flags.home });
  }
  if (flags.codex || flags.gemini) {
    throw new Error('only the claude and opencode adapters are implemented so far');
  }
  return installClaude({ target: flags.target, home: flags.home });
}

module.exports = {
  installClaude,
  installOpenCode,
  transformForOpenCode,
  openCodeDir,
  dispatch,
  claudeDir,
  PKG_ROOT,
};
