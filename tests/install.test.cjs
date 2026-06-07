const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const install = require('../verity/bin/lib/install.cjs');

test('installClaude lays down command files + engine internals', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-inst-'));
  const r = install.installClaude({ target });
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

test('installClaude does not require touching the real home dir', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-inst2-'));
  const r = install.installClaude({ target });
  assert(r.target === target, 'must install into the provided target');
});

test('non-claude harness is rejected in this slice', () => {
  let failed = false;
  try {
    install.dispatch([], { codex: true });
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'codex/opencode/gemini adapters not implemented yet');
});
