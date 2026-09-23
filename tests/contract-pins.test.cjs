// Stage 100 (ADR-0035) — contract pinning: each of the five frozen v1 contracts
// amended on 2026-09-23 must DOCUMENT everything the engine EMITS. The
// documented key set is derived from the contract text itself
// (tests/lib/contract-doc.cjs: fenced json/yaml examples + backticked names);
// the emitted set is observed from the real producer (hermetic fixtures, the
// declared RESULT_KEYS, or a grep of engine literals). The next additive field,
// effect kind, record status, or capability that lands in code without a
// contract line fails `npm test` instead of waiting for a revisit.
//
// Every pin is a pure function (contract path, observed surface) → problems[],
// so each one is proven NON-VACUOUS below by running it against a temp copy of
// its contract with one documented field removed — the real contracts are only
// ever read. Contract text is frozen (architect-owned): a failing pin here is a
// contract finding to escalate, never a reason to edit the pin or the contract.
//
// Fixtures: in-process only, no network, no real `gh` (injected stubs), local
// git + an offline `npm ci`/`npm pack` over a zero-dependency fixture package
// (the tests/promotion-*.test.cjs patterns). All bodies are synchronous.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { children, documentedKeys, parseContract } = require('./lib/contract-doc.cjs');
const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const resultContract = require('../verity/bin/lib/agents/result-contract.cjs');
const codex = require('../verity/bin/lib/agents/codex.cjs');
const operatorAct = require('../verity/bin/lib/operator-act.cjs');
const promotion = require('../verity/bin/lib/promotion.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(REPO_ROOT, 'contracts');
const LIB = path.join(REPO_ROOT, 'verity', 'bin', 'lib');
const contract = (name) => path.join(CONTRACTS, `${name}.md`);
const src = (...rel) => fs.readFileSync(path.join(LIB, ...rel), 'utf8');

// --- shared helpers ------------------------------------------------------------

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verity-pins-${tag}-`));
}

function rm(p) {
  if (p) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

function initRepo(dir) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Verity Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
const sorted = (xs) => [...xs].sort();

// Every name in `emitted` missing from `documented`, as one problem line each.
function missing(what, emitted, documented) {
  return sorted(emitted)
    .filter((k) => !documented.has(k))
    .map((k) => `${what}: '${k}' is emitted but not documented`);
}

// Every regex capture-1 in `text`, as a Set.
function literals(text, re) {
  return new Set([...text.matchAll(re)].map((m) => m[1]));
}

// A temp copy of `contractFile` with every whole-token occurrence of `field`
// replaced — the documented field is GONE from the copy while its examples
// still parse. The caller removes the returned dir.
const NEGATIVE_PLACEHOLDER = 'removed_by_negative_pin';
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function withoutField(contractFile, field) {
  const text = fs.readFileSync(contractFile, 'utf8');
  const re = new RegExp(`(?<![\\w-])${escapeRe(field)}(?![\\w-])`, 'g');
  const mutated = text.replace(re, NEGATIVE_PLACEHOLDER);
  if (mutated === text) {
    throw new Error(`negative pin setup: '${field}' does not occur in ${contractFile}`);
  }
  const dir = tmp('neg');
  const file = path.join(dir, path.basename(contractFile));
  fs.writeFileSync(file, mutated);
  return { dir, file };
}

// Run `pin` against the real contract (must be clean) and against a copy with
// `field` removed (must name `field`) — the non-vacuity proof.
function assertNegative(pin, contractFile, field) {
  const clean = pin(contractFile);
  assertEqual(clean.length, 0, `real contract is clean first: ${clean.join('; ')}`);
  const { dir, file } = withoutField(contractFile, field);
  try {
    const problems = pin(file);
    // The problem names the field, possibly as the leaf of a dotted path.
    const named = new RegExp(`'(?:[\\w-]+\\.)*${escapeRe(field)}'`);
    assert(
      problems.some((p) => named.test(p)),
      `removing documented '${field}' must fail the pin (got: ${JSON.stringify(problems)})`,
    );
  } finally {
    rm(dir);
  }
}

// Put the runner's strict-mode env back exactly (an unset var stays unset —
// assigning `undefined` to process.env would store the string "undefined").
function restoreStrict(prior) {
  if (prior === undefined) {
    Reflect.deleteProperty(process.env, 'VERITY_STRICT_RESULT_KEYS');
  } else {
    process.env.VERITY_STRICT_RESULT_KEYS = prior;
  }
}

// ================================================================================
// agent-result — RESULT_KEYS declared once, enforced strictly under the runner
// ================================================================================

test('agent-result: declared() throws on an undeclared key under VERITY_STRICT_RESULT_KEYS=1', () => {
  const prior = process.env.VERITY_STRICT_RESULT_KEYS;
  process.env.VERITY_STRICT_RESULT_KEYS = '1';
  try {
    const stub = { schema: 1, role: 'plan', outcome: 'success', bogus: 1 };
    let err = null;
    try {
      agentExec.declared(stub);
    } catch (e) {
      err = e;
    }
    assert(err !== null, 'an undeclared key must throw in strict mode');
    assert(/undeclared agent-result key: bogus/.test(err.message), `names the key: ${err.message}`);
    assert(err.message.includes('RESULT_KEYS'), 'the error names RESULT_KEYS as the fix site');
    assert(err.message.includes('contracts/agent-result.md'), 'and the contract text');
    const ok = { schema: 1, role: 'plan', outcome: 'success', work_items: {} };
    assert(agentExec.declared(ok) === ok, 'a fully declared result passes through unchanged');
  } finally {
    restoreStrict(prior);
  }
});

test('agent-result: env unset ⇒ declared() returns the SAME object untouched (production byte-identical)', () => {
  const prior = process.env.VERITY_STRICT_RESULT_KEYS;
  try {
    for (const value of [undefined, '0', 'true', '']) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, 'VERITY_STRICT_RESULT_KEYS');
      } else {
        process.env.VERITY_STRICT_RESULT_KEYS = value;
      }
      const stub = { schema: 1, bogus: 1, nested: { x: 1 } };
      const before = JSON.stringify(stub);
      const out = agentExec.declared(stub);
      assert(out === stub, `same reference returned (env=${JSON.stringify(value)})`);
      assertEqual(JSON.stringify(out), before, 'contents untouched');
    }
  } finally {
    restoreStrict(prior);
  }
});

test('agent-result: the runner enforces strictly, and RESULT_KEYS is frozen with no duplicates', () => {
  assertEqual(process.env.VERITY_STRICT_RESULT_KEYS, '1', 'scripts/run-tests.cjs sets strict mode');
  assert(Object.isFrozen(agentExec.RESULT_KEYS), 'RESULT_KEYS is frozen');
  assertEqual(
    new Set(agentExec.RESULT_KEYS).size,
    agentExec.RESULT_KEYS.length,
    'no duplicate keys',
  );
  // The v1 base builder's keys are all declared (the REQUIRED fields).
  const base = resultContract.buildResult('plan', Date.now(), 'success');
  for (const k of Object.keys(base)) {
    assert(agentExec.RESULT_KEYS.includes(k), `buildResult key '${k}' declared`);
  }
});

function pinAgentResultKeys(file) {
  const doc = documentedKeys(file);
  return missing(
    'agent-result top-level key',
    agentExec.RESULT_KEYS,
    union(doc.jsonTopLevelKeys, doc.backtickedNames),
  );
}

test('agent-result pin: RESULT_KEYS ⊆ documented (json examples ∪ backticked names)', () => {
  const problems = pinAgentResultKeys(contract('agent-result'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// artifacts sub-keys, OBSERVED: `paths` from codex's structured-output
// normalization (run it), `pr` from the git-lifecycle fold in agent-exec (grep).
function emittedArtifactKeys() {
  const structured = {
    verity: 1,
    outcome: 'completed',
    gate: null,
    artifacts: ['docs/x.md'],
    reason: null,
    summary: 'pin fixture',
  };
  const normalized = codex.normalizeResult({
    finalMessageText: JSON.stringify(structured),
    lastAgentMessage: null,
    failure: null,
  });
  const keys = new Set(Object.keys(normalized.artifacts));
  const folded = literals(
    src('agent-exec.cjs'),
    /artifacts: \{ \.\.\.\(out\.artifacts \|\| \{\}\), ([A-Za-z_]\w*):/g,
  );
  assert(folded.size > 0, 'the git-lifecycle artifacts fold is still greppable in agent-exec.cjs');
  for (const k of folded) {
    keys.add(k);
  }
  return new Set([...keys].map((k) => `artifacts.${k}`));
}

function pinArtifactKeys(file) {
  return missing(
    'agent-result artifacts key',
    emittedArtifactKeys(),
    documentedKeys(file).backtickedNames,
  );
}

test('agent-result pin: artifacts.paths / artifacts.pr (observed) are documented', () => {
  const emitted = emittedArtifactKeys();
  assertEqual(
    sorted(emitted).join(','),
    'artifacts.paths,artifacts.pr',
    'observed artifact sub-keys',
  );
  const problems = pinArtifactKeys(contract('agent-result'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// The three vocabulary layers, each derived from SOURCE: the text-marker
// OUTCOMES, the structured-output ROLE_OUTCOMES, the wire (OUTCOMES +
// infra_error, per exitCodeFor), and codex's normalization map.
function pinVocabulary(file) {
  const doc = documentedKeys(file);
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  // The wire adds the engine-only infra_error (exit 30) to the marker outcomes.
  const wire = [...resultContract.OUTCOMES, 'infra_error'];
  for (const [layer, vocab] of [
    ['marker OUTCOMES', resultContract.OUTCOMES],
    ['structured ROLE_OUTCOMES', resultContract.ROLE_OUTCOMES],
    ['wire', wire],
  ]) {
    const literal = vocab.join('|');
    if (!doc.backtickedNames.has(literal)) {
      problems.push(`agent-result vocabulary: ${layer} '${literal}' is not documented`);
    }
  }
  const m =
    /structured\.outcome === '([\w-]+)' \|\| structured\.outcome === '([\w-]+)'\s*\?\s*'([\w-]+)'/.exec(
      src('agents', 'codex.cjs'),
    );
  assert(m !== null, 'codex.cjs normalization map is still greppable');
  const [, a, b, to] = m;
  const sentence = new RegExp(`\`${a}\`\\s+and\\s+\`${b}\`\\s+map\\s+to\\s+wire\\s+\`${to}\``);
  if (!sentence.test(text)) {
    problems.push(`agent-result normalization: '${a}' and '${b}' → '${to}' is not documented`);
  }
  return problems;
}

test('agent-result pin: OUTCOMES / structured vocabulary / wire vocabulary / codex normalization documented', () => {
  const problems = pinVocabulary(contract('agent-result'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// ================================================================================
// operator-act — effect kinds (grep + hermetic run), reject order, worker-tick
// ================================================================================

const REPO = 'acme/widget';
const okGh = () => '';

function actEffects(result) {
  return (Array.isArray(result.effects) ? result.effects : [result.effect]).filter(
    (e) => e !== null,
  );
}

// Observed by RUNNING every verb against an injected fake gh / spawn.
const actRuns = {
  approve: operatorAct.dispatch(['approve', '42'], { repo: REPO }, { run: okGh }),
  reject: operatorAct.dispatch(['reject', '7'], { repo: REPO }, { run: okGh }),
  requestChanges: operatorAct.dispatch(
    ['request-changes', '7'],
    { repo: REPO },
    { run: okGh, note: 'rework the tests' },
  ),
  runOnceOk: operatorAct.dispatch(
    ['run-once'],
    { repo: REPO },
    { spawn: () => ({ status: 0, stdout: 'tick: ok\nmore\n', stderr: '' }) },
  ),
  runOnceSpawnError: operatorAct.dispatch(
    ['run-once'],
    { repo: REPO },
    {
      spawn: () => {
        throw new Error('ENOENT');
      },
    },
  ),
  runOnceSpawnResultError: operatorAct.dispatch(
    ['run-once'],
    { repo: REPO },
    { spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('EACCES') }) },
  ),
  // No repo: act() refuses before any effect (effect: null) — a real result
  // shape, contributing no kind.
  noRepo: operatorAct.dispatch(['run-once'], {}, { repo: null }),
};

function emittedEffectKinds() {
  const grepped = literals(src('operator-act.cjs'), /kind: '([\w-]+)'/g);
  const observed = new Set(
    Object.values(actRuns)
      .flatMap(actEffects)
      .map((e) => e.kind),
  );
  return { grepped, observed, all: union(grepped, observed) };
}

function pinEffectKinds(file) {
  return missing(
    'operator-act effect kind',
    emittedEffectKinds().all,
    documentedKeys(file).backtickedNames,
  );
}

test('operator-act pin: every emitted effect.kind (grepped ∪ observed) is documented', () => {
  const { grepped, observed } = emittedEffectKinds();
  assertEqual(
    sorted(grepped).join(','),
    'comment,label-add,label-remove,worker-tick',
    'kind literals in operator-act.cjs',
  );
  for (const k of observed) {
    assert(grepped.has(k), `observed kind '${k}' is one of the source literals`);
  }
  const problems = pinEffectKinds(contract('operator-act'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// Documented-but-reserved: named in the text, annotated reserved, never emitted.
function pinReservedKinds(file) {
  const doc = documentedKeys(file);
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  if (!doc.backtickedNames.has('label-swap')) {
    problems.push("operator-act: 'label-swap' is no longer documented");
  }
  if (!/`label-swap` is reserved/.test(text)) {
    problems.push("operator-act: 'label-swap' is not annotated reserved");
  }
  if (emittedEffectKinds().all.has('label-swap')) {
    problems.push("operator-act: 'label-swap' is emitted but documented reserved");
  }
  return problems;
}

test('operator-act pin: label-swap is documented AND reserved AND never emitted', () => {
  const problems = pinReservedKinds(contract('operator-act'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// The documented reject order, read from the contract sentence itself.
function documentedRejectOrder(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
  const m = /`reject` is expressed as an `effects\[\]` array of (.*?) in that order/.exec(text);
  if (m === null) {
    return null;
  }
  return [...m[1].matchAll(/`(label-[\w-]+)`/g)].map((x) => x[1]);
}

test('operator-act pin: reject effects[] is exactly label-remove, label-remove, label-add (observed = documented)', () => {
  const r = actRuns.reject;
  assertEqual(r.ok, true, 'hermetic reject ok');
  const observed = actEffects(r).map((e) => e.kind);
  assertEqual(observed.join(','), 'label-remove,label-remove,label-add', 'observed reject order');
  const documented = documentedRejectOrder(contract('operator-act'));
  assert(documented !== null, 'the contract states the reject effects[] order');
  assertEqual(documented.join(','), observed.join(','), 'documented order = observed order');
});

function emittedWorkerTickKeys() {
  const keys = new Set();
  for (const r of [actRuns.runOnceOk, actRuns.runOnceSpawnError, actRuns.runOnceSpawnResultError]) {
    assertEqual(r.effect.kind, 'worker-tick', `run-once effect kind (${r.effect.outcome})`);
    for (const k of Object.keys(r.effect)) {
      keys.add(k);
    }
  }
  return keys;
}

function pinWorkerTick(file) {
  return missing(
    'operator-act worker-tick field',
    emittedWorkerTickKeys(),
    documentedKeys(file).backtickedNames,
  );
}

test('operator-act pin: worker-tick effect keys ⊆ documented {kind, command, exitCode, outcome, summary}', () => {
  const emitted = emittedWorkerTickKeys();
  assertEqual(
    sorted(emitted).join(','),
    'command,exitCode,kind,outcome,summary',
    'observed worker-tick keys across ok / thrown spawn / spawn error result',
  );
  const problems = pinWorkerTick(contract('operator-act'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// ================================================================================
// production-projection — the report `project` writes and `verify` extends
// ================================================================================

const FIXTURE_PKG = 'verity-pins-fixture';
const PACK_FILES = {
  'package.json': `${JSON.stringify(
    {
      name: FIXTURE_PKG,
      version: '1.2.0',
      license: 'MIT',
      files: ['lib'],
      scripts: { lint: 'node -e "process.exit(0)"', test: 'node test.js' },
    },
    null,
    2,
  )}\n`,
  'package-lock.json': `${JSON.stringify(
    {
      name: FIXTURE_PKG,
      version: '1.2.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: FIXTURE_PKG, version: '1.2.0' } },
    },
    null,
    2,
  )}\n`,
  'lib/a.js': 'module.exports = 100;\n',
  'test.js': 'if (require("./lib/a.js") !== 100) { process.exit(1); }\n',
};

// project + verify over a dev repo whose whole tree is public except .verity/.
function projectAndVerify() {
  const repo = tmp('proj');
  initRepo(repo);
  writeTree(repo, {
    ...PACK_FILES,
    '.verity/production-content-classification.yml': [
      'schema_version: 1',
      'rules:',
      '  - pattern: "**"',
      '    bucket: public',
      '    reason: "test"',
      '  - pattern: ".verity/**"',
      '    bucket: private',
      '    reason: "test"',
      '',
    ].join('\n'),
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const projected = promotion.project('HEAD', { cwd: repo });
  assertEqual(
    projected.verdict,
    'built',
    `projection built (${JSON.stringify(projected.failures)})`,
  );
  const projectReport = JSON.parse(fs.readFileSync(projected.report_path, 'utf8'));
  const verified = promotion.verify(projected.staging_dir, {
    cwd: repo,
    report: projected.report_path,
  });
  assertEqual(verified.exit_code, 0, `verify passed (${JSON.stringify(verified.verify)})`);
  const report = JSON.parse(fs.readFileSync(projected.report_path, 'utf8'));
  rm(projected.staging_dir);
  rm(projected.report_path);
  rm(repo);
  return { projectReport, report };
}
const projection = projectAndVerify();

function pinProjection(file) {
  const doc = documentedKeys(file);
  const { projectReport, report } = projection;
  const problems = [
    ...missing('projection report key (project)', Object.keys(projectReport), doc.jsonTopLevelKeys),
    ...missing('projection report key (verify)', Object.keys(report), doc.jsonTopLevelKeys),
  ];
  const docVerify = children(doc.jsonKeyPaths, 'verify');
  problems.push(...missing('verify block key', Object.keys(report.verify), docVerify));
  for (const k of docVerify) {
    if (!(k in report.verify)) {
      problems.push(`verify block key: '${k}' is documented but not emitted on a passing verify`);
    }
  }
  const docGates = children(doc.jsonKeyPaths, 'verify.gates');
  problems.push(...missing('verify.gates key', Object.keys(report.verify.gates), docGates));
  for (const k of docGates) {
    if (!(k in report.verify.gates)) {
      problems.push(`verify.gates key: '${k}' is documented but not emitted`);
    }
  }
  // Each gate's object fields: the `{ ok, command, summary }` shape span plus the
  // backticked install extras (`downgraded`, `reason`).
  const shape = [...doc.backtickedNames].find((s) => /\{\s*ok,\s*command,\s*summary\s*\}/.test(s));
  const gateFields = new Set(shape ? ['ok', 'command', 'summary'] : []);
  for (const [name, gate] of Object.entries(report.verify.gates)) {
    if (gate !== null) {
      problems.push(
        ...missing(
          `verify.gates.${name} field`,
          Object.keys(gate),
          union(gateFields, doc.backtickedNames),
        ),
      );
    }
  }
  return problems;
}

test('production-projection pin: report keys ⊆ documented; verify = {gates, pack_shasum, baseline, verdict}; gates = {install, lint, test, pack}', () => {
  const { report } = projection;
  assertEqual(
    sorted(Object.keys(report.verify)).join(','),
    'baseline,gates,pack_shasum,verdict',
    'verify keys',
  );
  assertEqual(
    sorted(Object.keys(report.verify.gates)).join(','),
    'install,lint,pack,test',
    'gate keys',
  );
  assertEqual(report.verify.verdict, 'passed', 'a passing verify');
  const problems = pinProjection(contract('production-projection'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// ================================================================================
// promotion-records — PROM record keys at propose AND finalize; status machine
// ================================================================================

const DEV_URL = 'https://github.com/acme/widget-dev.git';
const PROD_REPO = 'acme/widget-prod';
const DEV_SHA = 'f0e1d2c3b4a5968778695a4b3c2d1e0f01234567';
const CLASSIFICATION_DIGEST = `sha256:${'a'.repeat(64)}`;
const STAGING_DIGEST = `sha256:${'b'.repeat(64)}`;

function packShasum(files) {
  const dir = tmp('packsrc');
  const dest = tmp('packdest');
  writeTree(dir, files);
  execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  const sha = crypto
    .createHash('sha1')
    .update(fs.readFileSync(path.join(dest, tgz)))
    .digest('hex');
  rm(dir);
  rm(dest);
  return sha;
}

// Keys (dotted) of a PROM record as the engine wrote it, read by the SAME
// comment-stripping yaml reader contract-doc applies to the contract's example
// (fails loud on a line that is not a `key:` mapping).
const recordKeyPaths = (text) =>
  parseContract(`\`\`\`yaml\n${text}\`\`\`\n`, 'PROM record').yamlKeyPaths;

const statusOf = (text) => /^status: (\S+)$/m.exec(text)?.[1] ?? null;

// propose (engine writes the record + manifest) → finalize (engine completes
// the SAME record) — the chain of the stage-43/44 fixtures.
function proposeThenFinalize() {
  const shasum = packShasum(PACK_FILES);
  const dirs = [];
  const mk = (tag) => {
    const d = tmp(tag);
    dirs.push(d);
    return d;
  };
  const promotionJson = (prodOwned) =>
    `${JSON.stringify({ schema: 1, split_active: true, prod_repo: PROD_REPO, prod_owned: prodOwned })}\n`;

  // -- propose ----------------------------------------------------------------
  const proposeDev = mk('pdev');
  initRepo(proposeDev);
  git(proposeDev, 'remote', 'add', 'origin', DEV_URL);
  writeTree(proposeDev, {
    '.verity/promotion.json': promotionJson(['.github/**', 'RELEASE-MANIFEST.json']),
  });
  git(proposeDev, 'add', '-A');
  git(proposeDev, 'commit', '-q', '-m', 'dev fixture');

  const prodWork = mk('pwork');
  initRepo(prodWork);
  writeTree(prodWork, { 'README.md': 'prod baseline\n', '.github/workflows/ci.yml': 'name: ci\n' });
  git(prodWork, 'add', '-A');
  git(prodWork, 'commit', '-q', '-m', 'prod baseline');
  git(prodWork, 'tag', 'v1.1.0');
  const prodBare = mk('pbare');
  fs.rmdirSync(prodBare);
  git(path.dirname(prodBare), 'clone', '-q', '--bare', prodWork, prodBare);

  const staging = mk('staging');
  writeTree(staging, PACK_FILES);
  const reportPath = `${staging}.report.json`;
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({
      schema: 1,
      source_ref: 'HEAD',
      source_commit: DEV_SHA,
      classification_digest: CLASSIFICATION_DIGEST,
      staging_digest: STAGING_DIGEST,
      files_projected: Object.keys(PACK_FILES).length,
      files_omitted: { private: 0, generated: 0 },
      verdict: 'built',
      failures: [],
      verify: {
        gates: {
          install: { ok: true },
          lint: { ok: true },
          test: { ok: true },
          pack: { ok: true },
        },
        pack_shasum: shasum,
        baseline: null,
        verdict: 'passed',
      },
    })}\n`,
  );
  const proposed = promotion.propose('1.2.0', {
    cwd: proposeDev,
    staging,
    prodUrl: prodBare,
    gh: () => `https://github.com/${PROD_REPO}/pull/7\n`,
  });
  assertEqual(proposed.exit_code, 0, `propose ok (${JSON.stringify(proposed.failures || null)})`);
  const recordRel = '.verity/promotions/PROM-0001.yml';
  const proposedText = fs.readFileSync(path.join(proposeDev, recordRel), 'utf8');
  const manifestText = git(prodBare, 'show', 'promote/v1.2.0:RELEASE-MANIFEST.json');

  // -- finalize the SAME record against a merged prod ---------------------------
  const finalizeDev = mk('fdev');
  initRepo(finalizeDev);
  git(finalizeDev, 'remote', 'add', 'origin', DEV_URL);
  writeTree(finalizeDev, {
    'package.json': `${JSON.stringify({ name: 'widget-dev', version: '1.1.0' })}\n`,
    '.verity/promotion.json': promotionJson(['.github/**', 'RELEASE-MANIFEST.json']),
    [recordRel]: proposedText,
  });
  git(finalizeDev, 'add', '-A');
  git(finalizeDev, 'commit', '-q', '-m', 'dev fixture');

  const mergeWork = mk('mwork');
  git(mergeWork, 'init', '-q', '-b', 'main');
  git(mergeWork, 'config', 'user.email', 'test@example.invalid');
  git(mergeWork, 'config', 'user.name', 'Verity Test');
  git(mergeWork, 'config', 'commit.gpgsign', 'false');
  writeTree(mergeWork, {
    'README.md': 'prod baseline\n',
    '.github/workflows/ci.yml': 'name: ci\n',
  });
  git(mergeWork, 'add', '-A');
  git(mergeWork, 'commit', '-q', '-m', 'prod baseline');
  git(mergeWork, 'tag', 'v1.1.0');
  git(mergeWork, 'checkout', '-q', '-b', 'promote/v1.2.0');
  rm(path.join(mergeWork, 'README.md'));
  writeTree(mergeWork, { ...PACK_FILES, 'RELEASE-MANIFEST.json': manifestText });
  git(mergeWork, 'add', '-A');
  git(mergeWork, 'commit', '-q', '-m', 'Promote v1.2.0');
  git(mergeWork, 'checkout', '-q', 'main');
  git(mergeWork, 'merge', '-q', '--no-ff', '-m', 'Merge promotion PR', 'promote/v1.2.0');
  const mergeSha = git(mergeWork, 'rev-parse', 'HEAD').trim();
  const mergedBare = mk('mbare');
  fs.rmdirSync(mergedBare);
  git(path.dirname(mergedBare), 'clone', '-q', '--bare', mergeWork, mergedBare);

  const finalized = promotion.finalize('1.2.0', {
    cwd: finalizeDev,
    prodUrl: mergedBare,
    gh: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return `${JSON.stringify({ state: 'MERGED', mergeCommit: { oid: mergeSha } })}\n`;
      }
      if (args[0] === 'release' && args[1] === 'create') {
        return `https://github.com/${PROD_REPO}/releases/tag/${args[2]}\n`;
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
  });
  assertEqual(
    finalized.exit_code,
    0,
    `finalize ok (${JSON.stringify(finalized.failures || null)})`,
  );
  const finalizedText = fs.readFileSync(path.join(finalizeDev, recordRel), 'utf8');

  for (const d of dirs) {
    rm(d);
  }
  rm(reportPath);
  if (proposed.tree_dir) {
    rm(proposed.tree_dir);
  }
  return { proposedText, finalizedText, manifest: JSON.parse(manifestText) };
}
const records = proposeThenFinalize();

function pinRecordKeys(file) {
  const doc = documentedKeys(file);
  const problems = [];
  for (const [step, text] of [
    ['propose', records.proposedText],
    ['finalize', records.finalizedText],
  ]) {
    const paths = recordKeyPaths(text);
    const top = [...paths].filter((p) => !p.includes('.'));
    problems.push(...missing(`PROM record top-level key (${step})`, top, doc.yamlTopLevelKeys));
    problems.push(...missing(`PROM record key (${step})`, paths, doc.yamlKeyPaths));
  }
  problems.push(
    ...missing('RELEASE-MANIFEST key', Object.keys(records.manifest), doc.jsonTopLevelKeys),
    ...missing(
      'RELEASE-MANIFEST verify key',
      Object.keys(records.manifest.verify || {}),
      children(doc.jsonKeyPaths, 'verify'),
    ),
  );
  return problems;
}

test('promotion-records pin: record keys written at propose AND finalize ⊆ documented YAML keys (comment-stripped)', () => {
  assertEqual(statusOf(records.proposedText), 'proposed', 'propose wrote status proposed');
  assertEqual(statusOf(records.finalizedText), 'released', 'finalize wrote status released');
  const problems = pinRecordKeys(contract('promotion-records'));
  assertEqual(problems.length, 0, problems.join('; '));
});

function writtenStatuses() {
  const grepped = literals(src('promotion.cjs'), /['"`]status: ([a-z]+)['"`]/g);
  const observed = new Set([statusOf(records.proposedText), statusOf(records.finalizedText)]);
  return union(grepped, observed);
}

function documentedStatuses(file) {
  const text = fs.readFileSync(file, 'utf8');
  const yamlBlock = /```yaml\n([\s\S]*?)```/.exec(text);
  const line = yamlBlock ? /^status: (.*)$/m.exec(yamlBlock[1].replace(/#.*$/gm, '')) : null;
  return new Set(line ? line[1].split('|').map((s) => s.trim()) : []);
}

function pinStatuses(file) {
  const text = fs.readFileSync(file, 'utf8');
  const written = writtenStatuses();
  const documented = documentedStatuses(file);
  const problems = missing('PROM record status', written, documented);
  // Documented-but-never-written values must each be annotated reserved in a
  // paragraph of the contract that says "reserved".
  const reservedParas = text.split(/\n\s*\n/).filter((p) => /reserved/.test(p));
  for (const v of documented) {
    if (!written.has(v) && !reservedParas.some((p) => p.includes(`\`${v}\``))) {
      problems.push(
        `PROM record status: '${v}' is documented, never written, and not annotated reserved`,
      );
    }
  }
  return problems;
}

test('promotion-records pin: written statuses = {proposed, released}; promoted/abandoned documented-but-reserved', () => {
  const written = writtenStatuses();
  assertEqual(sorted(written).join(','), 'proposed,released', 'status values the engine writes');
  const documented = documentedStatuses(contract('promotion-records'));
  const reserved = sorted([...documented].filter((v) => !written.has(v)));
  assertEqual(reserved.join(','), 'abandoned,promoted', 'documented ∧ never written');
  const problems = pinStatuses(contract('promotion-records'));
  assertEqual(problems.length, 0, problems.join('; '));
});

// ================================================================================
// role-capability-policy — schema capability keys and every role's file
// ================================================================================

const SCHEMA_FILE = path.join(REPO_ROOT, 'schemas', 'role-permissions.schema.json');
const schemaCapabilities = () =>
  Object.keys(JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')).properties.capabilities.properties);

function pinCapabilities(file) {
  const doc = documentedKeys(file);
  return missing(
    'capability key',
    schemaCapabilities(),
    union(children(doc.jsonKeyPaths, 'capabilities'), doc.backtickedNames),
  );
}

test('role-capability-policy pin: schema capabilities ⊆ documented (json blocks ∪ backticked)', () => {
  assert(schemaCapabilities().includes('write_protected_paths'), 'schema carries the stage-9 key');
  const problems = pinCapabilities(contract('role-capability-policy'));
  assertEqual(problems.length, 0, problems.join('; '));
});

test('role-capability-policy pin: every commands/verity/*.permissions.json capability key ⊆ the schema', () => {
  const allowed = new Set(schemaCapabilities());
  const dir = path.join(REPO_ROOT, 'commands', 'verity');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.permissions.json'));
  assert(files.length > 0, 'role permission files exist');
  const problems = [];
  for (const f of files) {
    const caps = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).capabilities || {};
    problems.push(...missing(`${f} capability`, Object.keys(caps), allowed));
  }
  assertEqual(problems.length, 0, problems.join('; '));
});

// ================================================================================
// negative pins — each pin FAILS on a temp copy with one documented field removed
// ================================================================================

test('negative pin (agent-result): removing `intent_artifacts` fails the RESULT_KEYS pin', () => {
  assertNegative(pinAgentResultKeys, contract('agent-result'), 'intent_artifacts');
});

test('negative pin (agent-result): removing `artifacts.pr` fails the artifacts pin', () => {
  assertNegative(pinArtifactKeys, contract('agent-result'), 'artifacts.pr');
});

test('negative pin (agent-result): removing `no-op` fails the vocabulary/normalization pin', () => {
  assertNegative(pinVocabulary, contract('agent-result'), 'no-op');
});

test('negative pin (operator-act): removing `label-swap` fails the reserved-kind pin', () => {
  assertNegative(pinReservedKinds, contract('operator-act'), 'label-swap');
});

test('negative pin (operator-act): removing `worker-tick` fails the effect-kind pin', () => {
  assertNegative(pinEffectKinds, contract('operator-act'), 'worker-tick');
});

test('negative pin (operator-act): removing `exitCode` fails the worker-tick pin', () => {
  assertNegative(pinWorkerTick, contract('operator-act'), 'exitCode');
});

test('negative pin (production-projection): removing `pack_shasum` fails the verify-block pin', () => {
  assertNegative(pinProjection, contract('production-projection'), 'pack_shasum');
});

test('negative pin (promotion-records): removing `finalized_at` fails the record-key pin', () => {
  assertNegative(pinRecordKeys, contract('promotion-records'), 'finalized_at');
});

test('negative pin (promotion-records): removing `released` fails the status pin', () => {
  assertNegative(pinStatuses, contract('promotion-records'), 'released');
});

test('negative pin (role-capability-policy): removing `write_protected_paths` fails the capability pin', () => {
  assertNegative(pinCapabilities, contract('role-capability-policy'), 'write_protected_paths');
});

test('contract-doc: a contract whose own json example does not parse fails loud', () => {
  const dir = tmp('broken');
  try {
    const file = path.join(dir, 'broken.md');
    fs.writeFileSync(file, '# broken\n\n```json\n{ "schema": 1, }\n```\n');
    let err = null;
    try {
      documentedKeys(file);
    } catch (e) {
      err = e;
    }
    assert(err !== null && /json block #0 does not parse/.test(err.message), 'names the bad block');
  } finally {
    rm(dir);
  }
});
