// Stage 31 (ADR-0014) — the unknown-cost gate must be resumable: an approval
// consumes the PARKED result, never a fresh dispatch.
//
// The defect (canary run 5, defect N2): under codex est_usd is always null, so
// every successful role parks at `unknown-cost` before the trust ladder
// (correct, ADR-0008) — but approving the gate RE-DISPATCHED the same role at
// full price. Review ran 3× on one PR (138k+144k+154k input tokens), posted
// duplicate findings comments, and flipped its verdict between re-runs: the
// human approved result A and the ladder received result B.
//
// The fix (ADR-0014): the success-path unknown-cost pause records a durable
// pointer to the parked result — an additive `parked:` line on the gate
// comment naming the run id, role, PR, and the PR's head SHA at park time (the
// staleness anchor). Consuming `verity:approved` for that item RESUMES from
// the persisted T05 result under ~/.verity/logs/<run-id>/: trust ladder,
// summary, ledger — zero provider spawns, zero new tokens, VERIFIED zero new
// cost, and no re-posted effects (the findings comment already landed when the
// result parked). Staleness and a missing/unreadable parked file fail CLOSED
// into a loudly-announced fresh dispatch — an approval is never a no-op.
// Stage 25's FAILED-run parks are untouched: a failed park's gate comment
// carries no pointer, and its approval still means "let the day proceed".
//
// Stub-driven like tests/worker.test.cjs (its stateful gh stub + scripted
// claude/codex agent stubs, $HOME redirected). No network, no live API, ever.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stage = require('../verity/bin/lib/stage.cjs');
const worker = require('../verity/worker/index.cjs');

const WORKER = path.join(__dirname, '..', 'verity', 'worker', 'index.cjs');
const MIN_CODEX = require('../package.json').verity.codexMinVersion;

// --- stateful gh stub (PATH) — trimmed twin of tests/worker.test.cjs ---------
// Extended for this stage: `pr view` serves headRefOid (the staleness anchor
// the parked pointer records and the resume re-checks) plus the T13 trust
// surface (diff/merge) so a resumed approve verdict can reach a real merge.
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.CALLS_FILE) fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n');
const stateFile = process.env.GH_STATE_FILE;
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const lname = (l) => (typeof l === 'string' ? l : l.name).toLowerCase();
// Stage 111 review: who the stub is (GH_USER_LOGIN; '' = an identity the
// lookup cannot name) and a LOGICAL clock, so comment/label ordering is exact.
const LOGIN = process.env.GH_USER_LOGIN === undefined ? 'verity-bot' : process.env.GH_USER_LOGIN;
const stamp = (s) => { s.clock = (s.clock || 0) + 1; return new Date(Date.UTC(2026, 8, 1) + s.clock * 1000).toISOString(); };
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
const prByNumber = (n) => state().prs.find((p) => p.number === Number(n));
if (args[0] === 'pr' && args[1] === 'diff') {
  out((prByNumber(args[2]).files || []).join('\\n') + '\\n');
  process.exit(0);
}
// Stage 111 round 3: \`updatedAt\` is GitHub's own time for the read — the
// stub's logical clock NOW (every later push is stamped strictly after it).
if (args[0] === 'pr' && args[1] === 'view') {
  const s0 = state();
  const p = prByNumber(args[2]);
  out({ additions: p.additions || 0, deletions: p.deletions || 0,
        headRefOid: p.headRefOid || null,
        updatedAt: new Date(Date.UTC(2026, 8, 1) + (s0.clock || 0) * 1000).toISOString(),
        labels: (p.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) });
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (prByNumber(args[2]).checksPass) { out('all checks pass\\n'); process.exit(0); }
  process.stderr.write('some checks were not successful\\n');
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const s = state();
  const target = s.prs.find((p) => p.number === Number(args[2]));
  // Stage 111: a scripted merge refusal, and GitHub's own head pin.
  if (target.mergeFails) { process.stderr.write('Pull request is not mergeable: merge conflict\\n'); process.exit(1); }
  const pin = flag('--match-head-commit');
  if (pin !== null && pin !== target.headRefOid) { process.stderr.write('head branch was modified\\n'); process.exit(1); }
  target.state = 'MERGED';
  save(s);
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') { out({ name: 'fixture' }); process.exit(0); }
if (args[0] === 'api') {
  const method = flag('-X') || 'GET';
  const url = args.find((a) => a === 'user' || a.startsWith('repos/'));
  if (url === 'user') { out({ login: LOGIN }); process.exit(0); }
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
    item.comments.push({ body: fBody().replace(/^body=/, ''), user: { login: LOGIN }, created_at: stamp(s) });
    save(s); out({}); process.exit(0);
  }
  if (rest === '/timeline' && method === 'GET') {
    if (s.timelineFails) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
    const page = Number((query.match(/(?:^|&)page=(\\d+)/) || [])[1] || 1);
    out(page > 1 ? [] : item.timeline || []);
    process.exit(0);
  }
  if (rest === '/labels' && method === 'POST') {
    const name = fBody().replace(/^labels\\[\\]=/, '');
    item.labels = (item.labels || []).concat([name]);
    item.timeline = (item.timeline || []).concat([{ event: 'labeled', label: { name }, actor: { login: LOGIN }, created_at: stamp(s) }]);
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

// --- scripted CLAUDE agent stub (VERITY_AGENT_BIN) ----------------------------
// Reports a REAL cost (total_cost_usd) on every result — the claude-unaffected
// test proves a run whose cost is known never parks and never records a pointer.
const AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('2.1.170 (Claude Code)\\n');
  process.exit(0);
}
const queueFile = process.env.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
// Stage 111 review: GitHub moving WHILE the review runs (a push, a label).
// A push is recorded on the PR's timeline as GitHub does (round 3):
// \`head_ref_force_pushed\` with a GitHub created_at. \`heads\` is a sequence
// (A→B→A inside the review window).
if (step.duringRun) {
  const st = JSON.parse(fs.readFileSync(process.env.GH_STATE_FILE, 'utf8'));
  const d = step.duringRun;
  for (const h of d.heads || (d.head ? [d.head] : [])) {
    const pr = st.prs.find((p) => p.number === h.pr);
    pr.headRefOid = h.sha;
    st.clock = (st.clock || 0) + 1;
    pr.timeline = (pr.timeline || []).concat([{ event: 'head_ref_force_pushed', actor: { login: 'mallory' }, commit_id: null, created_at: new Date(Date.UTC(2026, 8, 1) + st.clock * 1000).toISOString() }]);
  }
  if (d.label) {
    st.clock = (st.clock || 0) + 1;
    const it = st.issues.concat(st.prs).find((i) => i.number === d.label.number);
    it.labels = (it.labels || []).concat([d.label.name]);
    it.timeline = (it.timeline || []).concat([{ event: 'labeled', label: { name: d.label.name }, actor: { login: d.label.actor }, created_at: new Date(Date.UTC(2026, 8, 1) + st.clock * 1000).toISOString() }]);
  }
  fs.writeFileSync(process.env.GH_STATE_FILE, JSON.stringify(st));
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 3,
  result: step.final, session_id: 's-1', total_cost_usd: 1.87,
  usage: { input_tokens: 400000, cache_creation_input_tokens: 10000,
           cache_read_input_tokens: 2034, output_tokens: 38112 },
}) + '\\n');
`;

// --- scripted CODEX stub (VERITY_CODEX_BIN) -----------------------------------
// Usage with NO cost — codex never reports dollars (ADR-0008). Argv log lets
// tests count how many model runs were actually dispatched — the number this
// whole stage exists to hold at one.
const CODEX_AGENT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ${MIN_CODEX}\\n');
  process.exit(0);
}
if (args[0] === 'login') { process.stdout.write('Logged in\\n'); process.exit(0); }
const path = require('node:path');
const cwd = args[args.indexOf('--cd') + 1];
const logDir = path.dirname(args[args.indexOf('--output-last-message') + 1]);
const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.verity-stub.json'), 'utf8'));
if (cfg.CODEX_ARGV_LOG) fs.appendFileSync(cfg.CODEX_ARGV_LOG, JSON.stringify(args) + '\\n');
fs.readFileSync(0, 'utf8'); // consume the stdin prompt
const queueFile = cfg.AGENT_QUEUE;
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const step = queue.shift();
fs.writeFileSync(queueFile, JSON.stringify(queue));
if (!step) { process.stdout.write('agent queue exhausted\\n'); process.exit(1); }
const lines = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: step.final } },
  { type: 'turn.completed', usage: { input_tokens: 400000, cached_input_tokens: 2034, output_tokens: 38112 } },
];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
`;

const POLICY_SUPERVISED = ['mode: supervised', 'notify:', '  mention: [seanerama]', ''].join('\n');
// Codex worker policy — DEFAULT limits (max_usd_per_day 25.0,
// unknown_cost_behavior 'gate' from autonomy defaults): the canary's shape.
const POLICY_CODEX = [
  'mode: supervised',
  'agent:',
  '  provider: codex',
  '  acknowledged_enforcement_gaps: [network]',
  'notify:',
  '  mention: [seanerama]',
  '',
].join('\n');

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-parked-resume-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const agent = path.join(dir, 'agent-stub');
  fs.writeFileSync(agent, AGENT_STUB);
  fs.chmodSync(agent, 0o755);
  const codexAgent = path.join(dir, 'codex-agent-stub');
  fs.writeFileSync(codexAgent, CODEX_AGENT_STUB);
  fs.chmodSync(codexAgent, 0o755);
  const codexArgvLog = path.join(dir, 'codex-argv.jsonl');
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: opts.issues || [], prs: opts.prs || [] }));
  const queueFile = path.join(dir, 'agent-queue.json');
  fs.writeFileSync(queueFile, JSON.stringify(opts.queue || []));
  const callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    path.join(dir, '.verity-stub.json'),
    JSON.stringify({
      CODEX_ARGV_LOG: codexArgvLog,
      AGENT_QUEUE: queueFile,
      GH_STATE_FILE: stateFile,
    }),
  );
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), opts.policy || POLICY_CODEX);
  for (const spec of opts.stages || []) {
    stage.create(dir, spec.title, spec.opts || {});
  }
  return { dir, home, bin, agent, codexAgent, codexArgvLog, stateFile, queueFile, callsFile };
}

function runWorker(fx, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
    HOME: fx.home,
    GH_STATE_FILE: fx.stateFile,
    CALLS_FILE: fx.callsFile,
    AGENT_QUEUE: fx.queueFile,
    VERITY_AGENT_BIN: fx.agent,
    ...(extra.env || {}),
  };
  try {
    const out = execFileSync('node', [WORKER, '--repo', 'octo/fixture', '--once'], {
      cwd: fx.dir,
      encoding: 'utf8',
      env,
    });
    return { code: 0, out, stderr: '' };
  } catch (err) {
    return { code: err.status, out: err.stdout || '', stderr: err.stderr || '' };
  }
}

const codexEnv = (fx) => ({ VERITY_CODEX_BIN: fx.codexAgent });
const codexArgvs = (fx) =>
  fs.existsSync(fx.codexArgvLog)
    ? fs
        .readFileSync(fx.codexArgvLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
const ghState = (fx) => JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
const itemIn = (state, n) => state.issues.concat(state.prs).find((it) => it.number === n);
const comments = (state, n) => (itemIn(state, n).comments || []).map((c) => c.body);
const labelsOf = (state, n) =>
  (itemIn(state, n).labels || []).map((l) => (typeof l === 'string' ? l : l.name));
const mergeCalls = (fx) =>
  fs
    .readFileSync(fx.callsFile, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l))
    .filter((c) => c[0] === 'pr' && c[1] === 'merge');

// usage.csv data rows split into cells. Current 12-column layout:
// timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate
const usageCells = (fx) =>
  fs
    .readFileSync(path.join(fx.dir, '.verity', 'usage.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','));

// The operator does exactly what the gate comment says: applies the label —
// as a human account (stage 111 review F3/F4: the `labeled` event, its actor
// and its logical time are what the worker judges).
function approve(fx, number, actor = 'seanerama') {
  const s = ghState(fx);
  const it = s.issues.concat(s.prs).find((i) => i.number === number);
  it.labels = (it.labels || []).concat(['verity:approved']);
  s.clock = (s.clock || 0) + 1;
  it.timeline = (it.timeline || []).concat([
    {
      event: 'labeled',
      label: { name: 'verity:approved' },
      actor: { login: actor },
      created_at: new Date(Date.UTC(2026, 8, 1) + s.clock * 1000).toISOString(),
    },
  ]);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

// A push to the PR's head branch, recorded on its timeline the way GitHub
// records it (a force-push: `head_ref_force_pushed` at the stub's next
// logical tick; stage 111 review round 3).
function setHead(fx, number, sha) {
  const s = ghState(fx);
  const pr = s.prs.find((p) => p.number === number);
  pr.headRefOid = sha;
  s.clock = (s.clock || 0) + 1;
  pr.timeline = (pr.timeline || []).concat([
    {
      event: 'head_ref_force_pushed',
      actor: { login: 'mallory' },
      commit_id: null,
      created_at: new Date(Date.UTC(2026, 8, 1) + s.clock * 1000).toISOString(),
    },
  ]);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

function assertErrorLine(stderr, code, slug) {
  const lines = stderr.split('\n').filter((l) => l !== '');
  assertEqual(lines.length, 1, `exactly one stderr line, got:\n${stderr}`);
  assert(
    new RegExp(`^verity-worker: ${code} ${slug}: .+$`).test(lines[0]),
    `stderr matches §8.2 'verity-worker: <code> <slug>: <message>', got: ${lines[0]}`,
  );
}

const marker = (outcome, extra = {}) =>
  `Done.\n${JSON.stringify({ verity: 1, outcome, gate: null, artifacts: {}, reason: 'r', ...extra })}`;

const FINDINGS = '### Review findings\n- contracts intact\n- tests are real';
const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

// The canary tick shape: a stage in review whose PR carries
// verity:awaiting-review (P2 selects it), CI green, head SHA known.
const STAGE_ISSUE = {
  number: 41,
  title: '[stage 1] Core',
  state: 'OPEN',
  labels: [],
  author: { login: 'human' },
  createdAt: '2026-06-01T00:00:00Z',
  assignees: [],
  comments: [],
};

const REVIEW_PR = {
  number: 114,
  title: '[stage 1] Core',
  state: 'OPEN',
  headRefName: 'feat/stage-1-core',
  headRefOid: HEAD_SHA,
  labels: ['verity:awaiting-review'],
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  files: ['docs/guide.md', 'README.md'],
  additions: 10,
  deletions: 5,
  checksPass: true,
  comments: [],
};

// A successful codex review that declares findings + an approve verdict — the
// exact result canary run 5 parked (and then re-bought, twice).
const APPROVE_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'approve', effects: { findings_comment: FINDINGS } },
  }),
};
// The verdict-lottery step: what a RE-dispatch would return. Any test that
// proves zero re-dispatch seeds it and asserts it was never consumed.
const FLIPPED_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'request_changes', effects: { findings_comment: FINDINGS } },
  }),
};

// Stage 111: the operator's trust-0 claude shape — real costs, so a review
// reaches the trust ladder the same tick and parks at review:merge.
const POLICY_CLAUDE = `${POLICY_SUPERVISED}limits:\n  max_usd_per_day: 25.0\n`;
const REQUEST_CHANGES_STEP = {
  final: marker('success', {
    artifacts: { pr: 114, verdict: 'request_changes', effects: { findings_comment: FINDINGS } },
  }),
};

function reviewFixture(opts = {}) {
  return fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    queue: opts.queue || [APPROVE_STEP, FLIPPED_STEP],
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}

const findingsComments = (state, n) => comments(state, n).filter((b) => b.startsWith('🔎'));
const gateComments = (state, n) => comments(state, n).filter((b) => b.startsWith('⏸️'));
const summariesOf = (state, n) => comments(state, n).filter((b) => b.startsWith('🤖'));
const parkedRunId = (gate) => (gate.match(/result of run `(run-[^`]+)`/) || [])[1];

// ---------------------------------------------------------------------------
// (1) THE REGRESSION: approve a parked review → the verdict reaches the trust
// ladder with ZERO provider dispatches and no duplicate findings comment.
// ---------------------------------------------------------------------------

test('e2e REGRESSION ADR-0014: approving the unknown-cost gate resumes the PARKED review — zero new dispatches, no duplicate findings, the APPROVED verdict reaches the ladder', () => {
  const fx = reviewFixture();

  // Tick 1: the review succeeds, findings land, the run parks at unknown-cost
  // with a durable pointer to the parked result on the gate comment.
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates, exit 0 (stderr: ${tick1.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'tick 1 paid for exactly one review run');
  let state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'tick 1 parked the gate');
  assertEqual(findingsComments(state, 114).length, 1, 'tick 1 posted the findings once');
  const gate = gateComments(state, 114)[0];
  assert(
    gate.includes(`paused at human gate \`${worker.UNKNOWN_COST_GATE}\``),
    'unknown-cost gate',
  );
  assert(
    /^parked: role `review` result of run `run-[^`]+` at PR #114 head [0-9a-f]{40}/m.test(gate),
    `the gate comment records the parked-result pointer (run id + role + head SHA), got: ${gate}`,
  );
  assert(gate.includes('ADR-0014'), 'the pointer names the decision that authorizes the resume');

  // The operator reads the findings and does exactly what the comment says.
  approve(fx, 114);

  // Tick 2: before the fix this RE-DISPATCHED review at full price (the argv
  // log grew to 2), posted a second findings comment, and the ladder received
  // the flipped request_changes verdict — not the one the human approved.
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 resumes, exit 0 (stderr: ${tick2.stderr})`);
  assertEqual(
    codexArgvs(fx).length,
    1,
    'ZERO new provider dispatches — the parked result was consumed',
  );
  state = ghState(fx);
  assertEqual(findingsComments(state, 114).length, 1, 'no duplicate findings comment');

  // The APPROVED verdict reached the trust ladder: at default trust 0 the
  // deterministic decision is the review:merge gate, never a merge and never
  // the flipped verdict a re-run would have produced.
  assertEqual(mergeCalls(fx).length, 0, 'trust 0 never merges');
  const summaries = summariesOf(state, 114);
  assertEqual(summaries.length, 2, 'each tick posted its §7 summary');
  assert(
    summaries[1].includes('gated at review:merge'),
    `the approved verdict reached the ladder, got: ${summaries[1]}`,
  );
  assert(
    summaries[1].includes('roles: review (resumed)'),
    'the summary says the role was resumed, not dispatched',
  );
  assert(
    summaries[1].includes('resumed:') && summaries[1].includes(parkedRunId(gate)),
    `the resume is recorded and attributes the parked run, got: ${summaries[1]}`,
  );
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the single-use token was consumed');

  // Resumed-run ledger rows: VERIFIED zero new cost and zero new tokens —
  // never an unknown/empty est_usd cell, never the parked run's tokens again.
  const rows = usageCells(fx);
  assertEqual(rows.length, 2, 'one row per tick');
  assertEqual(rows[0][6], '', "tick 1's cost stays unknown (empty cell — ADR-0008)");
  assertEqual(rows[1][4], '0', 'resumed run: zero tokens in');
  assertEqual(rows[1][5], '0', 'resumed run: zero tokens out');
  assertEqual(rows[1][6], '0', 'resumed run: VERIFIED zero new cost, never an unknown cell');

  // Tick 3, no fresh approval: the day still holds tick 1's gated unknown-cost
  // rows, so the startup breaker refuses — stage 21's single-use semantics.
  const tick3 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick3.code, 30, 'tick 3 refuses without a fresh approval');
  assertErrorLine(tick3.stderr, 30, 'unknown-cost-budget');
  assertEqual(codexArgvs(fx).length, 1, 'tick 3 spent no model run');
});

test('e2e ADR-0014: at trust 1 a resumed approve verdict MERGES the PR — the resume re-enters the full trust ladder, zero new dispatches', () => {
  const fx = reviewFixture({
    policy: `${POLICY_CODEX}review:\n  trust: 1\n`,
  });
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 resumes and merges (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'zero new dispatches');
  assertEqual(
    JSON.stringify(mergeCalls(fx).map((c) => c.slice(0, 3))),
    JSON.stringify([['pr', 'merge', '114']]),
    'the resumed low-risk approve verdict merged deterministically',
  );
  assertEqual(itemIn(ghState(fx), 114).state, 'MERGED', 'the PR is merged');
});

// ---------------------------------------------------------------------------
// (2) Staleness fail-closed: the PR head moved between park and approval.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: PR head moves between park and approval → the resume REFUSES loudly and a fresh dispatch is announced as a repurchase', () => {
  const fx = reviewFixture();
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);

  // The branch moves — the parked verdict examined a head that no longer exists.
  setHead(fx, 114, 'ffffffffffffffffffffffffffffffffffffffff');
  approve(fx, 114);

  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 re-dispatches (stderr: ${tick2.stderr})`);
  assertEqual(
    codexArgvs(fx).length,
    2,
    'a FRESH dispatch ran — the stale result was never consumed',
  );
  const state = ghState(fx);
  const summaries = summariesOf(state, 114);
  assert(
    summaries[1].includes('repurchase:') && summaries[1].includes('head moved'),
    `the fresh dispatch is announced as a repurchase with the reason, got: ${summaries[1]}`,
  );
  assert(!summaries[1].includes('roles: review (resumed)'), 'nothing claims a resume happened');
});

// ---------------------------------------------------------------------------
// (3) Missing/unreadable parked result: loud fallback, never a no-op.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: parked result deleted from ~/.verity/logs → loud fallback dispatch, the approval is never a no-op', () => {
  const fx = reviewFixture();
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);

  // Log rotation ate the parked run (the ADR names this exact hazard).
  fs.rmSync(path.join(fx.home, '.verity', 'logs'), { recursive: true, force: true });
  approve(fx, 114);

  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 re-dispatches (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 2, 'the approval still bought a run — a fresh one');
  const summaries = summariesOf(ghState(fx), 114);
  assert(
    summaries[1].includes('repurchase:') && summaries[1].includes('missing'),
    `the fallback is announced with its reason, got: ${summaries[1]}`,
  );
});

// ---------------------------------------------------------------------------
// (4) Stage 25 boundary: a FAILED run's park is NOT resumable — its approval
// still means "let the day proceed", exactly as stage 25 built it.
// ---------------------------------------------------------------------------

test('e2e ADR-0014 × stage 25: a FAILED park carries no pointer; its approval re-dispatches (the retry), never replays the failure', () => {
  const fx = reviewFixture({
    queue: [{ final: marker('failed', { reason: 'review found blocking defects' }) }, APPROVE_STEP],
  });
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 20, `tick 1 fails, exit 20 (stderr: ${tick1.stderr})`);
  const gate = gateComments(ghState(fx), 114)[0];
  assert(gate !== undefined, 'the stage-25 gate park is still posted');
  assert(!gate.includes('parked:'), 'a failed park records NO resumable pointer');

  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 proceeds — stage 25 semantics (stderr: ${tick2.stderr})`);
  assertEqual(codexArgvs(fx).length, 2, 'the retry DISPATCHED — a failure is never resumed');
  const summaries = summariesOf(ghState(fx), 114);
  assert(!summaries[1].includes('resumed:'), 'nothing claims a resume');
  assert(
    !summaries[1].includes('repurchase:'),
    'and no repurchase is announced — no pointer existed',
  );
});

// ---------------------------------------------------------------------------
// (5) The neighbors stay exactly what they were.
// ---------------------------------------------------------------------------

test('e2e ADR-0014: allow_with_token_limit unchanged — no unknown-cost park; the ladder runs the same tick', () => {
  const fx = reviewFixture({
    policy: `${POLICY_CODEX}limits:\n  max_usd_per_day: 25.0\n  unknown_cost_behavior: allow_with_token_limit\n`,
    queue: [APPROVE_STEP],
  });
  const { code, stderr } = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(code, 0, `run completes (stderr: ${stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'one dispatch');
  const state = ghState(fx);
  const gates = gateComments(state, 114);
  assertEqual(gates.length, 1, 'only the review:merge gate — no unknown-cost park');
  assert(gates[0].includes('review:merge'), 'the ordinary trust-0 merge gate');
  assert(!gates[0].includes(worker.UNKNOWN_COST_GATE), 'never the unknown-cost gate');
  // Stage 111 (ADR-0014 amended): the COMPLETED review's review:merge park
  // records its own pointer — anchored to this run and the reviewed head.
  assert(
    new RegExp(
      `^parked: role \`review\` result of run \`run-[^\`]+\` at PR #114 head ${HEAD_SHA} `,
      'm',
    ).test(gates[0]),
    `the review:merge park records the pointer, got: ${gates[0]}`,
  );
});

test('e2e ADR-0014: claude (real costs) never parks at unknown-cost — its only park is review:merge, which (stage 111) records a pointer', () => {
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    policy: POLICY_CLAUDE,
    queue: [APPROVE_STEP],
  });
  const tick1 = runWorker(fx); // no codex env: the claude stub reports $1.87
  assertEqual(tick1.code, 0, `claude review gates at review:merge (stderr: ${tick1.stderr})`);
  const state = ghState(fx);
  const gates = gateComments(state, 114);
  assertEqual(gates.length, 1, 'only the review:merge gate — cost is KNOWN, no unknown-cost park');
  assert(gates[0].includes('paused at human gate `review:merge`'), 'the review:merge gate');
  assert(
    /^parked: role `review` result of run `run-[^`]+` at PR #114 head [0-9a-f]{40} /m.test(
      gates[0],
    ),
    `the completed review's verdict is parked (stage 111), got: ${gates[0]}`,
  );
  // What the approval then does is the stage-111 section below.
});

// ---------------------------------------------------------------------------
// (6) Stage 111 (ADR-0014 amended 2026-09-27, #291/#292): a completed review's
// review:merge park records the pointer; at trust 0 the approval that resumes
// an approve verdict on an unchanged head IS the human merge decision.
// ---------------------------------------------------------------------------

const agentQueueLeft = (fx) => JSON.parse(fs.readFileSync(fx.queueFile, 'utf8')).length;
const claudeReviewFixture = (queue) =>
  fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    policy: POLICY_CLAUDE,
    queue,
  });
const setChecks = (fx, number, pass) => {
  const s = ghState(fx);
  s.prs.find((p) => p.number === number).checksPass = pass;
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
};
const approveLine = (body) =>
  (body.split('\n').find((l) => l.startsWith('approve: ')) || '').slice(9);

test('e2e REGRESSION stage 111 (#291): trust 0 — approving a review:merge park with an approve verdict and green CI MERGES on the consuming tick, zero model dispatches', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);

  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates at review:merge (stderr: ${tick1.stderr})`);
  assertEqual(agentQueueLeft(fx), 1, 'tick 1 paid for exactly one review');
  let state = ghState(fx);
  const gate = gateComments(state, 114)[0];
  assert(gate.includes('paused at human gate `review:merge`'), 'the review:merge gate');

  // The operator does exactly what the gate comment says.
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 merges, exit 0 (stderr: ${tick2.stderr})`);

  // Before the fix: tick 2 re-dispatched review (the flipped verdict), called
  // decideMerge with no approval input, and gated again — no merge, ever.
  assertEqual(
    JSON.stringify(mergeCalls(fx)),
    JSON.stringify([['pr', 'merge', '114', '--squash', '--match-head-commit', HEAD_SHA]]),
    'exactly one merge, pinned to the head the approved verdict examined',
  );
  assertEqual(agentQueueLeft(fx), 1, 'ZERO model dispatches on the approval tick');
  state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'MERGED', 'the PR is merged');
  assertEqual(findingsComments(state, 114).length, 1, 'no duplicate findings comment');
  const summary = summariesOf(state, 114)[1];
  assert(summary.includes('roles: review (resumed)'), `resumed, not dispatched, got: ${summary}`);
  assert(
    summary.includes('resumed:') && summary.includes(parkedRunId(gate)),
    `the summary records the resume from the parked run, got: ${summary}`,
  );
  assert(summary.includes('auto-merged PR #114'), `the summary names the merge, got: ${summary}`);
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the token was consumed by the merge');
  const rows = usageCells(fx);
  assertEqual(rows[rows.length - 1][6], '0', 'the approval tick cost a VERIFIED $0');
  // And the gate that asked for the approval told the truth about it.
  assertEqual(
    approveLine(gate),
    worker.approvalHint({ trust: 0, verdict: 'approve', greenKnown: true, mergeAuthority: true }),
    'the gate tells the truth: the label merges on the next tick',
  );
});

test('e2e stage 111: head moved after the review:merge park → loud fallback to a FRESH review, and the stale approval never merges', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, APPROVE_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);

  const MOVED = 'ffffffffffffffffffffffffffffffffffffffff';
  setHead(fx, 114, MOVED);
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-reviews (stderr: ${tick2.stderr})`);
  assertEqual(agentQueueLeft(fx), 0, 'a FRESH review was dispatched at full price');
  assertEqual(
    mergeCalls(fx).length,
    0,
    'even an approve verdict on the new head does not merge — no human has seen it',
  );
  const state = ghState(fx);
  const summary = summariesOf(state, 114)[1];
  assert(
    summary.includes('repurchase:') && summary.includes('head moved'),
    `the fallback is announced loudly, got: ${summary}`,
  );
  const regate = gateComments(state, 114)[1];
  assert(
    regate.includes(`head ${MOVED} `),
    `the re-park anchors to the head the fresh review examined, got: ${regate}`,
  );
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'gated again for a human');
});

test('e2e stage 111: a parked request_changes verdict re-gates at ZERO cost on an unchanged head — the approve line says what to do', () => {
  const fx = claudeReviewFixture([REQUEST_CHANGES_STEP, APPROVE_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const hint = worker.approvalHint({ trust: 0, verdict: 'request_changes', mergeAuthority: true });
  assertEqual(approveLine(gateComments(ghState(fx), 114)[0]), hint, 'tick 1 gate copy');

  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-gates (stderr: ${tick2.stderr})`);
  assertEqual(agentQueueLeft(fx), 1, 'ZERO dispatches — the same verdict is not re-bought');
  assertEqual(mergeCalls(fx).length, 0, 'an approval never overrides request_changes');
  const state = ghState(fx);
  const regate = gateComments(state, 114)[1];
  assert(regate.includes("verdict 'request_changes' is not approve"), 'the re-gate reason');
  assertEqual(approveLine(regate), hint, 'the re-gate copy is the request_changes hint');
  const summary = summariesOf(state, 114)[1];
  assertEqual(approveLine(summary), hint, 'the summary carries the same hint');
  assert(summary.includes('roles: review (resumed)'), 'resumed, not dispatched');
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the resume consumed the token');
  assert(labelsOf(state, 114).includes('verity:awaiting-approval'), 'gated again');
});

test('e2e stage 111: approved but CI not green → gate, the token is NOT consumed; CI turns green → the next tick merges without a new label', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  // `gh pr checks` now fails (a re-run went red / is pending) while the
  // snapshot rollup still reads the stage as in review.
  setChecks(fx, 114, false);

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 gates on CI (stderr: ${tick2.stderr})`);
  assertEqual(mergeCalls(fx).length, 0, 'never merges without a verified green reading');
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches');
  let state = ghState(fx);
  assert(
    labelsOf(state, 114).includes('verity:approved'),
    "the approval STAYS — CI lag is not the human's",
  );
  // Stage 111 review F3/F6: the waiting tick posts NO new gate comment — the
  // pause the kept label answers stays the latest bot gate comment (so the
  // label is still newer than its gate), and a comment per waiting tick is
  // the spam the attempt bound exists to stop.
  assertEqual(gateComments(state, 114).length, 1, 'no new gate comment while CI is outstanding');
  const waiting = summariesOf(state, 114)[1];
  assert(
    waiting.includes('trust 0: approved, but checks are not green — the merge waits for CI'),
    `the summary gives the reason, got: ${waiting}`,
  );
  assertEqual(
    approveLine(waiting),
    worker.approvalHint({
      trust: 0,
      verdict: 'approve',
      greenKnown: false,
      mergeAuthority: true,
      approved: true,
    }),
    'the copy says the label stays and the merge waits for CI',
  );

  setChecks(fx, 114, true);
  const tick3 = runWorker(fx); // no new label applied
  assertEqual(tick3.code, 0, `tick 3 merges (stderr: ${tick3.stderr})`);
  assertEqual(mergeCalls(fx).length, 1, 'the retried merge landed');
  assertEqual(agentQueueLeft(fx), 1, 'still zero dispatches');
  state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'MERGED', 'merged');
  assert(!labelsOf(state, 114).includes('verity:approved'), 'consumed by the merge');
});

test('e2e stage 111: a failed approved merge is reported (infra) and LEAVES the token for the next tick', () => {
  const fx = claudeReviewFixture([APPROVE_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const s = ghState(fx);
  s.prs.find((p) => p.number === 114).mergeFails = true;
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 30, `the failed merge is infra, exit 30 (stderr: ${tick2.stderr})`);
  const state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'OPEN', 'not merged');
  assert(labelsOf(state, 114).includes('verity:approved'), 'the token is left in place');
  const summary = summariesOf(state, 114)[1];
  assert(
    summary.includes('approved trust-0 merge failed') && summary.includes('left in place'),
    `the summary says so, got: ${summary}`,
  );
});

test('e2e stage 111: an unknown-cost approval consents to the COST, not the merge — the resumed approve verdict re-parks at review:merge; a second approval merges', () => {
  const fx = reviewFixture(); // codex, default trust 0, green CI
  const tick1 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick1.code, 0, `tick 1 parks at unknown-cost (stderr: ${tick1.stderr})`);
  const costGate = gateComments(ghState(fx), 114)[0];
  approve(fx, 114);
  const tick2 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick2.code, 0, `tick 2 resumes and re-parks (stderr: ${tick2.stderr})`);
  assertEqual(mergeCalls(fx).length, 0, 'one consent never becomes two');
  let state = ghState(fx);
  const mergeGate = gateComments(state, 114)[1];
  assert(mergeGate.includes('paused at human gate `review:merge`'), 'now the merge gate');
  assert(
    mergeGate.includes(`result of run \`${parkedRunId(costGate)}\` at PR #114 head ${HEAD_SHA} `),
    'the review:merge pointer names the run that produced the verdict',
  );

  approve(fx, 114);
  const tick3 = runWorker(fx, { env: codexEnv(fx) });
  assertEqual(tick3.code, 0, `tick 3 merges (stderr: ${tick3.stderr})`);
  assertEqual(codexArgvs(fx).length, 1, 'one model run across all three ticks');
  state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'MERGED', 'the second (merge) approval merged');
});

test('e2e stage 111: a parked review:merge result without a verdict refuses the resume loudly and re-reviews', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, REQUEST_CHANGES_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  // Tamper: the parked review:merge pointer now names a run whose persisted
  // result carries no verdict (a plan-shaped success).
  const gate = gateComments(ghState(fx), 114)[0];
  const runId = parkedRunId(gate);
  const logDir = path.join(fx.home, '.verity', 'logs', runId);
  for (const f of fs.readdirSync(logDir)) {
    const p = path.join(logDir, f);
    fs.writeFileSync(
      p,
      fs.readFileSync(p, 'utf8').replace(/\\?"verdict\\?":\\?"approve\\?",?/g, ''),
    );
  }
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-reviews (stderr: ${tick2.stderr})`);
  assertEqual(agentQueueLeft(fx), 0, 'a fresh review ran');
  assertEqual(mergeCalls(fx).length, 0, 'nothing merged on a verdict-less resume');
  const summary = summariesOf(ghState(fx), 114)[1];
  assert(
    summary.includes('repurchase:') && summary.includes('carries no review verdict'),
    `the refusal is loud, got: ${summary}`,
  );
});

// --- approvalHint: one test per branch -----------------------------------------

test('approvalHint: every review:merge configuration gets true copy', () => {
  const h = (o) => worker.approvalHint({ mergeAuthority: true, ...o });
  assertEqual(
    h({ trust: 0, verdict: 'approve', greenKnown: true }),
    "apply label `verity:approved` from a human account (never the worker's bot; one listed in `humans:` if set) — the next tick merges when CI is green (zero new model runs)",
  );
  assertEqual(
    h({ trust: 0, verdict: 'approve', greenKnown: false }),
    "CI is not green; apply `verity:approved` once it is, from a human account (never the worker's bot; one listed in `humans:` if set), or merge on GitHub",
  );
  assertEqual(
    h({ trust: 0, verdict: 'approve', greenKnown: false, approved: true }),
    '`verity:approved` stays applied — the next tick merges once CI is green (zero new model runs), or merge on GitHub',
  );
  const rc =
    'the review asked for changes: push a fix (new head) and apply `verity:approved` to re-review, or merge on GitHub; approving the unchanged head re-gates at zero cost';
  for (const trust of [0, 1, 2]) {
    assertEqual(h({ trust, verdict: 'request_changes' }), rc, `request_changes at trust ${trust}`);
    assertEqual(
      h({ trust, verdict: 'escalate', greenKnown: true }),
      'architectural / frozen-contract blocker: resolve via /verity:plan; approval does not merge',
      `escalate at trust ${trust}`,
    );
  }
  assertEqual(
    worker.approvalHint({ trust: 0, verdict: 'approve', greenKnown: true, mergeAuthority: false }),
    'merge on GitHub; a verdict from this runtime never merges',
    'no merge authority (ADR-0031) outranks every verdict',
  );
  // The configurations where the label can NOT advance to a merge never say
  // the bare "apply label" line.
  for (const o of [
    { trust: 0, verdict: 'escalate' },
    { trust: 0, verdict: 'approve', mergeAuthority: false },
    { trust: 1, verdict: 'approve', greenKnown: true },
    { trust: 7, verdict: 'approve', greenKnown: true },
    { trust: 0, verdict: 'approve', greenKnown: true, hasPr: false },
    { trust: 0, verdict: 'approve', greenKnown: true, resumable: false },
    { trust: 0, verdict: 'request_changes' },
    { trust: 0, verdict: null },
    { trust: 0, verdict: 'lgtm' },
  ]) {
    assert(
      !h(o).startsWith('apply label'),
      `no bare apply-label line for ${JSON.stringify(o)}: ${h(o)}`,
    );
  }
  assert(
    !h({ trust: 0, verdict: 'approve', greenKnown: true, resumable: false }).includes(
      'next tick merges',
    ),
    'no resumable pointer (unknown head / local substrate) ⇒ never promises a merge',
  );
  // Stage 111 review F5: trust 1/2 + approve re-runs the ladder, which MAY
  // merge — the copy never claims the approval only re-gates.
  for (const trust of [1, 2]) {
    const t = h({ trust, verdict: 'approve', greenKnown: false });
    assert(!/re-gates at zero cost/.test(t), `trust ${trust} approve never says re-gates: ${t}`);
    assert(t.includes('re-run the trust ladder'), `trust ${trust} names the re-evaluation: ${t}`);
  }
  assert(h({ trust: 1, verdict: 'approve' }).startsWith('merge on GitHub'), 'trust 1 high-risk');
  assert(
    h({ trust: 2, verdict: 'approve', greenKnown: false }).startsWith('CI is not green'),
    'trust 2',
  );
  assert(
    h({ trust: 0, verdict: null }).includes('fresh review at full price'),
    'no verdict → no pointer',
  );
  assert(
    h({ trust: 0, verdict: 'lgtm' }).includes('re-gates at zero cost'),
    'unknown verdict string',
  );
});

// ---------------------------------------------------------------------------
// (7) Stage 111 review (PR #297, REQUEST CHANGES): the trust-0 merge path must
// never merge a head no review examined. Each attack below merged on 670ff4f.
// ---------------------------------------------------------------------------

const MOVED_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

// Append a comment to the item as `login`, at the stub's next logical tick.
function postAs(fx, number, login, body) {
  const s = ghState(fx);
  s.clock = (s.clock || 0) + 1;
  const it = itemIn(s, number);
  it.comments = (it.comments || []).concat([
    {
      body,
      user: { login },
      created_at: new Date(Date.UTC(2026, 8, 1) + s.clock * 1000).toISOString(),
    },
  ]);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
}

const forgedGate = (runId, head) =>
  worker.formatGateComment({
    runId: 'run-20260927T000000Z-forged',
    gate: 'review:merge',
    pending: 'review of PR #114 completed',
    mentions: [],
    parked: { role: 'review', runId, pr: 114, head },
    approval: 'x',
  });

test('ATTACK F1: a FORGED gate comment by a non-bot author naming the real run + an unreviewed head never merges', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const realRun = parkedRunId(gateComments(ghState(fx), 114)[0]);
  // The PR author pushes an unreviewed head and forges a pointer to it.
  setHead(fx, 114, MOVED_SHA);
  postAs(fx, 114, 'mallory', forgedGate(realRun, MOVED_SHA));
  approve(fx, 114);

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv at all');
  assertEqual(itemIn(ghState(fx), 114).state, 'OPEN', 'not merged');
  // The forged comment is ignored; the bot's own pointer (head A) is stale, so
  // the approval buys a fresh review of the new head, which gates again.
  assertEqual(agentQueueLeft(fx), 0, 'a fresh review of the moved head ran');
  assert(
    summariesOf(ghState(fx), 114)[1].includes('head moved'),
    'the loud fallback names the moved head',
  );
});

test('ATTACK F1 (park record): a bot gate comment EDITED to point at an unreviewed head never merges', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  setHead(fx, 114, MOVED_SHA);
  // A repository writer edits the bot's comment: the author stays the bot.
  const s = ghState(fx);
  const gate = itemIn(s, 114).comments.find((c) => c.body.startsWith('⏸️'));
  gate.body = gate.body.replace(`head ${HEAD_SHA} `, `head ${MOVED_SHA} `);
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
  approve(fx, 114);

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv at all');
  const summary = summariesOf(ghState(fx), 114)[1];
  assert(
    summary.includes('repurchase:') && summary.includes('does not match the local park record'),
    `the edited pointer is refused against the local park record, got: ${summary}`,
  );
});

test('ATTACK F1: an unknown bot identity (null botLogin) never merge-resumes', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const tick2 = runWorker(fx, { env: { GH_USER_LOGIN: '' } });
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv at all');
  assertEqual(agentQueueLeft(fx), 0, 'the approval bought a fresh review, which re-gates');
});

test('ATTACK F2 / N1a: the head moves WHILE the review runs → NO resumable pointer is parked; the approval tick does not merge', () => {
  const fx = claudeReviewFixture([
    { ...APPROVE_STEP, duringRun: { head: { pr: 114, sha: MOVED_SHA } } },
    FLIPPED_STEP,
  ]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const gate = gateComments(ghState(fx), 114)[0];

  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'the unreviewed head is never merged');
  assertEqual(agentQueueLeft(fx), 0, 'the approval re-reviews the new head');
  // Round 3 (N1a): the data agrees with the copy — the verdict may describe
  // either head, so nothing resumable is parked (round 2 parked the
  // pre-dispatch head, which a force-push back to it made resumable again).
  assert(!/^parked: /m.test(gate), `no parked pointer at all, got: ${gate}`);
  assert(gate.includes('head moved while the review ran'), `the gate copy says so: ${gate}`);
  assert(!approveLine(gate).includes('next tick merges'), 'the copy never promises a merge');
});

// --- stage 111 review round 3 (N1): A→B→A must never merge -------------------

// The PR's timeline events, as the stub holds them.
const prTimeline = (fx, n) => itemIn(ghState(fx), n).timeline || [];
const parkRecordOf = (fx, runId) =>
  JSON.parse(fs.readFileSync(path.join(fx.home, '.verity', 'logs', runId, 'park.json'), 'utf8'));

test('ATTACK N1 (across the gate): head A→B during the review, force-pushed back to A, a human label → no merge, no merge argv', () => {
  const fx = claudeReviewFixture([
    { ...APPROVE_STEP, duringRun: { head: { pr: 114, sha: MOVED_SHA } } },
    FLIPPED_STEP,
  ]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  // The PR author force-pushes the reviewed SHA back after the gate.
  setHead(fx, 114, HEAD_SHA);
  approve(fx, 114); // a real human, after the gate comment
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  // On 9711592: `pr merge 114 --squash --match-head-commit <A>`, zero dispatches.
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv at all');
  assertEqual(itemIn(ghState(fx), 114).state, 'OPEN', 'not merged');
  assertEqual(agentQueueLeft(fx), 0, 'the approval bought a fresh review (which re-gates)');
});

test('ATTACK N1 (inside the window): A→B→A entirely while the review runs (park-time read sees A) → the approval tick refuses the resume, no merge', () => {
  const fx = claudeReviewFixture([
    {
      ...APPROVE_STEP,
      duringRun: {
        heads: [
          { pr: 114, sha: MOVED_SHA },
          { pr: 114, sha: HEAD_SHA },
        ],
      },
    },
    FLIPPED_STEP,
  ]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const gate = gateComments(ghState(fx), 114)[0];
  // Undetectable at park time: the head is A again, so a pointer IS parked…
  assert(
    new RegExp(
      `^parked: role \`review\` result of run \`run-[^\`]+\` at PR #114 head ${HEAD_SHA} `,
      'm',
    ).test(gate),
    `the park-time read sees A — a pointer is parked, got: ${gate}`,
  );

  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  // On 9711592: `pr merge 114 --squash --match-head-commit <A>`, zero dispatches.
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv at all');
  assertEqual(agentQueueLeft(fx), 0, 'the resume was refused — a fresh review ran');
  const summary = summariesOf(ghState(fx), 114)[1];
  assert(
    summary.includes('repurchase:') &&
      summary.includes('pushed to after the review read its head') &&
      summary.includes('head_ref_force_pushed'),
    `the refusal is loud and names the push, got: ${summary}`,
  );
  const regate = gateComments(ghState(fx), 114)[1];
  assert(labelsOf(ghState(fx), 114).includes('verity:awaiting-approval'), 'gated again');
  assert(regate !== undefined, 'the fresh review re-gated for a human');
  // The parked run's record holds the GitHub-side time of the pre-dispatch
  // head read (0600, never posted), and both pushes are after it.
  const runId = parkedRunId(gate);
  const rec = parkRecordOf(fx, runId);
  assert(
    typeof rec.head_read_at === 'string',
    `park.json records head_read_at: ${JSON.stringify(rec)}`,
  );
  assert(!gate.includes(rec.head_read_at), 'the read time is local-only, not posted');
  const mode = fs.statSync(path.join(fx.home, '.verity', 'logs', runId, 'park.json')).mode & 0o777;
  assertEqual(mode, 0o600, 'park.json stays 0600');
  const pushes = prTimeline(fx, 114).filter((e) => e.event === 'head_ref_force_pushed');
  assertEqual(pushes.length, 2, 'the fixture pushed twice inside the window');
  assert(
    pushes.every((e) => Date.parse(e.created_at) >= Date.parse(rec.head_read_at)),
    'both pushes are after the recorded read',
  );
});

test('N1 happy path: pushes only BEFORE the review read its head (a force-push + A’s own commit) → the human approval still merges with zero dispatches', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  // Before tick 1: the builder force-pushed A (a push BEFORE the pre-dispatch
  // read), and the timeline lists A's own commit (never counted as a push).
  setHead(fx, 114, HEAD_SHA);
  const s = ghState(fx);
  s.prs
    .find((p) => p.number === 114)
    .timeline.push({
      event: 'committed',
      sha: HEAD_SHA,
      author: { date: '2026-09-01T00:00:01Z' },
      committer: { date: '2026-09-01T00:00:01Z' },
    });
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 merges (stderr: ${tick2.stderr})`);
  assertEqual(
    JSON.stringify(mergeCalls(fx)),
    JSON.stringify([['pr', 'merge', '114', '--squash', '--match-head-commit', HEAD_SHA]]),
    'exactly one pinned merge',
  );
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches on the approval tick');
  // The PR IS the labeled item: its timeline is read ONCE on the approval tick
  // (push check + label judgement share it).
  const timelineReads = fs
    .readFileSync(fx.callsFile, 'utf8')
    .split('\n')
    .filter((l) => l.includes('/issues/114/timeline'));
  assertEqual(timelineReads.length, 1, 'one timeline read serves both checks');
});

test('N1: a park record with no head-read time (parked before round 3) never merge-resumes — loud fresh review', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const runId = parkedRunId(gateComments(ghState(fx), 114)[0]);
  const file = path.join(fx.home, '.verity', 'logs', runId, 'park.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.head_read_at = undefined;
  fs.writeFileSync(file, JSON.stringify(rec));
  approve(fx, 114);
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv');
  assertEqual(agentQueueLeft(fx), 0, 'a fresh review ran');
  assert(
    summariesOf(ghState(fx), 114)[1].includes('carries no GitHub-side time'),
    'the refusal names the missing read time',
  );
});

test('pushesSince: push-type events at/after the read refuse; earlier ones, the reviewed commit and non-push events pass; unreadable fails closed', () => {
  const since = '2026-09-01T00:00:10Z';
  const head = HEAD_SHA;
  const at = (event, created_at) => ({ event, created_at });
  const c = (sha, date) => ({ event: 'committed', sha, committer: { date } });
  const ok = (events) => worker.pushesSince(events, { since, head }).ok;
  assertEqual(ok([]), true, 'no events');
  for (const ev of [
    'head_ref_force_pushed',
    'head_ref_restored',
    'head_ref_deleted',
    'base_ref_force_pushed',
    'base_ref_changed',
  ]) {
    assertEqual(ok([at(ev, '2026-09-01T00:00:11Z')]), false, `${ev} after`);
    assertEqual(ok([at(ev, '2026-09-01T00:00:10Z')]), false, `${ev} at the same instant`);
    assertEqual(ok([at(ev, '2026-09-01T00:00:09Z')]), true, `${ev} before`);
    assertEqual(ok([at(ev, 'garbage')]), false, `${ev} with no readable time`);
  }
  assertEqual(ok([c(MOVED_SHA, '2026-09-01T00:00:11Z')]), false, 'a commit after');
  assertEqual(ok([c(MOVED_SHA, '2026-09-01T00:00:09Z')]), true, 'a commit before');
  assertEqual(ok([c(MOVED_SHA, null)]), false, 'a commit with no date');
  assertEqual(ok([c(HEAD_SHA, '2026-09-01T00:00:11Z')]), true, "the reviewed head's own commit");
  assertEqual(
    ok([{ event: 'committed', sha: MOVED_SHA, author: { date: '2026-09-01T00:00:12Z' } }]),
    false,
    'author.date is the fallback',
  );
  assertEqual(ok([at('labeled', '2026-09-01T00:00:11Z')]), true, 'a label is not a push');
  assertEqual(worker.pushesSince(null, { since, head }).ok, false, 'not a list');
  assertEqual(worker.pushesSince([], { since: null, head }).ok, false, 'no read time');
  assertEqual(
    JSON.stringify(worker.PUSH_EVENTS),
    JSON.stringify([
      'committed',
      'head_ref_force_pushed',
      'head_ref_restored',
      'head_ref_deleted',
      'base_ref_force_pushed',
      'base_ref_changed',
    ]),
    'the documented push-type event set',
  );
});

test('ATTACK F3: `verity:approved` applied BEFORE the gate comment (while the review ran) never merges — it buys a zero-cost re-gate; a label after the new gate merges', () => {
  const fx = claudeReviewFixture([
    {
      ...APPROVE_STEP,
      duringRun: { label: { number: 114, name: 'verity:approved', actor: 'seanerama' } },
    },
    FLIPPED_STEP,
  ]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  assert(labelsOf(ghState(fx), 114).includes('verity:approved'), 'the early label survived tick 1');

  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-gates (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge before any human saw the verdict');
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches — the parked verdict re-gated');
  let state = ghState(fx);
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the stale label was consumed');
  const regate = gateComments(state, 114)[1];
  assert(regate.includes('was not honoured as the merge decision'), `says why: ${regate}`);

  approve(fx, 114); // a human, after the new gate comment
  const tick3 = runWorker(fx);
  assertEqual(tick3.code, 0, `tick 3 merges (stderr: ${tick3.stderr})`);
  assertEqual(mergeCalls(fx).length, 1, 'the fresh approval merges');
  assertEqual(agentQueueLeft(fx), 1, 'still one model run in total');
  state = ghState(fx);
  assertEqual(itemIn(state, 114).state, 'MERGED', 'merged');
});

test('ATTACK F4: `verity:approved` applied by the worker bot itself never merges', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114, 'verity-bot');
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-gates (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv');
  assert(
    gateComments(ghState(fx), 114)[1].includes("worker's own bot identity"),
    'the re-gate says why',
  );
});

test('ATTACK F4: with `humans:` configured, a label by an unlisted actor never merges; a listed human applying it after the gate merges with zero dispatches', () => {
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR)],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CLAUDE}humans: [seanerama]\n`,
    queue: [APPROVE_STEP, FLIPPED_STEP],
  });
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114, 'triage-bot'); // triage role / issues:write integration
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-gates (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'an unlisted labeler has no merge authority');
  assert(gateComments(ghState(fx), 114)[1].includes('not listed in the policy'), 'says why');

  approve(fx, 114, 'SeaneRama'); // listed (logins are case-insensitive)
  const tick3 = runWorker(fx);
  assertEqual(tick3.code, 0, `tick 3 merges (stderr: ${tick3.stderr})`);
  assertEqual(
    JSON.stringify(mergeCalls(fx)),
    JSON.stringify([['pr', 'merge', '114', '--squash', '--match-head-commit', HEAD_SHA]]),
    'the listed human merges, pinned',
  );
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches across both approval ticks');
});

test('ATTACK F3: an unreadable label timeline fails closed — no merge, a zero-cost re-gate', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const s = ghState(fx);
  s.timelineFails = true;
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
  const tick2 = runWorker(fx);
  assertEqual(tick2.code, 0, `tick 2 re-gates (stderr: ${tick2.stderr})`);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge on an unread timeline');
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches');
  assert(gateComments(ghState(fx), 114)[1].includes('could not be read'), 'says why');
});

test('ATTACK F6: approved but CI stays red → bounded: needs-human after MAX_APPROVED_MERGE_ATTEMPTS ticks, no further gate comments', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  setChecks(fx, 114, false);
  const n = 3; // the documented bound (asserted against the export below)
  for (let i = 1; i < n; i += 1) {
    const t = runWorker(fx);
    assertEqual(t.code, 0, `waiting tick ${i} (stderr: ${t.stderr})`);
    assert(labelsOf(ghState(fx), 114).includes('verity:approved'), `label kept on tick ${i}`);
  }
  const last = runWorker(fx);
  assertEqual(last.code, 20, `the bound parks the item (failed, exit 20; stderr: ${last.stderr})`);
  const state = ghState(fx);
  assertEqual(gateComments(state, 114).length, 1, 'no gate comment was added by any retry tick');
  assert(labelsOf(state, 114).includes('verity:needs-human'), 'parked needs-human');
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the token is consumed');
  assertEqual(mergeCalls(fx).length, 0, 'never merged on red CI');
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches throughout');
  const after = runWorker(fx);
  assertEqual(after.code, 0, `the parked item is not re-selected (stderr: ${after.stderr})`);
  assertEqual(gateComments(ghState(fx), 114).length, 1, 'still no new gate comment');
  assertEqual(worker.MAX_APPROVED_MERGE_ATTEMPTS, n, 'the exported bound is the documented one');
});

test('ATTACK F6: a merge GitHub keeps refusing → bounded: needs-human after MAX_APPROVED_MERGE_ATTEMPTS ticks', () => {
  const fx = claudeReviewFixture([APPROVE_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  approve(fx, 114);
  const s = ghState(fx);
  s.prs.find((p) => p.number === 114).mergeFails = true;
  fs.writeFileSync(fx.stateFile, JSON.stringify(s));
  const n = 3; // the documented bound
  for (let i = 1; i < n; i += 1) {
    const t = runWorker(fx);
    assertEqual(t.code, 30, `failed merge ${i} is infra (stderr: ${t.stderr})`);
  }
  const last = runWorker(fx);
  assertEqual(last.code, 20, `the bound parks the item (stderr: ${last.stderr})`);
  const state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:needs-human'), 'parked needs-human');
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the token is consumed');
  assertEqual(gateComments(state, 114).length, 1, 'no gate comment spam');
  assertEqual(mergeCalls(fx).length, n, 'one refused merge attempt per tick, never more');
});

test('ATTACK N4: a REFUSED label does not reset the F6 attempt counter — the bound still fires after MAX_APPROVED_MERGE_ATTEMPTS honoured ticks across the re-gate', () => {
  const fx = claudeReviewFixture([APPROVE_STEP, FLIPPED_STEP]);
  const tick1 = runWorker(fx);
  assertEqual(tick1.code, 0, `tick 1 gates (stderr: ${tick1.stderr})`);
  const runId = parkedRunId(gateComments(ghState(fx), 114)[0]);
  approve(fx, 114); // a human
  setChecks(fx, 114, false); // CI stays red throughout
  const t2 = runWorker(fx);
  assertEqual(t2.code, 0, `honoured tick 1 waits on CI (stderr: ${t2.stderr})`);
  assertEqual(parkRecordOf(fx, runId).approval.attempts, 1, 'attempt 1 recorded');

  approve(fx, 114, 'verity-bot'); // an untrusted label: refused → zero-cost re-gate
  const t3 = runWorker(fx);
  assertEqual(t3.code, 0, `the refused label re-gates (stderr: ${t3.stderr})`);
  assertEqual(gateComments(ghState(fx), 114).length, 2, 'the re-gate posted a new gate comment');
  assertEqual(
    parkRecordOf(fx, runId).approval?.attempts,
    1,
    'the re-park carried the counter (9711592 reset it to null)',
  );

  approve(fx, 114); // the human again, after the new gate
  const t4 = runWorker(fx);
  assertEqual(t4.code, 0, `honoured tick 2 waits on CI (stderr: ${t4.stderr})`);
  assertEqual(parkRecordOf(fx, runId).approval.attempts, 2, 'the count continued');
  const t5 = runWorker(fx);
  assertEqual(
    t5.code,
    20,
    `honoured tick 3 hits the bound → needs-human, exit 20 (stderr: ${t5.stderr})`,
  );
  const state = ghState(fx);
  assert(labelsOf(state, 114).includes('verity:needs-human'), 'parked needs-human');
  assert(!labelsOf(state, 114).includes('verity:approved'), 'the token is consumed');
  assertEqual(mergeCalls(fx).length, 0, 'never merged on red CI');
  assertEqual(agentQueueLeft(fx), 1, 'zero dispatches throughout');
  assertEqual(parkRecordOf(fx, runId).approval, null, 'the bound resets the counter');
});

test('N2 (F11): at trust 2 a verdict naming PR #115 on a review dispatched for PR #114 neither merges nor parks a pointer; its findings land on #114, never #115', () => {
  const OTHER = {
    ...structuredClone(REVIEW_PR),
    number: 115,
    title: 'someone else',
    headRefName: 'feat/other',
    headRefOid: MOVED_SHA,
    labels: [],
  };
  const fx = fixture({
    issues: [structuredClone(STAGE_ISSUE)],
    prs: [structuredClone(REVIEW_PR), OTHER],
    stages: [{ title: 'Core' }],
    policy: `${POLICY_CLAUDE}review:\n  trust: 2\n`,
    queue: [
      {
        final: marker('success', {
          artifacts: { pr: 115, verdict: 'approve', effects: { findings_comment: FINDINGS } },
        }),
      },
    ],
  });
  const tick = runWorker(fx);
  assertEqual(JSON.stringify(mergeCalls(fx)), '[]', 'no merge argv — neither #114 nor #115');
  assertEqual(tick.code, 0, `the tick gates (stderr: ${tick.stderr})`);
  const state = ghState(fx);
  assertEqual(itemIn(state, 115).state, 'OPEN', '#115 untouched');
  assertEqual(comments(state, 115).length, 0, 'nothing is written to the model-named PR');
  assertEqual(labelsOf(state, 115).length, 0, 'no label on the model-named PR');
  assertEqual(findingsComments(state, 114).length, 1, 'the findings land on the dispatched PR');
  const gate = gateComments(state, 114)[0];
  assert(gate !== undefined, 'the gate is on the PR the review was dispatched for');
  assert(gate.includes('dispatched for PR #114'), `the gate says why: ${gate}`);
  assert(!/^parked: /m.test(gate), `no pointer is parked: ${gate}`);
  const logs = path.join(fx.home, '.verity', 'logs');
  const records = fs.existsSync(logs)
    ? fs.readdirSync(logs).filter((d) => fs.existsSync(path.join(logs, d, 'park.json')))
    : [];
  assertEqual(records.length, 0, 'no local park record either');
});

test('N3: readTimeline fails closed when its LAST allowed page is full — never judges a truncated timeline', () => {
  const full = () => Array.from({ length: worker.TIMELINE_PER_PAGE }, () => ({ event: 'x' }));
  let calls = 0;
  let threw = null;
  try {
    worker.readTimeline('o/r', 7, () => {
      calls += 1;
      return full();
    });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'a timeline that fills every allowed page throws');
  assert(/truncated/.test(threw.message), `says why: ${threw?.message}`);
  assertEqual(calls, worker.TIMELINE_MAX_PAGES, 'bounded: exactly the page cap, never more');
  // One page short of the cap is complete and returned whole.
  calls = 0;
  const events = worker.readTimeline('o/r', 7, () => {
    calls += 1;
    return calls < worker.TIMELINE_MAX_PAGES ? full() : [{ event: 'last' }];
  });
  assertEqual(
    events.length,
    (worker.TIMELINE_MAX_PAGES - 1) * worker.TIMELINE_PER_PAGE + 1,
    'a partial last page ends the read',
  );
});

test('judgeApprovalEvent: newer-than-gate, not-the-bot, in-humans; everything else fails closed', () => {
  const gateAt = '2026-09-01T00:00:10.000Z';
  const ev = (actor, at, name = 'verity:approved') => ({
    event: 'labeled',
    label: { name },
    actor: { login: actor },
    created_at: at,
  });
  const j = (events, humans = []) =>
    worker.judgeApprovalEvent(events, { gateAt, botLogin: 'verity-bot', humans });
  assertEqual(j([ev('sean', '2026-09-01T00:00:11Z')]).ok, true, 'a human after the gate');
  assertEqual(j([ev('sean', '2026-09-01T00:00:10Z')]).ok, false, 'same instant ⇒ not after');
  assertEqual(j([ev('sean', '2026-09-01T00:00:09Z')]).ok, false, 'before the gate');
  assertEqual(j([ev('Verity-Bot', '2026-09-01T00:00:11Z')]).ok, false, 'the bot (any case)');
  assertEqual(j([ev('sean', '2026-09-01T00:00:11Z')], ['alice']).ok, false, 'not in humans');
  assertEqual(j([ev('Alice', '2026-09-01T00:00:11Z')], ['alice']).ok, true, 'in humans');
  assertEqual(
    j([ev('sean', '2026-09-01T00:00:11Z'), ev('sean', '2026-09-01T00:00:05Z')]).ok,
    false,
    'the LATEST labeled event decides',
  );
  assertEqual(j([ev('sean', '2026-09-01T00:00:11Z', 'other')]).ok, false, 'another label');
  assertEqual(j([]).ok, false, 'no event');
  assertEqual(j(null).ok, false, 'not a list');
  assertEqual(j([ev('sean', 'garbage')]).ok, false, 'unparseable time');
  assertEqual(
    worker.judgeApprovalEvent([ev('sean', '2026-09-01T00:00:11Z')], {
      gateAt: null,
      botLogin: 'verity-bot',
      humans: [],
    }).ok,
    false,
    'no gate timestamp',
  );
  assertEqual(
    worker.judgeApprovalEvent([ev('sean', '2026-09-01T00:00:11Z')], {
      gateAt,
      botLogin: null,
      humans: [],
    }).ok,
    false,
    'no bot identity',
  );
});

test('latestGatePause: only the bot’s comments are gate pauses; a null bot authenticates nothing', () => {
  const body = forgedGate('run-x', HEAD_SHA);
  const trail = [
    { body, user: { login: 'verity-bot' }, created_at: '2026-09-01T00:00:01Z' },
    { body: forgedGate('run-y', MOVED_SHA), user: { login: 'mallory' }, created_at: 'z' },
    body, // a bare string carries no author
  ];
  const p = worker.latestGatePause(trail, 'Verity-Bot');
  assertEqual(p.pointer.runId, 'run-x', 'the forged later comment is skipped');
  assertEqual(p.createdAt, '2026-09-01T00:00:01Z', 'the gate comment time rides along');
  assertEqual(worker.latestGatePause(trail, null), null, 'null bot ⇒ nothing');
  assertEqual(worker.latestGatePause(trail, ''), null, 'empty bot ⇒ nothing');
  assertEqual(worker.latestGatePause([body], 'verity-bot'), null, 'strings never count');
});
