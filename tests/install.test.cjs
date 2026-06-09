const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../verity/bin/lib/install.cjs');

// `home` keeps the global deployment-methods seed inside the test sandbox instead
// of the real ~/.verity.
function sandbox(tag) {
  return {
    target: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`)),
    home: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-home-`)),
  };
}

test('installClaude lays down command files + engine internals', () => {
  const { target, home } = sandbox('inst');
  const r = install.installClaude({ target, home });
  assertEqual(r.harness, 'claude');
  assert(
    r.installed.some((p) => p.endsWith('vision.md')),
    'vision.md should be reported installed',
  );
  assert(
    fs.existsSync(path.join(target, 'commands', 'verity', 'vision.md')),
    'command file on disk',
  );
  assert(
    fs.existsSync(path.join(target, 'verity', 'bin', 'verity.cjs')),
    'engine internals copied (self-contained fallback)',
  );
});

test('install seeds the global deployment-methods catalog (setup step)', () => {
  const { target, home } = sandbox('inst-deploy');
  const r = install.installClaude({ target, home });
  assert(r.deploymentMethods.created, 'catalog seeded on a fresh home');
  assert(
    fs.existsSync(path.join(home, 'deployment-methods.md')),
    'catalog on disk under ~/.verity',
  );
  // Reinstall must NOT clobber the user's edited catalog.
  const second = install.installClaude({ target, home });
  assertEqual(second.deploymentMethods.created, false, 'reinstall does not reseed');
});

test('installClaude does not require touching the real home dir', () => {
  const { target, home } = sandbox('inst2');
  const r = install.installClaude({ target, home });
  assert(r.target === target, 'must install into the provided target');
});

test('codex/gemini adapters are not implemented yet', () => {
  let failed = false;
  try {
    install.dispatch([], { codex: true });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'codex/gemini adapters not implemented yet');
});

// --- OpenCode adapter ---
test('transformForOpenCode reduces frontmatter to description, drops allowed-tools', () => {
  const claudeCmd = [
    '---',
    'name: verity:vision',
    'description: Vision — do the thing.',
    'allowed-tools:',
    '  - Bash',
    '  - Write',
    '---',
    'Body uses `verity` and falls back to node "$HOME/.claude/verity/bin/verity.cjs".',
  ].join('\n');
  const out = install.transformForOpenCode(claudeCmd);
  assert(out.includes('description: Vision — do the thing.'), 'description preserved');
  assert(!out.includes('allowed-tools'), 'Claude-only allowed-tools dropped');
  assert(!out.includes('name: verity:vision'), 'name dropped (filename is the id)');
  assert(!out.includes('.claude/verity'), 'CLI fallback path rewritten away from .claude');
  assert(out.includes('OPENCODE_CONFIG_DIR'), 'fallback points at the OpenCode config dir');
});

test('installOpenCode flattens commands to command/verity-*.md and copies internals', () => {
  const { target, home } = sandbox('oc');
  const r = install.installOpenCode({ target, home });
  assertEqual(r.harness, 'opencode');
  assert(r.deploymentMethods.created, 'OpenCode install also seeds the global catalog');
  assert(
    fs.existsSync(path.join(target, 'command', 'verity-vision.md')),
    'flattened command installed',
  );
  assert(
    fs.existsSync(path.join(target, 'verity', 'bin', 'verity.cjs')),
    'engine internals copied',
  );
  const installed = fs.readFileSync(path.join(target, 'command', 'verity-vision.md'), 'utf8');
  assert(!installed.includes('allowed-tools'), 'installed command is OpenCode-shaped');
});

test('dispatch --opencode routes to the OpenCode adapter', () => {
  const { target, home } = sandbox('oc2');
  const r = install.dispatch([], { opencode: true, target, home });
  assertEqual(r.harness, 'opencode');
});
