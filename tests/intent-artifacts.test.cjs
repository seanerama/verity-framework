// Stage 96 (ADR-0033, #189) — the ENGINE commits the intent artifacts a
// git_write:false role wrote, after the role returns.
//
// Hermetic: REAL git in mkdtemp repos with a sibling bare origin (the ADR-0029
// local-substrate provision, exactly as tests/substrate-local-git.test.cjs does),
// a claude agent stub (VERITY_AGENT_BIN) / codex actor stub (VERITY_CODEX_BIN)
// that write files the way a plan/revisit role would, and NO network, NO gh on
// any asserted path. Most cases drive the REAL CLI (`verity agent-exec …
// --commit-intent-artifacts`) so the wrapper inside dispatch runs its true code
// path; the call-order case runs dispatch in-process with recording stubs, as
// tests/work-item-reconcile-observability.test.cjs does for the reconcile.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const intentArtifacts = require('../verity/bin/lib/agents/intent-artifacts.cjs');
const autonomy = require('../verity/bin/lib/autonomy.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');
const usage = require('../verity/bin/lib/usage.cjs');
const workItems = require('../verity/bin/lib/work-items.cjs');
const worker = require('../verity/worker/index.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;
const STUB_CONFIG = '.ia-stub.json';

// A claude stand-in configured through `.ia-stub.json` in its cwd (the real
// checkout — tier 1): writes/removes the listed paths like a role would, then
// reports success, or a `failed` marker, or sleeps past the deadline.
const CLAUDE_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
const cwd = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '${STUB_CONFIG}'), 'utf8'));
for (const w of cfg.writes || []) {
  fs.mkdirSync(path.dirname(path.join(cwd, w.path)), { recursive: true });
  fs.writeFileSync(path.join(cwd, w.path), w.text === undefined ? 'written by the role\\n' : w.text);
}
for (const r of cfg.removes || []) {
  fs.rmSync(path.join(cwd, r), { force: true });
}
const marker = JSON.stringify({ verity: 1, outcome: 'failed', gate: null, artifacts: {}, reason: 'gh issue create denied under containment' });
const emit = () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, num_turns: 1,
    result: cfg.outcome === 'failed' ? 'Planned, but could not register.\\n' + marker : 'Planned.',
    session_id: 's-1', total_cost_usd: 0.5,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) + '\\n');
};
if (cfg.sleepMs) { setTimeout(emit, cfg.sleepMs); } else { emit(); }
`;

// The codex stand-in (the tests/enforcement.test.cjs actor, trimmed): same
// `.ia-stub.json` script, run under the codex driver's real hooks —
// captureInvariants/checkInvariants and the ADR-0012 git plan (null here: the
// plan role is git_write:false).
const CODEX_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli ${MIN_CODEX}\\n'); process.exit(0); }
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const flag = (n) => args[args.indexOf(n) + 1];
const cwd = flag('--cd');
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '${STUB_CONFIG}'), 'utf8'));
fs.readFileSync(0, 'utf8'); // consume the prompt
for (const w of cfg.writes || []) {
  fs.mkdirSync(path.dirname(path.join(cwd, w.path)), { recursive: true });
  fs.writeFileSync(path.join(cwd, w.path), w.text === undefined ? 'written by the role\\n' : w.text);
}
const marker = 'Done.\\n{"verity":1,"outcome":"success","gate":null,"artifacts":{},"reason":"ok"}';
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: marker } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A deterministic fixture: repo on `main` with one tracked stage file (so a
// deletion under a root is observable), a sibling BARE origin provisioned the
// ADR-0029 way (origin/HEAD set-head), an isolated $HOME, and both stubs.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-intent-artifacts-'));
  const dir = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@verity.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  fs.mkdirSync(path.join(dir, 'stage-instructions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', 'old.md'),
    '# Stage 1: Old\n\n- **Type:** feature\n- **Depends on:** none\n',
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  const { barePath } = sub.provisionBareOrigin(dir);
  const claudeStub = path.join(root, 'claude-stub');
  fs.writeFileSync(claudeStub, CLAUDE_STUB);
  fs.chmodSync(claudeStub, 0o755);
  const codexStub = path.join(root, 'codex-stub');
  fs.writeFileSync(codexStub, CODEX_STUB);
  fs.chmodSync(codexStub, 0o755);
  return { root, dir, home, barePath, claudeStub, codexStub };
}

function script(fx, cfg) {
  fs.writeFileSync(path.join(fx.dir, STUB_CONFIG), JSON.stringify(cfg));
}

// One REAL CLI run of `verity agent-exec <role> …` against the claude stub.
function runCli(fx, role, extraArgs = [], runId = 'ia-1') {
  const res = spawnSync('node', [CLI, 'agent-exec', role, '1', '--run-id', runId, ...extraArgs], {
    cwd: fx.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      VERITY_AGENT_BIN: fx.claudeStub,
      VERITY_CLAUDE_BIN: '',
      VERITY_CODEX_BIN: '',
    },
  });
  const out = String(res.stdout || '').trim();
  return { code: res.status, stderr: res.stderr || '', obj: out === '' ? null : JSON.parse(out) };
}

const head = (cwd) => git(cwd, 'rev-parse', 'HEAD').trim();
const dirty = (cwd, ...roots) => git(cwd, 'status', '--porcelain', '--', ...roots).trim();
const originTree = (fx) =>
  git(fx.barePath, 'ls-tree', '--name-only', '-r', 'main').trim().split('\n');
const originHead = (fx) => git(fx.barePath, 'rev-parse', 'main').trim();

const PLAN_WRITES = [
  {
    path: 'stage-instructions/stage-7-x.md',
    text: '# Stage 7: X\n\n- **Type:** feature\n- **Depends on:** none\n',
  },
  { path: 'feature-assessments/x-assessment.md', text: '# X assessment\n' },
];

// --- 1. the #189 regression -----------------------------------------------------

test("regression (#189): flag ON — a plan run's stage spec + assessment are committed on the default branch and land in the origin", () => {
  const fx = fixture();
  const before = head(fx.dir);
  script(fx, { writes: PLAN_WRITES });
  const { code, obj, stderr } = runCli(fx, 'plan', ['--commit-intent-artifacts']);

  assertEqual(code, 0, `plan run exits 0 (stderr: ${stderr})`);
  assertEqual(obj.outcome, 'success', 'the role outcome is untouched');
  const ia = obj.intent_artifacts;
  assert(ia !== undefined, 'the result carries the additive intent_artifacts field');
  assertEqual(ia.outcome, 'committed', 'the engine committed');
  assertEqual(ia.pushed, true, 'and pushed');
  assertEqual(ia.branch, 'main', 'onto the default branch');
  assertEqual(ia.sha, head(fx.dir), 'the reported sha IS the new HEAD');
  assert(ia.sha !== before, 'HEAD moved');
  assertEqual(
    JSON.stringify(ia.files),
    JSON.stringify(['feature-assessments/x-assessment.md', 'stage-instructions/stage-7-x.md']),
    'exactly the two role-written files, named on the result',
  );
  assertEqual(
    dirty(fx.dir, 'stage-instructions', 'feature-assessments'),
    '',
    'nothing under the roots is left dirty',
  );
  assertEqual(originHead(fx), ia.sha, "the bare origin's main advanced to the commit");
  const tree = originTree(fx);
  assert(tree.includes('stage-instructions/stage-7-x.md'), 'the spec is in the origin');
  assert(tree.includes('feature-assessments/x-assessment.md'), 'the assessment is in the origin');
  assertEqual(
    git(fx.dir, 'log', '-1', '--format=%an <%ae>').trim(),
    `${usage.COMMIT_AUTHOR_NAME} <${usage.COMMIT_AUTHOR_EMAIL}>`,
    'authored by the stage-38 bot identity, not the operator',
  );
  assertEqual(
    git(fx.dir, 'log', '-1', '--format=%s').trim(),
    'plan: intent artifacts — 2 file(s)',
    'the deterministic subject',
  );
  const body = git(fx.dir, 'log', '-1', '--format=%b');
  assert(body.includes('stage-instructions/stage-7-x.md'), 'the body lists the paths');
  assert(body.includes('ADR-0033'), 'and names the decision');
  assert(
    !stderr.includes('intent-artifacts-'),
    `no failure line on a clean commit + push (stderr: ${stderr})`,
  );
  // The stub's own config file sits OUTSIDE the roots — never swept in.
  assert(!tree.includes(STUB_CONFIG), 'a stray file outside the roots is never committed');
});

// --- 2. kill switch --------------------------------------------------------------

test('kill switch: flag OFF — tree left dirty, no commit, no intent_artifacts key (byte-identical)', () => {
  const fx = fixture();
  const before = head(fx.dir);
  script(fx, { writes: PLAN_WRITES });
  const { code, obj } = runCli(fx, 'plan');

  assertEqual(code, 0);
  assertEqual(obj.outcome, 'success');
  assert(!('intent_artifacts' in obj), 'no key at all — the OFF path is byte-identical');
  assertEqual(head(fx.dir), before, 'HEAD did not move');
  assertEqual(originHead(fx), before, 'the origin did not move');
  assert(
    dirty(fx.dir, 'stage-instructions', 'feature-assessments').includes('?? stage-instructions/'),
    'the spec is still untracked — the #189 state, preserved when OFF',
  );
});

// --- 3. idempotent -----------------------------------------------------------------

test('idempotent: a second run with nothing new ⇒ noop, no empty commit', () => {
  const fx = fixture();
  script(fx, { writes: PLAN_WRITES });
  const first = runCli(fx, 'plan', ['--commit-intent-artifacts'], 'ia-first');
  assertEqual(first.obj.intent_artifacts.outcome, 'committed');
  const sha = head(fx.dir);
  const count = git(fx.dir, 'rev-list', '--count', 'HEAD').trim();

  // The stub rewrites the same bytes: nothing changes under the roots.
  const second = runCli(fx, 'plan', ['--commit-intent-artifacts'], 'ia-second');
  assertEqual(second.code, 0);
  assertEqual(second.obj.intent_artifacts.outcome, 'noop', 'nothing new ⇒ noop');
  assert(!('sha' in second.obj.intent_artifacts), 'a noop carries no sha');
  assertEqual(head(fx.dir), sha, 'HEAD unchanged');
  assertEqual(git(fx.dir, 'rev-list', '--count', 'HEAD').trim(), count, 'no empty commit');

  // Same at the module level, twice in a row.
  const direct = intentArtifacts.commitIntentArtifacts({
    cwd: fx.dir,
    role: 'plan',
    substrate: 'local',
  });
  assertEqual(direct.outcome, 'noop', 'direct call on a clean tree is a noop');
  assertEqual(head(fx.dir), sha);
});

// --- 4. additive by pathspec -------------------------------------------------------

test('additive by pathspec: a stray src/x.js and a deleted stage-instructions/old.md are NOT staged', () => {
  const fx = fixture();
  script(fx, {
    writes: [
      { path: 'src/x.js', text: 'module.exports = 1;\n' },
      { path: 'stage-instructions/stage-8-y.md', text: '# Stage 8: Y\n' },
    ],
    removes: ['stage-instructions/old.md'],
  });
  const { code, obj } = runCli(fx, 'plan', ['--commit-intent-artifacts']);

  assertEqual(code, 0);
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'committed');
  assertEqual(
    JSON.stringify(ia.files),
    JSON.stringify(['stage-instructions/stage-8-y.md']),
    'only the addition under a root is taken',
  );
  const tracked = git(fx.dir, 'ls-tree', '--name-only', '-r', 'HEAD').trim().split('\n');
  assert(
    tracked.includes('stage-instructions/old.md'),
    'the deletion was NOT committed (still in HEAD)',
  );
  assert(!tracked.includes('src/x.js'), 'the stray file outside the roots was NOT committed');
  const status = git(fx.dir, 'status', '--porcelain'); // untrimmed: the XY columns matter
  assert(
    /^ D stage-instructions\/old\.md$/m.test(status),
    'the deletion is left unstaged in the tree',
  );
  assert(
    status.includes('?? src/'),
    'the stray file is left untracked (a new dir reports as `src/`)',
  );
  assert(!originTree(fx).includes('src/x.js'), 'and never reached the origin');
});

// Review B1: git QUOTES a path with a non-ASCII byte, a quote, a backslash or a
// tab in non-`-z` porcelain output, so a newline parse saw
// `"stage-instructions/stage-1-\303\274..."`, matched no root, staged nothing
// by pathspec, and then read `git diff --cached` REPO-WIDE — committing every
// stray staged file while the real spec stayed untracked. NUL parsing + the
// empty-activeRoots guard close both halves.
const QUOTED_SPEC = 'stage-instructions/stage-1-ünïcode "quoted".md';
// The paths HEAD's commit touched, read NUL-separated (a `"` in a name forces
// quoting even under core.quotePath=false, so `-z` is the only honest read).
const shownInHead = (fx) =>
  git(fx.dir, 'show', '--name-only', '-z', '--format=', 'HEAD')
    .split('\0')
    .filter((p) => p !== '');

test('quoted filenames (B1a): a spec git would quote in porcelain output is committed — and only it', () => {
  const fx = fixture();
  script(fx, {
    writes: [
      { path: QUOTED_SPEC, text: '# Stage 1: ünïcode\n' },
      { path: 'src/stray.js', text: 'x\n' },
    ],
  });
  const { code, obj, stderr } = runCli(fx, 'plan', ['--commit-intent-artifacts']);
  assertEqual(code, 0, `run exits 0 (stderr: ${stderr})`);
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'committed', `the quoted-name spec is committed (${JSON.stringify(ia)})`);
  assertEqual(JSON.stringify(ia.files), JSON.stringify([QUOTED_SPEC]), 'exactly that one file');
  assertEqual(
    JSON.stringify(shownInHead(fx)),
    JSON.stringify([QUOTED_SPEC]),
    'HEAD contains only the spec',
  );
  assertEqual(dirty(fx.dir, 'stage-instructions'), '', 'nothing under the root left dirty');
  assert(dirty(fx.dir).includes('?? src/'), 'the stray file stays untracked');
});

test('quoted filenames (B1b): a PRE-STAGED out-of-root file is NEVER committed alongside a quoted-name spec', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fx.dir, 'src', 'secret.js'), 'const token = "x";\n');
  git(fx.dir, 'add', '--', 'src/secret.js'); // staged by the operator before the run
  const before = head(fx.dir);
  script(fx, { writes: [{ path: QUOTED_SPEC, text: '# Stage 1: ünïcode\n' }] });
  const { code, obj } = runCli(fx, 'plan', ['--commit-intent-artifacts']);
  assertEqual(code, 0);
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'committed');
  assertEqual(JSON.stringify(ia.files), JSON.stringify([QUOTED_SPEC]));
  assert(ia.sha !== before, 'a commit happened');
  const shown = shownInHead(fx);
  assert(!shown.includes('src/secret.js'), `the pre-staged secret is NOT in HEAD (${shown})`);
  assert(shown.includes(QUOTED_SPEC), 'the spec is');
  assert(!originTree(fx).includes('src/secret.js'), 'and never reached the origin');
  assert(
    /^A {2}src\/secret\.js$/m.test(git(fx.dir, 'status', '--porcelain')),
    'src/secret.js stays STAGED and uncommitted, exactly as the operator left it',
  );
});

// Review B2: intent artifacts belong on the default branch. A checkout parked
// on any other branch is refused BEFORE staging — never pushed to that branch.
test('default-branch guard (B2): on feat/x nothing is committed and the result says so', () => {
  const fx = fixture();
  git(fx.dir, 'checkout', '-q', '-b', 'feat/x');
  const before = head(fx.dir);
  script(fx, { writes: PLAN_WRITES });
  const { code, obj, stderr } = runCli(fx, 'plan', ['--commit-intent-artifacts']);
  assertEqual(code, 0, 'non-fatal: the run exits on its own outcome');
  assertEqual(obj.outcome, 'success', 'the role outcome is unchanged');
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'failed');
  assertEqual(
    ia.error,
    'not on default branch main (on feat/x) — refusing to commit intent artifacts',
    'names both branches',
  );
  assert(stderr.includes('verity-agent-exec: intent-artifacts-commit-failed:'), 'one loud line');
  assertEqual(head(fx.dir), before, 'HEAD did not move');
  assertEqual(originHead(fx), before, 'the origin did not move');
  assert(dirty(fx.dir, 'stage-instructions').includes('??'), 'nothing was staged');
  // Direct call, same answer — and the resolver reads origin/HEAD (the
  // ADR-0029 provision sets it), which is exactly what the regression test on
  // `main` relies on.
  assertEqual(sub.defaultBranchRef(fx.dir), 'origin/main', 'origin/HEAD resolves the default');
  const direct = intentArtifacts.commitIntentArtifacts({
    cwd: fx.dir,
    role: 'plan',
    substrate: 'local',
  });
  assertEqual(direct.outcome, 'failed');
  assert(/not on default branch main/.test(direct.error));
});

// --- 5. push failure is loud, not fatal ------------------------------------------

test('push failure: unreachable origin ⇒ local commit exists, pushed:false, ONE intent-artifacts-push-failed line, run outcome unchanged', () => {
  const fx = fixture();
  const before = head(fx.dir);
  git(fx.dir, 'remote', 'set-url', 'origin', path.join(fx.root, 'no-such-origin.git'));
  script(fx, { writes: PLAN_WRITES });
  const { code, obj, stderr } = runCli(fx, 'plan', ['--commit-intent-artifacts']);

  assertEqual(code, 0, `non-fatal: the run still exits on its own outcome (stderr: ${stderr})`);
  assertEqual(obj.outcome, 'success', 'the role outcome is unchanged');
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'committed', 'the commit happened');
  assertEqual(ia.pushed, false, 'the push did not');
  assert(typeof ia.error === 'string' && ia.error.includes('git push'), 'the error names the push');
  assert(ia.sha !== before && ia.sha === head(fx.dir), 'the commit stays local');
  assertEqual(originHead(fx), before, 'the real bare origin never moved');
  const lines = stderr.split('\n').filter((l) => l.includes('intent-artifacts-push-failed'));
  assertEqual(lines.length, 1, `exactly one push-failed stderr line (stderr: ${stderr})`);
  assert(
    lines[0].startsWith('verity-agent-exec: intent-artifacts-push-failed:'),
    'in the §8.2 style',
  );
  assert(!stderr.includes('intent-artifacts-commit-failed'), 'and no commit-failed line');
});

test('commit failure is returned, never thrown: a detached HEAD refuses to commit', () => {
  const fx = fixture();
  git(fx.dir, 'checkout', '-q', '--detach');
  fs.mkdirSync(path.join(fx.dir, 'docs', 'revisit'), { recursive: true });
  fs.writeFileSync(path.join(fx.dir, 'docs', 'revisit', '2026-09-22-revisit.md'), '# r\n');
  const res = intentArtifacts.commitIntentArtifacts({
    cwd: fx.dir,
    role: 'revisit',
    substrate: 'local',
  });
  assertEqual(res.outcome, 'failed');
  assert(/detached/.test(res.error), `names the cause (${res.error})`);
  assert(dirty(fx.dir, 'docs/revisit').includes('??'), 'nothing was staged');
});

// --- 6. role table ------------------------------------------------------------------

test('role table: pinned by exact equality', () => {
  assertEqual(
    JSON.stringify(intentArtifacts.ROLE_ROOTS),
    JSON.stringify({
      plan: ['stage-instructions/', 'contracts/', 'feature-assessments/', 'docs/adr/'],
      revisit: ['docs/revisit/'],
    }),
    'the engine-owned role→roots table (ADR-0033 §1)',
  );
  assert(
    Object.isFrozen(intentArtifacts.ROLE_ROOTS),
    'frozen — amended by editing this file, never at runtime',
  );
});

test('role table: a role outside the table ⇒ skipped: role-not-tabled, with no git side effect', () => {
  const fx = fixture();
  script(fx, { writes: PLAN_WRITES }); // dirt that would commit for plan
  fs.writeFileSync(path.join(fx.dir, 'stage-instructions', 'stage-7-x.md'), '# 7\n');
  const before = head(fx.dir);
  for (const role of ['build', 'review', 'architect', 'security', 'sre', 'no-such-role']) {
    const res = intentArtifacts.commitIntentArtifacts({ cwd: fx.dir, role, substrate: 'local' });
    assertEqual(
      JSON.stringify(res),
      JSON.stringify({ outcome: 'skipped', reason: 'role-not-tabled' }),
      role,
    );
  }
  assertEqual(head(fx.dir), before, 'nothing committed');
  assert(dirty(fx.dir, 'stage-instructions').includes('??'), 'nothing staged');
});

test('role table: revisit commits ONLY docs/revisit/ — a stage file it also left behind stays untracked', () => {
  const fx = fixture();
  script(fx, {
    writes: [
      { path: 'docs/revisit/2026-09-22-revisit.md', text: '# Revisit\n' },
      { path: 'stage-instructions/stage-9-z.md', text: '# Stage 9: Z\n' },
    ],
  });
  const { code, obj, stderr } = runCli(fx, 'revisit', ['--commit-intent-artifacts']);

  assertEqual(code, 0, `revisit run exits 0 (stderr: ${stderr})`);
  const ia = obj.intent_artifacts;
  assertEqual(ia.outcome, 'committed');
  assertEqual(JSON.stringify(ia.files), JSON.stringify(['docs/revisit/2026-09-22-revisit.md']));
  assertEqual(
    git(fx.dir, 'log', '-1', '--format=%s').trim(),
    'revisit: 2026-09-22-revisit.md',
    'the revisit subject names the report',
  );
  assert(
    dirty(fx.dir, 'stage-instructions').includes('?? stage-instructions/stage-9-z.md'),
    "not revisit's root — untouched",
  );
  assert(
    originTree(fx).includes('docs/revisit/2026-09-22-revisit.md'),
    'the report reached the origin',
  );
  assert(!originTree(fx).includes('stage-instructions/stage-9-z.md'));
});

test('a build-role dispatch with the flag ON is untouched (no intent_artifacts key)', () => {
  // The wrapper keys on the table, not just the flag: no other run path changes.
  const fx = fixture();
  script(fx, { writes: [] });
  const { obj } = runCli(fx, 'build', ['--commit-intent-artifacts']);
  assert(obj !== null && !('intent_artifacts' in obj), 'build never gains the field');
});

// --- 7. ordering: after enforced(), before withWorkItems ---------------------------

test('ordering: under the codex hooks the engine commit runs AFTER checkInvariants (no refViolations) and BEFORE reconcileWorkItems (which sees a tracked file)', () => {
  const fx = fixture();
  script(fx, { writes: PLAN_WRITES });
  const order = [];
  let reconcileSawTracked = null;
  const origCheck = codex.checkInvariants;
  const origCommit = intentArtifacts.commitIntentArtifacts;
  const origReconcile = workItems.reconcileWorkItems;
  const origHome = process.env.HOME;
  const origCodexBin = process.env.VERITY_CODEX_BIN;
  codex.checkInvariants = (before, policyBag) => {
    order.push('checkInvariants');
    return origCheck(before, policyBag);
  };
  intentArtifacts.commitIntentArtifacts = (opts) => {
    order.push('commitIntentArtifacts');
    return origCommit(opts);
  };
  workItems.reconcileWorkItems = (cwd) => {
    order.push('reconcileWorkItems');
    // "Reconcile sees tracked files": is the spec in HEAD by the time it runs?
    reconcileSawTracked = git(cwd, 'ls-tree', '--name-only', '-r', 'HEAD').includes(
      'stage-instructions/stage-7-x.md',
    );
    return { enabled: true, created: [], skipped: [] }; // no gh, ever
  };
  process.env.HOME = fx.home;
  process.env.VERITY_CODEX_BIN = fx.codexStub;
  let res;
  try {
    res = agentExec.dispatch(['plan', '1'], {
      cwd: fx.dir,
      'run-id': 'ia-order',
      agent: 'codex',
      'acknowledge-gaps': 'network',
      'commit-intent-artifacts': true,
      'reconcile-work-items': true,
    });
  } finally {
    codex.checkInvariants = origCheck;
    intentArtifacts.commitIntentArtifacts = origCommit;
    workItems.reconcileWorkItems = origReconcile;
    process.env.HOME = origHome;
    if (origCodexBin === undefined) {
      Reflect.deleteProperty(process.env, 'VERITY_CODEX_BIN');
    } else {
      process.env.VERITY_CODEX_BIN = origCodexBin;
    }
  }
  assertEqual(
    JSON.stringify(order),
    JSON.stringify(['checkInvariants', 'commitIntentArtifacts', 'reconcileWorkItems']),
    'verdict → engine commit → reconcile',
  );
  assertEqual(
    res.outcome,
    'success',
    `the engine's own ref movement is not a violation (${res.error})`,
  );
  assert(!('enforcement_violations' in res), 'no refViolations raised for the post-verdict commit');
  assertEqual(res.intent_artifacts.outcome, 'committed');
  assertEqual(res.intent_artifacts.sha, head(fx.dir));
  assertEqual(reconcileSawTracked, true, 'the reconcile ran against a TRACKED spec');
  assert(res.work_items !== undefined, 'and its field still lands after ours');
});

// --- 8. outcome gating -------------------------------------------------------------

test('outcome gating: a plan that self-reports `failed` still commits (stage-65 parity)', () => {
  const fx = fixture();
  script(fx, { writes: PLAN_WRITES, outcome: 'failed' });
  const { code, obj } = runCli(fx, 'plan', ['--commit-intent-artifacts']);
  assertEqual(
    code,
    agentExec.exitCodeFor({ outcome: 'failed' }),
    "the run exits on the role's own failed outcome (20), untouched by the commit",
  );
  assertEqual(obj.outcome, 'failed', 'the outcome is never rewritten');
  assertEqual(obj.intent_artifacts.outcome, 'committed', 'but the specs it wrote are not lost');
  assertEqual(originHead(fx), head(fx.dir), 'and are pushed');
});

test('outcome gating: a timeout commits NOTHING — the tree stays dirty and no intent_artifacts key is emitted', () => {
  const fx = fixture();
  const before = head(fx.dir);
  script(fx, { writes: PLAN_WRITES, sleepMs: 8000 });
  const { obj } = runCli(fx, 'plan', ['--commit-intent-artifacts', '--timeout-secs', '1']);
  assertEqual(obj.outcome, 'failed');
  assertEqual(obj.timed_out, true, 'the deadline killed the child');
  // The timeout return path never reaches the post-verdict wrappers (exactly
  // as work_items), so nothing is committed and nothing is claimed.
  assert(!('intent_artifacts' in obj), 'no key: skipped, not committed');
  assertEqual(head(fx.dir), before, 'HEAD did not move');
  assert(
    dirty(fx.dir, 'stage-instructions').includes('??'),
    'the partial output stays dirty for a human',
  );
});

// --- 9. config: schema, validate, worker dispatch flag ------------------------------

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-ia-policy-'));
}

function writePolicy(dir, text) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), text);
}

function validateCli(dir) {
  const res = spawnSync('node', [CLI, 'autonomy', 'validate', '--cwd', dir], { encoding: 'utf8' });
  return { code: res.status, err: res.stderr || '' };
}

test('config: agent.commit_intent_artifacts is default-ABSENT, loads when set, rejects a non-boolean', () => {
  assertEqual(
    autonomy.DEFAULTS.agent.commit_intent_artifacts,
    undefined,
    'not in DEFAULTS — absence is the kill-switch',
  );
  const absent = tmpProject();
  writePolicy(absent, 'mode: supervised\n');
  assertEqual(
    autonomy.loadPolicy(absent).agent.commit_intent_artifacts,
    undefined,
    'absent stays absent',
  );

  const on = tmpProject();
  writePolicy(on, 'mode: supervised\nagent:\n  commit_intent_artifacts: true\n');
  assertEqual(
    autonomy.loadPolicy(on).agent.commit_intent_artifacts,
    true,
    'an explicit true loads',
  );
  assertEqual(validateCli(on).code, 0, '`verity autonomy validate` is green with it');

  const bad = tmpProject();
  writePolicy(bad, 'agent:\n  commit_intent_artifacts: maybe\n');
  let threw = null;
  try {
    autonomy.loadPolicy(bad);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null && threw.exitCode === 20, 'a non-boolean is a load error (exit 20)');
  assert(threw.message.includes('commit_intent_artifacts'), `names the key (${threw.message})`);
  assertEqual(validateCli(bad).code, 20, 'validate refuses it too');
});

test('config: the per-role override (agent.roles.plan.commit_intent_artifacts) loads and validates', () => {
  const dir = tmpProject();
  writePolicy(
    dir,
    'mode: supervised\nagent:\n  roles:\n    plan:\n      commit_intent_artifacts: true\n',
  );
  assertEqual(autonomy.loadPolicy(dir).agent.roles.plan.commit_intent_artifacts, true);
  assertEqual(validateCli(dir).code, 0, 'validate green with a per-role override');
  const bad = tmpProject();
  writePolicy(bad, 'agent:\n  roles:\n    plan:\n      commit_intent_artifacts: 1\n');
  assertEqual(validateCli(bad).code, 20, 'the per-role value uses the SAME boolean spec');
});

test('config: the shipped JSON schema publishes the flag (base + per-role) with NO default', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  const knob = schema.properties.agent.properties.commit_intent_artifacts;
  assert(knob !== undefined, 'published in the shipped schema');
  assertEqual(knob.type, 'boolean');
  assert(!('default' in knob), 'no default — absence is the kill-switch');
  assert(/ADR-0033/.test(knob.description), 'the description points at the decision');
  assert(/#189/.test(knob.description), 'and the defect');
  const perRole =
    schema.properties.agent.properties.roles.patternProperties['^(build|plan|review)$'].properties
      .commit_intent_artifacts;
  assertEqual(
    JSON.stringify(perRole),
    JSON.stringify({ type: 'boolean' }),
    'per-role override published',
  );
});

// The tests/worker.test.cjs stage-64 harness, applied to the new knob: the
// base, per-role and unset (byte-identical) paths all read off the SAME
// dispatch machinery.
const runDispatchWith = (mutatePolicy) => {
  const nextMod = require('../verity/bin/lib/next.cjs');
  const policy = JSON.parse(JSON.stringify(autonomy.DEFAULTS));
  policy.mode = 'supervised';
  mutatePolicy(policy);
  const calls = [];
  const origDispatch = agentExec.dispatch;
  const origNext = nextMod.dispatch;
  agentExec.dispatch = (args, flags) => {
    calls.push({ role: args[0], flags: { ...flags } });
    return {
      schema: 1,
      role: args[0],
      outcome: 'gated',
      tokens: { in: 1, out: 1 },
      est_usd: 0.01,
      wall_secs: 1,
      tool_calls: 0,
      artifacts: {},
      error: null,
    };
  };
  nextMod.dispatch = () => ({
    schema: 1,
    action: 'work',
    role: 'plan',
    args: ['31'],
    gate: null,
    target: { kind: 'stage', number: null },
    reason: 'stage ready',
  });
  try {
    worker.runLoop(
      { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr() {} },
      { policy, runId: 'run-ia', item: { kind: 'stage', number: null, tier: 'P5' } },
    );
    return calls;
  } finally {
    agentExec.dispatch = origDispatch;
    nextMod.dispatch = origNext;
  }
};

test('worker: agent.commit_intent_artifacts true reaches the plan dispatch as --commit-intent-artifacts', () => {
  const calls = runDispatchWith((policy) => {
    policy.agent = { ...policy.agent, commit_intent_artifacts: true };
  });
  assertEqual(calls.length, 1, 'one plan dispatch');
  assertEqual(calls[0].role, 'plan');
  assertEqual(calls[0].flags['commit-intent-artifacts'], true, 'the flag travels when set true');
});

test('worker: absent OR false is omitted-in — byte-identical dispatch', () => {
  const absent = runDispatchWith(() => {});
  assert(!('commit-intent-artifacts' in absent[0].flags), 'absent ⇒ no flag key');
  const explicitFalse = runDispatchWith((policy) => {
    policy.agent = { ...policy.agent, commit_intent_artifacts: false };
  });
  assert(!('commit-intent-artifacts' in explicitFalse[0].flags), 'explicit false ⇒ no flag key');
});

test('worker: a per-role plan commit_intent_artifacts override also carries', () => {
  const calls = runDispatchWith((policy) => {
    policy.agent = { ...policy.agent, roles: { plan: { commit_intent_artifacts: true } } };
  });
  assertEqual(calls[0].flags['commit-intent-artifacts'], true, 'per-role plan override travels');
});
