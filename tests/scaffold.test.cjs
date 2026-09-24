const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../verity/bin/lib/identity.cjs');
const scaffold = require('../verity/bin/lib/scaffold.cjs');

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verity-scaf-'));
}

test('render replaces {{key}} but leaves GitHub ${{ }} expressions intact', () => {
  assertEqual(
    scaffold.render('a {{slug}} ${{ github.ref }}', { slug: 'x' }),
    'a x ${{ github.ref }}',
  );
});

test('init throws without a locked identity', () => {
  let failed = false;
  try {
    scaffold.init(fresh(), {});
  } catch (_e) {
    failed = true;
  }
  assert(failed, 'should require a locked identity manifest');
});

test('init scaffolds the governance + hygiene file set', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo App', slug: 'demo-app', owner: 'acme' });
  const r = scaffold.init(d, { description: 'A demo.' });
  const expected = [
    'README.md',
    'LICENSE',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    'STATUS.md',
  ];
  for (const f of expected) {
    assert(fs.existsSync(path.join(d, f)), `expected ${f} on disk`);
    assert(r.created.includes(f), `should report ${f} created`);
  }
});

test('emitted ci.yml is the honest hygiene gate with GH expressions intact', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo', slug: 'demo', owner: 'acme' });
  scaffold.init(d, {});
  const ci = fs.readFileSync(path.join(d, '.github/workflows/ci.yml'), 'utf8');
  assert(ci.includes('gitleaks'), 'should include the secret-scan');
  assert(ci.includes('structure'), 'should include the structure check');
  assert(ci.includes('${{ github.ref }}'), 'GH expressions must survive templating');
  // Stage 105 (#178): the structure job keeps its required-files loop AND gains
  // the tracked-artifacts step; every ${{ }} expression survives templating.
  assert(ci.includes('for f in README.md LICENSE; do'), 'the required-files loop is still there');
  assert(
    ci.includes('- name: Tracked build artifacts absent'),
    'the structure job has the tracked-artifacts step',
  );
  assert(ci.includes('git ls-files -z'), 'the step reads the index NUL-delimited');
  assert(
    ci.includes('${{ secrets.GITHUB_TOKEN }}'),
    'the gitleaks token expression survives templating',
  );
  const structure = ci.slice(ci.indexOf('  structure:'), ci.indexOf('  secret-scan:'));
  assert(
    structure.indexOf('Required files present') <
      structure.indexOf('Tracked build artifacts absent'),
    'the tracked-artifacts step runs after the required-files loop, inside the structure job',
  );
});

// Stage 105 (#178): today's .gitignore lines, verbatim. The template may only
// GROW; removing a line would change what existing projects were promised.
const GITIGNORE_V1_LINES = [
  'node_modules/',
  'dist/',
  '*.tgz',
  '.DS_Store',
  '.env',
  '.env.*',
  '!.env.*.example',
  "# Verity's derived state cache — never authoritative (framework-spec §5)",
  '.verity-cache/',
  '# Per-app deployment access (host + credential locations) — shared out-of-band,',
  '# never committed. The committed pointer (.verity/deploy-access.README.md) stays.',
  '.verity/deploy-access.md',
];

test('emitted .gitignore is stack-agnostic: one line per added stack section, a superset of v1', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo', slug: 'demo', owner: 'acme' });
  scaffold.init(d, {});
  const lines = fs.readFileSync(path.join(d, '.gitignore'), 'utf8').split('\n');
  for (const line of GITIGNORE_V1_LINES) {
    assert(lines.includes(line), `v1 .gitignore line kept: ${line}`);
  }
  // The #178 reproduction: a Python first PR committed __pycache__/*.pyc.
  for (const line of ['__pycache__/', '*.py[cod]']) {
    assert(lines.includes(line), `Python bytecode ignored: ${line}`);
  }
  // One line from each added section.
  for (const line of [
    '.venv/',
    'vendor/bundle/',
    '*.test',
    'target/',
    '.gradle/',
    '*.user',
    'coverage/',
  ]) {
    assert(lines.includes(line), `stack section present: ${line}`);
  }
  // Left to the project on purpose (a docs site's build/, a tracked bin/).
  for (const line of ['bin/', 'obj/', 'build/']) {
    assert(!lines.includes(line), `${line} is NOT ignored (a project may track it)`);
  }
});

// Pull a step's `run: |` block out of the rendered workflow text and dedent it,
// so the test executes exactly the shell CI will run.
function stepRunBody(yml, stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert(at !== -1, `step '${stepName}' found`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  assert(runAt === at + 1, `step '${stepName}' has a run: | block`);
  const keyIndent = lines[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= keyIndent) {
      break;
    }
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return `${body.map((l) => l.slice(indent)).join('\n')}\n`;
}

function gitRepo(files) {
  const d = fresh();
  const git = (...args) => execFileSync('git', args, { cwd: d, stdio: 'pipe' });
  git('init', '--quiet');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), 'x');
  }
  // -f: the check must catch tracked bytecode REGARDLESS of ignore coverage.
  git('add', '-f', '--', ...files);
  return d;
}

test('structure step: tracked __pycache__ bytecode fails with the path printed; a clean tree passes', () => {
  const d = fresh();
  identity.lock(d, { name: 'Demo', slug: 'demo', owner: 'acme' });
  scaffold.init(d, {});
  const body = stepRunBody(
    fs.readFileSync(path.join(d, '.github/workflows/ci.yml'), 'utf8'),
    'Tracked build artifacts absent',
  );
  // POSIX sh (dash here, as on ubuntu) AND GitHub's default `bash -e`.
  for (const [shell, args] of [
    ['sh', ['-c', body]],
    ['bash', ['-e', '-c', body]],
  ]) {
    const dirty = gitRepo(['README.md', 'x/__pycache__/a.pyc', 'weird name/b.class']);
    const bad = spawnSync(shell, args, { cwd: dirty, encoding: 'utf8' });
    assertEqual(bad.status, 1, `${shell}: tracked bytecode exits 1`);
    assert(bad.stdout.includes('x/__pycache__/a.pyc'), `${shell}: the .pyc path is printed`);
    assert(bad.stdout.includes('weird name/b.class'), `${shell}: a spaced path is printed raw`);
    assert(!bad.stdout.includes('structure ok'), `${shell}: no ok line on failure`);

    // Anchored patterns: an Eclipse .classpath, a docs build/ and a tracked bin/
    // are legitimate and must NOT trip the check.
    const clean = gitRepo(['README.md', '.classpath', 'docs/build/index.html', 'bin/run']);
    const good = spawnSync(shell, args, { cwd: clean, encoding: 'utf8' });
    assertEqual(good.status, 0, `${shell}: a clean tree exits 0 (${good.stdout}${good.stderr})`);
    assert(good.stdout.includes('structure ok'), `${shell}: prints structure ok`);
  }
});

test('interpolates the manifest into README', () => {
  const d = fresh();
  identity.lock(d, { name: 'Cool Thing', slug: 'cool-thing', owner: 'acme' });
  scaffold.init(d, { description: 'Does cool stuff.' });
  const readme = fs.readFileSync(path.join(d, 'README.md'), 'utf8');
  assert(readme.includes('Cool Thing'), 'name interpolated');
  assert(readme.includes('Does cool stuff.'), 'description interpolated');
  assert(readme.includes('cool-thing'), 'slug interpolated');
});

test('init is idempotent — second run skips existing files', () => {
  const d = fresh();
  identity.lock(d, { name: 'X', slug: 'x-app', owner: 'a' });
  scaffold.init(d, {});
  const r2 = scaffold.init(d, {});
  assert(r2.skipped.length > 0, 'second run should skip existing files');
  assertEqual(r2.created.length, 0, 'nothing new created on the second run');
  // Stage 105: existing repos keep their .gitignore / ci.yml (new stack
  // sections + the artifacts step reach NEW projects only, absent --force).
  assert(r2.skipped.includes('.gitignore'), 'an existing .gitignore is skipped');
  assert(r2.skipped.includes('.github/workflows/ci.yml'), 'an existing ci.yml is skipped');
});
