// `verity init` — non-interactive project bootstrap (stage 113, ADR-0038,
// contract operator-init v1 incl. its 2026-09-29 additive amendment).
//
// A deterministic composition of EXISTING engine operations in the contract's
// fixed step order:
//   preflight → identity → scaffold → spec → gates → policy → git → remote →
//   labels → intake → register
// It dispatches no role, spends no model tokens and never starts the worker
// (invariant 2). Verity performs every effect (ADR-0012/0013).
//
// Invariants this module is built around (contracts/operator-init.md):
//   1. Refuse before effect — preflight is pure (reads only: fs stat/read,
//      `git rev-parse`, `git config --get`, `gh auth status`); a refusal leaves
//      NOTHING on disk, in git or on GitHub. outcome "refused", exit 2.
//   4. Honest partial state — steps that RAN are listed in table order; the
//      first ok:false ends the list; later steps are absent; every field the
//      run did not establish is null. outcome "failed", exit 1.
//   5. No ambiguous re-issue — `gh repo create` / `gh issue create` go through
//      gh.run with `idempotent:false` (stage 112): an ambiguous failure is read
//      back (`gh repo view` / the verity:request list), never re-issued.
//   6. Inert by default — the intake carries `verity:circuit-open` unless
//      `--start`; the starter policy is supervised, trust 0.
//   7. The register (`.verity/intake.json`) is committed AND pushed before ok.
//   9. Secrets never appear — the whole result passes the engine redactor.
//
// Dark by construction: a new top-level verb nobody invokes. No existing verb,
// the worker, the scanner or `benchmark provision` calls into this module.
//
// Injectable seams (so the suite drives it with zero network, the benchmark
// `defaultSpawn`/`provision` pattern): `spawn(cmd, args, options)` returning a
// spawnSync-shaped result, `now`, `cwd`, `env`, `sleep`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('./core.cjs');
const identity = require('./identity.cjs');
const scaffold = require('./scaffold.cjs');
const gates = require('./gates.cjs');
const autonomy = require('./autonomy.cjs');
const gh = require('./gh.cjs');
const ledger = require('./ledger.cjs');
const engineMeta = require('./engine-meta.cjs');
const substrateLocal = require('./substrate-local.cjs');
const intake = require('./intake.cjs');
const usage = require('./usage.cjs');
const { LABELS, ensureLabels } = require('./labels.cjs');

const SCHEMA = 1;

// The contract's fixed step vocabulary, in table order.
const STEPS = [
  'preflight',
  'identity',
  'scaffold',
  'spec',
  'gates',
  'policy',
  'git',
  'remote',
  'labels',
  'intake',
  'register',
];

// Sourced from the shared label vocabulary, never hardcoded (a rename can never
// silently unseat the intake or the breaker).
const REQUEST_LABEL = LABELS.find((l) => l.name === 'verity:request').name;
const CIRCUIT_LABEL = LABELS.find((l) => l.name === 'verity:circuit-open').name;

const DEFAULT_BRANCH = 'main';
const SPEC_REL = 'docs/spec.md';
const REGISTER_REL = path.join('.verity', 'intake.json');
const POLICY_REL = '.verity/autonomy.yml';
const FILED_BY = 'verity init';
const INITIAL_COMMIT_MESSAGE = 'chore(verity): initial scaffold + spec (verity init)';
const TITLE_MAX = 200;
// A GitHub owner: alphanumerics and single interior hyphens, never a leading
// or trailing hyphen (so `-x` / `--` can never read as a flag), max 39.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// Free text that reaches a scaffolded file (the run-gates.cjs / ci.yml header
// comment, README, STATUS), a commit message or an issue title must be ONE
// line of printable text: a C0/C1 control character (\p{Cc}: \n, \r, \x85,
// ESC, …) or U+2028/U+2029 (line terminators to JavaScript) would let the
// input break out of the template's comment line and inject code — e.g. a
// `process.exit(0)` that turns the fail-loud gate runner into a fabricated
// green (security invariant §4).
const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;
// The spec is read with a hard cap, from a regular file only (a FIFO or a
// device such as /dev/zero would block or never end).
const SPEC_MAX_BYTES = 1024 * 1024;

// Bounded child processes: a git/gh call that hangs (a credential prompt, a
// dead network) must not hang init. `gh repo create --push` uploads the
// initial commit, so it gets a longer deadline than a read.
const STEP_TIMEOUT_MS = 120_000;
const GH_WRITE_TIMEOUT_MS = 300_000;

// The refusal vocabulary. Each refusal's detail starts with its token, so a
// consumer can key on it: `preflight: path-not-empty — …`.
const REFUSALS = [
  'invalid-path',
  'unknown-flag',
  'identity-exists',
  'path-not-empty',
  'inside-work-tree',
  'spec-unreadable',
  'invalid-name',
  'invalid-slug',
  'invalid-owner',
  'invalid-substrate',
  'visibility-conflict',
  'invalid-gate',
  'git-identity',
  'gh-auth',
];

// The starter policy (invariant 6 / ADR-0038 D5). `commit_intent_artifacts`
// and `reconcile_work_items` are pinned `true` (contract note 2026-09-29, stage
// 114 amendment item 0): plan is a git_write:false role, so without ADR-0033's
// engine commit its stage files stay uncommitted and reach main only if a later
// build's `git add -A` sweeps them in (fixture A); without ADR-0026's reconcile
// no `[stage N]` work items exist for `operator work`. Both keys are written
// explicitly so the operator sees the knobs. Trust is never raised by init.
function starterPolicy(substrate) {
  return {
    mode: 'supervised',
    review: { trust: 0 },
    agent: { commit_intent_artifacts: true, reconcile_work_items: true },
    limits: { unknown_cost_behavior: 'allow_with_token_limit' },
    substrate,
  };
}

// --- spawn plumbing ----------------------------------------------------------

function defaultSpawn(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    ...options,
    env: { ...(options.env || process.env), GIT_TERMINAL_PROMPT: '0' },
  });
}

function ok(res) {
  return Boolean(res) && res.error == null && (res.status === 0 || res.status === undefined);
}

// Every non-empty line of a failure's output, collapsed to one line (a git
// rejection's reason and hints follow its first `To …` line), capped. The
// whole result is redacted before it leaves `run`.
const DETAIL_MAX = 1000;
function oneLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ')
    .slice(0, DETAIL_MAX);
}

function failDetail(res) {
  if (!res) {
    return 'no result';
  }
  const raw = res.stderr || res.stdout || res.error?.message || `exit ${res.status}`;
  return oneLine(raw);
}

// gh.run's exec seam, built on the injected spawn: success → stdout; failure →
// an error shaped like execFileSync's (status/stderr/code/signal), so gh.run's
// stage-112 classifier (ambiguous vs pre-connect vs definitive) runs for real.
function ghExecFrom(spawn, env) {
  return (args, o) => {
    const res = spawn('gh', args, {
      cwd: o.cwd,
      encoding: 'utf8',
      input: o.input,
      timeout: o.timeoutMs,
      killSignal: 'SIGTERM',
      env,
    });
    if (ok(res)) {
      return String(res.stdout ?? '');
    }
    const stderr = String(res?.stderr ?? '');
    const err = new Error(
      res?.error ? res.error.message : `Command failed: gh ${args.join(' ')}\n${stderr}`,
    );
    err.status = typeof res?.status === 'number' ? res.status : null;
    err.stderr = stderr;
    err.stdout = String(res?.stdout ?? '');
    if (res?.error?.code) {
      err.code = res.error.code;
    }
    if (res?.signal) {
      err.signal = res.signal;
    }
    throw err;
  };
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .find((l) => l.trim() !== '') || ''
  );
}

// --- argv -------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['private', 'public', 'start', 'json', 'raw']);
const VALUE_FLAGS = new Set(['spec', 'name', 'owner', 'slug', 'substrate', 'gate', 'cwd']);

// Strict parse of the raw argv (the CLI dispatcher's generic parser cannot
// carry a repeatable `--gate` and would read `--start <path>` as a value).
// The first positional is the noun (`init`) and is dropped. Unknown flags are
// recorded, never ignored — there is no `--force` (invariant 8).
function parseArgv(argv) {
  const positional = [];
  const opts = { gates: [] };
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (!a.startsWith('--') || a === '--') {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS.has(key) && eq === -1) {
      opts[key] = true;
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      let value;
      if (eq !== -1) {
        value = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
        i += 1;
        value = String(argv[i]);
      } else {
        value = '';
      }
      if (key === 'gate') {
        opts.gates.push(value);
      } else {
        opts[key] = value;
      }
      continue;
    }
    unknown.push(a);
  }
  positional.shift(); // the noun
  return { positional, opts, unknown };
}

// --- spec reading ----------------------------------------------------------

// The description string: first Markdown heading, else first non-empty line,
// trimmed to 200 characters (contract §Schema `spec.title`).
function specTitle(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m && m[1].trim() !== '') {
      return m[1].trim().slice(0, TITLE_MAX).trim();
    }
  }
  const first = lines.find((l) => l.trim() !== '');
  return (first || '').trim().slice(0, TITLE_MAX).trim();
}

// --- preflight (pure: reads only) --------------------------------------------

function refusal(code, sentence) {
  return { code, detail: `${code} — ${sentence}` };
}

// Nearest existing ancestor of `p` (for the reads that need a real cwd).
function nearestExisting(p) {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      return cur;
    }
    cur = parent;
  }
  return cur;
}

function isEmptyDir(p) {
  return fs.readdirSync(p).length === 0;
}

// A literal leading `~` / `~/` (a Console form passes argv unexpanded; a shell
// would have expanded it) means the operator's home — never a directory named
// `~` under the cwd.
function expandHome(p, env) {
  if (p === '~' || p.startsWith('~/')) {
    const home = env.HOME || os.homedir();
    return p === '~' ? home : path.join(home, p.slice(2));
  }
  return p;
}

// A printable description of a control character for a refusal detail (the
// character itself is never echoed).
function controlChar(text) {
  const m = String(text).match(CONTROL_RE);
  if (!m) {
    return null;
  }
  return `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function fileKind(st) {
  if (st.isDirectory()) {
    return 'a directory';
  }
  if (st.isFIFO()) {
    return 'a FIFO';
  }
  if (st.isCharacterDevice()) {
    return 'a character device';
  }
  if (st.isBlockDevice()) {
    return 'a block device';
  }
  if (st.isSocket()) {
    return 'a socket';
  }
  return 'not a regular file';
}

// Read the spec without ever blocking or reading unbounded: the TARGET's type
// is checked with stat (symlinks are followed deliberately — a symlinked spec
// is fine, a symlink to a FIFO/device is not) BEFORE any open; the open is
// non-blocking (a FIFO swapped in after the stat cannot hang it) and the fd is
// re-checked; at most SPEC_MAX_BYTES + 1 bytes are ever read.
// Returns { bytes } or { problem }.
function readSpecBounded(specAbs) {
  let st;
  try {
    st = fs.statSync(specAbs);
  } catch (err) {
    return { problem: `cannot read ${specAbs}: ${err.code || err.message}` };
  }
  const tooBig = (n) =>
    `${specAbs} is ${n} bytes, over the ${SPEC_MAX_BYTES}-byte (1 MiB) spec cap`;
  if (!st.isFile()) {
    return { problem: `${specAbs} is ${fileKind(st)}, not a regular file` };
  }
  if (st.size > SPEC_MAX_BYTES) {
    return { problem: tooBig(st.size) };
  }
  let fd;
  try {
    fd = fs.openSync(specAbs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    return { problem: `cannot read ${specAbs}: ${err.code || err.message}` };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) {
      return { problem: `${specAbs} is ${fileKind(fst)}, not a regular file` };
    }
    const buf = Buffer.alloc(SPEC_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) {
        break;
      }
      total += n;
    }
    if (total > SPEC_MAX_BYTES) {
      return { problem: tooBig(`over ${SPEC_MAX_BYTES}`) };
    }
    return { bytes: Buffer.from(buf.subarray(0, total)) };
  } catch (err) {
    return { problem: `cannot read ${specAbs}: ${err.code || err.message}` };
  } finally {
    fs.closeSync(fd);
  }
}

// Secret-bearing spec: a line matching a credential SHAPE from promotion.cjs
// SECRET_PATTERNS (the list the production secret-scan enforces, security
// invariant §3). The spec is committed, pushed and its first line becomes a
// README line and an issue title — none of which a later `--private` or
// redaction can take back — so it is refused before any effect. Shapes only:
// ledger.redact's keyword rules (a line mentioning "token"/"authorization"/
// "bearer") and its 40-hex rule (commit SHAs) would refuse ordinary specs.
// Lazy require, as ledger.cjs does, to stay clear of the promotion import
// cycle. Returns the offending line numbers (never the text) or null.
function secretLines(text) {
  const patterns = require('./promotion.cjs').SECRET_PATTERNS;
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (patterns.some((p) => p.re.test(line))) {
        hits.push(i + 1);
      }
    });
  return hits.length === 0 ? null : hits;
}

// The #303 state-mixing check, fail CLOSED: only git's own "not a git
// repository" answer proves `probe` is outside every work tree. Inside a work
// tree, inside a .git / bare repository ("false"), a git error of any other
// kind (dubious ownership, a missing git, a timeout) or GIT_DIR/GIT_WORK_TREE
// in the environment (every later git call would act on THAT repository) all
// refuse. Returns a sentence or null.
function workTreeProblem(spawn, probe, env, abs) {
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE']) {
    if (env[k]) {
      return `${k} is set in the environment — every git step would act on that repository instead of ${abs}; unset it`;
    }
  }
  // C locale: the one answer that proves "outside" is matched by its text, so
  // a translated git must not turn every run into a refusal.
  const inside = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: probe,
    env: { ...env, LC_ALL: 'C', LANGUAGE: 'C' },
    encoding: 'utf8',
  });
  if (ok(inside)) {
    const out = String(inside.stdout ?? '').trim();
    return out === 'true'
      ? `${abs} is inside an existing git work tree (${probe}) — an embedded repo would mix state`
      : `${abs} is inside a git directory or bare repository (${probe}) — an embedded repo would mix state`;
  }
  const why = failDetail(inside);
  if (inside && inside.error == null && /not a git repository/i.test(String(inside.stderr ?? ''))) {
    return null;
  }
  return `could not prove ${abs} is outside every git work tree (git rev-parse at ${probe}: ${why}) — refusing rather than risk an embedded repo`;
}

function gitConfigValue(spawn, cwd, env, key) {
  const res = spawn('git', ['config', '--get', key], { cwd, env, encoding: 'utf8' });
  return ok(res) ? String(res.stdout ?? '').trim() : '';
}

// Resolvable commit identity (amendment b): each of author/committer
// name/email from its env var or the git config (global/system — the checked
// directory is outside any work tree by the time this runs).
function gitIdentityProblem(spawn, cwd, env) {
  const configName = gitConfigValue(spawn, cwd, env, 'user.name');
  const configEmail = gitConfigValue(spawn, cwd, env, 'user.email');
  const missing = [];
  for (const [who, envName, envEmail] of [
    ['author', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'],
    ['committer', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'],
  ]) {
    if (!(env[envName] || configName)) {
      missing.push(`${who} name`);
    }
    if (!(env[envEmail] || configEmail)) {
      missing.push(`${who} email`);
    }
  }
  return missing.length === 0 ? null : missing.join(', ');
}

// Every contract check, in order; first failure wins. Returns
// { refused: {code, detail} } or { ok: plan } where plan carries the resolved
// inputs every later step uses.
function preflight(input, ctx) {
  const { spawn, env, baseCwd } = ctx;
  if (Array.isArray(input.unknown) && input.unknown.length > 0) {
    return {
      refused: refusal(
        'unknown-flag',
        `unknown flag(s): ${input.unknown.join(' ')} (there is no --force; see contracts/operator-init.md)`,
      ),
    };
  }
  const rawPath = input.path;
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { refused: refusal('invalid-path', 'a target <path> is required') };
  }
  if (Array.isArray(input.extra) && input.extra.length > 0) {
    return {
      refused: refusal(
        'invalid-path',
        `exactly one <path> is accepted (extra: ${input.extra.join(' ')})`,
      ),
    };
  }
  if (URL_RE.test(rawPath)) {
    return {
      refused: refusal('invalid-path', `<path> must be a local directory, not a URL: ${rawPath}`),
    };
  }
  const pathCc = controlChar(rawPath);
  if (pathCc !== null) {
    return {
      refused: refusal('invalid-path', `<path> contains a control character (${pathCc})`),
    };
  }
  const abs = path.resolve(baseCwd, expandHome(rawPath, env));
  const exists = fs.existsSync(abs);
  if (exists && !fs.statSync(abs).isDirectory()) {
    return { refused: refusal('invalid-path', `${abs} exists and is not a directory`), abs };
  }
  // identity-exists is checked before path-not-empty: an existing identity
  // implies a non-empty path, and naming the more specific condition ("this
  // is already a Verity project") is the more useful refusal on a re-run.
  if (fs.existsSync(identity.manifestPath(abs))) {
    return {
      refused: refusal('identity-exists', `${identity.manifestPath(abs)} already exists`),
      abs,
    };
  }
  if (exists && !isEmptyDir(abs)) {
    return { refused: refusal('path-not-empty', `${abs} exists and is not empty`), abs };
  }
  // The #303 state-mixing trap: <path> (or its nearest existing ancestor)
  // inside an existing git work tree.
  const probe = exists ? abs : nearestExisting(path.dirname(abs));
  const treeProblem = workTreeProblem(spawn, probe, env, abs);
  if (treeProblem !== null) {
    return { refused: refusal('inside-work-tree', treeProblem), abs };
  }
  // --spec: a local, readable, non-empty file.
  const specRaw = input.spec;
  if (typeof specRaw !== 'string' || specRaw === '') {
    return { refused: refusal('spec-unreadable', '--spec <file> is required'), abs };
  }
  if (URL_RE.test(specRaw)) {
    return {
      refused: refusal('spec-unreadable', `--spec must be a local file, not a URL: ${specRaw}`),
      abs,
    };
  }
  const specAbs = path.resolve(baseCwd, expandHome(specRaw, env));
  const read = readSpecBounded(specAbs);
  if (read.problem) {
    return { refused: refusal('spec-unreadable', read.problem), abs };
  }
  const specBytes = read.bytes;
  const specText = specBytes.toString('utf8');
  if (specText.trim() === '') {
    return { refused: refusal('spec-unreadable', `${specAbs} is empty`), abs };
  }
  const secrets = secretLines(specText);
  if (secrets !== null) {
    const where =
      secrets.length > 0 ? `line(s) ${secrets.slice(0, 10).join(', ')}` : 'a multi-line match';
    return {
      refused: refusal(
        'spec-unreadable',
        `${specAbs} carries a credential-shaped string (${where}; the production secret-scan patterns) — init never commits, pushes or files it; remove it and re-run`,
      ),
      abs,
    };
  }
  const title = specTitle(specText);
  const titleCc = controlChar(title);
  if (titleCc !== null) {
    return {
      refused: refusal(
        'spec-unreadable',
        `the spec's title line (its first heading, else first line) contains a control character (${titleCc}) — it would reach the README and the intake title`,
      ),
      abs,
    };
  }
  // name / slug / owner — the SAME slug check `identity lock` runs.
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    return { refused: refusal('invalid-name', '--name <name> must be non-empty'), abs };
  }
  const nameCc = controlChar(name);
  if (nameCc !== null) {
    return {
      refused: refusal(
        'invalid-name',
        `--name must be one line of printable text (it contains ${nameCc}; it reaches scaffolded files)`,
      ),
      abs,
    };
  }
  // Contract invariant 9 — no credential is written to the tree. The name
  // lands in README, STATUS, ci.yml, run-gates.cjs and identity.json, all
  // committed and pushed, so a credential-shaped name is refused (never echoed).
  if (secretLines(name) !== null) {
    return {
      refused: refusal(
        'invalid-name',
        '--name carries a credential-shaped string (the production secret-scan patterns) — it would be committed and pushed; init never writes a credential to the tree',
      ),
      abs,
    };
  }
  const slug =
    typeof input.slug === 'string' && input.slug !== '' ? input.slug : core.generateSlug(name);
  const slugCheck = core.validateSlug(slug);
  if (!slugCheck.valid) {
    return {
      refused: refusal('invalid-slug', `invalid slug "${slug}": ${slugCheck.issues.join('; ')}`),
      abs,
    };
  }
  const owner = typeof input.owner === 'string' ? input.owner : '';
  if (!OWNER_RE.test(owner)) {
    return {
      refused: refusal(
        'invalid-owner',
        `--owner must be a GitHub owner — letters, digits and single interior hyphens, at most 39 (got "${owner}")`,
      ),
      abs,
    };
  }
  const substrate =
    input.substrate === undefined || input.substrate === null ? 'github' : input.substrate;
  if (substrate !== 'github' && substrate !== 'local') {
    return {
      refused: refusal(
        'invalid-substrate',
        `--substrate must be github|local (got "${substrate}")`,
      ),
      abs,
    };
  }
  // local: the bare origin sibling `provisionBareOrigin` will create must not
  // exist in ANY form (a stale origin from an earlier run, an unrelated
  // directory, a file, a dangling symlink) — otherwise `remote` would fail
  // after six steps with effects, or write a bare repo into someone's files.
  if (substrate === 'local') {
    const originPath = path.join(path.dirname(abs), `${path.basename(abs)}-origin.git`);
    let originExists = true;
    try {
      fs.lstatSync(originPath);
    } catch {
      originExists = false;
    }
    if (originExists) {
      return {
        refused: refusal(
          'path-not-empty',
          `${originPath} (the local substrate's bare origin for ${abs}) already exists — init creates it and never reuses or writes into an existing path`,
        ),
        abs,
      };
    }
  }
  if (input.private === true && input.public === true) {
    return {
      refused: refusal('visibility-conflict', '--private and --public are mutually exclusive'),
      abs,
    };
  }
  const gateDefs = [];
  for (const g of input.gates || []) {
    const s = String(g);
    const eq = s.indexOf('=');
    const gname = eq === -1 ? '' : s.slice(0, eq).trim();
    const command = eq === -1 ? '' : s.slice(eq + 1).trim();
    if (gname === '' || command === '') {
      return {
        refused: refusal('invalid-gate', `--gate must be <name>=<command> (got "${s}")`),
        abs,
      };
    }
    const gateCc = controlChar(s);
    if (gateCc !== null) {
      return {
        refused: refusal('invalid-gate', `--gate must be one line (it contains ${gateCc})`),
        abs,
      };
    }
    // Contract invariant 9: gates.json is committed and pushed, so a literal
    // credential in a gate command is refused (never echoed). A gate that
    // REFERENCES a credential through the environment (`$GH_TOKEN`) is fine.
    if (secretLines(s) !== null) {
      return {
        refused: refusal(
          'invalid-gate',
          `--gate #${gateDefs.length + 1} carries a credential-shaped string (the production secret-scan patterns) — gates.json is committed and pushed; reference the credential through an environment variable instead`,
        ),
        abs,
      };
    }
    gateDefs.push({ name: gname, command });
  }
  const identityProblem = gitIdentityProblem(spawn, probe, env);
  if (identityProblem !== null) {
    return {
      refused: refusal(
        'git-identity',
        `no resolvable git ${identityProblem} for the initial commit (set git config user.name/user.email)`,
      ),
      abs,
    };
  }
  if (substrate === 'github') {
    const auth = spawn('gh', ['auth', 'status'], { cwd: probe, env, encoding: 'utf8' });
    if (!ok(auth)) {
      return {
        refused: refusal('gh-auth', `gh auth status failed: ${failDetail(auth)}`),
        abs,
      };
    }
  }
  return {
    ok: {
      abs,
      specBytes,
      title,
      name,
      slug,
      owner,
      substrate,
      visibility: input.public === true ? 'public' : 'private',
      start: input.start === true,
      gates: gateDefs,
    },
  };
}

// --- result ----------------------------------------------------------------

function redactDeep(value) {
  if (typeof value === 'string') {
    return ledger.redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

function emptyResult(abs) {
  return {
    schema: SCHEMA,
    ok: false,
    outcome: null,
    path: abs ?? null,
    identity: null,
    substrate: null,
    repo: null,
    remote: null,
    default_branch: null,
    spec: null,
    intake: null,
    policy: null,
    steps: [],
    reason: null,
  };
}

function exitCodeFor(result) {
  if (result?.outcome === 'ok') {
    return 0;
  }
  if (result?.outcome === 'refused') {
    return 2;
  }
  return 1;
}

// --- git helpers -------------------------------------------------------------

function gitIn(spawn, cwd, env, args, extra = {}) {
  return spawn('git', args, { cwd, env, encoding: 'utf8', ...extra });
}

function gitOrThrow(spawn, cwd, env, args) {
  const res = gitIn(spawn, cwd, env, args);
  if (!ok(res)) {
    throw new Error(`git ${args.join(' ')} failed: ${failDetail(res)}`);
  }
  return String(res.stdout ?? '').trim();
}

// --- run ---------------------------------------------------------------------

// Pure-composable entry. `opts` carries the parsed inputs (path, spec, name,
// owner, slug, substrate, private, public, start, gates[], unknown[], extra[])
// plus the seams (spawn, now, cwd, env, sleep). Never throws: every failure is
// a result.
function run(opts = {}) {
  const spawn = opts.spawn || defaultSpawn;
  const env = opts.env || process.env;
  const baseCwd = opts.cwd || process.cwd();
  const nowFn =
    typeof opts.now === 'function'
      ? opts.now
      : opts.now instanceof Date
        ? () => opts.now
        : () => new Date();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : undefined;

  let pre;
  try {
    pre = preflight(opts, { spawn, env, baseCwd });
  } catch (err) {
    pre = {
      refused: refusal('invalid-path', `preflight could not read its inputs: ${err.message}`),
    };
  }
  if (pre.refused) {
    const result = emptyResult(pre.abs);
    result.outcome = 'refused';
    result.steps.push({ step: 'preflight', ok: false, detail: pre.refused.detail });
    result.reason = `preflight: ${pre.refused.detail}`;
    return redactDeep(result);
  }

  const plan = pre.ok;
  const abs = plan.abs;
  const result = emptyResult(abs);
  result.substrate = plan.substrate;
  result.steps.push({ step: 'preflight', ok: true });
  const github = plan.substrate === 'github';
  const repo = `${plan.owner}/${plan.slug}`;
  const ghExec = ghExecFrom(spawn, env);
  const ghOpts = (extra = {}) => ({
    cwd: abs,
    exec: ghExec,
    ...(sleep ? { sleep } : {}),
    ...extra,
  });

  const state = { specCommit: null, intakeNumber: null, intakeLabels: null };

  // Each step: returns an optional { detail, skipped, confirmed_by } on
  // success, throws on failure. The first failure ends the run.
  const steps = [
    [
      'identity',
      () => {
        fs.mkdirSync(abs, { recursive: true });
        identity.lock(abs, { name: plan.name, slug: plan.slug, owner: plan.owner });
        result.identity = { name: plan.name, slug: plan.slug, owner: plan.owner };
      },
    ],
    [
      'scaffold',
      () => {
        scaffold.init(abs, { description: plan.title });
      },
    ],
    [
      'spec',
      () => {
        const dest = path.join(abs, SPEC_REL);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, plan.specBytes);
        result.spec = { path: SPEC_REL, commit: null, title: plan.title };
      },
    ],
    [
      'gates',
      () => {
        if (plan.gates.length === 0) {
          return {
            skipped: true,
            detail:
              'no gate definition written — the walking-skeleton stage defines .verity/gates.json with the stack (scaffold.cjs:22-29, ADR-0028)',
          };
        }
        const file = path.join(abs, gates.GATES_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          `${JSON.stringify({ schema: 1, gates: plan.gates.map((g) => ({ name: g.name, command: g.command })) }, null, 2)}\n`,
        );
        // The engine's own reader must accept what was written (fail closed).
        gates.readGateDefinition(abs);
        return { detail: `${plan.gates.length} gate(s) from --gate` };
      },
    ],
    [
      'policy',
      () => {
        const file = path.join(abs, POLICY_REL);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${autonomy.toYaml(starterPolicy(plan.substrate))}\n`);
        // The engine's own policy validation must accept it (throws PolicyError).
        const loaded = autonomy.loadPolicy(abs);
        if (
          loaded.mode !== 'supervised' ||
          loaded.review?.trust !== 0 ||
          loaded.substrate !== plan.substrate
        ) {
          throw new Error('the written starter policy did not load as supervised / trust 0');
        }
        result.policy = {
          path: POLICY_REL,
          mode: loaded.mode,
          trust: loaded.review.trust,
          circuit_open: null,
        };
      },
    ],
    [
      'git',
      () => {
        const init = gitIn(spawn, abs, env, ['init', '-b', DEFAULT_BRANCH]);
        if (!ok(init)) {
          // Old git without `init -b`: plain init, then point HEAD at main.
          gitOrThrow(spawn, abs, env, ['init']);
          gitOrThrow(spawn, abs, env, ['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`]);
        }
        gitOrThrow(spawn, abs, env, ['add', '-A']);
        gitOrThrow(spawn, abs, env, ['commit', '-q', '-m', INITIAL_COMMIT_MESSAGE]);
        state.specCommit = gitOrThrow(spawn, abs, env, ['rev-parse', '--short', 'HEAD']);
        result.default_branch = DEFAULT_BRANCH;
        result.spec = { ...result.spec, commit: state.specCommit };
        return { detail: `initial commit ${state.specCommit}` };
      },
    ],
    ['remote', () => (github ? remoteGithub() : remoteLocal())],
    [
      'labels',
      () => {
        if (!github) {
          return { skipped: true };
        }
        const labelRun = (largs, cwd) =>
          gh.run(['label', ...largs], ghOpts({ cwd, idempotent: largs[0] !== 'create' }));
        const res = ensureLabels(abs, labelRun, {
          substrate: 'github',
          ...(sleep ? { sleep } : {}),
        });
        if (res && res.ok === false) {
          const why = res.error || res.failed?.[0]?.error || 'unknown error';
          throw new Error(`could not ensure the Verity labels on ${repo}: ${why}`);
        }
      },
    ],
    ['intake', () => (github ? intakeGithub() : intakeLocal())],
    ['register', () => register()],
  ];

  function remoteGithub() {
    const args = ['repo', 'create', repo, '--source=.', '--push', `--${plan.visibility}`];
    let confirmedBy;
    // The repository exists from the moment the create succeeds (or is
    // confirmed by read-back): report it even if the wiring below fails, so a
    // consumer can see what exists (invariant 4).
    const established = () => {
      result.repo = repo;
      result.remote = `https://github.com/${repo}`;
    };
    try {
      gh.run(args, ghOpts({ idempotent: false, timeoutMs: GH_WRITE_TIMEOUT_MS }));
      established();
    } catch (err) {
      if (!err?.ambiguous) {
        throw new Error(`gh repo create failed: ${err?.message || err}`);
      }
      // Ambiguous (timeout / reset / 5xx): the repo may exist. Read back, never
      // re-issue the create (stage 112).
      try {
        gh.run(['repo', 'view', repo, '--json', 'name'], ghOpts());
      } catch (viewErr) {
        throw new Error(
          `gh repo create failed ambiguously (${err.message}) and ${repo} could not be confirmed by gh repo view (${viewErr?.message || viewErr}) — not re-issued`,
        );
      }
      confirmedBy = 'repo-view';
      established();
      // The create landed but its remote wiring / push may not have: finish
      // them idempotently (a second push of the same commit is a no-op).
      const remotes = gitIn(spawn, abs, env, ['remote']);
      const hasOrigin =
        ok(remotes) &&
        String(remotes.stdout ?? '')
          .split('\n')
          .some((l) => l.trim() === 'origin');
      if (!hasOrigin) {
        gitOrThrow(spawn, abs, env, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      }
      gitOrThrow(spawn, abs, env, ['push', '--quiet', 'origin', DEFAULT_BRANCH]);
    }
    // Stage-77 tail (benchmark.cjs): materialize origin/<branch>, then the
    // EXPLICIT set-head (`--auto` cannot answer right after create), so stage
    // branches fork from the fresh origin/<default>.
    gitOrThrow(spawn, abs, env, ['fetch', '--quiet', 'origin']);
    gitOrThrow(spawn, abs, env, ['remote', 'set-head', 'origin', DEFAULT_BRANCH]);
    return confirmedBy ? { confirmed_by: confirmedBy } : undefined;
  }

  function remoteLocal() {
    // Throws on any half-wired state — reported as the failed step, with the
    // FULL git output (a rejection's reason follows its first `To …` line).
    let origin;
    try {
      origin = substrateLocal.provisionBareOrigin(abs, { branch: DEFAULT_BRANCH });
    } catch (err) {
      const full = oneLine(err?.stderr);
      const msg = String(err?.message || err);
      throw new Error(full && !msg.includes(full) ? `${msg} — git: ${full}` : msg);
    }
    result.remote = origin.barePath;
    return { detail: `bare origin ${origin.barePath}` };
  }

  function intakeLabels() {
    return plan.start ? [REQUEST_LABEL] : [REQUEST_LABEL, CIRCUIT_LABEL];
  }

  function intakeGithub() {
    const labels = intakeLabels();
    const title = `[request] ${plan.title}`;
    const body = `Read \`${SPEC_REL}\` at commit ${state.specCommit} first: that file is this request's full specification, and this issue is only a pointer to it (filed by \`verity init\`).\n`;
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'];
    for (const l of labels) {
      args.push('--label', l);
    }
    let number = null;
    let confirmedBy;
    try {
      const out = gh.run(args, ghOpts({ idempotent: false, input: body }));
      const m = String(out).match(/\/issues\/(\d+)/);
      if (!m) {
        throw new Error(
          `gh issue create printed no issue URL (${firstLine(out) || 'empty output'})`,
        );
      }
      number = Number.parseInt(m[1], 10);
    } catch (err) {
      if (!err?.ambiguous) {
        throw new Error(`gh issue create failed: ${err?.message || err}`);
      }
      // Ambiguous: the issue may exist. Read the verity:request list back;
      // never re-issue the create (stage 112).
      let list;
      try {
        list = JSON.parse(
          gh.run(
            [
              'issue',
              'list',
              '--repo',
              repo,
              '--label',
              REQUEST_LABEL,
              '--state',
              'open',
              '--json',
              'number,title',
            ],
            ghOpts(),
          ) || '[]',
        );
      } catch (listErr) {
        throw new Error(
          `gh issue create failed ambiguously (${err.message}) and the ${REQUEST_LABEL} list could not be read (${listErr?.message || listErr}) — not re-issued`,
        );
      }
      const hit = Array.isArray(list) ? list.find((i) => i && i.title === title) : undefined;
      if (!hit || !Number.isInteger(hit.number)) {
        throw new Error(
          `gh issue create failed ambiguously (${err.message}) and no open ${REQUEST_LABEL} issue titled "${title}" was found — not re-issued; check ${repo} before retrying by hand`,
        );
      }
      number = hit.number;
      confirmedBy = 'issue-list';
    }
    state.intakeNumber = number;
    state.intakeLabels = labels;
    result.intake = {
      number,
      kind: 'issue',
      url: `https://github.com/${repo}/issues/${number}`,
      labels: [...labels],
      registered: false,
    };
    result.policy = { ...result.policy, circuit_open: labels.includes(CIRCUIT_LABEL) };
    return confirmedBy ? { confirmed_by: confirmedBy } : undefined;
  }

  function intakeLocal() {
    const labels = intakeLabels();
    const rec = substrateLocal.createWorkItem(
      abs,
      { title: `[request] ${plan.title} — spec: ${SPEC_REL}`, labels },
      { now: nowFn().getTime() },
    );
    state.intakeNumber = rec.number;
    state.intakeLabels = rec.labels;
    result.intake = {
      number: rec.number,
      kind: 'record',
      url: null,
      labels: [...rec.labels],
      registered: false,
    };
    result.policy = { ...result.policy, circuit_open: rec.labels.includes(CIRCUIT_LABEL) };
  }

  function register() {
    const file = path.join(abs, REGISTER_REL);
    let doc = { schema: 1, requests: [] };
    if (fs.existsSync(file)) {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Stage 114: the ONE schema-1 validator the scanner's trust read uses.
      if (intake.validate(doc) !== null) {
        throw new Error(`${REGISTER_REL} exists and is not a schema-1 register`);
      }
    }
    doc.requests.push({
      number: state.intakeNumber,
      kind: github ? 'issue' : 'record',
      spec: SPEC_REL,
      spec_commit: state.specCommit,
      filed_by: FILED_BY,
      engine: engineMeta.load().version ?? null,
      filed_at: nowFn()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    // Engine bookkeeping commit under the scoped bot identity (the
    // intent-artifacts / usage-untrack discipline), pathspec-limited.
    gitOrThrow(spawn, abs, env, ['add', '--', REGISTER_REL]);
    // The bot identity as env too: an inherited GIT_AUTHOR_*/GIT_COMMITTER_*
    // would otherwise outrank the `-c user.*` pair.
    gitOrThrow(spawn, abs, { ...env, ...usage.botIdentityEnv() }, [
      ...usage.botIdentityGitArgs(),
      'commit',
      '-q',
      '-m',
      `chore(verity): register intake #${state.intakeNumber}`,
      '--',
      REGISTER_REL,
    ]);
    const sha = gitOrThrow(spawn, abs, env, ['rev-parse', '--short', 'HEAD']);
    gitOrThrow(spawn, abs, env, ['push', '--quiet', 'origin', `HEAD:${DEFAULT_BRANCH}`]);
    result.intake = { ...result.intake, registered: true };
    return { detail: `commit ${sha} pushed to ${DEFAULT_BRANCH}` };
  }

  for (const [name, fn] of steps) {
    let extra;
    try {
      extra = fn();
    } catch (err) {
      const detail = oneLine(err?.message || err);
      result.steps.push({ step: name, ok: false, detail });
      result.outcome = 'failed';
      result.reason = `${name}: ${detail}`;
      return redactDeep(result);
    }
    const entry = { step: name, ok: true };
    if (extra?.skipped) {
      entry.skipped = true;
    }
    if (extra?.detail) {
      entry.detail = extra.detail;
    }
    if (extra?.confirmed_by) {
      entry.confirmed_by = extra.confirmed_by;
    }
    result.steps.push(entry);
  }

  result.ok = true;
  result.outcome = 'ok';
  return redactDeep(result);
}

// --- human render (not contractual) -----------------------------------------

function render(result) {
  const lines = [];
  const head = `verity init: ${result.outcome}`;
  lines.push(result.path ? `${head} — ${result.path}` : head);
  for (const s of result.steps || []) {
    const mark = s.ok ? (s.skipped ? '-' : '✓') : '✗';
    const extra = [s.confirmed_by ? `confirmed by ${s.confirmed_by}` : null, s.detail || null]
      .filter(Boolean)
      .join('; ');
    lines.push(`  ${mark} ${s.step}${extra ? ` — ${extra}` : ''}`);
  }
  if (result.outcome === 'ok') {
    lines.push(`  remote: ${result.remote}`);
    const intake = result.intake;
    lines.push(`  intake: #${intake.number} [${intake.labels.join(', ')}]`);
    if (result.policy?.circuit_open) {
      lines.push(
        `  the breaker is open — nothing runs until you close it: verity operator act circuit close ${intake.number}`,
      );
    }
  } else if (result.reason) {
    lines.push(`  reason: ${result.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- CLI ---------------------------------------------------------------------

// `verity init <path> --spec <file> --name <name> --owner <owner> [--slug s]
//  [--substrate github|local] [--private|--public] [--start] [--gate n=cmd]…
//  [--json]`. With the raw argv (the CLI path) the strict parser is used; the
// (rest, flags) form serves programmatic callers.
function dispatch(rest, flagsIn, argv) {
  const flags = flagsIn || {};
  let input;
  if (Array.isArray(argv)) {
    const parsed = parseArgv(argv);
    input = {
      ...parsed.opts,
      path: parsed.positional[0],
      extra: parsed.positional.slice(1),
      unknown: parsed.unknown,
    };
  } else {
    const gateFlag = flags.gate;
    input = {
      ...flags,
      gates: Array.isArray(gateFlag) ? gateFlag : gateFlag === undefined ? [] : [gateFlag],
      path: rest[0],
      extra: rest.slice(1),
    };
  }
  return run({ ...input, cwd: input.cwd || flags.cwd });
}

module.exports = {
  STEPS,
  REFUSALS,
  SCHEMA,
  starterPolicy,
  specTitle,
  parseArgv,
  run,
  render,
  dispatch,
  exitCodeFor,
};
