#!/usr/bin/env node
// Verity test runner. Zero dependencies — discovers tests/*.test.cjs, provides
// global test/assert/assertEqual/skip, runs them, and exits non-zero on any failure.
// (Deliberately tiny: the point of the walking skeleton is a REAL passing test,
// not a heavy framework.)
//
// Honesty rules (stage 99): the runner is SYNCHRONOUS, so a body that returns a
// Promise is a FAILURE (it would otherwise "pass" before its assertions ran); a
// declared skip — skip(reason) — is tallied and printed as a skip, never a pass;
// VERITY_TEST_FORBID_SKIPS=1 turns every skip into a failure for a lane that must
// be complete. VERITY_TESTS_DIR overrides the discovery directory (used by the
// runner's own tests to spawn it on fixtures).
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let skipped = 0;
let failed = 0;
const failures = [];
const forbidSkips = process.env.VERITY_TEST_FORBID_SKIPS === '1';
const noop = () => {};

// Runner-owned: only a skip() call produces one, so a test cannot fake a skip
// by throwing an ordinary error with a skip-looking message.
class SkipSignal extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipSignal';
  }
}

global.assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg || 'assertion failed');
  }
};

global.assertEqual = (actual, expected, msg) => {
  if (actual !== expected) {
    throw new Error(
      `${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

global.skip = (reason) => {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('skip() requires a non-empty reason — a skip must say why');
  }
  throw new SkipSignal(reason);
};

const fail = (name, err) => {
  failed += 1;
  failures.push({ name, err });
  console.log(`  ✗ ${name}: ${err.message}`);
};

global.test = (name, fn) => {
  try {
    const v = fn();
    if (v && typeof v.then === 'function') {
      v.then(noop, noop);
      fail(
        name,
        new Error(
          'returned a Promise — this runner is synchronous; an async body would pass before its assertions ran (make the body synchronous, e.g. spawnSync/execFileSync)',
        ),
      );
      return;
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    if (err instanceof SkipSignal) {
      if (forbidSkips) {
        fail(name, new Error(`skipped under VERITY_TEST_FORBID_SKIPS (${err.message})`));
        return;
      }
      skipped += 1;
      console.log(`  ⊘ ${name} — ${err.message}`);
      return;
    }
    fail(name, err);
  }
};

const dir = process.env.VERITY_TESTS_DIR
  ? path.resolve(process.env.VERITY_TESTS_DIR)
  : path.join(__dirname, '..', 'tests');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')) : [];

if (files.length === 0) {
  console.error('No test files found in tests/ — refusing a vacuous pass.');
  process.exit(1);
}

// Stage 100 (ADR-0035): run every test with the agent-result surface enforced
// strictly — agent-exec's dispatch() then throws on any top-level result key not
// declared in RESULT_KEYS, so every dispatch-driving test doubles as a contract
// drift detector. Test-only: production never sets it (declared() is a no-op).
// Child processes the tests spawn inherit it through process.env.
process.env.VERITY_STRICT_RESULT_KEYS = '1';

for (const file of files) {
  console.log(file);
  require(path.join(dir, file));
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
