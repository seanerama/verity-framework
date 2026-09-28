// Stage 110 — bounded external calls and retained tick logs: a local network
// loss can cost seconds, never hours.
//
// Evidence: benchmark run a-20260925-160754-run1, tick 1. The worker process
// stayed alive ~95 minutes after its last useful work on a LOCAL network outage
// and only reported `infra` once the network returned — no gh or git call on
// the worker path had a timeout, a network error was not retried, the harness
// burned ticks on an unreadable snapshot, and the tick's output was discarded.
//
// What is proven here:
//   1. gh.run bounds every attempt (timeoutMs → execFileSync `timeout`), and
//      classifies a killed child as `timeout` and a network-level error as
//      `network` — both transient, both retried, then a GhError naming the
//      class. REGRESSION: a real `gh` that blocks is killed at the deadline
//      (on main it blocks until it finishes);
//   2. git-lifecycle's git() carries the split deadline (network verbs vs
//      local), SIGTERM, and GIT_TERMINAL_PROMPT=0, and a timed-out git is
//      `ok:false, reason:'timeout'`;
//   3. the benchmark drive loop waits out `online:false` snapshots with a
//      bounded doubling backoff instead of ticking, and stops 'offline' past
//      the budget with zero spawns;
//   4. a worker tick is bounded by the lock-aligned deadline and a killed tick
//      is recorded `tick_timeout` while the loop proceeds;
//   5. every tick's stdout/stderr lands in tick-NNN.log (redacted, 0600) and
//      the record's ticks[] carries the parsed verdict;
//   6. a source scan: no execFileSync/spawnSync on the worker's GitHub path is
//      without a `timeout`.
//
// Timing: everything is injected (sleep, clock, spawn) except the
// real-subprocess tests, which use a 150-200 ms deadline against a child that
// would otherwise live 1.5-5 s — the kill lands long before the child could
// finish, so the assertion margin is > 1 s either way. (Stage 112 made the
// SIGTERM-trapping tick test real: SIGKILL after a 200 ms grace.)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'verity', 'bin', 'lib');
const gh = require(path.join(LIB, 'gh.cjs'));
const gitLifecycle = require(path.join(LIB, 'agents', 'git-lifecycle.cjs'));
const benchmark = require(path.join(LIB, 'benchmark.cjs'));

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-s110-${tag}-`));
}

// Temporarily set env vars for fn, restoring them after (undefined ⇒ delete).
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// A PATH stub named `name` that logs its argv, blocks `sleepMs`, then prints
// `out` and exits 0 — a stand-in for a gh/git hung on a dead network.
function slowStub(name, sleepMs, out = 'late') {
  const dir = tmp(`${name}-stub`);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(
    path.join(bin, name),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMs});
process.stdout.write(${JSON.stringify(`${out}\n`)});
`,
  );
  fs.chmodSync(path.join(bin, name), 0o755);
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

// The error execFileSync throws when it kills a child at its deadline.
function timeoutError(cmd) {
  return Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), {
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    status: null,
    stdout: '',
    stderr: '',
  });
}

function catchErr(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

// --- 1. gh.run: bounded attempts, timeout + network classes -------------------

test('gh.run: an exec that never returns is killed at timeoutMs — reason timeout, transient, 4 attempts', () => {
  const seen = [];
  const exec = (_args, opts) => {
    seen.push(opts.timeoutMs);
    throw timeoutError('gh');
  };
  const slept = [];
  const err = catchErr(() =>
    gh.run(['pr', 'list'], { exec, timeoutMs: 1000, sleep: (ms) => slept.push(ms), log: () => {} }),
  );
  assert(err instanceof gh.GhError, 'throws a GhError');
  assertEqual(err.reason, 'timeout', 'the class is named');
  assertEqual(err.transient, true, 'a timeout is transient');
  assertEqual(err.attempts, 4, '1 attempt + 3 retries, then give up');
  assertEqual(slept.length, 3, 'one backoff per retry — through the injected sleep');
  assert(
    seen.every((ms) => ms === 1000),
    `every attempt carried the deadline: ${JSON.stringify(seen)}`,
  );
  assert(/timed out after 1000 ms \(4 attempts\)/.test(err.message), err.message);
});

test('gh.run: the default per-attempt deadline is GH_TIMEOUT_MS (60 s)', () => {
  assertEqual(gh.GH_TIMEOUT_MS, 60_000);
  let seen;
  gh.run(['api', 'user'], {
    exec: (_a, opts) => {
      seen = opts.timeoutMs;
      return 'ok';
    },
    log: () => {},
  });
  assertEqual(seen, 60_000, 'exec sees the effective default deadline');
});

test('gh.run: a network error is retried, then fails loud with reason network', () => {
  const stderr =
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: network is unreachable';
  let calls = 0;
  const exec = () => {
    calls += 1;
    throw Object.assign(new Error('Command failed: gh'), { status: 1, stderr });
  };
  const err = catchErr(() => gh.run(['issue', 'list'], { exec, sleep: () => {}, log: () => {} }));
  assertEqual(calls, 4, 'retried like any transient failure');
  assertEqual(err.reason, 'network');
  assertEqual(err.transient, true);
  assert(/network is unreachable/.test(err.message), 'the message quotes gh');
});

test('gh.run: a network blip on attempt 1 then success returns the output', () => {
  let calls = 0;
  const slept = [];
  const out = gh.run(['issue', 'list'], {
    exec: () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('x'), {
          status: 1,
          stderr:
            'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
        });
      }
      return '[]';
    },
    sleep: (ms) => slept.push(ms),
    log: () => {},
  });
  assertEqual(out, '[]', 'the blip costs one backoff, not the tick');
  assertEqual(calls, 2);
  assertEqual(slept.length, 1);
});

test('gh.classify: timeout and network classes; the existing classes are unchanged', () => {
  const t = (err) => gh.classify(err);
  assertEqual(t({ code: 'ETIMEDOUT' }).reason, 'timeout');
  assertEqual(t({ killed: true }).reason, 'timeout');
  assertEqual(t({ signal: 'SIGTERM', status: null }).reason, 'timeout');
  for (const phrase of [
    'connect: network is unreachable',
    'dial tcp 1.2.3.4:443: i/o timeout',
    'lookup api.github.com: no such host',
    'getaddrinfo EAI_AGAIN api.github.com',
    'read: connection reset by peer',
    'connect: connection refused',
    'net/http: TLS handshake timeout',
    'Could not resolve host: github.com',
  ]) {
    const c = t({ stderr: phrase });
    assertEqual(c.reason, 'network', phrase);
    assertEqual(c.transient, true, phrase);
  }
  assertEqual(t({ stderr: 'HTTP 502: Bad Gateway' }).reason, 'http-5xx');
  assertEqual(t({ stderr: 'HTTP 404: Not Found' }).transient, false);
  assertEqual(t({ stderr: 'not a git repository' }).reason, 'error');
});

// REGRESSION (fails before, passes after): a REAL `gh` that blocks 1.5 s with a
// 200 ms timeoutMs is killed at the deadline on every attempt. On main the
// timeout never reaches execFileSync, so the call blocks the full 1.5 s and
// returns 'late' instead of throwing.
test('REGRESSION gh.run: a real gh blocking 1.5 s with timeoutMs 200 is killed per attempt, not waited out', () => {
  const stub = slowStub('gh', 1500);
  withEnv({ PATH: stub.PATH }, () => {
    const t0 = Date.now();
    const err = catchErr(() =>
      gh.run(['pr', 'list'], { timeoutMs: 200, retries: 1, sleep: () => {}, log: () => {} }),
    );
    const elapsed = Date.now() - t0;
    assert(err instanceof gh.GhError, `a blocked gh must be killed and fail, got: ${err}`);
    assertEqual(err.reason, 'timeout');
    assertEqual(stub.calls().length, 2, 'retries:1 ⇒ two bounded attempts');
    assert(elapsed < 1200, `two 200 ms attempts took ${elapsed} ms — the child was not killed`);
  });
});

// --- 2. git-lifecycle: split deadlines, no prompt, reason timeout -------------

test('git-lifecycle: network verbs get GIT_NET_TIMEOUT_MS, local ops GIT_LOCAL_TIMEOUT_MS (spawn-arg pinned)', () => {
  assertEqual(gitLifecycle.GIT_NET_TIMEOUT_MS, 300_000);
  assertEqual(gitLifecycle.GIT_LOCAL_TIMEOUT_MS, 60_000);
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push({ cmd, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
  const cases = [
    [['push', '--set-upstream', 'origin', 'feat/x'], 300_000],
    [['-c', 'remote.origin.followRemoteHEAD=never', 'fetch', 'origin'], 300_000],
    [['ls-remote', 'origin'], 300_000],
    [['rev-parse', 'HEAD'], 60_000],
    [['commit', '-m', 'x'], 60_000],
    [['status', '--porcelain=v1', '-z'], 60_000],
  ];
  for (const [args, want] of cases) {
    const r = gitLifecycle.git('/repo', args, { spawn });
    assertEqual(r.ok, true, 'a clean exit is ok');
    const o = seen[seen.length - 1].options;
    assertEqual(o.timeout, want, `git ${args.join(' ')} deadline`);
    assertEqual(o.killSignal, 'SIGTERM', 'killed with SIGTERM');
    assertEqual(o.env.GIT_TERMINAL_PROMPT, '0', 'git never prompts (invariant 1.6)');
    assertEqual(o.cwd, '/repo');
    assert(Array.isArray(seen[seen.length - 1].args), 'argv array, no shell');
  }
  assertEqual(gitLifecycle.gitSubcommand(['-C', '/x', 'push', 'origin']), 'push');
  assertEqual(gitLifecycle.gitTimeoutMs(['-C', '/x', 'push', 'origin']), 300_000);
});

test('git-lifecycle: an injected hanging git push → ok:false, reason timeout, a stderr that says so', () => {
  const spawn = () => ({
    status: null,
    signal: 'SIGTERM',
    error: timeoutError('git'),
    stdout: '',
    stderr: '',
  });
  const r = gitLifecycle.git('/repo', ['push', 'origin', 'b'], { spawn });
  assertEqual(
    r.ok,
    false,
    'a timed-out push is a failed push — the fail-closed refusals consume it',
  );
  assertEqual(r.reason, 'timeout');
  assert(/git push timed out after 300000 ms/.test(r.stderr), r.stderr);
});

test('git-lifecycle: a REAL git hung on push is killed within the configured window', () => {
  const stub = slowStub('git', 1500);
  const dir = tmp('git-hang');
  withEnv({ PATH: stub.PATH }, () => {
    const t0 = Date.now();
    const r = gitLifecycle.git(dir, ['push', 'origin', 'b'], { timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    assertEqual(r.ok, false, 'the hung push did not complete');
    assertEqual(r.reason, 'timeout');
    assert(elapsed < 1200, `killed at the 200 ms window, took ${elapsed} ms`);
  });
});

// --- 3. drive loop: wait offline instead of ticking ---------------------------

const WORKING = {
  online: true,
  next: { role: 'build', target_type: 'stage', target: 1 },
  queue: { ready: 1, in_progress: 0, waiting_for_ci: 0, awaiting_approval: 0, needs_human: 0 },
};
const DONE = {
  online: true,
  next: null,
  queue: { ready: 0, in_progress: 0, waiting_for_ci: 0, awaiting_approval: 0, needs_human: 0 },
};
const OFFLINE = { online: false };

function sequence(seq) {
  let i = 0;
  const reader = () => seq[Math.min(i++, seq.length - 1)];
  return { reader, reads: () => i };
}

// A fake clock that only moves when the injected sleep sleeps — the outage
// accounting is then exact.
function fakeTime() {
  let t = Date.UTC(2026, 8, 27, 12, 0, 0);
  const sleeps = [];
  return {
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function workerSpawn(stdout = '', stderr = '') {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, error: null, stdout, stderr };
  };
  return { spawn, calls };
}

test('driveStatus: online:false reads offline (never done, never working)', () => {
  assertEqual(benchmark.driveStatus(OFFLINE), 'offline');
  assertEqual(benchmark.driveStatus({ online: false, next: null, queue: {} }), 'offline');
  assertEqual(benchmark.driveStatus(DONE), 'done');
  assertEqual(benchmark.driveStatus(WORKING), 'working');
});

test('drive: three offline reads then online → no ticks during the wait, doubling backoff, then a normal tick', () => {
  const { spawn, calls } = workerSpawn();
  const time = fakeTime();
  const { reader, reads } = sequence([OFFLINE, OFFLINE, OFFLINE, WORKING, DONE]);
  const r = benchmark.drivePipeline({
    repo: 'o/r',
    dir: '/x',
    spawn,
    snapshotReader: reader,
    maxTicks: 10,
    sleep: time.sleep,
    now: time.now,
    waitMs: 1000,
  });
  assertEqual(r.stopReason, 'done');
  assertEqual(JSON.stringify(time.sleeps), JSON.stringify([1000, 2000, 4000]), 'backoff doubles');
  assertEqual(calls.length, 1, 'exactly one worker spawn — none while offline');
  assertEqual(r.ticks, 1, 'the wait counted no ticks');
  assertEqual(r.offlineWaits, 3);
  assertEqual(r.offlineSecs, 7);
  assertEqual(reads(), 5);
});

test('drive: an outage longer than the budget stops offline with zero spawns; the wait is capped at 5 min', () => {
  const { spawn, calls } = workerSpawn();
  const time = fakeTime();
  const { reader } = sequence([OFFLINE]);
  const r = benchmark.drivePipeline({
    repo: 'o/r',
    dir: '/x',
    spawn,
    snapshotReader: reader,
    maxTicks: 150,
    sleep: time.sleep,
    now: time.now,
    waitMs: 60_000,
    offlineBudgetMs: 20 * 60_000,
  });
  assertEqual(r.stopReason, 'offline');
  assertEqual(calls.length, 0, 'zero spawns — the tick budget is untouched');
  assertEqual(r.ticks, 0);
  assertEqual(
    JSON.stringify(time.sleeps),
    JSON.stringify([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]),
    'doubling to the 5-minute cap',
  );
  assertEqual(r.offlineSecs, 1320, 'the whole outage is accounted');
});

test('run: an offline outage past --offline-budget-min is recorded stop_reason offline, outcome incomplete', () => {
  const dir = tmp('run-offline');
  const { spawn, calls } = workerSpawn();
  const time = fakeTime();
  const r = benchmark.run({
    config: {
      enabled: true,
      owner: 'bench-owner',
      fixtures: { B: { stages_dir: 'unused/' } },
    },
    provision: () => ({ ok: true, fixture: 'B', repo: 'bench-owner/b-20260927-120000', dir }),
    spawn,
    snapshotReader: () => OFFLINE,
    ledgerReader: () => ({ rows: [] }),
    sleep: time.sleep,
    now: time.now,
    driveWaitMs: 20_000,
    offlineBudgetMin: 1,
    resultsDir: tmp('run-offline-out'),
    logsRoot: tmp('run-offline-logs'),
  });
  assertEqual(r.ok, true);
  const rec = r.results[0];
  assertEqual(rec.stop_reason, 'offline');
  assertEqual(rec.outcome, 'incomplete');
  assertEqual(rec.offline_waits, 2, '20 s + 40 s reaches the 1-minute budget');
  assertEqual(rec.offline_secs, 60);
  assertEqual(JSON.stringify(rec.ticks), '[]', 'no tick was spent');
  assertEqual(calls.filter((c) => c.cmd === 'verity-worker').length, 0);
});

test('offline budget: flag > benchmark.json limits.offline_budget_min > 60 min default', () => {
  assertEqual(benchmark.OFFLINE_BUDGET_MS, 60 * 60_000);
  assertEqual(benchmark.OFFLINE_MAX_WAIT_MS, 5 * 60_000);
  assertEqual(benchmark.offlineBudgetMs({}, undefined), 60 * 60_000);
  assertEqual(
    benchmark.offlineBudgetMs({ limits: { offline_budget_min: 15 } }, undefined),
    15 * 60_000,
  );
  assertEqual(
    benchmark.offlineBudgetMs({ variant: { limits: { offline_budget_min: 5 } } }, undefined),
    5 * 60_000,
  );
  assertEqual(benchmark.offlineBudgetMs({ limits: { offline_budget_min: 15 } }, 2), 2 * 60_000);
});

test('config: a malformed limits.offline_budget_min fails closed; a valid one loads', () => {
  const dir = tmp('cfg');
  const file = path.join(dir, 'benchmark.json');
  const base = { enabled: true, owner: 'o', fixtures: {} };
  fs.writeFileSync(file, JSON.stringify({ ...base, limits: { offline_budget_min: 'soon' } }));
  const bad = benchmark.loadConfig(file);
  assertEqual(bad.valid, false);
  assert(/offline_budget_min/.test(bad.reason), bad.reason);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...base, variant: { limits: { offline_budget_min: -1 } } }),
  );
  assertEqual(benchmark.loadConfig(file).valid, false, 'variant.limits is validated too');
  fs.writeFileSync(file, JSON.stringify({ ...base, limits: { offline_budget_min: 30 } }));
  assertEqual(benchmark.loadConfig(file).enabled, true);
  // The CLI flag is validated the same way.
  const cli = benchmark.dispatch(['run'], { config: file, 'offline-budget-min': 'x' });
  assertEqual(cli.ok, false);
  assert(/--offline-budget-min/.test(cli.reason), cli.reason);
});

// --- 4. a hung worker cannot hang the harness ---------------------------------

test('tick deadline: (max_wall_clock_min × TTL_FACTOR + 5) min — aligned to the lock TTL', () => {
  const { TTL_FACTOR } = require(path.join(LIB, 'locks.cjs'));
  assertEqual(benchmark.tickTimeoutMs(45), Math.round((45 * TTL_FACTOR + 5) * 60_000));
  assertEqual(benchmark.tickTimeoutMs(45), 4_350_000, '72.5 min for the default policy');
});

test('tick deadline: run() passes the lock-aligned timeout + SIGTERM on every worker spawn', () => {
  const dir = tmp('run-deadline');
  const { spawn, calls } = workerSpawn();
  const { reader } = sequence([WORKING, DONE]);
  benchmark.run({
    config: { enabled: true, owner: 'bench-owner', fixtures: { B: { stages_dir: 'unused/' } } },
    provision: () => ({ ok: true, fixture: 'B', repo: 'bench-owner/b-20260927-120001', dir }),
    spawn,
    snapshotReader: reader,
    ledgerReader: () => ({ rows: [] }),
    sleep: () => {},
    resultsDir: tmp('run-deadline-out'),
    logsRoot: tmp('run-deadline-logs'),
  });
  const ticks = calls.filter((c) => c.cmd === 'verity-worker');
  assertEqual(ticks.length, 1);
  assertEqual(ticks[0].options.timeout, 4_350_000, 'the fixture policy (default 45 min) × 1.5 + 5');
  assertEqual(ticks[0].options.killSignal, 'SIGTERM');
  assertEqual(ticks[0].options.env.VERITY_GH_LOG, '1', 'the gh retry log is on for the tick');
});

// Stage 112 (#290-3): made REAL — the child TRAPS SIGTERM and would live 5 s.
// defaultSpawn (the harness's own spawn) escalates to SIGKILL killGraceMs
// after the SIGTERM, so the tick ends at ~deadline + grace, not when the child
// chooses to exit. REGRESSION: on main defaultSpawn had no escalation, the
// SIGTERM was ignored and the harness blocked the full 5 s.
test('tick deadline: a REAL worker that traps SIGTERM is SIGKILLed after the grace, recorded tick_timeout; the loop proceeds', () => {
  const calls = [];
  const results = [];
  const spawn = (cmd, _args, options) => {
    calls.push({ cmd, options });
    if (calls.length === 1) {
      // Traps SIGTERM and would live on for 5 s past the 150 ms deadline.
      const res = benchmark.defaultSpawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000);"],
        options,
      );
      results.push(res);
      return res;
    }
    return {
      status: 0,
      error: null,
      stdout: 'verity-worker: idle — no eligible work\n',
      stderr: '',
    };
  };
  const { reader } = sequence([WORKING, WORKING, DONE]);
  const t0 = Date.now();
  const r = benchmark.drivePipeline({
    repo: 'o/r',
    dir: os.tmpdir(),
    spawn,
    snapshotReader: reader,
    maxTicks: 10,
    tickTimeoutMs: 150,
    killGraceMs: 200,
  });
  const elapsed = Date.now() - t0;
  // The observable outcome first: killed by SIGKILL, long before the child's 5 s.
  assert(elapsed < 3000, `the harness did not wait the child out (${elapsed} ms)`);
  assertEqual(results[0].signal, 'SIGKILL', 'the TERM-trapping child was SIGKILLed');
  assertEqual(results[0].escalated, true);
  assertEqual(calls[0].options.timeout, 150, 'the deadline reached the spawn');
  assertEqual(calls[0].options.killSignal, 'SIGTERM', 'TERM first');
  assertEqual(calls[0].options.killGraceMs, 200, 'the grace reached the spawn');
  assertEqual(r.tickLog[0].tick_outcome, 'tick_timeout');
  assertEqual(r.tickLog[0].outcome, 'tick_timeout', 'no verdict line — the kill is the outcome');
  assertEqual(r.tickLog[1].tick_outcome, 'exited', 'the next tick ran');
  assertEqual(r.tickLog[1].outcome, 'idle');
  assertEqual(r.stopReason, 'done', 'the loop proceeded to a terminal read');
  assertEqual(r.ticks, 2, 'the killed tick still counts against the budget');
});

test('tick deadline: the default grace is 10 s, and a child that honours SIGTERM is not escalated', () => {
  assertEqual(benchmark.TICK_KILL_GRACE_MS, 10_000);
  const { spawn, calls } = workerSpawn();
  const { reader } = sequence([WORKING, DONE]);
  benchmark.drivePipeline({ repo: 'o/r', dir: '/x', spawn, snapshotReader: reader, maxTicks: 5 });
  assertEqual(calls[0].options.killGraceMs, 10_000, 'the tick carries the default grace');
  const res = benchmark.defaultSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
    encoding: 'utf8',
    timeout: 150,
    killGraceMs: 2000,
  });
  assertEqual(res.signal, 'SIGTERM', 'TERM was enough');
  assertEqual(res.escalated, false);
  assertEqual(res.error?.code, 'ETIMEDOUT', 'still a timed-out child');
});

// --- 5. tick logs --------------------------------------------------------------

// Token-shaped literal assembled from fragments so the secret-scan CI never trips.
const FAKE_TOKEN = ['ghp', 'FAKEtickLogToken0000000'].join('_');

test('tick logs: stdout/stderr land in tick-001.log with the header; ticks[0] parsed; secrets never written', () => {
  const logDir = path.join(tmp('ticklog'), 'benchmark-x-run1');
  const stdout = [
    'verity-worker: note: something benign — not a verdict',
    'verity-worker: 20260927T120000Z-ab12 success — built stage 1',
    '',
  ].join('\n');
  const stderr = [
    'verity:gh status=retry attempt=1/4 exit=spawn ms=60001 reason=timeout cmd="gh pr list"',
    `leaked ${FAKE_TOKEN} in a message`,
    `Authorization: token ${FAKE_TOKEN}`,
    '',
  ].join('\n');
  const { spawn, calls } = workerSpawn(stdout, stderr);
  const { reader } = sequence([WORKING, DONE]);
  const r = withEnv({ VERITY_S110_SENTINEL: 'sentinel-env-value-do-not-log' }, () =>
    benchmark.drivePipeline({
      repo: 'o/r',
      dir: '/x',
      spawn,
      snapshotReader: reader,
      maxTicks: 5,
      logDir,
    }),
  );
  assertEqual(calls[0].options.env.VERITY_GH_LOG, '1', 'VERITY_GH_LOG=1 in the spawn env');
  const tick = r.tickLog[0];
  assertEqual(tick.n, 1);
  assertEqual(tick.exit_code, 0);
  assertEqual(tick.worker_run_id, '20260927T120000Z-ab12');
  assertEqual(tick.outcome, 'success');
  assertEqual(tick.tick_outcome, 'exited');
  assertEqual(tick.log, path.join(logDir, 'tick-001.log'));
  assert(typeof tick.started_at === 'string' && !Number.isNaN(Date.parse(tick.started_at)));
  assert(Number.isInteger(tick.wall_secs));
  const text = fs.readFileSync(tick.log, 'utf8');
  assert(text.startsWith('# verity benchmark tick 001\n'), text.slice(0, 80));
  assert(/# started_at: \d{4}-/.test(text), 'start time in the header');
  assert(/# wall_secs: \d+/.test(text), 'wall secs in the header');
  assert(/# exit_code: 0/.test(text), 'exit code in the header');
  assert(
    /# worker: verity-worker: 20260927T120000Z-ab12 success — built stage 1/.test(text),
    'the verdict line in the header',
  );
  assert(text.includes('reason=timeout cmd="gh pr list"'), 'stderr (the gh log) is kept');
  assert(text.includes('something benign'), 'stdout is kept');
  assert(!text.includes(FAKE_TOKEN), 'token shapes are redacted before the log touches disk');
  assert(!text.includes('sentinel-env-value-do-not-log'), 'no environment is ever written');
  assertEqual(fs.statSync(tick.log).mode & 0o777, 0o600, 'operator-private file');
});

test('tick logs: run() files them under ~/.verity/logs/benchmark-<run_id>/ and the record carries ticks[]', () => {
  const dir = tmp('run-logs');
  const logsRoot = tmp('run-logs-root');
  const { spawn } = workerSpawn('verity-worker: 20260927T1-cd34 gated — review:merge\n');
  const { reader } = sequence([WORKING, DONE]);
  const r = benchmark.run({
    config: { enabled: true, owner: 'bench-owner', fixtures: { B: { stages_dir: 'unused/' } } },
    provision: () => ({ ok: true, fixture: 'B', repo: 'bench-owner/b-20260927-120002', dir }),
    spawn,
    snapshotReader: reader,
    ledgerReader: () => ({ rows: [] }),
    sleep: () => {},
    resultsDir: tmp('run-logs-out'),
    logsRoot,
  });
  const rec = r.results[0];
  assertEqual(rec.run_id, 'b-20260927-120002-run1');
  assertEqual(rec.ticks.length, 1);
  assertEqual(
    Object.keys(rec.ticks[0]).join(','),
    'n,started_at,wall_secs,exit_code,worker_run_id,outcome,tick_outcome,log',
  );
  assertEqual(
    rec.ticks[0].log,
    path.join(logsRoot, 'benchmark-b-20260927-120002-run1', 'tick-001.log'),
  );
  assertEqual(rec.ticks[0].outcome, 'gated');
  assertEqual(rec.offline_waits, 0);
  assertEqual(rec.offline_secs, 0);
  assert(fs.existsSync(rec.ticks[0].log), 'the log file exists');
});

test('parseWorkerSummary: last verdict wins; idle/locked; notes and warnings never match', () => {
  const p = benchmark.parseWorkerSummary;
  assertEqual(p('').outcome, null);
  assertEqual(p('verity-worker: warn: failed — x\n').outcome, null, 'a warn line is not a verdict');
  assertEqual(p('verity-worker: idle — no eligible work\n').outcome, 'idle');
  assertEqual(p('verity-worker: locked — issue #3 held by r1\n').outcome, 'locked');
  const both = p('verity-worker: r1 failed — a\nverity-worker: r2 success — b\n');
  assertEqual(both.runId, 'r2');
  assertEqual(both.outcome, 'success');
});

// --- 6. source scan: no unbounded spawn on the worker's GitHub path -----------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function argSpan(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i += 1) {
    if (src[i] === '(') {
      depth += 1;
    } else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(openParen + 1, i);
      }
    }
  }
  return src.slice(openParen + 1);
}

test('source scan: every execFileSync/spawnSync on the worker GitHub path carries a timeout (git: no prompt)', () => {
  const files = [
    'gh.cjs',
    path.join('agents', 'git-lifecycle.cjs'),
    'review.cjs',
    'ledger.cjs',
    path.join('agents', 'intent-artifacts.cjs'),
    'benchmark.cjs',
  ];
  let scanned = 0;
  for (const rel of files) {
    const src = stripComments(fs.readFileSync(path.join(LIB, rel), 'utf8'));
    // A direct child_process call, or an (injectable) `spawn('git'|'gh', …)`
    // alias of one — git-lifecycle's git() spawns through `opts.spawn ||
    // spawnSync`. benchmark.cjs's own `spawn(...)` calls go through
    // defaultSpawn, whose spawnSync is scanned here.
    const re =
      rel === 'benchmark.cjs'
        ? /\b(execFileSync|spawnSync)\s*\(/g
        : /\b(execFileSync|spawnSync|spawn(?=\s*\(\s*'(?:git|gh)'))\s*\(/g;
    let m = re.exec(src);
    while (m !== null) {
      const span = argSpan(src, m.index + m[0].length - 1);
      assert(/\btimeout\s*:/.test(span), `${rel}: ${m[1]}(${span.slice(0, 60)}…) has no timeout`);
      if (/^\s*'git'/.test(span)) {
        assert(/GIT_TERMINAL_PROMPT/.test(span), `${rel}: git spawn without GIT_TERMINAL_PROMPT=0`);
      }
      scanned += 1;
      m = re.exec(src);
    }
  }
  assert(scanned >= 8, `the scan found the call sites (${scanned})`);
  // The harness's worker spawns go through ONE bounded helper (runTick), whose
  // options always carry the tick deadline.
  const bench = stripComments(fs.readFileSync(path.join(LIB, 'benchmark.cjs'), 'utf8'));
  const workerSpawns = bench.match(/spawn\(\s*'verity-worker'/g) || [];
  assertEqual(workerSpawns.length, 1, 'exactly one verity-worker spawn site');
  const runTick = bench.slice(
    bench.indexOf('function runTick('),
    bench.indexOf('function drivePipeline('),
  );
  assert(/ctx\.spawn\(\s*'verity-worker'/.test(runTick), 'the one site is inside runTick');
  assert(
    /timeout:\s*\n?\s*Number\.isInteger\(ctx\.tickTimeoutMs\)/.test(runTick),
    'with the tick deadline',
  );
});
