// Stage 50 — the operator-act contract (contracts/operator-act.md, frozen v1).
// `verity operator act <verb>` is the operator seam's ONLY write surface. These
// tests drive act()/dispatch() with an INJECTED fake `gh.run` (records every
// argv; returns/throws per scenario) and an INJECTED fake worker spawn, so they
// perform ZERO real network/process, and prove every safety invariant:
//   - each verb issues EXACTLY the documented gh api argv (method+endpoint+label);
//     reject's three ops in effect-order; request-changes posts a comment;
//   - NO MERGE: across ALL verbs the recorded argvs NEVER contain a `merge` token;
//     approve makes exactly one write and (v2, ADR-0037) its reason names the
//     effect.consequence its read-only prediction computed;
//   - idempotency: a simulated already-present(POST 200) / already-absent(DELETE
//     404) ⇒ ok:true;
//   - fail-closed: a simulated real gh error ⇒ ok:false + reason + non-zero exit;
//   - input validation: missing / flag-shaped / non-numeric target ⇒ refused
//     BEFORE any gh.run call (the fake gh is never invoked);
//   - unknown verb ⇒ an allowlist error;
//   - redaction: a token-shaped string in a --note / error never survives (the
//     token is assembled from RUNTIME fragments, never a literal in source).
const operatorAct = require('../verity/bin/lib/operator-act.cjs');

const REPO = 'acme/widget';

// A recording fake `gh.run`. `behavior(argv)` may return a string (success) or
// throw — default is success. Every argv it receives is captured in `.calls`.
function fakeGh(behavior) {
  const calls = [];
  const run = (argv, opts) => {
    calls.push({ argv, opts });
    const b = behavior ? behavior(argv, calls.length) : undefined;
    if (b instanceof Error) {
      throw b;
    }
    return typeof b === 'string' ? b : '';
  };
  return { run, calls };
}

// A GhError-shaped error (gh.cjs encodes the HTTP status in `.reason`).
function ghError(reason, message) {
  const err = new Error(message || `gh failed (${reason})`);
  err.name = 'GhError';
  err.reason = reason;
  return err;
}

// Assemble a token from RUNTIME fragments — NEVER a literal ghp_ + alnum in
// source (the promotion secret-scan smoke test flags a literal — it cost stage
// 47 a CI run).
function fakeToken() {
  return `ghp_${'A'.repeat(20)}`;
}

// Run a dispatch with an injected fake gh; returns { result, calls }.
function dispatchWith(args, flags, behavior, extra = {}) {
  const gh = fakeGh(behavior);
  const result = operatorAct.dispatch(args, { repo: REPO, ...flags }, { run: gh.run, ...extra });
  return { result, calls: gh.calls };
}

function argvOf(call) {
  return call.argv.join(' ');
}

test('approve → POST verity:approved (the ONE write); reason names the consequence (v2)', () => {
  const { result, calls } = dispatchWith(['approve', '42'], {});
  assertEqual(result.ok, true, 'approve ok');
  assertEqual(result.action, 'approve', 'action');
  assertEqual(result.target, 42, 'target parsed to int');
  assertEqual(result.effect.kind, 'label-add', 'effect kind');
  assertEqual(result.effect.label, 'verity:approved', 'effect label');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/42/labels -f labels[]=verity:approved',
    'exact approve argv',
  );
  // Stage 111 amendment (operator-act v2, ADR-0037): the verb still makes
  // exactly ONE write; any further call is a read-only consequence read.
  assertEqual(calls.filter((c) => c.argv.includes('-X')).length, 1, 'exactly one write');
  assert(
    /\(consequence: [a-z-]+ — /.test(result.reason),
    `approve reason names its consequence, got: ${result.reason}`,
  );
});

test('reject → DELETE approved, DELETE awaiting, POST needs-human in order', () => {
  const { result, calls } = dispatchWith(['reject', '7'], {});
  assertEqual(result.ok, true, 'reject ok');
  assertEqual(calls.length, 3, 'three ops');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/7/labels/verity%3Aapproved',
    'op1 removes approved',
  );
  assertEqual(
    argvOf(calls[1]),
    'api -X DELETE repos/acme/widget/issues/7/labels/verity%3Aawaiting-approval',
    'op2 removes awaiting-approval',
  );
  assertEqual(
    argvOf(calls[2]),
    'api -X POST repos/acme/widget/issues/7/labels -f labels[]=verity:needs-human',
    'op3 adds needs-human',
  );
  assertEqual(result.effects.length, 3, 'three effects in order');
  assertEqual(result.effects[0].kind, 'label-remove', 'effect1 remove');
  assertEqual(result.effects[2].kind, 'label-add', 'effect3 add');
});

test('request-changes → POST needs-human + a comment carrying the note', () => {
  const { result, calls } = dispatchWith(['request-changes', '9'], {
    note: 'please fix the tests',
  });
  assertEqual(result.ok, true, 'ok');
  assertEqual(calls.length, 2, 'two ops');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/9/labels -f labels[]=verity:needs-human',
    'op1 adds needs-human',
  );
  assertEqual(
    argvOf(calls[1]),
    'api -X POST repos/acme/widget/issues/9/comments -f body=please fix the tests',
    'op2 posts the comment',
  );
  assertEqual(result.effects[1].kind, 'comment', 'second effect is a comment');
});

test('request-changes with no --note posts a default rework note', () => {
  const { calls } = dispatchWith(['request-changes', '9'], {});
  assertEqual(calls.length, 2, 'two ops');
  assert(/comments -f body=/.test(argvOf(calls[1])), 'a comment is still posted');
  assert(
    argvOf(calls[1]).length > 'api -X POST repos/acme/widget/issues/9/comments -f body='.length,
    'default note is non-empty',
  );
});

test('needs-human → POST needs-human', () => {
  const { result, calls } = dispatchWith(['needs-human', '3'], {});
  assertEqual(result.ok, true, 'ok');
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/3/labels -f labels[]=verity:needs-human',
    'exact argv',
  );
});

test('clear-needs-human → DELETE needs-human', () => {
  const { result, calls } = dispatchWith(['clear-needs-human', '3'], {});
  assertEqual(result.ok, true, 'ok');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/3/labels/verity%3Aneeds-human',
    'exact argv',
  );
});

test('circuit open → POST circuit-open; circuit close → DELETE circuit-open', () => {
  // Stage 52: `circuit open` first READS its target to prove it is an open
  // issue (the breaker query cannot see PRs or closed issues), so the fake must
  // now feed that precondition read. Only the fixture changed — the argv
  // assertion below is the same one, on the same label POST.
  const open = dispatchWith(['circuit', 'open', '12'], {}, openIssueRead);
  assertEqual(open.result.ok, true, 'open ok');
  assertEqual(open.result.action, 'circuit open', 'action');
  assertEqual(open.calls.length, 2, 'precondition read + the label POST');
  assertEqual(
    argvOf(open.calls[1]),
    'api -X POST repos/acme/widget/issues/12/labels -f labels[]=verity:circuit-open',
    'open argv',
  );
  const close = dispatchWith(['circuit', 'close', '12'], {});
  assertEqual(close.result.ok, true, 'close ok');
  assertEqual(
    argvOf(close.calls[0]),
    'api -X DELETE repos/acme/widget/issues/12/labels/verity%3Acircuit-open',
    'close argv',
  );
});

test('circuit without open|close is refused before any gh call', () => {
  const { result, calls } = dispatchWith(['circuit', '12'], {});
  assertEqual(result.ok, false, 'refused');
  assertEqual(calls.length, 0, 'no gh call');
});

test('run-once relays the worker outcome, never a merge claim', () => {
  const spawns = [];
  const spawn = (cmd, cmdArgs) => {
    spawns.push({ cmd, cmdArgs });
    return { status: 0, stdout: 'worker: one tick, no work', stderr: '' };
  };
  const result = operatorAct.dispatch(['run-once'], { repo: REPO }, { spawn });
  assertEqual(result.ok, true, 'ok on exit 0');
  assertEqual(result.action, 'run-once', 'action');
  assertEqual(result.target, null, 'no target');
  assertEqual(result.effect.kind, 'worker-tick', 'worker-tick effect');
  assertEqual(result.effect.exitCode, 0, 'relays exit code');
  assertEqual(spawns.length, 1, 'spawned once');
  assertEqual(spawns[0].cmd, 'verity-worker', 'spawns the worker binary');
  assertEqual(spawns[0].cmdArgs.join(' '), `--repo ${REPO} --once`, 'worker argv');
});

test('run-once fails closed on a non-zero worker exit', () => {
  const spawn = () => ({ status: 20, stdout: '', stderr: 'boom' });
  const result = operatorAct.dispatch(['run-once'], { repo: REPO }, { spawn });
  assertEqual(result.ok, false, 'ok:false on non-zero exit');
  assertEqual(result.effect.exitCode, 20, 'relays exit code');
});

// --- Invariant 1: NO MERGE AUTHORITY, EVER --------------------------------
test('NO verb ever issues a `merge` argv (spied across every verb)', () => {
  const invocations = [
    ['approve', '1'],
    ['reject', '1'],
    ['request-changes', '1'],
    ['needs-human', '1'],
    ['clear-needs-human', '1'],
    ['circuit', 'open', '1'],
    ['circuit', 'close', '1'],
  ];
  for (const args of invocations) {
    // openIssueRead feeds `circuit open`'s precondition read (stage 52) so this
    // spy still sees that verb's real label POST, not a refusal.
    const { calls } = dispatchWith(args, { note: 'x' }, openIssueRead);
    for (const call of calls) {
      for (const tok of call.argv) {
        assert(
          !/merge/i.test(String(tok)),
          `verb ${args[0]} must never issue a merge argv (${tok})`,
        );
      }
    }
  }
});

// --- Invariant 4: IDEMPOTENT ----------------------------------------------
test('idempotent: DELETE of an already-absent label (gh 404) ⇒ ok:true', () => {
  const behavior = () => ghError('http-404', 'HTTP 404: Label does not exist');
  const { result, calls } = dispatchWith(['clear-needs-human', '5'], {}, behavior);
  assertEqual(result.ok, true, 'already-absent delete is idempotent ok');
  assertEqual(calls.length, 1, 'the op was attempted');
});

test('idempotent: POST of an already-present label (gh 200 no-op) ⇒ ok:true', () => {
  // GitHub returns 200 (no throw) when adding a present label.
  const behavior = () => 'ok';
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, true, 'already-present add is ok');
});

// --- Invariant 3: FAIL-CLOSED ---------------------------------------------
test('fail-closed: a real gh error ⇒ ok:false + reason + non-zero exit map', () => {
  const behavior = () => ghError('http-403', 'HTTP 403: Resource not accessible');
  const { result, calls } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'real error fails closed');
  assert(typeof result.reason === 'string' && result.reason.length > 0, 'has a reason');
  assertEqual(calls.length, 1, 'the op was attempted');
  // verity.cjs maps ok:false → non-zero exit; assert the mapping the CLI uses.
  const exit = result.ok ? 0 : 1;
  assert(exit !== 0, 'a failed act maps to a non-zero exit');
});

test('fail-closed: a 404 on a POST (add) is NOT swallowed — it fails closed', () => {
  // 404 is only idempotent for a DELETE (already-absent). A 404 on an add is a
  // real error (e.g. issue not found) and must fail closed.
  const behavior = () => ghError('http-404', 'HTTP 404: Not Found');
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'add 404 is not idempotent-swallowed');
});

// --- Invariant 5: INPUT-VALIDATED -----------------------------------------
test('missing / flag-shaped / non-numeric target ⇒ refused before any gh call', () => {
  for (const args of [
    ['approve'],
    ['approve', '--'],
    ['approve', 'abc'],
    ['approve', '0'],
    ['approve', '-3'],
  ]) {
    const { result, calls } = dispatchWith(args, {});
    assertEqual(result.ok, false, `refused: ${JSON.stringify(args)}`);
    assertEqual(result.effect, null, 'no effect performed');
    assertEqual(calls.length, 0, `gh.run NEVER called for ${JSON.stringify(args)}`);
  }
});

test('missing repo ⇒ refused before any gh call (fail closed)', () => {
  const gh = fakeGh();
  // repo explicitly null via opts overrides GH_REPO too.
  const result = operatorAct.dispatch(['approve', '5'], {}, { run: gh.run, repo: null });
  assertEqual(result.ok, false, 'no repo ⇒ ok:false');
  assertEqual(gh.calls.length, 0, 'gh.run never called');
});

// --- Invariant 2: ALLOWLIST ONLY ------------------------------------------
test('unknown verb ⇒ an allowlist error naming the valid verbs', () => {
  const gh = fakeGh();
  let threw = null;
  try {
    operatorAct.dispatch(['bogus-verb', '1'], { repo: REPO }, { run: gh.run });
  } catch (err) {
    threw = err;
  }
  assert(threw !== null, 'unknown verb throws');
  assert(/unknown operator act verb/i.test(threw.message), 'message names it as unknown');
  assert(/approve/.test(threw.message), 'message lists valid verbs');
  assertEqual(gh.calls.length, 0, 'no gh call for an unknown verb');
});

// --- Redaction (invariant 4 of the contract: no credential shape survives) --
test('a token-shaped string in a --note never survives into the result', () => {
  const token = fakeToken();
  const { result } = dispatchWith(['request-changes', '9'], {
    note: `secret is ${token} do not leak`,
  });
  const json = JSON.stringify(result);
  assert(!json.includes(token), 'the token must not survive redaction in the result');
  assert(json.includes('[redacted]'), 'the token was redacted');
});

test('a token-shaped string in a gh error never survives into the reason', () => {
  const token = fakeToken();
  const behavior = () => ghError('http-401', `HTTP 401 for token ${token}`);
  const { result } = dispatchWith(['approve', '5'], {}, behavior);
  assertEqual(result.ok, false, 'fails closed');
  assert(!JSON.stringify(result).includes(token), 'token redacted out of the reason');
});

// --- Stage 52 (#135): the repo field is an ENDPOINT, so it must be validated --
//
// `apiBase` interpolates the resolved repo straight into the `gh api` PATH, and
// `gh api` truncates the endpoint at `?` / `#` — everything after is a query
// string / fragment. So a hostile `--repo`/`GH_REPO` retargets the label
// POST/DELETE at an ARBITRARY endpoint (e.g. DELETE
// /repos/{o}/{r}/branches/main/protection) while the envelope still reports a
// label op with ok:true. The existing "NO MERGE spy" greps argv tokens for the
// literal `merge` — a branch-protection DELETE contains no such token and sails
// straight past it. These assertions are therefore on the RESOLVED ENDPOINT:
// the path GitHub actually routes, after the ?/# truncation.

// The endpoint is the first non-flag token after `api` (skipping the value of
// -X/-f/-F/-H). Returns null if this argv is not a `gh api` call.
function endpointOf(argv) {
  const start = argv.indexOf('api');
  if (start === -1) {
    return null;
  }
  for (let i = start + 1; i < argv.length; i += 1) {
    const tok = String(argv[i]);
    if (tok === '-X' || tok === '-f' || tok === '-F' || tok === '-H') {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    return tok;
  }
  return null;
}

// Resolve an endpoint the way `gh api` does: split on the first ? or #, keep
// the path. This is the ONLY assertion that would have caught the defect.
function resolvedPath(endpoint) {
  return String(endpoint).split(/[?#]/)[0];
}

// Repo shapes that are NOT a GitHub owner/name slug. Each one either escapes the
// issues subtree outright or truncates into a different endpoint.
const HOSTILE_REPOS = [
  'acme/widget/branches/main/protection?',
  'acme/widget#frag',
  'acme/widget/extra',
  'acme/widget?',
  'owner',
  '',
  '   ',
  '../../x',
  'acme/widget with space',
];

// Every verb in the allowlist, incl. run-once (which hands the repo to the
// worker's argv via spawn, not gh.run — so the choke point must cover it too).
const EVERY_VERB = [
  ['approve', '1'],
  ['reject', '1'],
  ['request-changes', '1'],
  ['needs-human', '1'],
  ['clear-needs-human', '1'],
  ['circuit', 'open', '1'],
  ['circuit', 'close', '1'],
  ['run-once'],
];

// Drive one verb with BOTH seams injected and report what each seam recorded.
function actWithSeams(args, flags, opts = {}) {
  const gh = fakeGh(opts.behavior);
  const spawns = [];
  const spawn = (cmd, cmdArgs) => {
    spawns.push({ cmd, cmdArgs });
    return { status: 0, stdout: 'worker: one tick, no work', stderr: '' };
  };
  const result = operatorAct.dispatch(args, flags, { run: gh.run, spawn });
  return { result, calls: gh.calls, spawns };
}

// Run fn with GH_REPO forced to `value` (undefined = unset), then restore.
const GH_REPO_ENV = 'GH_REPO';

function withGhRepo(value, fn) {
  const had = Object.hasOwn(process.env, GH_REPO_ENV);
  const prev = process.env[GH_REPO_ENV];
  if (value === undefined) {
    delete process.env[GH_REPO_ENV];
  } else {
    process.env[GH_REPO_ENV] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[GH_REPO_ENV] = prev;
    } else {
      delete process.env[GH_REPO_ENV];
    }
  }
}

test('repo injection (--repo rung): every hostile repo is refused for EVERY verb, before any gh.run or spawn', () => {
  withGhRepo(undefined, () => {
    for (const repo of HOSTILE_REPOS) {
      for (const args of EVERY_VERB) {
        const where = `${args.join(' ')} --repo ${JSON.stringify(repo)}`;
        const { result, calls, spawns } = actWithSeams(args, { repo });
        assertEqual(result.ok, false, `refused: ${where}`);
        assertEqual(result.effect, null, `effect:null: ${where}`);
        assertEqual(result.effects, undefined, `no effects array on a refusal: ${where}`);
        assertEqual(calls.length, 0, `gh.run NEVER called: ${where}`);
        assertEqual(spawns.length, 0, `spawn NEVER called: ${where}`);
        // verity.cjs:295-309 maps ok:false → exitCode 1 (fail-closed).
        assert((result.ok ? 0 : 1) !== 0, `maps to a non-zero exit: ${where}`);
      }
    }
  });
});

test('repo injection (GH_REPO rung): the env path is refused identically for EVERY verb', () => {
  for (const repo of HOSTILE_REPOS) {
    withGhRepo(repo, () => {
      for (const args of EVERY_VERB) {
        const where = `${args.join(' ')} GH_REPO=${JSON.stringify(repo)}`;
        // No --repo flag at all: resolveRepo must fall through to GH_REPO.
        const { result, calls, spawns } = actWithSeams(args, {});
        assertEqual(result.ok, false, `refused: ${where}`);
        assertEqual(result.effect, null, `effect:null: ${where}`);
        assertEqual(calls.length, 0, `gh.run NEVER called: ${where}`);
        assertEqual(spawns.length, 0, `spawn NEVER called: ${where}`);
      }
    });
  }
});

test('the refusal reason names the offending repo value and the required owner/name form', () => {
  withGhRepo(undefined, () => {
    const { result } = actWithSeams(['reject', '1'], {
      repo: 'acme/widget/branches/main/protection?',
    });
    assertEqual(result.ok, false, 'refused');
    assert(
      result.reason.includes('acme/widget/branches/main/protection?'),
      'reason quotes the offending value',
    );
    assert(/owner\/name/.test(result.reason), 'reason names the required form');
    assert(/before any/i.test(result.reason), 'reason states nothing was called');
  });
});

test('positive control: with a VALID repo every resolved endpoint stays inside repos/acme/widget/issues/<n>', () => {
  withGhRepo(undefined, () => {
    for (const args of EVERY_VERB) {
      if (args[0] === 'run-once') {
        continue;
      }
      const { result, calls } = actWithSeams(
        args,
        { repo: REPO, note: 'x' },
        {
          behavior: openIssueRead,
        },
      );
      assertEqual(result.ok, true, `${args.join(' ')} ok with a valid repo`);
      assert(calls.length > 0, `${args.join(' ')} issued at least one gh call`);
      for (const call of calls) {
        const endpoint = endpointOf(call.argv);
        assert(endpoint !== null, `${args.join(' ')} is a gh api call`);
        const seg = resolvedPath(endpoint).split('/');
        assertEqual(seg[0], 'repos', `${args.join(' ')}: routed under repos/`);
        assertEqual(seg[1], 'acme', `${args.join(' ')}: owner segment`);
        assertEqual(seg[2], 'widget', `${args.join(' ')}: name segment`);
        assertEqual(
          seg[3],
          'issues',
          `${args.join(' ')}: the resolved path NEVER leaves the issues subtree (got ${resolvedPath(endpoint)})`,
        );
        assertEqual(seg[4], '1', `${args.join(' ')}: the resolved path targets item #1`);
      }
    }
  });
});

// --- Stage 52 (#135): the kill switch must prove it can actually halt --------
//
// The worker's breaker query is
// `gh issue list --label verity:circuit-open --state open` (worker/index.cjs:798)
// — it never returns PRs, and --state open excludes closed issues. So labelling
// a PR or a closed issue is a GENUINE write that halts NOTHING, reported green.
// `circuit open` must verify its target is an OPEN ISSUE first, and fail closed
// when it cannot.

const PRECONDITION_ARGV = 'api repos/acme/widget/issues/12';

// The precondition read's payload for a plain open issue. Used as a default
// behavior wherever a test drives `circuit open` incidentally.
function openIssueRead() {
  return '{"state":"open","number":12}';
}

test('circuit open on a PR ⇒ ok:false, NO label write, reason names the breaker query', () => {
  const { result, calls } = dispatchWith(
    ['circuit', 'open', '12'],
    {},
    () => '{"state":"open","number":12,"pull_request":{"url":"https://api.github.com/x"}}',
  );
  assertEqual(result.ok, false, 'refused on a PR');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'the ONLY call is the precondition read');
  assertEqual(argvOf(calls[0]), PRECONDITION_ARGV, 'the precondition read argv');
  assert(/pull request/i.test(result.reason), 'reason says it is a PR');
  assert(/gh issue list/.test(result.reason), "reason quotes the worker's breaker query");
  assert(/--state open/.test(result.reason), 'reason names the --state open filter');
});

test('circuit open on a CLOSED issue ⇒ ok:false, NO label write', () => {
  const { result, calls } = dispatchWith(
    ['circuit', 'open', '12'],
    {},
    () => '{"state":"closed","number":12}',
  );
  assertEqual(result.ok, false, 'refused on a closed issue');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'the ONLY call is the precondition read');
  assert(/closed/i.test(result.reason), 'reason says it is closed');
  assert(/--state open/.test(result.reason), 'reason names the filter that hides it');
});

test('circuit open with an UNREADABLE target fails closed — never claims the switch is armed', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, () =>
    ghError('http-403', 'HTTP 403: Resource not accessible'),
  );
  assertEqual(result.ok, false, 'refused on an unverifiable read');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'no label write was attempted');
  assert(/could not (verify|read|check)/i.test(result.reason), 'reason names the failed read');
  assert(!/halts/.test(result.reason), 'reason NEVER claims the worker halts');
});

test('circuit open with unparseable precondition JSON fails closed', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, () => 'not json at all');
  assertEqual(result.ok, false, 'refused on unparseable JSON');
  assertEqual(result.effect, null, 'no effect');
  assertEqual(calls.length, 1, 'no label write was attempted');
  assert(!/halts/.test(result.reason), 'reason NEVER claims the worker halts');
});

test('circuit open on a genuine OPEN ISSUE still issues the exact documented POST', () => {
  const { result, calls } = dispatchWith(['circuit', 'open', '12'], {}, openIssueRead);
  assertEqual(result.ok, true, 'ok on an open issue');
  assertEqual(result.effect.kind, 'label-add', 'label-add effect');
  assertEqual(result.effect.label, 'verity:circuit-open', 'the breaker label');
  assertEqual(calls.length, 2, 'precondition read + the label POST');
  assertEqual(argvOf(calls[0]), PRECONDITION_ARGV, 'op1 is the precondition read');
  assertEqual(
    argvOf(calls[1]),
    'api -X POST repos/acme/widget/issues/12/labels -f labels[]=verity:circuit-open',
    'op2 is the exact documented POST',
  );
  assert(/halts/.test(result.reason), 'reason may claim the halt — it is now proven');
});

test('DELIBERATE ASYMMETRY: circuit close is NOT gated — its DELETE issues with NO precondition read', () => {
  // Refusing to REMOVE a halt label is not fail-closed, and gating close would
  // strand a verity:circuit-open label a pre-fix build already applied to a PR
  // or a closed issue. This test pins the asymmetry so it is never "fixed" into
  // symmetry. The fake returns a payload that WOULD read as a closed PR — if
  // close ever grew a precondition it would refuse here, and this test fails.
  const { result, calls } = dispatchWith(
    ['circuit', 'close', '12'],
    {},
    () => '{"state":"closed","pull_request":{"url":"https://api.github.com/x"}}',
  );
  assertEqual(result.ok, true, 'close succeeds regardless of the target kind/state');
  assertEqual(calls.length, 1, 'exactly ONE call — no precondition read');
  assertEqual(
    argvOf(calls[0]),
    'api -X DELETE repos/acme/widget/issues/12/labels/verity%3Acircuit-open',
    'the only call is the DELETE',
  );
});

// --- Stage 111 amendment (ADR-0037, contracts/operator-act-v2.md § Schema) ----
//
// `approve` reports `effect.consequence` — what the worker's NEXT tick does with
// the token — from the SAME inputs as the worker's review:merge gate copy
// (trust, the parked verdict + its head vs the PR's current head, the review
// runtime's merge authority), decided by the SAME pure function
// (trust.approvalConsequence) approvalHint words. Any input that cannot be read
// ⇒ 'unknown'. The verb still performs exactly ONE write (the label POST) and
// never merges: the prediction's reads are GETs taken after the write.
const trustLadder = require('../verity/bin/lib/trust.cjs');
const worker = require('../verity/worker/index.cjs');

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const PARKED_RUN = 'run-20260927-parked';

function policyOf({ trust = 0, provider = 'claude' } = {}) {
  return {
    gates: ['review:merge', 'ship:prod', 'golive'],
    review: { trust },
    agent: { provider: 'claude', roles: { review: { provider } } },
  };
}

// A real worker gate comment (formatGateComment) — the trail the worker itself
// writes, so the act side is proven to parse the worker's own format.
function gateBody({ gate = 'review:merge', parked = { role: 'review', pr: 42, head: HEAD } } = {}) {
  return worker.formatGateComment({
    runId: 'run-20260927-gate',
    gate,
    pending: 'review of PR #42 completed',
    mentions: [],
    parked: parked === null ? null : { runId: PARKED_RUN, ...parked },
    approval: 'x',
  });
}

// Stage 111 review F1/F3: the gate comments are the BOT's (author + time), the
// label's `labeled` event is a human's, AFTER the gate. A trail entry is a body
// string (posted by the bot) or a full comment object (any author).
const GATE_AT = '2026-09-27T10:00:00Z';
const LABELED_AT = '2026-09-27T10:05:00Z';
const labeled = (actor = 'seanerama', at = LABELED_AT) => ({
  event: 'labeled',
  label: { name: 'verity:approved' },
  actor: { login: actor },
  created_at: at,
});

// Route the fake gh by endpoint: the label POST succeeds; the comment trail,
// the PR read and the label timeline serve the scenario (an Error is thrown).
function scenario({
  trail = [gateBody()],
  head = HEAD,
  labelError = null,
  timeline = [labeled()],
} = {}) {
  return (argv) => {
    if (argv.includes('-X')) {
      return labelError === null ? '' : labelError;
    }
    const endpoint = String(argv[1]);
    if (endpoint.startsWith('repos/acme/widget/issues/42/comments?')) {
      return trail instanceof Error
        ? trail
        : JSON.stringify(
            trail.map((c) =>
              typeof c === 'string'
                ? { body: c, user: { login: 'verity-bot' }, created_at: GATE_AT }
                : c,
            ),
          );
    }
    if (endpoint.startsWith('repos/acme/widget/issues/42/timeline?')) {
      return timeline instanceof Error ? timeline : JSON.stringify(timeline);
    }
    if (endpoint === 'repos/acme/widget/pulls/42') {
      return head instanceof Error ? head : JSON.stringify({ head: { sha: head } });
    }
    return new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
}

// The worker host's local park record for the parked run (F1): exactly what
// the worker's recordPark wrote when it posted gateBody()'s pointer.
// Stage 111 round 3: the record carries the GitHub time of the review's
// pre-dispatch head read (before the gate comment).
const HEAD_READ_AT = '2026-09-27T09:30:00Z';
function parkRecordFor({
  head = HEAD,
  gate = 'review:merge',
  bot = 'verity-bot',
  headReadAt = HEAD_READ_AT,
} = {}) {
  return (runId) =>
    runId === PARKED_RUN
      ? {
          schema: 1,
          role: 'review',
          run_id: PARKED_RUN,
          pr: 42,
          head,
          gate,
          bot,
          head_read_at: headReadAt,
          approval: null,
        }
      : null;
}

function parkedResult(verdict, outcome = 'success') {
  return () => ({ outcome, artifacts: verdict === null ? {} : { verdict, pr: 42 }, error: null });
}

// Drive approve through act() with every seam injected; returns the result and
// the recorded gh call log.
function approveWith({
  policy = policyOf(),
  readParkedResult = parkedResult('approve'),
  readParkRecord = parkRecordFor(),
  ...s
} = {}) {
  const gh = fakeGh(scenario(s));
  const result = operatorAct.act('approve', ['42'], {
    repo: REPO,
    substrate: 'github',
    run: gh.run,
    policy,
    readParkedResult,
    readParkRecord,
  });
  return { result, calls: gh.calls };
}

// The write discipline every consequence path must keep: the FIRST call is the
// one documented label POST, it is the ONLY call carrying -X (every other call
// is a read), and no argv carries a merge token.
function assertOneWriteNoMerge(calls, label) {
  assertEqual(
    argvOf(calls[0]),
    'api -X POST repos/acme/widget/issues/42/labels -f labels[]=verity:approved',
    `${label}: the first call is the one label POST`,
  );
  const writes = calls.filter((c) => c.argv.includes('-X'));
  assertEqual(writes.length, 1, `${label}: exactly one write`);
  for (const call of calls) {
    for (const tok of call.argv) {
      assert(!/merge/i.test(String(tok)), `${label}: no merge argv (${tok})`);
    }
  }
}

function assertConsequence(result, calls, value, label) {
  assertEqual(result.ok, true, `${label}: ok`);
  assertEqual(result.effect.kind, 'label-add', `${label}: effect kind unchanged`);
  assertEqual(result.effect.label, 'verity:approved', `${label}: effect label unchanged`);
  assertEqual(result.effect.item, 42, `${label}: effect item unchanged`);
  assertEqual(result.effect.consequence, value, `${label}: consequence (${result.reason})`);
  assert(
    result.reason.includes(`(consequence: ${value} — `),
    `${label}: the reason names the consequence, got: ${result.reason}`,
  );
  assert(!/not a merge/i.test(result.reason), `${label}: no "not a merge" copy`);
  assertOneWriteNoMerge(calls, label);
}

test('approve consequence merge-when-green: trust 0, parked approve verdict, unchanged head', () => {
  const { result, calls } = approveWith();
  assertConsequence(result, calls, 'merge-when-green', 'merge-when-green');
  assertEqual(calls.length, 4, 'label POST + trail read + head read + label-timeline read');
  assertEqual(
    Object.keys(result).join(','),
    'schema,action,target,effect,ok,reason',
    'no new top-level field',
  );
});

test('approve consequence resume: a parked request_changes re-gates at zero cost', () => {
  const r = approveWith({ readParkedResult: parkedResult('request_changes') });
  assertConsequence(r.result, r.calls, 'resume', 'request_changes');
});

test('approve consequence (review F5): trust 1/2 + approve verdict + unchanged head is UNKNOWN — the ladder may merge; never `resume`', () => {
  for (const trust of [1, 2]) {
    const r = approveWith({ policy: policyOf({ trust }) });
    assertConsequence(r.result, r.calls, 'unknown', `approve at trust ${trust}`);
    assert(r.result.reason.includes('may merge'), r.result.reason);
  }
});

test('approve consequence re-review: head moved, no parked pointer, or a verdict-less parked result', () => {
  let r = approveWith({ head: MOVED });
  assertConsequence(r.result, r.calls, 're-review', 'head moved');
  assert(r.result.reason.includes('head moved'), r.result.reason);
  // The bot is authenticated by an earlier pointer's park record; its LATEST
  // pause recorded no pointer ⇒ the worker buys a fresh review.
  r = approveWith({ trail: [gateBody(), gateBody({ parked: null })] });
  assertConsequence(r.result, r.calls, 're-review', 'no pointer');
  // With no pointer anywhere, nothing authenticates the bot here ⇒ unknown.
  r = approveWith({ trail: [gateBody({ parked: null })] });
  assertConsequence(r.result, r.calls, 'unknown', 'no pointer to authenticate by');
  r = approveWith({ readParkedResult: parkedResult(null) });
  assertConsequence(r.result, r.calls, 're-review', 'no verdict');
  r = approveWith({
    trail: [gateBody({ parked: { role: 'review', pr: 42, head: 'unknown' } })],
    readParkRecord: parkRecordFor({ head: 'unknown' }),
  });
  assertConsequence(r.result, r.calls, 're-review', 'unknown recorded head');
});

test('approve consequence gate: escalate, or a review runtime without merge authority', () => {
  let r = approveWith({ readParkedResult: parkedResult('escalate') });
  assertConsequence(r.result, r.calls, 'gate', 'escalate');
  r = approveWith({ policy: policyOf({ provider: 'grok' }) });
  assertConsequence(r.result, r.calls, 'gate', 'no merge authority');
  assert(r.result.reason.includes('no merge authority'), r.result.reason);
});

test('ATTACK F1 (act): a FORGED gate comment never yields merge-when-green', () => {
  // The PR author's comment names the real parked run and an unreviewed head.
  const forged = {
    body: gateBody({ parked: { role: 'review', pr: 42, head: MOVED } }),
    user: { login: 'mallory' },
    created_at: '2026-09-27T10:01:00Z',
  };
  // (a) the forger's comment is the ONLY gate comment: nothing authenticates.
  let r = approveWith({ trail: [forged], head: MOVED });
  assert(r.result.effect.consequence !== 'merge-when-green', 'forged-only trail');
  assertConsequence(r.result, r.calls, 'unknown', 'forged-only trail');
  // (b) forged AFTER the bot's real pause, head moved: the real pause decides
  // and its head moved — re-review, never a merge.
  r = approveWith({ trail: [gateBody(), forged], head: MOVED });
  assertConsequence(r.result, r.calls, 're-review', 'forged after the real pause');
  // (c) a bot-authored pointer that does not match the local park record (an
  // EDITED comment): not honoured — re-review.
  r = approveWith({ readParkRecord: parkRecordFor({ head: MOVED }) });
  assertConsequence(r.result, r.calls, 'unknown', 'no matching record authenticates the bot');
  // (d) the record exists but names another bot: nothing authenticates.
  r = approveWith({ readParkRecord: parkRecordFor({ bot: 'someone-else' }) });
  assertConsequence(r.result, r.calls, 'unknown', 'record by another bot');
});

test('ATTACK F3/F4 (act): a label the worker will not honour is `gate`, never merge-when-green', () => {
  const cases = [
    ['labeled before the gate', { timeline: [labeled('seanerama', '2026-09-27T09:00:00Z')] }],
    ['labeled by the bot', { timeline: [labeled('verity-bot')] }],
    [
      'labeled by an actor not in humans:',
      { timeline: [labeled('triage-bot')], policy: { ...policyOf(), humans: ['seanerama'] } },
    ],
  ];
  for (const [label, s] of cases) {
    const { result, calls } = approveWith(s);
    assertConsequence(result, calls, 'gate', label);
    assert(result.reason.includes('will not honour this label'), result.reason);
  }
  const ok = approveWith({ policy: { ...policyOf(), humans: ['SeaneRama'] } });
  assertConsequence(ok.result, ok.calls, 'merge-when-green', 'a listed human after the gate');
  const unread = approveWith({ timeline: ghError('http-502', 'HTTP 502') });
  assertConsequence(unread.result, unread.calls, 'unknown', 'timeline unreadable');
});

test('ATTACK N1 (act): a push to the PR after the review read its head, or a record with no read time, is `re-review` — never merge-when-green', () => {
  const forced = (at) => ({
    event: 'head_ref_force_pushed',
    actor: { login: 'mallory' },
    created_at: at,
  });
  const cases = [
    ['A→B→A inside the review window', { timeline: [forced('2026-09-27T09:40:00Z'), labeled()] }],
    [
      'force-push at the read instant (tie ⇒ after)',
      { timeline: [forced(HEAD_READ_AT), labeled()] },
    ],
    [
      'a commit added after the read',
      {
        timeline: [
          { event: 'committed', sha: MOVED, committer: { date: '2026-09-27T09:45:00Z' } },
          labeled(),
        ],
      },
    ],
    ['park record without head_read_at', { readParkRecord: parkRecordFor({ headReadAt: null }) }],
  ];
  for (const trust of [0, 1, 2]) {
    for (const [label, s] of cases) {
      const { result, calls } = approveWith({ policy: policyOf({ trust }), ...s });
      assertConsequence(result, calls, 're-review', `${label} (trust ${trust})`);
    }
  }
  // A push BEFORE the read is not a push after it: still merge-when-green,
  // and the PR's timeline (the item IS the PR) is read once for both checks.
  const before = approveWith({ timeline: [forced('2026-09-27T09:00:00Z'), labeled()] });
  assertConsequence(before.result, before.calls, 'merge-when-green', 'push before the read');
  assertEqual(
    before.calls.filter((c) => String(c.argv[1]).includes('/timeline?')).length,
    1,
    'one timeline read serves the push and label checks',
  );
});

test('approve consequence (review F9): a resolver that throws AFTER the write reports unknown, never a failed verb', () => {
  // A policy the gate-name resolver throws on (read after the label write).
  const policy = {
    review: { trust: 0 },
    agent: { provider: 'claude' },
    get gates() {
      throw new Error('policy gates unreadable');
    },
  };
  const { result, calls } = approveWith({ policy });
  assertEqual(result.ok, true, 'the label was applied — the verb succeeded');
  assertEqual(result.effect.consequence, 'unknown', result.reason);
  assertEqual(calls.length, 1, 'no read after the unresolvable policy');
});

test('approve consequence unknown: any unreadable input is unknown — never a guess', () => {
  const cases = [
    ['trail read fails', { trail: ghError('http-502', 'HTTP 502') }],
    ['head read fails', { head: ghError('timeout', 'gh api timed out after 60000 ms') }],
    ['parked result not on this host', { readParkedResult: () => null }],
    [
      'parked result unreadable',
      {
        readParkedResult: () => {
          throw new Error('EACCES');
        },
      },
    ],
    ['no gate pause at all', { trail: ['just a comment'] }],
    [
      'latest gate is not review:merge',
      { trail: [gateBody(), gateBody({ gate: 'ci:unverified', parked: null })] },
    ],
    ['park record not on this host', { readParkRecord: () => null }],
    [
      'park record unreadable',
      {
        readParkRecord: () => {
          throw new Error('EACCES');
        },
      },
    ],
  ];
  for (const [label, s] of cases) {
    const { result, calls } = approveWith(s);
    assertConsequence(result, calls, 'unknown', label);
  }
});

test('approve consequence unknown: an unreadable autonomy policy (the real loader) is unknown', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-act-policy-'));
  try {
    fs.mkdirSync(path.join(dir, '.verity'));
    // trust 9 is out of range — loadPolicy refuses it (PolicyError).
    fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'review:\n  trust: 9\n');
    const gh = fakeGh(scenario({}));
    const result = operatorAct.act('approve', ['42'], {
      repo: REPO,
      cwd: dir,
      substrate: 'github',
      run: gh.run,
      readParkedResult: parkedResult('approve'),
    });
    assertConsequence(result, gh.calls, 'unknown', 'policy unreadable');
    assert(result.reason.includes('policy could not be read'), result.reason);
    assertEqual(gh.calls.length, 1, 'no read is taken once the policy is unreadable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approve whose label write FAILS carries no consequence, takes no read, and keeps its failure reason', () => {
  const { result, calls } = approveWith({ labelError: ghError('http-403', 'HTTP 403: nope') });
  assertEqual(result.ok, false, 'fails closed');
  assertEqual(calls.length, 1, 'only the attempted write — no prediction reads');
  assert(!('consequence' in result.effect), 'no consequence for a token that was not applied');
  assert(/^approve on #42 failed: /.test(result.reason), result.reason);
});

// Parity: the act verb's consequence and the worker's gate copy are one
// decision. For every input combination the worker's approvalHint words the
// consequence trust.approvalConsequence returns — its text belongs to that
// consequence's family and to no family it contradicts.
const HINT_FAMILIES = {
  'merge-when-green': (t) =>
    /the next tick merges (when|once) CI is green|CI is not green; apply `verity:approved` once it is, from a human account/.test(
      t,
    ),
  // v2 `resume`: a parked NON-approve verdict re-gates at zero cost.
  resume: (t) =>
    /approving the unchanged head re-gates at zero cost/.test(t) &&
    !/next tick merges|re-run the trust ladder/.test(t),
  're-review': (t) =>
    /re-review|fresh review at full price/.test(t) &&
    !/approving the unchanged head re-gates at zero cost/.test(t) &&
    !/next tick merges/.test(t),
  gate: (t) => /never merges|does not merge/.test(t) && !/next tick merges/.test(t),
  // Review F5: trust 1/2 + approve — the ladder re-runs and MAY merge.
  unknown: (t) => /re-run the trust ladder/.test(t) && !/re-gates at zero cost/.test(t),
};

test('parity: approvalHint and trust.approvalConsequence agree across the shared input matrix', () => {
  let n = 0;
  for (const trust of [0, 1, 2, 7]) {
    for (const verdict of ['approve', 'request_changes', 'escalate', 'lgtm', null, '']) {
      for (const mergeAuthority of [true, false]) {
        for (const hasPr of [true, false]) {
          for (const resumable of [true, false]) {
            for (const greenKnown of [true, false, null]) {
              for (const approved of [false, true]) {
                const inputs = { trust, verdict, mergeAuthority, hasPr, resumable };
                const c = trustLadder.approvalConsequence(inputs);
                assert(trustLadder.APPROVAL_CONSEQUENCES.includes(c), `a v2 value: ${c}`);
                assert(
                  c !== 'unknown' ||
                    ((trust === 1 || trust === 2) &&
                      verdict === 'approve' &&
                      mergeAuthority &&
                      hasPr &&
                      resumable),
                  `the pure decision says unknown only for trust 1/2 + approve (F5): ${JSON.stringify(inputs)}`,
                );
                const hint = worker.approvalHint({ ...inputs, greenKnown, approved });
                assert(
                  HINT_FAMILIES[c](hint),
                  `hint for ${JSON.stringify(inputs)} (${c}) words another consequence: ${hint}`,
                );
                n += 1;
              }
            }
          }
        }
      }
    }
  }
  assert(n > 1000, `the matrix is exhaustive (${n})`);
});

test('parity: each act scenario reports exactly what the shared function decides for its inputs', () => {
  const rows = [
    [{}, { trust: 0, verdict: 'approve', resumable: true }],
    [{ head: MOVED }, { trust: 0, verdict: 'approve', resumable: false }],
    [
      { readParkedResult: parkedResult('request_changes') },
      { trust: 0, verdict: 'request_changes', resumable: true },
    ],
    [
      { readParkedResult: parkedResult('escalate') },
      { trust: 0, verdict: 'escalate', resumable: true },
    ],
    [{ policy: policyOf({ trust: 2 }) }, { trust: 2, verdict: 'approve', resumable: true }],
  ];
  for (const [s, inputs] of rows) {
    const { result } = approveWith(s);
    assertEqual(
      result.effect.consequence,
      trustLadder.approvalConsequence({ mergeAuthority: true, hasPr: true, ...inputs }),
      `act ≡ shared decision for ${JSON.stringify(inputs)}`,
    );
  }
});
