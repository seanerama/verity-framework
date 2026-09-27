// T11 — usage ledger + `verity usage` (SKETCH §3.4) + the §4.1 daily-limit
// rollup. Unit tests hit the lib directly; CLI tests spawn the dispatcher.
// Git-commit tests use real throwaway `git init` repos in /tmp — no network.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autonomy = require('../verity/bin/lib/autonomy.cjs');
const usage = require('../verity/bin/lib/usage.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-usage-'));
}

function writeCsv(dir, lines) {
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'usage.csv'), `${lines.join('\n')}\n`);
}

// spawnSync (not execFileSync) so STDERR is captured on success too — the
// malformed-row test asserts warnings land on stderr while exit stays 0.
function runCli(args, dir) {
  const res = spawnSync('node', [CLI, ...args, '--cwd', dir], { encoding: 'utf8' });
  return { out: res.stdout || '', err: res.stderr || '', code: res.status };
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

function gitRepo() {
  const dir = tmpDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'bot@example.com']);
  git(dir, ['config', 'user.name', 'verity-bot']);
  return dir;
}

const SUMMARY = {
  runId: 'run-20260610T120000Z-abc123',
  repo: 'octo/fixture',
  outcome: 'gated',
  roles: ['plan', 'build', 'review'],
  tokens: { in: 412034, out: 38112 },
  est_usd: 1.87,
  wall_secs: 702,
};

// --- csv row schema (§3.4 — exact column order, header required) ---------------

test('appendUsage: creates usage.csv with the EXACT §3.4 header + row, byte-exact', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T12:34:56.000Z');
  usage.appendUsage(dir, usage.entryFromSummary(SUMMARY, now));
  const lines = fs.readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8').split('\n');
  assertEqual(
    lines[0],
    'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate,provider,model',
    'header row is exactly the §3.4 column list (stage-3/21/53 additive columns last)',
  );
  assertEqual(
    lines[1],
    '2026-06-10T12:34:56.000Z,run-20260610T120000Z-abc123,octo/fixture,plan+build+review,412034,38112,1.87,702,gated,0,,,,',
    'data row matches the column order exactly (trailing provider,model empty)',
  );
  assertEqual(lines[2], '', 'file ends with a newline');
});

test('appendUsage: append-only — second row appended, header never duplicated', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T12:00:00.000Z');
  usage.appendUsage(dir, usage.entryFromSummary(SUMMARY, now));
  usage.appendUsage(dir, usage.entryFromSummary({ ...SUMMARY, runId: 'run-2' }, now));
  const lines = fs
    .readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assertEqual(lines.length, 3, 'header + 2 rows');
  assertEqual(lines.filter((l) => l === usage.HEADER).length, 1, 'exactly one header');
  assert(lines[2].includes('run-2'), 'second row appended after the first');
});

test('entryFromSummary: null est_usd → empty cell; no roles → empty cell', () => {
  const row = usage.formatRow(
    usage.entryFromSummary(
      {
        ...SUMMARY,
        est_usd: null,
        roles: [],
        tokens: { in: 0, out: 0 },
        wall_secs: 0,
        outcome: 'success',
      },
      new Date('2026-06-10T00:00:00.000Z'),
    ),
  );
  assertEqual(
    row,
    '2026-06-10T00:00:00.000Z,run-20260610T120000Z-abc123,octo/fixture,,0,0,,0,success,0,,,,',
  );
});

test('formatRow: cells with commas/quotes are RFC-4180 escaped and read back intact', () => {
  const entry = usage.entryFromSummary(
    { ...SUMMARY, repo: 'octo/has,comma"x' },
    new Date('2026-06-10T00:00:00.000Z'),
  );
  const row = usage.formatRow(entry);
  assert(row.includes('"octo/has,comma""x"'), 'quoted + doubled quotes');
  const dir = tmpDir();
  usage.appendUsage(dir, entry);
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].repo, 'octo/has,comma"x', 'round-trips through the reader');
});

// --- reader: missing / malformed input is handled gracefully -------------------

test('readUsage: missing file is an empty ledger, not an error', () => {
  const { rows, skipped, exists } = usage.readUsage(tmpDir());
  assertEqual(rows.length, 0);
  assertEqual(skipped, 0);
  assertEqual(exists, false);
});

test('readUsage: malformed rows are SKIPPED with a warning; good rows still count', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,octo/fixture,plan,100,10,0.50,60,success',
    'this,is,not,enough,columns',
    '2026-06-10T02:00:00.000Z,run-2,octo/fixture,plan,not-a-number,10,0.50,60,success',
    'not-a-date,run-3,octo/fixture,plan,100,10,0.50,60,success',
    '2026-06-10T03:00:00.000Z,run-4,octo/fixture,plan+build,200,20,,30,failed',
  ]);
  const warnings = [];
  const { rows, skipped } = usage.readUsage(dir, { warn: (m) => warnings.push(m) });
  assertEqual(rows.length, 2, 'two good rows survive');
  assertEqual(skipped, 3, 'three malformed rows skipped');
  assertEqual(warnings.length, 3, 'one warning per skipped row');
  assert(warnings[0].includes('line 3'), 'warning names the line');
  assertEqual(rows[1].est_usd, null, 'empty est_usd cell reads as UNKNOWN, never 0 (ADR-0008)');
  assertEqual(rows[1].roles.join('|'), 'plan|build', 'roles split back from +');
});

// --- stage 3: additive CSV evolution (tool_calls, role; one row per invocation) --

test('readUsage: legacy 9-column files (old header + old rows) parse with NO warnings', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,octo/fixture,plan+build,100,10,0.50,60,success',
  ]);
  const warnings = [];
  const { rows, skipped } = usage.readUsage(dir, { warn: (m) => warnings.push(m) });
  assertEqual(warnings.length, 0, 'legacy header + rows are valid, not warned about');
  assertEqual(skipped, 0);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].tool_calls, 0, 'missing tool_calls column reads as 0');
  assertEqual(rows[0].role, '', 'missing role column reads as empty');
  assertEqual(rows[0].roles.join('|'), 'plan|build', 'legacy roles cell still splits');
});

test('readUsage: pre-stage-21 11-column rows carry tool_calls + role; bad tool_calls is malformed', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,build,100,10,0.50,60,success,17,build',
    '2026-06-10T02:00:00.000Z,run-1,o/r,review,50,5,0.25,30,gated,not-a-number,review',
  ]);
  const { rows, skipped } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(skipped, 1, 'unparsable tool_calls is skipped like any malformed number');
  assertEqual(rows[0].tool_calls, 17);
  assertEqual(rows[0].role, 'build');
});

test('record: summary.invocations → one row PER ROLE INVOCATION sharing the run_id, NO commit (stage 108)', () => {
  const dir = gitRepo();
  const summary = {
    ...SUMMARY,
    invocations: [
      {
        role: 'plan',
        outcome: 'success',
        tokens: { in: 100, out: 10 },
        est_usd: 0.5,
        wall_secs: 60,
        tool_calls: 4,
      },
      {
        role: 'build',
        outcome: 'success',
        tokens: { in: 200, out: 20 },
        est_usd: 1.0,
        wall_secs: 300,
        tool_calls: 31,
      },
      {
        role: 'review',
        outcome: 'gated',
        tokens: { in: 50, out: 5 },
        est_usd: null,
        wall_secs: 42,
        tool_calls: 7,
      },
    ],
  };
  const res = usage.record(dir, summary, {
    commit: true,
    now: new Date('2026-06-10T12:00:00.000Z'),
  });
  assertEqual(res.rows, 3, 'three rows appended');
  assertEqual(res.committed, undefined, 'record reports no commit — it never makes one');
  // Stage 108 (ADR-0036 amended): in a git repository the rows land in the
  // git-dir sidecar — never in the working tree.
  assertEqual(res.path, path.join(dir, '.git', 'verity', 'usage.csv'));
  assert(!fs.existsSync(path.join(dir, '.verity', 'usage.csv')), 'nothing written in the tree');
  const lines = fs
    .readFileSync(usage.ledgerPath(dir), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assertEqual(lines.length, 4, 'header + one row per invocation');
  assertEqual(
    lines[1],
    `2026-06-10T12:00:00.000Z,${SUMMARY.runId},octo/fixture,plan,100,10,0.5,60,success,4,plan,,,`,
  );
  assertEqual(
    lines[3],
    `2026-06-10T12:00:00.000Z,${SUMMARY.runId},octo/fixture,review,50,5,,42,gated,7,review,,,`,
    'null invocation est_usd → empty cell; invocation outcome recorded',
  );
  const { rows } = usage.readUsage(dir);
  assertEqual(new Set(rows.map((r) => r.run_id)).size, 1, 'all rows share the run_id');
  let hasCommits = true;
  try {
    git(dir, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasCommits = false;
  }
  assertEqual(hasCommits, false, 'commit:true is ignored — the repo still has zero commits');
});

test('record: no invocations → single legacy-shaped run row (zero-role runs still leave a trace)', () => {
  const dir = tmpDir();
  const res = usage.record(dir, { ...SUMMARY, invocations: [] }, { commit: false });
  assertEqual(res.rows, 1);
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].outcome, 'gated', 'run outcome recorded on the fallback row');
  assertEqual(rows[0].role, '', 'fallback row is unattributed');
});

test('rollup: mixed-format files — runs counts DISTINCT run_ids, tool_calls sums', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    // legacy per-run row (its own run_id)
    '2026-06-10T01:00:00.000Z,run-old,o/r,plan+build,300,30,1.50,60,success',
    // stage-3 per-invocation rows: ONE run split across three rows
    '2026-06-10T02:00:00.000Z,run-new,o/r,plan,100,10,0.50,60,success,4,plan',
    '2026-06-10T03:00:00.000Z,run-new,o/r,build,200,20,1.00,300,success,31,build',
    '2026-06-10T04:00:00.000Z,run-new,o/r,review,50,5,0.25,42,gated,7,review',
  ]);
  const { rows } = usage.readUsage(dir);
  const totals = usage.rollup(rows);
  assertEqual(totals.runs, 2, 'run-old + run-new — per-invocation rows do NOT inflate runs');
  assertEqual(totals.tokens_in, 650);
  assertEqual(totals.tokens_out, 65);
  assertEqual(totals.est_usd, 3.25);
  assertEqual(totals.tool_calls, 42, 'legacy rows contribute 0 tool calls');
});

test('rollupByRole: per-role math; legacy rows group under their joined roles string', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-old,o/r,plan+build,300,30,1.50,60,success',
    '2026-06-10T02:00:00.000Z,run-a,o/r,build,200,20,1.00,300,success,31,build',
    '2026-06-10T03:00:00.000Z,run-b,o/r,build,100,10,0.50,120,failed,9,build',
    '2026-06-10T04:00:00.000Z,run-b,o/r,review,50,5,0.25,42,gated,7,review',
  ]);
  const { rows } = usage.readUsage(dir);
  const byRole = usage.rollupByRole(rows);
  assertEqual(
    JSON.stringify(Object.keys(byRole)),
    '["build","plan+build","review"]',
    'roles sorted; the unsplittable legacy attribution is its own honest group',
  );
  assertEqual(byRole.build.rows, 2);
  assertEqual(byRole.build.tokens_in, 300);
  assertEqual(byRole.build.tokens_out, 30);
  assertEqual(byRole.build.est_usd, 1.5);
  assertEqual(byRole.build.tool_calls, 40);
  assertEqual(byRole.review.tool_calls, 7);
  assertEqual(byRole['plan+build'].tool_calls, 0);
});

test('summarizeUsage: --by-role windows the same rows; omitted unless requested', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T15:00:00.000Z');
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-a,o/r,build,100,10,1.00,60,success,5,build',
    '2026-06-01T01:00:00.000Z,run-z,o/r,build,900,90,9.00,60,success,50,build', // outside window
  ]);
  const plain = usage.summarizeUsage(dir, { days: 7, now });
  assertEqual(plain.by_role, undefined, 'by_role only appears with the flag');
  const summary = usage.summarizeUsage(dir, { days: 7, now, byRole: true });
  assertEqual(summary.by_role.build.tool_calls, 5, 'window filter applies to by_role too');
  assertEqual(summary.by_role.build.est_usd, 1);
});

test('checkDailyLimits: sums unchanged across formats — split rows trip exactly like one run row', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const limits = { max_usd_per_day: 3, max_runs_per_day: 24 };
  // Legacy granularity: the whole run in one row.
  const legacyDir = tmpDir();
  writeCsv(legacyDir, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan+build,300,30,3.00,60,success',
  ]);
  // Stage-3 granularity: the SAME run split into per-role rows.
  const splitDir = tmpDir();
  writeCsv(splitDir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,100,10,1.00,30,success,4,plan',
    '2026-06-10T01:05:00.000Z,run-1,o/r,build,200,20,2.00,30,success,31,build',
  ]);
  const legacy = usage.checkDailyLimits(legacyDir, limits, { now });
  const split = usage.checkDailyLimits(splitDir, limits, { now });
  assertEqual(legacy.ok, false, 'legacy: $3.00 >= max_usd_per_day 3 trips');
  assertEqual(split.ok, false, 'split rows sum to the same $3.00 and trip identically');
  assertEqual(legacy.totals.est_usd, split.totals.est_usd, 'identical day sums');
  assertEqual(legacy.totals.runs, 1);
  assertEqual(split.totals.runs, 1, 'shared run_id counts as ONE run against max_runs_per_day');
});

// --- rollups: UTC day windows ---------------------------------------------------

test('summarizeUsage: --days window is UTC calendar days including today', () => {
  const dir = tmpDir();
  const now = new Date('2026-06-10T15:00:00.000Z');
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T00:00:00.000Z,run-a,o/r,plan,100,10,1.00,60,success', // today, at UTC midnight
    '2026-06-09T23:59:59.000Z,run-b,o/r,plan,100,10,2.00,60,failed', // yesterday (UTC)
    '2026-06-04T12:00:00.000Z,run-c,o/r,plan,100,10,4.00,60,success', // 6 days ago — in a 7-day window
    '2026-06-03T12:00:00.000Z,run-d,o/r,plan,100,10,8.00,60,gated', // 7 days ago — OUT of a 7-day window
  ]);
  const today = usage.summarizeUsage(dir, { days: 1, now });
  assertEqual(today.runs, 1, 'days=1 → today (UTC) only');
  assertEqual(today.est_usd, 1, 'yesterday 23:59:59Z excluded at the UTC boundary');
  const week = usage.summarizeUsage(dir, { days: 7, now });
  assertEqual(week.runs, 3, 'days=7 → today + 6 prior UTC days');
  assertEqual(week.est_usd, 7);
  assertEqual(week.since, '2026-06-04T00:00:00.000Z', 'window starts at UTC midnight');
  assertEqual(JSON.stringify(week.outcomes), '{"success":2,"failed":1}');
});

// --- daily-limit check (§4.1, the T11 slice — T12 reuses this) -------------------

test('checkDailyLimits: under both limits → ok', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,1.00,1,success']);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24 },
    { now: new Date('2026-06-10T12:00:00.000Z') },
  );
  assertEqual(res.ok, true);
  assertEqual(res.totals.runs, 1);
});

test('checkDailyLimits: est_usd at/over max_usd_per_day → not ok, slug daily-limit', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,20.00,1,success',
    '2026-06-10T02:00:00.000Z,run-2,o/r,plan,1,1,5.00,1,success',
  ]);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24 },
    { now: new Date('2026-06-10T12:00:00.000Z') },
  );
  assertEqual(res.ok, false, '>= is a trip, not >');
  assertEqual(res.slug, 'daily-limit');
  assert(res.message.includes('max_usd_per_day 25'), 'message names the limit');
});

test('checkDailyLimits: runs at max_runs_per_day → not ok; yesterday does not count', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-09T23:00:00.000Z,run-old,o/r,plan,1,1,0.10,1,success',
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1,1,0.10,1,success',
    '2026-06-10T02:00:00.000Z,run-2,o/r,plan,1,1,0.10,1,failed',
  ]);
  const limits = { max_usd_per_day: 25, max_runs_per_day: 2 };
  const res = usage.checkDailyLimits(dir, limits, { now: new Date('2026-06-10T12:00:00.000Z') });
  assertEqual(res.ok, false);
  assert(res.message.includes('max_runs_per_day 2'), 'message names the run cap');
  assertEqual(res.totals.runs, 2, "yesterday's run is outside today (UTC)");
});

test('checkDailyLimits: missing usage.csv → ok (empty ledger)', () => {
  const res = usage.checkDailyLimits(tmpDir(), { max_usd_per_day: 25, max_runs_per_day: 24 });
  assertEqual(res.ok, true);
});

// --- stage 18 (#51, ADR-0008): unknown cost is UNKNOWN, never $0 -----------------
//
// The ledger has always written '' for an unknown cost (entryFrom* above), but
// the aggregation layer used to read that cell back as 0 — so `verity usage`
// reported a confident $0.00 over the 2026-07-31 codex canary run and
// checkDailyLimits({max_usd_per_day: 0.01}) answered ok. Rows below are shaped
// like that run's real rows (empty est_usd cell, real token counts).

const CODEX_ROW_A = '2026-06-10T01:00:00.000Z,run-cx-1,o/r,build,193745,2436,,93,success,7,build';
const CODEX_ROW_B = '2026-06-10T02:00:00.000Z,run-cx-2,o/r,build,213749,2223,,88,success,5,build';
// A claude-shaped row: a real dollar figure on every run.
const CLAUDE_ROW = '2026-06-10T03:00:00.000Z,run-cl-1,o/r,build,1000,100,3.00,60,success,9,build';
const DAY = new Date('2026-06-10T12:00:00.000Z');

test('regression (#51): an all-unknown ledger reports no verified $0 and the USD breaker cannot pass', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, CODEX_ROW_A, CODEX_ROW_B]);
  // The safety claim first: a budget computed from a total the code KNOWS is
  // incomplete must never come back as a plain ok.
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 0.01, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(res.ok, false, 'a $0.01 ceiling is not cleared by 2 runs of unverifiable cost');
  assertEqual(res.slug, 'unknown-cost-budget', 'its own slug — this is not a daily-limit trip');
  assert(res.message.includes('2 run'), 'the message names how many runs were unverifiable');
  // ...and the totals carry known spend and unknown runs as SEPARATE facts.
  const summary = usage.summarizeUsage(dir, { days: 1, now: DAY });
  assertEqual(summary.unknown_cost_runs, 2, 'both runs counted as unverifiable, not summed as $0');
  assertEqual(summary.unknown_cost_rows, 2);
  assertEqual(summary.est_usd, 0, 'est_usd is VERIFIED spend only — here, genuinely nothing');
});

test('readUsage: an empty est_usd cell is UNKNOWN (null), never 0; garbage cells stay malformed', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    CODEX_ROW_A,
    '2026-06-10T04:00:00.000Z,run-bad,o/r,build,100,10,not-a-number,60,success,1,build',
  ]);
  const { rows, skipped } = usage.readUsage(dir);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].est_usd, null, "'' is unknown cost — null, never 0 (ADR-0008)");
  assertEqual(skipped, 1, 'a non-empty unparsable cell is still a malformed row, as before');
});

test('rollup: a mixed ledger keeps known spend exact AND the unknown count visible, per role too', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, CODEX_ROW_A, CLAUDE_ROW]);
  const { rows } = usage.readUsage(dir);
  const totals = usage.rollup(rows);
  assertEqual(totals.est_usd, 3, 'the known row is summed exactly');
  assertEqual(totals.runs, 2);
  assertEqual(totals.unknown_cost_runs, 1);
  assertEqual(totals.unknown_cost_rows, 1);
  assertEqual(totals.tokens_in, 194745, 'tokens are known for BOTH providers and always sum');
  const byRole = usage.rollupByRole(rows);
  assertEqual(byRole.build.est_usd, 3, 'per-role known spend excludes the unknown row');
  assertEqual(byRole.build.unknown_cost_rows, 1, 'and reports it separately');
});

test('checkDailyLimits: known spend still trips daily-limit for real, even beside unknown rows', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, CODEX_ROW_A, CLAUDE_ROW]);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 3, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(res.ok, false);
  assertEqual(res.slug, 'daily-limit', 'genuine overspend is reported as overspend, not as doubt');
  assert(res.message.includes('$3.00'), 'and names the verified figure that tripped it');
});

test('checkDailyLimits: gate/fail refuse an unverifiable budget; allow_with_token_limit is inert BY CONSENT', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, CODEX_ROW_A, CLAUDE_ROW]);
  const limits = (behavior) => ({
    max_usd_per_day: 25,
    max_runs_per_day: 24,
    unknown_cost_behavior: behavior,
  });
  for (const behavior of ['gate', 'fail']) {
    const res = usage.checkDailyLimits(dir, limits(behavior), { now: DAY });
    assertEqual(res.ok, false, `${behavior}: the budget cannot be verified, so it must not pass`);
    assertEqual(res.slug, 'unknown-cost-budget');
    assert(res.message.includes('1 run'), `${behavior}: names how many runs were unverifiable`);
    assert(res.message.includes(`'${behavior}'`), `${behavior}: names the behavior in force`);
  }
  const consent = usage.checkDailyLimits(dir, limits('allow_with_token_limit'), { now: DAY });
  assertEqual(consent.ok, true, 'the operator accepted token ceilings as the bound');
  assert(
    consent.note.includes('allow_with_token_limit'),
    'and the result SAYS the USD breaker is inert by consent, not that the total is verified',
  );
  assertEqual(consent.totals.unknown_cost_runs, 1, 'the count is still on the totals');
  const dflt = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24 },
    { now: DAY },
  );
  assertEqual(dflt.ok, false, "an absent knob defaults to 'gate' (ADR-0008)");
  assertEqual(dflt.slug, 'unknown-cost-budget');
});

test('checkDailyLimits: no max_usd_per_day configured → unknown cost changes nothing', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, CODEX_ROW_A, CODEX_ROW_B]);
  const res = usage.checkDailyLimits(dir, { max_runs_per_day: 24 }, { now: DAY });
  assertEqual(res.ok, true, 'there is no USD breaker to fool when no ceiling is set');
  assertEqual(res.note, undefined, 'and nothing to disclaim');
});

test('stage 18: a claude-only ledger is byte-identical — totals, both messages, and the run cap', () => {
  // Claude reports a real dollar figure on every run, so no unknown-cost row
  // can exist on that path. Every string below is the pre-stage-18 output.
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan,1000,100,1.25,60,success,4,plan',
    '2026-06-10T02:00:00.000Z,run-1,o/r,build,2000,200,2.50,300,success,31,build',
    '2026-06-10T03:00:00.000Z,run-2,o/r,review,500,50,0.25,42,gated,7,review',
  ]);
  const summary = usage.summarizeUsage(dir, { days: 1, now: DAY, byRole: true });
  assertEqual(summary.est_usd, 4, 'known spend unchanged');
  assertEqual(summary.runs, 2);
  assertEqual(summary.unknown_cost_runs, 0, 'nothing is unverifiable on the claude path');
  assertEqual(summary.unknown_cost_rows, 0);
  assertEqual(summary.by_role.build.unknown_cost_rows, 0);
  assertEqual(summary.by_role.build.est_usd, 2.5);
  const under = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(under.ok, true, 'under both limits, gate or not');
  assertEqual(under.slug, undefined, 'no slug on the ok path');
  assertEqual(under.note, undefined, 'no consent note where there is nothing unknown');
  const usd = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 4, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(usd.slug, 'daily-limit');
  assertEqual(
    usd.message,
    'daily budget reached: est $4.00 spent today (UTC) >= max_usd_per_day 4',
    'the USD message is byte-identical to pre-stage-18',
  );
  const runs = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 2 },
    {
      now: DAY,
    },
  );
  assertEqual(runs.slug, 'daily-limit');
  assertEqual(
    runs.message,
    'daily run cap reached: 2 runs today (UTC) >= max_runs_per_day 2',
    'the run-cap message is byte-identical to pre-stage-18',
  );
});

test('backward compat: pre-stage-18 legacy rows parse unchanged and count nothing as unknown', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-old,o/r,plan+build,300,30,1.50,60,success',
  ]);
  const warnings = [];
  const summary = usage.summarizeUsage(dir, { days: 1, now: DAY, warn: (m) => warnings.push(m) });
  assertEqual(warnings.length, 0, 'legacy files are still valid, not warned about');
  assertEqual(summary.est_usd, 1.5);
  assertEqual(summary.unknown_cost_runs, 0, 'a legacy row with a real cost is not "unknown"');
});

// Run fn with NO git identity resolvable: an empty HOME plus /dev/null global
// and system config, and the GIT_*_NAME/EMAIL env overrides cleared — so the
// ambient dev identity (this machine's global git config) cannot leak in and
// the bare runner's state is reproduced faithfully.
function withNoGitIdentity(fn) {
  const keys = [
    'HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = tmpDir(); // empty home → no ~/.gitconfig
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  for (const k of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// A git repo with NO user.name/user.email configured (unlike gitRepo above).
function bareGitRepo() {
  const dir = tmpDir();
  git(dir, ['init', '-q']);
  return dir;
}

// --- stage 108 (ADR-0036 amended): the ledger is runtime state in the git dir ------
//
// Before 108 `record` committed the ledger (`chore(verity): usage <run-id>`) on
// whatever branch HEAD was on — the stage branch the run built on — and the
// next tick's fresh stage branch, forked from the squash-merged default
// branch, did not contain that commit: the working-tree ledger lost the rows
// (fixture A, 2026-09-25: 9 of 14). Since 108 the ledger is
// `<git-dir>/verity/usage.csv`, which no checkout can reach. Real throwaway
// repos, no network.

const ROW_1 = '2026-06-10T01:00:00.000Z,run-1,o/r,plan,100,10,0.5,60,success,4,plan,,,';
const ROW_2 = '2026-06-10T02:00:00.000Z,run-2,o/r,build,200,20,1,300,success,31,build,,,';
const ROW_3 = '2026-06-10T03:00:00.000Z,run-3,o/r,review,50,5,,42,gated,7,review,,,';

const treeLedger = (dir) => path.join(dir, '.verity', 'usage.csv');
const sidecar = (dir) => path.join(dir, '.git', 'verity', 'usage.csv');

// A repo on `main` whose baseline commit TRACKS a one-row ledger — the shape
// of every pre-108 repo after its first worker run.
function repoWithTrackedLedger() {
  const dir = gitRepo();
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeCsv(dir, [usage.HEADER, ROW_1]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline with a tracked ledger']);
  return dir;
}

// ... plus a bare `origin` that ALSO tracks the ledger, with
// refs/remotes/origin/HEAD SET — the shape stage branches really fork from
// (git-lifecycle resolveBase prefers origin/HEAD). PR #282 F5.
function repoWithOriginTrackingLedger() {
  const dir = repoWithTrackedLedger();
  const origin = path.join(tmpDir(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'pipe' });
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['remote', 'set-head', 'origin', 'main']);
  assertEqual(
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim(),
    'refs/remotes/origin/main',
    'precondition: origin/HEAD is set',
  );
  return dir;
}

function usageCommits(dir) {
  return git(dir, ['log', '--all', '--format=%s', '--grep=chore(verity): usage'])
    .split('\n')
    .filter((l) => l !== '');
}

function commitCount(dir) {
  return git(dir, ['rev-list', '--all', '--count']).trim();
}

function refs(dir) {
  return git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

// Commit `text` as the in-tree ledger on a new branch off main, then return to
// main (which may or may not track the file).
function usageCommitOnBranch(dir, branch, text, subject) {
  git(dir, ['checkout', '-q', '-b', branch, 'main']);
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(treeLedger(dir), text);
  git(dir, ['add', '--', '.verity/usage.csv']);
  git(dir, ['commit', '-q', '-m', subject]);
  git(dir, ['checkout', '-q', 'main']);
}

test('regression (stage 108, F5): a recorded row survives `checkout -b feat/b origin/main` with origin/HEAD set', () => {
  const dir = repoWithOriginTrackingLedger();
  git(dir, ['checkout', '-q', '-b', 'feat/a']);
  // Exactly the call the pre-108 worker made under the default policy.
  usage.record(dir, SUMMARY, { commit: true });
  git(dir, ['checkout', '-q', '-b', 'feat/b', 'origin/main']);
  const { rows } = usage.readUsage(dir);
  assert(
    rows.some((r) => r.run_id === SUMMARY.runId),
    'the row recorded on feat/a is still in the ledger on feat/b',
  );
  assertEqual(usageCommits(dir).length, 0, 'no chore(verity): usage commit was made');
  assertEqual(
    fs.readFileSync(treeLedger(dir), 'utf8'),
    `${usage.HEADER}\n${ROW_1}\n`,
    'the tracked in-tree file is untouched history',
  );
});

test('clobber immunity (stage 108): checkouts to and from branches that TRACK the ledger never change the rows', () => {
  const dir = repoWithTrackedLedger();
  usageCommitOnBranch(
    dir,
    'feat/t',
    `${usage.HEADER}\n${ROW_2}\n`,
    'a branch with its own tracked copy',
  );
  usage.record(dir, SUMMARY, { now: new Date('2026-06-10T12:00:00.000Z') });
  const before = fs.readFileSync(usage.ledgerPath(dir), 'utf8');
  for (const target of ['feat/t', 'main', 'feat/t', 'main']) {
    git(dir, ['checkout', '-q', target]);
    assertEqual(
      fs.readFileSync(usage.ledgerPath(dir), 'utf8'),
      before,
      `ledger byte-identical after checkout ${target}`,
    );
  }
  assertEqual(usage.readUsage(dir).rows.length, 1, 'the one recorded row, on every branch');
  assertEqual(git(dir, ['status', '--porcelain']).trim(), '', 'nothing written in the tree');
});

test('crash immunity (stage 108): rows written before a checkout switch stay visible to the daily breaker with no restore step', () => {
  const dir = repoWithOriginTrackingLedger();
  const now = new Date('2026-06-10T12:00:00.000Z');
  usage.record(dir, { ...SUMMARY, runId: 'run-a' }, { now });
  git(dir, ['checkout', '-q', '-b', 'feat/stage-1', 'origin/main']);
  usage.record(dir, { ...SUMMARY, runId: 'run-b' }, { now });
  // The "run" dies here: no summarize, no restore — the tree is left on a
  // branch that tracks the ledger. The next run's breaker must see both runs.
  const check = usage.checkDailyLimits(dir, { max_runs_per_day: 2 }, { now });
  assertEqual(check.ok, false, 'the breaker trips on the rows the crash left');
  assertEqual(check.totals.runs, 2);
});

test('ledgerPath (stage 108): git dir sidecar inside a repo (also from a subdirectory); tree path outside git', () => {
  const plain = tmpDir();
  assertEqual(
    usage.ledgerPath(plain),
    path.join(plain, '.verity', 'usage.csv'),
    'non-git fallback',
  );
  assertEqual(usage.usagePath(plain), usage.ledgerPath(plain), 'usagePath is the same resolver');
  const dir = repoWithTrackedLedger();
  assertEqual(usage.ledgerPath(dir), sidecar(dir));
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  const fromSub = usage.ledgerPath(path.join(dir, 'sub', 'deeper'));
  assertEqual(path.basename(fromSub), 'usage.csv');
  assertEqual(
    fs.realpathSync(path.dirname(path.dirname(fromSub))),
    fs.realpathSync(path.join(dir, '.git')),
    'a subdirectory resolves the same sidecar',
  );
  assert(!fs.existsSync(path.dirname(sidecar(dir))), 'resolution creates nothing');
  // A directory that becomes a repository later is not pinned to the fallback.
  const later = tmpDir();
  assertEqual(usage.ledgerPath(later), path.join(later, '.verity', 'usage.csv'));
  git(later, ['init', '-q']);
  assertEqual(usage.ledgerPath(later), sidecar(later), 'the fallback is never cached');
});

test('ledgerPath (stage 108): a `git worktree add` checkout gets its OWN sidecar', () => {
  const dir = repoWithTrackedLedger();
  const wt = path.join(tmpDir(), 'wt');
  git(dir, ['worktree', 'add', '-q', '-b', 'feat/wt', wt]);
  const wtPath = usage.ledgerPath(wt);
  assert(wtPath !== usage.ledgerPath(dir), 'distinct files');
  assert(
    wtPath.includes(`${path.sep}worktrees${path.sep}`),
    `inside the worktree's git dir: ${wtPath}`,
  );
  usage.record(wt, { ...SUMMARY, runId: 'run-wt' });
  usage.record(dir, { ...SUMMARY, runId: 'run-main' });
  assertEqual(
    usage
      .readUsage(wt)
      .rows.map((r) => r.run_id)
      .join(','),
    'run-wt',
  );
  assertEqual(
    usage
      .readUsage(dir)
      .rows.map((r) => r.run_id)
      .join(','),
    'run-main',
  );
  assertEqual(git(wt, ['status', '--porcelain']).trim(), '', 'the worktree tree stays clean');
});

test('cli (stage 108): `usage --json` reports the resolved ledger path', () => {
  const dir = repoWithTrackedLedger();
  usage.record(dir, SUMMARY);
  const { out, code } = runCli(['usage', '--json'], dir);
  assertEqual(code, 0);
  assertEqual(
    fs.realpathSync(JSON.parse(out).path),
    fs.realpathSync(sidecar(dir)),
    '`path` names the git-dir sidecar',
  );
  const plain = tmpDir();
  assertEqual(
    JSON.parse(runCli(['usage', '--json'], plain).out).path,
    path.join(plain, '.verity', 'usage.csv'),
    'outside git: the tree path, as before',
  );
});

test('record (stage 108): commit_usage true performs NO commit; loadPolicy warns exactly once', () => {
  const dir = repoWithTrackedLedger();
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: true\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'an old policy that still says commit_usage: true']);
  const refsBefore = refs(dir);
  const countBefore = commitCount(dir);
  const warnings = [];
  const policy = autonomy.loadPolicy(dir, { warn: (m) => warnings.push(m) });
  assertEqual(warnings.length, 1, 'exactly one warning');
  assertEqual(warnings[0], autonomy.COMMIT_USAGE_IGNORED_WARNING);
  assert(warnings[0].includes('ADR-0036'), 'the warning names the ADR');
  assertEqual(policy.commit_usage, true, 'still a valid key — the policy loads, never errors');
  assertEqual(
    JSON.stringify(autonomy.loadPolicy(dir)),
    JSON.stringify(policy),
    'the warn seam never changes the loaded policy',
  );
  usage.record(dir, SUMMARY, { commit: policy.commit_usage });
  assertEqual(refs(dir), refsBefore, 'no ref moved');
  assertEqual(commitCount(dir), countBefore, 'git log unchanged on every ref');
  assertEqual(git(dir, ['status', '--porcelain']).trim(), '', 'nothing written in the tree');
  // No key, or an explicit false: no warning at all.
  for (const text of ['mode: supervised\n', 'commit_usage: false\n']) {
    fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), text);
    const none = [];
    autonomy.loadPolicy(dir, { warn: (m) => none.push(m) });
    assertEqual(none.length, 0, `no warning for: ${text.trim()}`);
  }
});

test('cli (stage 108): autonomy validate on commit_usage: true exits 0 with ONE stderr warning', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: true\n');
  const { out, err, code } = runCli(['autonomy', 'validate', '--json'], dir);
  assertEqual(code, 0, 'a dead key is never an error');
  const obj = JSON.parse(out.trim());
  assertEqual(obj.valid, true);
  assertEqual(
    JSON.stringify(obj.warnings),
    JSON.stringify([autonomy.COMMIT_USAGE_IGNORED_WARNING]),
  );
  const warnLines = err.split('\n').filter((l) => l.includes('commit_usage is ignored'));
  assertEqual(warnLines.length, 1, 'one warning line on stderr');
  // A policy without the key validates byte-identically to before (no warnings key).
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'mode: supervised\n');
  const plain = JSON.parse(runCli(['autonomy', 'validate', '--json'], dir).out.trim());
  assertEqual(Object.keys(plain).join(','), 'valid,path,exists,raw', 'unchanged result shape');
});

// --- stage 108: `verity usage untrack` (operator-only) --------------------------------

test('untrack: a tracked ledger → ONE bot commit touching exactly .gitignore + the removal', () => {
  const dir = repoWithTrackedLedger();
  // Something the operator has staged must NOT be swept into the commit.
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'operator work\n');
  git(dir, ['add', 'staged.txt']);
  const before = fs.readFileSync(treeLedger(dir), 'utf8');
  const headBefore = git(dir, ['rev-parse', 'HEAD']).trim();
  const res = usage.untrackLedger(dir);
  assertEqual(res.error, null);
  assertEqual(res.ok, true);
  assertEqual(res.changed, true);
  assertEqual(res.tracked, true);
  assertEqual(res.ignore_added, true);
  assertEqual(res.gitignore_refreshed, true, 'no local .gitignore → refreshed from the new HEAD');
  assertEqual(git(dir, ['log', '-1', '--format=%s']).trim(), usage.MIGRATION_MESSAGE);
  assertEqual(git(dir, ['rev-parse', 'HEAD^']).trim(), headBefore, 'one parent: the old HEAD');
  assertEqual(
    git(dir, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).trim(),
    `${usage.COMMIT_AUTHOR_NAME} <${usage.COMMIT_AUTHOR_EMAIL}>|${usage.COMMIT_AUTHOR_NAME} <${usage.COMMIT_AUTHOR_EMAIL}>`,
    'authored and committed by the bot identity',
  );
  const touched = git(dir, ['show', '--name-status', '--format=', 'HEAD'])
    .trim()
    .split('\n')
    .sort();
  assertEqual(touched.join('|'), 'A\t.gitignore|D\t.verity/usage.csv', 'exactly the two paths');
  assertEqual(res.commit, git(dir, ['rev-parse', 'HEAD']).trim());
  assertEqual(
    git(dir, ['symbolic-ref', 'HEAD']).trim(),
    'refs/heads/main',
    'the branch moved, HEAD still attached',
  );
  assertEqual(
    fs.readFileSync(treeLedger(dir), 'utf8'),
    before,
    'the working-tree ledger is kept byte-for-byte (index-only removal)',
  );
  assertEqual(git(dir, ['ls-files', '--', '.verity/usage.csv']).trim(), '', 'no longer tracked');
  git(dir, ['check-ignore', '-q', '.verity/usage.csv']); // throws unless ignored
  assertEqual(
    git(dir, ['status', '--porcelain']).trim(),
    'A  staged.txt',
    'the operator’s staged work is still staged, and nothing else is dirty',
  );
  const ignoreLines = fs
    .readFileSync(path.join(dir, '.gitignore'), 'utf8')
    .split('\n')
    .filter((l) => l === '.verity/usage.csv');
  assertEqual(ignoreLines.length, 1, 'the ignore line, once');
  assertEqual(usage.isLedgerTracked(dir), false);
  assert(
    !fs.existsSync(path.join(dir, '.git', 'info', 'exclude')) ||
      !fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').includes('usage.csv'),
    'no .git/info/exclude line (dropped with the sidecar)',
  );
});

test('untrack F3: unrelated .gitignore edits — unstaged or staged — are NEVER swept into the commit', () => {
  for (const staged of [false, true]) {
    const dir = gitRepo();
    git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeCsv(dir, [usage.HEADER, ROW_1]);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'baseline']);
    fs.appendFileSync(path.join(dir, '.gitignore'), 'operator-local-secret/\n');
    if (staged) {
      git(dir, ['add', '.gitignore']);
    }
    const res = usage.untrackLedger(dir);
    assertEqual(res.changed, true, `committed (${res.error})`);
    const committed = git(dir, ['show', 'HEAD:.gitignore']);
    assertEqual(
      committed,
      `node_modules/\n${usage.LEDGER_IGNORE_COMMENT}\n.verity/usage.csv\n`,
      `HEAD's .gitignore + the ignore line, nothing else (staged=${staged})`,
    );
    assertEqual(res.gitignore_refreshed, false, 'a locally modified .gitignore is left alone');
    assert(res.reason.includes('left as it is'), `says so: ${res.reason}`);
    assert(
      fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('operator-local-secret/'),
      'the operator’s edit is still in the working file',
    );
    if (staged) {
      assert(
        git(dir, ['show', ':.gitignore']).includes('operator-local-secret/'),
        'a staged edit stays staged, not committed',
      );
    }
    assertEqual(git(dir, ['ls-files', '--', '.verity/usage.csv']).trim(), '', 'untracked');
  }
});

test('untrack F4: failing hooks cannot block it (plumbing — no hook runs)', () => {
  const dir = repoWithTrackedLedger();
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
    const file = path.join(hooks, hook);
    fs.writeFileSync(file, `#!/bin/sh\necho ${hook} ran >> "${dir}/hooks.log"\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  const res = usage.untrackLedger(dir);
  assertEqual(res.error, null, 'no hook failure surfaces');
  assertEqual(res.changed, true);
  assertEqual(git(dir, ['log', '-1', '--format=%s']).trim(), usage.MIGRATION_MESSAGE);
  assert(!fs.existsSync(path.join(dir, 'hooks.log')), 'no hook ran');
});

test('untrack F2: refuses (ok:false, named) while a merge / cherry-pick / revert / rebase is in progress', () => {
  for (const [marker, isDir] of [
    ['MERGE_HEAD', false],
    ['CHERRY_PICK_HEAD', false],
    ['REVERT_HEAD', false],
    ['rebase-merge', true],
    ['rebase-apply', true],
  ]) {
    const dir = repoWithTrackedLedger();
    const at = path.join(dir, '.git', marker);
    if (isDir) {
      fs.mkdirSync(at);
    } else {
      fs.writeFileSync(at, `${git(dir, ['rev-parse', 'HEAD']).trim()}\n`);
    }
    const count = commitCount(dir);
    const res = usage.untrackLedger(dir);
    assertEqual(res.ok, false, `${marker}: refused`);
    assertEqual(res.refused, marker, 'the marker is named');
    assertEqual(res.changed, false);
    assert(res.reason.includes(marker), `reason names it: ${res.reason}`);
    assertEqual(commitCount(dir), count, `${marker}: no commit`);
    assertEqual(usage.isLedgerTracked(dir), true, `${marker}: still tracked, nothing written`);
    if (marker === 'MERGE_HEAD') {
      const cli = runCli(['usage', 'untrack', '--json'], dir);
      assertEqual(cli.code, 1, 'the CLI exits non-zero on a refusal');
      assertEqual(JSON.parse(cli.out).refused, 'MERGE_HEAD', 'and prints the refusal object');
    }
  }
});

test('untrack: second call is a no-op (changed:false, no commit); a repo with no ledger is a no-op', () => {
  const dir = repoWithTrackedLedger();
  usage.untrackLedger(dir);
  const count = commitCount(dir);
  const again = usage.untrackLedger(dir);
  assertEqual(again.changed, false, 'idempotent');
  assertEqual(again.commit, null);
  assert(again.reason.includes('not tracked'), `says so: ${again.reason}`);
  assertEqual(commitCount(dir), count, 'no second commit');

  const empty = gitRepo();
  fs.writeFileSync(path.join(empty, 'README.md'), 'x\n');
  git(empty, ['add', '-A']);
  git(empty, ['commit', '-q', '-m', 'no ledger here']);
  const res = usage.untrackLedger(empty);
  assertEqual(res.changed, false, 'no ledger → nothing to untrack');
  assertEqual(commitCount(empty), '1', 'no commit');
  assert(!fs.existsSync(treeLedger(empty)), 'no ledger conjured');

  const notRepo = usage.untrackLedger(tmpDir());
  assertEqual(notRepo.changed, false, 'outside a repository: a no-op, never a throw');
  assertEqual(notRepo.error, null);
});

test('untrack F6: a ledger staged but never committed → unstaged, changed:true even when no commit is needed', () => {
  const dir = gitRepo();
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(dir, '.gitignore'), `${usage.LEDGER_IGNORE_LINE}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline already ignoring the ledger']);
  writeCsv(dir, [usage.HEADER, ROW_1]);
  git(dir, ['add', '-f', '--', '.verity/usage.csv']);
  const count = commitCount(dir);
  const res = usage.untrackLedger(dir);
  assertEqual(res.changed, true, 'the index was written');
  assertEqual(res.commit, null, 'the tree equals HEAD — no commit');
  assertEqual(commitCount(dir), count);
  assertEqual(git(dir, ['ls-files', '--', '.verity/usage.csv']).trim(), '', 'unstaged');
  assert(fs.existsSync(treeLedger(dir)), 'the working file is kept');
});

test('stage 108: the untrack commit succeeds with NO ambient git identity (stage-38 carry-over)', () => {
  const dir = bareGitRepo();
  writeCsv(dir, [usage.HEADER, ROW_1]);
  withNoGitIdentity(() => {
    git(dir, ['add', '-A']);
    git(dir, [...usage.botIdentityGitArgs(), 'commit', '-q', '-m', 'baseline']);
  });
  const res = withNoGitIdentity(() => usage.untrackLedger(dir));
  assertEqual(res.changed, true, `untrack commits even with no git identity (${res.error})`);
  const who = withNoGitIdentity(() =>
    git(dir, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).trim(),
  );
  assertEqual(
    who,
    'verity-worker <verity-worker@users.noreply.github.com>|verity-worker <verity-worker@users.noreply.github.com>',
    'a single -c pair covers author AND committer',
  );
});

test('cli: usage untrack --json → exactly one JSON object; a second call reports changed:false', () => {
  const dir = repoWithTrackedLedger();
  const first = runCli(['usage', 'untrack', '--json'], dir);
  assertEqual(first.code, 0, first.err);
  assertEqual(first.out.trim().split('\n').length, 1, 'stdout is exactly one line');
  assertEqual(JSON.parse(first.out).changed, true);
  const second = runCli(['usage', 'untrack', '--json'], dir);
  assertEqual(JSON.parse(second.out).changed, false);
  const bad = runCli(['usage', 'bogus'], dir);
  assertEqual(bad.code, 1, 'an unknown usage verb is an error');
  assert(bad.err.includes('untrack|recover'), 'the error names the verbs');
});

// --- stage 108: `verity usage recover` ----------------------------------------------

test('recover: sidecar + tree file + two orphaned usage commits → the sorted union in the SIDECAR; tree byte-identical; idempotent; malformed blob skipped', () => {
  const dir = gitRepo();
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  usageCommitOnBranch(dir, 'feat/1', `${usage.HEADER}\n${ROW_1}\n`, 'chore(verity): usage run-1');
  usageCommitOnBranch(dir, 'feat/2', `${usage.HEADER}\n${ROW_2}\n`, 'chore(verity): usage run-2');
  usageCommitOnBranch(dir, 'feat/3', 'not,a,ledger\n', 'chore(verity): usage run-bad');
  // The untrack commit carries no ledger and is excluded, never "skipped".
  git(dir, ['commit', '-q', '--allow-empty', '-m', usage.MIGRATION_MESSAGE]);
  // The legacy in-tree file holds ROW_1 (as a pre-108 checkout would) …
  writeCsv(dir, [usage.HEADER, ROW_1]);
  const treeBefore = fs.readFileSync(treeLedger(dir));
  // … and the sidecar already has a post-108 row.
  fs.mkdirSync(path.dirname(sidecar(dir)), { recursive: true });
  fs.writeFileSync(sidecar(dir), `${usage.HEADER}\n${ROW_3}\n`);
  const res = usage.recoverLedger(dir);
  assertEqual(res.path, usage.ledgerPath(dir), 'reports the sidecar path');
  assertEqual(res.commits_scanned, 3, 'three usage commits across all refs');
  assertEqual(res.commits_skipped, 1, 'the malformed blob is skipped and counted');
  assertEqual(res.tree_rows, 1, 'the in-tree file is counted');
  assertEqual(res.rows_before, 1, 'the sidecar row');
  assertEqual(res.rows_added, 2);
  assertEqual(res.rows_after, 3);
  const text = fs.readFileSync(sidecar(dir), 'utf8');
  assertEqual(
    text,
    `${usage.HEADER}\n${ROW_1}\n${ROW_2}\n${ROW_3}\n`,
    'header first, sorted by ts',
  );
  assert(fs.readFileSync(treeLedger(dir)).equals(treeBefore), 'the tree file is byte-identical');
  const again = usage.recoverLedger(dir);
  assertEqual(again.rows_added, 0, 'a second run adds nothing');
  assertEqual(again.rows_after, 3);
  assertEqual(fs.readFileSync(sidecar(dir), 'utf8'), text, 'untouched');
  assert(fs.readFileSync(treeLedger(dir)).equals(treeBefore), 'still byte-identical');
});

test('recover: outside a git repository it throws, never writes', () => {
  const dir = tmpDir();
  let threw = false;
  try {
    usage.recoverLedger(dir);
  } catch (e) {
    threw = true;
    assert(e.message.includes('not inside a git repository'), e.message);
  }
  assertEqual(threw, true);
});

test('seedLedger (stage 108): first call seeds the sidecar from tree + history; second call seeds nothing; non-git is a no-op', () => {
  const dir = repoWithTrackedLedger();
  usageCommitOnBranch(
    dir,
    'feat/old',
    `${usage.HEADER}\n${ROW_1}\n${ROW_2}\n`,
    'chore(verity): usage run-2',
  );
  const refsBefore = refs(dir);
  const first = usage.seedLedger(dir);
  assertEqual(first.seeded, 2, 'ROW_1 (tree) + ROW_2 (history)');
  assertEqual(first.tracked, true, 'reports the still-tracked tree file');
  assertEqual(usage.readUsage(dir).rows.length, 2);
  const second = usage.seedLedger(dir);
  assertEqual(second.seeded, 0, 'the sidecar exists — nothing seeded');
  assertEqual(refs(dir), refsBefore, 'git reads only — no ref moved');
  assertEqual(git(dir, ['status', '--porcelain']).trim(), '', 'nothing written in the tree');
  const plain = tmpDir();
  const res = usage.seedLedger(plain);
  assertEqual(res.git, false);
  assertEqual(res.seeded, 0);
  assert(!fs.existsSync(path.join(plain, '.verity')), 'nothing written');
});

test('cli: usage recover --json → exactly one JSON object with the counts', () => {
  const dir = repoWithTrackedLedger();
  git(dir, ['checkout', '-q', '-b', 'feat/x']);
  fs.appendFileSync(treeLedger(dir), `${ROW_2}\n`);
  git(dir, ['commit', '-q', '-am', 'chore(verity): usage run-2']);
  git(dir, ['checkout', '-q', '-b', 'feat/y', 'main']);
  const { out, code, err } = runCli(['usage', 'recover', '--json'], dir);
  assertEqual(code, 0, err);
  assertEqual(out.trim().split('\n').length, 1, 'stdout is exactly one line');
  const obj = JSON.parse(out);
  assertEqual(fs.realpathSync(obj.path), fs.realpathSync(sidecar(dir)));
  assertEqual(obj.commits_scanned, 1);
  assertEqual(obj.tree_rows, 1);
  assertEqual(obj.rows_before, 0);
  assertEqual(obj.rows_added, 2);
  assertEqual(obj.rows_after, 2);
});

test('ensureIgnoreLine: idempotent, creates the file, and recognizes an anchored spelling', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.gitignore');
  assertEqual(usage.ensureIgnoreLine(file), true, 'created');
  assertEqual(usage.ensureIgnoreLine(file), false, 'second call writes nothing');
  const text = fs.readFileSync(file, 'utf8');
  assertEqual(text.split('\n').filter((l) => l === '.verity/usage.csv').length, 1);
  assert(text.includes('ADR-0036'), 'the comment cites the ADR');
  fs.writeFileSync(file, 'node_modules/\n/.verity/usage.csv'); // no trailing newline
  assertEqual(usage.ensureIgnoreLine(file), false, 'an anchored line already counts');
  fs.writeFileSync(file, 'node_modules/');
  usage.ensureIgnoreLine(file);
  assert(
    fs.readFileSync(file, 'utf8').startsWith('node_modules/\n#'),
    'appended on its own line even without a trailing newline',
  );
});

// --- policy: commit_usage key (T11; ignored since stage 108) -----------------------

test('policy: commit_usage defaults to false (stage 108) and still validates as a boolean', () => {
  assertEqual(autonomy.DEFAULTS.commit_usage, false, 'default false — the key is ignored');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.verity'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: true\n');
  assertEqual(autonomy.loadPolicy(dir).commit_usage, true, 'file value merges over default');
  fs.writeFileSync(path.join(dir, '.verity', 'autonomy.yml'), 'commit_usage: sometimes\n');
  let threw = false;
  try {
    autonomy.loadPolicy(dir);
  } catch (e) {
    threw = true;
    assertEqual(e.exitCode, 20, 'schema violation is a PolicyError');
  }
  assertEqual(threw, true, 'non-boolean rejected');
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  assertEqual(schema.properties.commit_usage.type, 'boolean', 'shipped JSON schema has the key');
  assertEqual(schema.properties.commit_usage.default, false);
  assert(schema.properties.commit_usage.description.includes('ADR-0036'), 'documented as ignored');
});

// --- CLI: `verity usage [--days 7] [--json]` --------------------------------------

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

test('cli: usage --days 7 --json → exactly one JSON object whose totals match the fixture', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    `${isoDaysAgo(0)},run-1,o/r,plan+build,1000,100,1.25,60,success`,
    `${isoDaysAgo(0)},run-2,o/r,review,2000,200,0.75,30,gated`,
    `${isoDaysAgo(6)},run-3,o/r,plan,4000,400,2.00,90,failed`,
    `${isoDaysAgo(10)},run-old,o/r,plan,8000,800,9.99,10,success`, // outside the window
  ]);
  const { out, code } = runCli(['usage', '--days', '7', '--json'], dir);
  assertEqual(code, 0);
  const lines = out.trim().split('\n');
  assertEqual(lines.length, 1, 'stdout is exactly one line');
  const obj = JSON.parse(lines[0]);
  assertEqual(obj.days, 7);
  assertEqual(obj.timezone, 'UTC');
  assertEqual(obj.runs, 3, 'the 10-day-old row is excluded');
  assertEqual(obj.tokens_in, 7000);
  assertEqual(obj.tokens_out, 700);
  assertEqual(obj.est_usd, 4);
  assertEqual(JSON.stringify(obj.outcomes), '{"success":1,"gated":1,"failed":1}');
  assertEqual(obj.skipped_rows, 0);
});

test('cli: usage defaults to --days 7; human mode carries a raw one-liner', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, `${isoDaysAgo(0)},run-1,o/r,plan,1000,100,1.25,60,success`]);
  const { out, code } = runCli(['usage'], dir);
  assertEqual(code, 0);
  const obj = JSON.parse(out);
  assertEqual(obj.days, 7);
  assertEqual(obj.runs, 1);
  assertEqual(obj.raw, 'runs=1 tokens_in=1000 tokens_out=100 est_usd=1.25 days=7');
});

test('cli: unknown-cost rows never print a confident $0.00 (#51)', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    `${isoDaysAgo(0)},run-cx-1,o/r,build,193745,2436,,93,success,7,build`,
    `${isoDaysAgo(0)},run-cx-2,o/r,build,213749,2223,,88,success,5,build`,
  ]);
  const { out, code } = runCli(['usage', '--days', '1'], dir);
  assertEqual(code, 0);
  const obj = JSON.parse(out);
  assertEqual(
    obj.raw,
    'runs=2 tokens_in=407494 tokens_out=4659 est_usd=0.00+unknown unknown_cost_runs=2 days=1',
    'the human one-liner says the total is incomplete instead of claiming $0.00',
  );
  assertEqual(obj.unknown_cost_runs, 2, '--json carries the same fact');
  assertEqual(obj.unknown_cost_rows, 2);
});

test('cli: usage with no usage.csv → zero totals, exit 0', () => {
  const { out, code } = runCli(['usage', '--json'], tmpDir());
  assertEqual(code, 0);
  const obj = JSON.parse(out);
  assertEqual(obj.runs, 0);
  assertEqual(obj.est_usd, 0);
  assertEqual(JSON.stringify(obj.outcomes), '{}');
});

test('cli: malformed rows → warning on STDERR, --json stdout stays one clean object', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    'garbage line',
    `${isoDaysAgo(0)},run-1,o/r,plan,1000,100,1.25,60,success`,
  ]);
  const { out, err, code } = runCli(['usage', '--json'], dir);
  assertEqual(code, 0, 'a corrupt line never bricks the command');
  const obj = JSON.parse(out.trim());
  assertEqual(obj.runs, 1);
  assertEqual(obj.skipped_rows, 1);
  assert(err.includes('verity usage: warn:'), 'warning went to stderr');
});

test('cli: usage --by-role --json → per-role totals over the window, mixed formats', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.LEGACY_HEADER,
    `${isoDaysAgo(0)},run-old,o/r,plan+build,1000,100,1.25,60,success`, // legacy row
    `${isoDaysAgo(0)},run-1,o/r,build,2000,200,0.75,30,success,12,build`,
    `${isoDaysAgo(0)},run-1,o/r,review,500,50,0.25,15,gated,3,review`,
    `${isoDaysAgo(10)},run-out,o/r,build,9000,900,9.99,10,success,99,build`, // outside window
  ]);
  const { out, code } = runCli(['usage', '--days', '7', '--by-role', '--json'], dir);
  assertEqual(code, 0);
  const obj = JSON.parse(out.trim());
  assertEqual(obj.runs, 2, 'run-old + run-1 (two rows, one run)');
  assertEqual(obj.tool_calls, 15, 'window totals include tool_calls');
  assertEqual(JSON.stringify(Object.keys(obj.by_role)), '["build","plan+build","review"]');
  assertEqual(obj.by_role.build.tokens_in, 2000, 'the 10-day-old build row is excluded');
  assertEqual(obj.by_role.build.tool_calls, 12);
  assertEqual(obj.by_role.review.est_usd, 0.25);
  const plain = JSON.parse(runCli(['usage', '--days', '7', '--json'], dir).out.trim());
  assertEqual(plain.by_role, undefined, 'no by_role without the flag');
});

test('cli: --by-role with a value is a usage error, exit 1', () => {
  const { code, err } = runCli(['usage', '--by-role', 'yes'], tmpDir());
  assertEqual(code, 1);
  assert(err.includes('--by-role'), 'error names the flag');
});

test('cli: bad --days values are usage errors, exit 1', () => {
  const dir = tmpDir();
  for (const bad of ['0', '-3', 'week', '1.5']) {
    const { code, err } = runCli(['usage', '--days', bad], dir);
    assertEqual(code, 1, `--days ${bad} rejected`);
    assert(err.includes('--days'), 'error names the flag');
  }
  const { code } = runCli(['usage', 'extra-arg'], dir);
  assertEqual(code, 1, 'positional args rejected');
});

// --- stage 21 (#58, ADR-0008): the unknown-cost gate must be approvable ----------
//
// Stage 18's breaker refused an unverifiable budget at startup BEFORE the P1
// approved-resume path ran, so approving the unknown-cost gate was a no-op and
// every default-policy codex worker wedged after its first run. The ledger now
// records the gate a run ended paused at (the `gate` column, run-level, on
// every row), and checkDailyLimits marks a refusal `approvable: true` only
// when EVERY unverifiable run today ended parked at the unknown-cost gate —
// i.e. a human was already asked for exactly the ADR-0008 decision.

// Codex-shaped rows that ended parked at the unknown-cost gate (stage 21+).
const GATED_ROW_A =
  '2026-06-10T01:00:00.000Z,run-cx-1,o/r,build,193745,2436,,93,success,7,build,unknown-cost';
const GATED_ROW_B =
  '2026-06-10T02:00:00.000Z,run-cx-2,o/r,build,213749,2223,,88,success,5,build,unknown-cost';

test('record (stage 21): the run-level gate is stamped on every row; ungated runs stamp nothing', () => {
  const dir = tmpDir();
  usage.record(dir, { ...SUMMARY, gate: 'unknown-cost' }, { commit: false });
  usage.record(dir, { ...SUMMARY, runId: 'run-2', outcome: 'success' }, { commit: false });
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 2);
  assertEqual(rows[0].gate, 'unknown-cost', 'the gated run records its terminal gate');
  assertEqual(rows[1].gate, '', 'a run that did not end gated records no gate');
});

test('readUsage (stage 21): pre-stage-21 11-column rows read back with gate ""', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.STAGE3_HEADER, CODEX_ROW_A]);
  const warnings = [];
  const { rows, skipped } = usage.readUsage(dir, { warn: (m) => warnings.push(m) });
  assertEqual(warnings.length, 0, 'the 11-column header is still a valid header');
  assertEqual(skipped, 0);
  assertEqual(rows[0].gate, '', 'missing gate column reads as empty, never invented');
});

test('rollup (stage 21): unknown_cost_gated_runs counts only fully gate-parked runs (fail closed)', () => {
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    GATED_ROW_A, // run-cx-1: unknown cost, parked at the gate
    CODEX_ROW_B, // run-cx-2: unknown cost, NO gate stamp — slipped through
    CLAUDE_ROW, // run-cl-1: verified cost — irrelevant to the count
  ]);
  const { rows } = usage.readUsage(dir);
  const totals = usage.rollup(rows);
  assertEqual(totals.unknown_cost_runs, 2);
  assertEqual(totals.unknown_cost_gated_runs, 1, 'only the parked run counts');
  // A run with BOTH a stamped and an unstamped unknown-cost row is not covered.
  const mixedDir = tmpDir();
  writeCsv(mixedDir, [
    usage.HEADER,
    GATED_ROW_A,
    '2026-06-10T01:30:00.000Z,run-cx-1,o/r,test,1000,100,,40,success,2,test,',
  ]);
  const mixed = usage.rollup(usage.readUsage(mixedDir).rows);
  assertEqual(mixed.unknown_cost_runs, 1);
  assertEqual(mixed.unknown_cost_gated_runs, 0, 'one unstamped row disqualifies the run');
});

test('checkDailyLimits (stage 21): a fully gate-parked unverifiable budget refuses but is approvable', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, GATED_ROW_A, GATED_ROW_B]);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 25, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(res.ok, false, 'still NOT ok — this function never waves a budget through');
  assertEqual(res.slug, 'unknown-cost-budget', "stage 18's slug, unchanged");
  assertEqual(res.approvable, true, 'but the worker may honour a pending verity:approved');
  assert(res.message.includes('verity:approved'), 'the message says how to unwedge');
});

test('checkDailyLimits (stage 21): ungated unknown cost, and behavior fail, are NEVER approvable', () => {
  const ungated = tmpDir();
  writeCsv(ungated, [usage.HEADER, GATED_ROW_A, CODEX_ROW_B]); // one run never gated
  const res = usage.checkDailyLimits(
    ungated,
    { max_usd_per_day: 25, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(res.ok, false);
  assertEqual(res.approvable, false, 'spend that slipped through ungated asked nobody — refuse');
  const failDir = tmpDir();
  writeCsv(failDir, [usage.HEADER, GATED_ROW_A]);
  const failRes = usage.checkDailyLimits(
    failDir,
    { max_usd_per_day: 25, max_runs_per_day: 24, unknown_cost_behavior: 'fail' },
    { now: DAY },
  );
  assertEqual(failRes.ok, false);
  assertEqual(failRes.approvable, false, "'fail' has no approval mechanism — never approvable");
});

test('checkDailyLimits (stage 21): a verified overspend still trips daily-limit FIRST, never approvable', () => {
  const dir = tmpDir();
  writeCsv(dir, [usage.HEADER, GATED_ROW_A, CLAUDE_ROW]);
  const res = usage.checkDailyLimits(
    dir,
    { max_usd_per_day: 3, max_runs_per_day: 24, unknown_cost_behavior: 'gate' },
    { now: DAY },
  );
  assertEqual(res.slug, 'daily-limit', 'known spend >= ceiling is a real trip, not doubt');
  assertEqual(res.approvable, undefined, 'no approval outranks a verified overspend');
});

// --- stage 53: provider + model columns (additive, backward-compatible) ----------
//
// Two new trailing columns record WHICH agent produced each row (provenance for
// the per-role work of stage 54 / ADR-0024 and the benchmark scorecard). The
// evolution is additive-only (§3.4): width grows to 14, older 12/11/9-column
// files keep reading forever with provider/model defaulting to ''. The columns
// are provenance ONLY — never summed, so no rollup number may move. A null model
// (the claude default) writes '', never a fabricated value.

test('stage 53: a 14-column row round-trips (write → read) with provider/model preserved', () => {
  const dir = tmpDir();
  const entry = usage.entryFromInvocation(
    { ...SUMMARY, provider: 'codex', model: 'gpt-5-codex' },
    {
      role: 'build',
      outcome: 'success',
      tokens: { in: 100, out: 10 },
      est_usd: null,
      wall_secs: 60,
      tool_calls: 5,
    },
    new Date('2026-06-10T12:00:00.000Z'),
  );
  usage.appendUsage(dir, entry);
  const csv = fs
    .readFileSync(path.join(dir, '.verity', 'usage.csv'), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  assertEqual(csv[0], usage.HEADER, 'fresh file gets the 14-column header');
  assertEqual(csv[0].split(',').length, 14, 'header width is 14');
  const { rows, skipped } = usage.readUsage(dir);
  assertEqual(skipped, 0);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].provider, 'codex', 'provider preserved through write→read');
  assertEqual(rows[0].model, 'gpt-5-codex', 'model preserved through write→read');
});

test('stage 53: a written row with provider codex / model gpt-5-codex reads back exactly', () => {
  const dir = tmpDir();
  usage.appendUsage(
    dir,
    usage.entryFromSummary(
      { ...SUMMARY, provider: 'codex', model: 'gpt-5-codex' },
      new Date('2026-06-10T00:00:00.000Z'),
    ),
  );
  const { rows } = usage.readUsage(dir);
  assertEqual(rows[0].provider, 'codex');
  assertEqual(rows[0].model, 'gpt-5-codex');
});

test('stage 53 (backward compat): 12/11/9-column files still parse; provider/model read ""', () => {
  // The critical guarantee. Each fixture is a LITERAL older-width CSV; none may
  // be warned about, skipped, or read as anything but empty provider/model.

  // pre-stage-53: 12 columns (…,tool_calls,role,gate — NO provider/model).
  const dir12 = tmpDir();
  writeCsv(dir12, [
    'timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate',
    '2026-06-10T01:00:00.000Z,run-1,o/r,build,100,10,0.50,60,success,7,build,unknown-cost',
  ]);
  const w12 = [];
  const r12 = usage.readUsage(dir12, { warn: (m) => w12.push(m) });
  assertEqual(w12.length, 0, 'the 12-column header is a recognized header, not a warning');
  assertEqual(r12.skipped, 0, 'the 12-column row is valid, not malformed');
  assertEqual(r12.rows.length, 1);
  assertEqual(r12.rows[0].gate, 'unknown-cost', 'the 12th column (gate) still reads');
  assertEqual(r12.rows[0].provider, '', 'missing provider reads as empty, never invented');
  assertEqual(r12.rows[0].model, '', 'missing model reads as empty, never invented');

  // pre-stage-21: 11 columns (no gate).
  const dir11 = tmpDir();
  writeCsv(dir11, [
    usage.STAGE3_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,build,100,10,0.50,60,success,7,build',
  ]);
  const w11 = [];
  const r11 = usage.readUsage(dir11, { warn: (m) => w11.push(m) });
  assertEqual(w11.length, 0);
  assertEqual(r11.skipped, 0);
  assertEqual(r11.rows[0].role, 'build');
  assertEqual(r11.rows[0].gate, '', 'missing gate reads as empty');
  assertEqual(r11.rows[0].provider, '');
  assertEqual(r11.rows[0].model, '');

  // pre-stage-3: 9 columns (no tool_calls/role/gate).
  const dir9 = tmpDir();
  writeCsv(dir9, [
    usage.LEGACY_HEADER,
    '2026-06-10T01:00:00.000Z,run-1,o/r,plan+build,100,10,0.50,60,success',
  ]);
  const w9 = [];
  const r9 = usage.readUsage(dir9, { warn: (m) => w9.push(m) });
  assertEqual(w9.length, 0);
  assertEqual(r9.skipped, 0);
  assertEqual(r9.rows[0].tool_calls, 0);
  assertEqual(r9.rows[0].role, '');
  assertEqual(r9.rows[0].gate, '');
  assertEqual(r9.rows[0].provider, '', 'a 9-column row reads provider as empty');
  assertEqual(r9.rows[0].model, '', 'a 9-column row reads model as empty');
});

test('stage 53: rollup + rollupByRole numbers are UNCHANGED by the new columns', () => {
  // The stage-3 rollup fixture, now carrying provider/model. Provenance must not
  // shift a single token/cost/tool_call total, and the rollups must NOT grow a
  // by-provider/by-model aggregate (out of scope).
  const dir = tmpDir();
  writeCsv(dir, [
    usage.HEADER,
    '2026-06-10T02:00:00.000Z,run-new,o/r,plan,100,10,0.50,60,success,4,plan,,claude,',
    '2026-06-10T03:00:00.000Z,run-new,o/r,build,200,20,1.00,300,success,31,build,,codex,gpt-5-codex',
    '2026-06-10T04:00:00.000Z,run-new,o/r,review,50,5,0.25,42,gated,7,review,,codex,gpt-5-codex',
  ]);
  const { rows, skipped } = usage.readUsage(dir);
  assertEqual(skipped, 0, 'all three 14-column rows parse');
  const totals = usage.rollup(rows);
  assertEqual(totals.runs, 1, 'one run_id');
  assertEqual(totals.tokens_in, 350);
  assertEqual(totals.tokens_out, 35);
  assertEqual(totals.est_usd, 1.75);
  assertEqual(totals.tool_calls, 42);
  assertEqual('provider' in totals, false, 'no by-provider rollup added (out of scope)');
  assertEqual('model' in totals, false, 'no by-model rollup added (out of scope)');
  const byRole = usage.rollupByRole(rows);
  assertEqual(JSON.stringify(Object.keys(byRole)), '["build","plan","review"]');
  assertEqual(byRole.build.tokens_in, 200);
  assertEqual(byRole.build.est_usd, 1);
  assertEqual(byRole.build.tool_calls, 31);
  assertEqual('provider' in byRole.build, false, 'per-role groups are unchanged in shape');
});

test('stage 53: a null model writes ""; est_usd/unknown-cost/gate semantics unchanged', () => {
  const dir = tmpDir();
  // provider present, model null (the claude default) → empty model cell.
  const entry = usage.entryFromSummary(
    { ...SUMMARY, provider: 'claude', model: null, est_usd: null, gate: 'unknown-cost' },
    new Date('2026-06-10T00:00:00.000Z'),
  );
  const row = usage.formatRow(entry);
  assert(row.endsWith('claude,'), 'provider written; a null model becomes a trailing empty cell');
  usage.appendUsage(dir, entry);
  const { rows } = usage.readUsage(dir);
  assertEqual(rows[0].provider, 'claude');
  assertEqual(rows[0].model, '', 'a null model is written and read as "" — never fabricated');
  assertEqual(rows[0].est_usd, null, 'unknown cost still UNKNOWN (null), never 0 (ADR-0008)');
  assertEqual(rows[0].gate, 'unknown-cost', 'gate semantics untouched');
});

test('stage 53 (worker path): an invocation carrying a resolved agentCfg writes its provider/model', () => {
  // The worker pushes agentCfg.provider/model onto every invocation (a null
  // model → ''). record() must land them on each per-invocation row.
  const dir = tmpDir();
  const summary = {
    ...SUMMARY,
    invocations: [
      {
        role: 'build',
        outcome: 'success',
        tokens: { in: 100, out: 10 },
        est_usd: 0.5,
        wall_secs: 60,
        tool_calls: 5,
        provider: 'codex',
        model: 'gpt-5-codex',
      },
      {
        role: 'review',
        outcome: 'gated',
        tokens: { in: 50, out: 5 },
        est_usd: null,
        wall_secs: 42,
        tool_calls: 7,
        provider: 'codex',
        model: 'gpt-5-codex',
      },
    ],
  };
  usage.record(dir, summary, { commit: false, now: new Date('2026-06-10T12:00:00.000Z') });
  const { rows } = usage.readUsage(dir);
  assertEqual(rows.length, 2);
  for (const r of rows) {
    assertEqual(r.provider, 'codex', 'each per-invocation row records the invocation provider');
    assertEqual(r.model, 'gpt-5-codex', 'each per-invocation row records the invocation model');
  }
  // A claude-default invocation (model null) lands provider claude, model ''.
  const dir2 = tmpDir();
  usage.record(
    dir2,
    {
      ...SUMMARY,
      invocations: [
        {
          role: 'plan',
          outcome: 'success',
          tokens: { in: 1, out: 1 },
          est_usd: 0.1,
          wall_secs: 1,
          tool_calls: 0,
          provider: 'claude',
          model: null,
        },
      ],
    },
    { commit: false },
  );
  const r2 = usage.readUsage(dir2).rows;
  assertEqual(r2[0].provider, 'claude');
  assertEqual(r2[0].model, '', 'a null model → "" on the row, never fabricated');
});
