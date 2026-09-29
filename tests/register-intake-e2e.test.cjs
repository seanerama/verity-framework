// Stage 114 (ADR-0038 D2/D3/D7, request #304 acceptance) — register-trusted
// intake end to end.
//
//   (1) LOCAL substrate, automated #304 acceptance: `verity init --substrate
//       local --start` in a temp path, then `verity-worker --once` with a stub
//       agent that, as the plan role, writes one stage file. The request is
//       selected (no self-feeding note), the stage exists, the request's
//       `verity:request` label is retired, and `verity next` returns build for
//       stage 1. Before the tick, `operator snapshot` shows the request pending
//       with a `plan` next action. Zero gh (a PATH sentinel fails any call).
//       Amendment item 0 (init's starter policy turns on ADR-0033's intent-
//       artifact commit and ADR-0026's work-item reconcile): BEFORE any build
//       runs, the stage file is on the bare origin's `main` in the engine's
//       `plan: intent artifacts` commit (bot identity, that file only) and a
//       `[stage 1]` local-work-item record exists — the stub records both at
//       every dispatch, so a chained build proves the ordering, not a sweep.
//   (2) GITHUB substrate, single identity, through a stateful gh stub: a
//       bot-authored request listed in the register COMMITTED on origin/HEAD is
//       planned under the same login; the same request listed only in a
//       working-tree register is NOT (still skipped, still reported).
// Real git, real engine, stub model; no network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'verity', 'bin', 'verity.cjs');
const WORKER = path.join(ROOT, 'verity', 'worker', 'index.cjs');

const STAGE_1 =
  '# Stage 1: Core\n\n- **Type:** feature\n- **Depends on:** none\n\n## Objectives\n\nThe first slice.\n';

// Agent stub: pops one step per dispatch, writes the step's files into its cwd
// (the plan role's intent artifacts), logs the dispatch, prints the stream-json
// result the claude driver parses.
const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
fs.appendFileSync(process.env.AGENT_LOG, process.cwd() + '\\n');
// Probe (local e2e): what the bare origin's main and the local work-item store
// hold at the moment of THIS dispatch, before the role does anything.
if (process.env.PROBE_LOG) {
  const { execFileSync } = require('node:child_process');
  let onOrigin = [];
  try {
    onOrigin = execFileSync('git', ['--git-dir', process.env.PROBE_ORIGIN, 'ls-tree', '-r',
      '--name-only', 'main', '--', 'stage-instructions/'],
      { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      .split('\\n').filter(Boolean);
  } catch {}
  const wiDir = path.join(process.env.PROBE_PROJ, '.verity', 'work-items');
  let titles = [];
  try {
    titles = fs.readdirSync(wiDir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(wiDir, f), 'utf8')).title);
  } catch {}
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ onOrigin, titles }) + '\\n');
}
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

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

// Every temp dir a test makes is tracked and removed in the test's finally
// (review F4) — the sandbox holds HOME, the project AND its bare origin
// (`<proj>-origin.git` is a sibling of the project inside the sandbox).
const made = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verity-e2e114-${tag}-`));
  made.push(dir);
  return dir;
}
function cleanup() {
  while (made.length > 0) {
    fs.rmSync(made.pop(), { recursive: true, force: true });
  }
}

// Isolated environment: its own HOME, git config with a commit identity and
// no signing, the stub agent, and a bin dir that goes first on PATH.
function sandbox(tag, ghStub) {
  const dir = tmp(tag);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), ghStub);
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

// ---------------------------------------------------------------------------
// (1) LOCAL substrate — the automated #304 acceptance
// ---------------------------------------------------------------------------

const GH_FORBIDDEN = `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.GH_SENTINEL, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('gh is FORBIDDEN on the local substrate\\n');
process.exit(97);
`;

test('#304 LOCAL e2e: verity init --substrate local --start → snapshot shows the pending request → verity-worker --once plans it → stage file on origin main by the engine + [stage 1] record BEFORE build → verity next = build stage 1', () => {
  try {
    localE2e();
  } finally {
    cleanup();
  }
});

function localE2e() {
  const sb = sandbox('local', GH_FORBIDDEN);
  const sentinel = path.join(sb.dir, 'gh-invocations.log');
  sb.env.GH_SENTINEL = sentinel;
  fs.writeFileSync(
    path.join(sb.dir, 'spec.md'),
    '# Widget Tracker: tracks widgets\n\nThe whole spec lives here.\n',
  );

  const init = run(
    process.execPath,
    [
      CLI,
      'init',
      'proj',
      '--spec',
      'spec.md',
      '--name',
      'Widget Tracker',
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
  assertEqual(r.intake.registered, true, 'register written');
  const proj = r.path;
  const n = r.intake.number;
  const origin = r.remote;
  assert(
    typeof origin === 'string' && origin.startsWith(sb.dir),
    `the bare origin lives inside the sandbox (cleaned with it): ${origin}`,
  );
  if (!origin.startsWith(sb.dir)) {
    made.push(origin);
  }

  // Before any tick: the snapshot shows the request waiting to be planned.
  const snapRes = run(process.execPath, [CLI, 'operator', 'snapshot', '--json'], proj, sb.env);
  assertEqual(snapRes.code, 0, `snapshot exit 0 (${snapRes.err})`);
  const snap = JSON.parse(snapRes.out);
  assertEqual(snap.schema, 1, 'schema stays 1');
  assertEqual(snap.queue.requests_pending, 1, 'requests_pending: 1');
  assertEqual(snap.queue.requests_parked, 0, 'requests_parked: 0');
  assertEqual(snap.next?.role, 'plan', 'next is plan');
  assertEqual(snap.next.target, n, 'on the intake record');
  const human = run(process.execPath, [CLI, 'operator', 'snapshot'], proj, sb.env);
  assert(
    human.out.includes('waiting to be planned (1 request(s) pending)'),
    `the human render says so: ${human.out}`,
  );

  // The tick: plan (stub) writes one stage file and succeeds. The stub probes
  // the origin and the work-item store at every dispatch.
  const probeLog = path.join(sb.dir, 'probe.log');
  Object.assign(sb.env, { PROBE_LOG: probeLog, PROBE_ORIGIN: origin, PROBE_PROJ: proj });
  fs.writeFileSync(
    sb.queue,
    JSON.stringify([
      {
        final: marker('success'),
        files: { 'stage-instructions/stage-1-core.md': STAGE_1 },
      },
      // Should the run chain into build, it gates — the tick stops there.
      { final: marker('gated', { gate: 'review:merge' }) },
    ]),
  );
  const tick = run(
    process.execPath,
    [WORKER, '--repo', 'me/widget-tracker', '--once'],
    proj,
    sb.env,
  );
  const log = `stdout:\n${tick.out}\nstderr:\n${tick.err}`;
  assert(tick.code === 0 || tick.code === 10, `worker tick exit 0/10\n${log}`);
  assert(!/self-authored/.test(tick.err + tick.out), `no self-feeding note\n${log}`);
  const dispatched = fs.readFileSync(sb.agentLog, 'utf8').trim().split('\n').filter(Boolean);
  assert(dispatched.length >= 1, `the plan role was dispatched\n${log}`);

  assert(
    fs.existsSync(path.join(proj, 'stage-instructions', 'stage-1-core.md')),
    'the stage the plan role wrote exists',
  );
  const rec = JSON.parse(
    fs.readFileSync(path.join(proj, '.verity', 'work-items', `${n}.json`), 'utf8'),
  );
  assert(!rec.labels.includes('verity:request'), `verity:request retired: ${rec.labels}`);

  // The run chains plan → build (supervised auto_advance); the stub's build
  // step gates, which ends the tick without touching stage 1's state.
  assert(dispatched.length <= 2, `plan, then at most the chained build\n${log}`);

  // Amendment item 0 — ADR-0033: the ENGINE committed and pushed the plan
  // role's stage file. Exactly one commit on the bare origin's main touches
  // it: the bot identity, ADR-0033's message, that file and nothing else (a
  // build's `git add -A` sweep would carry the operator identity and more).
  const STAGE_REL = 'stage-instructions/stage-1-core.md';
  const originGit = (...args) => git(proj, sb.env, `--git-dir=${origin}`, ...args);
  const shas = originGit('log', '--format=%H', 'main', '--', STAGE_REL).split('\n').filter(Boolean);
  assertEqual(shas.length, 1, `one commit on origin main carries the stage file\n${log}`);
  const [authorName, authorEmail, committerName, subject] = originGit(
    'show',
    '-s',
    '--format=%an%n%ae%n%cn%n%s',
    shas[0],
  ).split('\n');
  assertEqual(authorName, 'verity-worker', 'engine-authored (bot identity)');
  assertEqual(authorEmail, 'verity-worker@users.noreply.github.com', 'bot email');
  assertEqual(committerName, 'verity-worker', 'engine-committed');
  assertEqual(subject, 'plan: intent artifacts — 1 file(s)', "ADR-0033's subject");
  const body = originGit('show', '-s', '--format=%b', shas[0]);
  assert(body.startsWith(`${STAGE_REL}\n`), `the body names the file first: ${body}`);
  assert(
    body.includes(
      "Committed by the Verity engine after the plan role returned — a git_write:false role's intent artifacts are worker-owned (ADR-0033, #189).",
    ),
    `ADR-0033's body: ${body}`,
  );
  assertEqual(
    originGit('show', '--format=', '--name-only', shas[0]),
    STAGE_REL,
    'that file and nothing else',
  );
  assertEqual(
    git(proj, sb.env, 'show', `origin/main:${STAGE_REL}`),
    STAGE_1.trim(),
    'the committed content is what the plan role wrote',
  );

  // ADR-0026: a `[stage 1]` record exists in the local-work-item v1 store.
  const wiDir = path.join(proj, '.verity', 'work-items');
  const records = fs
    .readdirSync(wiDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(wiDir, f), 'utf8')));
  const stageRecs = records.filter((x) => /^\[stage 1\] /.test(x.title));
  assertEqual(stageRecs.length, 1, `one [stage 1] record: ${records.map((x) => x.title)}`);
  assertEqual(stageRecs[0].schema, 1, 'local-work-item v1');
  assertEqual(stageRecs[0].state, 'OPEN', 'open');
  assert(stageRecs[0].number !== n, 'a new record, not the intake one');

  // …and both held BEFORE any build ran: the stub's probe at each dispatch.
  const probes = fs
    .readFileSync(probeLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assertEqual(probes.length, dispatched.length, 'one probe per dispatch');
  assertEqual(probes[0].onOrigin.length, 0, 'at the plan dispatch: no stage on origin yet');
  assert(
    !probes[0].titles.some((t) => t.startsWith('[stage 1]')),
    'at the plan dispatch: no [stage 1] record yet',
  );
  for (const p of probes.slice(1)) {
    assert(
      p.onOrigin.includes(STAGE_REL),
      `at the build dispatch the stage is on origin main: ${JSON.stringify(p)}`,
    );
    assert(
      p.titles.some((t) => t.startsWith('[stage 1] ')),
      `at the build dispatch the [stage 1] record exists: ${JSON.stringify(p)}`,
    );
  }

  const next = run(process.execPath, [CLI, 'next', '--json'], proj, sb.env);
  const decision = JSON.parse(next.out);
  assertEqual(decision.role, 'build', `build (${next.out})`);
  assertEqual(decision.args?.[0], '1', 'stage 1');
  if (dispatched.length === 2) {
    // The chained build's gate now has a carrier — the reconciled [stage 1]
    // record — so stage 1 waits at the supervised human gate.
    assertEqual(decision.action, 'gated', `stage 1 paused at its build gate (${next.out})`);
    assertEqual(decision.gate, 'build', 'the build gate');
    assertEqual(decision.target?.number, stageRecs[0].number, 'on the [stage 1] record');
  } else {
    assertEqual(decision.action, 'work', `verity next works (${next.out})`);
  }
  assert(
    !fs.existsSync(sentinel),
    `zero gh: ${fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : ''}`,
  );
  // The register is committed on the default branch and was never touched.
  const reg = JSON.parse(git(proj, sb.env, 'show', 'origin/HEAD:.verity/intake.json'));
  assertEqual(reg.requests[0].number, n, 'register lists the intake');
}

// ---------------------------------------------------------------------------
// (2) GITHUB substrate, single identity — the worker tick through a stateful
//     gh stub whose `gh api user` login is verity-bot, the same login that
//     authored the request (the one-login Console setup).
// ---------------------------------------------------------------------------

// Stateful gh stub — a twin of tests/self-authored-skip.test.cjs's harness.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
if (args[0] === 'auth' && args[1] === 'status') { out('Logged in as verity-bot\\n'); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'list') {
  const s = state();
  let items = args[0] === 'issue' ? s.issues : s.prs;
  const label = flag('--label');
  if (label) items = items.filter((it) => (it.labels || []).some((l) => lname(l) === label.toLowerCase()));
  if (flag('--state') === 'open') items = items.filter((it) => it.state === 'OPEN');
  out(items);
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') { out({ name: 'fixture' }); process.exit(0); }
if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'view') {
  const s = state();
  const pool = args[0] === 'issue' ? s.issues : s.prs;
  const it = pool.find((x) => x.number === Number(args[2]));
  out({ labels: (it.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'api') {
  const method = flag('-X') || 'GET';
  const url = args.find((a) => a === 'user' || a.startsWith('repos/'));
  if (url === 'user') { out({ login: 'verity-bot' }); process.exit(0); }
  const m = (url || '').match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)(.*)$/);
  if (!m) { process.stderr.write('HTTP 404: no route\\n'); process.exit(1); }
  let rest = m[2] || '';
  let query = '';
  const qi = rest.indexOf('?');
  if (qi !== -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const s = state();
  const item = s.issues.concat(s.prs).find((it) => it.number === Number(m[1]));
  if (!item) { process.stderr.write('HTTP 404: not found\\n'); process.exit(1); }
  const fBody = () => args[args.indexOf('-f') + 1];
  if (rest === '' && method === 'GET') {
    out({ number: item.number, title: item.title, labels: (item.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
    process.exit(0);
  }
  if (rest === '/comments' && method === 'GET') {
    const page = Number((query.match(/(?:^|&)page=(\\d+)/) || [])[1] || 1);
    out(page > 1 ? [] : item.comments || []);
    process.exit(0);
  }
  if (rest === '/comments' && method === 'POST') {
    item.comments = item.comments || [];
    item.comments.push({ body: fBody().replace(/^body=/, '') });
    save(s); out({}); process.exit(0);
  }
  if (rest === '/labels' && method === 'POST') {
    item.labels = (item.labels || []).concat([fBody().replace(/^labels\\[\\]=/, '')]);
    save(s); out([]); process.exit(0);
  }
  if (rest.startsWith('/labels/') && method === 'DELETE') {
    const target = decodeURIComponent(rest.slice('/labels/'.length)).toLowerCase();
    item.labels = (item.labels || []).filter((l) => lname(l) !== target);
    save(s); out(''); process.exit(0);
  }
}
process.stderr.write('HTTP 404: unhandled gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

const botRequest = {
  number: 1,
  title: '[request] Widget Tracker: tracks widgets',
  state: 'OPEN',
  labels: ['verity:request'],
  author: { login: 'verity-bot' },
  createdAt: '2026-09-29T18:00:00Z',
  assignees: [],
  comments: [],
};

const REGISTER = `${JSON.stringify(
  {
    schema: 1,
    requests: [
      {
        number: 1,
        kind: 'issue',
        spec: 'docs/spec.md',
        spec_commit: 'abc1234',
        filed_by: 'verity init',
        engine: '1.8.0',
        filed_at: '2026-09-29T18:00:00Z',
      },
    ],
  },
  null,
  2,
)}\n`;

// A github-substrate checkout: git repo, policy, origin/HEAD → main. With
// `committed`, main carries the register; with `workingTreeOnly`, the register
// exists only as an uncommitted file (what a role's file write would leave).
function githubFixture(tag, { committed, workingTreeOnly }) {
  const sb = sandbox(tag, GH_STUB);
  const proj = path.join(sb.dir, 'proj');
  fs.mkdirSync(path.join(proj, '.verity'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.verity', 'autonomy.yml'),
    ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n'),
  );
  git(proj, sb.env, 'init', '-q', '-b', 'main');
  if (committed) {
    fs.writeFileSync(path.join(proj, '.verity', 'intake.json'), REGISTER);
  }
  git(proj, sb.env, 'add', '-A');
  git(proj, sb.env, 'commit', '-q', '-m', 'init');
  git(proj, sb.env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(proj, sb.env, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  if (workingTreeOnly) {
    fs.writeFileSync(path.join(proj, '.verity', 'intake.json'), REGISTER);
  }
  const stateFile = path.join(sb.dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: [{ ...botRequest }], prs: [] }));
  sb.env.GH_STATE_FILE = stateFile;
  // The plan role (stub) succeeds without writing stages: selection is what is
  // under test here, and the request keeps its label (no stages → no retire).
  fs.writeFileSync(sb.queue, JSON.stringify([{ final: marker('success') }]));
  return { sb, proj };
}

test('github single identity: a bot-authored request in the COMMITTED register is planned under the same login', () => {
  try {
    ghRegistered();
  } finally {
    cleanup();
  }
});

function ghRegistered() {
  const { sb, proj } = githubFixture('gh-registered', { committed: true });
  const tick = run(process.execPath, [WORKER, '--repo', 'octo/fixture', '--once'], proj, sb.env);
  const log = `stdout:\n${tick.out}\nstderr:\n${tick.err}`;
  assertEqual(tick.code, 0, `the request run succeeds\n${log}`);
  assertEqual(
    JSON.parse(fs.readFileSync(sb.queue, 'utf8')).length,
    0,
    `the plan role was dispatched on the registered request\n${log}`,
  );
  assert(
    tick.err.includes(
      'verity-worker: note: skipped 0 self-authored request(s), accepted 1 engine-registered (see docs/autonomy.md)',
    ),
    `the note reports the accepted request\n${log}`,
  );
}

test('github single identity SECURITY: the same request listed only in a WORKING-TREE register is still skipped and reported', () => {
  try {
    ghWorktree();
  } finally {
    cleanup();
  }
});

function ghWorktree() {
  const { sb, proj } = githubFixture('gh-worktree', { workingTreeOnly: true });
  const tick = run(process.execPath, [WORKER, '--repo', 'octo/fixture', '--once'], proj, sb.env);
  const log = `stdout:\n${tick.out}\nstderr:\n${tick.err}`;
  assertEqual(tick.code, 0, `honest idle exit 0\n${log}`);
  assertEqual(
    JSON.parse(fs.readFileSync(sb.queue, 'utf8')).length,
    1,
    `the model was never invoked\n${log}`,
  );
  assert(/not committed on the default branch/.test(tick.err), `the register warning\n${log}`);
  assert(
    tick.err.includes('verity-worker: note: skipped 1 self-authored request(s) (no self-feeding'),
    `the stage-28 note\n${log}`,
  );
  assert(
    /idle — no eligible work — skipped 1 self-authored request\(s\)/.test(tick.out),
    `qualified idle line\n${log}`,
  );
}
