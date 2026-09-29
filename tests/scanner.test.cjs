// T08 — scanner (SKETCH §4.2 ranked work selection).
//
// Fixture-driven: `exec` is injected through the shared gh layer (gh.cjs), so
// no real `gh`/network is touched; queries are routed on `<kind> <label>` and
// recorded so the frozen §4.2 command shapes can be asserted. P5 is driven by
// an injected `nextDecision` (the `verity next` module API seam).
const scanner = require('../verity/bin/lib/scanner.cjs');

// fixtures: map 'issue verity:approved' | 'pr verity:awaiting-review' | ... ->
// array of raw gh items. Unlisted queries return [].
function fakeGh(fixtures) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    const label = args[args.indexOf('--label') + 1];
    return JSON.stringify(fixtures[`${args[0]} ${label}`] || []);
  };
  return { exec, calls };
}

function scanWith(fixtures, opts = {}) {
  const { exec, calls } = fakeGh(fixtures);
  const result = scanner.scan({
    exec,
    nextDecision: opts.nextDecision || (() => ({ action: 'idle' })),
    ...opts,
  });
  return { result, calls };
}

const issue = (number, createdAt, extra = {}) => ({
  number,
  title: `issue ${number}`,
  createdAt,
  labels: [],
  ...extra,
});

test('P1 wins over all lower tiers; issues and PRs merge FIFO by createdAt', () => {
  const { result } = scanWith({
    'issue verity:approved': [issue(10, '2026-06-02T00:00:00Z')],
    'pr verity:approved': [issue(11, '2026-06-01T00:00:00Z')],
    'pr verity:awaiting-review': [issue(20, '2026-01-01T00:00:00Z')],
    'issue verity:ready': [issue(30, '2026-01-01T00:00:00Z')],
    'issue verity:request': [issue(40, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P1');
  assertEqual(result.kind, 'pr', 'older PR beats newer issue within P1');
  assertEqual(result.number, 11);
});

test('P2 wins when P1 empty; headRefName surfaces on the item', () => {
  const { result } = scanWith({
    'pr verity:awaiting-review': [
      issue(21, '2026-06-02T00:00:00Z', { headRefName: 'feat/b' }),
      issue(20, '2026-06-01T00:00:00Z', { headRefName: 'feat/a' }),
    ],
    'issue verity:ready': [issue(30, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P2');
  assertEqual(result.kind, 'pr');
  assertEqual(result.number, 20, 'FIFO: oldest first');
  assertEqual(result.headRefName, 'feat/a');
  assertEqual(result.title, 'issue 20');
});

test('P3 wins when P1-P2 empty', () => {
  const { result } = scanWith({
    'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')],
    'issue verity:request': [issue(40, '2026-01-01T00:00:00Z')],
  });
  assertEqual(result.tier, 'P3');
  assertEqual(result.kind, 'issue');
  assertEqual(result.number, 30);
});

test('P4 wins when P1-P3 empty; bot-authored requests are ignored', () => {
  const fixtures = {
    'issue verity:request': [
      issue(40, '2026-06-01T00:00:00Z', { author: { login: 'verity-bot' } }),
      issue(41, '2026-06-02T00:00:00Z', { author: { login: 'human' } }),
    ],
  };
  const { result } = scanWith(fixtures, { botLogin: 'verity-bot' });
  assertEqual(result.tier, 'P4');
  assertEqual(result.number, 41, 'older bot-authored item is skipped (no self-feeding)');
  assertEqual(result.author, 'human');
});

test('P4: only bot-authored requests -> tier is empty, falls through to P5/idle', () => {
  const { result } = scanWith(
    {
      'issue verity:request': [
        issue(40, '2026-06-01T00:00:00Z', { author: { login: 'Verity-Bot' } }),
      ],
    },
    { botLogin: 'verity-bot' }, // login match is case-insensitive
  );
  assertEqual(result, null);
});

test('verity:needs-human is excluded in every tier', () => {
  const nh = { labels: [{ name: 'Verity:Needs-Human' }] }; // case-insensitive
  const { result } = scanWith({
    'issue verity:approved': [issue(10, '2026-06-01T00:00:00Z', nh)],
    'pr verity:approved': [issue(11, '2026-06-01T00:00:00Z', nh)],
    'pr verity:awaiting-review': [issue(20, '2026-06-01T00:00:00Z', nh)],
    'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z', nh)],
    'issue verity:request': [
      issue(40, '2026-06-01T00:00:00Z', { ...nh, author: { login: 'human' } }),
    ],
  });
  assertEqual(result, null, 'all candidates carry needs-human -> idle');
});

test('locked items are skipped via the injected isLocked predicate', () => {
  const seen = [];
  const { result } = scanWith(
    {
      'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z'), issue(31, '2026-06-02T00:00:00Z')],
    },
    {
      isLocked: (item) => {
        seen.push(item);
        return item.number === 30;
      },
    },
  );
  assertEqual(result.number, 31, 'locked oldest is skipped, next-oldest selected');
  assert(
    seen.every((i) => i.kind === 'issue' && typeof i.number === 'number' && i.tier === 'P3'),
    'predicate receives normalized items (kind/number/tier present)',
  );
});

test('default lock predicate filters nothing (T10 wires the real one)', () => {
  const { exec } = fakeGh({ 'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')] });
  const result = scanner.scan({ exec, nextDecision: () => ({ action: 'idle' }) });
  assertEqual(result.number, 30);
});

test('whole tier locked -> falls through to the next tier', () => {
  const { result } = scanWith(
    {
      'issue verity:ready': [issue(30, '2026-06-01T00:00:00Z')],
      'issue verity:request': [issue(40, '2026-06-01T00:00:00Z', { author: { login: 'h' } })],
    },
    { isLocked: (item) => item.number === 30, botLogin: 'verity-bot' },
  );
  assertEqual(result.tier, 'P4');
  assertEqual(result.number, 40);
});

test('P5: next decision action=work is trusted and returned with the decision attached', () => {
  const decision = {
    schema: 1,
    action: 'work',
    role: 'build',
    args: ['3'],
    gate: null,
    target: { kind: 'pr', number: 12 },
    reason: 'PR #12 open',
  };
  const { result } = scanWith({}, { nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.kind, 'pr');
  assertEqual(result.number, 12);
  assertEqual(result.decision, decision);
});

test('P5: gated decision yields nothing (ship gated -> no sweep)', () => {
  const decision = {
    action: 'gated',
    gate: 'review:merge',
    target: { kind: 'pr', number: 12 },
  };
  const { result } = scanWith({}, { nextDecision: () => decision });
  assertEqual(result, null);
});

test('P5: locked engine item is skipped (idle, not selected)', () => {
  const decision = { action: 'work', target: { kind: 'issue', number: 9 } };
  const { result } = scanWith(
    {},
    { nextDecision: () => decision, isLocked: (item) => item.tier === 'P5' },
  );
  assertEqual(result, null);
});

test('all tiers empty and next idle -> null (idle)', () => {
  const { result, calls } = scanWith({});
  assertEqual(result, null);
  assertEqual(calls.length, 5, 'all five §4.2 queries were attempted');
});

test('first non-empty tier wins: lower-tier queries are not even issued', () => {
  const { calls } = scanWith({ 'issue verity:approved': [issue(10, '2026-06-01T00:00:00Z')] });
  assertEqual(calls.length, 2, 'P1 issue+pr queries only; P2-P4 never run');
});

test('gh commands match the frozen §4.2 contract (createdAt/labels additions noted)', () => {
  const { calls } = scanWith({});
  assertEqual(
    calls.join('\n'),
    [
      'issue list --label verity:approved --state open --json number,labels,title,createdAt',
      'pr list --label verity:approved --state open --json number,labels,title,createdAt',
      'pr list --label verity:awaiting-review --state open --json number,headRefName,title,labels,createdAt',
      'issue list --label verity:ready --state open --json number,title,labels,createdAt',
      'issue list --label verity:request --state open --json number,title,author,labels,createdAt',
    ].join('\n'),
  );
});

test('FIFO tie-break: equal createdAt sorts by number; missing createdAt sorts last', () => {
  const t = '2026-06-01T00:00:00Z';
  const sorted = [
    { number: 5, createdAt: null },
    { number: 3, createdAt: t },
    { number: 2, createdAt: t },
  ].sort(scanner.byCreatedAt);
  assertEqual(sorted.map((i) => i.number).join(','), '2,3,5');
});

// --- P5 needs-human enforcement (#4, stage 5) ---------------------------------
// The dependency-engine fallback carries no labels, so scan() fetches the P5
// target's labels and drops escalated items — failing CLOSED on fetch errors.

// exec stub that answers list queries from fixtures (like fakeGh) AND `view`
// calls for the P5 label fetch. viewLabels: array of names, or 'THROW'.
function fakeGhWithView(fixtures, viewLabels) {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'view') {
      if (viewLabels === 'THROW') {
        // Same convention as tests/gh.test.cjs: a FAILING exec THROWS an
        // error object carrying status/stderr — so this exercises gh.run's
        // real error path (classify -> GhError), not an accidental parse error.
        const err = new Error('gh: boom');
        err.status = 1;
        err.stderr = 'boom';
        throw err;
      }
      return JSON.stringify({ labels: viewLabels.map((name) => ({ name })) });
    }
    const label = args[args.indexOf('--label') + 1];
    return JSON.stringify(fixtures[`${args[0]} ${label}`] || []);
  };
  return { exec, calls };
}

const workDecision = () => ({
  action: 'work',
  role: 'build',
  target: { kind: 'issue', number: 9 },
});

test('P5 regression (#4): target labeled verity:needs-human is dropped -> idle', () => {
  const { exec } = fakeGhWithView({}, ['verity:ready', 'verity:needs-human']);
  const result = scanner.scan({ exec, nextDecision: workDecision });
  assertEqual(result, null);
});

test('P5: fetched labels are carried on the returned item (no more hardcoded [])', () => {
  const { exec, calls } = fakeGhWithView({}, ['verity:ready']);
  const result = scanner.scan({ exec, nextDecision: workDecision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.labels.join(','), 'verity:ready');
  assertEqual(
    calls.filter((c) => c.startsWith('issue view 9 --json labels')).length,
    1,
    'labels come from exactly one issue view call',
  );
});

test('P5: label fetch failure fails closed -> idle, no throw, with a warn', () => {
  const { exec } = fakeGhWithView({}, 'THROW');
  const warns = [];
  const result = scanner.scan({
    exec,
    nextDecision: workDecision,
    log: (line) => warns.push(line),
    retries: 0,
  });
  assertEqual(result, null);
  assertEqual(
    warns.some((w) => w.includes('P5 label fetch failed for issue #9')),
    true,
    'fail-closed is never silent',
  );
});

test('P5: stage-kind target skips the label fetch entirely (stage number is not an issue number)', () => {
  const { exec, calls } = fakeGhWithView({}, 'THROW'); // any view call would throw
  const decision = { action: 'work', role: 'build', target: { kind: 'stage', number: 3 } };
  const result = scanner.scan({ exec, nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(result.labels.join(','), '');
  assertEqual(
    calls.some((c) => c.split(' ')[1] === 'view'),
    false,
    'no gh view call for stage targets',
  );
});

test('P5: pr target uses pr view for the label fetch', () => {
  const { exec, calls } = fakeGhWithView({}, []);
  const decision = { action: 'work', role: 'review', target: { kind: 'pr', number: 4 } };
  const result = scanner.scan({ exec, nextDecision: () => decision });
  assertEqual(result.tier, 'P5');
  assertEqual(
    calls.some((c) => c.startsWith('pr view 4 --json labels')),
    true,
  );
});

// ---------------------------------------------------------------------------
// Stage 114 (ADR-0038 D2): P4 register trust. A self-authored request is kept
// iff its number is in the intake register COMMITTED on the default branch
// (origin/HEAD) of opts.cwd. Real git fixture; gh stays the injected stub.
// ---------------------------------------------------------------------------

const fs114 = require('node:fs');
const os114 = require('node:os');
const path114 = require('node:path');
const { execFileSync: exec114 } = require('node:child_process');

// A repo with origin/HEAD → main; `committed` is the register main carries
// (object or raw text; undefined = none).
function registerRepo(committed) {
  const dir = fs114.mkdtempSync(path114.join(os114.tmpdir(), 'verity-scanner-intake-'));
  const git = (...args) =>
    exec114(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Scanner Test',
        '-c',
        'user.email=scanner@verity.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init', '-q', '-b', 'main');
  fs114.writeFileSync(path114.join(dir, 'README.md'), '# x\n');
  if (committed !== undefined) {
    writeRegisterFile(dir, committed);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return dir;
}

function writeRegisterFile(dir, doc) {
  fs114.mkdirSync(path114.join(dir, '.verity'), { recursive: true });
  fs114.writeFileSync(
    path114.join(dir, '.verity', 'intake.json'),
    typeof doc === 'string' ? doc : JSON.stringify(doc),
  );
}

const reg = (...numbers) => ({
  schema: 1,
  requests: numbers.map((number) => ({
    number,
    kind: 'issue',
    spec: 'docs/spec.md',
    spec_commit: 'abc1234',
    filed_by: 'verity init',
    engine: '1.8.0',
    filed_at: '2026-09-29T18:00:00Z',
  })),
});
const botReq = (number, createdAt) => issue(number, createdAt, { author: { login: 'verity-bot' } });

function scanRegister(cwd, requests) {
  const warns = [];
  const { result } = scanWith(
    { 'issue verity:request': requests },
    { cwd, botLogin: 'verity-bot', warn: (m) => warns.push(m) },
  );
  return { result, warns };
}

test('stage 114: a bot-authored request whose number the committed register lists is SELECTED', () => {
  const cwd = registerRepo(reg(1));
  const { result, warns } = scanRegister(cwd, [botReq(1, '2026-06-01T00:00:00Z')]);
  assertEqual(result?.tier, 'P4', 'P4 selection');
  assertEqual(result.number, 1, 'the registered request');
  assertEqual(warns.length, 1, 'one note');
  assertEqual(
    warns[0],
    'skipped 0 self-authored request(s), accepted 1 engine-registered (see docs/autonomy.md)',
  );
});

test('stage 114: a bot-authored request NOT in the register is still dropped, with the stage-28 note', () => {
  const cwd = registerRepo(reg(1));
  const { result, warns } = scanRegister(cwd, [botReq(2, '2026-06-01T00:00:00Z')]);
  assertEqual(result, null, 'dropped → idle');
  assertEqual(warns.length, 1);
  assertEqual(
    warns[0],
    'skipped 1 self-authored request(s) (no self-feeding; see docs/autonomy.md)',
    'byte-identical stage-28 note when nothing was accepted',
  );
});

test('stage 114: registered and unregistered together ⇒ the note carries BOTH counts; FIFO among the kept', () => {
  const cwd = registerRepo(reg(3));
  const { result, warns } = scanRegister(cwd, [
    botReq(2, '2026-06-01T00:00:00Z'), // unregistered, older
    botReq(3, '2026-06-02T00:00:00Z'), // registered
    issue(4, '2026-06-03T00:00:00Z', { author: { login: 'human' } }),
  ]);
  assertEqual(result.number, 3, 'oldest KEPT item (the unregistered #2 is gone)');
  assertEqual(
    warns[0],
    'skipped 1 self-authored request(s), accepted 1 engine-registered (see docs/autonomy.md)',
  );
});

test('stage 114: a malformed committed register trusts nothing — dropped, plus one warning', () => {
  const cwd = registerRepo('{"schema":1,"requests":[{"number":1}]}');
  const { result, warns } = scanRegister(cwd, [botReq(1, '2026-06-01T00:00:00Z')]);
  assertEqual(result, null, 'fail closed');
  assertEqual(warns.length, 2, 'the register warning, then the skip note');
  assert(
    /intake register \.verity\/intake\.json .*no engine-registered request is trusted/.test(
      warns[0],
    ),
    warns[0],
  );
  assert(warns[1].startsWith('skipped 1 self-authored request(s) (no self-feeding'), warns[1]);
});

test('stage 114: a human-authored request is unaffected by the register (and no register read happens)', () => {
  const cwd = registerRepo('not json at all'); // would warn if it were read
  const { result, warns } = scanRegister(cwd, [
    issue(9, '2026-06-01T00:00:00Z', { author: { login: 'human' } }),
  ]);
  assertEqual(result.number, 9, 'selected exactly as before');
  assertEqual(warns.length, 0, 'the register is only read when a self-authored request exists');
});

test('stage 114 SECURITY: an UNCOMMITTED working-tree register entry does not make a bot request eligible', () => {
  const cwd = registerRepo(reg(1));
  writeRegisterFile(cwd, reg(1, 5)); // a role's file write, never committed
  const { result, warns } = scanRegister(cwd, [botReq(5, '2026-06-01T00:00:00Z')]);
  assertEqual(result, null, '#5 is listed only in the working tree — not trusted');
  assert(warns[0].startsWith('skipped 1 self-authored request(s) (no self-feeding'), warns[0]);
});

test('stage 114: a record-kind register entry never trusts a GitHub issue of the same number', () => {
  const doc = reg(1);
  doc.requests[0].kind = 'record';
  const cwd = registerRepo(doc);
  const { result } = scanRegister(cwd, [botReq(1, '2026-06-01T00:00:00Z')]);
  assertEqual(result, null, 'local record #1 and GitHub issue #1 share no namespace');
});

test('stage 114: a needs-human registered request stays dropped; a locked one is skipped', () => {
  const cwd = registerRepo(reg(1, 2));
  const nh = botReq(1, '2026-06-01T00:00:00Z');
  nh.labels = [{ name: 'verity:needs-human' }];
  const { result } = scanWith(
    { 'issue verity:request': [nh, botReq(2, '2026-06-02T00:00:00Z')] },
    { cwd, botLogin: 'verity-bot', isLocked: (it) => it.number === 2 },
  );
  assertEqual(result, null, 'needs-human and lock filters still apply to register-kept items');
});
