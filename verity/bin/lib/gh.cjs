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
//                       Stage 112: a caller whose call is a NON-IDEMPOTENT write
//                       passes opts.idempotent === false. Such a call is still
//                       retried on a PRE-CONNECT failure (the request never
//                       reached GitHub: DNS, refused, unreachable, secondary rate
//                       limit), but NOT on an AMBIGUOUS one (a killed child,
//                       i/o timeout, connection reset, TLS handshake timeout,
//                       HTTP 5xx — the write may have been applied): it throws
//                       at once with GhError.ambiguous === true, and the caller
//                       decides (re-read, adopt, or fail loud — never write twice).
//   json(args, opts) -> JSON.parse(run(args, opts)).
//   GhError          -> Error subclass: { args, exitCode, stderr, attempts,
//                       transient, reason, ambiguous }. message = first stderr line.
//
// opts (all optional): { cwd, input, retries=3, timeoutMs=GH_TIMEOUT_MS,
//   idempotent=true, exec, sleep, random, log }
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
// Stage 112 splits the class by whether the request can have reached GitHub:
//   AMBIGUOUS — the connection was up (or its state is unknown) when it
//     failed, so a write may have been applied: i/o timeout, connection reset,
//     TLS handshake timeout;
//   PRE-CONNECT — the request never left the box: unreachable, no such host,
//     EAI_AGAIN, could not resolve host, connection refused (and a bare
//     `dial tcp` with none of the above).
// Both keep reason 'network' (the stage-110 vocabulary); only `ambiguous`
// differs, and only a non-idempotent caller acts on it.
const AMBIGUOUS_NETWORK_RE = /i\/o timeout|connection reset|TLS handshake timeout/i;
const NETWORK_RE =
  /network is unreachable|dial tcp|no such host|i\/o timeout|EAI_AGAIN|connection (refused|reset)|TLS handshake timeout|could not resolve host/i;

// Stage 112 (#290-4): the HTTP status gh reports, anchored to the two shapes gh
// prints — `HTTP 404: Not Found (…)` at the start of a line (REST/GraphQL
// commands) or `… (HTTP 404)` (gh api) — so a status quoted inside a comment
// body or a title can never classify a call.
const HTTP_LINE_RE = /^(?:gh: )?HTTP (\d{3})\b/m;
const HTTP_PAREN_RE = /\(HTTP (\d{3})\)/;

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
    // Stage 112: true iff a non-idempotent call stopped on an ambiguous
    // failure — the write may or may not have been applied.
    this.ambiguous = info.ambiguous === true;
  }
}

// Transient (retriable) = HTTP 5xx or a secondary rate limit, per SKETCH §8.3,
// plus (stage 110) a child killed at its deadline (`timeout`) and a
// network-level error (`network`). gh does not encode HTTP status in its exit
// code, so classify from its output. A killed child is checked FIRST: it was
// stopped mid-flight, so whatever partial output it left is not a verdict.
//
// Stage 112: every class also says whether it is AMBIGUOUS for a write — may
// the request have been applied? A killed child, an ambiguous network error
// and an HTTP 5xx are; a secondary rate limit (GitHub refused the request) and
// a pre-connect network error are not. `run` retries an ambiguous failure only
// for an idempotent call.
//
// The text classified is gh's STDERR. execFileSync's own message is
// `Command failed: gh <argv>\n<stderr>` — the argv carries comment bodies and
// titles, so a body quoting "dial tcp" or "HTTP 502" must never classify the
// call (#290-4). The message is consulted only when it is not that shape (an
// error thrown by an injected exec, or a spawn failure).
function classifiedText(err) {
  const stderr = String(err?.stderr || '');
  const message = String(err?.message || '');
  return /^Command failed: /.test(message) ? stderr : `${stderr}\n${message}`;
}

function classify(err) {
  if (err?.code === 'ETIMEDOUT' || err?.killed === true || err?.signal) {
    return { transient: true, reason: 'timeout', ambiguous: true };
  }
  const text = classifiedText(err);
  if (/secondary rate limit|submitted too quickly/i.test(text)) {
    return { transient: true, reason: 'secondary-rate-limit', ambiguous: false };
  }
  const http = text.match(HTTP_LINE_RE) || text.match(HTTP_PAREN_RE);
  if (http) {
    return http[1][0] === '5'
      ? { transient: true, reason: 'http-5xx', ambiguous: true }
      : { transient: false, reason: `http-${http[1]}`, ambiguous: false };
  }
  if (NETWORK_RE.test(text)) {
    return { transient: true, reason: 'network', ambiguous: AMBIGUOUS_NETWORK_RE.test(text) };
  }
  return { transient: false, reason: 'error', ambiguous: false };
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
  // Stage 112: only an explicit false opts out — every existing caller (reads,
  // label adds/removes) keeps the stage-110 behaviour byte-identically.
  const idempotent = opts.idempotent !== false;

  let lastErr;
  let lastClass;
  let ambiguous = false;
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
      // A non-idempotent write that failed ambiguously may have landed:
      // retrying could apply it twice, so it stops here (stage 112).
      ambiguous = !idempotent && lastClass.ambiguous === true;
      const willRetry = lastClass.transient && !ambiguous && attempt < maxAttempts;
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
  const base =
    lastClass.reason === 'timeout'
      ? `gh ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms (${attempts} attempt${attempts === 1 ? '' : 's'})`
      : firstLine(lastErr?.stderr) || firstLine(lastErr?.message) || `gh ${args.join(' ')} failed`;
  const message = ambiguous
    ? `${base} — not retried: a non-idempotent write that may have been applied (${lastClass.reason})`
    : base;
  throw new GhError(message, {
    args,
    exitCode: typeof lastErr?.status === 'number' ? lastErr.status : null,
    stderr: String(lastErr?.stderr || ''),
    attempts,
    transient: lastClass.transient,
    reason: lastClass.reason,
    ambiguous,
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
