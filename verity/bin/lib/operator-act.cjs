// Operator ACT — `verity operator act <verb>` (stage 50; contracts/operator-act-v2.md,
// frozen v2 — ADR-0037; v1 superseded, wire shape a superset). This is the
// operator seam's ONLY WRITE surface, kept in a SEPARATE module so the
// projection (operator.cjs) stays pure-read; operator.cjs merely DELEGATES the
// `act` verb here. Each verb is a thin, allowlisted wrapper over an
// action an operator can already perform by hand — a label POST/DELETE (the same
// `gh api …/labels` primitive verity/worker/index.cjs addLabel/removeLabel uses)
// or launching `verity-worker --once`. It adds convenience + a structured audit
// result, NOT new authority.
//
// Safety spine (contract §Invariants — the point of this stage):
//   1. NO merge authority, EVER. No verb merges, closes a PR, or grants merge.
//      `approve` only applies the single-use resume token the worker's trust
//      ladder then EVALUATES (ADR-0013; since stage 111 / ADR-0014 amended, at
//      trust 0 the WORKER merges on that token only for an approve verdict on
//      an unchanged head with green CI — this module still never does). There
//      is no merge/`pr merge` argv anywhere in this module. `approve` reports
//      what the worker's next tick will do (`effect.consequence`, v2) from
//      READ-ONLY reads taken after its one write — the prediction adds no
//      write and no authority.
//   2. Allowlist only. The verb set is exhaustive; an unknown verb is a hard
//      error. No generic gh/label passthrough.
//   3. Fail-closed. Any gh/worker failure ⇒ ok:false + a redacted reason + a
//      non-zero process exit. NEVER a false success.
//   4. Idempotent where meaningful. Adding a label already present (GitHub 200
//      no-op) or removing one already absent (GitHub 404) resolves to ok:true, so
//      a Console retry is safe. Only a REAL error (auth/network/5xx) fails closed.
//   5. Input-validated. `target` must be a positive integer; a flag-shaped or
//      non-numeric or missing target is refused BEFORE any gh.run call. So must
//      the REPO (stage 52, #135): it is interpolated into the `gh api` PATH and
//      `gh api` truncates at `?`/`#`, so an unvalidated --repo/GH_REPO is an
//      endpoint-injection vector. gh.isRepoSlug gates every verb at the point of
//      use, before any gh.run, breaker read, or spawn.
//   6. `circuit open` proves it can HALT before it says it did — the worker's
//      breaker query never sees PRs or closed issues (stage 52, #135).
//
// Kill-switch / dark-launch: nothing in the worker/scanner/trust/automation calls
// this module — it fires ONLY on an explicit `operator act` invocation. Removing
// the single delegation line in operator.cjs disables the whole write surface.
const { spawnSync } = require('node:child_process');
const gh = require('./gh.cjs');
const ledger = require('./ledger.cjs');
// Stage 80 (ADR-0029, contract local-work-item v1): the local-substrate ops the
// label verbs dispatch to when the resolved policy substrate is 'local'. The
// github path is byte-identical — the dispatch lives in runOps, keyed off the
// substrate act() resolves once, and 'github'/unreadable-policy changes nothing.
const substrateLocal = require('./substrate-local.cjs');

const SCHEMA = 1;

// Label vocabulary (labels.cjs LABELS) — the exact names the worker and a human
// operator already use.
const APPROVED = 'verity:approved';
const AWAITING = 'verity:awaiting-approval';
const NEEDS_HUMAN = 'verity:needs-human';
const CIRCUIT_OPEN = 'verity:circuit-open';

// The exhaustive allowlist (contract §Exposes). Anything else is a hard error.
const VERBS = [
  'approve',
  'reject',
  'request-changes',
  'needs-human',
  'clear-needs-human',
  'circuit',
  'run-once',
];

// The gate-comment trail read's pagination — the worker's own comment reader's
// bounds (locks.cjs PER_PAGE / MAX_PAGES).
const TRAIL_PER_PAGE = 100;
const TRAIL_MAX_PAGES = 50;

const DEFAULT_REWORK_NOTE =
  'Changes requested — parked for rework (verity:needs-human). Address the review notes, then clear the label to resume.';

// Deep-redact every string in the result through the engine redactor so no token
// shape or Authorization/Bearer/token line can survive in any field, reason, or
// error message. Non-strings pass untouched — crucially null stays null
// (ledger.redact would coerce it to ''). Mirrors operator.cjs's redactDeep.
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

// Repository resolution — the read side's rule (ledger/operator resolveRepo): an
// explicit --repo/--gh-repo wins, then the GH_REPO env var, then null.
function resolveRepo(flags = {}) {
  const explicit = flags.repo || flags['gh-repo'];
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }
  const env = process.env.GH_REPO;
  return typeof env === 'string' && env !== '' ? env : null;
}

// A target must be a positive integer. `/^\d+$/` refuses a flag-shaped string
// ('--', '--foo'), a negative, a non-number ('abc'), an empty string, and a
// missing (undefined) arg — the --repo-injection lesson (ledger) applied to
// targets. '0' is rejected (not > 0).
function parseTarget(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function apiBase(repo, n) {
  return `repos/${repo}/issues/${n}`;
}

// One label ADD. POST to the issues/labels endpoint is idempotent on GitHub —
// adding an already-present label is a 200 no-op, never an error — so it needs no
// 404-swallowing; a 4xx/5xx here is a REAL failure. (Issues AND PRs share this
// endpoint — the worker's apiBase proves it.)
function opAddLabel(repo, n, label) {
  return {
    effect: { kind: 'label-add', label, item: n },
    argv: ['api', '-X', 'POST', `${apiBase(repo, n)}/labels`, '-f', `labels[]=${label}`],
    tolerate404: false,
    idempotent: true, // stage 112: an already-present label is a 200 no-op — keeps retrying
  };
}

// One label REMOVE. DELETE of an already-absent label returns HTTP 404 — the
// desired end-state (label gone) already holds — so we swallow ONLY 404 to
// idempotent success, exactly as verity/worker/index.cjs removeLabel does.
function opRemoveLabel(repo, n, label) {
  return {
    effect: { kind: 'label-remove', label, item: n },
    argv: ['api', '-X', 'DELETE', `${apiBase(repo, n)}/labels/${encodeURIComponent(label)}`],
    tolerate404: true,
  };
}

// One comment POST. The body is echoed into the effect for audit, and the whole
// result passes through redactDeep — so a token shape in a note never survives.
function opComment(repo, n, body) {
  return {
    effect: { kind: 'comment', item: n, body },
    argv: ['api', '-X', 'POST', `${apiBase(repo, n)}/comments`, '-f', `body=${body}`],
    tolerate404: false,
    // Stage 112: NOT idempotent — an ambiguous failure (timeout, reset, 5xx)
    // is never retried (it could post the note twice); the verb reports it
    // failed, never a false success (invariant 4).
    idempotent: false,
  };
}

// Stage 80: one op against the LOCAL work-item store. Only the ops the frozen
// contract's write half defines (label add/remove — a record edit committed by
// the engine, ADR-0026); anything else (a comment) throws so runOps fails
// CLOSED with an honest reason instead of fabricating a write the local
// substrate has no surface for (ADR-0029 consequence: degrade honestly, never
// fabricate). removeLabel is idempotent on absence by construction — the same
// end-state rule the gh path's tolerate404 encodes.
function performLocalOp(op, cwd) {
  const effect = op.effect;
  if (effect.kind === 'label-add') {
    substrateLocal.addLabel(cwd, effect.item, effect.label);
    return;
  }
  if (effect.kind === 'label-remove') {
    substrateLocal.removeLabel(cwd, effect.item, effect.label);
    return;
  }
  throw new Error(
    `the local substrate has no '${effect.kind}' surface (contract local-work-item v1 defines create/label/close only) — not performed`,
  );
}

// Run the verb's ops in effect-order through the injected `run` (gh.run in
// production). Idempotency (invariant 4): a tolerate404 op whose gh.run throws a
// GhError with reason 'http-404' (gh.cjs encodes the HTTP status there) is the
// already-absent no-op — treat as success. Any OTHER failure (auth 401/403,
// network, 5xx) is a REAL error and fails closed at the first op that fails.
// Stage 80: on the 'local' substrate each op routes to performLocalOp instead
// of gh — same effect-order, same fail-closed-at-first-failure envelope.
function runOps(ops, run, ghOpts) {
  for (const op of ops) {
    try {
      if (ghOpts.substrate === 'local') {
        performLocalOp(op, ghOpts.cwd || process.cwd());
      } else {
        // Stage 112: a non-idempotent op says so; every other op's bag is
        // byte-identical to before.
        run(op.argv, op.idempotent === false ? { ...ghOpts, idempotent: false } : ghOpts);
      }
    } catch (err) {
      if (op.tolerate404 && err && err.reason === 'http-404') {
        continue;
      }
      return { ok: false, error: err };
    }
  }
  return { ok: true };
}

function noRepoReason() {
  return 'no repository resolved — pass --repo owner/name or set GH_REPO';
}

// The repo is an ENDPOINT, not a label. `apiBase` interpolates it into the
// `gh api` PATH and `gh api` truncates the endpoint at `?` / `#` — everything
// after is a query string / fragment — so an unvalidated repo retargets the
// label POST/DELETE at an arbitrary endpoint while the envelope still reports a
// label op. Contract invariant 6 (input-validated) + 4 (never a false success).
const REPO_FORM = "letters, digits, '.', '_', '-', exactly one slash";

function badRepoReason(repo) {
  return `--repo/GH_REPO ${JSON.stringify(repo)} is not a valid owner/name repository (${REPO_FORM}) — refusing before any GitHub call`;
}

function targetUsage(action, raw) {
  const got = raw === undefined ? '(none)' : JSON.stringify(raw);
  return `operator act ${action} requires a positive-integer target (got ${got}); usage: verity operator act ${action} <n>`;
}

// A refused (input-validation / no-repo) result — ok:false, no effect performed.
function refused(action, target, reason) {
  return redactDeep({
    schema: SCHEMA,
    action,
    target: target ?? null,
    effect: null,
    ok: false,
    reason,
  });
}

// The contract `action` string for a verb + its post-verb args, resolvable
// BEFORE any per-verb parsing (so a pre-flight refusal still names itself
// honestly). `circuit` carries its subcommand; every other verb is its own name.
function actionLabel(verb, args) {
  if (verb === 'circuit') {
    return args[0] === 'open' || args[0] === 'close' ? `circuit ${args[0]}` : 'circuit';
  }
  return verb;
}

// The target a verb WOULD have acted on, for the same pre-flight refusals.
// `run-once` has none; `circuit` takes its number one arg later.
function targetOf(verb, args) {
  if (verb === 'run-once') {
    return null;
  }
  return parseTarget(verb === 'circuit' ? args[1] : args[0]);
}

// `circuit open` precondition (stage 52, #135; contract line 24 — "on **open
// issue** n"). The worker's breaker query is
// `gh issue list --label verity:circuit-open --state open` (worker/index.cjs:798):
// `gh issue list` NEVER returns PRs, and --state open excludes closed issues.
// So labelling a PR or a closed issue is a genuine write that halts NOTHING —
// the single most dangerous false success in the seam. Prove the target is an
// OPEN ISSUE first, through the SAME injected `run` seam, and fail closed when
// the read cannot be trusted: Verity does not throw a kill switch it could not
// verify.
const BREAKER_QUERY = '`gh issue list --label verity:circuit-open --state open`';

// The read-failure wording follows the worker's own breaker-read precedent
// (index.cjs:802-807): name what could not be READ, and never claim the switch
// is armed.
function unverifiedReason(target, detail) {
  return `could not verify that #${target} is an open issue before opening the circuit (failing closed — the kill switch was NOT thrown): ${detail}`;
}

// Stage 85 (ADR-0029): the LOCAL `circuit open` precondition — same invariant,
// local read. The local worker's breaker query is "any OPEN work-item record
// carrying verity:circuit-open" (worker startupChecks stage 85 — the same
// derivation stage 84's snapshot uses for autonomy.circuit_open), so labeling
// a CLOSED or missing/corrupt record is a genuine write that halts NOTHING.
// Prove the target is an OPEN record first; a record that cannot be honestly
// read fails closed — Verity does not throw a kill switch it could not verify.
const LOCAL_BREAKER_READ =
  'the local worker\'s breaker read is "any OPEN work-item record carrying verity:circuit-open" (stage 85, ADR-0029)';

function verifyLocalOpenRecord(cwd, target) {
  let rec;
  try {
    rec = substrateLocal.readWorkItem(cwd, target);
  } catch (err) {
    return {
      ok: false,
      reason: `could not verify that work-item record #${target} is OPEN before opening the circuit (failing closed — the kill switch was NOT thrown): ${err?.message || String(err)}`,
    };
  }
  if (rec.state !== 'OPEN') {
    return {
      ok: false,
      reason: `work-item record #${target} is ${rec.state}; ${LOCAL_BREAKER_READ} — the label would be invisible to the worker, which would NOT have halted. Open the circuit on an OPEN record.`,
    };
  }
  return { ok: true };
}

function verifyOpenIssue(repo, target, opts) {
  let raw;
  try {
    raw = (opts.run || gh.run)(['api', apiBase(repo, target)], { cwd: opts.cwd });
  } catch (err) {
    return { ok: false, reason: unverifiedReason(target, err?.message || String(err)) };
  }
  let item;
  try {
    item = JSON.parse(raw);
  } catch (_err) {
    return {
      ok: false,
      reason: unverifiedReason(target, 'the GitHub read returned unparseable JSON'),
    };
  }
  // An item carrying a `pull_request` key is a PR, not an issue (both share the
  // issues endpoint — which is exactly why the label write would have succeeded).
  if (item?.pull_request) {
    return {
      ok: false,
      reason: `#${target} is a pull request; the worker's breaker query is ${BREAKER_QUERY}, which never sees PRs — the breaker would NOT have halted the worker. Open the circuit on an open ISSUE.`,
    };
  }
  if (item?.state !== 'open') {
    return {
      ok: false,
      reason: `issue #${target} is ${item?.state || 'not open'}; the breaker query ${BREAKER_QUERY} filters --state open — the label would be invisible to the worker, which would NOT have halted.`,
    };
  }
  return { ok: true };
}

function failReason(action, target, res) {
  const msg = res.error?.message ? res.error.message : String(res.error);
  return `${action} on #${target} failed: ${msg}`;
}

// Execute a label-op verb and shape its contract result. `effect`/`effects`
// always describe the INTENDED operation(s) (so a consumer sees what was
// attempted even on failure); ok/reason come from the run. The whole object is
// redacted before it leaves.
function performLabelOps(action, target, ops, opts, { singular, okReason }) {
  const intended = ops.map((o) => o.effect);
  // Stage 84 (stage-81 review finding 2): the substrate stamp rides in the
  // ghOpts bag ONLY on 'local' (where runOps dispatches on it) — a github
  // run's gh.run receives the same clean { cwd } bag it always did.
  const ghOpts =
    opts.substrate === 'local' ? { cwd: opts.cwd, substrate: 'local' } : { cwd: opts.cwd };
  const res = runOps(ops, opts.run || gh.run, ghOpts);
  const out = { schema: SCHEMA, action, target };
  if (singular) {
    out.effect = intended[0] ?? null;
  } else {
    out.effects = intended;
  }
  out.ok = res.ok;
  out.reason = res.ok ? okReason : failReason(action, target, res);
  return redactDeep(out);
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

// `run-once` — spawn `verity-worker --repo <repo> --once` (one deterministic
// tick) and RELAY the worker's own outcome under `effect`; it never models and
// makes no merge claim (contract invariant 7). Fail-closed: a spawn error or a
// non-zero worker exit ⇒ ok:false.
// Stage 85 (ADR-0029): on the LOCAL substrate the tick targets the LOCAL repo
// — the worker's gh sites are substrate-aware now, so the spawn additionally
// pins the worker's working directory with `--cwd <cwd>` (the record store,
// policy, and gate definitions live THERE; the --repo id remains the worker
// CLI's required run-naming pointer, recorded verbatim in the usage ledger and
// consulted by no gh call on local). The github spawn argv is byte-identical.
function runOnce(opts = {}) {
  const repo = opts.repo || null;
  const local = opts.substrate === 'local';
  const workerArgs = local
    ? ['--repo', repo, '--once', '--cwd', opts.cwd || process.cwd()]
    : ['--repo', repo, '--once'];
  const command = repo ? `verity-worker ${workerArgs.join(' ')}` : null;
  if (!repo) {
    return redactDeep({
      schema: SCHEMA,
      action: 'run-once',
      target: null,
      effect: { kind: 'worker-tick', command: null, exitCode: null, outcome: 'refused' },
      ok: false,
      reason: noRepoReason(),
    });
  }
  const spawn = opts.spawn || spawnSync;
  let res;
  try {
    res = spawn('verity-worker', workerArgs, { encoding: 'utf8' });
  } catch (err) {
    return redactDeep({
      schema: SCHEMA,
      action: 'run-once',
      target: null,
      effect: { kind: 'worker-tick', command, exitCode: null, outcome: 'spawn-error' },
      ok: false,
      reason: `failed to spawn verity-worker: ${err?.message ? err.message : String(err)}`,
    });
  }
  if (res?.error) {
    return redactDeep({
      schema: SCHEMA,
      action: 'run-once',
      target: null,
      effect: { kind: 'worker-tick', command, exitCode: null, outcome: 'spawn-error' },
      ok: false,
      reason: `failed to spawn verity-worker: ${res.error.message || String(res.error)}`,
    });
  }
  const exitCode = res && typeof res.status === 'number' ? res.status : null;
  const okRun = exitCode === 0;
  const outcome = okRun ? 'ok' : exitCode === null ? 'unknown' : 'failed';
  return redactDeep({
    schema: SCHEMA,
    action: 'run-once',
    target: null,
    effect: { kind: 'worker-tick', command, exitCode, outcome, summary: firstLine(res.stdout) },
    ok: okRun,
    reason: okRun
      ? 'verity-worker --once completed one deterministic tick (exit 0)'
      : `verity-worker --once did not complete cleanly (exit ${exitCode === null ? 'unknown' : exitCode})`,
  });
}

// --- approve: effect.consequence (stage 111 amendment, ADR-0037) -----------
//
// contracts/operator-act-v2.md § Schema: `effect.consequence` on `approve` is
// what the worker's NEXT tick does with the token, computed from the SAME
// inputs as the worker's gate copy — and decided by the SAME pure function
// (trust.approvalConsequence, which approvalHint words), so the act verb and
// the gate comment never disagree. The inputs, each read-only and bounded
// (gh.run's own per-call timeout; no write, no merge, no model):
//   - the effective policy (review trust, the review gate's name, the review
//     runtime's merge authority from the provider trust table, ADR-0031, and
//     the `humans:` list);
//   - the item's gate-comment trail → the LATEST gate pause the worker's BOT
//     posted and its parked pointer (the worker's own parsers). Stage 111
//     review F1: the act verb does not know the worker's bot login, so it
//     learns it from the worker host's local park records
//     (~/.verity/logs/<run>/park.json): the bot is the author of a gate
//     comment whose pointer matches a record exactly and whose record names
//     that author. A trail with no such comment (forged, edited, or read on a
//     host without the records) authenticates nothing ⇒ 'unknown';
//   - the parked review result's verdict (~/.verity/logs, the file the
//     worker's resume re-reads) and the pointer's own park record;
//   - the PR's current head vs the pointer's recorded head;
//   - for an approve verdict (round 3, N1b), the PR's timeline: any push at
//     or after the review's pre-dispatch head read (park record
//     `head_read_at`) ⇒ the worker re-reviews ('re-review');
//   - at trust 0 for an approve verdict, the item's label timeline (review
//     F3/F4): the worker honours the label only when its latest `labeled`
//     event is newer than that gate comment, by an actor that is not the bot
//     (and is in `humans:` when set) — else the token cannot merge ('gate').
// Any input that cannot be read ⇒ 'unknown' — never a guess. The checks
// reading is deliberately NOT taken: no consequence value depends on it
// (merge-when-green already means "merges once CI is green"), so reading it
// would only add a way to be unknown.
function errText(err) {
  return firstLine(err?.message || String(err)) || 'no detail';
}

function unknownConsequence(detail) {
  return { consequence: 'unknown', detail };
}

function readTrail(repo, target, run, cwd) {
  const all = [];
  for (let page = 1; page <= TRAIL_MAX_PAGES; page += 1) {
    const raw = run(
      ['api', `${apiBase(repo, target)}/comments?per_page=${TRAIL_PER_PAGE}&page=${page}`],
      { cwd },
    );
    const batch = JSON.parse(raw);
    if (!Array.isArray(batch)) {
      throw new Error('the comment read returned no comment list');
    }
    all.push(...batch);
    if (batch.length < TRAIL_PER_PAGE) {
      break;
    }
  }
  return all;
}

function readPrHead(repo, pr, run, cwd) {
  const view = JSON.parse(run(['api', `repos/${repo}/pulls/${pr}`], { cwd }));
  const sha = view?.head?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{6,40}$/.test(sha)) {
    throw new Error('the PR read carried no head SHA');
  }
  return sha.toLowerCase();
}

// Stage 111 review F1: the worker bot's login, learned from the local park
// records (see above), or null when no gate comment on the trail is
// authenticated by one. Newest first; an unreadable record authenticates
// nothing (skipped).
function authenticatedBot(trail, worker, readRecord) {
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const c = trail[i];
    const author = c?.user?.login;
    if (
      typeof c?.body !== 'string' ||
      typeof author !== 'string' ||
      author === '' ||
      !c.body.startsWith(worker.GATE_COMMENT_PREFIX)
    ) {
      continue;
    }
    const { pointer } = worker.parseGatePause(c.body);
    if (pointer === null) {
      continue;
    }
    let rec;
    try {
      rec = readRecord(pointer.runId);
    } catch {
      continue;
    }
    if (rec !== null && worker.parkRecordMismatch(rec, pointer, author) === null) {
      return rec.bot;
    }
  }
  return null;
}

function approveConsequence(repo, target, opts) {
  // Lazy: only this verb's prediction needs the worker's parsers/resolvers;
  // every other verb's load path is unchanged.
  const worker = require('../../worker/index.cjs');
  const trust = require('./trust.cjs');
  const tiers = require('./agents/tiers.cjs');
  if (opts.substrate === 'local') {
    return unknownConsequence(
      'the local substrate has no comment trail to read a parked review verdict from (contract local-work-item v1)',
    );
  }
  const cwd = opts.cwd || process.cwd();
  const run = opts.run || gh.run;
  const readRecord = opts.readParkRecord || worker.readParkRecord;
  // Stage 111 review F9: every resolution that can throw sits inside the try,
  // so a failure AFTER the label write reports `unknown`, never a failed verb.
  let policy;
  let trustLevel;
  let reviewGate;
  let provider;
  let mergeAuthority;
  try {
    policy = opts.policy || require('./autonomy.cjs').loadPolicy(cwd);
    trustLevel = policy?.review?.trust;
    reviewGate = worker.gateNameFor('review', policy);
    provider = worker.resolveEffectiveAgent(policy).agentForRole('review').provider;
    const entry = tiers.getTier(provider);
    mergeAuthority = entry !== null && entry.merge_authority === true;
  } catch (err) {
    return unknownConsequence(
      `the autonomy policy could not be read or resolved (${errText(err)})`,
    );
  }

  let trail;
  try {
    trail = readTrail(repo, target, run, cwd);
  } catch (err) {
    return unknownConsequence(
      `#${target}'s gate-comment trail could not be read (${errText(err)})`,
    );
  }
  const anyPause = trail.some(
    (c) => typeof c?.body === 'string' && c.body.startsWith(worker.GATE_COMMENT_PREFIX),
  );
  if (!anyPause) {
    return unknownConsequence(`#${target} carries no gate pause to evaluate this approval against`);
  }
  const bot = authenticatedBot(trail, worker, readRecord);
  if (bot === null) {
    return unknownConsequence(
      `no gate comment on #${target} is authenticated by a local park record on this host — the worker's bot identity cannot be established here, and a gate comment is never trusted by its text (stage 111)`,
    );
  }
  const pause = worker.latestGatePause(trail, bot);
  if (pause === null) {
    return unknownConsequence(
      `#${target} carries no gate pause by ${bot} to evaluate this approval against`,
    );
  }
  if (pause.gate !== reviewGate || (pause.pointer !== null && pause.pointer.role !== 'review')) {
    return unknownConsequence(
      `#${target}'s latest gate is \`${pause.gate ?? '(unnamed)'}\`, not a completed review's ${reviewGate} park — the engine predicts only the review merge decision`,
    );
  }
  const decide = (inputs, detail) => ({
    consequence: trust.approvalConsequence({ trust: trustLevel, mergeAuthority, ...inputs }),
    detail,
  });
  if (!mergeAuthority) {
    return decide(
      { verdict: null, resumable: false },
      `the review runtime '${provider}' has no merge authority (ADR-0031) — a verdict from it never merges`,
    );
  }
  const pointer = pause.pointer;
  if (pointer === null) {
    return decide(
      { verdict: null, resumable: false },
      `the ${reviewGate} pause on #${target} recorded no parked review verdict — the approval buys a fresh review`,
    );
  }

  let record;
  try {
    record = readRecord(pointer.runId);
  } catch (err) {
    return unknownConsequence(
      `the local park record of run ${pointer.runId} could not be read (${errText(err)})`,
    );
  }
  if (record === null) {
    return unknownConsequence(
      `the local park record of run ${pointer.runId} is not on this host (~/.verity/logs) — the pointer cannot be verified here`,
    );
  }
  const mismatch = worker.parkRecordMismatch(record, pointer, bot);
  if (mismatch !== null) {
    return decide(
      { verdict: null, resumable: false },
      `the ${reviewGate} pointer on #${target} is not honoured (${mismatch}) — the approval buys a fresh review`,
    );
  }

  let parked;
  try {
    const read = opts.readParkedResult || require('./agent-exec.cjs').readParkedResult;
    parked = read({ 'run-id': pointer.runId, role: pointer.role, agent: provider });
  } catch (err) {
    return unknownConsequence(
      `the parked review result of run ${pointer.runId} could not be read (${errText(err)})`,
    );
  }
  if (parked === null || parked === undefined) {
    return unknownConsequence(
      `the parked review result of run ${pointer.runId} is not on this host (~/.verity/logs) — its verdict cannot be read here`,
    );
  }
  const verdict =
    parked.outcome === 'success' && typeof parked.artifacts?.verdict === 'string'
      ? parked.artifacts.verdict.toLowerCase()
      : null;
  if (verdict === null || verdict === '') {
    return decide(
      { verdict: null, resumable: false },
      `the parked review result of run ${pointer.runId} carries no completed verdict — the approval buys a fresh review`,
    );
  }
  if (!/^[0-9a-f]{6,40}$/.test(pointer.head)) {
    return decide(
      { verdict, resumable: false },
      `the parked '${verdict}' verdict recorded no verifiable head at park time`,
    );
  }
  let head;
  try {
    head = readPrHead(repo, pointer.pr, run, cwd);
  } catch (err) {
    return unknownConsequence(
      `PR #${pointer.pr}'s current head could not be read (${errText(err)})`,
    );
  }
  if (head !== pointer.head) {
    return decide(
      { verdict, resumable: false },
      `PR #${pointer.pr}'s head moved since the '${verdict}' verdict parked (${pointer.head} → ${head})`,
    );
  }
  // Stage 111 review round 3 (N1b): the worker honours a parked APPROVE
  // verdict only when the MERGE TARGET's timeline (PR #pointer.pr) shows no
  // push since the review's pre-dispatch head read (worker.pushesSince, the
  // same pure judgement). A push, or a record with no read time, makes the
  // worker refuse the resume and buy a fresh review ⇒ 're-review'; a timeline
  // that cannot be read here ⇒ 'unknown'.
  let prEvents = null;
  if (verdict === 'approve') {
    const since = record.head_read_at;
    if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) {
      return decide(
        { verdict, resumable: false },
        `the parked '${verdict}' verdict's park record carries no time for the review's pre-dispatch head read — a later push cannot be ruled out, so the worker re-reviews`,
      );
    }
    try {
      prEvents = worker.readTimeline(repo, pointer.pr, (args) => JSON.parse(run(args, { cwd })));
    } catch (err) {
      return unknownConsequence(
        `PR #${pointer.pr}'s timeline could not be read to rule out a push after the review's head read (${errText(err)})`,
      );
    }
    const pushes = worker.pushesSince(prEvents, { since, head: pointer.head });
    if (!pushes.ok) {
      return decide(
        { verdict, resumable: false },
        `PR #${pointer.pr} was pushed to after the review read its head (${pushes.reason}) — the parked '${verdict}' verdict may describe another head, so the worker re-reviews`,
      );
    }
  }
  // Stage 111 review F3/F4: at trust 0 the label IS the merge decision, so
  // predict exactly what the worker will judge from the same timeline (the
  // item's; read once when the item is the PR itself).
  let approverTrusted = true;
  let approverNote = '';
  if (trustLevel === 0 && verdict === 'approve') {
    let events = pointer.pr === Number(target) ? prEvents : null;
    if (events === null) {
      try {
        events = worker.readTimeline(repo, target, (args) => JSON.parse(run(args, { cwd })));
      } catch (err) {
        return unknownConsequence(
          `#${target}'s label timeline could not be read (${errText(err)})`,
        );
      }
    }
    const judged = worker.judgeApprovalEvent(events, {
      gateAt: pause.createdAt,
      botLogin: bot,
      humans: policy.humans,
    });
    approverTrusted = judged.ok;
    if (!judged.ok) {
      approverNote = ` — but the worker will not honour this label as the merge decision: ${judged.reason}; it re-gates the verdict at zero cost instead`;
    }
  }
  return decide(
    { verdict, resumable: true, approverTrusted },
    `parked '${verdict}' verdict on PR #${pointer.pr}'s unchanged head ${head}, review trust ${trustLevel}${
      trustLevel === 1 || trustLevel === 2
        ? ' — the ladder re-evaluates it (risk / checks, which this verb does not read) and may merge'
        : ''
    }${approverNote}`,
  );
}

// Perform one allowlisted verb. `args` are the tokens AFTER the verb (for
// `circuit` that is [sub, target]; otherwise [target]). `opts`: { repo, cwd, run,
// spawn, note } — `run`/`spawn` are the injection seams (default to gh.run /
// spawnSync). Unknown verb ⇒ a hard allowlist error (invariant 2).
function act(verb, args, opts = {}) {
  if (!VERBS.includes(verb)) {
    throw new Error(
      `unknown operator act verb: '${verb ?? ''}' — allowed verbs: ${VERBS.join(', ')}`,
    );
  }

  // Stage 80 (ADR-0029): resolve the delivery substrate ONCE, before any verb
  // logic — from the same stage-79 policy accessor every other consumer reads
  // (injectable via opts.substrate for tests). 'github' and an unreadable
  // policy leave every line below byte-identical.
  const substrate =
    opts.substrate === undefined
      ? substrateLocal.resolveSubstrate(opts.cwd || process.cwd())
      : opts.substrate;
  const acting = { ...opts, substrate };

  const repo = opts.repo || null;

  // Stage 85 (ADR-0029; stage-83 review): the stage-80/84 blanket refusal for
  // `run-once`/`circuit` on local is LIFTED — the underlying capabilities now
  // exist. The worker's gh sites are substrate-aware (preflight/identity
  // skipped honestly, breaker read from OPEN records carrying
  // `verity:circuit-open`, comments routed to the run log + usage ledger), so
  // `run-once` drives a genuinely GitHub-free tick, and `circuit open/close`
  // arms/disarms the exact record-label breaker the local worker now consults
  // (the same derivation stage 84's snapshot uses for autonomy.circuit_open).
  // What is still impossible keeps refusing with an updated honest reason:
  // the comment half of request-changes (performLocalOp — contract v1 has no
  // comment surface).

  // THE REPO CHOKE POINT (stage 52, #135). It lives HERE, at the point of use,
  // and NOT inside resolveRepo: resolveRepo is bypassed whenever a caller
  // passes opts.repo (operator.cjs's delegation, the test seam), so a validator
  // living there would be provably incomplete. Every verb — including run-once,
  // which hands the repo to the worker's argv — passes through this line before
  // any gh.run, any breaker precondition read, and any spawn.
  if (repo !== null && !gh.isRepoSlug(repo)) {
    return refused(actionLabel(verb, args), targetOf(verb, args), badRepoReason(repo));
  }

  if (verb === 'run-once') {
    // No repository resolved: refuse with the SAME shape every other verb uses
    // (ok:false, effect:null) — nothing was spawned, so there is no worker-tick
    // to report.
    if (!repo) {
      return refused('run-once', null, noRepoReason());
    }
    // Stage 85: `acting` carries the resolved substrate, so a local tick pins
    // the worker's --cwd; a github tick spawns the byte-identical argv.
    return runOnce(acting);
  }

  if (verb === 'circuit') {
    const sub = args[0];
    if (sub !== 'open' && sub !== 'close') {
      return refused(
        'circuit',
        null,
        'operator act circuit requires a subcommand: verity operator act circuit open|close <n>',
      );
    }
    const action = `circuit ${sub}`;
    const target = parseTarget(args[1]);
    if (target === null) {
      return refused(action, null, targetUsage(action, args[1]));
    }
    // Stage 85 (ADR-0029): on the local substrate the breaker is a work-item
    // RECORD label addressed by number under opts.cwd — no owner/name
    // repository exists to name (the same rule the single-target verbs below
    // adopted in stage 80), so the no-repo refusal is github-only.
    if (!repo && substrate !== 'local') {
      return refused(action, target, noRepoReason());
    }
    // `circuit open` must PROVE it can actually halt the worker before it
    // claims to. `circuit close` is DELIBERATELY NOT GATED and must stay that
    // way: refusing to REMOVE a halt label is not fail-closed, and gating it
    // would strand a verity:circuit-open label that a pre-fix build already
    // applied to a PR or a closed issue with no way to clear it. Do not "fix"
    // this asymmetry into symmetry — a test pins it. Stage 85: the local
    // precondition proves the SAME thing against the local breaker read (an
    // OPEN record — verifyLocalOpenRecord above); close stays ungated on both
    // substrates (the local removeLabel is idempotent on absence by
    // construction, stage 80).
    if (sub === 'open') {
      const pre =
        substrate === 'local'
          ? verifyLocalOpenRecord(opts.cwd || process.cwd(), target)
          : verifyOpenIssue(repo, target, opts);
      if (!pre.ok) {
        return refused(action, target, pre.reason);
      }
    }
    const ops =
      sub === 'open'
        ? [opAddLabel(repo, target, CIRCUIT_OPEN)]
        : [opRemoveLabel(repo, target, CIRCUIT_OPEN)];
    const okReason =
      sub === 'open'
        ? `opened the circuit breaker on #${target} (${CIRCUIT_OPEN}) — the worker halts, fail-closed`
        : `closed the circuit breaker on #${target} (removed ${CIRCUIT_OPEN}) — the worker may resume`;
    return performLabelOps(action, target, ops, acting, { singular: true, okReason });
  }

  // Single-target verbs.
  const target = parseTarget(args[0]);
  if (target === null) {
    return refused(verb, null, targetUsage(verb, args[0]));
  }
  // Stage 80: the local substrate addresses work-item RECORDS by number under
  // opts.cwd — there is no owner/name repository to name, so the no-repo
  // refusal is a github-path precondition only (the gh argv below is built but
  // never run on 'local'; runOps dispatches on the effect instead).
  if (!repo && substrate !== 'local') {
    return refused(verb, target, noRepoReason());
  }

  if (verb === 'approve') {
    const out = performLabelOps('approve', target, [opAddLabel(repo, target, APPROVED)], acting, {
      singular: true,
      okReason: `applied ${APPROVED} to #${target}`,
    });
    if (!out.ok) {
      return out; // the token was not applied — nothing to predict (reason unchanged)
    }
    // Stage 111 amendment (ADR-0037, contracts/operator-act-v2.md § Schema):
    // report what the worker's NEXT tick does with the token. Read-only, and
    // only AFTER the one write succeeded — this verb still performs exactly
    // one write and never merges (v2 invariant 1).
    const { consequence, detail } = approveConsequence(repo, target, acting);
    out.effect.consequence = consequence;
    // (Never the word "token" here: ledger.redact treats `token …` as a
    // credential line and would redact the rest of the reason.)
    out.reason = `applied ${APPROVED} to #${target} — the worker's trust ladder decides what this approval does on its next tick (consequence: ${consequence} — ${detail})`;
    return redactDeep(out);
  }

  if (verb === 'reject') {
    // A label-swap in effect-order: decline (remove the resume token + the
    // awaiting gate), then park for a human.
    const ops = [
      opRemoveLabel(repo, target, APPROVED),
      opRemoveLabel(repo, target, AWAITING),
      opAddLabel(repo, target, NEEDS_HUMAN),
    ];
    return performLabelOps('reject', target, ops, acting, {
      singular: false,
      okReason: `declined #${target}: removed ${APPROVED} + ${AWAITING}, applied ${NEEDS_HUMAN} (parked for a human; not a merge)`,
    });
  }

  if (verb === 'request-changes') {
    const note =
      typeof opts.note === 'string' && opts.note !== '' ? opts.note : DEFAULT_REWORK_NOTE;
    const ops = [opAddLabel(repo, target, NEEDS_HUMAN), opComment(repo, target, note)];
    return performLabelOps('request-changes', target, ops, acting, {
      singular: false,
      okReason: `requested changes on #${target}: applied ${NEEDS_HUMAN} and posted a rework comment`,
    });
  }

  if (verb === 'needs-human') {
    return performLabelOps('needs-human', target, [opAddLabel(repo, target, NEEDS_HUMAN)], acting, {
      singular: true,
      okReason: `applied ${NEEDS_HUMAN} to #${target} — parked for a human`,
    });
  }

  if (verb === 'clear-needs-human') {
    return performLabelOps(
      'clear-needs-human',
      target,
      [opRemoveLabel(repo, target, NEEDS_HUMAN)],
      acting,
      {
        singular: true,
        okReason: `removed ${NEEDS_HUMAN} from #${target} — unparked`,
      },
    );
  }

  // Unreachable — VERBS gate above is exhaustive.
  throw new Error(`unhandled operator act verb: ${verb}`);
}

// CLI: `verity operator act <verb> [target] [--note S] [--repo owner/name]
// [--json]`. `opts` (3rd arg) is the injection seam for tests — { run, spawn,
// repo, cwd, note } override the flag-derived values. A failed act returns
// ok:false; verity.cjs maps that to a non-zero exit (fail-closed).
function dispatch(args, flags = {}, opts = {}) {
  const verb = args[0];
  const merged = {
    cwd: opts.cwd || flags.cwd || process.cwd(),
    repo: opts.repo !== undefined ? opts.repo : resolveRepo(flags),
    run: opts.run,
    spawn: opts.spawn,
    note: opts.note !== undefined ? opts.note : flags.note,
  };
  return act(verb, args.slice(1), merged);
}

module.exports = {
  SCHEMA,
  VERBS,
  act,
  dispatch,
  resolveRepo,
  parseTarget,
};
