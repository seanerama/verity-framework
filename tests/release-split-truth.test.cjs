// Stage 97 (ADR-0034): once the dev/prod split is active, the dev side's release
// truth is the released promotion record, never a dev tag. `release prepare`,
// `release cut` (and `--dry-run`) derive `previous` and the commit range from
// the highest `status: released` record's version / development.commit, and
// `verity state` reports the same number with `release_source`. No released
// record ⇒ fail closed (`no-released-promotion`); a computed version that was
// already released ⇒ `version-already-released` (both modes). Non-split repos
// are byte-identical (the regression contract for THAT is tests/shipyard.test.cjs
// and tests/release-prepare.test.cjs passing unchanged).
//
// Everything here runs against hermetic temp git repos + hand-written PROM
// records in the promotion-records v1 shape. No network, no gh, no real tags:
// this repo's own .verity/ is never read.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const release = require('../verity/bin/lib/release.cjs');
const ledger = require('../verity/bin/lib/ledger.cjs');
const promotion = require('../verity/bin/lib/promotion.cjs');
const operator = require('../verity/bin/lib/operator.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'verity-test',
  GIT_AUTHOR_EMAIL: 'test@verity.local',
  GIT_COMMITTER_NAME: 'verity-test',
  GIT_COMMITTER_EMAIL: 'test@verity.local',
};

// The post-1.3.0 work: exactly what a correct derivation must range over.
const POST = ['feat: one (#31)', 'fix: two', 'chore: three'];

// The defect's shape, as a repo: an annotated `v1.2.0` mirror tag on an OLD
// commit (the 2026-08-22 stopgap), a later commit that 1.3.0 was projected from
// (the released record's development.commit — no v1.3.0 mirror was ever added,
// finalize creates no dev tag), then three more commits.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-split-truth-'));
  const git = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
    });
  const commit = (msg) => {
    fs.appendFileSync(path.join(dir, 'log.txt'), `${msg}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', msg]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  git(['init', '-q']);
  git(['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.3.0\n\n- shipped\n');
  const baseline = commit('feat: baseline');
  git([
    'tag',
    '-a',
    'v1.2.0',
    '-m',
    'mirror of authoritative prod v1.2.0 (PROM-0001) — baseline for dev-side derivation',
  ]);
  const devCommit = commit('feat: shipped in 1.3.0');
  for (const m of POST) {
    commit(m);
  }
  return { dir, git, baseline, devCommit, head: git(['rev-parse', 'HEAD']).trim() };
}

function armSplit(dir) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'promotion.json'),
    JSON.stringify({ schema: 1, split_active: true, prod_repo: 'acme/widget' }),
  );
}

// A PROM record in the promotion-records v1 shape (exactly what propose writes
// and finalize completes) — only the four fields stage 97 reads vary.
function record(dir, { id, version, status, devCommit, tag = null, extra = '' }) {
  const released = status === 'released';
  const text = [
    `promotion_id: PROM-${id}`,
    `version: ${version}`,
    `status: ${status}`,
    'development:',
    '  repository: acme/widget-dev',
    `  commit: ${devCommit}`,
    '  staging_digest: sha256:aaaa',
    '  classification_digest: sha256:bbbb',
    'production:',
    '  repository: acme/widget',
    `  pull_request: ${Number.parseInt(id, 10)}`,
    `  commit: ${released ? 'f'.repeat(40) : 'null'}`,
    `  tag: ${tag === null ? 'null' : tag}`,
    'verification:',
    '  gates: all-pass',
    '  package_shasum: deadbeef',
    '  baseline: null',
    'timestamps:',
    '  proposed_at: 2026-08-23T03:04:43.573Z',
    `  finalized_at: ${released ? '2026-08-23T03:08:23.896Z' : 'null'}`,
    extra,
  ].join('\n');
  fs.mkdirSync(path.join(dir, '.verity', 'promotions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'promotions', `PROM-${id}.yml`), text);
}

// The canonical split fixture: split on, PROM-0002 released 1.3.0 from devCommit.
function splitFixture() {
  const f = repo();
  armSplit(f.dir);
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: f.devCommit,
    tag: 'v1.3.0',
  });
  return f;
}

function ghShaped(f) {
  return { online: true, issues: [], prs: [], tags: f.git(['tag']).split('\n').filter(Boolean) };
}

function refusal(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

function snapshotOf(f) {
  return {
    head: f.git(['rev-parse', 'HEAD']).trim(),
    tags: f.git(['tag']).trim(),
    changelog: fs.readFileSync(path.join(f.dir, 'CHANGELOG.md'), 'utf8'),
    porcelain: f.git(['status', '--porcelain']).trim(),
  };
}

// ---------------------------------------------------------------------------
// 1. Regression: the released record — not the v1.2.0 dev tag — is `previous`.
// ---------------------------------------------------------------------------
test('regression (ADR-0034): split-active prepare derives previous/version/range from the released record, never the v1.2.0 dev tag', () => {
  const f = splitFixture();
  // What the pre-stage-97 path answered for this exact repo: the mirror tag is
  // the highest local tag, so it re-derived 1.3.0 over EVERY commit since it.
  assertEqual(ledger.latestTag(ghShaped(f).tags), 'v1.2.0', 'the dev tag is still there');
  assertEqual(
    release.nextVersion('v1.2.0', 'minor'),
    '1.3.0',
    'tag-based bump re-derives the shipped 1.3.0',
  );
  assertEqual(
    f.git(['rev-list', '--count', 'v1.2.0..HEAD']).trim(),
    '4',
    'tag-based range re-lists shipped work',
  );

  const r = release.prepare(f.dir, { bump: 'minor' });
  assertEqual(r.previous, 'v1.3.0', 'previous is the released record');
  assertEqual(r.version, '1.4.0');
  assertEqual(r.tag_candidate, 'v1.4.0');
  assertEqual(r.commitCount, POST.length, 'exactly the post-record commits');
  assert(r.changelog.includes('- one (dev#31)'), 'post-record feat present (sanitized)');
  assert(r.changelog.includes('- two'), 'post-record fix present');
  assert(r.changelog.includes('- three'), 'post-record chore present');
  assert(!r.changelog.includes('baseline'), 'pre-1.3.0 work is not re-listed');
  assert(!r.changelog.includes('shipped in 1.3.0'), 'the 1.3.0 commit itself is not re-listed');
  assertEqual(r.applied, false);

  // The CLI reports the same numbers and touches nothing.
  const out = cli(['release', 'prepare', '--bump', 'minor', '--cwd', f.dir, '--json']);
  assertEqual(out.status, 0, `stderr: ${out.stderr}`);
  const j = JSON.parse(out.stdout);
  assertEqual(j.previous, 'v1.3.0');
  assertEqual(j.version, '1.4.0');
  assertEqual(j.commitCount, POST.length);
  assertEqual(
    f.git(['status', '--porcelain']).trim(),
    '?? .verity/',
    'only the fixture furniture is untracked',
  );
});

// ---------------------------------------------------------------------------
// 2. state.release: same source, with release_source naming it.
// ---------------------------------------------------------------------------
test('state.release: split-active reports the released record (v1.3.0) with release_source promotion-record, never the v1.2.0 tag', () => {
  const f = splitFixture();
  const snap = ghShaped(f);
  assert(snap.tags.includes('v1.2.0'), 'the snapshot carries the dev tag — and it must be ignored');
  const proj = ledger.project(f.dir, { snapshot: snap });
  assertEqual(proj.release, 'v1.3.0');
  assertEqual(proj.release_source, 'promotion-record');
  assertEqual(proj.online, true);
  assertEqual(
    Object.keys(proj).join(','),
    'online,release,release_source,stages,next',
    'state view gains exactly release_source',
  );
  assertEqual(ledger.summarize(proj).release, 'v1.3.0', 'summary passes the value through');
});

test('state.release: split-active with no released record is null (never the v1.2.0 tag)', () => {
  const f = repo();
  armSplit(f.dir);
  record(f.dir, { id: '0002', version: '1.3.0', status: 'proposed', devCommit: f.devCommit });
  const proj = ledger.project(f.dir, { snapshot: ghShaped(f) });
  assertEqual(proj.release, null, 'nothing released ⇒ null');
  assertEqual(proj.release_source, 'promotion-record');
  assertEqual(
    ledger.summarize(proj).raw.includes('release (none)'),
    true,
    'summary renders the honest none',
  );
});

test('state.release: non-split keeps the highest local tag with release_source tag (byte-identical value)', () => {
  const f = repo(); // no promotion.json at all
  const proj = ledger.project(f.dir, { snapshot: ghShaped(f) });
  assertEqual(proj.release, 'v1.2.0');
  assertEqual(proj.release_source, 'tag');
  // split_active: false spelled out is the same as absent.
  fs.mkdirSync(path.join(f.dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(f.dir, '.verity', 'promotion.json'),
    JSON.stringify({ schema: 1, split_active: false, prod_repo: null }),
  );
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: f.devCommit,
    tag: 'v1.3.0',
  });
  const off = ledger.project(f.dir, { snapshot: ghShaped(f) });
  assertEqual(off.release, 'v1.2.0', 'split off ⇒ records are not consulted');
  assertEqual(off.release_source, 'tag');
});

// ---------------------------------------------------------------------------
// 3. Fail closed: split on, nothing released ⇒ every verb refuses, nothing written.
// ---------------------------------------------------------------------------
test('fail closed: split-active with only a proposed record — prepare, cut --dry-run, and cut all refuse no-released-promotion (exit 20), nothing written', () => {
  const f = repo();
  armSplit(f.dir);
  record(f.dir, { id: '0002', version: '1.3.0', status: 'proposed', devCommit: f.devCommit });
  const before = snapshotOf(f);

  for (const [name, fn] of [
    ['prepare', () => release.prepare(f.dir, { bump: 'minor' })],
    ['prepare --apply', () => release.prepare(f.dir, { bump: 'minor', apply: true })],
    ['cut --dry-run', () => release.cut(f.dir, { bump: 'minor', dryRun: true })],
    ['cut', () => release.cut(f.dir, { bump: 'minor', push: false })],
  ]) {
    const err = refusal(fn);
    assert(err, `${name} must refuse`);
    assertEqual(err.slug, 'no-released-promotion', `${name} slug`);
    assertEqual(err.exitCode, 20, `${name} carries the tag guard's exit code`);
    assert(err.message.startsWith('no-released-promotion:'), `${name} message leads with the slug`);
    assert(err.message.includes('promotion'), `${name} message names the promotion flow`);
  }

  for (const args of [
    ['release', 'prepare', '--bump', 'minor'],
    ['release', 'cut', '--dry-run', '--bump', 'minor'],
    ['release', 'cut', '--no-push', '--bump', 'minor'],
  ]) {
    const r = cli([...args, '--cwd', f.dir, '--json']);
    assertEqual(
      r.status,
      20,
      `${args.join(' ')}: expected exit 20, got ${r.status} (stderr: ${r.stderr})`,
    );
    assertEqual(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
    const payload = JSON.parse(r.stderr);
    assert(
      payload.error.startsWith('no-released-promotion:'),
      `${args.join(' ')}: JSON refusal shape {error} with the slug`,
    );
  }

  const after = snapshotOf(f);
  assertEqual(after.head, before.head, 'no commit');
  assertEqual(after.tags, before.tags, 'no tag');
  assertEqual(after.changelog, before.changelog, 'CHANGELOG untouched (even prepare --apply)');
  assertEqual(after.porcelain, '?? .verity/', 'only the fixture furniture is untracked');
});

test('fail closed: split-active with NO promotions dir at all refuses the same way (no silent tag fall-back)', () => {
  const f = repo();
  armSplit(f.dir);
  const err = refusal(() => release.prepare(f.dir));
  assert(err, 'must refuse');
  assertEqual(err.slug, 'no-released-promotion');
  assertEqual(promotion.latestReleased(f.dir), null, 'absent dir ⇒ null, not a throw');
});

// ---------------------------------------------------------------------------
// 4. Collision guard, both modes.
// ---------------------------------------------------------------------------
test('collision guard (split): a computed version that already has a released record is refused version-already-released in prepare and cut --dry-run', () => {
  const f = splitFixture();
  record(f.dir, {
    id: '0003',
    version: '1.3.1',
    status: 'released',
    devCommit: f.head,
    tag: 'v1.3.1',
  });
  // With a consistent ledger the derivation can never land on a released
  // version (highest wins: 1.3.1 → 1.3.2). The guard is the invariant that
  // catches the derivation and the released ledger DISAGREEING, so the test
  // forces exactly that: derivation sees 1.3.0 as latest while the ledger
  // holds a released 1.3.1.
  assertEqual(
    release.prepare(f.dir, { bump: 'patch' }).version,
    '1.3.2',
    'consistent ledger: no collision',
  );
  const real = promotion.latestReleased;
  promotion.latestReleased = () => ({
    promotionId: 'PROM-0002',
    version: '1.3.0',
    tag: 'v1.3.0',
    devCommit: f.devCommit,
  });
  try {
    for (const [name, fn] of [
      ['prepare', () => release.prepare(f.dir, { bump: 'patch' })],
      ['cut --dry-run', () => release.cut(f.dir, { bump: 'patch', dryRun: true })],
      ['cut', () => release.cut(f.dir, { bump: 'patch', push: false })],
    ]) {
      const err = refusal(fn);
      assert(err, `${name} must refuse`);
      assertEqual(err.slug, 'version-already-released', `${name} slug`);
      assertEqual(err.exitCode, 20, `${name} exit code`);
      assert(
        err.message.includes('v1.3.1') && err.message.includes('PROM-0003'),
        `${name} names the shipped version and record`,
      );
    }
  } finally {
    promotion.latestReleased = real;
  }
  assertEqual(f.git(['tag']).trim(), 'v1.2.0', 'no tag was born');
});

test('collision guard (non-split): a derivation landing on an existing local v<version> tag is refused version-already-released', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-split-truth-nonsplit-'));
  const git = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
    });
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: a']);
  git(['tag', 'v0.1.0']);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'feat: b']);
  git(['tag', 'v0.2.0']);
  // Sanity: the repo's own tags derive 0.2.1 / 0.3.0 — no collision.
  assertEqual(release.prepare(dir).version, '0.2.1');
  // A derivation from an injected view that lands on 0.2.0 while the local
  // tag v0.2.0 exists: the local tags are the non-split release truth.
  for (const [name, fn] of [
    ['prepare', () => release.prepare(dir, { tags: ['v0.1.0'], bump: 'minor' })],
    ['cut --dry-run', () => release.cut(dir, { tags: ['v0.1.0'], bump: 'minor', dryRun: true })],
    ['cut', () => release.cut(dir, { tags: ['v0.1.0'], bump: 'minor', push: false })],
  ]) {
    const err = refusal(fn);
    assert(err, `${name} must refuse`);
    assertEqual(err.slug, 'version-already-released', `${name} slug`);
    assertEqual(err.exitCode, 20, `${name} exit code`);
    assert(err.message.includes('v0.2.0'), `${name} names the colliding tag`);
  }
  assertEqual(git(['tag']).trim(), 'v0.1.0\nv0.2.0', 'no tag was born');
  // Injected tags on a non-git dir (the shipyard pattern) keep working.
  const r = release.cut(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-nogit-')), {
    tags: ['v0.1.0', 'v0.1.5'],
    commits: ['feat: a'],
    dryRun: true,
  });
  assertEqual(r.version, '0.1.6');
});

// ---------------------------------------------------------------------------
// Review R1: `release current` answers from the same truth (the ship role
// runs it first — it must agree with prepare.previous and state.release).
// ---------------------------------------------------------------------------
test('release current (split): reports the released record and agrees with prepare.previous', () => {
  const f = splitFixture();
  const c = release.current(f.dir);
  assertEqual(c.version, '1.3.0');
  assertEqual(c.tag, 'v1.3.0');
  assertEqual(c.latest, 'v1.3.0');
  assertEqual(c.raw, 'v1.3.0');
  assertEqual(c.source, 'promotion-record');
  assertEqual(c.promotion_id, 'PROM-0002');
  assertEqual(c.tag, release.prepare(f.dir).previous, 'current == prepare.previous');
  assertEqual(
    c.tag,
    ledger.project(f.dir, { snapshot: ghShaped(f) }).release,
    'current == state.release',
  );
  const r = cli(['release', 'current', '--cwd', f.dir, '--json']);
  assertEqual(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assertEqual(out.tag, 'v1.3.0');
  assertEqual(out.source, 'promotion-record');
  // Split with nothing released: the same refusal as derive(), never the tag.
  const g = repo();
  armSplit(g.dir);
  const err = refusal(() => release.current(g.dir));
  assert(err, 'must refuse');
  assertEqual(err.slug, 'no-released-promotion');
  assertEqual(err.exitCode, 20);
});

test('release current (non-split): unchanged apart from the additive source: tag', () => {
  const f = repo();
  const c = release.current(f.dir);
  assertEqual(Object.keys(c).sort().join(','), 'latest,raw,source,version', 'keys');
  assertEqual(c.latest, 'v1.2.0');
  assertEqual(c.version, '1.2.0');
  assertEqual(c.raw, 'v1.2.0');
  assertEqual(c.source, 'tag');
  const none = release.current(fs.mkdtempSync(path.join(os.tmpdir(), 'verity-nogit-')));
  assertEqual(none.latest, null);
  assertEqual(none.version, null);
  assertEqual(none.raw, '');
  assertEqual(none.source, 'tag');
});

// ---------------------------------------------------------------------------
// Review R2: a development.commit the clone cannot see, or that is not an
// ancestor of HEAD, refuses in every verb — never a silent empty range.
// ---------------------------------------------------------------------------
function everyVerb(f) {
  return [
    ['prepare', () => release.prepare(f.dir, { bump: 'minor' })],
    ['prepare --apply', () => release.prepare(f.dir, { bump: 'minor', apply: true })],
    ['cut --dry-run', () => release.cut(f.dir, { bump: 'minor', dryRun: true })],
    ['cut', () => release.cut(f.dir, { bump: 'minor', push: false })],
    ['current', () => release.current(f.dir)],
  ];
}

function assertRefusesEverywhere(f, slug, needles) {
  const before = snapshotOf(f);
  for (const [name, fn] of everyVerb(f)) {
    const err = refusal(fn);
    assert(err, `${name} must refuse`);
    assertEqual(err.slug, slug, `${name} slug`);
    assertEqual(err.exitCode, 20, `${name} exit code`);
    for (const n of needles) {
      assert(err.message.includes(n), `${name} message names ${n}`);
    }
  }
  for (const args of [
    ['release', 'prepare', '--bump', 'minor'],
    ['release', 'cut', '--dry-run'],
    ['release', 'cut', '--no-push'],
    ['release', 'current'],
  ]) {
    const r = cli([...args, '--cwd', f.dir, '--json']);
    assertEqual(r.status, 20, `${args.join(' ')}: expected exit 20, got ${r.status}`);
    assertEqual(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert(
      JSON.parse(r.stderr).error.startsWith(`${slug}:`),
      `${args.join(' ')}: {error} leads with the slug`,
    );
  }
  const after = snapshotOf(f);
  assertEqual(after.head, before.head, 'no commit');
  assertEqual(after.tags, before.tags, 'no tag');
  assertEqual(after.changelog, before.changelog, 'CHANGELOG untouched (incl. prepare --apply)');
  assertEqual(after.porcelain, '?? .verity/', 'only the fixture furniture is untracked');
}

test('R2: a released record whose development.commit this clone does not have refuses dev-commit-unreachable in every verb (no silent empty range)', () => {
  const f = repo();
  armSplit(f.dir);
  const ghost = 'a'.repeat(40);
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: ghost,
    tag: 'v1.3.0',
  });
  assertRefusesEverywhere(f, 'dev-commit-unreachable', ['PROM-0002', ghost]);
});

test('R2: a released record whose development.commit is a real commit not merged into HEAD refuses dev-commit-not-ancestor', () => {
  const f = repo();
  f.git(['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(f.dir, 'side.txt'), 'side\n');
  f.git(['add', '.']);
  f.git(['commit', '-q', '-m', 'feat: on a side branch']);
  const side = f.git(['rev-parse', 'HEAD']).trim();
  f.git(['checkout', '-q', 'main']);
  armSplit(f.dir);
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: side,
    tag: 'v1.3.0',
  });
  assert(
    !f.git(['branch', '--contains', side]).includes('main'),
    'fixture: side commit is not on main',
  );
  assertRefusesEverywhere(f, 'dev-commit-not-ancestor', ['PROM-0002', side]);
});

// ---------------------------------------------------------------------------
// 5. Highest released wins; proposed / abandoned never count; malformed is loud.
// ---------------------------------------------------------------------------
test('latestReleased: highest released version wins; proposed/abandoned records are ignored regardless of PROM number', () => {
  const f = repo();
  armSplit(f.dir);
  record(f.dir, {
    id: '0001',
    version: '1.2.0',
    status: 'released',
    devCommit: f.baseline,
    tag: 'v1.2.0',
  });
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: f.devCommit,
    tag: 'v1.3.0',
  });
  record(f.dir, { id: '0003', version: '1.4.0', status: 'proposed', devCommit: f.head });
  record(f.dir, { id: '0004', version: '1.5.0', status: 'abandoned', devCommit: f.head });
  const last = promotion.latestReleased(f.dir);
  assertEqual(last.promotionId, 'PROM-0002');
  assertEqual(last.version, '1.3.0');
  assertEqual(last.tag, 'v1.3.0');
  assertEqual(last.devCommit, f.devCommit);
  assertEqual(release.prepare(f.dir, { bump: 'minor' }).previous, 'v1.3.0');
  assertEqual(
    promotion
      .releasedRecords(f.dir)
      .map((r) => r.version)
      .join(','),
    '1.2.0,1.3.0',
  );
  // A newer PROM number on an OLDER line (a hotfix of 1.2.x) does not win.
  record(f.dir, {
    id: '0005',
    version: '1.2.1',
    status: 'released',
    devCommit: f.baseline,
    tag: 'v1.2.1',
  });
  assertEqual(promotion.latestReleased(f.dir).version, '1.3.0', 'semver, not PROM order');
});

test('latestReleased: the real record shape — full-line comments and an additive publish block — parses; a malformed record throws naming the file', () => {
  const f = splitFixture();
  record(f.dir, {
    id: '0001',
    version: '1.2.0',
    status: 'released',
    devCommit: f.baseline,
    tag: 'v1.2.0',
    extra: [
      "# Additive publish block (contract v1 status enum has no 'published' state —",
      '# candidate for additive growth; recorded here as evidence, not a transition).',
      'publish:',
      '  registry: registry.npmjs.org',
      '  package: verity-framework@1.2.0',
      '  method: manual by maintainer (O4 open; prepublishOnly lint+test gates ran in the publish clone)',
      '',
    ].join('\n'),
  });
  assertEqual(
    promotion.latestReleased(f.dir).version,
    '1.3.0',
    'PROM-0001 with comments is readable, 1.3.0 still wins',
  );

  fs.writeFileSync(
    path.join(f.dir, '.verity', 'promotions', 'PROM-0009.yml'),
    'this is: not: a record\n',
  );
  const err = refusal(() => promotion.latestReleased(f.dir));
  assert(err, 'malformed record must throw');
  assert(err.message.includes('PROM-0009.yml'), 'error names the file');
  assertEqual(err.exitCode, 20);
  assertEqual(
    refusal(() => release.prepare(f.dir)).message.includes('PROM-0009.yml'),
    true,
    'prepare fails loud, not silently on tags',
  );
  fs.rmSync(path.join(f.dir, '.verity', 'promotions', 'PROM-0009.yml'));

  // A released record with no development.commit cannot anchor a range.
  record(f.dir, {
    id: '0009',
    version: '1.3.5',
    status: 'released',
    devCommit: 'null',
    tag: 'v1.3.5',
  });
  const noCommit = refusal(() => promotion.latestReleased(f.dir));
  assert(noCommit, 'released record without a dev commit must throw');
  assert(noCommit.message.includes('PROM-0009.yml'), 'names the file');
});

// ---------------------------------------------------------------------------
// 6. Non-split byte-identical: the same repo without the split derives from tags
//    exactly as before (the full contract is shipyard + release-prepare unchanged).
// ---------------------------------------------------------------------------
test('non-split: the same repository without promotion.json derives from the highest tag over every commit since it (pre-stage-97 path)', () => {
  const f = repo();
  record(f.dir, {
    id: '0002',
    version: '1.3.0',
    status: 'released',
    devCommit: f.devCommit,
    tag: 'v1.3.0',
  });
  const r = release.prepare(f.dir, { bump: 'minor' });
  assertEqual(r.previous, 'v1.2.0', 'tags, not records, when the split is off');
  assertEqual(r.version, '1.3.0');
  assertEqual(r.commitCount, 4);
  const dry = release.cut(f.dir, { bump: 'minor', dryRun: true });
  assertEqual(dry.previous, 'v1.2.0');
  assertEqual(dry.version, '1.3.0');
});

// ---------------------------------------------------------------------------
// 7. Shared derivation on the split fixture (release-prepare.test.cjs extends
//    its own "cut and prepare share one derivation" too).
// ---------------------------------------------------------------------------
test('shared derivation: cut --dry-run and prepare agree on the record-derived version/previous/range', () => {
  const f = splitFixture();
  const dry = release.cut(f.dir, { bump: 'minor', dryRun: true });
  const prep = release.prepare(f.dir, { bump: 'minor' });
  assertEqual(dry.previous, 'v1.3.0');
  assertEqual(prep.previous, dry.previous);
  assertEqual(prep.version, dry.version);
  assertEqual(prep.tag_candidate, dry.tag);
  assertEqual(prep.commitCount, dry.commitCount);
  assertEqual(dry.applied, false);
  assertEqual(f.git(['tag']).trim(), 'v1.2.0', 'dry-run minted nothing');
});

// ---------------------------------------------------------------------------
// 8. Local substrate: the record read is cwd-based, so `substrate: local`
//    reports the same truth through the real `verity state` CLI (zero gh).
// ---------------------------------------------------------------------------
test('local substrate: verity state reports release from the record (cwd-based read), ignoring the local tag the snapshot still carries', () => {
  const f = splitFixture();
  fs.writeFileSync(path.join(f.dir, '.verity', 'autonomy.yml'), 'substrate: local\n');
  const snap = sub.fetchLocalSnapshot(f.dir);
  assertEqual(snap.verified, true);
  assert(snap.tags.includes('v1.2.0'), 'the local snapshot reads the dev tag as before');
  const proj = ledger.project(f.dir, { snapshot: snap });
  assertEqual(proj.release, 'v1.3.0');
  assertEqual(proj.release_source, 'promotion-record');

  const r = cli(['state', 'view', '--cwd', f.dir, '--json']);
  assertEqual(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assertEqual(out.release, 'v1.3.0');
  assertEqual(out.release_source, 'promotion-record');
  const summary = cli(['state', 'summary', '--cwd', f.dir, '--json']);
  assertEqual(summary.status, 0, `stderr: ${summary.stderr}`);
  assertEqual(JSON.parse(summary.stdout).release, 'v1.3.0');
});

// ---------------------------------------------------------------------------
// 9. Consumer sweep pin: the frozen operator-* key sets do not move on the split
//    fixture (only the `release` VALUE inside state changes; the operator
//    projections never carried it).
// ---------------------------------------------------------------------------
test('consumer sweep pin: operator snapshot / policy / usage / diagnostics key sets are unchanged on the split fixture', () => {
  const f = splitFixture();
  fs.mkdirSync(path.join(f.dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(f.dir, 'stage-instructions', 'stage-1-core.md'),
    '# Stage 1: Core\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  const twin = repo(); // same repo, split off — the reference key sets
  fs.mkdirSync(path.join(twin.dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(twin.dir, 'stage-instructions', 'stage-1-core.md'),
    '# Stage 1: Core\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  const keys = (o) => Object.keys(o).sort().join(',');

  const snap = operator.snapshot(f.dir, { snapshot: ghShaped(f) });
  assertEqual(
    keys(snap),
    'autonomy,generated_at,health,limits,next,online,queue,repository,runtime,schema,worker',
    'operator-snapshot contract keys (the set operator-snapshot.test.cjs pins)',
  );
  assertEqual(
    keys(snap),
    keys(operator.snapshot(twin.dir, { snapshot: ghShaped(twin) })),
    'split vs non-split',
  );
  assert(!('release' in snap) && !('release_source' in snap), 'snapshot never carried release');

  assertEqual(
    keys(operator.policy(f.dir)),
    keys(operator.policy(twin.dir)),
    'operator policy keys',
  );
  assertEqual(keys(operator.usage(f.dir)), keys(operator.usage(twin.dir)), 'operator usage keys');
  assertEqual(
    keys(operator.diagnostics(f.dir)),
    keys(operator.diagnostics(twin.dir)),
    'operator diagnostics keys',
  );

  // And the work queue (operator work) still projects from the same ledger.
  const work = operator.work(f.dir, { snapshot: ghShaped(f) });
  assert(Array.isArray(work), 'operator work projects a list on the split fixture');
});
