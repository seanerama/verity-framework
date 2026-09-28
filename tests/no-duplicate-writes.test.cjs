// Stage 112 — timeouts never duplicate a write; the ledger path fails closed.
//
// Evidence: reviewer follow-ups #290 (stage 110) and #283 (stage 108). Stage
// 110 made `timeout`/`network` transient for EVERY gh.run caller, so a comment
// POST that exceeded its deadline but landed was posted again — and
// countRepeatedRole read the two copies as two runs, refusing the role's next
// dispatch as no-progress after ONE real run. Separately, stage 108's
// resolveGitDir fell back to the in-tree ledger on ANY git failure, so a
// `dubious ownership` refusal sent one process to a file no other process uses
// and the daily breaker under-read.
//
// What is proven here:
//   1. gh.run: `idempotent: false` stops on an AMBIGUOUS failure (timeout,
//      reset, 5xx) after ONE attempt with GhError.ambiguous; pre-connect
//      failures still retry; idempotent calls keep the stage-110 retries.
//      classify never reads a status/network phrase out of the argv.
//   2. trust.merge: an ambiguous merge failure re-reads `gh pr view` — merged
//      ⇒ success `confirmed_by: 'pr-view'`; open (or merged at another head
//      than the pin) ⇒ the original error; never a second merge call.
//   3. lock acquire adopts its own landed lock comment; PR create adopts the
//      PR the branch has; issue create fails loud after exactly ONE attempt.
//   4. REGRESSION: a duplicated run summary no longer trips the breaker.
//   5. REGRESSION: resolveGitDir fails closed — "not a git repository" is the
//      only fallback; `dubious ownership` throws LedgerPathError, the worker
//      refuses the run as infra before the daily-limit check, and the CLI
//      verbs exit non-zero.
//   6. provider keys (sk-ant-, sk-proj-) never reach a tick log; recover
//      replaces the ledger by temp-file + rename and keeps a concurrent row;
//      untrack refuses mid-sequence/mid-bisect.
//   7. a source scan: every gh write call site declares its idempotency.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'verity', 'bin', 'lib');
const gh = require(path.join(LIB, 'gh.cjs'));
const trust = require(path.join(LIB, 'trust.cjs'));
const locks = require(path.join(LIB, 'locks.cjs'));
const usage = require(path.join(LIB, 'usage.cjs'));
const ledger = require(path.join(LIB, 'ledger.cjs'));
const benchmark = require(path.join(LIB, 'benchmark.cjs'));
const workItems = require(path.join(LIB, 'work-items.cjs'));
const gitLifecycle = require(path.join(LIB, 'agents', 'git-lifecycle.cjs'));
const operatorAct = require(path.join(LIB, 'operator-act.cjs'));
const worker = require(path.join(ROOT, 'verity', 'worker', 'index.cjs'));

const CLI = path.join(ROOT, 'verity', 'bin', 'verity.cjs');
const WORKER_BIN = path.join(ROOT, 'verity', 'worker', 'index.cjs');

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-s112-${tag}-`));
}

function catchErr(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
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

// The error execFileSync throws when it kills a child at its deadline.
function timeoutError() {
  return Object.assign(new Error('spawnSync gh ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    signal: 'SIGTERM',
    status: null,
    stdout: '',
    stderr: '',
  });
}

// A non-zero gh exit, shaped exactly like execFileSync's: message
// `Command failed: gh <argv>\n<stderr>`, the stderr also on its own field.
function ghFailure(args, stderr) {
  return Object.assign(new Error(`Command failed: gh ${args.join(' ')}\n${stderr}`), {
    status: 1,
    stderr,
    stdout: '',
  });
}

const RESET =
  'Post "https://api.github.com/repos/o/r/issues/1/comments": read tcp 10.0.0.2:5555->140.82.112.6:443: read: connection reset by peer';
const NO_HOST = 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host';

// A PATH directory holding stub executables (`name` → node source body).
function stubBin(scripts) {
  const dir = tmp('bin');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const [name, body] of Object.entries(scripts)) {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + JSON.stringify(args) + '\\n');
${body}
`,
    );
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return {
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    calls: (name) =>
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith(`${name} `))
        .map((l) => JSON.parse(l.slice(name.length + 1))),
  };
}

// --- 1. gh.run: ambiguous vs pre-connect ---------------------------------------

// REGRESSION (fails before, passes after): on main a timed-out write is retried
// 3 times — 4 attempts, each of which may land.
test('REGRESSION gh.run idempotent:false + timeout → ONE attempt, GhError.ambiguous, never retried', () => {
  let calls = 0;
  const slept = [];
  const err = catchErr(() =>
    gh.run(['api', '-X', 'POST', 'repos/o/r/issues/1/comments', '-f', 'body=x'], {
      idempotent: false,
      exec: () => {
        calls += 1;
        throw timeoutError();
      },
      sleep: (ms) => slept.push(ms),
      log: () => {},
    }),
  );
  assert(err instanceof gh.GhError, `a GhError, got: ${err}`);
  assertEqual(calls, 1, 'exactly one attempt');
  assertEqual(slept.length, 0, 'no backoff — nothing is retried');
  assertEqual(err.ambiguous, true);
  assertEqual(err.reason, 'timeout', 'the reason names the class');
  assertEqual(err.attempts, 1);
  assert(/not retried/.test(err.message), err.message);
});

test('gh.run idempotent:false + connection reset / HTTP 5xx → one attempt, ambiguous', () => {
  for (const [stderr, reason] of [
    [RESET, 'network'],
    ['dial tcp 140.82.112.6:443: i/o timeout', 'network'],
    ['net/http: TLS handshake timeout', 'network'],
    ['HTTP 502: Bad Gateway (https://api.github.com/graphql)', 'http-5xx'],
  ]) {
    let calls = 0;
    const args = ['pr', 'merge', '7', '--squash'];
    const err = catchErr(() =>
      gh.run(args, {
        idempotent: false,
        exec: () => {
          calls += 1;
          throw ghFailure(args, stderr);
        },
        sleep: () => {},
        log: () => {},
      }),
    );
    assertEqual(calls, 1, stderr);
    assertEqual(err.ambiguous, true, stderr);
    assertEqual(err.reason, reason, stderr);
  }
});

test('gh.run idempotent:false + a PRE-CONNECT failure is still retried (the request never left the box)', () => {
  for (const stderr of [
    NO_HOST,
    'connect: network is unreachable',
    'getaddrinfo EAI_AGAIN api.github.com',
    'connect: connection refused',
    'Could not resolve host: github.com',
    'You have exceeded a secondary rate limit',
  ]) {
    let calls = 0;
    const out = gh.run(['issue', 'create', '--title', 't'], {
      idempotent: false,
      exec: (args) => {
        calls += 1;
        if (calls === 1) {
          throw ghFailure(args, stderr);
        }
        return 'https://github.com/o/r/issues/9\n';
      },
      sleep: () => {},
      log: () => {},
    });
    assertEqual(calls, 2, `retried once then succeeded: ${stderr}`);
    assert(/issues\/9/.test(out), stderr);
  }
});

test('gh.run idempotent (default, or explicit true) + timeout → retried exactly as in stage 110', () => {
  for (const extra of [{}, { idempotent: true }]) {
    let calls = 0;
    const slept = [];
    const err = catchErr(() =>
      gh.run(['pr', 'list'], {
        ...extra,
        exec: () => {
          calls += 1;
          throw timeoutError();
        },
        sleep: (ms) => slept.push(ms),
        log: () => {},
        timeoutMs: 1000,
      }),
    );
    assertEqual(calls, 4, '1 attempt + 3 retries');
    assertEqual(slept.length, 3);
    assertEqual(err.reason, 'timeout');
    assertEqual(err.transient, true);
    assertEqual(err.ambiguous, false, 'an idempotent call is never "ambiguous"');
    assert(/timed out after 1000 ms \(4 attempts\)/.test(err.message), err.message);
  }
});

test('gh.run: an HTTP 5xx on a read keeps retrying; on a write it stops', () => {
  const run = (idempotent) => {
    let calls = 0;
    catchErr(() =>
      gh.run(['api', 'repos/o/r'], {
        idempotent,
        exec: (args) => {
          calls += 1;
          throw ghFailure(args, 'HTTP 503: Service Unavailable');
        },
        sleep: () => {},
        log: () => {},
      }),
    );
    return calls;
  };
  assertEqual(run(true), 4, 'read: retried');
  assertEqual(run(false), 1, 'write: not retried');
});

test('gh.classify (#290-4): a status or network phrase quoted in the argv never classifies the call', () => {
  const body = 'body=see HTTP 502 and dial tcp: i/o timeout in the log';
  const args = ['api', '-X', 'POST', 'repos/o/r/issues/1/comments', '-f', body];
  // The real failure is a 422; the body quotes a 502 and a network phrase.
  const c = gh.classify(ghFailure(args, 'HTTP 422: Validation Failed'));
  assertEqual(c.reason, 'http-422');
  assertEqual(c.transient, false);
  // No stderr at all: the argv alone must not read as 5xx/network.
  const bare = gh.classify(ghFailure(args, ''));
  assertEqual(bare.reason, 'error', 'a quoted body is not a verdict');
  // A multi-line body with a line that STARTS with the phrase.
  const multi = ['api', '-X', 'POST', 'x', '-f', 'body=line one\nHTTP 500: quoted'];
  assertEqual(gh.classify(ghFailure(multi, '')).reason, 'error');
  // gh api's own "(HTTP nnn)" suffix still classifies.
  assertEqual(gh.classify({ stderr: 'gh: Not Found (HTTP 404)' }).reason, 'http-404');
  // The stage-110 fixture shapes are unchanged.
  assertEqual(gh.classify({ stderr: 'HTTP 502: Bad Gateway' }).reason, 'http-5xx');
  assertEqual(gh.classify(new Error('HTTP 502 from gh')).reason, 'http-5xx');
});

test('gh.classify: ambiguous flags — timeout/reset/5xx ambiguous; pre-connect/rate-limit/4xx not', () => {
  const a = (err) => gh.classify(err).ambiguous;
  assertEqual(a({ code: 'ETIMEDOUT' }), true);
  assertEqual(a({ stderr: RESET }), true);
  assertEqual(a({ stderr: 'HTTP 500: x' }), true);
  assertEqual(a({ stderr: NO_HOST }), false);
  assertEqual(a({ stderr: 'connect: connection refused' }), false);
  assertEqual(a({ stderr: 'secondary rate limit' }), false);
  assertEqual(a({ stderr: 'HTTP 404: Not Found' }), false);
});

// --- 2. trust.merge: read-after-ambiguous ---------------------------------------

// An exec that fails the merge with `mergeErr` and answers `pr view` with `view`.
function mergeExec(mergeErr, view) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'merge') {
      throw mergeErr(args);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (view instanceof Error) {
        throw view;
      }
      return JSON.stringify(view);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { exec, calls };
}

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('REGRESSION trust.merge: a timed-out merge that LANDED is a success confirmed by pr view — one merge call', () => {
  const { exec, calls } = mergeExec(timeoutError, {
    state: 'MERGED',
    mergedAt: '2026-09-28T00:00:00Z',
    mergeCommit: { oid: 'c'.repeat(40) },
  });
  const res = trust.merge(7, { exec, sleep: () => {}, log: () => {} });
  assertEqual(res.merged, true);
  assertEqual(res.confirmed_by, 'pr-view');
  assertEqual(res.method, 'squash');
  const merges = calls.filter((a) => a[1] === 'merge');
  assertEqual(merges.length, 1, 'the merge is never re-issued');
  assertEqual(merges[0].join(' '), 'pr merge 7 --squash', 'unpinned argv unchanged');
  const view = calls.find((a) => a[1] === 'view');
  assertEqual(view.join(' '), 'pr view 7 --json state,mergedAt,mergeCommit');
});

test('trust.merge: timed out and pr view says OPEN → the ORIGINAL error, one merge call', () => {
  const { exec, calls } = mergeExec(timeoutError, { state: 'OPEN', mergedAt: null });
  const err = catchErr(() => trust.merge(7, { exec, sleep: () => {}, log: () => {} }));
  assert(err instanceof gh.GhError, `rethrows the merge GhError: ${err}`);
  assert(/timed out/.test(err.message), err.message);
  assertEqual(err.ambiguous, true);
  assertEqual(calls.filter((a) => a[1] === 'merge').length, 1);
});

test('trust.merge: an unreadable pr view after an ambiguous merge → the original error (fail closed)', () => {
  const { exec } = mergeExec(
    (args) => ghFailure(args, RESET),
    ghFailure(['pr', 'view'], 'HTTP 404: Not Found'),
  );
  const err = catchErr(() => trust.merge(7, { exec, sleep: () => {}, log: () => {} }));
  assert(/connection reset/.test(err.message), err.message);
});

test('trust.merge (pinned, stage 111): confirmed only at the PINNED head; merged elsewhere is not this merge', () => {
  const at = (headRefOid) =>
    mergeExec(timeoutError, { state: 'MERGED', mergedAt: 'x', mergeCommit: {}, headRefOid });
  const ok = at(HEAD);
  const res = trust.merge(
    7,
    { exec: ok.exec, sleep: () => {}, log: () => {} },
    { matchHead: HEAD },
  );
  assertEqual(res.confirmed_by, 'pr-view');
  assertEqual(
    ok.calls.find((a) => a[1] === 'merge').join(' '),
    `pr merge 7 --squash --match-head-commit ${HEAD}`,
    'the pin is kept on the one merge call',
  );
  assertEqual(
    ok.calls.find((a) => a[1] === 'view').join(' '),
    'pr view 7 --json state,mergedAt,mergeCommit,headRefOid',
  );
  const other = at(OTHER);
  const err = catchErr(() =>
    trust.merge(7, { exec: other.exec, sleep: () => {}, log: () => {} }, { matchHead: HEAD }),
  );
  assert(err instanceof gh.GhError, 'merged at another head ⇒ the original error');
  assertEqual(other.calls.filter((a) => a[1] === 'merge').length, 1);
});

test('trust.merge: a definite (non-ambiguous) refusal is reported as-is — no pr view read', () => {
  const { exec, calls } = mergeExec(
    (args) => ghFailure(args, 'HTTP 405: Pull Request is not mergeable'),
    { state: 'MERGED' },
  );
  const err = catchErr(() => trust.merge(7, { exec, sleep: () => {}, log: () => {} }));
  assertEqual(err.reason, 'http-405');
  assertEqual(calls.filter((a) => a[1] === 'view').length, 0);
});

test('trust.merge: a pre-connect failure is retried with the SAME (pinned) argv, then succeeds', () => {
  const calls = [];
  const res = trust.merge(
    7,
    {
      exec: (args) => {
        calls.push(args.join(' '));
        if (calls.length === 1) {
          throw ghFailure(args, NO_HOST);
        }
        return '';
      },
      sleep: () => {},
      log: () => {},
    },
    { matchHead: HEAD },
  );
  assertEqual(res.merged, true);
  assertEqual(res.confirmed_by, undefined, 'a direct success needs no confirmation');
  assertEqual(calls.length, 2);
  assertEqual(calls[0], calls[1], 'the retry carries the same pin');
});

// --- 3. lock acquire / PR create adopt; issue create fails loud -----------------

// A lock-protocol exec: item has no labels, the trail holds `trail`; the lock
// comment POST fails with `postErr` — and, when `lands`, lands anyway.
function lockExec({ postErr, lands }) {
  const trail = [];
  const posts = [];
  const exec = (args) => {
    const endpoint = args.find((a) => a.startsWith('repos/'));
    if (args.includes('DELETE')) {
      return ''; // the label removal (idempotent, never the question here)
    }
    if (args.includes('-X')) {
      if (endpoint.endsWith('/labels')) {
        return '{}';
      }
      const body = args[args.indexOf('-f') + 1].replace(/^body=/, '');
      posts.push(body);
      if (lands) {
        trail.push({ body });
      }
      throw postErr(args);
    }
    if (endpoint.includes('/comments')) {
      return JSON.stringify(trail);
    }
    return JSON.stringify({ labels: [] });
  };
  return { exec, posts };
}

test('locks.acquire: an ambiguous lock-comment failure whose comment LANDED is an acquired lock — one POST', () => {
  const { exec, posts } = lockExec({ postErr: () => timeoutError(), lands: true });
  const res = locks.acquire(41, {
    runId: 'run-1',
    ttlMinutes: 10,
    now: 0,
    repo: 'o/r',
    exec,
    sleep: () => {},
    log: () => {},
  });
  assertEqual(res.acquired, true);
  assertEqual(posts.length, 1, 'never posted twice');
  assert(posts[0].startsWith('lock:run-1 expires:'), posts[0]);
});

test('locks.acquire: an ambiguous failure whose comment did NOT land → the original error, one POST', () => {
  const { exec, posts } = lockExec({ postErr: (a) => ghFailure(a, RESET), lands: false });
  const err = catchErr(() =>
    locks.acquire(41, {
      runId: 'run-1',
      ttlMinutes: 10,
      now: 0,
      repo: 'o/r',
      exec,
      sleep: () => {},
      log: () => {},
    }),
  );
  assert(err instanceof gh.GhError && err.ambiguous === true, `${err}`);
  assertEqual(posts.length, 1);
});

test('locks.release: an ambiguous unlock failure is reported once, never re-posted (no double strike)', () => {
  const { exec, posts } = lockExec({ postErr: () => timeoutError(), lands: true });
  const logged = [];
  const res = locks.release(41, {
    runId: 'run-1',
    outcome: 'failed',
    repo: 'o/r',
    exec,
    sleep: () => {},
    log: (l) => logged.push(l),
  });
  assertEqual(res.released, false);
  assertEqual(posts.length, 1, 'one unlock:<id> outcome:failed line, never two');
});

function stageRepo() {
  const dir = tmp('stage');
  fs.mkdirSync(path.join(dir, 'stage-instructions'));
  fs.writeFileSync(
    path.join(dir, 'stage-instructions', 'stage-1-demo.md'),
    '# Stage 1: Demo\n\n- **Type:** feature\n\n## Acceptance conditions\n- [ ] it works\n',
  );
  return dir;
}

test('git-lifecycle openPr: an ambiguous `pr create` adopts the PR the branch now has — one create', () => {
  const dir = stageRepo();
  const calls = [];
  let created = false;
  const exec = (args) => {
    calls.push(args);
    if (args[1] === 'list') {
      return created ? '[{"number":17}]' : '[]';
    }
    created = true; // the create landed on GitHub…
    throw timeoutError(); // …but the call timed out
  };
  const pr = gitLifecycle.openPr(
    dir,
    { branch: 'feat/stage-1-demo', stage: 1 },
    { exec, sleep: () => {}, log: () => {} },
  );
  assertEqual(pr, 17, 'adopted');
  assertEqual(calls.filter((a) => a[1] === 'create').length, 1, 'never created twice');
  assertEqual(calls.map((a) => a.slice(0, 2).join(' ')).join(', '), 'pr list, pr create, pr list');
  assertEqual(
    calls[1].slice(0, 4).join(' '),
    'pr create --head feat/stage-1-demo',
    'the pinned create argv',
  );
});

test('git-lifecycle openPr: ambiguous create and no PR for the branch → the original error', () => {
  const dir = stageRepo();
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    if (args[1] === 'list') {
      return '[]';
    }
    throw ghFailure(args, RESET);
  };
  const err = catchErr(() =>
    gitLifecycle.openPr(
      dir,
      { branch: 'feat/stage-1-demo', stage: 1 },
      { exec, sleep: () => {}, log: () => {} },
    ),
  );
  assert(err instanceof gh.GhError && err.ambiguous === true, `${err}`);
  assertEqual(calls.filter((a) => a[1] === 'create').length, 1);
});

// REGRESSION (fails before, passes after): a REAL `gh` whose issue create dies
// with a connection reset (it may have landed) is invoked exactly ONCE — on
// main gh.run retried it three more times (four possible issues).
test('REGRESSION work-items: an ambiguous `gh issue create` fails LOUD after exactly one attempt (spawn-arg pinned)', () => {
  const dir = stageRepo();
  const stub = stubBin({
    gh: `process.stderr.write(${JSON.stringify(`${RESET}\n`)}); process.exit(1);`,
  });
  const res = withEnv({ PATH: stub.PATH }, () =>
    workItems.reconcileWorkItems(dir, { flag: true, substrate: 'github', ghList: () => [] }),
  );
  const creates = stub.calls('gh');
  assertEqual(creates.length, 1, `exactly one create attempt, got ${creates.length}`);
  assertEqual(
    JSON.stringify(creates[0].slice(0, 4)),
    JSON.stringify(['issue', 'create', '--title', '[stage 1] Demo']),
    'the pinned argv',
  );
  assertEqual(res.created.length, 0);
  assertEqual(res.failed.length, 1, 'the step failed');
  assert(/may exist; not re-created/.test(res.failed[0].error), res.failed[0].error);
});

test('operator-act request-changes: the comment op is non-idempotent; the label op bag is unchanged', () => {
  const seen = [];
  const run = (argv, opts) => {
    seen.push({ argv: argv.join(' '), opts });
    return '{}';
  };
  const res = operatorAct.dispatch(
    ['request-changes', '9'],
    { repo: 'acme/widget', note: 'n' },
    { run },
  );
  assertEqual(res.ok, true);
  assertEqual(seen.length, 2);
  assertEqual(seen[0].opts.idempotent, undefined, 'label add: the byte-identical { cwd } bag');
  assertEqual(seen[1].opts.idempotent, false, 'comment POST: idempotent:false');
});

// --- 4. the repeat-dispatch breaker dedupes -------------------------------------

function summaryBody(runId, roles) {
  return worker.formatRunSummary({
    runId,
    outcome: 'success',
    roles,
    result: 'ok',
    tokens: { in: 1, out: 1 },
    est_usd: 0.1,
    wall_secs: 1,
  });
}

// REGRESSION (fails before, passes after): on main the two copies of ONE run's
// summary counted 2 — MAX_REPEAT_DISPATCHES — and the role's next dispatch was
// refused as no-progress and escalated to needs-human after one real run.
test('REGRESSION countRepeatedRole: a duplicated run summary counts ONCE and cannot trip the breaker', () => {
  const one = summaryBody('run-20260928T000000Z-aaaaaa', ['build']);
  const trail = [{ body: 'lock:run-x expires:y' }, { body: one }, { body: one }];
  const streak = worker.countRepeatedRole(trail, 'build');
  assertEqual(streak, 1, 'one run, however many copies');
  assert(streak < worker.MAX_REPEAT_DISPATCHES, 'the next dispatch is allowed');
});

test('countRepeatedRole: distinct runs still count; a duplicate inside the streak neither extends nor breaks it', () => {
  const a = summaryBody('run-a', ['build']);
  const b = summaryBody('run-b', ['build']);
  assertEqual(worker.countRepeatedRole([{ body: a }, { body: b }], 'build'), 2);
  assertEqual(worker.countRepeatedRole([{ body: a }, { body: a }, { body: b }], 'build'), 2);
  assertEqual(worker.countRepeatedRole([a, b, b], 'build'), 2, 'string bodies too');
  const plan = summaryBody('run-p', ['plan']);
  assertEqual(
    worker.countRepeatedRole([{ body: a }, { body: plan }, { body: plan }, { body: b }], 'build'),
    1,
    'a different run still breaks the streak',
  );
});

// --- 5. resolveGitDir fails closed -----------------------------------------------

// A directory that LOOKS like a repository (a .git dir) with a stub `git` on
// PATH answering rev-parse the way a real one refuses.
function refusingGit(stderr, code = 128) {
  const dir = tmp('repo');
  fs.mkdirSync(path.join(dir, '.git'));
  const stub = stubBin({
    git: `process.stderr.write(${JSON.stringify(`${stderr}\n`)}); process.exit(${code});`,
  });
  return { dir, stub };
}

const DUBIOUS =
  "fatal: detected dubious ownership in repository at '/srv/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/repo";

test('resolveGitDir: git says "not a git repository" → null, and ledgerPath is the in-tree fallback', () => {
  const { dir, stub } = refusingGit(
    'fatal: not a git repository (or any of the parent directories): .git',
  );
  withEnv({ PATH: stub.PATH }, () => {
    assertEqual(usage.resolveGitDir(dir), null);
    assertEqual(usage.ledgerPath(dir), path.join(dir, '.verity', 'usage.csv'));
  });
  // No repository anywhere up the tree: any git failure is "not a repository".
  const plain = tmp('plain');
  const broken = stubBin({ git: 'process.stderr.write("boom\\n"); process.exit(2);' });
  withEnv({ PATH: broken.PATH }, () => {
    assertEqual(usage.resolveGitDir(plain), null, 'no .git walking up ⇒ fallback');
  });
});

// REGRESSION (fails before, passes after): on main a `dubious ownership`
// refusal inside a real repository silently fell back to the in-tree ledger.
test('REGRESSION resolveGitDir: `dubious ownership` inside a repository throws LedgerPathError — no fallback', () => {
  const { dir, stub } = refusingGit(DUBIOUS);
  withEnv({ PATH: stub.PATH }, () => {
    const err = catchErr(() => usage.ledgerPath(dir));
    assert(err instanceof usage.LedgerPathError, `LedgerPathError, got: ${err}`);
    assert(/cannot locate the usage ledger/.test(err.message), err.message);
    assert(/dubious ownership/.test(err.message), 'names the git error');
    // Every reader fails closed the same way — never an empty (zero) read.
    assert(catchErr(() => usage.readUsage(dir)) instanceof usage.LedgerPathError, 'readUsage');
    assert(
      catchErr(() => usage.checkDailyLimits(dir, { max_runs_per_day: 1 })) instanceof
        usage.LedgerPathError,
      'checkDailyLimits never reads zero',
    );
  });
  assert(!fs.existsSync(path.join(dir, '.verity')), 'nothing written in-tree');
});

test('resolveGitDir: other git failures inside a repository (config error, missing binary) throw too', () => {
  const cfg = refusingGit('fatal: bad config line 3 in file /home/u/.gitconfig');
  withEnv({ PATH: cfg.stub.PATH }, () => {
    assert(catchErr(() => usage.resolveGitDir(cfg.dir)) instanceof usage.LedgerPathError);
  });
  // A stand-in git that exits 0 with no usable answer, inside a repository.
  const junk = refusingGit('', 0);
  withEnv({ PATH: junk.stub.PATH }, () => {
    assert(catchErr(() => usage.resolveGitDir(junk.dir)) instanceof usage.LedgerPathError);
  });
  const missing = tmp('nogit');
  fs.mkdirSync(path.join(missing, '.git'));
  withEnv({ PATH: tmp('empty-path') }, () => {
    assert(
      catchErr(() => usage.resolveGitDir(missing)) instanceof usage.LedgerPathError,
      'no git binary inside a repository',
    );
  });
});

test('CLI: `verity usage`, `usage recover`, `usage untrack` and `operator runs` exit non-zero on an unlocatable ledger', () => {
  const { dir, stub } = refusingGit(DUBIOUS);
  for (const args of [
    ['usage', '--json'],
    ['usage', 'recover', '--json'],
    ['usage', 'untrack', '--json'],
    ['operator', 'runs', '--json'],
    ['operator', 'usage', '--json'],
  ]) {
    const res = spawnSync(process.execPath, [CLI, ...args, '--cwd', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: stub.PATH },
    });
    assert(res.status !== 0, `${args.join(' ')}: exit ${res.status}`);
    assert(
      /cannot locate the usage ledger/.test(`${res.stderr}${res.stdout}`),
      `${args.join(' ')} names the error: ${res.stderr}${res.stdout}`,
    );
  }
});

function policyRepo() {
  const dir = tmp('worker');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.verity'));
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'mode: supervised\n');
  return dir;
}

test('worker: a throwing ledger resolver refuses the run as infra (exit 30) BEFORE checkDailyLimits and any gh call', () => {
  const dir = policyRepo();
  const saved = {
    ledgerPath: usage.ledgerPath,
    checkDailyLimits: usage.checkDailyLimits,
    seedLedger: usage.seedLedger,
    run: gh.run,
    json: gh.json,
  };
  const touched = [];
  usage.ledgerPath = () => {
    throw new usage.LedgerPathError(dir, 'fatal: detected dubious ownership');
  };
  usage.checkDailyLimits = () => {
    touched.push('checkDailyLimits');
    return { ok: true, totals: {} };
  };
  usage.seedLedger = () => {
    touched.push('seedLedger');
    return { seeded: 0, tracked: false };
  };
  gh.run = (args) => {
    touched.push(`gh ${args.join(' ')}`);
    return '';
  };
  gh.json = (args) => {
    touched.push(`gh ${args.join(' ')}`);
    return {};
  };
  let err;
  try {
    err = catchErr(() => worker.runOnce({ repo: 'o/r', cwd: dir, stdout() {}, stderr() {} }));
  } finally {
    Object.assign(usage, {
      ledgerPath: saved.ledgerPath,
      checkDailyLimits: saved.checkDailyLimits,
      seedLedger: saved.seedLedger,
    });
    gh.run = saved.run;
    gh.json = saved.json;
  }
  assert(err instanceof worker.WorkerError, `a WorkerError, got: ${err}`);
  assertEqual(err.exitCode, 30, 'infra');
  assertEqual(err.slug, 'ledger-path');
  assert(/cannot locate the usage ledger/.test(err.message), err.message);
  assertEqual(JSON.stringify(touched), '[]', 'no daily-limit read, no seed, no gh call');
});

// REGRESSION (fails before, passes after): the real worker, with a git that
// refuses `dubious ownership`, exits 30 ledger-path before touching gh. On
// main it fell back to an empty in-tree ledger, passed the daily check and
// went on to call gh.
test('REGRESSION worker CLI: `dubious ownership` → exit 30 ledger-path, zero gh calls', () => {
  const dir = policyRepo();
  const stub = stubBin({
    git: `process.stderr.write(${JSON.stringify(`${DUBIOUS}\n`)}); process.exit(128);`,
    gh: 'process.stderr.write("HTTP 401: Bad credentials\\n"); process.exit(1);',
  });
  const res = spawnSync(process.execPath, [WORKER_BIN, '--repo', 'o/r', '--once', '--cwd', dir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: stub.PATH, VERITY_GH_LOG: '' },
  });
  assertEqual(res.status, 30, `exit 30 (infra): ${res.stderr}`);
  assert(
    /^verity-worker: 30 ledger-path: cannot locate the usage ledger/m.test(res.stderr),
    res.stderr,
  );
  assertEqual(stub.calls('gh').length, 0, 'no gh call before the refusal');
});

// --- 6. redaction, recover, untrack ---------------------------------------------

// Key-shaped literals assembled from fragments so the secret-scan CI never trips.
const ANT_KEY = ['sk', 'ant', 'api03', 'FAKEtickLogKey000000000000'].join('-');
const PROJ_KEY = ['sk', 'proj', 'FAKEtickLogKey000000000000'].join('-');

test('REGRESSION redaction (#290-2): sk-ant- and sk-proj- keys never reach a tick log', () => {
  const logDir = path.join(tmp('ticklog'), 'benchmark-x-run1');
  const spawn = (cmd) => {
    if (cmd !== 'verity-worker') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return {
      status: 0,
      error: null,
      stdout: `verity-worker: idle — no eligible work (${ANT_KEY})\n`,
      stderr: `ANTHROPIC_API_KEY=${ANT_KEY}\nOPENAI_API_KEY=${PROJ_KEY}\n`,
    };
  };
  let reads = 0;
  const r = benchmark.drivePipeline({
    repo: 'o/r',
    dir: '/x',
    spawn,
    snapshotReader: () => {
      reads += 1;
      return reads === 1
        ? { online: true, next: { role: 'build' }, queue: {} }
        : { online: true, next: null, queue: {} };
    },
    maxTicks: 3,
    logDir,
    sleep: () => {},
  });
  const file = r.tickLog[0].log;
  assert(typeof file === 'string', 'a tick log was written');
  const text = fs.readFileSync(file, 'utf8');
  assert(!text.includes(ANT_KEY), 'no sk-ant- key in the tick log');
  assert(!text.includes(PROJ_KEY), 'no sk-proj- key in the tick log');
  assert(text.includes('[redacted]'), 'redacted in place');
  // One pattern set: the redactor covers every promotion SECRET_PATTERNS shape.
  assertEqual(ledger.redact(`a ${ANT_KEY} b ${PROJ_KEY}`), 'a [redacted] b [redacted]');
});

function repoWithHistory() {
  const dir = tmp('recover');
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'bot@example.com']);
  git(['config', 'user.name', 'verity-bot']);
  fs.mkdirSync(path.join(dir, '.verity'));
  fs.writeFileSync(
    path.join(dir, '.verity', 'usage.csv'),
    `${usage.HEADER}\n2026-09-01T00:00:00.000Z,run-tree,o/r,build,1,1,0.1,1,success,0,build,,,\n`,
  );
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const live = usage.ledgerPath(dir);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(
    live,
    `${usage.HEADER}\n2026-09-02T00:00:00.000Z,run-live,o/r,build,1,1,0.1,1,success,0,build,,,\n`,
  );
  return { dir, live };
}

const LATE_ROW = '2026-09-03T00:00:00.000Z,run-late,o/r,review,1,1,0.1,1,success,0,review,,,';

test('recover (#283 N4): a row appended between recover’s read and its rename is preserved', () => {
  const { dir, live } = repoWithHistory();
  let injected = false;
  const res = usage.recoverLedger(dir, {
    beforeFinalRead: () => {
      fs.appendFileSync(live, `${LATE_ROW}\n`); // a worker appends concurrently
      injected = true;
    },
  });
  assert(injected, 'the concurrent append happened mid-recover');
  assertEqual(res.rows_added, 1, 'the tree row was recovered');
  const text = fs.readFileSync(live, 'utf8');
  for (const id of ['run-tree', 'run-live', 'run-late']) {
    assert(text.includes(`,${id},`), `${id} kept: ${text}`);
  }
  assert(text.startsWith(`${usage.HEADER}\n`), 'header first');
  assertEqual(
    fs.readdirSync(path.dirname(live)).filter((f) => f.endsWith('.tmp')).length,
    0,
    'no temp file left behind',
  );
});

test('recover (#283 N4): an interrupted write leaves the previous ledger intact', () => {
  const { dir, live } = repoWithHistory();
  const before = fs.readFileSync(live, 'utf8');
  const err = catchErr(() =>
    usage.recoverLedger(dir, {
      beforeFinalRead: () => {
        throw new Error('killed mid-write');
      },
    }),
  );
  assert(err !== null && /killed mid-write/.test(err.message), `${err}`);
  assertEqual(fs.readFileSync(live, 'utf8'), before, 'byte-identical live ledger');
  assertEqual(
    fs.readdirSync(path.dirname(live)).filter((f) => f.endsWith('.tmp')).length,
    0,
    'the partial temp file is removed',
  );
});

test('untrack (#283 N6): refuses while a cherry-pick/revert sequence or a bisect is in progress', () => {
  for (const [marker, what] of [
    ['sequencer', /sequence is in progress/],
    ['BISECT_LOG', /bisect is in progress/],
  ]) {
    const { dir } = repoWithHistory();
    const gitDir = path.join(dir, '.git');
    if (marker === 'sequencer') {
      fs.mkdirSync(path.join(gitDir, marker));
    } else {
      fs.writeFileSync(path.join(gitDir, marker), 'git bisect start\n');
    }
    const res = usage.untrackLedger(dir);
    assertEqual(res.ok, false, marker);
    assertEqual(res.refused, marker);
    assert(what.test(res.reason), res.reason);
    assertEqual(res.changed, false, 'nothing written');
  }
});

// --- 7. source scan: every gh write declares its idempotency ----------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// The balanced span starting at src[open] (one of '(' '[' '{').
function span(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === src[open]) {
      depth += 1;
    } else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) {
        return src.slice(open + 1, i);
      }
    }
  }
  return src.slice(open + 1);
}

function libFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...libFiles(full));
    } else if (entry.name.endsWith('.cjs')) {
      out.push(full);
    }
  }
  return out;
}

const WRITE_RE = /'POST'|'PATCH'|'PUT'|'create'|'merge'|'edit'/;

test('source scan: every gh.run/gh.json/ghRun whose args are a write passes idempotent:false (label adds: explicit true)', () => {
  const sites = [];
  for (const file of libFiles(path.join(ROOT, 'verity'))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /\b(gh\.run|gh\.json|ghRun)\s*\(/g;
    let m = re.exec(src);
    while (m !== null) {
      const call = span(src, m.index + m[0].length - 1);
      // The argv: a literal array, or an identifier resolved to the nearest
      // `const|let <id> = [` in the same function.
      const lead = call.search(/\S/);
      let argv = call[lead] === '[' ? span(call, lead) : call;
      const ident = /^\s*([A-Za-z_$][\w$]*)\s*,/.exec(call);
      if (ident !== null) {
        const fnStart = src.lastIndexOf('\nfunction ', m.index);
        const body = src.slice(fnStart, m.index);
        const decl = new RegExp(`(?:const|let)\\s+${ident[1]}\\s*=\\s*\\[`, 'g');
        let last = null;
        let d = decl.exec(body);
        while (d !== null) {
          last = d;
          d = decl.exec(body);
        }
        argv = last === null ? '' : span(body, last.index + last[0].length - 1);
      }
      if (WRITE_RE.test(argv)) {
        const rel = path.relative(ROOT, file);
        const labelAdd = /'POST'/.test(argv) && /\/labels`/.test(argv);
        if (labelAdd) {
          assert(/idempotent:\s*true/.test(call), `${rel}: a label add states idempotent: true`);
        } else {
          assert(
            /idempotent:\s*false/.test(call),
            `${rel}: ${m[1]}(${argv.replace(/\s+/g, ' ').slice(0, 70)}…) must pass idempotent: false`,
          );
        }
        sites.push(`${rel}:${labelAdd ? 'label' : 'write'}`);
      }
      m = re.exec(src);
    }
  }
  const writes = sites.filter((s) => s.endsWith(':write'));
  for (const where of [
    'verity/worker/index.cjs',
    'verity/bin/lib/locks.cjs',
    'verity/bin/lib/trust.cjs',
    'verity/bin/lib/work-items.cjs',
    'verity/bin/lib/agents/git-lifecycle.cjs',
    'verity/bin/lib/promotion.cjs',
  ]) {
    assert(writes.includes(`${where}:write`), `the scan found the write in ${where}: ${sites}`);
  }
  assert(writes.length >= 7, `the scan found the write call sites (${writes.length})`);
  // operator-act builds its ops as objects run later: each POST op states it.
  const act = stripComments(fs.readFileSync(path.join(LIB, 'operator-act.cjs'), 'utf8'));
  const ops = act.match(/argv: \['api', '-X', 'POST'[^\n]*\n[\s\S]*?\n {2}\};/g) || [];
  assertEqual(ops.length, 2, 'label-add and comment op builders');
  for (const op of ops) {
    const want = /\/comments`/.test(op) ? /idempotent: false/ : /idempotent: true/;
    assert(want.test(op), `operator-act op declares its idempotency: ${op.slice(0, 80)}`);
  }
});
