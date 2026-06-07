const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('../verity/bin/lib/release.cjs');
const status = require('../verity/bin/lib/status.cjs');

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`));
}

// --- release: version derived from tag ---
test('nextVersion bumps patch/minor/major from the latest tag', () => {
  assertEqual(release.nextVersion('v1.2.3', 'patch'), '1.2.4');
  assertEqual(release.nextVersion('v1.2.3', 'minor'), '1.3.0');
  assertEqual(release.nextVersion('v1.2.3', 'major'), '2.0.0');
});

test('nextVersion starts at 0.0.1 with no prior tag', () => {
  assertEqual(release.nextVersion(null, 'patch'), '0.0.1');
});

// --- release: changelog from Conventional Commits ---
test('changelogFrom groups Conventional Commits', () => {
  const log = release.changelogFrom(
    ['feat: profiles', 'fix(auth): token bug', 'chore: bump', 'random note'],
    '0.2.0',
  );
  assert(log.includes('## 0.2.0'), 'version header');
  assert(log.includes('### Features') && log.includes('- profiles'), 'features grouped');
  assert(log.includes('### Fixes') && log.includes('- token bug'), 'fixes grouped');
  assert(log.includes('### Other') && log.includes('- random note'), 'non-conventional -> Other');
});

test('cut --dry-run computes version + changelog without tagging (injected tags/commits)', () => {
  const r = release.cut(fresh('rel'), {
    tags: ['v0.1.0', 'v0.1.5'],
    commits: ['feat: a', 'fix: b'],
    dryRun: true,
  });
  assertEqual(r.previous, 'v0.1.5');
  assertEqual(r.version, '0.1.6');
  assertEqual(r.applied, false);
  assert(r.changelog.includes('### Features'), 'changelog generated');
});

// --- status: runtime truth artifact ---
test('status set writes runtime.json and renders STATUS.md', () => {
  const d = fresh('status');
  status.set(d, 'version', '0.4.2');
  assertEqual(status.read(d).version, '0.4.2');
  const md = fs.readFileSync(path.join(d, 'STATUS.md'), 'utf8');
  assert(md.includes('0.4.2'), 'STATUS.md reflects the version');
  assert(md.includes('Secret locations'), 'has the secrets section');
});

test('status set supports dot-path (environments.prod.digest)', () => {
  const d = fresh('status2');
  status.set(d, 'environments.prod.digest', 'sha256:abc');
  assertEqual(status.read(d).environments.prod.digest, 'sha256:abc');
});

test('status secret appends a LOCATION (never a value)', () => {
  const d = fresh('status3');
  status.append(d, 'secret_locations', 'JWT_SECRET @ VM1:/opt/app/.env.prod');
  const md = fs.readFileSync(path.join(d, 'STATUS.md'), 'utf8');
  assert(md.includes('JWT_SECRET @ VM1'), 'secret location rendered');
  assert(!md.includes('(none)\n- (none)'), 'secrets section populated');
});
