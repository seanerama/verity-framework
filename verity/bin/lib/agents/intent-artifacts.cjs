// Stage 96 (ADR-0033, #189) — the ENGINE commits the intent artifacts a
// `git_write:false` role wrote, after the role returns.
//
// plan writes stage-instructions/, contracts/, feature-assessments/, docs/adr/;
// revisit writes docs/revisit/. Both roles are git_write:false by contract
// (contracts/role-capability-policy.md — unchanged here), so nothing ever
// committed those files: the stage lifecycle (ADR-0012) engages only for a
// git_write GRANT on a stage-keyed run, and a later build's `begin` excludes
// pre-existing dirt from its own commit. The specs rode along locally and were
// never pushed (#189, both providers, both substrates).
//
// This is the file-side sibling of ADR-0026's work-item reconcile
// (../work-items.cjs): deterministic, additive, idempotent, non-fatal, and
// performed by the WORKER process after the verdict — the model still never
// touches `.git`. It runs where withWorkItems runs in agent-exec (after
// enforced() and committed()), so the ref movement it causes is an engine
// action taken AFTER the invariants verdict, never a role violation.
//
//   - Role→roots table: engine-owned and test-pinned (like the ADR-0031 trust
//     table). Roots are extended by amending the table, never by prompt text.
//     A role absent from it is skipped with a machine-readable reason.
//   - Additive by pathspec: `git add --ignore-removal -- <roots>` — deletions
//     and paths outside the roots are never staged, so dirt from other runs is
//     never swept in; the commit names the exact files it takes.
//   - Idempotent: nothing changed under the roots ⇒ `noop`, never an empty
//     commit.
//   - Non-fatal, never silent: every failure is a returned object; the caller
//     (agent-exec's withIntentArtifacts) prints the one stderr line, mirroring
//     `work-item-reconcile-failed`. This module never throws.
//   - Bot identity: the stage-38 `verity-worker` identity usage.commitUsage
//     commits the ledger with (scoped `-c`, never the operator's git config).
//   - Push target: the substrate's `origin` (ADR-0029 wires the local bare
//     origin under the same remote name, so one push path serves both). A
//     failed push leaves the commit local and is reported, not hidden.
//
// Node built-ins only (zero-dependency repo).
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const substrateLocal = require('../substrate-local.cjs');
const usage = require('../usage.cjs');

// The role→roots table. Trailing slashes are deliberate: each entry is a
// DIRECTORY pathspec, so `stage-instructions-old/` can never match
// `stage-instructions/`. architect / security / sre are candidates once they
// are worker-dispatched (ADR-0033 §Consequences) — add a line, pin a test.
const ROLE_ROOTS = Object.freeze({
  plan: Object.freeze(['stage-instructions/', 'contracts/', 'feature-assessments/', 'docs/adr/']),
  revisit: Object.freeze(['docs/revisit/']),
});

// Same rule as agents/git-lifecycle.cjs: the remote is not configurable.
const REMOTE = 'origin';

function firstLine(text) {
  return (
    String(text || '')
      .split('\n')
      .find((l) => l.trim().length > 0) || ''
  ).trim();
}

// A push that hangs on a credential prompt or a dead remote must not hang the
// worker: git never prompts (GIT_TERMINAL_PROMPT=0) and every call has a
// deadline. A timeout surfaces as { ok: false, error } like any other failure.
const GIT_TIMEOUT_MS = 120_000;

// Result-shaped git: never throws, the first stderr line is the error.
function git(cwd, args) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      error: firstLine(err.stderr) || err.message,
    };
  }
}

// `git status --porcelain=v1 -z` paths, one per entry — the NEW path for a
// rename/copy (its ORIGIN path follows in its own NUL field and is skipped).
// NUL-separated on purpose: without `-z` git QUOTES any path with a non-ASCII
// byte, a quote, a backslash or a tab (`"stage-instructions/stage-1-\303\274.md"`),
// which no longer startsWith() its root — the same parse git-lifecycle.statusMap
// and invariants.snapshotStatus use.
function porcelainPaths(stdout) {
  const fields = String(stdout).split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      i += 1; // the ORIGIN path follows in its own NUL field
    }
  }
  return paths;
}

// Deterministic, attributable message: the subject names the role; the body
// lists every path the commit takes and says WHY a commit exists that the role
// did not make (the same discipline as git-lifecycle.commitMessage).
function commitMessage(role, files) {
  const subject =
    role === 'revisit'
      ? `revisit: ${path.basename(files[0])}${files.length > 1 ? ` (+${files.length - 1} more)` : ''}`
      : `${role}: intent artifacts — ${files.length} file(s)`;
  const body = [
    ...files,
    '',
    `Committed by the Verity engine after the ${role} role returned — a git_write:false role's intent artifacts are worker-owned (ADR-0033, #189).`,
  ].join('\n');
  return [subject, body];
}

// Commit + push the role's declared intent-artifact roots. Returns one of:
//   { outcome: 'skipped',   reason: 'role-not-tabled' }
//   { outcome: 'noop' }                                  — nothing under the roots
//   { outcome: 'committed', sha, files, branch, pushed: true }
//   { outcome: 'committed', sha, files, branch, pushed: false, error }
//   { outcome: 'failed',    error, files? }
// Never throws. `substrate` is resolved from the policy when absent (ADR-0029)
// and echoed back so the operator can see which origin the push targeted.
function commitIntentArtifacts({ cwd, role, substrate } = {}) {
  const roots = ROLE_ROOTS[role];
  if (roots === undefined) {
    return { outcome: 'skipped', reason: 'role-not-tabled' };
  }
  const resolvedSubstrate =
    substrate === undefined ? substrateLocal.resolveSubstrate(cwd) : substrate;

  // 1. Anything at all under the roots? `--untracked-files=all` so a brand-new
  //    directory reports its files, not just the directory. An empty answer is
  //    the idempotent no-op: a second pass after a commit changes nothing.
  const status = git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...roots,
  ]);
  if (!status.ok) {
    return { outcome: 'failed', error: `git status failed: ${status.error}` };
  }
  const touched = porcelainPaths(status.stdout);
  // Only the roots that actually changed go to `git add` (a root with nothing
  // on disk and nothing tracked is a pathspec error, and add is all-or-nothing).
  // The empty guard is load-bearing: an EMPTY pathspec would make `git add`
  // a no-op and `git diff --cached -- ` repo-wide — every stray staged file
  // would then be committed under the bot identity. Nothing under a root ⇒
  // noop, BEFORE any add/diff.
  const activeRoots = roots.filter((root) => touched.some((p) => p.startsWith(root)));
  if (activeRoots.length === 0) {
    return { outcome: 'noop' };
  }

  // Refuse to commit onto no branch: a detached HEAD would strand the commit
  // the moment the checkout moves. Checked BEFORE anything is staged.
  const head = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : '';
  if (branch === '') {
    return {
      outcome: 'failed',
      error: 'HEAD is detached — refusing to commit intent artifacts onto no branch',
    };
  }
  // Refuse to commit anywhere but the default branch: intent artifacts belong
  // on main (ADR-0033), and a checkout parked on some other branch would
  // otherwise get the specs pushed to THAT remote branch. The resolver is the
  // substrate driver's own (`refs/remotes/origin/HEAD` first, then a local
  // main/master, then HEAD's branch) — the rung the stage lifecycle uses too.
  const defaultRef = substrateLocal.defaultBranchRef(cwd);
  const defaultBranch =
    defaultRef === null
      ? null
      : defaultRef.startsWith(`${REMOTE}/`)
        ? defaultRef.slice(REMOTE.length + 1)
        : defaultRef;
  if (defaultBranch !== null && branch !== defaultBranch) {
    return {
      outcome: 'failed',
      error: `not on default branch ${defaultBranch} (on ${branch}) — refusing to commit intent artifacts`,
    };
  }

  // 2. Stage additively, by pathspec. --ignore-removal: a deleted file under a
  //    root is never staged; the engine adds and updates, it never removes.
  const add = git(cwd, ['add', '--ignore-removal', '--', ...activeRoots]);
  if (!add.ok) {
    return { outcome: 'failed', error: `git add failed: ${add.error}` };
  }
  // The exact files the commit takes: what is staged under the roots as an
  // addition/modification (a pre-existing staged deletion under a root is
  // excluded — --diff-filter=ACMR). Empty ⇒ only deletions were pending, and
  // the never-an-empty-commit rule makes that a no-op too.
  // `-z` here too: --name-only quotes exactly like porcelain does.
  const staged = git(cwd, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMR',
    '--',
    ...activeRoots,
  ]);
  if (!staged.ok) {
    return { outcome: 'failed', error: `git diff --cached failed: ${staged.error}` };
  }
  const files = staged.stdout.split('\0').filter((l) => l !== '');
  if (files.length === 0) {
    return { outcome: 'noop' };
  }

  // 3. Commit ONLY those paths (`git commit -- <paths>` leaves anything else
  //    the operator had staged exactly as it was), under the bot identity.
  const [subject, body] = commitMessage(role, files);
  const commit = git(cwd, [
    ...usage.botIdentityGitArgs(),
    'commit',
    '--quiet',
    '-m',
    subject,
    '-m',
    body,
    '--',
    ...files,
  ]);
  if (!commit.ok) {
    return { outcome: 'failed', error: `git commit failed: ${commit.error}`, files };
  }
  const rev = git(cwd, ['rev-parse', 'HEAD']);
  const sha = rev.ok ? rev.stdout.trim() : null;
  const base = { outcome: 'committed', sha, files, branch, substrate: resolvedSubstrate };

  // 4. Push the branch the commit landed on to the substrate's origin. In every
  //    worker dispatch that is the default branch — a git_write:false role never
  //    gets a stage branch (ADR-0012 lifecycle is stage-keyed). A failed push
  //    keeps the commit local and says so; it never fails the run.
  const push = git(cwd, ['push', '--quiet', REMOTE, `${branch}:${branch}`]);
  if (!push.ok) {
    return { ...base, pushed: false, error: `git push ${REMOTE} ${branch} failed: ${push.error}` };
  }
  return { ...base, pushed: true };
}

module.exports = { REMOTE, ROLE_ROOTS, commitIntentArtifacts, commitMessage };
