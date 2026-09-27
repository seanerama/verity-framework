// Shared `gh` CLI layer (T07, SKETCH §8.3) — the ONE place verity shells out to
// GitHub. All label/comment/pr/issue operations in autonomy code go through here
// so retries and logging are uniform.
//
// Public surface (keep small):
//   run(args, opts)  -> stdout string. Executes `gh <args...>` with the §8.3 retry
//                       policy: up to 3 retries with jittered exponential backoff,
//                       ONLY on transient failures (HTTP 5xx, GitHub secondary
//                       rate limit, a timed-out child, or a network-level error —
//                       stage 110); 4xx and everything else fail fast. Throws
//                       GhError when attempts are exhausted or the error is
//                       non-transient. Every attempt is BOUNDED: the child is
//                       killed (SIGTERM) after opts.timeoutMs (default
//                       GH_TIMEOUT_MS), so the worst case per call is
//                       (retries + 1) × timeoutMs + backoff — never "until the
//                       network comes back".
//   json(args, opts) -> JSON.parse(run(args, opts)).
//   GhError          -> Error subclass: { args, exitCode, stderr, attempts,
//                       transient, reason }. message = first stderr line.
//
// opts (all optional): { cwd, input, retries=3, timeoutMs=GH_TIMEOUT_MS, exec,
//   sleep, random, log }
//   exec/sleep/random/log are injection points for tests — no real subprocess,
//   sleep, or randomness is required to unit-test the retry/backoff machinery.
//   exec receives the EFFECTIVE timeoutMs in its opts (the caller's, else the
//   default), so an injected exec sees exactly the deadline defaultExec enforces.
//
// Logging: one greppable line per attempt on stderr, gated by VERITY_GH_LOG=1
// (the CLI is silent by default; the worker can flip it on). Format:
//   verity:gh status=<ok|retry|fail> attempt=<n>/<max> exit=<code> ms=<ms> reason=<r> cmd="gh ..."
//
// Exported for tests (internal, not a stability contract): backoffMs, classify.
// Exported for reuse (stage 110): GH_TIMEOUT_MS — the one per-call deadline the
// direct `gh` shell-outs outside this module (ledger.cjs ghJson, review.cjs)
// share, so no worker-path `gh` call is unbounded.
// Exported for reuse (stage 105): sleepSync — the one synchronous sleep the
// gh-facing modules share (labels.cjs's fresh-repo list retry).
const { execFileSync } = require('node:child_process');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
// Stage 110: the per-attempt deadline. A `gh` call that has not returned in a
// minute is not going to — the 2026-09-25 benchmark tick-1 stall was a worker
// alive ~95 minutes on a local network loss with no timeout anywhere.
const GH_TIMEOUT_MS = 60_000;

// Stage 110: network-level failures (the box, not GitHub). Transient — a
// 5-second blip must not end a tick as `infra` — but still bounded by the retry
// budget, after which the GhError names the class.
const NETWORK_RE =
  /network is unreachable|dial tcp|no such host|i\/o timeout|EAI_AGAIN|connection (refused|reset)|TLS handshake timeout|could not resolve host/i;

class GhError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'GhError';
    this.args = info.args;
    this.exitCode = info.exitCode;
    this.stderr = info.stderr;
    this.attempts = info.attempts;
    this.transient = info.transient;
    this.reason = info.reason;
  }
}

// Transient (retriable) = HTTP 5xx or a secondary rate limit, per SKETCH §8.3,
// plus (stage 110) a child killed at its deadline (`timeout`) and a
// network-level error (`network`). gh does not encode HTTP status in its exit
// code, so classify from its output. A killed child is checked FIRST: it was
// stopped mid-flight, so whatever partial output it left is not a verdict.
function classify(err) {
  if (err?.code === 'ETIMEDOUT' || err?.killed === true || err?.signal) {
    return { transient: true, reason: 'timeout' };
  }
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  if (/secondary rate limit|submitted too quickly/i.test(text)) {
    return { transient: true, reason: 'secondary-rate-limit' };
  }
  const http = text.match(/HTTP (\d{3})/);
  if (http) {
    return http[1][0] === '5'
      ? { transient: true, reason: 'http-5xx' }
      : { transient: false, reason: `http-${http[1]}` };
  }
  if (NETWORK_RE.test(text)) {
    return { transient: true, reason: 'network' };
  }
  return { transient: false, reason: 'error' };
}

// Jittered exponential backoff: 500ms doubling per retry, scaled by a random
// factor in [0.5, 1.5). `random` is injectable so tests never sleep for real.
// floor (not round) keeps the result in the half-open interval — rounding could
// push a near-1.0 draw up to the excluded upper bound (e.g. retry 2 → 1500).
function backoffMs(retry, random = Math.random) {
  return Math.floor(BASE_DELAY_MS * 2 ** (retry - 1) * (0.5 + random()));
}

// Synchronous sleep (the whole CLI is sync); no busy-wait, no dependency.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultLog(line) {
  if (process.env.VERITY_GH_LOG) {
    process.stderr.write(`${line}\n`);
  }
}

function logLine(status, attempt, maxAttempts, exitCode, ms, reason, args) {
  return (
    `verity:gh status=${status} attempt=${attempt}/${maxAttempts} exit=${exitCode} ` +
    `ms=${ms} reason=${reason || '-'} cmd="gh ${args.join(' ')}"`
  );
}

function firstLine(text) {
  return String(text || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
}

function defaultExec(args, opts) {
  return execFileSync('gh', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? GH_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  });
}

function run(args, opts = {}) {
  const exec = opts.exec || defaultExec;
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
  const execOpts = { ...opts, timeoutMs };
  const retries = opts.retries ?? MAX_RETRIES;
  const sleep = opts.sleep || sleepSync;
  const random = opts.random || Math.random;
  const log = opts.log || defaultLog;
  const maxAttempts = retries + 1;

  let lastErr;
  let lastClass;
  let attempt = 0;
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const out = exec(args, execOpts);
      log(logLine('ok', attempt, maxAttempts, 0, Date.now() - t0, null, args));
      return out;
    } catch (err) {
      lastErr = err;
      lastClass = classify(err);
      const exitCode = typeof err.status === 'number' ? err.status : 'spawn';
      const willRetry = lastClass.transient && attempt < maxAttempts;
      log(
        logLine(
          willRetry ? 'retry' : 'fail',
          attempt,
          maxAttempts,
          exitCode,
          Date.now() - t0,
          lastClass.reason,
          args,
        ),
      );
      if (!willRetry) {
        break;
      }
      sleep(backoffMs(attempt, random));
    }
  }

  const attempts = Math.min(attempt, maxAttempts);
  // A killed child's own text is Node's "spawnSync gh ETIMEDOUT" — say what
  // happened instead, naming the deadline and how many attempts it cost.
  const message =
    lastClass.reason === 'timeout'
      ? `gh ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms (${attempts} attempt${attempts === 1 ? '' : 's'})`
      : firstLine(lastErr?.stderr) || firstLine(lastErr?.message) || `gh ${args.join(' ')} failed`;
  throw new GhError(message, {
    args,
    exitCode: typeof lastErr?.status === 'number' ? lastErr.status : null,
    stderr: String(lastErr?.stderr || ''),
    attempts,
    transient: lastClass.transient,
    reason: lastClass.reason,
  });
}

function json(args, opts = {}) {
  return JSON.parse(run(args, opts));
}

// A GitHub "owner/name" repository slug — GitHub's owner/name charset exactly:
// letters, digits, '.', '_', '-', ONE slash, neither side empty. This is a pure
// predicate; it touches nothing in run/json.
//
// Why it lives here (stage 52, #135): callers interpolate a repo straight into
// the `gh api` PATH (operator-act.cjs apiBase, worker/index.cjs apiBase,
// locks.cjs apiBase) and `gh api` TRUNCATES the endpoint at `?` / `#` —
// everything after is a query string / fragment. So an unvalidated repo is an
// endpoint-injection vector: `acme/widget/branches/main/protection?` turns a
// label DELETE into `DELETE /repos/acme/widget/branches/main/protection`. One
// shared predicate keeps every interpolation site honest.
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isRepoSlug(value) {
  // JS `$` matches BEFORE a trailing newline, so an anchored charset test alone
  // would accept 'acme/widget\n'. Reject any newline explicitly.
  return typeof value === 'string' && !/[\r\n]/.test(value) && REPO_SLUG_RE.test(value);
}

module.exports = {
  run,
  json,
  GhError,
  GH_TIMEOUT_MS,
  backoffMs,
  classify,
  isRepoSlug,
  sleepSync,
};
