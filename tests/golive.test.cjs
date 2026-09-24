// Stage 107 — golive can say not applicable: the `status secret --none` form,
// auto-check 2's n/a handling, recorded dispositions for the five manual gates,
// the STATUS.md `## Go-live gate` section, and `ready` = auto-checks pass AND
// every manual gate answered. Every test works in its own temp dir; the CLI
// tests always pass --cwd, never touching this repository's runtime.json.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const golive = require('../verity/bin/lib/golive.cjs');
const recovery = require('../verity/bin/lib/recovery.cjs');
const security = require('../verity/bin/lib/security.cjs');
const status = require('../verity/bin/lib/status.cjs');

const CLI = path.join(__dirname, '..', 'verity', 'bin', 'verity.cjs');
const NOW = '2026-09-24T12:00:00.000Z';
const IDS = [
  'secrets-rotated',
  'throwaway-accounts',
  'cross-user-isolation',
  'backup-coverage',
  'security-signoff',
];

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-golive-${tag}-`));
}

// A temp repo with the two documents present (security invariants + recovery
// plan), so auto-checks 1 and 3 pass and only check 2 depends on the test.
function withDocs(tag) {
  const d = fresh(tag);
  security.init(d);
  recovery.init(d);
  return d;
}

function cli(d, ...args) {
  const r = spawnSync('node', [CLI, '--cwd', d, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function statusMd(d) {
  return fs.readFileSync(path.join(d, 'STATUS.md'), 'utf8');
}

function runtimeJson(d) {
  return JSON.parse(fs.readFileSync(status.runtimePath(d), 'utf8'));
}

function refuses(fn, re, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert(err !== null, `${msg}: expected a refusal`);
  assert(re.test(err.message), `${msg}: message ${JSON.stringify(err.message)} matches ${re}`);
}

function secretItem(d) {
  return golive.check(d).items[1];
}

// --- status secret --none -----------------------------------------------------

test('status secret --none records the literal n/a string; auto-check 2 passes', () => {
  const d = withDocs('none');
  status.secret(d, [], { none: 'no deploy host; credentials are env-only' });
  assertEqual(
    JSON.stringify(status.read(d).secret_locations),
    JSON.stringify(['n/a: no deploy host; credentials are env-only']),
    'array holds the n/a string',
  );
  assertEqual(secretItem(d).ok, true, 'auto-check 2 ok');
  assertEqual(
    secretItem(d).item,
    'Secret locations recorded in STATUS (runtime.json)',
    'passing item text unchanged',
  );
  assert(
    statusMd(d).includes('- n/a: no deploy host; credentials are env-only'),
    'STATUS renders the n/a string like any location',
  );
});

test('status secret --none refuses a reason under 10 characters (and a bare --none)', () => {
  const d = fresh('short');
  refuses(() => status.secret(d, [], { none: 'x' }), /at least 10 characters/, '--none "x"');
  refuses(() => status.secret(d, [], { none: '   short  ' }), /at least 10/, 'trimmed short');
  refuses(() => status.secret(d, [], { none: true }), /at least 10/, 'bare --none');
  assert(!fs.existsSync(status.runtimePath(d)), 'nothing written on refusal');
});

test('status secret --none after a real location is refused', () => {
  const d = fresh('loc-then-none');
  status.secret(d, ['JWT_SECRET @ VM1:/opt/app/.env.prod'], {});
  refuses(
    () => status.secret(d, [], { none: 'no deploy host; credentials are env-only' }),
    /cannot both/,
    '--none after a location',
  );
  assertEqual(status.read(d).secret_locations.length, 1, 'unchanged');
});

test('a real location after --none is refused', () => {
  const d = fresh('none-then-loc');
  status.secret(d, [], { none: 'no deploy host; credentials are env-only' });
  refuses(
    () => status.secret(d, ['JWT_SECRET @ VM1:/opt/app/.env.prod'], {}),
    /cannot both/,
    'location after --none',
  );
  assertEqual(status.read(d).secret_locations.length, 1, 'unchanged');
});

test('status secret --none with a positional location as well is refused', () => {
  const d = fresh('both-at-once');
  refuses(
    () => status.secret(d, ['X @ y'], { none: 'no deploy host; credentials are env-only' }),
    /no location/,
    'both in one call',
  );
});

test('the plain status secret form is byte-identical to a direct append', () => {
  const a = fresh('plain-a');
  const b = fresh('plain-b');
  status.dispatch(['secret', 'JWT_SECRET', '@', 'VM1:/opt/app/.env.prod'], { cwd: a });
  status.append(b, 'secret_locations', 'JWT_SECRET @ VM1:/opt/app/.env.prod');
  assertEqual(
    fs.readFileSync(status.runtimePath(a), 'utf8'),
    fs.readFileSync(status.runtimePath(b), 'utf8'),
    'runtime.json',
  );
  assertEqual(statusMd(a), statusMd(b), 'STATUS.md');
});

// --- auto-check 2 -------------------------------------------------------------

test('a hand-written "n/a: " with a blank reason fails auto-check 2, saying why', () => {
  const d = withDocs('blank');
  status.write(d, { ...status.DEFAULTS, secret_locations: ['n/a: '] });
  const item = secretItem(d);
  assertEqual(item.ok, false, 'blank n/a fails');
  assert(/has no reason/.test(item.item), `item text explains: ${item.item}`);
  assert(/--none/.test(item.item), 'item text names the fix');
  assertEqual(golive.check(d).autoPass, false, 'autoPass false');
});

test('an empty secret_locations still fails auto-check 2 with the unchanged item text', () => {
  const d = withDocs('empty');
  const item = secretItem(d);
  assertEqual(item.ok, false, 'fails');
  assertEqual(item.item, 'Secret locations recorded in STATUS (runtime.json)', 'item text');
});

// --- manual gates --------------------------------------------------------------

test('manual gates carry the five stable ids and unchanged item text, unanswered by default', () => {
  const d = fresh('ids');
  const { manual } = golive.check(d);
  assertEqual(manual.map((m) => m.id).join(','), IDS.join(','), 'ids');
  assertEqual(
    manual.map((m) => m.item).join('|'),
    [
      'Secrets rotated (no dev/exposed credentials)',
      'Throwaway accounts removed',
      'Cross-user data isolation verified',
      'Backup coverage for ALL persistent state (no silent gaps)',
      'Security deep-audit sign-off',
    ].join('|'),
    'item text unchanged',
  );
  for (const m of manual) {
    assertEqual(
      JSON.stringify(Object.keys(m)),
      JSON.stringify(['id', 'item', 'disposition', 'by', 'at', 'reason']),
      `${m.id} shape`,
    );
    assertEqual(m.disposition, null, `${m.id} unanswered`);
  }
});

test('confirm --na persists the record, renders it in STATUS.md, and manual[] carries it', () => {
  const d = withDocs('na');
  golive.confirm(d, 'cross-user-isolation', {
    by: 'sean',
    na: 'single-operator tool, no user data store',
    now: NOW,
  });
  assertEqual(
    JSON.stringify(runtimeJson(d).golive['cross-user-isolation']),
    JSON.stringify({
      disposition: 'n/a',
      by: 'sean',
      at: NOW,
      reason: 'single-operator tool, no user data store',
    }),
    'persisted in runtime.json',
  );
  const entry = golive.check(d).manual.find((m) => m.id === 'cross-user-isolation');
  assertEqual(entry.disposition, 'n/a', 'disposition');
  assertEqual(entry.by, 'sean', 'by');
  assertEqual(entry.at, NOW, 'at');
  assertEqual(entry.reason, 'single-operator tool, no user data store', 'reason');
  const md = statusMd(d);
  assert(
    md.includes(
      '- **Cross-user data isolation verified:** n/a — single-operator tool, no user data store (sean, 2026-09-24)',
    ),
    'n/a line rendered',
  );
  assert(md.includes('- **Throwaway accounts removed:** unanswered'), 'others unanswered');
});

test('confirm without --by, or with a short --na reason, is refused and writes nothing', () => {
  const d = fresh('anon');
  refuses(() => golive.confirm(d, 'secrets-rotated', {}), /--by/, 'no --by');
  refuses(() => golive.confirm(d, 'secrets-rotated', { by: true }), /--by/, 'bare --by');
  refuses(() => golive.confirm(d, 'secrets-rotated', { by: '  ' }), /--by/, 'blank --by');
  refuses(
    () => golive.confirm(d, 'secrets-rotated', { by: 'sean', na: 'n/a' }),
    /at least 10/,
    'short --na',
  );
  refuses(
    () => golive.confirm(d, 'secrets-rotated', { by: 'sean', na: true }),
    /at least 10/,
    'bare --na',
  );
  assert(!fs.existsSync(status.runtimePath(d)), 'nothing written');
});

test('an unknown gate id is refused with the list of the five ids (confirm and reset)', () => {
  const d = fresh('unknown');
  for (const fn of [
    () => golive.confirm(d, 'no-such-gate', { by: 'sean' }),
    () => golive.reset(d, 'no-such-gate'),
    () => golive.confirm(d, undefined, { by: 'sean' }),
  ]) {
    refuses(fn, new RegExp(`use one of: ${IDS.join(', ')}`), 'unknown id');
  }
});

test('a hand-written anonymous or reasonless record counts as unanswered', () => {
  const d = fresh('handwritten');
  status.write(d, {
    ...status.DEFAULTS,
    golive: {
      'secrets-rotated': { disposition: 'ok', at: NOW },
      'throwaway-accounts': { disposition: 'n/a', by: 'sean', at: NOW },
      'backup-coverage': { disposition: 'yes', by: 'sean', at: NOW },
    },
  });
  for (const m of golive.check(d).manual) {
    assertEqual(m.disposition, null, `${m.id} unanswered`);
  }
});

test('ready: false with one gate unanswered, true once all five answered, reset flips it back', () => {
  const d = withDocs('ready');
  status.secret(d, [], { none: 'no deploy host; credentials are env-only' });
  for (const id of IDS.slice(0, 4)) {
    golive.confirm(d, id, { by: 'sean', now: NOW });
  }
  let r = golive.check(d);
  assertEqual(r.autoPass, true, 'auto-checks pass');
  assertEqual(r.ready, false, 'one gate unanswered');
  assertEqual(r.raw, 'auto-checks pass; 1 manual gate(s) unanswered: security-signoff', 'raw');

  golive.confirm(d, 'security-signoff', { by: 'sean', now: NOW });
  r = golive.check(d);
  assertEqual(r.ready, true, 'all answered');

  const out = golive.reset(d, 'throwaway-accounts');
  assertEqual(out.removed, true, 'removed');
  r = golive.check(d);
  assertEqual(r.ready, false, 'reset flips it back');
  assertEqual(
    r.raw,
    'auto-checks pass; 1 manual gate(s) unanswered: throwaway-accounts',
    'names id',
  );
  assertEqual(
    Object.hasOwn(runtimeJson(d).golive, 'throwaway-accounts'),
    false,
    'record removed from runtime.json',
  );
});

test('ready stays false while an auto-check fails, even with every gate answered', () => {
  const d = fresh('blocked');
  for (const id of IDS) {
    golive.confirm(d, id, { by: 'sean', now: NOW });
  }
  const r = golive.check(d);
  assertEqual(r.autoPass, false, 'auto-checks fail');
  assertEqual(r.ready, false, 'not ready');
  assertEqual(r.raw, 'BLOCKED: resolve the failing auto-checks', 'blocked message unchanged');
});

test('resetting the last answered gate drops the golive key; reset of an unanswered gate is a no-op', () => {
  const d = fresh('drop');
  status.set(d, 'version', '1.0.0');
  const before = fs.readFileSync(status.runtimePath(d), 'utf8');
  const beforeMd = statusMd(d);
  golive.confirm(d, 'secrets-rotated', { by: 'sean', now: NOW });
  assert(statusMd(d).includes('## Go-live gate'), 'section rendered while a record exists');
  golive.reset(d, 'secrets-rotated');
  assertEqual(
    fs.readFileSync(status.runtimePath(d), 'utf8'),
    before,
    'runtime.json back to before',
  );
  assertEqual(statusMd(d), beforeMd, 'STATUS.md back to before');
  assertEqual(golive.reset(d, 'secrets-rotated').removed, false, 'no-op reset');
});

// --- STATUS.md rendering ------------------------------------------------------

test('a runtime.json without golive reads and renders exactly as before (no gate section)', () => {
  const d = fresh('legacy');
  const legacy = {
    version: '1.2.0',
    deployed_at: '2026-09-01T00:00:00Z',
    rollback_from: null,
    environments: { prod: { digest: 'sha256:abc' } },
    secret_locations: ['JWT_SECRET @ VM1:/opt/app/.env.prod'],
    notes: ['a coordination note'],
  };
  fs.mkdirSync(path.join(d, '.verity'));
  fs.writeFileSync(status.runtimePath(d), `${JSON.stringify(legacy, null, 2)}\n`);
  assertEqual(JSON.stringify(status.read(d)), JSON.stringify(legacy), 'reads identically');
  assertEqual(JSON.stringify(status.DEFAULTS.golive), undefined, 'DEFAULTS has no golive key');
  status.render(d, status.read(d));
  const expected = [
    '# Status & Handoff',
    '',
    '> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`',
    '> by the Release/Deploy Operator. Secret LOCATIONS only — never values.',
    '',
    '**Live version:** 1.2.0',
    '**Deployed at:** 2026-09-01T00:00:00Z',
    '**Rollback from:** (n/a)',
    '',
    '## Environments',
    '- **prod:** {"digest":"sha256:abc"}',
    '',
    '## Secret locations (names + on-disk locations only, never values)',
    '- JWT_SECRET @ VM1:/opt/app/.env.prod',
    '',
    '## Coordination notes',
    '- a coordination note',
  ].join('\n');
  assertEqual(statusMd(d), `${expected}\n`, 'pre-107 bytes');

  // With a golive key, the render is the same bytes plus the new section.
  golive.confirm(d, 'secrets-rotated', { by: 'sean', now: NOW });
  const md = statusMd(d);
  const cut = md.indexOf('\n## Go-live gate\n');
  assert(cut !== -1, 'section present');
  assertEqual(md.slice(0, cut), `${expected}\n`, 'everything before the section unchanged');
});

test('the Go-live gate section follows Coordination notes and re-renders idempotently', () => {
  const d = fresh('idem');
  golive.confirm(d, 'secrets-rotated', { by: 'sean', now: NOW });
  golive.confirm(d, 'backup-coverage', {
    by: 'ops',
    na: 'persistent state is GitHub and npm',
    now: '2026-09-25T01:02:03.000Z',
  });
  const md = statusMd(d);
  assert(md.indexOf('## Coordination notes') < md.indexOf('## Go-live gate'), 'section order');
  assert(
    md.endsWith(
      [
        '## Go-live gate',
        '- **Secrets rotated (no dev/exposed credentials):** ok — sean, 2026-09-24',
        '- **Throwaway accounts removed:** unanswered',
        '- **Cross-user data isolation verified:** unanswered',
        '- **Backup coverage for ALL persistent state (no silent gaps):** n/a — persistent state is GitHub and npm (ops, 2026-09-25)',
        '- **Security deep-audit sign-off:** unanswered',
        '',
      ].join('\n'),
    ),
    `section rendered:\n${md}`,
  );
  status.render(d, status.read(d));
  assertEqual(statusMd(d), md, 'idempotent re-render');
});

// --- CLI ------------------------------------------------------------------------

test('CLI refusals exit 1: --none "x", confirm without --by, unknown id, short --na', () => {
  const d = fresh('cli-refuse');
  const cases = [
    [['status', 'secret', '--none', 'x'], /at least 10/],
    [['golive', 'confirm', 'secrets-rotated'], /--by/],
    [['golive', 'confirm', 'nope', '--by', 'sean'], /use one of: secrets-rotated, /],
    [['golive', 'reset', 'nope'], /use one of: /],
    [['golive', 'confirm', 'secrets-rotated', '--by', 'sean', '--na', 'short'], /at least 10/],
    [['golive', 'frobnicate'], /unknown golive verb/],
  ];
  for (const [args, re] of cases) {
    const r = cli(d, ...args);
    assertEqual(r.code, 1, `${args.join(' ')} exits 1`);
    assert(re.test(r.stderr), `${args.join(' ')} stderr: ${r.stderr}`);
  }
  assert(!fs.existsSync(status.runtimePath(d)), 'no refusal wrote runtime.json');
});

test('acceptance: --none plus five confirms → ready; STATUS shows the table; reset one → not ready, id named', () => {
  const d = withDocs('accept');
  let r = cli(d, 'status', 'secret', '--none', 'no deploy host; credentials are env-only');
  assertEqual(r.code, 0, `status secret --none: ${r.stderr}`);

  r = cli(
    d,
    'golive',
    'confirm',
    'cross-user-isolation',
    '--by',
    'sean',
    '--na',
    'single-operator tool, no user data store',
  );
  assertEqual(r.code, 0, `confirm --na: ${r.stderr}`);
  assertEqual(r.json.disposition, 'n/a', 'n/a recorded');
  assertEqual(r.json.ready, false, 'not ready yet');
  r = cli(
    d,
    'golive',
    'confirm',
    'backup-coverage',
    '--by',
    'sean',
    '--na',
    'persistent state is GitHub and the npm registry',
  );
  assertEqual(r.code, 0, `confirm --na: ${r.stderr}`);
  for (const id of ['secrets-rotated', 'throwaway-accounts', 'security-signoff']) {
    r = cli(d, 'golive', 'confirm', id, '--by', 'sean');
    assertEqual(r.code, 0, `confirm ${id}: ${r.stderr}`);
    assertEqual(r.json.disposition, 'ok', `${id} ok`);
    assert(/^\d{4}-\d{2}-\d{2}T/.test(r.json.at), `${id} stamped`);
  }

  r = cli(d, 'golive');
  assertEqual(r.code, 0, 'golive exits 0');
  assertEqual(r.json.autoPass, true, 'auto-checks pass');
  assertEqual(r.json.ready, true, 'ready: true');
  assertEqual(r.json.manual.filter((m) => m.disposition).length, 5, 'five answered');

  const md = statusMd(d);
  assert(md.includes('## Go-live gate'), 'STATUS shows the gate table');
  assert(!md.includes('unanswered'), 'no gate unanswered');
  assert(
    /- \*\*Cross-user data isolation verified:\*\* n\/a — single-operator tool, no user data store \(sean, \d{4}-\d{2}-\d{2}\)/.test(
      md,
    ),
    'n/a line',
  );
  assert(
    /- \*\*Security deep-audit sign-off:\*\* ok — sean, \d{4}-\d{2}-\d{2}/.test(md),
    'ok line',
  );

  r = cli(d, 'golive', 'reset', 'security-signoff');
  assertEqual(r.code, 0, `reset: ${r.stderr}`);
  assertEqual(r.json.removed, true, 'removed');
  r = cli(d, 'golive', '--raw');
  assertEqual(
    r.stdout.trim(),
    'auto-checks pass; 1 manual gate(s) unanswered: security-signoff',
    'raw names the id',
  );
  r = cli(d, 'golive');
  assertEqual(r.json.ready, false, 'ready: false after reset');
  assert(
    statusMd(d).includes('- **Security deep-audit sign-off:** unanswered'),
    'STATUS shows it unanswered',
  );
});
