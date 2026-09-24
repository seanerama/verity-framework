const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const map = require('../verity/bin/lib/map.cjs');
const recovery = require('../verity/bin/lib/recovery.cjs');
const golive = require('../verity/bin/lib/golive.cjs');
const security = require('../verity/bin/lib/security.cjs');
const status = require('../verity/bin/lib/status.cjs');

function fresh(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`));
}

// --- Codebase Mapper ---
test('map generate emits a Mermaid graph of the directory structure', () => {
  const d = fresh('map');
  fs.mkdirSync(path.join(d, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', 'junk'), { recursive: true });
  const r = map.generate(d, { depth: 3 });
  const out = fs.readFileSync(r.path, 'utf8');
  assert(out.includes('graph TD'), 'mermaid graph');
  assert(out.includes('"src"') && out.includes('"lib"') && out.includes('"tests"'), 'dirs mapped');
  assert(!out.includes('node_modules'), 'ignored dirs excluded');
});

// --- SRE recovery plan ---
test('recovery init scaffolds recovery-plan.md; idempotent', () => {
  const d = fresh('rec');
  const r = recovery.init(d);
  assert(r.created, 'created');
  assert(fs.readFileSync(r.path, 'utf8').includes('additive-only'), 'has the rollback discipline');
  assertEqual(recovery.init(d).created, false, 'idempotent');
});

// --- pre-go-live gate ---
test('golive blocks until auto-checks pass, then defers to manual gates', () => {
  const d = fresh('gl');
  const before = golive.check(d);
  assertEqual(before.ready, false, 'blocked with nothing set up');

  security.init(d);
  recovery.init(d);
  status.append(d, 'secret_locations', 'JWT_SECRET @ VM1:/opt/app/.env.prod');

  const after = golive.check(d);
  assertEqual(after.autoPass, true, 'auto-checks pass once invariants/recovery/secrets exist');
  assert(after.manual.length > 0, 'still lists manual gates for human sign-off');
});

// Stage 107: the n/a form satisfies auto-check 2, and the manual gates are
// objects with a disposition — the gate is `ready` only once all are answered.
test('golive: status secret --none passes auto-check 2; ready waits on the manual gates', () => {
  const d = fresh('gl-na');
  security.init(d);
  recovery.init(d);
  status.dispatch(['secret'], { cwd: d, none: 'no deploy host; credentials are env-only' });
  const r = golive.check(d);
  assertEqual(r.autoPass, true, 'n/a satisfies the secret-locations auto-check');
  assertEqual(r.ready, false, 'manual gates unanswered');
  assert(
    r.manual.every((m) => typeof m.id === 'string' && m.disposition === null),
    'manual gates are {id, item, disposition} objects, unanswered',
  );
  for (const m of r.manual) {
    golive.dispatch(['confirm', m.id], { cwd: d, by: 'sean' });
  }
  assertEqual(golive.check(d).ready, true, 'ready once every gate is answered');
});
