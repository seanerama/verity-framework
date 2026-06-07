// Integration tests: spawn the real dispatcher, the way a harness would.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const ROOT = path.join(__dirname, '..');

function run(args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('slug --raw emits a clean slug', () => {
  assertEqual(run(['slug', 'My Cool App!', '--raw']).trim(), 'my-cool-app');
});

test('slug (json) includes validation', () => {
  const obj = JSON.parse(run(['slug', 'Good Name']));
  assert(obj.validation.valid, 'generated slug should validate');
});

test('timestamp --raw is ISO-8601', () => {
  assert(/^\d{4}-\d{2}-\d{2}T/.test(run(['timestamp', '--raw']).trim()), 'expected ISO timestamp');
});

test('verify-path --raw reports existence', () => {
  assertEqual(run(['verify-path', 'package.json', '--raw', '--cwd', ROOT]).trim(), 'true');
  assertEqual(run(['verify-path', 'nope.xyz', '--raw', '--cwd', ROOT]).trim(), 'false');
});

test('help lists commands', () => {
  const obj = JSON.parse(run(['help']));
  assert(obj.commands.includes('slug'), 'help should list slug');
});

test('unknown command exits non-zero', () => {
  let failed = false;
  try {
    run(['nonsense-command']);
  } catch (_err) {
    failed = true;
  }
  assert(failed, 'unknown command should exit non-zero');
});
