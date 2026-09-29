// Stage 115 (ADR-0038 D4, request #304) — the spec-soundness gate.
//
//   (1) The one text shape (verity/bin/lib/spec-soundness.cjs): the gate
//       comment round-trips its gaps, redacts secrets, and reads to stage
//       111's parsers as a gate with NO parked-result pointer.
//   (2) runLoop (github, gh stubbed in-process): a gated P4 plan whose marker
//       names `spec-unsound` parks needs-human with the gaps; EVERY other
//       gated result — another gate, another role, another tier, an
//       unreadable marker — takes today's gatePause path, call for call.
//   (3) The no-progress breaker: a spec-unsound summary breaks the streak.
//   (4) LOCAL substrate end to end: `verity init --substrate local --start`
//       with tests/fixtures/specs/vague.md → one `--once` parks the request
//       (record label + label-commit note, NO stage file, NO intent-artifacts
//       commit with commit_intent_artifacts on) → `operator gates` renders
//       the gate per the contract note, `requests_parked` counts it →
//       `operator act clear-needs-human` → `--once` with a sound plan (the
//       spec amended to tests/fixtures/specs/sound.md) writes the stage and
//       retires the request. Zero gh (a PATH sentinel fails any call).
// Real git, real engine, stub model; no network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'verity', 'bin', 'verity.cjs');
const WORKER = path.join(ROOT, 'verity', 'worker', 'index.cjs');
const SPECS = path.join(__dirname, 'fixtures', 'specs');

const specSoundness = require('../verity/bin/lib/spec-soundness.cjs');
const worker = require('../verity/worker/index.cjs');

const GAPS = ['no users named', 'no data model for orders', 'success criterion missing'];

// ---------------------------------------------------------------------------
// (1) the text shape
// ---------------------------------------------------------------------------

test('stage 115: the gate comment round-trips its gaps and reads as a pointer-less gate to stage 111', () => {
  assertEqual(specSoundness.GATE_COMMENT_PREFIX, worker.GATE_COMMENT_PREFIX, 'one prefix');
  const gaps = specSoundness.gapsFromReason(`- ${GAPS[0]}\n\n* ${GAPS[1]}\r\n  ${GAPS[2]}  \n`);
  assertEqual(JSON.stringify(gaps), JSON.stringify(GAPS), 'one gap per non-empty line, unbulleted');
  const body = specSoundness.formatGateComment({
    runId: 'run-a1',
    number: 7,
    gaps,
    mentions: ['op'],
  });
  const parsed = specSoundness.parseGateComment(body);
  assertEqual(parsed.runId, 'run-a1', 'run id read back');
  assertEqual(JSON.stringify(parsed.gaps), JSON.stringify(GAPS), 'gaps read back verbatim');
  assert(body.includes('\n## Spec gaps\n'), 'fixed heading');
  assert(body.endsWith('cc @op'), 'mentions last');
  const pause = worker.parseGatePause(body);
  assertEqual(pause.gate, 'spec-unsound', "stage 111's parser reads the gate name");
  assertEqual(pause.pointer, null, 'and NO parked-result pointer — nothing resumes or merges');
  const latest = worker.latestGatePause([{ body, user: { login: 'bot' } }], 'bot');
  assertEqual(latest.pointer, null, 'latestGatePause: no pointer either');
  assertEqual(
    specSoundness.parseGateComment('⏸️ **verity-worker** `r` — paused at human gate `review:merge`'),
    null,
    'another gate is not this one',
  );
  const none = specSoundness.formatGateComment({ runId: 'run-a2', number: 7, gaps: [] });
  assertEqual(JSON.stringify(specSoundness.parseGateComment(none).gaps), '[]', 'no gaps ⇒ []');
});

test('stage 115: a secret pasted into the spec never reaches the gate comment (redactor)', () => {
  const pat = `ghp_${'A'.repeat(36)}`;
  const key = `sk-ant-api03-${'b'.repeat(40)}`;
  const gaps = specSoundness.gapsFromReason(
    `no deploy target (spec pastes ${pat})\nkey ${key} is not a data model`,
  );
  const body = specSoundness.formatGateComment({ runId: 'run-s1', number: 3, gaps });
  assert(!body.includes(pat), 'no GitHub token');
  assert(!body.includes(key), 'no provider key');
  assert(body.includes('[redacted]'), 'redacted in place');
  assertEqual(specSoundness.parseGateComment(body).gaps.length, 2, 'both gaps still named');
});

// ---------------------------------------------------------------------------
// (2) runLoop — the park vs today's gatePause, call for call
// ---------------------------------------------------------------------------

function withStubs(fn) {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const ghMod = require('../verity/bin/lib/gh.cjs');
  const saved = {
    dispatch: agentExecMod.dispatch,
    readResultGate: agentExecMod.readResultGate,
    next: nextMod.dispatch,
    run: ghMod.run,
    json: ghMod.json,
  };
  try {
    return fn({ agentExecMod, nextMod, ghMod });
  } finally {
    agentExecMod.dispatch = saved.dispatch;
    agentExecMod.readResultGate = saved.readResultGate;
    nextMod.dispatch = saved.next;
    ghMod.run = saved.run;
    ghMod.json = saved.json;
  }
}

// One runLoop tick: the role returns `gated`; `markerGate` is what
// readResultGate re-reads (a value, null, or an Error to throw). Returns the
// gh write calls, the readResultGate calls, and the summary.
function tick({ tier = 'P4', role = 'plan', markerGate, substrate }) {
  return withStubs(({ agentExecMod, nextMod, ghMod }) => {
    const calls = [];
    const reads = [];
    const stderr = [];
    ghMod.run = (args) => {
      calls.push(args);
      return '';
    };
    ghMod.json = () => [];
    agentExecMod.dispatch = (args) => ({
      schema: 1,
      role: args[0],
      outcome: 'gated',
      tokens: { in: 1, out: 1 },
      est_usd: 0.01,
      wall_secs: 1,
      tool_calls: 0,
      artifacts: {},
      error: null,
    });
    agentExecMod.readResultGate = (flags) => {
      reads.push(flags);
      if (markerGate instanceof Error) {
        throw markerGate;
      }
      return markerGate;
    };
    nextMod.dispatch = () => ({
      schema: 1,
      action: 'work',
      role,
      args: ['5'],
      gate: null,
      target: { kind: 'issue', number: 42 },
      reason: `stage 5 needs ${role}`,
    });
    const policy = JSON.parse(JSON.stringify(require('../verity/bin/lib/autonomy.cjs').DEFAULTS));
    policy.mode = 'supervised';
    const ctx = { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr: (l) => stderr.push(l) };
    if (substrate !== undefined) {
      ctx.substrate = substrate;
    }
    const s = worker.runLoop(ctx, {
      policy,
      runId: 'run-115',
      item: { kind: 'issue', number: 42, tier },
    });
    return { calls, reads, stderr, summary: s };
  });
}

const labelPosts = (calls) =>
  calls
    .filter((a) => a[2] === 'POST' && String(a[3]).endsWith('/labels'))
    .map((a) => a[5].replace(/^labels\[\]=/, ''));
const labelDeletes = (calls) =>
  calls
    .filter((a) => a[2] === 'DELETE')
    .map((a) => decodeURIComponent(String(a[3]).split('/labels/')[1]));
const commentPosts = (calls) =>
  calls
    .filter((a) => a[2] === 'POST' && String(a[3]).endsWith('/comments'))
    .map((a) => a[5].replace(/^body=/, ''));

test('stage 115 runLoop: a P4 plan marker naming spec-unsound parks needs-human — no awaiting-approval, verity:request kept, gaps verbatim', () => {
  const r = tick({ markerGate: { gate: 'spec-unsound', reason: GAPS.join('\n') } });
  assertEqual(JSON.stringify(labelPosts(r.calls)), '["verity:needs-human"]', 'only needs-human');
  assertEqual(labelDeletes(r.calls).length, 0, 'nothing removed — verity:request stays');
  const [body] = commentPosts(r.calls);
  assertEqual(commentPosts(r.calls).length, 1, 'one gate comment');
  assertEqual(
    body,
    specSoundness.formatGateComment({ runId: 'run-115', number: 42, gaps: GAPS }),
    'the fixed gate comment',
  );
  const post = r.calls.find((a) => String(a[3]).endsWith('/comments'));
  assertEqual(post[3], 'repos/o/r/issues/42/comments', 'on the request');
  assertEqual(r.summary.outcome, 'gated', 'summary outcome gated');
  assertEqual(r.summary.gate, 'spec-unsound', 'the gate named (usage rows carry it)');
  assert(r.summary.result.startsWith('gated at spec-unsound — request #42'), r.summary.result);
  assertEqual(
    r.summary.approval_hint,
    'amend `docs/spec.md`, then `verity operator act clear-needs-human 42` — the next tick re-plans',
    'the configuration-true action line',
  );
  assertEqual(
    JSON.stringify(r.reads),
    JSON.stringify([{ 'run-id': 'run-115', role: 'plan', agent: 'claude' }]),
    'marker re-read once, for this run',
  );
});

test('stage 115 runLoop LOCAL: label only (+ the run-log route) — no awaiting-approval, no gh', () => {
  const substrateLocal = require('../verity/bin/lib/substrate-local.cjs');
  const origAdd = substrateLocal.addLabel;
  const added = [];
  substrateLocal.addLabel = (_cwd, n, label, opts) => added.push({ n, label, opts });
  try {
    const r = tick({
      markerGate: { gate: 'spec-unsound', reason: GAPS.join('\n') },
      substrate: 'local',
    });
    assertEqual(r.calls.length, 0, 'zero gh on local');
    assertEqual(
      JSON.stringify(added),
      JSON.stringify([{ n: 42, label: 'verity:needs-human', opts: { note: 'spec-unsound' } }]),
      'one label, noted',
    );
    assert(
      r.stderr.some((l) => l.includes('## Spec gaps') && l.includes(`- ${GAPS[1]}`)),
      'gaps on the run log',
    );
    assertEqual(r.summary.gate, 'spec-unsound', 'gated at spec-unsound');
  } finally {
    substrateLocal.addLabel = origAdd;
  }
});

test('stage 115 regression (no kill-switch): every OTHER gated result takes gatePause, call for call', () => {
  // The reference: today's path, reached with no marker gate at all.
  const ref = tick({ markerGate: null });
  assertEqual(
    JSON.stringify(labelPosts(ref.calls)),
    '["verity:awaiting-approval"]',
    "today's pause",
  );
  const refCalls = JSON.stringify(ref.calls);
  const refSummary = JSON.stringify(ref.summary);
  for (const [what, opts] of [
    ['another gate on a P4 plan', { markerGate: { gate: 'plan:confirm', reason: 'x' } }],
    ['an unreadable marker', { markerGate: new Error('boom') }],
  ]) {
    const r = tick(opts);
    assertEqual(JSON.stringify(r.calls), refCalls, `${what}: identical gh calls`);
    const sum = JSON.stringify({ ...r.summary, wall_secs: ref.summary.wall_secs });
    assertEqual(sum, refSummary, `${what}: identical summary`);
  }
  // Not a P4 plan ⇒ the marker is never even read (no new I/O on those paths).
  for (const [what, opts] of [
    ['a P5 plan', { tier: 'P5' }],
    ['a P5 build', { tier: 'P5', role: 'build' }],
    ['a P5 review', { tier: 'P5', role: 'review' }],
  ]) {
    const r = tick({ ...opts, markerGate: { gate: 'spec-unsound', reason: 'x' } });
    assertEqual(r.reads.length, 0, `${what}: marker not read`);
    assert(!labelPosts(r.calls).includes('verity:needs-human'), `${what}: no park`);
  }
});

// ---------------------------------------------------------------------------
// (3) the no-progress breaker
// ---------------------------------------------------------------------------

test('stage 115: a spec-unsound run summary BREAKS the no-progress streak (a cleared park is new input, never a strike)', () => {
  const summary = (id, result) =>
    `🤖 **verity-worker** \`${id}\` — ⏸️ gated\nroles: plan\nresult: ${result}\ntokens: 1k in / 1k out · est $0.01 · wall 0m1s`;
  const plain = (id) => summary(id, 'no stages');
  const parked = (id) =>
    summary(
      id,
      `${specSoundness.SUMMARY_RESULT_PREFIX}request #3 parked verity:needs-human with 2 named spec gap(s); nothing was planned`,
    );
  assertEqual(worker.countRepeatedRole([plain('a'), plain('b')], 'plan'), 2, 'baseline streak');
  assertEqual(worker.countRepeatedRole([parked('a'), parked('b')], 'plan'), 0, 'parks never count');
  assertEqual(
    worker.countRepeatedRole([plain('a'), parked('b'), plain('c')], 'plan'),
    1,
    'a park breaks the streak',
  );
});

// ---------------------------------------------------------------------------
// (4) LOCAL end to end
// ---------------------------------------------------------------------------

const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.AGENT_LOG, process.cwd() + '\\n');
const queue = JSON.parse(fs.readFileSync(process.env.AGENT_QUEUE, 'utf8'));
const step = queue.shift();
fs.writeFileSync(process.env.AGENT_QUEUE, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
for (const [rel, body] of Object.entries(step.files || {})) {
  const file = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 0.5,
  usage: { input_tokens: 1000, cache_creation_input_tokens: 0,
           cache_read_input_tokens: 0, output_tokens: 100 },
}) + '\\n');
`;

const GH_FORBIDDEN = `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.GH_SENTINEL, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('gh is FORBIDDEN on the local substrate\\n');
process.exit(97);
`;

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

const made = [];
function cleanup() {
  while (made.length > 0) {
    fs.rmSync(made.pop(), { recursive: true, force: true });
  }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-s115-'));
  made.push(dir);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_FORBIDDEN);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(
    gitconfig,
    '[user]\n\tname = Verity E2E\n\temail = e2e@verity.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n',
  );
  const queue = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queue, '[]');
  const agentLog = path.join(dir, 'agent.log');
  fs.writeFileSync(agentLog, '');
  const env = { ...process.env };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'VERITY_SUBSTRATE',
    'GH_REPO',
    'GH_TOKEN',
  ]) {
    delete env[k];
  }
  Object.assign(env, {
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    VERITY_AGENT_BIN: agent,
    AGENT_QUEUE: queue,
    AGENT_LOG: agentLog,
    GH_SENTINEL: path.join(dir, 'gh-invocations.log'),
  });
  return { dir, env, queue, agentLog };
}

function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function git(cwd, env, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const STAGE_1 =
  '# Stage 1: Skeleton\n\n- **Type:** feature\n- **Depends on:** none\n\n## Objectives\n\nBoot the order desk.\n';

test('stage 115 LOCAL e2e: vague spec → parked with named gaps, nothing planned or committed → gates/snapshot show it → clear-needs-human → sound spec plans and retires the request', () => {
  try {
    localE2e();
  } finally {
    cleanup();
  }
});

function localE2e() {
  const sb = sandbox();
  fs.copyFileSync(path.join(SPECS, 'vague.md'), path.join(sb.dir, 'spec.md'));
  const init = run(
    process.execPath,
    [
      CLI,
      'init',
      'proj',
      '--spec',
      'spec.md',
      '--name',
      'Shop Thing',
      '--owner',
      'me',
      '--substrate',
      'local',
      '--start',
      '--json',
    ],
    sb.dir,
    sb.env,
  );
  assertEqual(init.code, 0, `init ok (stderr: ${init.err})`);
  const r = JSON.parse(init.out);
  const proj = r.path;
  const n = r.intake.number;
  const origin = r.remote;
  if (!origin.startsWith(sb.dir)) {
    made.push(origin);
  }
  const originMain = () => git(proj, sb.env, `--git-dir=${origin}`, 'rev-parse', 'main');
  const mainBefore = originMain();

  // Tick 1: the plan role writes its assessment ONLY and reports spec-unsound.
  fs.writeFileSync(
    sb.queue,
    JSON.stringify([
      {
        files: {
          'feature-assessments/shop-thing-spec-assessment.md': '# Spec assessment\n\nUnsound.\n',
        },
        final: marker('gated', { gate: 'spec-unsound', reason: GAPS.join('\n') }),
      },
    ]),
  );
  const t1 = run(process.execPath, [WORKER, '--repo', 'me/shop-thing', '--once'], proj, sb.env);
  const log1 = `stdout:\n${t1.out}\nstderr:\n${t1.err}`;
  assertEqual(t1.code, 0, `tick 1 exits 0\n${log1}`);
  const rec = () =>
    JSON.parse(fs.readFileSync(path.join(proj, '.verity', 'work-items', `${n}.json`), 'utf8'));
  const labels1 = rec().labels;
  assert(labels1.includes('verity:needs-human'), `parked: ${labels1}`);
  assert(labels1.includes('verity:request'), `request kept: ${labels1}`);
  assert(!labels1.includes('verity:awaiting-approval'), `no approval pause: ${labels1}`);
  assert(
    !fs.existsSync(path.join(proj, 'stage-instructions')) ||
      fs.readdirSync(path.join(proj, 'stage-instructions')).length === 0,
    'no stage file',
  );
  // commit_intent_artifacts is on (init's starter policy) — and committed NOTHING.
  assert(
    /commit_intent_artifacts:\s*true/.test(
      fs.readFileSync(path.join(proj, '.verity', 'autonomy.yml'), 'utf8'),
    ),
    'the init policy has intent-artifact commit on',
  );
  assertEqual(originMain(), mainBefore, 'origin main did not move');
  assertEqual(
    git(proj, sb.env, 'log', '--all', '--format=%s', '--grep=intent artifacts'),
    '',
    'no intent-artifacts commit anywhere',
  );
  assertEqual(
    git(proj, sb.env, 'log', '-1', '--format=%s', '--', `.verity/work-items/${n}.json`),
    `verity: label work-item #${n} +verity:needs-human (spec-unsound)`,
    'the park is recorded in the record label commit',
  );
  assert(
    t1.err.includes('## Spec gaps') && t1.err.includes(`- ${GAPS[2]}`),
    `gaps on the run log\n${log1}`,
  );

  // The operator surface.
  const gatesRes = run(process.execPath, [CLI, 'operator', 'gates', '--json'], proj, sb.env);
  assertEqual(gatesRes.code, 0, `gates exit 0 (${gatesRes.err})`);
  const gates = JSON.parse(gatesRes.out);
  assertEqual(gates.length, 1, `one gate: ${gatesRes.out}`);
  const g = gates[0];
  assertEqual(g.gate, 'spec-unsound', 'gate');
  assertEqual(g.role, 'plan', 'role');
  assertEqual(
    JSON.stringify(g.work_item),
    JSON.stringify({ type: 'issue', number: n, title: rec().title }),
    'work_item',
  );
  assertEqual(g.stage, null, 'stage null');
  assertEqual(g.pull_request, null, 'no PR');
  assertEqual(g.risk, null, 'risk null');
  assert(
    Object.values(g.evidence).every((v) => v === null),
    `evidence all null: ${JSON.stringify(g.evidence)}`,
  );
  assertEqual(g.next_on_approve, null, 'approval does not apply');
  assertEqual(JSON.stringify(g.allowed_actions), '["clear-needs-human"]', 'one action');
  assertEqual(JSON.stringify(g.gaps), '[]', 'gaps [] on local');
  assertEqual(g.schema, 1, 'schema stays 1');
  const snap = JSON.parse(
    run(process.execPath, [CLI, 'operator', 'snapshot', '--json'], proj, sb.env).out,
  );
  assertEqual(snap.queue.requests_parked, 1, 'requests_parked counts it');
  assertEqual(snap.queue.requests_pending, 0, 'nothing pending');
  const runs = JSON.parse(
    run(process.execPath, [CLI, 'operator', 'runs', '--json'], proj, sb.env).out,
  );
  assertEqual(runs[0].gate, 'spec-unsound', 'the run ledger names the gate');
  assertEqual(runs[0].outcome, 'gated', 'outcome gated');

  // A parked request is not worked.
  const idle = run(process.execPath, [WORKER, '--repo', 'me/shop-thing', '--once'], proj, sb.env);
  assertEqual(idle.code, 0, `idle tick exits 0 (${idle.err})`);
  assertEqual(
    fs.readFileSync(sb.agentLog, 'utf8').trim().split('\n').length,
    1,
    'no re-plan while parked',
  );

  // Amend the spec, clear the park, tick: a sound plan proceeds to Mode A.
  fs.copyFileSync(path.join(SPECS, 'sound.md'), path.join(proj, 'docs', 'spec.md'));
  const clear = run(
    process.execPath,
    [CLI, 'operator', 'act', 'clear-needs-human', String(n), '--json'],
    proj,
    sb.env,
  );
  assertEqual(clear.code, 0, `clear-needs-human ok (${clear.out}${clear.err})`);
  assert(!rec().labels.includes('verity:needs-human'), 'unparked');
  fs.writeFileSync(
    sb.queue,
    JSON.stringify([
      {
        files: {
          'stage-instructions/stage-1-skeleton.md': STAGE_1,
          'feature-assessments/shop-thing-spec-assessment.md': '# Spec assessment\n\nSound.\n',
        },
        final: marker('success'),
      },
      { final: marker('gated', { gate: 'review:merge' }) },
    ]),
  );
  const t2 = run(process.execPath, [WORKER, '--repo', 'me/shop-thing', '--once'], proj, sb.env);
  const log2 = `stdout:\n${t2.out}\nstderr:\n${t2.err}`;
  assert(t2.code === 0 || t2.code === 10, `tick 2 exits 0/10\n${log2}`);
  assert(
    fs.existsSync(path.join(proj, 'stage-instructions', 'stage-1-skeleton.md')),
    'the stage exists',
  );
  assert(!rec().labels.includes('verity:request'), `request retired: ${rec().labels}`);
  const sha = git(
    proj,
    sb.env,
    `--git-dir=${origin}`,
    'log',
    '--format=%H',
    'main',
    '--',
    'stage-instructions/stage-1-skeleton.md',
  );
  assertEqual(
    git(proj, sb.env, `--git-dir=${origin}`, 'show', '-s', '--format=%s', sha),
    'plan: intent artifacts — 2 file(s)',
    'the sound plan IS committed by the engine',
  );
  assertEqual(
    git(proj, sb.env, `--git-dir=${origin}`, 'show', '--format=', '--name-only', sha)
      .split('\n')
      .sort()
      .join(','),
    'feature-assessments/shop-thing-spec-assessment.md,stage-instructions/stage-1-skeleton.md',
    'the stage and the (sound) spec assessment',
  );
  const after = JSON.parse(
    run(process.execPath, [CLI, 'operator', 'gates', '--json'], proj, sb.env).out,
  );
  assert(!after.some((x) => x.gate === 'spec-unsound'), 'the spec gate is gone');
  assert(!fs.existsSync(sb.env.GH_SENTINEL), 'zero gh');
}
