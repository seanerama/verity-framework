// Stage 114 (ADR-0038 D2, contract operator-init v1 §register) — the intake
// register reader, verity/bin/lib/intake.cjs.
//
//   - schema-1 acceptance/rejection (validate/parse), one reason per defect;
//   - a missing register is the empty set, SILENTLY (every pre-init project);
//   - fail closed: an unparseable or schema-invalid COMMITTED register is the
//     empty set WITH one warning — a broken register never trusts anything;
//   - the trust source is the register COMMITTED on the default branch
//     (refs/remotes/origin/HEAD), never the working tree and never a stage
//     branch the checkout happens to stand on: a working-tree edit or a
//     branch-only entry is not trusted.
// Real git in throwaway repos; no network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const intake = require('../verity/bin/lib/intake.cjs');

const entry = (number, extra = {}) => ({
  number,
  kind: 'issue',
  spec: 'docs/spec.md',
  spec_commit: '3f1c2ab',
  filed_by: 'verity init',
  engine: '1.8.0',
  filed_at: '2026-09-29T18:00:00Z',
  ...extra,
});
const register = (...requests) => ({ schema: 1, requests });

// A repo whose `main` carries `committed` (object or raw string; undefined =
// no register) and whose origin/HEAD points at it (the clone / init shape).
function repo(tag, committed, { originHead = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verity-intake-${tag}-`));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Intake Test',
        '-c',
        'user.email=intake@verity.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  if (committed !== undefined) {
    writeRegister(dir, committed);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (originHead) {
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  }
  return { dir, git };
}

function writeRegister(dir, doc) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.verity', 'intake.json'),
    typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`,
  );
}

function numbers(dir, opts = {}) {
  const warns = [];
  const set = intake.registeredNumbers(dir, { ...opts, warn: (m) => warns.push(m) });
  return { list: [...set].sort((a, b) => a - b), warns };
}

// --- schema ------------------------------------------------------------------

test('validate: the contract example (schema 1) is accepted; an unknown extra key is tolerated', () => {
  assertEqual(intake.validate(register(entry(1))), null, 'contract example');
  assertEqual(intake.validate(register()), null, 'an empty register is valid');
  assertEqual(
    intake.validate(register(entry(2, { kind: 'record', engine: null, future_key: 'x' }))),
    null,
    'record kind, null engine, additive key',
  );
});

test('validate: every schema defect is rejected with a reason', () => {
  const cases = [
    [null, 'is not a JSON object'],
    [[], 'is not a JSON object'],
    [{ schema: 2, requests: [] }, 'schema must be 1'],
    [{ schema: 1 }, 'requests must be an array'],
    [register('x'), 'requests[0] is not an object'],
    [register(entry(0)), 'requests[0].number must be a positive integer'],
    [register(entry('1')), 'requests[0].number must be a positive integer'],
    [register(entry(1.5)), 'requests[0].number must be a positive integer'],
    [register(entry(1, { kind: 'pr' })), 'requests[0].kind must be'],
    [register(entry(1, { spec: '' })), 'requests[0].spec must be'],
    [register(entry(1, { filed_by: undefined })), 'requests[0].filed_by must be'],
    [register(entry(1, { spec_commit: 7 })), 'requests[0].spec_commit must be'],
    [register(entry(1), entry(2, { filed_at: {} })), 'requests[1].filed_at must be'],
  ];
  for (const [doc, want] of cases) {
    const got = intake.validate(doc);
    assert(
      typeof got === 'string' && got.includes(want),
      `${JSON.stringify(doc)} → ${got} (want ${want})`,
    );
  }
});

test('parse: invalid JSON fails closed with a reason; valid text yields the requests', () => {
  const bad = intake.parse('{"schema":1,');
  assertEqual(bad.ok, false, 'not ok');
  assertEqual(bad.requests.length, 0, 'no requests');
  assert(/not valid JSON/.test(bad.reason), bad.reason);
  const good = intake.parse(JSON.stringify(register(entry(4))));
  assertEqual(good.ok, true);
  assertEqual(good.requests[0].number, 4);
});

// --- read: missing register is silent ---------------------------------------

test('missing register: the empty set, no warning (a git repo without one, and a non-git directory)', () => {
  const r = repo('none', undefined);
  const a = numbers(r.dir);
  assertEqual(a.list.length, 0, 'empty set');
  assertEqual(a.warns.length, 0, 'silent');
  const read = intake.read(r.dir);
  assertEqual(read.ok, true, 'a missing register is not an error');
  assertEqual(read.reason, null);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-intake-plain-'));
  const b = numbers(plain);
  assertEqual(b.list.length, 0, 'non-git dir: empty');
  assertEqual(b.warns.length, 0, 'non-git dir: silent');
});

// --- read: the committed register is the trust source -----------------------

test('committed register on origin/HEAD: its numbers, narrowed by kind', () => {
  const r = repo('ok', register(entry(1), entry(3), entry(7, { kind: 'record' })));
  const all = numbers(r.dir);
  assertEqual(all.list.join(','), '1,3,7', 'every number');
  assertEqual(all.warns.length, 0, 'no warning');
  assertEqual(numbers(r.dir, { kind: 'issue' }).list.join(','), '1,3', 'issue kind only');
  assertEqual(numbers(r.dir, { kind: 'record' }).list.join(','), '7', 'record kind only');
  assert(/^origin\/HEAD@[0-9a-f]{12}$/.test(intake.read(r.dir).source), 'source names the ref');
});

test('SECURITY: a working-tree edit to a committed register is NOT trusted — the committed copy wins', () => {
  const r = repo('dirty', register(entry(1)));
  writeRegister(r.dir, register(entry(1), entry(99))); // uncommitted edit
  const got = numbers(r.dir, { kind: 'issue' });
  assertEqual(got.list.join(','), '1', 'only the committed number; #99 is not trusted');
});

test('SECURITY: a register that exists ONLY in the working tree trusts nothing, with a warning', () => {
  const r = repo('wt-only', undefined);
  writeRegister(r.dir, register(entry(5)));
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'nothing trusted');
  assertEqual(got.warns.length, 1, 'one warning');
  assert(/not committed on the default branch/.test(got.warns[0]), got.warns[0]);
});

test('SECURITY: no origin/HEAD ⇒ nothing trusted (no fallback to a local branch or HEAD); a working-tree register warns', () => {
  const r = repo('no-head', register(entry(2)), { originHead: false });
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'nothing trusted even though main commits the register');
  assertEqual(got.warns.length, 1, 'the working-tree register is named');
  assert(/does not resolve/.test(got.warns[0]), got.warns[0]);
});

test('SECURITY: a checkout standing on a stage branch reads the DEFAULT branch register, not the branch one', () => {
  const r = repo('branch', register(entry(1)));
  r.git('checkout', '-q', '-b', 'feat/stage-3-x');
  writeRegister(r.dir, register(entry(1), entry(42)));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'branch-only register entry');
  const got = numbers(r.dir, { kind: 'issue' });
  assertEqual(got.list.join(','), '1', 'the stage branch entry #42 is not trusted');
});

// --- read: origin/HEAD must be a symref into refs/remotes/origin/ (review F2) --

// The reviewer's reproduction: a LOCAL unpushed commit carries a forged
// register, and origin/HEAD is re-pointed at the local branch. `rev-parse
// origin/HEAD` would follow it to the forged commit; the resolver must not.
test('SECURITY (F2): origin/HEAD symref pointing at a local branch trusts nothing — one warning, the forged entry is not trusted', () => {
  const r = repo('symref-local', register(entry(1)));
  writeRegister(r.dir, register(entry(1), entry(99))); // forged, committed locally, never pushed
  r.git('commit', '-q', '-am', 'forged register entry');
  fs.writeFileSync(
    path.join(r.dir, '.git', 'refs', 'remotes', 'origin', 'HEAD'),
    'ref: refs/heads/main\n',
  );
  assertEqual(
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD'),
    'refs/heads/main',
    'precondition: origin/HEAD is a symref to the local branch',
  );
  const got = numbers(r.dir, { kind: 'issue' });
  assertEqual(got.list.length, 0, `nothing trusted — not #99, not even #1 (got ${got.list})`);
  assertEqual(got.warns.length, 1, 'exactly one warning');
  assert(
    /points at refs\/heads\/main, outside refs\/remotes\/origin\//.test(got.warns[0]),
    got.warns[0],
  );
  assert(/no engine-registered request is trusted/.test(got.warns[0]), got.warns[0]);
  assertEqual(intake.read(r.dir).ok, false, 'read reports the failure');
});

test('SECURITY (F2): a NON-symbolic (detached) origin/HEAD trusts nothing — one warning when a register is at stake, silent when none is', () => {
  const r = repo('detached', register(entry(1)), { originHead: false });
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.git('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', 'HEAD');
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'nothing trusted');
  assertEqual(got.warns.length, 1, 'exactly one warning');
  assert(/is not a symbolic ref/.test(got.warns[0]), got.warns[0]);

  // No register at that commit and none in the working tree: nothing is at
  // stake, so a project without a register stays silent (byte-identical).
  const bare = repo('detached-none', undefined, { originHead: false });
  bare.git('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', 'HEAD');
  const none = numbers(bare.dir);
  assertEqual(none.list.length, 0, 'empty');
  assertEqual(none.warns.length, 0, 'silent without a register');
});

test('F2: a dangling origin/HEAD (symref into refs/remotes/origin/ whose target is gone) is the pre-F2 "does not resolve" case', () => {
  const r = repo('dangling', register(entry(1)), { originHead: false });
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'nothing trusted');
  assertEqual(got.warns.length, 1, 'the working-tree register is named');
  assert(/does not resolve/.test(got.warns[0]), got.warns[0]);
});

// Legitimate states are unaffected: the ones `git clone` and an explicit
// `git remote set-head` (verity init, benchmark provision, provisionBareOrigin)
// produce are symbolic and remote-namespaced.
test('F2: legitimate origin/HEAD states still trust the register — a real `git clone`, and `git remote set-head origin main`', () => {
  const src = repo('legit-src', register(entry(1), entry(3)), { originHead: false });
  const bareDir = `${src.dir}-origin.git`;
  execFileSync('git', ['clone', '-q', '--bare', src.dir, bareDir], { stdio: 'ignore' });

  const cloneDir = `${src.dir}-clone`;
  execFileSync('git', ['clone', '-q', bareDir, cloneDir], { stdio: 'ignore' });
  assertEqual(
    execFileSync('git', ['-C', cloneDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8',
    }).trim(),
    'refs/remotes/origin/main',
    'precondition: clone writes a symbolic origin/HEAD',
  );
  const cloned = numbers(cloneDir, { kind: 'issue' });
  assertEqual(cloned.list.join(','), '1,3', 'clone: trusted');
  assertEqual(cloned.warns.length, 0, 'clone: no warning');

  // The init/provision shape: remote added, fetched, then an explicit set-head.
  src.git('remote', 'add', 'origin', bareDir);
  src.git('fetch', '-q', 'origin');
  src.git('remote', 'set-head', 'origin', 'main');
  const setHead = numbers(src.dir, { kind: 'issue' });
  assertEqual(setHead.list.join(','), '1,3', 'set-head: trusted');
  assertEqual(setHead.warns.length, 0, 'set-head: no warning');
  for (const d of [bareDir, cloneDir]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- read: fail closed on a broken committed register ------------------------

test('fail closed: a committed register that is not JSON is the empty set with one warning', () => {
  const r = repo('badjson', '{"schema": 1, "requests": [');
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'nothing trusted');
  assertEqual(got.warns.length, 1, 'one warning');
  assert(/not valid JSON/.test(got.warns[0]), got.warns[0]);
  assert(/no engine-registered request is trusted/.test(got.warns[0]), got.warns[0]);
});

test('fail closed: one malformed entry voids the WHOLE committed register', () => {
  const r = repo('badentry', register(entry(1), entry(2, { kind: 'pr' })));
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0, 'not even the valid #1 is trusted');
  assertEqual(got.warns.length, 1);
  assert(/requests\[1\]\.kind/.test(got.warns[0]), got.warns[0]);
});

test('fail closed: a wrong schema version is rejected', () => {
  const r = repo('schema2', { schema: 2, requests: [entry(1)] });
  const got = numbers(r.dir);
  assertEqual(got.list.length, 0);
  assert(/schema must be 1/.test(got.warns[0]), got.warns[0]);
});
