// Intake register (stage 114, ADR-0038 D2, contract operator-init v1 §register).
//
// `.verity/intake.json` lists the intake items the ENGINE filed (`verity init`
// in v1). The scanner's P4 tier keeps a `verity:request` authored by the
// worker's own login IFF its number is listed here — the no-self-feeding rule
// is otherwise untouched. There is no policy knob: a project without a
// register has the empty set, so the tier behaves exactly as before.
//
// Public surface:
//   read(cwd, opts)              → { ok, requests[], reason, source }
//   registeredNumbers(cwd, opts) → Set<number>
//   validate(doc)                → null | error string (schema 1)
//   parse(text)                  → { ok, requests[], reason }
//
// THE TRUST SOURCE IS THE COMMITTED REGISTER ON THE DEFAULT BRANCH, never the
// working tree. ADR-0038's safety argument is that listing a number requires
// landing an edit to `.verity/**` on the default branch — a forced-protected
// path (autonomy.cjs FORCED_PROTECTED_PATHS) that gates at trust 0 and 1. A
// working-tree file carries none of that: a role with a plain file-write tool
// (the Claude plan role holds Write/Edit) could write it during a run, and the
// worker's checkout may stand on a stage branch. So `read` resolves the
// default branch the way the stage lifecycle does (`refs/remotes/origin/HEAD`,
// rung 1 of git-lifecycle.resolveBase — set by `git clone` and by `verity
// init`) and reads the blob at that commit with `git show`. No fallback to a
// local branch or HEAD: when origin/HEAD does not resolve, nothing is trusted.
//
// origin/HEAD must be a SYMBOLIC ref whose target lies under
// `refs/remotes/origin/` (stage 114 review F2). `rev-parse origin/HEAD` alone
// would follow a symref to ANY ref: `ref: refs/heads/main` written into
// `.git/refs/remotes/origin/HEAD` makes an unpushed local commit "the default
// branch", and a fetch does not repair it. Every state git and the engine
// produce is symbolic and remote-namespaced — `git clone`, `git remote set-head`
// (explicit or --auto), `verity init`, `benchmark provision`,
// substrate-local.provisionBareOrigin — and the engine's own default-branch
// resolvers (git-lifecycle.resolveBase, substrate-local.defaultBranchRef)
// already read origin/HEAD via `symbolic-ref`, so a non-symbolic origin/HEAD
// (only an explicit update-ref / `fetch HEAD:refs/remotes/origin/HEAD` makes
// one) is not a state they honour either. Such a ref — or a symref pointing
// outside the remote namespace — trusts nothing, with one warning whenever a
// register is at stake (at that commit or in the working tree). This is only
// as strong as the local ref store: a role able to write `.git/` directly is
// outside this guarantee, as it is for hooks.
//
// Fail closed, three ways (contract: a broken register never trusts anything):
//   - no committed register (every pre-init project) ⇒ empty, ok, SILENT;
//   - a register present only in the working tree, or origin/HEAD missing
//     while a working-tree register exists ⇒ empty, with a reason;
//   - an unreadable / non-JSON / schema-invalid committed register ⇒ empty,
//     with a reason.
// `registeredNumbers` hands the reason to `opts.warn` once; it never throws.
//
// Every git call is bounded (git-lifecycle's split deadline) and never
// prompts. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 1;
const REGISTER_REL = '.verity/intake.json';
const DEFAULT_REF = 'refs/remotes/origin/HEAD';
// The only namespace origin/HEAD may point into (review F2).
const REMOTE_NAMESPACE = 'refs/remotes/origin/';
const KINDS = new Set(['issue', 'record']);
const MAX_BYTES = 1024 * 1024;

function nullableString(v) {
  return v === null || v === undefined || typeof v === 'string';
}

// Schema-1 validation. Returns null when valid, else a one-line reason. An
// unknown extra key is tolerated (the contract is additive); a malformed
// entry fails the WHOLE register (a partly-broken register trusts nothing).
function validate(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'is not a JSON object';
  }
  if (doc.schema !== SCHEMA) {
    return `schema must be ${SCHEMA} (got ${JSON.stringify(doc.schema)})`;
  }
  if (!Array.isArray(doc.requests)) {
    return 'requests must be an array';
  }
  for (let i = 0; i < doc.requests.length; i += 1) {
    const r = doc.requests[i];
    const at = `requests[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return `${at} is not an object`;
    }
    if (!Number.isInteger(r.number) || r.number <= 0) {
      return `${at}.number must be a positive integer (got ${JSON.stringify(r.number)})`;
    }
    if (!KINDS.has(r.kind)) {
      return `${at}.kind must be "issue" or "record" (got ${JSON.stringify(r.kind)})`;
    }
    if (typeof r.spec !== 'string' || r.spec === '') {
      return `${at}.spec must be a non-empty string`;
    }
    if (typeof r.filed_by !== 'string' || r.filed_by === '') {
      return `${at}.filed_by must be a non-empty string`;
    }
    for (const k of ['spec_commit', 'engine', 'filed_at']) {
      if (!nullableString(r[k])) {
        return `${at}.${k} must be a string or null`;
      }
    }
  }
  return null;
}

function parse(text) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (err) {
    return { ok: false, requests: [], reason: `is not valid JSON (${err.message})` };
  }
  const err = validate(doc);
  if (err !== null) {
    return { ok: false, requests: [], reason: err };
  }
  return { ok: true, requests: doc.requests, reason: null };
}

// Bounded, prompt-free git read. Never throws: { ok, stdout }.
function git(cwd, args) {
  // Lazy: git-lifecycle sits in a require graph with the scanner's callers;
  // only its deadline helper is needed here.
  const gitLifecycle = require('./agents/git-lifecycle.cjs');
  const res = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BYTES * 2,
    timeout: gitLifecycle.gitTimeoutMs(args),
    killSignal: 'SIGTERM',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: res.stdout };
}

function workingTreeHasRegister(cwd) {
  try {
    return fs.existsSync(path.join(cwd, REGISTER_REL));
  } catch {
    return false;
  }
}

// The committed register on the default branch. `source` names what was read
// (`origin/HEAD@<sha>`), or null when nothing was.
// Resolve origin/HEAD to a commit, accepting ONLY a symbolic ref into the
// remote namespace. Returns { sha } (sha '' when origin/HEAD is absent or
// dangling — the pre-F2 "does not resolve" case) or { anomaly, sha } when
// origin/HEAD exists but is non-symbolic or points outside
// `refs/remotes/origin/` (sha: what it WOULD have resolved to, used only to
// decide whether a register was at stake — never read as the register).
function resolveDefault(dir) {
  const sym = git(dir, ['symbolic-ref', '--quiet', DEFAULT_REF]);
  const target = sym.ok ? sym.stdout.trim() : '';
  if (target === '') {
    // Absent, or present but not symbolic: tell them apart by a no-deref read.
    const direct = git(dir, ['rev-parse', '--verify', '--quiet', '--no-deref', DEFAULT_REF]);
    const sha = direct.ok ? direct.stdout.trim() : '';
    if (sha === '') {
      return { sha: '' };
    }
    return {
      anomaly: `${DEFAULT_REF} is not a symbolic ref (a detached ${sha.slice(0, 12)}; git clone / git remote set-head / verity init always write a symbolic one)`,
      sha,
    };
  }
  const commit = git(dir, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  const sha = commit.ok ? commit.stdout.trim() : '';
  if (!target.startsWith(REMOTE_NAMESPACE) || target.length === REMOTE_NAMESPACE.length) {
    return {
      anomaly: `${DEFAULT_REF} points at ${target}, outside ${REMOTE_NAMESPACE} — only the remote's default branch is trusted`,
      sha,
    };
  }
  return { sha };
}

function read(cwd, _opts = {}) {
  const dir = cwd || process.cwd();
  const empty = (reason) => ({ ok: reason === null, requests: [], reason, source: null });
  const resolved = resolveDefault(dir);
  if (resolved.anomaly !== undefined) {
    // Fail closed. Warn only when a register is at stake, so a project with no
    // register stays byte-identical (silent) whatever its ref store looks like.
    const atStake =
      workingTreeHasRegister(dir) ||
      (resolved.sha !== '' && git(dir, ['cat-file', '-e', `${resolved.sha}:${REGISTER_REL}`]).ok);
    return atStake
      ? empty(`cannot be read from the default branch (${resolved.anomaly}); nothing is trusted`)
      : empty(null);
  }
  const sha = resolved.sha;
  if (sha === '') {
    return workingTreeHasRegister(dir)
      ? empty(
          `cannot be read from the default branch (${DEFAULT_REF} does not resolve); the working-tree copy is never trusted`,
        )
      : empty(null);
  }
  const present = git(dir, ['cat-file', '-e', `${sha}:${REGISTER_REL}`]);
  if (!present.ok) {
    return workingTreeHasRegister(dir)
      ? empty('is not committed on the default branch; the working-tree copy is never trusted')
      : empty(null);
  }
  const size = git(dir, ['cat-file', '-s', `${sha}:${REGISTER_REL}`]);
  if (!size.ok || Number(size.stdout.trim()) > MAX_BYTES) {
    return empty(size.ok ? `exceeds ${MAX_BYTES} bytes` : 'could not be read');
  }
  const blob = git(dir, ['show', `${sha}:${REGISTER_REL}`]);
  if (!blob.ok) {
    return empty('could not be read');
  }
  const parsed = parse(blob.stdout);
  return { ...parsed, source: `origin/HEAD@${sha.slice(0, 12)}` };
}

// The registered numbers, optionally narrowed to one carrier kind (`issue` on
// the github substrate — a local record number shares no namespace with a
// GitHub issue number). Empty on any failure; the reason goes to opts.warn.
function registeredNumbers(cwd, opts = {}) {
  let r;
  try {
    r = read(cwd, opts);
  } catch (err) {
    r = { ok: false, requests: [], reason: `could not be read (${err?.message || err})` };
  }
  if (!r.ok && typeof opts.warn === 'function') {
    opts.warn(
      `intake register ${REGISTER_REL} ${r.reason} — no engine-registered request is trusted (see docs/autonomy.md)`,
    );
  }
  const set = new Set();
  for (const req of r.requests) {
    if (opts.kind === undefined || req.kind === opts.kind) {
      set.add(req.number);
    }
  }
  return set;
}

module.exports = {
  SCHEMA,
  REGISTER_REL,
  DEFAULT_REF,
  REMOTE_NAMESPACE,
  validate,
  parse,
  read,
  registeredNumbers,
};
