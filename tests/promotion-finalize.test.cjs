// Stage 44 (#107 Phase 3) — `verity promotion finalize`: prod-side tag +
// GitHub Release from a MERGED promotion PR, completing the promotion-records
// v1 evidence trail. Offline, the stage-43 fixture pattern extended: a LOCAL
// bare repo stands in for prod carrying a real --no-ff merge of a promotion
// branch, gh sits behind an injectable stub (pr view / release create), and
// the record's digests are deliberately fake — equality proves finalize
// COMPARES them (verify-before-tag) and never recomputes. The pack shasum is
// the one REAL value: computed once from the fixture package by `npm pack`,
// so the merged tree provably reproduces it.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promotion = require('../verity/bin/lib/promotion.cjs');
const status = require('../verity/bin/lib/status.cjs');
const { findBare } = require('../verity/bin/lib/changelog-sanitize.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'verity', 'bin', 'verity.cjs');

const DEV_SLUG = 'acme/widget-dev';
const DEV_URL = `https://github.com/${DEV_SLUG}.git`;
const PROD_REPO = 'acme/widget-prod';
const DEV_SHA = 'f0e1d2c3b4a5968778695a4b3c2d1e0f01234567';
const CLASSIFICATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const STAGING_DIGEST = `sha256:${'b'.repeat(64)}`;

// --- fixture helpers ---------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-finalize-${tag}-`));
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function rm(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// The promotion tree's packable content. `npm pack` respects the files
// allowlist, so RELEASE-MANIFEST.json / .github never enter the tarball —
// the merged tree must pack byte-identically to this set alone.
const PACK_FILES = {
  'package.json': `${JSON.stringify(
    { name: 'widget-prod', version: '1.2.0', license: 'MIT', files: ['lib'] },
    null,
    2,
  )}\n`,
  'lib/a.js': 'module.exports = 44;\n',
};

// The ONE real verification value: what the fixture package actually packs to.
function computePackShasum(files) {
  const dir = tmp('packsrc');
  const dest = tmp('packdest');
  writeTree(dir, files);
  execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  const sha = crypto
    .createHash('sha1')
    .update(fs.readFileSync(path.join(dest, tgz)))
    .digest('hex');
  rm(dir);
  rm(dest);
  return sha;
}
const REAL_PACK_SHASUM = computePackShasum(PACK_FILES);

function manifestJson(overrides = {}) {
  return `${JSON.stringify(
    {
      schema: 1,
      version: '1.2.0',
      promotion_id: 'PROM-0001',
      development_commit: DEV_SHA,
      classification_digest: CLASSIFICATION_DIGEST,
      staging_digest: STAGING_DIGEST,
      package_shasum: REAL_PACK_SHASUM,
      verify: { gates: 'all-pass', baseline: null },
      promoted_at: '2026-08-05T00:00:00.000Z',
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

// A PROM record exactly as propose (stage 43) writes it.
function promRecordText({
  version = '1.2.0',
  status = 'proposed',
  pull = 7,
  packShasum = REAL_PACK_SHASUM,
} = {}) {
  return [
    'promotion_id: PROM-0001',
    `version: ${version}`,
    `status: ${status}`,
    'development:',
    `  repository: ${DEV_SLUG}`,
    `  commit: ${DEV_SHA}`,
    `  staging_digest: ${STAGING_DIGEST}`,
    `  classification_digest: ${CLASSIFICATION_DIGEST}`,
    'production:',
    `  repository: ${PROD_REPO}`,
    `  pull_request: ${pull}`,
    '  commit: null',
    '  tag: null',
    'verification:',
    '  gates: all-pass',
    `  package_shasum: ${packShasum}`,
    '  baseline: null',
    'timestamps:',
    '  proposed_at: 2026-08-05T00:00:00.000Z',
    '  finalized_at: null',
    '',
  ].join('\n');
}

// Stage 91 fixture surface: the dev repo carries a package.json (the
// rollback_from string reuses its name — no hardcoded "verity-framework"), a
// STALE .verity/runtime.json, and the STATUS.md rendered from it. That stale
// pair IS the drift this stage closes: without the stamp, finalize leaves the
// release surface naming the OLD version.
const DEV_PKG_NAME = 'widget-dev';
const STALE_RUNTIME = {
  version: '1.1.0',
  deployed_at: '2026-07-01T00:00:00.000Z',
  rollback_from: `v1.0.1 (git tag; npm ${DEV_PKG_NAME}@1.0.1)`,
  environments: { prod: 'https://widget.example.invalid' },
  secret_locations: ['WIDGET_TOKEN @ ~/.config/widget/token'],
  notes: ['fixture coordination note'],
};

// Render STATUS.md the way status.cjs would, without touching the repo under
// test: render into a throwaway dir and read the bytes back.
function renderedStatusMd(data) {
  const dir = tmp('render');
  status.render(dir, data);
  const text = fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8');
  rm(dir);
  return text;
}

// The dev repo: origin remote (sanitization checks need a slug to scan for),
// promotion.json + the PROM record committed. NO tags — the ADR-0019
// assertion is that finalize never adds one.
function makeDevRepo(recordText = promRecordText(), { runtime = STALE_RUNTIME } = {}) {
  const dir = tmp('dev');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', DEV_URL);
  const files = {
    'package.json': `${JSON.stringify({ name: DEV_PKG_NAME, version: '1.1.0' }, null, 2)}\n`,
    '.verity/promotion.json': `${JSON.stringify({
      schema: 1,
      split_active: true,
      prod_repo: PROD_REPO,
      prod_owned: ['.github/**', 'RELEASE-MANIFEST.json'],
    })}\n`,
    '.verity/runtime.json': `${JSON.stringify(runtime, null, 2)}\n`,
    'STATUS.md': renderedStatusMd(runtime),
  };
  if (recordText !== null) {
    files['.verity/promotions/PROM-0001.yml'] = recordText;
  }
  writeTree(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dev fixture');
  return dir;
}

function readRuntime(dev) {
  return JSON.parse(fs.readFileSync(path.join(dev, '.verity/runtime.json'), 'utf8'));
}

function recordFinalizedAt(dev) {
  const line = fs
    .readFileSync(path.join(dev, '.verity/promotions/PROM-0001.yml'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('  finalized_at: '));
  return line ? line.slice('  finalized_at: '.length) : null;
}

// The prod stand-in AFTER the review/merge step: baseline (tagged v1.1.0) +
// a promotion branch merged into main with a real --no-ff merge commit.
function makeMergedProd({ files = PACK_FILES, manifest = manifestJson(), preTag = null } = {}) {
  const work = tmp('prodwork');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Verity Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeTree(work, {
    'README.md': 'prod baseline readme\n',
    '.github/workflows/ci.yml': 'name: prod-ci\non: [push]\n',
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'prod baseline');
  git(work, 'tag', 'v1.1.0');
  git(work, 'checkout', '-q', '-b', 'promote/v1.2.0');
  for (const entry of fs.readdirSync(work)) {
    if (entry !== '.git') {
      rm(path.join(work, entry));
    }
  }
  writeTree(work, {
    ...files,
    'RELEASE-MANIFEST.json': manifest,
    '.github/workflows/ci.yml': 'name: prod-ci\non: [push]\n',
  });
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Promote Verity v1.2.0');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'Merge promotion PR', 'promote/v1.2.0');
  const mergeSha = git(work, 'rev-parse', 'HEAD').trim();
  if (preTag) {
    git(work, 'tag', preTag);
  }
  const bare = tmp('prodbare');
  fs.rmdirSync(bare);
  git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  rm(work);
  return { bare, mergeSha };
}

// gh stub: answers `pr view --json state,mergeCommit` and `release create`.
function finalizeGhStub(calls, { state = 'MERGED', mergeSha = null } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return `${JSON.stringify({
        state,
        mergeCommit: state === 'MERGED' ? { oid: mergeSha } : null,
      })}\n`;
    }
    if (args[0] === 'release' && args[1] === 'create') {
      return `https://github.com/${PROD_REPO}/releases/tag/${args[2]}\n`;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

function refsOf(bare) {
  return git(bare, 'for-each-ref');
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// --- happy path: verified merge → tag + release + completed record -----------

const happyProd = makeMergedProd();
const happyDev = makeDevRepo();
const happyCalls = [];
const happy = promotion.finalize('1.2.0', {
  cwd: happyDev,
  prodUrl: happyProd.bare,
  gh: finalizeGhStub(happyCalls, { mergeSha: happyProd.mergeSha }),
});

test('finalize: happy path exits 0 with the full envelope', () => {
  assertEqual(happy.exit_code, 0, `exit (failures: ${JSON.stringify(happy.failures || null)})`);
  assertEqual(happy.promotion_id, 'PROM-0001', 'promotion id from the record');
  assertEqual(happy.prod_repo, PROD_REPO, 'prod repo from config');
  assertEqual(happy.pull_request, 7, 'PR number from the record');
  assertEqual(happy.merge_commit, happyProd.mergeSha, 'merge commit from gh');
  assertEqual(happy.tag, 'v1.2.0', 'authoritative tag name');
  assertEqual(happy.release_created, true, 'release issued');
  assertEqual(happy.published, 'workflow-triggered', 'the tag push triggered the publish workflow');
  assertEqual(happy.verification.manifest, 'match', 'manifest verified before tagging');
  assertEqual(
    happy.verification.pack_shasum,
    REAL_PACK_SHASUM,
    'merged tree repacked to the record shasum',
  );
});

test('annotated tag v1.2.0 sits ON the merge commit in PROD, message sanitized', () => {
  const tagType = git(happyProd.bare, 'cat-file', '-t', 'refs/tags/v1.2.0').trim();
  assertEqual(tagType, 'tag', 'ANNOTATED tag object, not lightweight');
  const target = git(happyProd.bare, 'rev-parse', 'v1.2.0^{}').trim();
  assertEqual(target, happyProd.mergeSha, 'tag points at the merge commit');
  const tagObj = git(happyProd.bare, 'cat-file', 'tag', 'refs/tags/v1.2.0');
  assert(tagObj.includes('Verity v1.2.0 (PROM-0001)'), 'tag message names version + promotion');
  assert(tagObj.includes(STAGING_DIGEST), 'tag message carries the staging digest');
  assert(!tagObj.includes(DEV_SLUG), 'no dev repo name in the tag');
  assert(!tagObj.includes(DEV_URL), 'no dev URL in the tag');
});

test('gh saw pr view then release create against PROD; release body embeds the manifest, sanitized', () => {
  assertEqual(happyCalls.length, 2, 'exactly two gh calls');
  const [view, release] = happyCalls;
  assertEqual(view[0], 'pr', 'first call is pr view');
  assertEqual(view[1], 'view', 'first call is pr view');
  assertEqual(view[2], '7', 'PR number from the record');
  assertEqual(flag(view, '--repo'), PROD_REPO, 'pr view targets prod');
  assertEqual(release[0], 'release', 'second call is release create');
  assertEqual(release[1], 'create', 'second call is release create');
  assertEqual(release[2], 'v1.2.0', 'release for the tag');
  assertEqual(flag(release, '--repo'), PROD_REPO, 'release targets prod');
  assertEqual(flag(release, '--title'), 'v1.2.0', 'release title');
  const body = flag(release, '--notes');
  assert(body?.includes('RELEASE-MANIFEST.json'), 'body embeds the manifest');
  assert(body.includes(STAGING_DIGEST), 'manifest content present');
  assert(body.includes(REAL_PACK_SHASUM), 'package shasum present');
  assert(!body.includes(DEV_SLUG), 'no dev repo name in the release body');
  assert(!body.includes(DEV_URL), 'no dev URL in the release body');
  assertEqual(findBare(body).length, 0, 'no bare #NN autolink hazards in the release body');
});

test('PROM record completed per the contract and committed with a chore(promotion) message', () => {
  const p = path.join(happyDev, '.verity/promotions/PROM-0001.yml');
  assertEqual(happy.record_path, p, 'record path in the envelope');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert(lines.includes('status: released'), 'status → released');
  assert(lines.includes(`  commit: ${happyProd.mergeSha}`), 'production.commit = merge commit');
  assert(lines.includes('  tag: v1.2.0'), 'production.tag set');
  assert(
    lines.some((l) => /^ {2}finalized_at: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(l)),
    'finalized_at is iso8601',
  );
  assert(lines.includes('  proposed_at: 2026-08-05T00:00:00.000Z'), 'proposed_at untouched');
  assert(lines.includes(`  staging_digest: ${STAGING_DIGEST}`), 'digests untouched');
  assert(lines.includes(`  package_shasum: ${REAL_PACK_SHASUM}`), 'shasum untouched');
  assertEqual(happy.record_committed, true, 'record committed');
  const subject = git(happyDev, 'log', '-1', '--pretty=%s').trim();
  assertEqual(
    subject,
    'chore(promotion): record PROM-0001 — finalize v1.2.0 released (prod tag v1.2.0)',
    'dev commit message (no #NN autolink hazard)',
  );
  assertEqual(git(happyDev, 'status', '--porcelain'), '', 'dev working tree clean');
});

test('ADR-0019: the DEV repo has NO tags after finalize — authoritative tags are born in prod only', () => {
  assertEqual(git(happyDev, 'tag'), '', 'dev tag list empty after a successful finalize');
});

// --- stage 93: the publish notice reports what finalize CAUSED ---------------

test('publish notice: names the trigger, the approval and the verification, with the by-hand fallback', () => {
  const text = happy.publish_instruction;
  assert(text.includes('.github/workflows/publish.yml'), 'the triggered workflow is named');
  assert(/on: push.*v\*|v\* tags/.test(text), 'the trigger is stated as a v* tag push');
  assert(text.includes('npm-publish'), 'the environment gate is named');
  assert(
    text.includes(`https://github.com/${PROD_REPO}/actions/workflows/publish.yml`),
    'the approval URL is the PROD actions URL',
  );
  assert(
    text.includes(`npm view ${DEV_PKG_NAME}@1.2.0 dist.shasum`),
    'verification names the package from package.json, never a hardcoded name',
  );
  assert(text.includes(REAL_PACK_SHASUM), 'expected tarball shasum stated');
  assert(/[Ff]allback/.test(text), 'the by-hand path is explicitly the fallback');
  assert(text.includes(`https://github.com/${PROD_REPO}.git`), 'clone URL is the PROD repo');
  assert(text.includes('git checkout v1.2.0'), 'the fallback checks out the authoritative tag');
  assert(text.includes('npm publish'), 'the by-hand command is still spelled out');
});

test('publish notice: claims no registry state and names no credential mechanism', () => {
  const text = happy.publish_instruction;
  for (const forbidden of ['pending-O4', 'O4', 'NOT executed', 'OIDC', 'token', 'secret']) {
    assert(!text.includes(forbidden), `notice must not say ${JSON.stringify(forbidden)}`);
  }
  assert(!/trusted publish/i.test(text), 'no credential mechanism named');
  assert(
    !/\bis published\b|\bhas been published\b/.test(text),
    'no claim that the package IS published',
  );
});

test('publish notice: no secrets or dev identifiers', () => {
  const text = happy.publish_instruction;
  assert(!text.includes(DEV_SLUG), 'no dev repo name');
  assert(!text.includes(DEV_URL), 'no dev URL');
  for (const p of promotion.SECRET_PATTERNS) {
    assert(!p.re.test(text), `no ${p.name} shape in the instruction`);
  }
});

test('the success raw line renders the published enum; pending-O4 is gone from the module', () => {
  assert(
    happy.raw.includes('(publish: workflow-triggered)'),
    `raw renders result.published: ${happy.raw}`,
  );
  const src = fs.readFileSync(path.join(REPO_ROOT, 'verity/bin/lib/promotion.cjs'), 'utf8');
  assert(!src.includes('pending-O4'), 'no hardcoded pending-O4 left in promotion.cjs');
  assert(!src.includes('npm publish NOT executed'), 'the old NOT-executed claim is gone');
});

// --- stage 91: the release surface is stamped at the moment of release --------
// The dev fixture goes in reading 1.1.0. Every assertion below fails if
// finalize completes while the release surface still names the OLD version —
// which is exactly the drift (1.2.0 and 1.3.0 released, STATUS.md at 1.1.0)
// that produced this stage.

test('stage 91 regression: runtime.json names the finalized version, not the stale one', () => {
  const rt = readRuntime(happyDev);
  assertEqual(rt.version, '1.2.0', 'runtime version is the finalized version (no v prefix)');
  assertEqual(
    rt.deployed_at,
    recordFinalizedAt(happyDev),
    'ONE clock reading — deployed_at is byte-identical to the record finalized_at',
  );
  assertEqual(happy.runtime_stamped, true, 'envelope reports the stamp');
  assertEqual(happy.runtime_version, '1.2.0', 'envelope names the stamped version');
});

test('stage 91: rollback_from carries the REPLACED version in the existing string shape', () => {
  assertEqual(
    readRuntime(happyDev).rollback_from,
    `v1.1.0 (git tag; npm ${DEV_PKG_NAME}@1.1.0)`,
    'previous runtime version; package name read from package.json, never hardcoded',
  );
});

test('stage 91: STATUS.md is regenerated as a PURE rendering of the JSON', () => {
  const rt = readRuntime(happyDev);
  const text = fs.readFileSync(path.join(happyDev, 'STATUS.md'), 'utf8');
  assert(text.includes('**Live version:** 1.2.0'), 'live version line matches the JSON');
  assert(text.includes(`**Deployed at:** ${rt.deployed_at}`), 'deployed-at line matches the JSON');
  assertEqual(text, renderedStatusMd(rt), 'byte-identical to status.render — no hand-authoring');
});

test('stage 91: environments / secret_locations / notes are untouched by the stamp', () => {
  const rt = readRuntime(happyDev);
  assertEqual(
    JSON.stringify(rt.environments),
    JSON.stringify(STALE_RUNTIME.environments),
    'environments byte-identical',
  );
  assertEqual(
    JSON.stringify(rt.secret_locations),
    JSON.stringify(STALE_RUNTIME.secret_locations),
    'secret locations byte-identical',
  );
  assertEqual(
    JSON.stringify(rt.notes),
    JSON.stringify(STALE_RUNTIME.notes),
    'notes byte-identical',
  );
});

test('stage 91: ONE commit carries the PROM record AND both runtime files', () => {
  const names = git(happyDev, 'show', '--name-only', '--pretty=format:', 'HEAD')
    .trim()
    .split('\n')
    .sort();
  assertEqual(
    names.join(','),
    ['.verity/promotions/PROM-0001.yml', '.verity/runtime.json', 'STATUS.md'].join(','),
    'the chore(promotion) commit is the whole release-surface update',
  );
});

// A fresh prod+dev fixture per case (the happy pair is shared and already
// finalized — finalize is not repeatable).
function finalizeFresh(opts = {}, devOpts = {}) {
  const prod = makeMergedProd();
  const dev = makeDevRepo(promRecordText(), devOpts);
  const calls = [];
  const r = promotion.finalize('1.2.0', {
    cwd: dev,
    prodUrl: prod.bare,
    gh: finalizeGhStub(calls, { mergeSha: prod.mergeSha }),
    ...opts,
  });
  return { r, dev, prod, calls };
}

test('stage 91: a runtime.json with version null finalizes, leaving rollback_from alone', () => {
  const { r, dev, prod } = finalizeFresh(
    {},
    { runtime: { ...STALE_RUNTIME, version: null, rollback_from: null } },
  );
  assertEqual(r.exit_code, 0, `exit (raw: ${r.raw})`);
  const rt = readRuntime(dev);
  assertEqual(rt.version, '1.2.0', 'version stamped from nothing');
  assertEqual(rt.rollback_from, null, 'no previous version → rollback_from untouched');
  assertEqual(r.runtime_stamped, true, 'still stamped');
  rm(dev);
  rm(prod.bare);
});

test('stage 91: commitRecord:false writes both runtime files but commits nothing', () => {
  const { r, dev, prod } = finalizeFresh({ commitRecord: false });
  assertEqual(r.exit_code, 0, `exit (raw: ${r.raw})`);
  assertEqual(r.record_committed, false, 'record not committed');
  assertEqual(r.runtime_stamped, true, 'stamp still written to disk');
  assertEqual(readRuntime(dev).version, '1.2.0', 'runtime.json written');
  assert(
    fs.readFileSync(path.join(dev, 'STATUS.md'), 'utf8').includes('**Live version:** 1.2.0'),
    'STATUS.md written',
  );
  const dirty = git(dev, 'status', '--porcelain');
  assert(/\.verity\/runtime\.json/.test(dirty), 'runtime.json left UNcommitted');
  assert(/STATUS\.md/.test(dirty), 'STATUS.md left UNcommitted');
  assertEqual(git(dev, 'log', '-1', '--pretty=%s').trim(), 'dev fixture', 'no new dev commit');
  rm(dev);
  rm(prod.bare);
});

test('stage 91 FAIL SOFT: a broken status seam warns but never loses the release', () => {
  const boom = () => {
    throw new Error('runtime.json is unwritable (simulated)');
  };
  const captured = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  let out;
  try {
    out = finalizeFresh({ status: { read: boom, write: boom, render: boom } });
  } finally {
    process.stderr.write = realWrite;
  }
  const { r, dev, prod } = out;
  assertEqual(r.exit_code, 0, 'EXIT_BUILT — a stamp failure cannot fail a verified release');
  assertEqual(r.tag, 'v1.2.0', 'tag still reported');
  assertEqual(r.release_created, true, 'release still reported');
  assertEqual(r.record_committed, true, 'PROM record still committed');
  assertEqual(r.runtime_stamped, false, 'the stamp is reported as NOT done');
  assertEqual(r.runtime_version, null, 'no stamped version is claimed');
  assertEqual(readRuntime(dev).version, '1.1.0', 'runtime.json left at its stale value');
  const warned = captured.join('');
  assert(
    warned.includes('verity status set version 1.2.0'),
    'the warning names the manual command to run',
  );
  rm(dev);
  rm(prod.bare);
});

// --- verify-before-tag: every mismatch aborts, tags NOTHING, status untouched -

function finalizeExpectingAbort(name, { record, prod, ghState, reMessage, expectStatus }) {
  test(name, () => {
    const p = prod ? prod() : makeMergedProd();
    const dev = makeDevRepo(record !== undefined ? record : promRecordText());
    const refsBefore = refsOf(p.bare);
    const devLogBefore = git(dev, 'rev-list', '--all');
    const recordPath = path.join(dev, '.verity/promotions/PROM-0001.yml');
    const recordBefore = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : null;
    const calls = [];
    const r = promotion.finalize('1.2.0', {
      cwd: dev,
      prodUrl: p.bare,
      gh: finalizeGhStub(calls, { state: ghState || 'MERGED', mergeSha: p.mergeSha }),
    });
    assertEqual(r.exit_code, 20, `contract exit (raw: ${r.raw})`);
    assert(reMessage.test(r.raw), `refusal names the cause: ${r.raw}`);
    // Stage 93: nothing was tagged, so nothing was started — on EVERY in-process
    // refusal path, not just the CLI one below.
    assertEqual(r.published, 'not-triggered', 'refusal reports no publish trigger');
    assertEqual(r.publish_instruction, null, 'and prints no publish notice');
    assertEqual(refsOf(p.bare), refsBefore, 'prod refs BYTE-IDENTICAL — nothing tagged');
    assert(!calls.some((a) => a[0] === 'release'), 'no release call ever issued');
    if (recordBefore !== null) {
      assertEqual(
        fs.readFileSync(recordPath, 'utf8'),
        recordBefore,
        `record byte-identical — status stays ${expectStatus || 'proposed'}`,
      );
    }
    assertEqual(git(dev, 'rev-list', '--all'), devLogBefore, 'no dev commit');
    assertEqual(git(dev, 'tag'), '', 'dev never tagged (ADR-0019, refusal path too)');
    rm(dev);
    rm(p.bare);
  });
}

finalizeExpectingAbort('mismatch: manifest version differs from the record → abort, tag nothing', {
  prod: () => makeMergedProd({ manifest: manifestJson({ version: '1.3.0' }) }),
  reMessage: /verification mismatch \(version/,
});

finalizeExpectingAbort('mismatch: manifest staging digest differs → abort, tag nothing', {
  prod: () =>
    makeMergedProd({ manifest: manifestJson({ staging_digest: `sha256:${'d'.repeat(64)}` }) }),
  reMessage: /verification mismatch \(.*staging_digest/,
});

finalizeExpectingAbort('mismatch: manifest classification digest differs → abort, tag nothing', {
  prod: () =>
    makeMergedProd({
      manifest: manifestJson({ classification_digest: `sha256:${'e'.repeat(64)}` }),
    }),
  reMessage: /verification mismatch \(.*classification_digest/,
});

finalizeExpectingAbort('mismatch: merged tree PACKS to a different shasum → abort, tag nothing', {
  prod: () =>
    makeMergedProd({
      files: { ...PACK_FILES, 'lib/a.js': 'module.exports = 45; // drifted after verify\n' },
    }),
  reMessage: /verification mismatch \(package_shasum \(npm pack\)\)/,
});

finalizeExpectingAbort('mismatch: merged tree has no RELEASE-MANIFEST.json → abort, tag nothing', {
  prod: () => {
    const p = makeMergedProd();
    // Simulate a merge that somehow lost the manifest: point gh at the
    // BASELINE commit (a real commit whose tree has no manifest).
    return { bare: p.bare, mergeSha: git(p.bare, 'rev-parse', 'v1.1.0^{}').trim() };
  },
  reMessage: /no RELEASE-MANIFEST\.json/,
});

// --- status machine ----------------------------------------------------------

finalizeExpectingAbort(
  'status machine: finalize on a released record refuses (idempotence guard)',
  {
    record: promRecordText({ status: 'released' }),
    reMessage: /already released.*not repeatable/,
    expectStatus: 'released',
  },
);

finalizeExpectingAbort('status machine: finalize on an abandoned record refuses', {
  record: promRecordText({ status: 'abandoned' }),
  reMessage: /status "abandoned", not "proposed"/,
  expectStatus: 'abandoned',
});

finalizeExpectingAbort(
  'status machine: an OPEN promotion PR refuses, naming the review/merge step',
  {
    ghState: 'OPEN',
    reMessage: /is OPEN, not MERGED.*reviewed and merged in prod/,
  },
);

finalizeExpectingAbort('status machine: a CLOSED-unmerged PR refuses — propose a new promotion', {
  ghState: 'CLOSED',
  reMessage: /is CLOSED, not MERGED/,
});

finalizeExpectingAbort('no PROM record for the version → refuse pointing at propose', {
  record: null,
  reMessage: /no PROM record for version 1\.2\.0/,
});

finalizeExpectingAbort('tag already present in prod → refuse, never re-tag', {
  prod: () => makeMergedProd({ preTag: 'v1.2.0' }),
  reMessage: /tag v1\.2\.0 already exists/,
});

// --- CLI wiring ---------------------------------------------------------------

test('CLI: finalize --json with no PROM record exits 20 with one compact object', () => {
  const dev = makeDevRepo(null);
  let status = 0;
  let stdout = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'finalize', '1.2.0', '--cwd', dev, '--json'], {
      encoding: 'utf8',
    });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
  }
  assertEqual(status, 20, 'contract-violation exit code');
  const lines = stdout.trim().split('\n');
  assertEqual(lines.length, 1, 'exactly one stdout line (pipe-safe)');
  const obj = JSON.parse(lines[0]);
  assert(/no PROM record/.test(obj.raw), 'the refusal reason reaches the envelope');
  assertEqual(obj.published, 'not-triggered', 'a refusal tagged nothing, so it started nothing');
  rm(dev);
});

test('CLI: finalize without a version is a usage error', () => {
  let status = 0;
  let stderr = '';
  try {
    execFileSync('node', [CLI, 'promotion', 'finalize'], { encoding: 'utf8' });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr || '');
  }
  assertEqual(status, 1, 'usage error exit');
  assert(/usage: verity promotion finalize/.test(stderr), 'usage line printed');
});

// happy-path fixture cleanup (kept alive across the earlier tests)
rm(happyDev);
rm(happyProd.bare);
