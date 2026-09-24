// Release/Deploy Operator — runtime-truth artifact (framework-spec.md §4.6 / D6).
// `.verity/runtime.json` is the structured single-writer (Operator) store; STATUS.md
// is the committed human-readable rendering of it. Records secret LOCATIONS only —
// never values ("a map to secrets, not a copy").
const fs = require('node:fs');
const path = require('node:path');

const { getAt, setAt, coerce } = require('./config.cjs');

const DEFAULTS = {
  version: null,
  deployed_at: null,
  rollback_from: null,
  environments: {},
  secret_locations: [],
  notes: [],
};

function runtimePath(cwd) {
  return path.join(cwd, '.verity', 'runtime.json');
}

// A fresh copy of DEFAULTS per read: a shallow spread would share the default
// arrays, so an `append` on a repo with no runtime.json would mutate DEFAULTS
// itself and leak into every later read in the same process (stage 107).
function read(cwd) {
  const p = runtimePath(cwd);
  return fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, 'utf8'))
    : JSON.parse(JSON.stringify(DEFAULTS));
}

function write(cwd, data) {
  fs.mkdirSync(path.dirname(runtimePath(cwd)), { recursive: true });
  fs.writeFileSync(runtimePath(cwd), `${JSON.stringify(data, null, 2)}\n`);
}

function section(title, items) {
  const out = [`## ${title}`];
  if (items && items.length > 0) {
    for (const x of items) {
      out.push(`- ${x}`);
    }
  } else {
    out.push('- (none)');
  }
  out.push('');
  return out;
}

function render(cwd, data) {
  const envItems = Object.entries(data.environments || {}).map(
    ([k, v]) => `**${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`,
  );
  const lines = [
    '# Status & Handoff',
    '',
    '> Runtime/ops truth (framework-spec §4.6). Generated from `.verity/runtime.json`',
    '> by the Release/Deploy Operator. Secret LOCATIONS only — never values.',
    '',
    `**Live version:** ${data.version || '(none)'}`,
    `**Deployed at:** ${data.deployed_at || '(not deployed)'}`,
    `**Rollback from:** ${data.rollback_from || '(n/a)'}`,
    '',
    ...section('Environments', envItems),
    ...section(
      'Secret locations (names + on-disk locations only, never values)',
      data.secret_locations,
    ),
    ...section('Coordination notes', data.notes),
    // Stage 107: the go-live gate dispositions, rendered only when the optional
    // `golive` key exists — a runtime.json without it renders byte-identically to
    // before. Required lazily: golive.cjs requires this module at load time.
    ...(data.golive && typeof data.golive === 'object'
      ? require('./golive.cjs').statusSection(data.golive)
      : []),
  ];
  fs.writeFileSync(path.join(cwd, 'STATUS.md'), `${lines.join('\n').trim()}\n`);
}

function show(cwd) {
  return { runtime: read(cwd) };
}

function set(cwd, field, rawValue) {
  if (!field) {
    throw new Error('status set requires a field');
  }
  const data = read(cwd);
  setAt(data, field, coerce(rawValue));
  write(cwd, data);
  render(cwd, data);
  return { field, value: getAt(data, field), runtime: runtimePath(cwd) };
}

function append(cwd, listField, value) {
  const data = read(cwd);
  const list = Array.isArray(data[listField]) ? data[listField] : [];
  list.push(value);
  data[listField] = list;
  write(cwd, data);
  render(cwd, data);
  return { field: listField, count: list.length };
}

// Stage 107: the explicit not-applicable form for secret locations. A project
// with no deploy host and no stored secrets records `n/a: <reason>` instead of a
// location that does not exist. The array stays an array of strings.
const NA_PREFIX = 'n/a:';
const MIN_REASON = 10;

function isNotApplicable(entry) {
  return typeof entry === 'string' && entry.startsWith(NA_PREFIX);
}

// `verity status secret "<NAME> @ <loc>"` (unchanged) or
// `verity status secret --none "<reason>"`. Locations and an n/a are mutually
// exclusive: a project cannot both record where its secrets live and declare it
// has none, so either order is refused.
function secret(cwd, args, flags) {
  const existing = read(cwd).secret_locations;
  const list = Array.isArray(existing) ? existing : [];
  if (flags.none === undefined) {
    const na = list.find(isNotApplicable);
    if (na !== undefined) {
      throw new Error(
        `status secret refused: secret locations are already declared not applicable (${JSON.stringify(na)}) — a project cannot both record locations and declare none`,
      );
    }
    return append(cwd, 'secret_locations', args.join(' '));
  }
  if (args.length > 0) {
    throw new Error(
      'status secret --none takes one quoted reason and no location — a project cannot both record locations and declare none',
    );
  }
  const reason = typeof flags.none === 'string' ? flags.none.trim() : '';
  if (reason.length < MIN_REASON) {
    throw new Error(
      `status secret --none needs a reason of at least ${MIN_REASON} characters saying why no secret location applies (got ${JSON.stringify(reason)})`,
    );
  }
  const located = list.find((e) => !isNotApplicable(e));
  if (located !== undefined) {
    throw new Error(
      `status secret --none refused: a secret location is already recorded (${JSON.stringify(located)}) — a project cannot both record locations and declare none`,
    );
  }
  return append(cwd, 'secret_locations', `${NA_PREFIX} ${reason}`);
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0] || 'show';
  if (verb === 'show') {
    return show(cwd);
  }
  if (verb === 'set') {
    return set(cwd, args[1], args[2]);
  }
  if (verb === 'note') {
    return append(cwd, 'notes', args.slice(1).join(' '));
  }
  if (verb === 'secret') {
    return secret(cwd, args.slice(1), flags);
  }
  if (verb === 'render') {
    render(cwd, read(cwd));
    return { rendered: path.join(cwd, 'STATUS.md') };
  }
  throw new Error(`unknown status verb: ${verb} — use show|set|note|secret|render`);
}

// `write` is exported (stage 91) so a caller that must change SEVERAL fields
// from one read — `promotion finalize` stamping version/deployed_at/
// rollback_from together — can do it as a single write + single render, rather
// than three `set` round-trips that each re-read and re-render.
module.exports = {
  DEFAULTS,
  NA_PREFIX,
  MIN_REASON,
  isNotApplicable,
  runtimePath,
  read,
  write,
  render,
  show,
  set,
  append,
  secret,
  dispatch,
};
