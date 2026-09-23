// Stage 99 — test-runner honesty. The runner (scripts/run-tests.cjs) must be
// unable to report a pass it did not earn: a body that returns a Promise is a
// FAILURE, a declared skip() is tallied as a SKIP (never a pass), a reason-less
// skip() is a failure, and VERITY_TEST_FORBID_SKIPS=1 turns every skip into a
// failure. Each case spawns the real runner on a fixture directory
// (tests/fixtures/runner/<case>/, never discovered by the suite's non-recursive
// glob) via VERITY_TESTS_DIR, and is judged by EXIT CODE and the SUMMARY LINE —
// never by tailing output (ADR-0028).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'runner');
const SUMMARY = /^(\d+) passed, (\d+) skipped, (\d+) failed$/;

// Every env knob that could change a run's outcome is stripped, so a developer
// who has an opt-in lane switched on still gets the default-behaviour answer.
function baseEnv(extra) {
  const env = { ...process.env };
  for (const k of [
    'VERITY_TESTS_DIR',
    'VERITY_TEST_FORBID_SKIPS',
    'VERITY_REAL_CODEX_TEST',
    'VERITY_PROMOTION_BASELINE_TEST',
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

function run(dir, extra = {}) {
  const r = spawnSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: baseEnv({ VERITY_TESTS_DIR: dir, ...extra }),
  });
  const lines = r.stdout.split('\n');
  const summaries = lines.filter((l) => SUMMARY.test(l));
  let counts = null;
  if (summaries.length === 1) {
    const m = SUMMARY.exec(summaries[0]);
    counts = { passed: Number(m[1]), skipped: Number(m[2]), failed: Number(m[3]) };
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines, summaries, counts };
}

function expectSummary(r, line, what) {
  assertEqual(r.summaries.length, 1, `${what}: exactly one summary line (stdout: ${r.stdout})`);
  assertEqual(r.summaries[0], line, `${what}: summary line`);
}

// 1. Regression: before stage 99 this was exit 0, "1 passed, 0 failed".
test('runner: an async body that throws after an await FAILS loud (returned a Promise)', () => {
  const r = run(path.join(FIXTURES, 'async'));
  assertEqual(r.status, 1, `exit code (stdout: ${r.stdout} stderr: ${r.stderr})`);
  expectSummary(r, '0 passed, 0 skipped, 1 failed', 'async');
  assert(r.stdout.includes('returned a Promise'), 'the failure names the returned Promise');
  assert(!r.stdout.includes('  ✓ '), 'nothing printed as a pass');
  assert(!/unhandled/i.test(r.stderr), `no unhandled rejection on top of it (stderr: ${r.stderr})`);
});

// 2. A declared skip is tallied as a skip, and never as a pass.
test('runner: skip(reason) is tallied as skipped, never passed, and exits 0', () => {
  const r = run(path.join(FIXTURES, 'skip'));
  assertEqual(r.status, 0, `exit code (stdout: ${r.stdout})`);
  expectSummary(r, '0 passed, 1 skipped, 0 failed', 'skip');
  assert(r.lines.includes('  ⊘ x — why'), `the skip line names test and reason (${r.stdout})`);
});

// 3. A lane that must be complete refuses skips.
test('runner: VERITY_TEST_FORBID_SKIPS=1 counts every skip as a failure', () => {
  const r = run(path.join(FIXTURES, 'skip'), { VERITY_TEST_FORBID_SKIPS: '1' });
  assertEqual(r.status, 1, `exit code (stdout: ${r.stdout})`);
  expectSummary(r, '0 passed, 0 skipped, 1 failed', 'forbid-skips');
  assert(
    r.stdout.includes('skipped under VERITY_TEST_FORBID_SKIPS'),
    'the failure says the skip was forbidden',
  );
});

// 4. A skip must say why.
test('runner: skip() with no reason is a failure, not a skip', () => {
  const r = run(path.join(FIXTURES, 'skip-no-reason'));
  assertEqual(r.status, 1, `exit code (stdout: ${r.stdout})`);
  expectSummary(r, '0 passed, 0 skipped, 1 failed', 'skip-no-reason');
  assert(r.stdout.includes('requires a non-empty reason'), 'the failure says a reason is required');
});

// 5. The synchronous path is byte-identical in behaviour.
test('runner: synchronous pass + throw behave exactly as before', () => {
  const r = run(path.join(FIXTURES, 'sync'));
  assertEqual(r.status, 1, `exit code (stdout: ${r.stdout})`);
  expectSummary(r, '1 passed, 0 skipped, 1 failed', 'sync');
  assert(r.lines.includes('  ✓ sync pass'), 'the passing test prints a ✓');
  assert(
    r.lines.includes('  ✗ sync fail: deliberate sync failure'),
    'the failing test prints a ✗ with its message',
  );
});

// 6. The existing zero-file rule is unchanged.
test('runner: a directory with no *.test.cjs still refuses a vacuous pass', () => {
  const r = run(path.join(FIXTURES, 'empty'));
  assertEqual(r.status, 1, `exit code (stdout: ${r.stdout})`);
  assert(r.stderr.includes('refusing a vacuous pass'), `refusal message (stderr: ${r.stderr})`);
  assertEqual(r.summaries.length, 0, 'no summary line — nothing ran');
});

// 7. The migrated sites, run by the REAL suite files with actionlint absent and
// both opt-in gates unset. Each real file is loaded through a one-line shim in a
// temp dir (`require(<abs path>)`), so the file's own relative requires resolve
// from tests/ exactly as in the normal run. PATH keeps every entry EXCEPT the
// ones holding an `actionlint`, so this holds whether or not this box has it.
function pathWithoutActionlint() {
  const kept = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'actionlint')));
  return kept.join(path.delimiter);
}

test('runner: the migrated skip sites are tallied as skipped by the real suite files', () => {
  const PATH = pathWithoutActionlint();
  const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8', env: { PATH } });
  assert(probe.error, 'precondition: actionlint is not resolvable on the constructed PATH');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-runner-migrated-'));
  try {
    for (const f of ['actions.test.cjs', 'real-codex.test.cjs', 'promotion-verify.test.cjs']) {
      fs.writeFileSync(path.join(dir, f), `require(${JSON.stringify(path.join(__dirname, f))});\n`);
    }
    const r = run(dir, { PATH });
    assertEqual(r.status, 0, `exit code (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assertEqual(r.summaries.length, 1, `exactly one summary line (stdout: ${r.stdout})`);
    assertEqual(r.counts.failed, 0, 'nothing failed');
    assert(r.counts.passed > 0, 'the always-on cases still pass');

    const skipLines = r.lines.filter((l) => l.startsWith('  ⊘ '));
    assertEqual(r.counts.skipped, skipLines.length, 'every ⊘ line is counted under skipped');
    assert(
      skipLines.some(
        (l) =>
          l.startsWith('  ⊘ actionlint accepts the generated workflow') &&
          l.endsWith(' — actionlint not on PATH — fixture test covers the freeze'),
      ),
      'actions.test.cjs: the actionlint case is a skip, not a pass',
    );
    assert(
      !r.lines.some((l) => l.startsWith('  ✓ actionlint accepts the generated workflow')),
      'and it is never printed as a pass',
    );
    const codexSkips = skipLines.filter((l) => l.startsWith('  ⊘ real-codex: '));
    assert(codexSkips.length > 0, 'real-codex.test.cjs: the gated cases are registered skips');
    for (const l of codexSkips) {
      assert(
        l.endsWith(' — VERITY_REAL_CODEX_TEST not set — opt-in lane'),
        `real-codex skip names its gate: ${l}`,
      );
    }
    assert(
      skipLines.some(
        (l) =>
          l.startsWith('  ⊘ REAL baseline:') &&
          l.endsWith(' — VERITY_PROMOTION_BASELINE_TEST not set — opt-in lane'),
      ),
      'promotion-verify.test.cjs: the baseline lane is a registered skip',
    );
    assertEqual(
      r.counts.skipped,
      1 + codexSkips.length + 1,
      'exactly the three migrated sites are skipped',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
