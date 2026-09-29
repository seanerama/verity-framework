// Stage 113 (ADR-0038, contract operator-init v1 incl. the 2026-09-29 additive
// amendment) — `verity init`, the non-interactive project bootstrap.
//
//   - wire shape: an ok result on EACH substrate carries every contract field
//     with the right type; steps[].step is the fixed vocabulary in table order;
//     the breaker label is on the intake by default and absent with --start.
//   - refuse-before-effect: one test per preflight refusal — exit 2, a single
//     preflight step, the target (and its parent) byte-unchanged, and NO gh
//     call (only the `gh auth status` read in the gh-auth refusal itself).
//   - local substrate end to end with REAL git (no gh anywhere): initial
//     commit, bare origin + origin/HEAD, the register committed and present at
//     the bare origin's main, the work-item record, the verbatim spec, a live
//     `operator snapshot`, and a refused re-run that changes nothing.
//   - github substrate through a FAKE gh (argv recorded): repo create flags
//     (--private default), labels, the intake's labels + pointer body, no
//     re-issue of `gh repo create` / `gh issue create` after an ambiguous
//     failure (read-back ⇒ confirmed_by), partial failure truncation.
//   - gates only from --gate (else honestly skipped), the starter policy
//     through autonomy's own loader, and no secret in any output field.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const init = require('../verity/bin/lib/init.cjs');
const autonomy = require('../verity/bin/lib/autonomy.cjs');
const gates = require('../verity/bin/lib/gates.cjs');
const sub = require('../verity/bin/lib/substrate-local.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const NOW = new Date(Date.UTC(2026, 8, 29, 18, 0, 0));
const SPEC_TEXT =
  '# Widget Tracker: tracks widgets\n\nThe full spec body, never pasted into the issue.\n';
const TITLE = 'Widget Tracker: tracks widgets';
const SLUG = 'widget-tracker';
const REPO = `me/${SLUG}`;
const noop = () => {};

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-init-${tag}-`));
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// The suite must not depend on the machine's git config: every test runs with
// an isolated global config carrying a commit identity and no signing.
const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'VERITY_SUBSTRATE',
];
function withGitEnv(fn) {
  const home = tmp('gitcfg');
  const cfg = path.join(home, 'gitconfig');
  fs.writeFileSync(
    cfg,
    '[user]\n\tname = Verity Init Test\n\temail = init@verity.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n',
  );
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// A byte-level fingerprint of a directory tree (or 'ABSENT').
function treeHash(p) {
  if (!fs.existsSync(p)) {
    return 'ABSENT';
  }
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.lstatSync(f).isDirectory()) {
        h.update(`D:${r}\n`);
        walk(f, r);
      } else {
        h.update(`F:${r}\n`);
        h.update(fs.readFileSync(f));
      }
    }
  };
  walk(p, '');
  return h.digest('hex');
}

function okRes(stdout) {
  return { status: 0, error: null, signal: null, stdout, stderr: '' };
}

function failRes(stderr, status = 1) {
  return { status, error: null, signal: null, stdout: '', stderr };
}

function timeoutRes() {
  const error = Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { status: null, error, signal: 'SIGTERM', stdout: '', stderr: '' };
}

// The fake-gh spawn: every gh call is recorded (argv + stdin) and answered by
// `script[<verb> <sub>]` or a default; git's network verbs (fetch, push,
// remote set-head) are recorded and faked; every other git runs for real.
function fakeGithub(script = {}) {
  const calls = [];
  const gitNet = [];
  let issueSeq = 0;
  const spawn = (cmd, args, options = {}) => {
    if (cmd === 'gh') {
      calls.push({ args: [...args], input: options.input });
      const key = `${args[0]} ${args[1]}`;
      if (script[key]) {
        const r = script[key](args, calls);
        if (r) {
          return r;
        }
      }
      if (key === 'auth status' || key === 'label create' || key === 'label edit') {
        return okRes('');
      }
      if (key === 'repo create') {
        return okRes(`https://github.com/${args[2]}\n`);
      }
      if (key === 'repo view') {
        return okRes('{"name":"x"}');
      }
      if (key === 'label list' || key === 'issue list') {
        return okRes('[]');
      }
      if (key === 'issue create') {
        issueSeq += 1;
        return okRes(`https://github.com/${args[args.indexOf('--repo') + 1]}/issues/${issueSeq}\n`);
      }
      return failRes(`unscripted gh ${args.join(' ')}`);
    }
    if (
      cmd === 'git' &&
      (args[0] === 'fetch' ||
        args[0] === 'push' ||
        (args[0] === 'remote' && args[1] === 'set-head'))
    ) {
      gitNet.push([...args]);
      return okRes('');
    }
    return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  };
  const ghOf = (verb, subverb) => calls.filter((c) => c.args[0] === verb && c.args[1] === subverb);
  return { spawn, calls, gitNet, ghOf };
}

// A spawn that runs everything for real but FAILS (and records) any gh call —
// the local substrate must never reach GitHub.
function noGhSpawn() {
  const ghCalls = [];
  const spawn = (cmd, args, options = {}) => {
    if (cmd === 'gh') {
      ghCalls.push([...args]);
      return failRes('gh is forbidden on the local substrate', 97);
    }
    return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  };
  return { spawn, ghCalls };
}

function workspace(tag) {
  const root = tmp(tag);
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, SPEC_TEXT);
  return { root, spec, target: path.join(root, 'proj') };
}

function baseOpts(ws, spawn, extra = {}) {
  return {
    path: ws.target,
    spec: ws.spec,
    name: 'Widget Tracker',
    owner: 'me',
    substrate: 'github',
    gates: [],
    spawn,
    sleep: noop,
    now: NOW,
    cwd: ws.root,
    ...extra,
  };
}

const TOP_KEYS = [
  'schema',
  'ok',
  'outcome',
  'path',
  'identity',
  'substrate',
  'repo',
  'remote',
  'default_branch',
  'spec',
  'intake',
  'policy',
  'steps',
  'reason',
];

function assertStepShape(steps) {
  for (const s of steps) {
    for (const k of Object.keys(s)) {
      assert(
        ['step', 'ok', 'detail', 'skipped', 'confirmed_by'].includes(k),
        `step key ${k} is in the contract`,
      );
    }
    assert(init.STEPS.includes(s.step), `step ${s.step} is in the vocabulary`);
    assertEqual(typeof s.ok, 'boolean', `${s.step}.ok boolean`);
    if (s.ok === false) {
      assertEqual(typeof s.detail, 'string', `${s.step} failure carries a detail`);
    }
  }
  // Table order: each step's index strictly increases.
  const idx = steps.map((s) => init.STEPS.indexOf(s.step));
  for (let i = 1; i < idx.length; i += 1) {
    assert(idx[i] > idx[i - 1], 'steps are in table order');
  }
}

function assertOkWire(r, substrate) {
  assertEqual(Object.keys(r).join(','), TOP_KEYS.join(','), 'top-level keys (contract order)');
  assertEqual(r.schema, 1, 'schema');
  assertEqual(r.ok, true, 'ok');
  assertEqual(r.outcome, 'ok', 'outcome');
  assertEqual(init.exitCodeFor(r), 0, 'exit 0');
  assert(typeof r.path === 'string' && path.isAbsolute(r.path), 'path absolute');
  assertEqual(Object.keys(r.identity).join(','), 'name,slug,owner', 'identity keys');
  assertEqual(r.identity.name, 'Widget Tracker', 'identity.name');
  assertEqual(r.identity.slug, SLUG, 'identity.slug');
  assertEqual(r.identity.owner, 'me', 'identity.owner');
  assertEqual(r.substrate, substrate, 'substrate');
  assertEqual(r.default_branch, 'main', 'default_branch');
  assertEqual(Object.keys(r.spec).join(','), 'path,commit,title', 'spec keys');
  assertEqual(r.spec.path, 'docs/spec.md', 'spec.path');
  assert(/^[0-9a-f]{7,39}$/.test(r.spec.commit), 'spec.commit is a short sha');
  assertEqual(r.spec.title, TITLE, 'spec.title');
  assertEqual(Object.keys(r.intake).join(','), 'number,kind,url,labels,registered', 'intake keys');
  assert(Number.isInteger(r.intake.number), 'intake.number integer');
  assert(Array.isArray(r.intake.labels), 'intake.labels array');
  assertEqual(r.intake.registered, true, 'intake.registered');
  assertEqual(Object.keys(r.policy).join(','), 'path,mode,trust,circuit_open', 'policy keys');
  assertEqual(r.policy.path, '.verity/autonomy.yml', 'policy.path');
  assertEqual(r.policy.mode, 'supervised', 'policy.mode');
  assertEqual(r.policy.trust, 0, 'policy.trust');
  assertEqual(typeof r.policy.circuit_open, 'boolean', 'policy.circuit_open boolean');
  assertEqual(r.reason, null, 'reason null on ok');
  assertEqual(r.steps.map((s) => s.step).join(','), init.STEPS.join(','), 'full step vocabulary');
  assert(
    r.steps.every((s) => s.ok === true),
    'every step ok',
  );
  assertStepShape(r.steps);
  if (substrate === 'github') {
    assertEqual(r.repo, REPO, 'repo owner/slug');
    assertEqual(r.remote, `https://github.com/${REPO}`, 'remote is the GitHub URL');
    assertEqual(r.intake.kind, 'issue', 'intake.kind issue');
    assertEqual(r.intake.url, `https://github.com/${REPO}/issues/${r.intake.number}`, 'intake.url');
  } else {
    assertEqual(r.repo, null, 'repo null on local');
    assertEqual(r.remote, `${r.path}-origin.git`, 'remote is the bare repo path');
    assertEqual(r.intake.kind, 'record', 'intake.kind record');
    assertEqual(r.intake.url, null, 'intake.url null on local');
    const labels = r.steps.find((s) => s.step === 'labels');
    assertEqual(labels.skipped, true, 'labels skipped on local');
  }
}

// ---------------------------------------------------------------------------
// Wire shape — github (fake gh)
// ---------------------------------------------------------------------------

test('init github: ok result has the exact operator-init v1 wire shape; breaker open by default', () => {
  withGitEnv(() => {
    const ws = workspace('gh-wire');
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn));
    assertOkWire(r, 'github');
    assertEqual(
      r.intake.labels.join(','),
      'verity:request,verity:circuit-open',
      'circuit label applied by default',
    );
    assertEqual(r.policy.circuit_open, true, 'policy.circuit_open matches the label');

    // gh argv, in order: auth read, repo create (--private default), labels,
    // issue create — nothing else.
    assertEqual(fake.calls[0].args.join(' '), 'auth status', 'preflight reads gh auth');
    const create = fake.ghOf('repo', 'create');
    assertEqual(create.length, 1, 'one repo create');
    assertEqual(
      create[0].args.join(' '),
      `repo create ${REPO} --source=. --push --private`,
      'repo create flags, --private by default',
    );
    assert(fake.ghOf('label', 'list').length >= 1, 'labels were ensured');
    assert(
      fake.ghOf('label', 'create').some((c) => c.args[2] === 'verity:request'),
      'the verity:request label is created',
    );
    const issue = fake.ghOf('issue', 'create');
    assertEqual(issue.length, 1, 'one issue create');
    const a = issue[0].args;
    assertEqual(a[a.indexOf('--title') + 1], `[request] ${TITLE}`, 'intake title');
    assertEqual(a[a.indexOf('--repo') + 1], REPO, 'intake repo');
    assertEqual(a[a.indexOf('--body-file') + 1], '-', 'pointer body on stdin');
    const labels = a.filter((_, i) => a[i - 1] === '--label');
    assertEqual(labels.join(','), 'verity:request,verity:circuit-open', 'intake labels');
    const body = issue[0].input;
    assert(body.includes('docs/spec.md'), 'body names the spec path');
    assert(body.includes(r.spec.commit), 'body names the spec commit');
    assert(/first/.test(body), 'body says to read the file first');
    assert(!body.includes('full spec body'), 'the spec is NOT pasted into the issue');
    assertEqual(body.trim().split('\n').length, 1, 'body is one pointer paragraph');

    // Stage-77 tail + the register push.
    const net = fake.gitNet.map((x) => x.join(' '));
    assert(net.includes('fetch --quiet origin'), 'fetch after create');
    assert(net.includes('remote set-head origin main'), 'explicit set-head');
    assert(net.includes('push --quiet origin HEAD:main'), 'register pushed to main');

    // Register committed on main by the engine's bot identity.
    const log = git(r.path, 'log', '--format=%s|%an', 'main');
    assertEqual(
      log.split('\n')[0],
      `chore(verity): register intake #${r.intake.number}|verity-worker`,
      'register commit on top, bot identity',
    );
    assertEqual(
      log.split('\n')[1].split('|')[0],
      'chore(verity): initial scaffold + spec (verity init)',
      'initial commit below it',
    );
    const reg = JSON.parse(git(r.path, 'show', 'main:.verity/intake.json'));
    assertEqual(reg.schema, 1, 'register schema');
    assertEqual(reg.requests.length, 1, 'one request');
    const q = reg.requests[0];
    assertEqual(
      Object.keys(q).join(','),
      'number,kind,spec,spec_commit,filed_by,engine,filed_at',
      'register entry keys',
    );
    assertEqual(q.number, r.intake.number, 'register number');
    assertEqual(q.kind, 'issue', 'register kind');
    assertEqual(q.spec, 'docs/spec.md', 'register spec');
    assertEqual(q.spec_commit, r.spec.commit, 'register spec_commit');
    assertEqual(q.filed_by, 'verity init', 'register filed_by');
    assertEqual(q.filed_at, '2026-09-29T18:00:00Z', 'register filed_at');
    assertEqual(git(r.path, 'status', '--porcelain'), '', 'clean tree after init');
  });
});

test('init github: --start leaves the breaker closed; --public is passed to gh repo create', () => {
  withGitEnv(() => {
    const ws = workspace('gh-start');
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn, { start: true, public: true }));
    assertOkWire(r, 'github');
    assertEqual(r.intake.labels.join(','), 'verity:request', 'no circuit label with --start');
    assertEqual(r.policy.circuit_open, false, 'policy.circuit_open false with --start');
    assertEqual(
      fake.ghOf('repo', 'create')[0].args.slice(-1)[0],
      '--public',
      'visibility flag is --public',
    );
    const a = fake.ghOf('issue', 'create')[0].args;
    assert(!a.includes('verity:circuit-open'), 'issue create carries no circuit label');
  });
});

// ---------------------------------------------------------------------------
// No ambiguous re-issue (stage 112 discipline)
// ---------------------------------------------------------------------------

test('init github: an ambiguous gh issue create is NOT re-issued; the list read-back confirms it', () => {
  withGitEnv(() => {
    const ws = workspace('gh-issue-amb');
    const fake = fakeGithub({
      'issue create': () => timeoutRes(),
      'issue list': () =>
        okRes(
          JSON.stringify([
            { number: 7, title: `[request] ${TITLE}` },
            { number: 3, title: 'other' },
          ]),
        ),
    });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(r.outcome, 'ok', 'confirmed write is ok');
    assertEqual(fake.ghOf('issue', 'create').length, 1, 'issue create issued exactly once');
    const list = fake.ghOf('issue', 'list');
    assertEqual(list.length, 1, 'one read-back');
    assertEqual(
      list[0].args.join(' '),
      `issue list --repo ${REPO} --label verity:request --state open --json number,title`,
      'read-back is the verity:request list',
    );
    const step = r.steps.find((s) => s.step === 'intake');
    assertEqual(step.confirmed_by, 'issue-list', 'confirmed_by issue-list');
    assertEqual(r.intake.number, 7, 'number from the read-back');
    assertEqual(r.intake.registered, true, 'registered');
  });
});

test('init github: an unconfirmed ambiguous gh issue create fails honestly and is not re-issued', () => {
  withGitEnv(() => {
    const ws = workspace('gh-issue-unconf');
    const fake = fakeGithub({ 'issue create': () => timeoutRes() });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(r.outcome, 'failed', 'failed');
    assertEqual(r.ok, false, 'ok false');
    assertEqual(init.exitCodeFor(r), 1, 'exit 1');
    assertEqual(fake.ghOf('issue', 'create').length, 1, 'never re-issued');
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.step, 'intake', 'the run stops at intake');
    assertEqual(last.ok, false, 'intake ok:false');
    assert(/not re-issued/.test(last.detail), 'the ambiguity is named');
    assert(r.reason.startsWith('intake: '), 'reason names the step');
    assertEqual(r.intake, null, 'intake null');
    assertEqual(r.policy.circuit_open, null, 'circuit_open not established');
    assert(!r.steps.some((s) => s.step === 'register'), 'register absent');
    assertStepShape(r.steps);
  });
});

test('init github: a definite gh issue create failure is not read back', () => {
  withGitEnv(() => {
    const ws = workspace('gh-issue-422');
    const fake = fakeGithub({
      'issue create': () => failRes('HTTP 422: Validation Failed (https://api.github.com/graphql)'),
    });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(r.outcome, 'failed', 'failed');
    assertEqual(fake.ghOf('issue', 'create').length, 1, 'no retry');
    assertEqual(fake.ghOf('issue', 'list').length, 0, 'no read-back for a definite failure');
  });
});

test('init github: an ambiguous gh repo create is NOT re-issued; gh repo view confirms it', () => {
  withGitEnv(() => {
    const ws = workspace('gh-repo-amb');
    const fake = fakeGithub({ 'repo create': () => failRes('HTTP 502: Bad Gateway') });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(r.outcome, 'ok', 'confirmed create is ok');
    assertEqual(fake.ghOf('repo', 'create').length, 1, 'repo create issued exactly once');
    assertEqual(
      fake.ghOf('repo', 'view')[0].args.join(' '),
      `repo view ${REPO} --json name`,
      'read back with gh repo view',
    );
    const step = r.steps.find((s) => s.step === 'remote');
    assertEqual(step.confirmed_by, 'repo-view', 'confirmed_by repo-view');
    assertEqual(
      git(r.path, 'remote', 'get-url', 'origin'),
      `https://github.com/${REPO}.git`,
      'origin wired after the confirmed create',
    );
    assert(
      fake.gitNet.some((x) => x.join(' ') === 'push --quiet origin main'),
      'the initial commit is pushed (idempotent)',
    );
  });
});

test('init github: an ambiguous gh repo create that cannot be confirmed fails at remote', () => {
  withGitEnv(() => {
    const ws = workspace('gh-repo-unconf');
    const fake = fakeGithub({
      'repo create': () => timeoutRes(),
      'repo view': () => failRes('GraphQL: Could not resolve to a Repository'),
    });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(r.outcome, 'failed', 'failed');
    assertEqual(fake.ghOf('repo', 'create').length, 1, 'never re-issued');
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.step, 'remote', 'stops at remote');
    assert(/not re-issued/.test(last.detail), 'ambiguity named');
    assertEqual(r.repo, null, 'repo null');
  });
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

test('init github: a failing remote step yields failed, exit 1, steps truncated after remote, nulls', () => {
  withGitEnv(() => {
    const ws = workspace('gh-remote-fail');
    const fake = fakeGithub({
      'repo create': () =>
        failRes('GraphQL: Name already exists on this account (createRepository)'),
    });
    const r = init.run(baseOpts(ws, fake.spawn));
    assertEqual(Object.keys(r).join(','), TOP_KEYS.join(','), 'wire keys on failure');
    assertEqual(r.outcome, 'failed', 'outcome failed');
    assertEqual(r.ok, false, 'ok false');
    assertEqual(init.exitCodeFor(r), 1, 'exit 1');
    assertEqual(
      r.steps.map((s) => s.step).join(','),
      init.STEPS.slice(0, init.STEPS.indexOf('remote') + 1).join(','),
      'steps truncated after remote',
    );
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.ok, false, 'remote ok:false');
    assert(/Name already exists/.test(last.detail), 'detail carries gh stderr');
    assert(r.reason.startsWith('remote: gh repo create failed'), 'reason names the step');
    assertEqual(r.repo, null, 'repo null');
    assertEqual(r.remote, null, 'remote null');
    assertEqual(r.intake, null, 'intake null');
    assertEqual(r.policy.circuit_open, null, 'circuit_open not established');
    assert(r.identity !== null, 'identity established');
    assert(/^[0-9a-f]+$/.test(r.spec.commit), 'spec commit established');
    assertEqual(fake.ghOf('issue', 'create').length, 0, 'no intake after a failed remote');
    assertEqual(fake.ghOf('label', 'list').length, 0, 'no labels after a failed remote');
    assertStepShape(r.steps);
  });
});

test('init: no secret reaches any output field (redactor applied)', () => {
  withGitEnv(() => {
    const ws = workspace('gh-secret');
    const sentinel = `ghp_${'Z'.repeat(36)}`;
    const fake = fakeGithub({
      'repo create': () => failRes(`remote: Invalid credentials ${sentinel} rejected`),
    });
    const r = init.run(baseOpts(ws, fake.spawn));
    const wire = JSON.stringify(r);
    assert(!wire.includes(sentinel), 'the sentinel token never appears');
    assert(wire.includes('[redacted]'), 'the redactor replaced it');
    assert(!init.render(r).includes(sentinel), 'nor in the human render');
  });
});

// ---------------------------------------------------------------------------
// Gates + policy
// ---------------------------------------------------------------------------

test('init: --gate flags write the stage-82 gates.json in argv order; the engine reader accepts it', () => {
  withGitEnv(() => {
    const ws = workspace('gates');
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn, { gates: ['test=npm test', 'lint=npm run lint'] }));
    assertEqual(r.outcome, 'ok', 'ok');
    const def = JSON.parse(fs.readFileSync(path.join(r.path, '.verity', 'gates.json'), 'utf8'));
    assertEqual(
      JSON.stringify(def),
      JSON.stringify({
        schema: 1,
        gates: [
          { name: 'test', command: 'npm test' },
          { name: 'lint', command: 'npm run lint' },
        ],
      }),
      'stage-82 format, argv order',
    );
    assertEqual(
      JSON.stringify(gates.readGateDefinition(r.path)),
      JSON.stringify(def.gates),
      'readGateDefinition accepts it',
    );
    assertEqual(
      git(r.path, 'ls-files', '.verity/gates.json'),
      '.verity/gates.json',
      'committed in the initial commit',
    );
    const step = r.steps.find((s) => s.step === 'gates');
    assertEqual(step.skipped, undefined, 'not skipped');
  });
});

test('init: no --gate ⇒ an honestly skipped gates step and NO gates.json (never a fabricated green)', () => {
  withGitEnv(() => {
    const ws = workspace('nogates');
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn));
    const step = r.steps.find((s) => s.step === 'gates');
    assertEqual(step.ok, true, 'ok');
    assertEqual(step.skipped, true, 'skipped');
    assert(/no gate definition written/.test(step.detail), 'says why');
    assert(!fs.existsSync(path.join(r.path, '.verity', 'gates.json')), 'no file');
  });
});

test('init: the starter policy loads through autonomy.cjs (supervised, trust 0, substrate, allow_with_token_limit, intent-artifact commit + work-item reconcile ON)', () => {
  withGitEnv(() => {
    for (const substrate of ['github', 'local']) {
      const ws = workspace(`policy-${substrate}`);
      const spawn = substrate === 'github' ? fakeGithub().spawn : noGhSpawn().spawn;
      const r = init.run(baseOpts(ws, spawn, { substrate }));
      assertEqual(r.outcome, 'ok', `${substrate}: ok`);
      const p = autonomy.loadPolicy(r.path);
      assertEqual(p.mode, 'supervised', `${substrate}: mode`);
      assertEqual(p.review.trust, 0, `${substrate}: trust 0`);
      assertEqual(p.substrate, substrate, `${substrate}: substrate`);
      assertEqual(
        p.limits.unknown_cost_behavior,
        'allow_with_token_limit',
        `${substrate}: unknown_cost_behavior`,
      );
      // Stage 114 amendment item 0 / contract note 2026-09-29: pinned TRUE, so
      // the engine commits + pushes the plan role's stage files (ADR-0033) and
      // reconciles `[stage N]` work items (ADR-0026).
      assertEqual(p.agent.commit_intent_artifacts, true, `${substrate}: commit_intent_artifacts`);
      assertEqual(p.agent.reconcile_work_items, true, `${substrate}: reconcile_work_items`);
      // Written explicitly (the operator sees the knobs), not inherited.
      const written = fs.readFileSync(path.join(r.path, '.verity', 'autonomy.yml'), 'utf8');
      assert(
        /^\s*commit_intent_artifacts: true$/m.test(written),
        `${substrate}: commit_intent_artifacts: true is written\n${written}`,
      );
      assert(
        /^\s*reconcile_work_items: true$/m.test(written),
        `${substrate}: reconcile_work_items: true is written\n${written}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Local substrate end to end (real git, zero gh)
// ---------------------------------------------------------------------------

test('init local: end to end with real git — origin, register at the bare main, record, spec, snapshot, refused re-run', () => {
  withGitEnv(() => {
    const ws = workspace('local-e2e');
    const guard = noGhSpawn();
    const r = init.run(baseOpts(ws, guard.spawn, { substrate: 'local' }));
    assertOkWire(r, 'local');
    assertEqual(guard.ghCalls.length, 0, 'zero gh calls on local');
    assertEqual(
      r.intake.labels.join(','),
      'verity:request,verity:circuit-open',
      'breaker open by default',
    );
    assertEqual(r.policy.circuit_open, true, 'circuit_open true');

    const p = r.path;
    const bare = `${p}-origin.git`;
    const subjects = git(p, 'log', '--format=%s', 'main').split('\n');
    assertEqual(
      subjects[subjects.length - 1],
      'chore(verity): initial scaffold + spec (verity init)',
      'initial commit',
    );
    assertEqual(
      subjects[0],
      `chore(verity): register intake #${r.intake.number}`,
      'register on top',
    );
    assertEqual(git(p, 'remote', 'get-url', 'origin'), bare, 'origin → <path>-origin.git');
    assertEqual(
      git(p, 'symbolic-ref', 'refs/remotes/origin/HEAD'),
      'refs/remotes/origin/main',
      'origin/HEAD set',
    );
    assertEqual(
      git(p, 'rev-parse', 'main'),
      git(bare, 'rev-parse', 'main'),
      'bare main == local main',
    );
    const reg = JSON.parse(git(bare, 'show', 'main:.verity/intake.json'));
    assertEqual(reg.requests[0].number, r.intake.number, 'register present at the bare main');
    assertEqual(reg.requests[0].kind, 'record', 'register kind record');
    assertEqual(git(p, 'status', '--porcelain'), '', 'clean tree');

    const rec = JSON.parse(
      fs.readFileSync(path.join(p, '.verity', 'work-items', `${r.intake.number}.json`), 'utf8'),
    );
    assertEqual(rec.title, `[request] ${TITLE} — spec: docs/spec.md`, 'record title');
    assertEqual(rec.state, 'OPEN', 'record open');
    assertEqual(rec.labels.join(','), 'verity:request,verity:circuit-open', 'record labels');
    assertEqual(
      fs.readFileSync(path.join(p, 'docs', 'spec.md'), 'utf8'),
      SPEC_TEXT,
      'spec copied verbatim',
    );

    // The local store reads the request; the operator snapshot is online and
    // sees the breaker the record carries.
    const snapLocal = sub.fetchLocalSnapshot(p);
    assert(
      snapLocal.issues.some(
        (i) => i.number === r.intake.number && i.labels.includes('verity:request'),
      ),
      'the request is visible in the local snapshot issues',
    );
    const snapRes = spawnSync(process.execPath, [CLI, 'operator', 'snapshot', '--json'], {
      cwd: p,
      encoding: 'utf8',
    });
    assertEqual(snapRes.status, 0, 'snapshot exits 0');
    const snap = JSON.parse(snapRes.stdout);
    assertEqual(snap.online, true, 'snapshot online');
    assertEqual(snap.repository, null, 'local snapshot has no GitHub repository');
    assertEqual(snap.autonomy.circuit_open, true, 'snapshot reads the open breaker');
    assertEqual(snap.autonomy.mode, 'supervised', 'snapshot reads the starter policy');

    // Re-run on the same path: refused, nothing changes.
    const before = treeHash(ws.root);
    const again = init.run(baseOpts(ws, guard.spawn, { substrate: 'local' }));
    assertEqual(again.outcome, 'refused', 're-run refused');
    assert(
      /^(identity-exists|path-not-empty) — /.test(again.steps[0].detail),
      're-run refused with identity-exists/path-not-empty',
    );
    assertEqual(init.exitCodeFor(again), 2, 'exit 2');
    assertEqual(treeHash(ws.root), before, 're-run changed nothing');
  });
});

test('init local via the CLI: --start --json prints one compact object, exit 0; repeated --gate keeps order', () => {
  withGitEnv(() => {
    const ws = workspace('cli-local');
    const res = spawnSync(
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
        '--gate',
        'test=node -e 0',
        '--gate',
        'lint=node -e 1',
        '--json',
      ],
      { cwd: ws.root, encoding: 'utf8' },
    );
    assertEqual(res.status, 0, `exit 0 (stderr: ${res.stderr})`);
    const lines = res.stdout.trim().split('\n');
    assertEqual(lines.length, 1, 'exactly one line on stdout');
    const r = JSON.parse(lines[0]);
    assertOkWire(r, 'local');
    assertEqual(r.path, ws.target, 'path resolved against the cwd');
    assertEqual(r.intake.labels.join(','), 'verity:request', 'no breaker with --start');
    assertEqual(r.policy.circuit_open, false, 'circuit_open false');
    const def = gates.readGateDefinition(r.path);
    assertEqual(def.map((g) => g.name).join(','), 'test,lint', 'gate argv order kept');
  });
});

test('init via the CLI: a refusal exits 2 with outcome refused (and --force is not a flag)', () => {
  withGitEnv(() => {
    const ws = workspace('cli-refuse');
    const base = ['init', 'proj', '--spec', 'spec.md', '--name', 'W', '--owner', 'me'];
    const before = treeHash(ws.root);
    const res = spawnSync(
      process.execPath,
      [CLI, ...base, '--substrate', 'local', '--force', '--json'],
      { cwd: ws.root, encoding: 'utf8' },
    );
    assertEqual(res.status, 2, 'exit 2');
    const r = JSON.parse(res.stdout);
    assertEqual(r.outcome, 'refused', 'refused');
    assert(r.reason.startsWith('preflight: unknown-flag'), 'unknown flag refused');
    assertEqual(treeHash(ws.root), before, 'nothing written');
    const human = spawnSync(process.execPath, [CLI, ...base, '--substrate', 'nope'], {
      cwd: ws.root,
      encoding: 'utf8',
    });
    assertEqual(human.status, 2, 'human render also exits 2');
    assert(/refused/.test(human.stdout) && /invalid-substrate/.test(human.stdout), 'human summary');
  });
});

test('init: parseArgv keeps repeatable --gate in order and treats --start/--private/--public as booleans', () => {
  const parsed = init.parseArgv([
    'init',
    '--start',
    'p',
    '--gate',
    'a=x y',
    '--gate=b=z',
    '--private',
    '--json',
    '--bogus',
  ]);
  assertEqual(parsed.positional.join(','), 'p', 'the path survives a preceding boolean flag');
  assertEqual(parsed.opts.gates.join('|'), 'a=x y|b=z', 'gates in argv order');
  assertEqual(parsed.opts.start, true, 'start');
  assertEqual(parsed.opts.private, true, 'private');
  assertEqual(parsed.unknown.join(','), '--bogus', 'unknown flags recorded');
});

test('init: specTitle is the first Markdown heading, else the first non-empty line, trimmed to 200', () => {
  assertEqual(init.specTitle('\n\nintro line\n# The Heading #\n'), 'The Heading', 'heading wins');
  assertEqual(init.specTitle('\n  plain first line  \nmore\n'), 'plain first line', 'first line');
  assertEqual(init.specTitle(`# ${'x'.repeat(300)}`).length, 200, 'trimmed to 200');
});

// ---------------------------------------------------------------------------
// Refuse before effect — one test per preflight reason
// ---------------------------------------------------------------------------

const REFUSAL_CASES = [
  ['invalid-path', (_ws) => ({ path: '' })],
  ['unknown-flag', () => ({ unknown: ['--force'] })],
  [
    'identity-exists',
    (ws) => {
      fs.mkdirSync(path.join(ws.target, '.verity'), { recursive: true });
      fs.writeFileSync(path.join(ws.target, '.verity', 'identity.json'), '{}\n');
      return {};
    },
  ],
  [
    'path-not-empty',
    (ws) => {
      fs.mkdirSync(ws.target);
      fs.writeFileSync(path.join(ws.target, 'README.md'), 'hello\n');
      return {};
    },
  ],
  [
    'inside-work-tree',
    (ws) => {
      execFileSync('git', ['init', '-q', ws.root]);
      return { path: path.join(ws.root, 'nested', 'proj') };
    },
  ],
  ['spec-unreadable', (ws) => ({ spec: path.join(ws.root, 'missing.md') })],
  [
    'spec-unreadable',
    (ws) => {
      fs.writeFileSync(path.join(ws.root, 'empty.md'), '  \n\n');
      return { spec: path.join(ws.root, 'empty.md') };
    },
    'empty spec',
  ],
  ['invalid-name', () => ({ name: '   ' })],
  ['invalid-slug', () => ({ slug: 'Bad_Slug' })],
  ['invalid-owner', () => ({ owner: 'me/you' })],
  ['invalid-substrate', () => ({ substrate: 'gitlab' })],
  ['visibility-conflict', () => ({ private: true, public: true })],
  ['invalid-gate', () => ({ gates: ['test=npm test', 'no-command-here'] })],
  [
    'git-identity',
    (ws) => {
      const empty = path.join(ws.root, 'empty-gitconfig');
      fs.writeFileSync(empty, '');
      return {
        env: {
          PATH: process.env.PATH,
          HOME: ws.root,
          GIT_CONFIG_GLOBAL: empty,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      };
    },
  ],
  ['gh-auth', () => ({}), 'gh auth status fails'],
  // --- stage 113 rework (PR #308 review F1/F2/F3, N5) — each new refusal maps
  // onto an EXISTING reason token (the vocabulary a consumer keys on is
  // unchanged); the detail names the precise cause.
  ['invalid-name', () => ({ name: 'Demo\nprocess.exit(0); //' }), 'F1: newline in --name'],
  ['invalid-name', () => ({ name: 'Demo\rprocess.exit(0); //' }), 'F1: CR in --name'],
  ['invalid-name', () => ({ name: 'Demo process.exit(0); //' }), 'F1: U+2028 in --name'],
  ['invalid-name', () => ({ name: 'Demo process.exit(0); //' }), 'F1: U+2029 in --name'],
  ['invalid-name', () => ({ name: 'Demo\u0085x' }), 'F1: NEL (C1) in --name'],
  ['invalid-name', () => ({ name: 'Demo\u001b[2Jx' }), 'F1: ESC in --name'],
  ['invalid-path', (ws) => ({ path: path.join(ws.root, 'a\nb') }), 'F1: newline in <path>'],
  ['invalid-gate', () => ({ gates: ['test=npm test\nexit 0'] }), 'F1: newline in --gate'],
  // PR #308 review round 2 (R2-1) — contract invariant 9: no credential is
  // written to the tree; gates.json and the name-bearing files are pushed.
  [
    'invalid-gate',
    () => ({
      gates: ['test=npm test', `lint=curl -H "Authorization: token ghp_${'G'.repeat(36)}" x`],
    }),
    'R2-1: a credential-shaped string in --gate',
  ],
  [
    'invalid-name',
    () => ({ name: `Demo ghp_${'N'.repeat(36)}` }),
    'R2-1: a credential-shaped string in --name',
  ],
  [
    'spec-unreadable',
    (ws) => {
      const f = path.join(ws.root, 'cc-title.md');
      fs.writeFileSync(f, '# Demo\rprocess.exit(0); //\n\nbody\n');
      return { spec: f };
    },
    'F1: control character in the spec title line',
  ],
  [
    'spec-unreadable',
    (ws) => {
      const f = path.join(ws.root, 'secret.md');
      fs.writeFileSync(f, `# Demo\n\nuse ${`ghp_${'S'.repeat(36)}`} to deploy\n`);
      return { spec: f };
    },
    'F2: secret-bearing spec',
  ],
  [
    'spec-unreadable',
    (ws) => {
      const env = path.join(ws.root, '.env');
      fs.writeFileSync(env, `ANTHROPIC_API_KEY=sk-ant-${'k'.repeat(40)}\n`);
      const link = path.join(ws.root, 'spec-link.md');
      fs.symlinkSync(env, link);
      return { spec: link };
    },
    'F2: spec is a symlink to a secret-bearing .env',
  ],
  [
    'spec-unreadable',
    (ws) => {
      const d = path.join(ws.root, 'spec-dir');
      fs.mkdirSync(d);
      return { spec: d };
    },
    'F2: spec is a directory',
  ],
  [
    'spec-unreadable',
    (ws) => {
      const f = path.join(ws.root, 'huge.md');
      fs.writeFileSync(f, `# Huge\n${'x'.repeat(1024 * 1024)}`);
      return { spec: f };
    },
    'F2: spec over the 1 MiB cap',
  ],
  [
    'path-not-empty',
    (ws) => {
      execFileSync('git', ['init', '--bare', '-q', `${ws.target}-origin.git`]);
      return { substrate: 'local' };
    },
    'F3: a stale bare origin at <path>-origin.git',
  ],
  [
    'path-not-empty',
    (ws) => {
      const d = `${ws.target}-origin.git`;
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'my-notes.txt'), 'the user files, not a repo\n');
      return { substrate: 'local' };
    },
    'F3: an unrelated non-empty directory at <path>-origin.git',
  ],
  [
    'path-not-empty',
    (ws) => {
      fs.writeFileSync(`${ws.target}-origin.git`, 'a plain file\n');
      return { substrate: 'local' };
    },
    'F3: a file at <path>-origin.git',
  ],
  ['invalid-owner', () => ({ owner: '-x' }), 'N5: leading hyphen'],
  ['invalid-owner', () => ({ owner: '--' }), 'N5: double hyphen'],
  [
    'inside-work-tree',
    (ws) => {
      const bare = path.join(ws.root, 'bare.git');
      execFileSync('git', ['init', '--bare', '-q', bare]);
      return { path: path.join(bare, 'proj') };
    },
    'N5: inside a bare repository',
  ],
  [
    'inside-work-tree',
    (ws) => ({ env: { ...process.env, GIT_DIR: path.join(ws.root, 'elsewhere.git') } }),
    'N5: GIT_DIR in the environment',
  ],
];

for (const [code, setup, label] of REFUSAL_CASES) {
  test(`init refuses before any effect: ${code}${label ? ` (${label})` : ''}`, () => {
    withGitEnv(() => {
      const ws = workspace(`refuse-${code}`);
      const extra = setup(ws);
      if (extra.env === undefined) {
        extra.env = process.env;
      }
      const fake = fakeGithub(
        code === 'gh-auth'
          ? { 'auth status': () => failRes('You are not logged into any GitHub hosts.') }
          : {},
      );
      const before = treeHash(ws.root);
      const r = init.run(baseOpts(ws, fake.spawn, extra));

      assertEqual(Object.keys(r).join(','), TOP_KEYS.join(','), 'wire keys on refusal');
      assertEqual(r.outcome, 'refused', 'outcome refused');
      assertEqual(r.ok, false, 'ok false');
      assertEqual(init.exitCodeFor(r), 2, 'exit 2');
      assertEqual(r.steps.length, 1, 'a single step');
      assertEqual(r.steps[0].step, 'preflight', 'the preflight step');
      assertEqual(r.steps[0].ok, false, 'preflight ok:false');
      assert(
        r.steps[0].detail.startsWith(`${code} — `),
        `detail names ${code}: ${r.steps[0].detail}`,
      );
      assert(r.reason.startsWith(`preflight: ${code} — `), 'reason names the check');
      for (const k of [
        'identity',
        'substrate',
        'repo',
        'remote',
        'default_branch',
        'spec',
        'intake',
        'policy',
      ]) {
        assertEqual(r[k], null, `${k} null on refusal`);
      }
      assertEqual(treeHash(ws.root), before, 'nothing on disk changed (target and siblings)');
      const effectful = fake.calls.filter((c) => c.args.join(' ') !== 'auth status');
      assertEqual(effectful.length, 0, 'no gh write/read beyond the auth check');
      if (code !== 'gh-auth') {
        assertEqual(fake.calls.length, 0, 'no gh call at all');
      }
      assertEqual(fake.gitNet.length, 0, 'no git network verb');
      assert(init.REFUSALS.includes(code), 'the reason is in the refusal vocabulary');
    });
  });
}

// ---------------------------------------------------------------------------
// Stage 113 rework (PR #308 review): F1 injection, F2 bounded spec read,
// F3 full remote detail, N5 fail-closed work-tree check, N6 register identity,
// N7 repo reported once it exists + `~` expansion.
// ---------------------------------------------------------------------------

test('init F1: the generated run-gates.cjs can no longer be made to exit 0 via --name', () => {
  withGitEnv(() => {
    // Control: a clean name scaffolds a runner that FAILS LOUDLY with no gate
    // definition (security invariant §4).
    const clean = workspace('f1-control');
    const ok = init.run(baseOpts(clean, noGhSpawn().spawn, { substrate: 'local' }));
    assertEqual(ok.outcome, 'ok', 'control run ok');
    const rgClean = spawnSync(process.execPath, [path.join('.verity', 'run-gates.cjs')], {
      cwd: ok.path,
      encoding: 'utf8',
    });
    assert(rgClean.status !== 0, 'a clean runner with no gates.json exits non-zero');

    for (const sep of ['\n', '\r', ' ', ' ', '\u0085']) {
      const ws = workspace('f1-inject');
      const guard = noGhSpawn();
      const before = treeHash(ws.root);
      const r = init.run(
        baseOpts(ws, guard.spawn, { substrate: 'local', name: `Demo${sep}process.exit(0); //` }),
      );
      const cp = `U+${sep.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      assertEqual(r.outcome, 'refused', `${cp}: refused`);
      assert(r.steps[0].detail.startsWith('invalid-name — '), `${cp}: invalid-name`);
      assert(r.steps[0].detail.includes(cp), `${cp}: the detail names the code point`);
      assertEqual(treeHash(ws.root), before, `${cp}: tree unchanged`);
      assertEqual(guard.ghCalls.length, 0, `${cp}: zero gh calls`);
      const rg = path.join(ws.target, '.verity', 'run-gates.cjs');
      if (fs.existsSync(rg)) {
        const res = spawnSync(process.execPath, [rg], { cwd: ws.target, encoding: 'utf8' });
        assert(res.status !== 0, `${cp}: an injected runner must never exit 0`);
      }
      assert(!fs.existsSync(rg), `${cp}: no runner was scaffolded`);
    }
  });
});

test('init F2: a secret-bearing spec is refused without echoing the secret', () => {
  withGitEnv(() => {
    const ws = workspace('f2-secret-echo');
    const sentinel = `ghp_${'Q'.repeat(36)}`;
    const f = path.join(ws.root, 'secret.md');
    fs.writeFileSync(f, `# Demo\n\nline two\nGITHUB token ${sentinel}\n`);
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn, { spec: f }));
    assertEqual(r.outcome, 'refused', 'refused');
    assert(r.steps[0].detail.startsWith('spec-unreadable — '), 'spec-unreadable');
    assert(/line\(s\) 4/.test(r.steps[0].detail), 'the detail names the line, not the text');
    assert(!JSON.stringify(r).includes(sentinel), 'the secret never appears in the result');
    assertEqual(fake.calls.length, 0, 'zero gh calls');
  });
});

test('init F2: ordinary spec prose about tokens, authorization and commit SHAs is NOT refused (shapes only)', () => {
  withGitEnv(() => {
    const ws = workspace('f2-no-false-positive');
    const f = path.join(ws.root, 'ordinary.md');
    fs.writeFileSync(
      f,
      [
        '# Demo',
        '',
        'Authorization is role-based; a Bearer token expires after 1h.',
        'Login returns a session token: store it in an HttpOnly cookie.',
        `Pinned upstream at ${'a1'.repeat(20)}.`,
        '',
      ].join('\n'),
    );
    const fake = fakeGithub();
    const r = init.run(baseOpts(ws, fake.spawn, { spec: f }));
    assert(
      !(r.outcome === 'refused' && /spec-unreadable/.test(r.steps[0].detail || '')),
      `an ordinary spec passes the secret check (got ${r.outcome}: ${r.steps[0].detail})`,
    );
    assertEqual(r.steps[0].ok, true, 'preflight passes');
  });
});

test('init R2-1: a gate that REFERENCES a credential via the environment is accepted and written verbatim', () => {
  withGitEnv(() => {
    const ws = workspace('r21-env-gate');
    const fake = fakeGithub();
    const gate = 'deploy=curl -H "Authorization: token $GH_TOKEN" https://example.invalid';
    const r = init.run(baseOpts(ws, fake.spawn, { gates: [gate] }));
    assertEqual(r.steps[0].ok, true, 'preflight passes');
    const written = JSON.parse(
      fs.readFileSync(path.join(ws.target, '.verity', 'gates.json'), 'utf8'),
    );
    assert(
      JSON.stringify(written).includes('$GH_TOKEN'),
      'the env-var reference is written as-is (no credential in the tree)',
    );
  });
});

// A spec that is a FIFO or a device must be refused WITHOUT opening it for a
// blocking read — run in a child with a deadline so a regression (a blocked
// read) fails the test instead of hanging the suite. The special files live
// outside the hashed workspace (hashing would read them).
test('init F2: a FIFO or device spec (direct or via symlink) is refused before any read', () => {
  withGitEnv(() => {
    const specials = tmp('f2-special');
    const cases = [];
    if (process.platform !== 'win32') {
      const fifo = path.join(specials, 'spec.fifo');
      const mk = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      if (mk.status === 0) {
        cases.push(['fifo', fifo]);
        const link = path.join(specials, 'fifo-link.md');
        fs.symlinkSync(fifo, link);
        cases.push(['symlink → fifo', link]);
      }
      if (fs.existsSync('/dev/zero')) {
        cases.push(['/dev/zero', '/dev/zero']);
        const zlink = path.join(specials, 'zero-link.md');
        fs.symlinkSync('/dev/zero', zlink);
        cases.push(['symlink → /dev/zero', zlink]);
      }
    }
    if (cases.length === 0) {
      skip('no FIFO or /dev/zero on this platform');
    }
    const INIT = path.join(__dirname, '..', 'verity', 'bin', 'lib', 'init.cjs');
    const script = `
      const cp = require('node:child_process');
      const init = require(${JSON.stringify(INIT)});
      const gh = [];
      const spawn = (cmd, args, o = {}) => {
        if (cmd === 'gh') { gh.push(args); return { status: 1, error: null, stdout: '', stderr: 'no gh' }; }
        return cp.spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...o });
      };
      const opts = JSON.parse(process.env.INIT_TEST_OPTS);
      const r = init.run({ ...opts, spawn, sleep() {}, now: new Date(0) });
      process.stdout.write(JSON.stringify({ r, gh: gh.length }));
    `;
    for (const [label, spec] of cases) {
      const ws = workspace('f2-special-ws');
      const before = treeHash(ws.root);
      const opts = {
        path: ws.target,
        spec,
        name: 'Widget Tracker',
        owner: 'me',
        substrate: 'github',
        gates: [],
        cwd: ws.root,
      };
      const res = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, INIT_TEST_OPTS: JSON.stringify(opts) },
      });
      assertEqual(res.status, 0, `${label}: the child finished (did not block): ${res.stderr}`);
      const out = JSON.parse(res.stdout);
      assertEqual(out.r.outcome, 'refused', `${label}: refused`);
      assert(
        out.r.steps[0].detail.startsWith('spec-unreadable — '),
        `${label}: spec-unreadable (${out.r.steps[0].detail})`,
      );
      assert(/not a regular file/.test(out.r.steps[0].detail), `${label}: names the file type`);
      assertEqual(out.gh, 0, `${label}: zero gh calls`);
      assertEqual(treeHash(ws.root), before, `${label}: tree unchanged`);
    }
  });
});

test('init F3: a local remote failure surfaces the FULL git rejection text, not just its first line', () => {
  if (process.platform === 'win32') {
    skip('shell hooks are POSIX-only');
  }
  withGitEnv(() => {
    // A client-side pre-push hook (via the isolated global config) rejects the
    // bare-origin push with a multi-line reason.
    const hooks = tmp('f3-hooks');
    const hook = path.join(hooks, 'pre-push');
    fs.writeFileSync(
      hook,
      '#!/bin/sh\necho "push rejected: first line" >&2\necho "policy: the second-line reason" >&2\nexit 1\n',
    );
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(process.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${hooks}\n`);
    const ws = workspace('f3-reject');
    const guard = noGhSpawn();
    const r = init.run(baseOpts(ws, guard.spawn, { substrate: 'local' }));
    assertEqual(r.outcome, 'failed', 'failed');
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.step, 'remote', 'stops at remote');
    assert(last.detail.includes('push rejected: first line'), 'first line present');
    assert(
      last.detail.includes('policy: the second-line reason'),
      `the reason after the first line is surfaced: ${last.detail}`,
    );
    assert(/failed to push some refs/.test(last.detail), "git's own error line is surfaced");
    assert(!last.detail.includes('\n'), 'still one line');
    assertEqual(guard.ghCalls.length, 0, 'zero gh calls');
  });
});

test('init F3: a github push rejection keeps every line of git output in the detail', () => {
  withGitEnv(() => {
    const ws = workspace('f3-gh-reject');
    const fake = fakeGithub();
    const spawn = (cmd, args, options = {}) => {
      if (cmd === 'git' && args[0] === 'push' && args.includes('HEAD:main')) {
        return failRes(
          "To https://github.com/me/widget-tracker.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/me/widget-tracker.git'\nhint: Updates were rejected because the remote contains work that you do not have locally.\n",
        );
      }
      return fake.spawn(cmd, args, options);
    };
    const r = init.run(baseOpts(ws, spawn));
    assertEqual(r.outcome, 'failed', 'failed');
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.step, 'register', 'stops at register');
    assert(last.detail.includes('[rejected]'), 'the rejection line');
    assert(
      last.detail.includes('Updates were rejected because the remote contains work'),
      `the hint after line 3 is kept: ${last.detail}`,
    );
  });
});

test('init N5: a git error other than "not a git repository" fails CLOSED (dubious ownership)', () => {
  withGitEnv(() => {
    const ws = workspace('n5-dubious');
    const fake = fakeGithub();
    const spawn = (cmd, args, options = {}) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return failRes(
          "fatal: detected dubious ownership in repository at '/somewhere'\nTo add an exception for this directory, call: git config --global --add safe.directory /somewhere",
          128,
        );
      }
      return fake.spawn(cmd, args, options);
    };
    const before = treeHash(ws.root);
    const r = init.run(baseOpts(ws, spawn));
    assertEqual(r.outcome, 'refused', 'refused');
    assert(r.steps[0].detail.startsWith('inside-work-tree — '), 'inside-work-tree');
    assert(/dubious ownership/.test(r.steps[0].detail), 'the git error is named');
    assertEqual(treeHash(ws.root), before, 'tree unchanged');
    assertEqual(fake.calls.length, 0, 'zero gh calls');
  });
});

test('init N6: the register commit is the bot identity even with GIT_AUTHOR_*/GIT_COMMITTER_* inherited', () => {
  withGitEnv(() => {
    const ws = workspace('n6-identity');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Inherited Author',
      GIT_AUTHOR_EMAIL: 'author@inherited.invalid',
      GIT_COMMITTER_NAME: 'Inherited Committer',
      GIT_COMMITTER_EMAIL: 'committer@inherited.invalid',
    };
    const r = init.run(baseOpts(ws, noGhSpawn().spawn, { substrate: 'local', env }));
    assertEqual(r.outcome, 'ok', 'ok');
    const top = git(r.path, 'log', '-1', '--format=%an|%ae|%cn|%ce', 'main');
    assertEqual(
      top,
      'verity-worker|verity-worker@users.noreply.github.com|verity-worker|verity-worker@users.noreply.github.com',
      'register commit author + committer are the bot',
    );
    const root = git(r.path, 'rev-list', '--max-parents=0', 'main');
    const initial = git(r.path, 'log', '-1', '--format=%an', root);
    assertEqual(initial, 'Inherited Author', 'the initial commit keeps the operator identity');
  });
});

test('init N7: repo/remote are reported once gh repo create succeeded, even if a later remote call fails', () => {
  withGitEnv(() => {
    const ws = workspace('n7-repo');
    const fake = fakeGithub();
    const spawn = (cmd, args, options = {}) => {
      if (cmd === 'git' && args[0] === 'fetch') {
        return failRes('fatal: unable to access the remote: Could not resolve host', 128);
      }
      return fake.spawn(cmd, args, options);
    };
    const r = init.run(baseOpts(ws, spawn));
    assertEqual(r.outcome, 'failed', 'failed');
    const last = r.steps[r.steps.length - 1];
    assertEqual(last.step, 'remote', 'stops at remote');
    assertEqual(last.ok, false, 'remote ok:false');
    assertEqual(r.repo, REPO, 'repo reported: it exists');
    assertEqual(r.remote, `https://github.com/${REPO}`, 'remote reported: it exists');
    assertEqual(r.intake, null, 'intake null');
  });
});

test('init N7: a literal ~ in <path> / --spec means the home directory', () => {
  withGitEnv(() => {
    const ws = workspace('n7-tilde');
    const env = { ...process.env, HOME: ws.root };
    const r = init.run(
      baseOpts(ws, noGhSpawn().spawn, {
        substrate: 'local',
        path: '~/proj',
        spec: '~/spec.md',
        cwd: os.tmpdir(),
        env,
      }),
    );
    assertEqual(r.outcome, 'ok', `ok (${r.reason})`);
    assertEqual(r.path, ws.target, '~/proj resolved under HOME');
    assert(!fs.existsSync(path.join(os.tmpdir(), '~')), 'no directory literally named ~');
  });
});
