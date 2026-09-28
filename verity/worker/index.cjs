#!/usr/bin/env node
// verity-worker — the autonomy orchestrator bin (T10, SKETCH §4).
//
//   verity-worker --repo owner/name --once        # cron / Actions driver
//   verity-worker --repo owner/name --watch       # T17 — exits 30 "not-implemented"
//
// One --once run is the §4.4 state machine, exactly:
//   select item (scanner §4.2) → acquire lock (§4.3) → loop {
//     plan = `verity next` (module API — ground truth every iteration);
//     idle → SUMMARIZE(success); gated → GATE_PAUSE;
//     limits (max_chained_roles / max_tokens_per_run / max_wall_clock_min)
//       → SUMMARIZE(limit_hit);
//     no-progress strike (stage 19): the same role at the same GitHub target
//       for the MAX_REPEAT_DISPATCHES'th time — counted ACROSS ticks from the
//       item's own §7 run-summary trail plus within this run — → needs-human
//       label + SUMMARIZE(failed), BEFORE any dispatch, so the refused tick
//       costs zero model runs;
//     res = agent-exec role (module API);
//     gated → GATE_PAUSE; failed → 2-strike via unlock-comment counting
//       (locks.countFailures + 1 for the current strike) → needs-human label +
//       SUMMARIZE(failed), else SUMMARIZE(failed_once) — and when the failed
//       role's cost is UNKNOWN under unknown_cost_behavior 'gate', the run
//       ALSO parks at the unknown-cost gate (stage 25: label + comment +
//       gate-stamped ledger rows, so the next tick's budget refusal stays
//       visible and approvable instead of wedging the day);
//     infra_error → SUMMARIZE(infra), NO needs-human;
//     est_usd null (unknown cost, ADR-0008) → limits.unknown_cost_behavior:
//       gate → GATE_PAUSE; fail → SUMMARIZE(failed); allow_with_token_limit
//       → proceed (token ceilings remain the bound; null NEVER counts as $0);
//     success → loop }
// Stage 9 (ADR-0005/0007): the run resolves ONE immutable agent config from
// the policy's `agent` block (provider claude|codex, model, sandbox/approval
// narrowing overrides) and passes it — plus the REMAINING wall-clock budget
// as --timeout-secs, shrinking monotonically — into every chained dispatch.
// plus the T13 trust ladder (§4.5): when the REVIEW role completes with
// outcome success, its verdict (`artifacts.verdict` in the T05 marker —
// 'approve' | 'request_changes') is applied deterministically HERE:
//   trust 0 → never merge autonomously (gate) — stage 111: the consumed
//   `verity:approved` on a resumed review:merge park IS the human merge
//   decision, so approve + approval + checks green merges; trust 1 →
//   trust.classify() low-risk → `gh pr merge --squash`, else gate; trust 2 →
//   merge if checks green.
// Merge authority lives in this worker, never in the review agent — the
// review allowlist (T06) has no merge tool, and a success WITHOUT an explicit
// approve verdict gates (fail closed; it never merges and never loops).
// And two deliberate, documented extensions of the frozen sketch:
//   - a P4 request's FIRST iteration dispatches role `plan` on the request
//     issue (the dependency engine knows stages, not requests — without this a
//     fresh request would read as idle and never get planned);
//   - a role result of `gated` (the agent-exec marker outcome) routes to
//     GATE_PAUSE too; the §4.4 listing omits the branch but agent-exec defines
//     gated as "a human gate blocks progress", and looping on it would spin.
//
// Stage 20 (issue #60): `verity next` can also report that it could not READ
// GitHub state at all (gate `state:unverified`). That is NOT a human gate and
// does not take GATE_PAUSE — labeling and commenting would write to the very
// API that just failed. It stops the run as `infra` (exit 30) from the loop, or
// refuses at startup with slug `state-unverified` when the scan found nothing:
// a wasted model run against a state nobody verified is strictly worse than a
// clear stop, and an idle exit 0 would read as "all quiet".
//
// Stage 19 (issue #50): `verity next` now distinguishes a PR whose CI is RED
// from one whose CI is UNVERIFIABLE (no checks reported at all — the repository
// may have no CI). The latter arrives here as a plain `gated` decision at gate
// `ci:unverified`. When a labeled tier (P1–P4) selected the item, the run loop
// routes it through GATE_PAUSE below like any other gate; when ONLY the P5
// dependency engine can see the stage, the scanner yields no item — canary run
// 3 parked there as plain `idle`, invisibly — so runOnce announces the gate
// itself through the same GATE_PAUSE + SUMMARIZE machinery before the empty
// scan can read as idle (stage 22, issue #59). `verity next` marks a
// label-derived gate `announced: true`, so an already-visible pause is never
// re-announced on every cron tick. Either way nothing new is duplicated and
// nothing merges on unverified CI. A P1 item —
// one whose single-use `verity:approved` token this run consumes — passes
// `unverified-ci: allow_without_merge` into that call, because the human
// decision the gate asks for has just been made, for this run only.
//
// Stage 24 (ADR-0013): under containment a role computes; Verity talks to
// GitHub. Two seams, both here because this worker is the dispatcher:
//   - PRE-DISPATCH: `verity next` is asked for the FACTS a contained role's
//     workflow needs (opts.withFacts — stage status, the next list,
//     dependency/PR/CI state), derived from the SAME verified snapshot the
//     dispatch decision came from (stage 20 stays binding), and passed to
//     agent-exec as --state-snapshot for codex dispatches only. Claude
//     dispatches are byte-identical — its harness reads GitHub itself.
//   - POST-DISPATCH: performResultEffects() performs the GitHub writes a
//     role's T05 marker DECLARES (`artifacts.effects`, additive and
//     DEFAULT-CLOSED: absent field = nothing performed). Recognized today:
//     `findings_comment` — the review findings body, posted on the PR with the
//     run id (mirroring ADR-0012's attributable commits). An effect the worker
//     does not recognize is ignored with a logged note — never executed, never
//     guessed at, never fatal. Merge authority is NOT an effect: the trust
//     ladder below stays the only merge path.
//
// GATE_PAUSE: label `verity:awaiting-approval`, comment what's pending + the
// exact approval action + @mentions from notify.mention → SUMMARIZE(gated).
// The label + comment go on the gate's GitHub TARGET (the issue/PR from the
// dispatch decision — for review:merge that is the PR), falling back to the
// run's anchor when the target is a bare stage. This is where the human is
// told to approve, so it is where `verity next` reads the gate from (T03/T14):
// labeling only the anchor (e.g. the originating request issue) left the gate
// invisible to the dependency engine — the worker re-selected the gated PR and
// re-ran review every tick (found by the T14 integration run; fixed there).
//
// Stage 31 (ADR-0014): the unknown-cost gate is a checkpoint, not a toll
// booth. When a role COMPLETES and parks at the unknown-cost gate, its T05
// result already persists under ~/.verity/logs/<run-id>/ — so the gate comment
// records a durable pointer (run id + role + PR + the PR's head SHA at park
// time), and consuming the single-use `verity:approved` RESUMES that exact
// result through the post-role path (trust ladder, §7 summary) with zero
// provider spawns, zero new tokens, and a VERIFIED zero cost on its ledger
// rows. Effects (ADR-0013) are NOT re-performed — they ran before the park.
// Fail-closed both ways: a moved PR head, a missing/unreadable parked file, or
// a non-success parked outcome refuses the resume LOUDLY and falls back to a
// fresh dispatch announced as a repurchase — an approval is never a no-op.
// Pre-completion gates (ci:unverified, role-declared) and the stage-25
// failed-run park record no pointer and keep their semantics byte-for-byte;
// claude never parks here (its costs are real numbers).
//
// Stage 111 (ADR-0014 amended 2026-09-27, #291/#292): a review:merge park made
// after a COMPLETED review with a verdict is a post-completion park too, so it
// records the same pointer (any provider). Its approval resumes the recorded
// verdict on an unchanged head at zero cost; at trust 0 that approval is the
// human merge decision (approve + green → merge, the token consumed by the
// merge; approve + not green → re-gate, the token LEFT for the next tick), and
// any other verdict re-gates at zero cost. Its approve line is approvalHint's
// configuration-true copy, never the bare "apply label".
//
// Stage 111 review (REQUEST CHANGES) — the merge-on-approval path merges only a head a
// review examined, on a decision a human made after seeing it:
//   F1  a gate comment is a pause only if the worker's BOT wrote it (unknown
//       bot identity ⇒ no pointer at all), and a pointer resumes only if it
//       matches the local park record (~/.verity/logs/<run>/park.json) the
//       worker wrote when it posted it — a forged or edited pointer re-reviews;
//   F2  a review's pointer anchors to the PR head read BEFORE the review ran;
//       round 3 (N1): a head that moved by park time records NO resumable
//       pointer, and a resumed approve verdict is refused (fresh review) when
//       the PR's timeline shows any push at/after that read (GitHub's own
//       `updatedAt` from the read vs the events' `created_at` — an A→B→A
//       inside the review window is caught; unreadable ⇒ no merge);
//   F3/F4 the label merges only if its latest `labeled` event (issue
//       timeline) is newer than the bot gate comment it answers, by an actor
//       that is not the bot and, when `humans:` is set, is listed there — else
//       the verdict re-gates at zero cost and the stale label is consumed;
//   F6  an approved merge that does not land (CI red, GitHub refusal) retries
//       without new gate comments, at most MAX_APPROVED_MERGE_ATTEMPTS ticks
//       per parked verdict (round 3, N4: no label, refused or honoured,
//       restarts the count), then parks `verity:needs-human`;
//   F11 a verdict naming a PR other than the one the review was dispatched for
//       is never acted on (round 3, N2: its findings land on the dispatched PR).
//
// SUMMARIZE posts the §7 run-summary comment (exact template, one append-only
// comment per run), calls the T11 recordUsage seam, and the lock is released
// in `finally` (§8.1). P1 items consume `verity:approved` before working (§1
// single-use token); the gate label comes off with it, otherwise `verity next`
// would immediately re-gate the just-approved item.
//
// Items: only kind issue|pr can carry a GitHub lock/labels/comments. A P5
// 'stage' target (no work-item issue yet) proceeds WITHOUT a GitHub lock; the
// summary anchors to the first issue/PR target the loop discovers, or falls
// back to stdout.
//
// Exit codes: success/gated/limit_hit → 0; failed/failed_once → 20; infra → 30.
// idle / locked-by-another-run / mode:manual → 0 (§8.5: a second concurrent
// start exits 0 within one scan). Every nonzero exit prints exactly one
// machine-parsable stderr line: `verity-worker: <code> <slug>: <message>` (§8.2).
//
// Startup (§4.1, T11+T12): the full fail-fast check sequence runs BEFORE
// scanning/locking and is read-only (no labels/comments). Order — local checks
// first so a refused start costs zero gh calls, then the network checks:
//   1. policy loads + validates              → 30 `bad-policy`
//   2. mode manual → "autonomy disabled"     → exit 0
//   3. daily limits (usage.csv, UTC, T11)    → 30 `daily-limit`
//      ...or, when a max_usd_per_day is set and today's ledger holds runs of
//      unknown cost, the budget cannot be VERIFIED (ADR-0008, stage 18)
//                                            → 30 `unknown-cost-budget`
//      ...UNLESS every such run ended parked at the unknown-cost gate
//      (stage 21, #58): then the refusal is deferred past the scan, and a P1
//      item's single-use `verity:approved` — the approval that gate's own
//      comment asked for — lets exactly that one run proceed. No P1 item →
//      the deferred refusal fires unchanged (still before any lock or label).
//   4. `gh auth status`                      → 30 `gh-auth`
//   5. bot identity (`gh api user`; lookup failure → `gh-auth`);
//      bot login ∈ policy humans (case-insensitive — GitHub logins are)
//                                            → 30 `bot-is-human`
//   6. any OPEN issue labeled verity:circuit-open (or breaker unreadable —
//      fail closed)                          → 30 `circuit-open`
// Every gh call the run makes targets the --repo repository (GH_REPO, set in
// runOnce — stage 29), never a cwd-derived remote: a clone with no remotes
// gets PAST the breaker check and refuses later, truthfully, as
// `git-unprovidable` (ADR-0012); `circuit-open` stays reserved for the actual
// kill switch and for genuine breaker-READ failures.
const agentExec = require('../bin/lib/agent-exec.cjs');
// Stage 94 (ADR-0031): the engine-owned provider TRUST table. Every containment
// decision below that used to ask "is this provider codex?" now asks the table
// what the provider's profile IS — and an un-tiered provider is refused.
const tiers = require('../bin/lib/agents/tiers.cjs');
const autonomy = require('../bin/lib/autonomy.cjs');
const gates = require('../bin/lib/gates.cjs');
const gh = require('../bin/lib/gh.cjs');
const { LABELS } = require('../bin/lib/labels.cjs');
const ledger = require('../bin/lib/ledger.cjs');
const locks = require('../bin/lib/locks.cjs');
const next = require('../bin/lib/next.cjs');
const scanner = require('../bin/lib/scanner.cjs');
const stage = require('../bin/lib/stage.cjs');
const substrateLocal = require('../bin/lib/substrate-local.cjs');
const trust = require('../bin/lib/trust.cjs');
// approvalHint's `trust` parameter shadows the module; the shared decision is
// bound here once (stage 111 amendment, ADR-0037).
const { approvalConsequence } = trust;
const usage = require('../bin/lib/usage.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE = 'usage: verity-worker --repo owner/name --once';
// The approval line of every gate EXCEPT a completed review's review:merge park
// (ci:unverified, unknown-cost, role-declared, pre-dispatch label gates): there
// the label genuinely advances the item, so the bare instruction is true.
const APPROVAL_ACTION = 'apply label `verity:approved`';

// Stage 111 (ADR-0014 amended 2026-09-27, #291): the review:merge park's
// approval line must be TRUE for its configuration — "apply label" appears only
// where the label can advance the item. Used by the trust-ladder gate comment
// AND its §7 summary. Inputs: the review trust, the verdict, the green reading
// (true | false | null = not read), whether the verdict's runtime has merge
// authority (ADR-0031), and whether this gate already holds a consumed-for-
// merge approval the worker deliberately left in place (trust 0, CI not green).
// Stage 111 amendment (ADR-0037, contracts/operator-act-v2.md): WHAT the
// approval does is decided once, by trust.approvalConsequence — the same pure
// function `verity operator act approve` reports as `effect.consequence` — and
// this function only words it, so the gate copy and the act verb can never
// disagree for the same inputs.
function approvalHint({
  trust,
  verdict,
  greenKnown = null,
  mergeAuthority,
  approved = false,
  hasPr = true,
  resumable = true,
}) {
  const consequence = approvalConsequence({
    trust,
    verdict,
    mergeAuthority,
    hasPr,
    resumable,
  });
  const hasVerdict = typeof verdict === 'string' && verdict !== '';
  if (consequence === 'gate') {
    if (mergeAuthority !== true) {
      return 'merge on GitHub; a verdict from this runtime never merges';
    }
    if (verdict === 'escalate') {
      return 'architectural / frozen-contract blocker: resolve via /verity:plan; approval does not merge';
    }
    return 'merge on GitHub; an unknown trust level fails closed and never merges';
  }
  if (consequence === 're-review') {
    const noPointer =
      'this park has no resumable pointer, so any approval re-reviews at full price';
    if (!hasVerdict) {
      // No verdict at all leaves no resumable pointer, so approval re-reviews.
      return 'the review reported no verdict: apply `verity:approved` to re-review (a fresh review at full price), or merge on GitHub';
    }
    if (verdict === 'request_changes') {
      return `the review asked for changes: push a fix (new head) and apply \`verity:approved\` to re-review, or merge on GitHub; ${noPointer}`;
    }
    if (verdict !== 'approve') {
      return `the review verdict '${verdict}' is not approve: push a fix (new head) and apply \`verity:approved\` to re-review, or merge on GitHub; ${noPointer}`;
    }
    if (hasPr !== true) {
      return 'merge on GitHub; the approve verdict named no PR, so Verity cannot act on it — an approval only buys a fresh review at full price';
    }
    if (trust === 0) {
      // No verifiable parked pointer (an unreadable head, or the local
      // substrate's missing comment trail): an approval can only buy a fresh
      // review, which gates again — it can never complete this merge.
      return 'merge the PR yourself, or apply `verity:approved` to re-review at full price — this park has no resumable pointer, so an approval cannot merge';
    }
    return `merge on GitHub, or apply \`verity:approved\` to re-review at full price — ${noPointer}`;
  }
  if (consequence === 'resume') {
    // v2 `resume`: a parked NON-approve verdict re-gates at zero cost.
    if (verdict === 'request_changes') {
      return 'the review asked for changes: push a fix (new head) and apply `verity:approved` to re-review, or merge on GitHub; approving the unchanged head re-gates at zero cost';
    }
    // A recorded verdict string re-gates at zero cost on an unchanged head.
    return `the review verdict '${verdict}' is not approve: push a fix (new head) and apply \`verity:approved\` to re-review, or merge on GitHub; approving the unchanged head re-gates at zero cost`;
  }
  if (consequence === 'unknown') {
    // Stage 111 review F5: trust 1/2 + approve + a resumable head. The resumed
    // verdict re-enters the ladder, which MAY merge it — never say "re-gates".
    if (trust === 1) {
      return 'merge on GitHub, or apply `verity:approved` to re-run the trust ladder on this approve verdict at zero cost — at trust 1 it merges only a low-risk PR with green checks; an approval never overrides the risk classification';
    }
    return 'CI is not green; apply `verity:approved` once it is to re-run the trust ladder on this approve verdict at zero cost — it merges if checks are green by then (or merge on GitHub)';
  }
  // merge-when-green: trust 0, approve verdict, a resumable pointer. Stage 111
  // review F3/F4: the worker honours only a label applied AFTER this comment,
  // by an account that is not its bot (and is listed in `humans:` when set).
  if (greenKnown === false) {
    return approved === true
      ? '`verity:approved` stays applied — the next tick merges once CI is green (zero new model runs), or merge on GitHub'
      : "CI is not green; apply `verity:approved` once it is, from a human account (never the worker's bot; one listed in `humans:` if set), or merge on GitHub";
  }
  return "apply label `verity:approved` from a human account (never the worker's bot; one listed in `humans:` if set) — the next tick merges when CI is green (zero new model runs)";
}

function labelName(name) {
  const label = LABELS.find((l) => l.name === name);
  if (!label) {
    throw new Error(`verity-worker: ${name} missing from label vocabulary`);
  }
  return label.name;
}
const GATE_LABEL = labelName('verity:awaiting-approval');
const APPROVED_LABEL = labelName('verity:approved');
const NEEDS_HUMAN_LABEL = labelName('verity:needs-human');
const CIRCUIT_LABEL = labelName('verity:circuit-open');
// Stage 73 (#202): the P4 tier's plan trigger. The worker retires it from a
// request issue after a successful plan produces stages, so later ticks fall to
// P5 instead of re-anchoring P4 and re-planning an already-decomposed project.
const REQUEST_LABEL = labelName('verity:request');

// §7 "<outcome emoji+word>" vocabulary — one badge per SUMMARIZE outcome.
const OUTCOME_BADGES = {
  success: '✅ success',
  gated: '⏸️ gated',
  limit_hit: '🛑 limit_hit',
  failed: '❌ failed',
  failed_once: '⚠️ failed_once',
  infra: '💥 infra',
};

// §4.4 SUMMARIZE exit codes: success/gated/limit → 0; failed → 20; infra → 30.
// failed_once IS a failure (the unlock comment `outcome:failed_once` feeds the
// 2-strike counter), so it shares the failure exit code.
const EXIT_CODES = {
  success: 0,
  gated: 0,
  limit_hit: 0,
  failed: 20,
  failed_once: 20,
  infra: 30,
};

// stderr slugs for the nonzero outcomes (§8.2 single-line error format).
const ERROR_SLUGS = {
  failed: 'role-failed',
  failed_once: 'role-failed-once',
  infra: 'infra-error',
};

class WorkerError extends Error {
  constructor(message, slug) {
    super(message);
    this.name = 'WorkerError';
    this.exitCode = 30;
    this.slug = slug || 'internal';
  }
}

function oneLine(text) {
  return String(text ?? 'unknown error').split('\n')[0];
}

function lockable(item) {
  return item.kind === 'issue' || item.kind === 'pr';
}

function makeRunId(now = Date.now()) {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- GitHub item ops (issue AND pr — both are issues to the REST API) -------
//
// Stage 80 (ADR-0029, contract local-work-item v1): each op dispatches on the
// run's resolved substrate (ctx.substrate, stamped from policy.substrate in
// runOnce). 'local' routes to the engine-performed record edits in
// substrate-local.cjs (worker-owned commits, ADR-0026); anything else is the
// gh path, byte-identical to before the seam existed. Live since stage 83:
// assertSubstrateSupported now admits 'local' (the driver is complete).

function apiBase(ctx, number) {
  return `repos/${ctx.repo}/issues/${number}`;
}

function addLabel(ctx, number, label) {
  if (ctx.substrate === 'local') {
    substrateLocal.addLabel(ctx.cwd, number, label);
    return;
  }
  // Stage 112: a label add is idempotent on GitHub (an already-present label is
  // a 200 no-op), so it keeps the full stage-110 retry — said explicitly.
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/labels`, '-f', `labels[]=${label}`], {
    cwd: ctx.cwd,
    idempotent: true,
  });
}

// Tolerates already-absent labels (HTTP 404) so consume/cleanup is idempotent.
// (The local op is idempotent on absence by construction — same end-state rule.)
function removeLabel(ctx, number, label) {
  if (ctx.substrate === 'local') {
    substrateLocal.removeLabel(ctx.cwd, number, label);
    return;
  }
  try {
    gh.run(['api', '-X', 'DELETE', `${apiBase(ctx, number)}/labels/${encodeURIComponent(label)}`], {
      cwd: ctx.cwd,
    });
  } catch (err) {
    if (err?.reason !== 'http-404') {
      throw err;
    }
  }
}

// Stage 85 (ADR-0029; stage-83 review): substrate-aware like the label ops
// above. Contract local-work-item v1 (FROZEN) has NO comment surface and must
// not grow one — so on 'local' the comment body lands on the run's log stream
// (ctx.stderr), headed with the record it addresses, and is NEVER silently
// dropped. The STRUCTURED half of every §7 summary already lands in the usage
// ledger (recordUsage → usage.csv — outcome, roles, tokens, cost, gate), which
// the operator surface reads (`operator runs` / snapshot worker.last_*, stage
// 85); this route carries the free text (findings bodies, gate instructions,
// the summary template) the ledger's columns cannot. github: byte-identical.
function postComment(ctx, number, body) {
  if (ctx.substrate === 'local') {
    ctx.stderr(
      `verity-worker: local comment for work-item #${number} (contract local-work-item v1 has no comment surface — recorded on the run log, structured facts in the usage ledger; stage 85, ADR-0029):\n${body}`,
    );
    return;
  }
  // Stage 112: a comment POST is NOT idempotent. A timed-out POST that landed
  // and was retried posted the comment twice — and a doubled run summary read
  // as two runs to the no-progress breaker. An ambiguous failure throws at once
  // (GhError.ambiguous); every caller already treats a failed post as its own
  // best-effort case (summary, findings) or a failed gate step.
  gh.run(['api', '-X', 'POST', `${apiBase(ctx, number)}/comments`, '-f', `body=${body}`], {
    cwd: ctx.cwd,
    idempotent: false,
  });
}

// --- result-declared GitHub effects (stage 24, ADR-0013) ----------------------

// The effect vocabulary this worker recognizes from a role's T05 marker
// (`artifacts.effects`). Everything else is ignored with a logged note —
// Verity never guesses at a write it was not built to perform, and the merge
// levers stay out of the vocabulary on purpose (T13: merge authority is the
// trust ladder's, never a role's request).
const RECOGNIZED_EFFECTS = ['findings_comment'];

// Attribution mirrors the §7 templates: same worker voice, same run-id badge,
// and it says WHO actually performed the write — deterministic Verity code on
// the role's behalf, because the sandbox denies the role GitHub by design.
function formatFindingsComment({ runId, role, body }) {
  return [
    `🔎 **verity-worker** \`${runId}\` — ${role} findings (posted by Verity on the role's behalf, ADR-0013)`,
    '',
    body,
  ].join('\n');
}

// Perform the GitHub writes a role's result DECLARED. Default-closed: an
// absent `artifacts.effects` performs nothing and logs nothing. Best-effort
// like the §7 summary comment — a failed post is a loud warn, never a changed
// run outcome (the verdict/trust path below stays the deterministic spine).
function performResultEffects(ctx, { runId, role, res, pr }) {
  const effects = res.artifacts?.effects;
  if (effects === undefined) {
    return;
  }
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) {
    ctx.stderr(
      `verity-worker: note: role ${role} declared a malformed effects block — ignored, never guessed at (ADR-0013)`,
    );
    return;
  }
  for (const [name, value] of Object.entries(effects)) {
    if (!RECOGNIZED_EFFECTS.includes(name)) {
      ctx.stderr(
        `verity-worker: note: ignoring unrecognized GitHub effect '${name}' declared by role ${role} — not in the recognized effect vocabulary (${RECOGNIZED_EFFECTS.join(', ')}), never executed (ADR-0013)`,
      );
      continue;
    }
    // findings_comment: the review findings body, posted on the run's PR.
    if (typeof value !== 'string' || value.trim() === '') {
      ctx.stderr(
        `verity-worker: note: effect findings_comment from role ${role} carries no body — nothing posted`,
      );
      continue;
    }
    if (!Number.isInteger(pr)) {
      ctx.stderr(
        `verity-worker: note: effect findings_comment from role ${role} has no PR to land on (artifacts.pr absent and none known this run) — nothing posted`,
      );
      continue;
    }
    try {
      postComment(ctx, pr, formatFindingsComment({ runId, role, body: value }));
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: failed to post the ${role} findings comment on #${pr}: ${oneLine(err.message)}`,
      );
    }
  }
}

// --- pure helpers (exported for tests) ---------------------------------------

// Per-run circuit breakers (§4.4). Returns the tripped limit's name or null.
function checkLimits(totals, limits, elapsedMs) {
  if (totals.chained >= limits.max_chained_roles) {
    return `max_chained_roles (${limits.max_chained_roles})`;
  }
  if (totals.tokens >= limits.max_tokens_per_run) {
    return `max_tokens_per_run (${limits.max_tokens_per_run})`;
  }
  if (elapsedMs >= limits.max_wall_clock_min * 60_000) {
    return `max_wall_clock_min (${limits.max_wall_clock_min})`;
  }
  return null;
}

// A role reported gated but the agent-exec result object carries no gate name;
// resolve it from the policy's gates (e.g. review → review:merge), else the role.
function gateNameFor(role, policy) {
  return (policy.gates || []).find((g) => g === role || g.startsWith(`${role}:`)) || role;
}

// The gate a run pauses at when a role's cost is unknown and
// limits.unknown_cost_behavior is 'gate' (ADR-0008 — the default until a
// provider's cost accounting is proven). Single-sourced from the usage ledger
// (stage 21): SUMMARIZE stamps the run's terminal gate onto its usage.csv rows,
// and checkDailyLimits matches those cells against the same constant to tell an
// approvable unknown-cost pause from ungated unknown spend.
const UNKNOWN_COST_GATE = usage.UNKNOWN_COST_GATE;

// Stage 19 (issue #50) — the no-progress stop condition.
//
// `verity next` is ground truth every iteration, which means a state that never
// changes produces the SAME decision forever. Where that state is a PR whose CI
// never goes green, the worker answered it with the same role every tick and
// spent a full model run each time: the 2026-07-31 canary burned two runs on
// `build` for stage 1 and never reached `test` or `review`.
//
// Mechanism: a STRIKE, counted from the item's own comment trail — the same
// shape as the 2-strike failure rule, so the worker stays stateless and GitHub
// keeps holding the state. Backoff was rejected
// (a cron-driven `--once` worker has nowhere to hold a timer, and a slower
// livelock is still a livelock) and so was a plain per-run cap (it bounds one
// tick, not the sequence of ticks, which is where the canary's spend went).
//
// Two identical dispatches are allowed — a role legitimately gets a retry —
// and the third is refused, escalating to a human instead. Consecutive runs
// that dispatched the same single role count toward the ceiling, as do
// consecutive identical dispatches inside one run.
//
// The cross-tick trail is the worker's OWN §7 run-summary comments, already
// posted append-only on the locked item, one per run, with `roles: a → b` as
// part of that exact template (formatRunSummary below). Nothing new is written
// and no frozen format is touched — in particular the §4.3 lock/unlock comment
// bodies are left exactly as they were.
const MAX_REPEAT_DISPATCHES = 2;
const SUMMARY_PREFIX = '🤖 **verity-worker**';
const SUMMARY_ROLES_RE = /^roles: (.+)$/m;
// Stage 112: the run id a §7 summary names on its first line (formatRunSummary).
const SUMMARY_RUN_ID_RE = /^🤖 \*\*verity-worker\*\* `([^`\s]+)`/;

// The roles a past run dispatched, per its §7 summary — or null if this comment
// is not a run summary at all. `(none)` (a run that dispatched nothing) reads
// as the empty list, which breaks a streak rather than extending it.
function summaryRoles(body) {
  if (typeof body !== 'string' || !body.startsWith(SUMMARY_PREFIX)) {
    return null;
  }
  const m = SUMMARY_ROLES_RE.exec(body);
  if (m === null) {
    return null;
  }
  return m[1] === '(none)' ? [] : m[1].split(' → ');
}

// How many of the item's MOST RECENT CONSECUTIVE runs dispatched exactly this
// one role and nothing else. Any run that chained, dispatched something else,
// or dispatched nothing breaks the streak; comments that are not run summaries
// (locks, gate pauses, humans) are skipped without breaking it. Deliberately a
// FLOOR: a summary that failed to post simply is not counted, so the guard this
// feeds can only ever fire late, never early.
//
// Stage 112 (#290): the streak counts DISTINCT runs — (run id, roles) — never
// comment copies. A summary POST that timed out but landed and was re-posted
// (stage 110 retried every timeout) left two identical summaries, which read as
// two runs and refused the role's next dispatch as no-progress after ONE real
// run. A repeated identity is skipped (it neither extends nor breaks the
// streak), so a duplicate from any cause can never trip MAX_REPEAT_DISPATCHES.
function countRepeatedRole(comments, role) {
  let streak = 0;
  const seen = new Set();
  for (let i = (comments || []).length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    const body = typeof comment === 'string' ? comment : comment?.body;
    const roles = summaryRoles(body);
    if (roles === null) {
      continue;
    }
    const runId = SUMMARY_RUN_ID_RE.exec(body)?.[1] ?? body;
    const identity = `${runId}\u0000${roles.join(' → ')}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    if (roles.length !== 1 || roles[0] !== role) {
      break;
    }
    streak += 1;
  }
  return streak;
}

// Monotonic elapsed-time source for the run loop (ADR-0008). Date.now() is
// WALL clock and can step backwards (NTP correction, VM/WSL clock skew) —
// measured elapsed time must never shrink, or a later chained role would be
// handed a LARGER --timeout-secs deadline than an earlier one (seen once in
// CI as 2700 → 2701: a backwards step made elapsedMs negative and
// floor(-1ms/1000) ADDED a second). process.hrtime.bigint() is monotonic by
// contract, so elapsed never decreases and the deadline never increases.
function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

// Stage 9 (ADR-0008): the wall-clock budget becomes a real subprocess
// deadline. Each chained role receives the REMAINING budget as --timeout-secs
// — never a fresh full window — so the deadline shrinks monotonically across
// the chain (the caller measures elapsed on the monotonic clock above).
// checkLimits() trips BEFORE dispatch once the budget is spent, so the floor
// of 1 only guards the sub-second race between check and dispatch. The spent
// clamp at 0 is belt-and-braces: no elapsed input, however broken, may ever
// yield MORE than the full budget.
function remainingTimeoutSecs(limits, elapsedMs) {
  const spentSecs = Math.max(0, Math.floor(elapsedMs / 1000));
  return Math.max(1, limits.max_wall_clock_min * 60 - spentSecs);
}

// Stage 9 (ADR-0005/0007): ONE immutable effective agent config per run,
// resolved from the already-validated policy (loadPolicy rejects an unknown
// provider with bad-policy/exit 30 BEFORE any scan, lock, or label) and passed
// to every chained dispatch — roles never re-read or reinterpret provider
// policy mid-run. sandbox/approval are codex-only overrides that agent-exec's
// driver may only apply by NARROWING the role's .permissions.json projection;
// the transcript destination stays what it has always been — the run-id
// selects ~/.verity/logs/<run-id>/ for every invocation of the run.
// Stage 11 (ADR-0011): `acknowledged_enforcement_gaps` travels here too, and
// defaults to the EMPTY list — acknowledging nothing, so a role declaring a
// restriction Verity cannot enforce refuses the run (fail closed).
// Stage 14 (ADR-0011 tier 2): `containment_tier` likewise defaults to 1 — the
// guarantee every codex run has had since stage 11. Tier 2 (disposable shaped
// workspace + gated merge-back) is OPT-IN, and UNATTENDED codex autonomy is
// refused without it (assertContainmentTier below).
// Stage 54 (ADR-0024): the ONE resolution stays once-per-run and frozen — just
// keyed by role. It returns a frozen resolver that exposes the BASE config (as
// today, spread at the top level so every existing run-wide `.provider`/`.model`
// read keeps working, plus a `.base` handle) AND `agentForRole(role)` = the base
// overridden by `policy.agent.roles[role]`, per role. EVERY per-role config is
// computed and frozen HERE, at run start; `agentForRole` is a pure lookup into
// that frozen cache, so nothing re-reads (or can be made to re-read) policy
// mid-run — the Stage-9 invariant is preserved, only now per-role instead of
// single. Absent `agent.roles` ⇒ agentForRole returns the identical base for
// every role ⇒ byte-identical to today (the feature's kill-switch, default OFF).
function resolveEffectiveAgent(policy) {
  const agent = policy.agent || {};
  const { roles: roleOverrides, ...agentBase } = agent;
  const base = Object.freeze({
    provider: 'claude',
    model: null,
    sandbox: null,
    approval: null,
    acknowledged_enforcement_gaps: [],
    containment_tier: 1,
    reconcile_work_items: false,
    // Stage 96 (ADR-0033): default-OFF like the reconcile; only an explicit
    // true (base or per-role) reaches agent-exec as --commit-intent-artifacts.
    commit_intent_artifacts: false,
    ...agentBase,
  });
  // Snapshot each role's fully-merged config, frozen, at resolution time. A
  // shallow spread over the frozen base — the same discipline the base itself
  // uses — so a later mutation of the policy object cannot reach these.
  const cache = new Map();
  if (roleOverrides !== null && typeof roleOverrides === 'object') {
    for (const [role, override] of Object.entries(roleOverrides)) {
      cache.set(role, Object.freeze({ ...base, ...(override || {}) }));
    }
  }
  const agentForRole = (role) => cache.get(role) || base;
  return Object.freeze({ ...base, base, agentForRole });
}

// ADR-0011 tier gating, checked at startup BEFORE any gh call, label, or lock.
// "Unattended" is `mode: autonomous` — the mode in which no human sees the run
// before its effects land. Tier 1 catches a containment violation after the
// fact and reverts what it safely can; only tier 2 makes the violation
// impossible to propagate, so tier 1 is enough for supervised/trust-0 and not
// enough for autonomy. Claude is unaffected: its write-time restriction is
// enforced by its own harness allowlist, so it has no tiers.
// Stage 54 (ADR-0024): the check is now PER ROLE, and strictly MORE fail-closed
// — a per-role codex override can never bypass tier-2. The base config is
// checked first (so a policy with NO roles map throws the byte-identical error
// it always did), then every role whose RESOLVED provider is codex. `resolved`
// is the resolveEffectiveAgent resolver: `.base` + `agentForRole`.
// Stage 94 (ADR-0031): the gate is no longer a codex denylist. It resolves the
// provider's TRUST-TABLE entry FIRST — no entry ⇒ the run is refused before any
// tier arithmetic (`untiered-provider`), because "not codex" used to mean "the
// claude reference tier", i.e. maximum trust granted by omission. With an entry,
// the gate reads `required_containment_tier` instead of the provider id; codex's
// entry carries 2, so the two message bodies below render byte-identically to
// what they have always said (they are quoted in operator docs).
function assertContainmentTier(policy, resolved) {
  if (policy.mode !== 'autonomous') {
    return;
  }
  const base = resolved.base;
  const baseEntry = tiers.getTier(base.provider);
  if (baseEntry === null) {
    throw new WorkerError(
      tiers.untieredProviderMessage(base.provider, "mode 'autonomous' (agent.provider)"),
      'untiered-provider',
    );
  }
  if (
    baseEntry.required_containment_tier !== null &&
    base.containment_tier !== baseEntry.required_containment_tier
  ) {
    throw new WorkerError(
      `fail-closed: mode 'autonomous' with agent.provider ${base.provider} requires ADR-0011 tier-${baseEntry.required_containment_tier} containment (a disposable shaped workspace + gated merge-back), but agent.containment_tier is ${JSON.stringify(base.containment_tier)} — unattended ${base.provider} autonomy is REFUSED at tier 1, which catches a protected-path write only after it happened. Set agent.containment_tier: ${baseEntry.required_containment_tier} in .verity/autonomy.yml, or run in mode 'supervised'`,
      'containment-tier-required',
    );
  }
  for (const role of autonomy.KNOWN_AGENT_ROLES) {
    const cfg = resolved.agentForRole(role);
    const entry = tiers.getTier(cfg.provider);
    if (entry === null) {
      throw new WorkerError(
        tiers.untieredProviderMessage(
          cfg.provider,
          `mode 'autonomous' (per-role agent.roles.${role}.provider)`,
        ),
        'untiered-provider',
      );
    }
    if (
      entry.required_containment_tier !== null &&
      cfg.containment_tier !== entry.required_containment_tier
    ) {
      throw new WorkerError(
        `fail-closed: mode 'autonomous' with a per-role agent.provider ${cfg.provider} (role '${role}') requires ADR-0011 tier-${entry.required_containment_tier} containment (a disposable shaped workspace + gated merge-back), but this role resolves to agent.containment_tier ${JSON.stringify(cfg.containment_tier)} — a per-role ${cfg.provider} override can NEVER bypass tier-${entry.required_containment_tier}. Set agent.roles.${role}.containment_tier: ${entry.required_containment_tier} (or agent.containment_tier: ${entry.required_containment_tier}) in .verity/autonomy.yml, or run in mode 'supervised'`,
        'containment-tier-required',
      );
    }
  }
}

// Stage 79 (ADR-0029) introduced this delivery-substrate gate as a fail-closed
// placeholder; stage 83 LIFTS it for 'local' — the local driver is complete
// (stage 80 record store + snapshot acquirer, stage 81 bare-origin git
// lifecycle + engine-performed merge, stage 82 gate runner), so 'github' AND
// 'local' both proceed. Anything else still refuses fail-closed, checked at
// startup BEFORE any gh call, scan, label, or lock — exactly like the tier
// gate above. loadPolicy resolves `substrate` ONCE onto the effective policy
// (absent ⇒ 'github', byte-identical; an unknown value is its own bad-policy
// load error), so by the time a run consumes the policy the value is one of
// the two schema enums — this check is the belt for unit callers passing raw
// policy objects: a substrate this engine cannot drive must never proceed
// half-driven, and never silently falls back to github (which would let a
// config the operator believes is GitHub-free touch the real repo).
function assertSubstrateSupported(policy) {
  // Unit callers may pass a raw policy object; absence resolves to 'github',
  // the same resolution loadPolicy performs.
  const substrate = policy.substrate === undefined ? 'github' : policy.substrate;
  if (substrate === 'github' || substrate === 'local') {
    return;
  }
  throw new WorkerError(
    `fail-closed: substrate '${substrate}' is not supported — the ADR-0029 delivery-substrate seam drives 'github' and 'local' (local driver complete as of stage 83); remove \`substrate: ${substrate}\` from .verity/autonomy.yml (absent resolves to github, byte-identical)`,
    'substrate-unimplemented',
  );
}

// Stage 76 guard, made substrate-aware by stage 81 (ADR-0029): did a build
// role that self-reported `gated` actually FINISH its job, so the gate is a
// mis-declared merge handoff? The stage-76 semantics key on the trust/role
// outcome ("the builder's job ends at delivered-for-review"), not on a PR
// object — but the original evidence guard was `artifacts.pr` (a real PR
// number), which only the github substrate can produce. On 'local' there is
// no PR to number; the equivalent delivered-for-review evidence is the
// git-lifecycle report's `pushed: true` (Verity committed and pushed the
// stage branch to the bare origin — agents/git-lifecycle.cjs finish, the
// "branch pushed, PR not opened" path every gh-less role takes). The github
// path is byte-identical: without `substrate === 'local'` the ONLY evidence
// accepted is the original PR number, so a genuine no-PR build failure is
// untouched exactly as before.
// Stage 82 (ADR-0029 §4): the local substrate's verification act. Where the
// github path waits on CI checks to appear on the pushed stage branch, the
// local path has NO CI — so after a build role completes, the ENGINE runs the
// committed single-source gate definition against that branch head and writes
// the SHA-pinned gate-run record (contract local-work-item v1) the stage-80
// snapshot driver reads. Synchronous by design: the record exists BEFORE the
// loop re-consults the dependency engine, so the very next snapshot read turns
// the branch's honest UNKNOWN into a verified green/red.
//
// Branch resolution: the Verity-performed git lifecycle names it directly
// (codex, res.git_lifecycle.branch); a provider whose harness performs its own
// git (claude) reports none, so the branch is DERIVED from the dispatch
// decision's stage number via stage.branchName — the same derivation the
// interactive `verity stage branch` uses, so it is the branch by construction.
//
// EVERY failure path is fail-closed and loud-but-non-fatal: a refused gate run
// (no committed definition, dirty tree, mid-run head move, missing branch)
// writes NO record, the branch stays UNKNOWN, and the existing ci:unverified
// gate fires on the next decision — never green, and never a crashed worker
// over a verification the snapshot honestly reports as unperformed.
function runLocalGates(ctx, plan, res) {
  let branch = typeof res.git_lifecycle?.branch === 'string' ? res.git_lifecycle.branch : null;
  if (branch === null) {
    const n = Number(plan.args?.[0]);
    if (Number.isInteger(n)) {
      try {
        branch = stage.branchName(ctx.cwd, n);
      } catch {
        branch = null;
      }
    }
  }
  if (branch === null) {
    ctx.stderr(
      'verity-worker: warn: local build completed but no stage branch could be resolved for the gate run — the stage stays UNKNOWN (ci:unverified gates, ADR-0029 §4)',
    );
    return;
  }
  try {
    // Stage 86 (ADR-0030): the run's resolved gate_runner travels with the
    // call — 'localhost' executes via the stage-87 act runner and
    // 'remote:<name>' via the stage-89 SSH act runner, both inside the same
    // honesty bracket; a runner the engine cannot serve (an unreachable or
    // unprovisionable remote, a localhost whose Docker/act preflight fails)
    // refuses inside, landing in the catch below: no record, honestly
    // UNKNOWN, loud warn — never a silent fallback to another runner.
    const run = gates.runGatesForBranch(ctx.cwd, { branch, runner: ctx.gateRunner });
    const verdict = run.ok
      ? 'green'
      : `red (${run.gates
          .filter((g) => g.exit_code !== 0)
          .map((g) => `${g.name}=${g.exit_code}`)
          .join(', ')})`;
    ctx.stderr(
      `verity-worker: note: local gates for ${branch} @ ${run.sha.slice(0, 12)}: ${verdict} — record ${run.record} (stage 82, ADR-0029 §4)`,
    );
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: local gate run for ${branch} wrote no record — ${oneLine(err.message)}; the branch stays UNKNOWN and the ci:unverified gate fires (fail closed, ADR-0029 §4)`,
    );
  }
}

function buildMisdeclaredHandoff(res, substrate) {
  if (res.outcome !== 'gated') {
    return false;
  }
  if (Number.isInteger(res.artifacts?.pr)) {
    return true;
  }
  return substrate === 'local' && res.git_lifecycle?.pushed === true;
}

function fmtTokens(n) {
  return `${Math.round(n / 1000)}k`;
}

function fmtWall(secs) {
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

// SKETCH §7 — exact template. The approve line appears ONLY when gated, and
// the budget line (stage 21) ONLY when the run consumed a `verity:approved` to
// proceed past an unverifiable daily budget — consent recorded, not implied.
function formatRunSummary(s) {
  const usd = typeof s.est_usd === 'number' ? s.est_usd.toFixed(2) : '?';
  const lines = [
    `🤖 **verity-worker** \`${s.runId}\` — ${OUTCOME_BADGES[s.outcome]}`,
    `roles: ${s.roles.length > 0 ? s.roles.join(' → ') : '(none)'}`,
    `result: ${s.result}`,
    `tokens: ${fmtTokens(s.tokens.in)} in / ${fmtTokens(s.tokens.out)} out · est $${usd} · wall ${fmtWall(s.wall_secs)}`,
  ];
  if (s.unknown_cost_budget_approved === true) {
    lines.push(
      `budget: unverifiable daily budget covered by the operator's single-use \`verity:approved\` — this run only (ADR-0008)`,
    );
  }
  // Stage 31 (ADR-0014): the resumed-from-parked outcome flavor, and its
  // fail-closed opposite — both recorded on GitHub, never stderr-only (a
  // cron-driven worker's operator reads comments, not logs).
  if (s.resumed_from !== null && s.resumed_from !== undefined) {
    lines.push(
      `resumed: consumed the parked ${s.resumed_from.role} result of run \`${s.resumed_from.runId}\` — zero new model runs, verified zero new cost (ADR-0014)`,
    );
  }
  if (typeof s.repurchase === 'string' && s.repurchase !== '') {
    lines.push(
      `repurchase: ${s.repurchase} — the approval bought a FRESH dispatch at full price (ADR-0014)`,
    );
  }
  if (s.outcome === 'gated') {
    // Stage 111: a review:merge park carries its configuration-true hint.
    lines.push(`approve: ${s.approval_hint ?? APPROVAL_ACTION}`);
  }
  return lines.join('\n');
}

// GATE_PAUSE comment: what's pending, the exact approval action, @mentions.
// Stage 31 (ADR-0014): a POST-COMPLETION unknown-cost pause additionally
// records the durable pointer to the PARKED result (`parked`, optional) — the
// line the next tick's resume parses (PARKED_POINTER_RE below). Every other
// gate comment is byte-identical to what it was.
// Stage 111 (ADR-0014 amended): a completed review's review:merge park records
// the same pointer line, and passes its configuration-true `approval` hint
// (approvalHint above). A pointer re-recorded for a RESUMED result names the run
// that actually produced it (`parked.runId`) — the parked file lives under THAT
// run's log directory, never under the resuming run's.
function formatGateComment({ runId, gate, pending, mentions, parked, approval }) {
  const lines = [
    `⏸️ **verity-worker** \`${runId}\` — paused at human gate \`${gate}\``,
    `pending: ${pending}`,
    `approve: ${approval ?? APPROVAL_ACTION}`,
  ];
  if (parked !== null && parked !== undefined) {
    lines.push(
      `parked: role \`${parked.role}\` result of run \`${parked.runId ?? runId}\` at PR #${parked.pr} head ${parked.head} — approving RESUMES this exact result (trust ladder + summary, zero new model runs); if the PR head has moved by then, the approval re-dispatches at full price instead (ADR-0014)`,
    );
  }
  if (mentions.length > 0) {
    lines.push(`cc ${mentions.map((m) => `@${m}`).join(' ')}`);
  }
  return lines.join('\n');
}

// Stage 31 (ADR-0014) — where the parked-result pointer LIVES: the gate
// comment the pause already posts on the item. It survives ticks (GitHub holds
// it, like the §7 no-progress trail and the §4.3 lock comments — the worker
// stays stateless), it needs no new contract or file, and its authority level
// is right: the pointer only NAMES a local file under ~/.verity/logs/ that is
// itself the authority (agent-exec re-validates run-id/role as path components
// and re-parses the persisted result fail-closed), and the head SHA recorded
// beside it bounds what a tampered or stale pointer can do — a mismatch is a
// loud repurchase, never a resumed lie.
const GATE_COMMENT_PREFIX = '⏸️ **verity-worker**';
// Stage 111: which gate a pointer was parked at (the comment's first line).
// Only a review:merge park's approval is a trust-0 MERGE decision — an
// unknown-cost park's approval consents to the cost, never to the merge
// (ADR-0014's rejected alternative: two consents never collapse into one).
const GATE_NAME_RE = /paused at human gate `([^`]+)`/;
const PARKED_POINTER_RE =
  /^parked: role `([A-Za-z0-9][A-Za-z0-9._-]*)` result of run `([A-Za-z0-9][A-Za-z0-9._-]*)` at PR #(\d+) head ([0-9a-f]{6,40}|unknown) /m;

// The staleness anchor a pointer records: the PR's head SHA at park time, read
// once, best-effort. No PR → no pointer (nothing verifiable to anchor the
// resume to — the fallback dispatch is the honest price); an unreadable head
// records `unknown`, which the resume refuses fail-closed, loudly. Only a
// COMPLETED result's park ever calls this (the unknown-cost park and, since
// stage 111, a completed review's review:merge park) — the stage-25 failed-run
// park and every pre-completion gate (ci:unverified, role-declared) record no
// pointer and keep their stages 19/21/22/25/27 semantics untouched.
// Stage 85 (ADR-0029): the head read is substrate-aware — on 'local' the SHA
// comes from the stage-80 snapshot's branch mapping + git itself
// (substrateLocal.localPrHead), never `gh pr view`; a failed local read records
// the same honest 'unknown' the gh path records (approval then repurchases,
// never resumes a lie). github: byte-identical gh argv.
function prHeadSha(ctx, pr) {
  if (ctx.substrate === 'local') {
    const head = substrateLocal.localPrHead(ctx.cwd, pr);
    if (!/^[0-9a-f]{6,40}$/.test(head)) {
      throw new Error(`local head for PR #${pr} is not a SHA: ${JSON.stringify(head)}`);
    }
    return head;
  }
  const view = gh.json(['pr', 'view', String(pr), '--json', 'headRefOid'], { cwd: ctx.cwd });
  if (typeof view.headRefOid === 'string' && /^[0-9a-fA-F]{6,40}$/.test(view.headRefOid)) {
    return view.headRefOid.toLowerCase();
  }
  return null;
}

function parkedResultPointer(ctx, { role, pr }) {
  if (!Number.isInteger(pr)) {
    return null;
  }
  let head = 'unknown';
  try {
    const sha = prHeadSha(ctx, pr);
    if (sha !== null) {
      head = sha;
    }
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read PR #${pr}'s head SHA to anchor the parked result — recorded 'unknown', so an approval will repurchase rather than resume (${oneLine(err.message)})`,
    );
  }
  return { role, pr, head };
}

// Stage 111 review round 3 (N1): the PRE-DISPATCH head read of a review — the
// head SHA and GitHub's own `updatedAt` for the PR, from ONE `gh pr view`
// response (bounded by gh.run's timeout). `updatedAt` is the GitHub-side
// timestamp the approval tick later compares the PR's push events against:
// it is taken from the same response as the head, so it is ≤ the moment of
// the read and no PR update (a push included) happened between it and the
// read — any push AFTER the read carries a GitHub `created_at` ≥ it. No local
// clock is involved anywhere in that comparison, so host clock skew cannot
// widen or narrow the window. github substrate only (the local substrate
// never honours a pointer). Returns { head, at } — either may be null.
function prHeadRead(ctx, pr) {
  const view = gh.json(['pr', 'view', String(pr), '--json', 'headRefOid,updatedAt'], {
    cwd: ctx.cwd,
  });
  const head =
    typeof view?.headRefOid === 'string' && /^[0-9a-fA-F]{6,40}$/.test(view.headRefOid)
      ? view.headRefOid.toLowerCase()
      : null;
  const at =
    typeof view?.updatedAt === 'string' && Number.isFinite(Date.parse(view.updatedAt))
      ? view.updatedAt
      : null;
  return { head, at };
}

// Stage 111 review F2 (+F11) and round 3 (N1a): the pointer a COMPLETED REVIEW
// parks with. It anchors to the head read BEFORE the review was dispatched
// (`reviewedHead`) — the head the verdict actually examined — never to the
// head read now. If the head MOVED while the review ran, the verdict may
// describe either head (the review reads the live PR, not a pinned SHA), so
// NO resumable pointer is recorded at all: the gate copy says an approval
// re-reviews, and the data now agrees (round 2 still recorded the
// pre-dispatch head, which a force-push back to it made resumable again). A
// move that returns to the reviewed head INSIDE the window is invisible here;
// the approval tick's push-event check (pushesSince) refuses it. A verdict
// whose PR is not the PR this review was dispatched for (or a review with no
// pre-dispatch read) parks no pointer. The pointer carries the pre-dispatch
// read's GitHub timestamp (`headReadAt`) for the local park record — it is
// never posted. Returns { parked, note }.
function reviewParkPointer(ctx, { pr, targetPr, reviewedHead }) {
  if (!Number.isInteger(pr)) {
    return { parked: null, note: null };
  }
  if (ctx.substrate === 'local') {
    // No pointer is ever READ on the local substrate (readParkedPointer), so
    // its log-only pointer keeps the park-time head, byte-identical to before.
    return { parked: parkedResultPointer(ctx, { role: 'review', pr }), note: null };
  }
  if (targetPr !== pr || reviewedHead === null || reviewedHead.pr !== pr) {
    return { parked: null, note: null };
  }
  const now = parkedResultPointer(ctx, { role: 'review', pr });
  if (
    /^[0-9a-f]{6,40}$/.test(reviewedHead.head) &&
    /^[0-9a-f]{6,40}$/.test(now.head) &&
    now.head !== reviewedHead.head
  ) {
    const note = `PR #${pr}'s head moved while the review ran (${reviewedHead.head} → ${now.head}): the verdict may describe either head, so no resumable result is parked — an approval re-reviews the current head at full price and cannot merge on this verdict`;
    ctx.stderr(`verity-worker: warn: ${note} (stage 111)`);
    return { parked: null, note };
  }
  return {
    parked: { role: 'review', pr, head: reviewedHead.head, headReadAt: reviewedHead.at ?? null },
    note: null,
  };
}

// GitHub logins are case-insensitive (the bot-is-human check compares the
// same way).
function sameLogin(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a !== '' &&
    b !== '' &&
    a.toLowerCase() === b.toLowerCase()
  );
}

// The LATEST gate pause in an item's comment trail (ascending) that the
// worker's BOT posted, parsed: its gate name, its parked-result pointer (null
// when that pause recorded none), and the comment's author/created_at — or
// null when the trail holds no bot-authored gate pause at all. Pure — shared
// by readParkedPointer below and `verity operator act approve`'s
// effect.consequence (stage 111 amendment, ADR-0037), so both read the trail
// the same way.
//
// Stage 111 review F1: authorship is the first gate. A comment that merely
// STARTS with the ⏸️ prefix is text anyone who can comment can write (the PR
// author included); only a comment whose `user.login` is `botLogin` is a
// gate pause at all. A non-bot comment is skipped — it neither supplies a
// pointer nor supersedes the bot's own latest pause. A missing/empty
// `botLogin` (bot identity unknown) authenticates nothing ⇒ null, so every
// caller fails closed (no resume, never a merge). String trail entries carry
// no author and are never accepted.
function latestGatePause(trail, botLogin) {
  if (typeof botLogin !== 'string' || botLogin === '') {
    return null;
  }
  for (let i = (trail || []).length - 1; i >= 0; i -= 1) {
    const c = trail[i];
    const body = c !== null && typeof c === 'object' ? c.body : null;
    if (typeof body !== 'string' || !body.startsWith(GATE_COMMENT_PREFIX)) {
      continue;
    }
    if (!sameLogin(c.user?.login, botLogin)) {
      continue;
    }
    const createdAt = typeof c.created_at === 'string' ? c.created_at : null;
    const { gate, pointer } = parseGatePause(body);
    return {
      gate,
      author: c.user.login,
      createdAt,
      pointer: pointer === null ? null : { ...pointer, commentAt: createdAt },
    };
  }
  return null;
}

// One gate comment's TEXT, parsed — its gate name (first line only) and its
// pointer line. Says nothing about who wrote it: callers authenticate first
// (latestGatePause above; the act verb's park-record check).
function parseGatePause(body) {
  const g = GATE_NAME_RE.exec(String(body).split('\n')[0]);
  const gate = g ? g[1] : null;
  const m = PARKED_POINTER_RE.exec(String(body));
  return {
    gate,
    pointer: m === null ? null : { role: m[1], runId: m[2], pr: Number(m[3]), head: m[4], gate },
  };
}

// --- the local park record (stage 111 review F1) -----------------------------
//
// The gate comment is a POINTER, and GitHub text is editable by more people
// than the bot (repository writers can edit any comment; the author stays the
// bot). So every pointer this worker posts is ALSO recorded on the worker host,
// beside the parked result it names: ~/.verity/logs/<result-run-id>/park.json.
// A pointer is honoured only when it matches that record EXACTLY (role, run
// id, PR, head, gate) and the record's bot is this run's bot — a pointer this
// host did not write, or one edited after it was written, never resumes (loud
// fallback to a fresh dispatch; never a merge). The record holds no secret:
// public identifiers (run id, PR number, commit SHA, gate name, bot login), a
// timestamp, and the resumed-approval attempt counter (F6). Same availability
// as the parked result itself — log cleanup that takes one takes the other.
const PARK_RECORD_FILE = 'park.json';
const PARK_RECORD_SCHEMA = 1;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Stage 111 review F6: how many approval ticks may end WITHOUT the approved
// trust-0 merge landing (CI still not green → the label is kept; or GitHub
// refused the merge → infra, label kept) before the worker stops retrying and
// parks the item `verity:needs-human`. Counted per parked verdict (one run id
// ⇒ one head) — round 3 (N4): a newer label does not restart the count and a
// refused label's re-gate carries it; only the needs-human park resets it.
// 3 = the approval tick plus two retries.
const MAX_APPROVED_MERGE_ATTEMPTS = 3;

function parkRecordPath(runId) {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`invalid run id for a park record: ${JSON.stringify(runId)}`);
  }
  return path.join(os.homedir(), '.verity', 'logs', runId, PARK_RECORD_FILE);
}

// null when no record exists; throws on an unreadable/malformed one (callers
// fail closed either way).
function readParkRecord(runId) {
  const file = parkRecordPath(runId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const rec = JSON.parse(raw);
  if (rec === null || typeof rec !== 'object' || rec.schema !== PARK_RECORD_SCHEMA) {
    throw new Error(`${file} is not a schema-${PARK_RECORD_SCHEMA} park record`);
  }
  return rec;
}

// Atomic (tmp + rename) so a reader never sees half a record. The record
// lives BESIDE the parked result: the run's log directory must already exist
// (agent-exec created it when the result was persisted). No directory ⇒ no
// result to point at ⇒ the write fails and recordPark posts no pointer.
function writeParkRecord(rec) {
  const file = parkRecordPath(rec.run_id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: PARK_RECORD_SCHEMA, ...rec }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

// Does `pointer` (parsed from a bot gate comment) match `rec` exactly, for
// `botLogin`? Returns null when it does, else the refusal reason.
function parkRecordMismatch(rec, pointer, botLogin) {
  if (rec === null || rec === undefined) {
    return 'no local park record exists for it on this host (a pointer this worker did not record is never resumed)';
  }
  for (const [key, want] of [
    ['role', pointer.role],
    ['run_id', pointer.runId],
    ['pr', pointer.pr],
    ['head', pointer.head],
    ['gate', pointer.gate],
  ]) {
    if (rec[key] !== want) {
      return `the gate comment's ${key} (${JSON.stringify(want)}) does not match the local park record (${JSON.stringify(rec[key])})`;
    }
  }
  if (!sameLogin(rec.bot, botLogin)) {
    return `the local park record was written by bot ${JSON.stringify(rec.bot)}, not this run's ${JSON.stringify(botLogin)}`;
  }
  return null;
}

// Record the park of `parked` (the pointer about to be posted) at `gate`.
// Returns the pointer to post, or null when the record could not be written —
// a pointer without its record could never resume, so it is not posted
// (the approval then honestly buys a fresh dispatch). Local substrate: no
// pointer is ever read there (no comment trail), so nothing is recorded.
//
// Round 3: the record also carries `head_read_at` — the GitHub-side timestamp
// of the pre-dispatch head read (N1b; null for a non-review pointer) — and a
// re-park of a RESUMED verdict carries both it and the F6 attempt counter
// (`approval`) forward from the record it resumed, so neither the push window
// nor the attempt bound restarts because the verdict re-gated (N4).
function recordPark(ctx, parked, { gate, runId, approval = null }) {
  if (parked === null || parked === undefined || ctx.substrate === 'local') {
    return parked ?? null;
  }
  const resultRunId = parked.runId ?? runId;
  try {
    writeParkRecord({
      role: parked.role,
      run_id: resultRunId,
      pr: parked.pr,
      head: parked.head,
      gate,
      bot: ctx.botLogin ?? null,
      parked_at: new Date().toISOString(),
      head_read_at: parked.headReadAt ?? null,
      approval,
    });
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not write the local park record for run ${resultRunId} (${oneLine(err.message)}) — the gate records no pointer, so an approval buys a fresh dispatch`,
    );
    return null;
  }
  return parked;
}

// --- the approval label's provenance (stage 111 review F3/F4) -----------------
//
// At trust 0 the `verity:approved` label on a review:merge park is the merge
// decision, so WHO applied it and WHEN matters. `judgeApprovalEvent` is pure:
// given the item's issue-timeline events (ascending), the latest bot gate
// comment's created_at, the bot login and the policy's `humans:` list, it
// accepts the label only when its LATEST `labeled` event
//   - is strictly newer than that gate comment (a label applied before — or
//     while — the gate was posted answers no verdict a human had seen);
//   - was applied by an actor that is not the worker's bot;
//   - was applied by a login in `humans:` when that list is non-empty
//     (GitHub's triage role and issues:write integrations can label but
//     cannot merge — the label must not hand them merge authority).
// Any missing/unparseable fact fails closed. Returns { ok, reason, at, actor }.
function judgeApprovalEvent(events, { gateAt, botLogin, humans }) {
  const refuse = (reason, ev = null) => ({
    ok: false,
    reason,
    at: ev?.created_at ?? null,
    actor: ev?.actor?.login ?? null,
  });
  if (!Array.isArray(events)) {
    return refuse('the label timeline is not an event list');
  }
  let ev = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (
      e !== null &&
      typeof e === 'object' &&
      e.event === 'labeled' &&
      typeof e.label?.name === 'string' &&
      e.label.name.toLowerCase() === APPROVED_LABEL
    ) {
      ev = e;
      break;
    }
  }
  if (ev === null) {
    return refuse(`no \`${APPROVED_LABEL}\` labeled event is on the timeline`);
  }
  const labeledAt = Date.parse(ev.created_at);
  const gateTime = Date.parse(gateAt);
  if (!Number.isFinite(labeledAt) || !Number.isFinite(gateTime)) {
    return refuse('the label or gate-comment timestamp is unreadable', ev);
  }
  if (labeledAt <= gateTime) {
    return refuse(
      `\`${APPROVED_LABEL}\` was applied at ${ev.created_at}, not after the gate comment it would answer (${gateAt})`,
      ev,
    );
  }
  const actor = ev.actor?.login;
  if (typeof actor !== 'string' || actor === '') {
    return refuse(`the \`${APPROVED_LABEL}\` event names no actor`, ev);
  }
  if (typeof botLogin !== 'string' || botLogin === '' || sameLogin(actor, botLogin)) {
    return refuse(
      `\`${APPROVED_LABEL}\` was applied by the worker's own bot identity (${actor}) — the worker never honours its own label as a merge decision`,
      ev,
    );
  }
  const list = Array.isArray(humans) ? humans.filter((h) => typeof h === 'string' && h !== '') : [];
  if (list.length > 0 && !list.some((h) => sameLogin(h, actor))) {
    return refuse(
      `\`${APPROVED_LABEL}\` was applied by ${actor}, who is not listed in the policy's \`humans:\``,
      ev,
    );
  }
  return { ok: true, reason: null, at: ev.created_at, actor };
}

// The item's issue timeline, every page, ascending — bounded like the comment
// reader (locks.cjs PER_PAGE/MAX_PAGES) and per call by gh.run's timeout.
// `run` is the gh seam (default: the worker's gh.json). Throws on any failure.
// Round 3 (N3): a timeline whose LAST allowed page is still full may hold
// events past the bound — the latest label or a push among them — so it is
// never judged truncated: it throws (every caller fails closed).
const TIMELINE_PER_PAGE = 100;
const TIMELINE_MAX_PAGES = 50;

function readTimeline(repo, number, readJson) {
  const all = [];
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
    const batch = readJson([
      'api',
      `repos/${repo}/issues/${number}/timeline?per_page=${TIMELINE_PER_PAGE}&page=${page}`,
    ]);
    if (!Array.isArray(batch)) {
      throw new Error('the timeline read returned no event list');
    }
    all.push(...batch);
    if (batch.length < TIMELINE_PER_PAGE) {
      return all;
    }
  }
  throw new Error(
    `the timeline of #${number} fills all ${TIMELINE_MAX_PAGES} pages the reader may take (${TIMELINE_MAX_PAGES * TIMELINE_PER_PAGE} events) — refusing to judge a possibly truncated timeline`,
  );
}

// --- pushes after the review's head read (stage 111 review round 3, N1b) ------
//
// The resume re-checks that the PR head still EQUALS the head the review
// examined — but a head that went A → B → A is equal again while the verdict
// (the review reads the live PR, not a pinned SHA) may describe B. Returning
// to A after anything was pushed on top of it is always a non-fast-forward
// update, which GitHub records on the PR's timeline with its own `created_at`.
// So a resumed APPROVE verdict is honoured only when the PR's timeline (the
// MERGE TARGET's — `issues/<pr>/timeline`, which may not be the item carrying
// the label) shows no push-type event at or after the pre-dispatch head read
// (`head_read_at`, GitHub's `updatedAt` from that same read — prHeadRead).
// Push-type events (GitHub REST "issue event types", timeline):
//   head_ref_force_pushed  the PR's head branch was force-pushed      (created_at)
//   head_ref_restored      the head branch was restored               (created_at)
//   head_ref_deleted       the head branch was deleted                (created_at)
//   committed              a commit was added to the head branch — carries NO
//                          GitHub timestamp, only the git author/committer
//                          dates (client-set): judged by committer.date
//                          (author.date fallback), the reviewed head's own
//                          commit excluded; a missing/unparseable date refuses.
//                          Defense in depth only: a commit that stays moves the
//                          head (the equality check), and one that is removed
//                          again needs a force-push (the load-bearing signal).
//   base_ref_force_pushed, base_ref_changed — not listed for the REST
//                          timeline today, honoured if GitHub serves them: the
//                          head would then merge into a base the review did
//                          not see.
// The comparison is `>=` (a tie is treated as after the read — fail closed).
// Pure. Returns { ok, reason }.
const PUSH_EVENTS = [
  'committed',
  'head_ref_force_pushed',
  'head_ref_restored',
  'head_ref_deleted',
  'base_ref_force_pushed',
  'base_ref_changed',
];

function pushesSince(events, { since, head }) {
  const refuse = (reason) => ({ ok: false, reason });
  const sinceMs = typeof since === 'string' ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(sinceMs)) {
    return refuse('no GitHub-side time of the pre-review head read is recorded');
  }
  if (!Array.isArray(events)) {
    return refuse('the PR timeline is not an event list');
  }
  const reviewed = typeof head === 'string' ? head.toLowerCase() : '';
  for (const e of events) {
    if (e === null || typeof e !== 'object' || !PUSH_EVENTS.includes(e.event)) {
      continue;
    }
    let when;
    let what = e.event;
    if (e.event === 'committed') {
      const sha = typeof e.sha === 'string' ? e.sha.toLowerCase() : '';
      if (reviewed !== '' && sha !== '' && (sha === reviewed || sha.startsWith(reviewed))) {
        continue; // the reviewed head's own commit
      }
      when = e.committer?.date ?? e.author?.date;
      what = `committed ${sha === '' ? '(no sha)' : sha.slice(0, 12)}`;
    } else {
      when = e.created_at;
    }
    const ms = typeof when === 'string' ? Date.parse(when) : Number.NaN;
    if (!Number.isFinite(ms)) {
      return refuse(`a \`${what}\` event on the PR timeline carries no readable time`);
    }
    if (ms >= sinceMs) {
      return refuse(
        `the PR timeline shows \`${what}\` at ${when}, at or after the review's head read (${since})`,
      );
    }
  }
  return { ok: true, reason: null };
}

// Worker side: judge the label on `number` against the resumed pointer's gate
// comment. An unreadable timeline fails closed (not honoured). `events` (when
// given) is that same timeline already read this tick — the resume's push
// check reads the PR's timeline, which IS the label's when the item is the PR.
function verifyApprovalEvent(ctx, policy, number, gateAt, readAlready = null) {
  let events = readAlready;
  if (Array.isArray(events)) {
    return judgeApprovalEvent(events, { gateAt, botLogin: ctx.botLogin, humans: policy.humans });
  }
  try {
    events = readTimeline(ctx.repo, number, (args) => gh.json(args, { cwd: ctx.cwd }));
  } catch (err) {
    return {
      ok: false,
      reason: `the label timeline of #${number} could not be read (${oneLine(err.message)}) — failing closed`,
      at: null,
      actor: null,
    };
  }
  return judgeApprovalEvent(events, { gateAt, botLogin: ctx.botLogin, humans: policy.humans });
}

// The most recent BOT gate pause's pointer on a P1 item, or null. The LATEST
// bot ⏸️ comment decides: an older parked pointer must never outlive the pause
// that superseded it (a later failed-run or pre-completion park carries no
// pointer line, and that absence is the answer). Best-effort read — a trail we
// cannot read yields null, and the approval buys a fresh dispatch instead of
// wedging (the run-4 lesson: an approval must never be a no-op).
// Stage 111 review F1: with no bot identity there is nothing to authenticate a
// gate comment against — no pointer, said out loud (fresh dispatch; a fresh
// review re-gates, so this never merges).
function readParkedPointer(ctx, item) {
  // Stage 85 (ADR-0029): the pointer LIVES in the gate-comment trail, and the
  // local substrate has no comment surface (contract v1, frozen) — the local
  // gate pause landed its text on the run log (postComment above), which is
  // not a machine-readable trail. No pointer ⇒ the approval buys a fresh
  // dispatch — the documented fail-safe direction (an approval is never a
  // no-op, and a resume is never guessed). Said out loud, never silent.
  if (ctx.substrate === 'local') {
    ctx.stderr(
      `verity-worker: note: no parked-result pointer can exist on the local substrate (no comment trail; contract local-work-item v1) — a consumed approval on #${item.number} dispatches fresh (stage 85, ADR-0029)`,
    );
    return null;
  }
  if (typeof ctx.botLogin !== 'string' || ctx.botLogin === '') {
    ctx.stderr(
      `verity-worker: warn: the bot identity is unknown, so no gate comment on #${item.number} can be authenticated — no parked result is resumed; the approval buys a fresh dispatch (stage 111)`,
    );
    return null;
  }
  try {
    const trail = locks.readComments(item, { repo: ctx.repo, cwd: ctx.cwd });
    const pause = latestGatePause(trail, ctx.botLogin);
    return pause === null ? null : pause.pointer;
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read the parked-result pointer on #${item.number}: ${oneLine(err.message)}`,
    );
  }
  return null;
}

// Consume a parked pointer (ADR-0014): verify the parked result's inputs still
// hold, re-read the persisted T05 result, and hand back a zero-cost `res` the
// run loop re-enters the post-role path with. Fail-closed on every doubt —
// each refusal names its reason, and the caller announces the fresh dispatch
// as a repurchase. The returned result carries VERIFIED zeros (tokens, cost,
// wall): this run spawned no provider, so its ledger rows must never say
// unknown and must never re-count the parked run's tokens.
//
// Stage 111 (ADR-0014 amended): `requireVerdict` — set for a review:merge
// park, whose whole point is the recorded verdict — additionally refuses a
// parked result that carries no verdict string (loud fallback, never a
// resumed guess). The unknown-cost park never sets it (byte-identical).
//
// Stage 111 review F1: the pointer must also match the LOCAL park record the
// worker wrote when it posted it (recordPark) — exactly, for this run's bot.
// The record rides back on the attempt (`record`) for the resumed-approval
// attempt counter (F6).
function resumeParkedResult(ctx, { agentCfg, pointer, requireVerdict = false }) {
  const refuse = (reason) => ({ res: null, from: null, reason, record: null, pushCheck: null });
  const who = `parked ${pointer.role} result of run ${pointer.runId}`;
  if (!/^[0-9a-f]{6,40}$/.test(pointer.head)) {
    return refuse(`${who} recorded no verifiable head SHA at park time`);
  }
  let head = null;
  try {
    // Stage 85 (ADR-0029): substrate-aware head verification (prHeadSha above)
    // — local reads git via the stage-80 snapshot; github is byte-identical.
    head = prHeadSha(ctx, pointer.pr);
  } catch (err) {
    return refuse(
      `could not read PR #${pointer.pr}'s current head to verify the ${who} is still fresh (${oneLine(err.message)})`,
    );
  }
  if (head === null || head !== pointer.head) {
    return refuse(
      `PR #${pointer.pr} head moved since the ${pointer.role} result parked (${pointer.head} → ${head ?? 'unreadable'}) — the approved verdict examined a head that no longer exists`,
    );
  }
  let parked = null;
  try {
    parked = agentExec.readParkedResult({
      'run-id': pointer.runId,
      role: pointer.role,
      agent: agentCfg.provider,
    });
  } catch (err) {
    return refuse(`${who} is unreadable (${oneLine(err.message)})`);
  }
  if (parked === null) {
    return refuse(`${who} is missing from ~/.verity/logs — log cleanup must have taken it`);
  }
  let record;
  try {
    record = readParkRecord(pointer.runId);
  } catch (err) {
    return refuse(`${who}'s local park record is unreadable (${oneLine(err.message)})`);
  }
  const mismatch = parkRecordMismatch(record, pointer, ctx.botLogin);
  if (mismatch !== null) {
    return refuse(`the gate pointer to the ${who} is not honoured: ${mismatch}`);
  }
  // Stage 25 boundary, belt-and-braces (the failed-run park never writes a
  // pointer in the first place): only a COMPLETED result is resumable. A
  // failed park's approval means "let the day proceed", never "replay the
  // failure" — ADR-0014 scopes resume to post-completion parks of successes.
  if (parked.outcome !== 'success') {
    return refuse(`${who} is not a completed success (outcome ${parked.outcome})`);
  }
  if (
    requireVerdict &&
    (typeof parked.artifacts?.verdict !== 'string' || parked.artifacts.verdict === '')
  ) {
    return refuse(`${who} carries no review verdict to resume`);
  }
  // Stage 111 review round 3 (N1b): a parked review APPROVE verdict is the
  // only resumed result that can reach a merge (at any trust — trust 1/2 merge
  // a resumed approve too, pinned to the same head). Before it is honoured,
  // the MERGE TARGET's timeline (`issues/<pointer.pr>/timeline`) must show no
  // push since the review's pre-dispatch head read (pushesSince). A push found
  // is the same fact as a moved head (the verdict may describe another head):
  // the resume REFUSES and the approval buys a fresh review, announced as a
  // repurchase — never a zero-cost re-gate, which would re-park a verdict no
  // later approval could ever merge. A record with no read time (parked before
  // this check existed) refuses the same way. An UNREADABLE timeline says
  // nothing about the verdict: the resume proceeds, flagged unverified, and
  // the ladder refuses the merge and re-gates at zero cost (the F3 refusal
  // path) — `pushCheck` rides back for that, with the events for reuse.
  let pushCheck = null;
  if (
    pointer.role === 'review' &&
    ctx.substrate !== 'local' &&
    typeof parked.artifacts?.verdict === 'string' &&
    parked.artifacts.verdict.toLowerCase() === 'approve'
  ) {
    const since = record?.head_read_at;
    if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) {
      return refuse(
        `${who}'s park record carries no GitHub-side time for the review's pre-dispatch head read (parked before stage 111 review round 3) — a push to PR #${pointer.pr} after that read cannot be ruled out`,
      );
    }
    let events = null;
    try {
      events = readTimeline(ctx.repo, pointer.pr, (args) => gh.json(args, { cwd: ctx.cwd }));
    } catch (err) {
      pushCheck = {
        verified: false,
        reason: `PR #${pointer.pr}'s timeline could not be read to rule out a push after the review's head read (${oneLine(err.message)}) — failing closed`,
        pr: pointer.pr,
        events: null,
      };
    }
    if (events !== null) {
      const pushes = pushesSince(events, { since, head: pointer.head });
      if (!pushes.ok) {
        return refuse(
          `PR #${pointer.pr} was pushed to after the review read its head (${pushes.reason}) — the approved verdict may describe a head other than ${pointer.head}`,
        );
      }
      pushCheck = { verified: true, reason: null, pr: pointer.pr, events };
    }
  }
  return {
    res: {
      outcome: 'success',
      artifacts: parked.artifacts,
      error: null,
      tokens: { in: 0, out: 0 },
      // A VERIFIED zero, not an unknown (the stage-22 distinction): this
      // iteration dispatched no model, so its new cost is genuinely $0.
      est_usd: 0,
      wall_secs: 0,
      tool_calls: 0,
    },
    from: { runId: pointer.runId, role: pointer.role },
    reason: null,
    record,
    pushCheck,
  };
}

// --- T11 / T12 seams ----------------------------------------------------------

// T11 — usage ledger. SUMMARIZE calls this exactly once per run with the
// final run summary ({ runId, repo, outcome, roles, invocations, tokens:{in,out},
// est_usd, wall_secs, ... }): §3.4 usage.csv append — since stage 3 one row PER
// ROLE INVOCATION (summary.invocations, all sharing the run_id; a zero-role run
// still writes its single run-level row). Since stage 108 (ADR-0036) the row
// goes to the git-dir sidecar (usage.ledgerPath) and NOTHING is committed —
// the ledger is runtime state; policy `commit_usage` is ignored (loadPolicy
// warns when it is true). Best-effort like the summary comment itself —
// ledger failures are logged and NEVER change the run's outcome (the §8.1
// lock release is the invariant, not bookkeeping).
function recordUsage(ctx, _policy, summary) {
  try {
    usage.record(ctx.cwd, summary);
  } catch (err) {
    ctx.stderr(`verity-worker: warn: failed to record usage: ${oneLine(err.message)}`);
  }
}

// Stage 112 (#283 S1) — run start, before the seed and the daily-limit check:
// resolve WHERE the usage ledger lives. usage.ledgerPath falls back to the
// in-tree path only when git says this is not a repository; any other git
// failure (a timeout, `dubious ownership`, a broken config) throws
// LedgerPathError — and the run is refused here as infra (exit 30), before any
// gh call or dispatch. The alternative is reading a stale or empty fallback
// file while every other process uses the git-dir ledger: the daily breaker
// would read (near) zero and under-enforce the cap.
function locateLedger(ctx) {
  try {
    usage.ledgerPath(ctx.cwd);
  } catch (err) {
    if (err instanceof usage.LedgerPathError) {
      throw new WorkerError(
        `${oneLine(err.message)} — refusing the run: the daily limits cannot be checked against a ledger that cannot be located, and reading it as empty would under-enforce them`,
        'ledger-path',
      );
    }
    throw err;
  }
}

// Stage 108 (ADR-0036 amended) — run start, BEFORE the daily-limit check (so
// the breakers read every row a pre-108 repo left behind): usage.seedLedger
// seeds the git-dir sidecar ONCE, when it does not exist yet, from the legacy
// in-tree ledger + every historical `chore(verity): usage` commit (git reads
// only), and reports whether the tree still tracks `.verity/usage.csv` — one
// warning naming the operator verb. Never a commit, a checkout, or a write
// under the working tree (untracking is `verity usage untrack`, an ordinary
// reviewed change — never the worker's). Never throws: a failed seed is a
// warning, never a refused run.
function prepareLedger(ctx) {
  let res;
  try {
    res = usage.seedLedger(ctx.cwd);
  } catch (err) {
    ctx.stderr(`verity-worker: warn: could not seed the usage ledger: ${oneLine(err.message)}`);
    return;
  }
  if (res.seeded > 0) {
    ctx.stderr(
      `verity-worker: note: seeded ledger: ${res.seeded} rows (${res.path}; stage 108, ADR-0036)`,
    );
  }
  if (res.tracked) {
    ctx.stderr(
      `verity-worker: warn: .verity/usage.csv is still tracked by git — it is stale history (the live ledger is ${res.path}); run \`verity usage untrack\` and merge the change it makes (stage 108, ADR-0036)`,
    );
  }
}

// §4.1 startup checks (T11 daily limits + T12 the rest). Runs AFTER the
// bad-policy / mode:manual checks in runOnce, BEFORE scanning/locking; all
// checks are read-only (no labels/comments — no GitHub side effects). Returns
// { ok:true, botLogin } or the first failing check's { ok:false, slug, message }
// → exit 30 as `verity-worker: 30 <slug>: <message>` (§8.2). Order: local
// checks first (a refused start must not cost gh calls), then auth → identity
// → circuit breaker.
function startupChecks(ctx, policy) {
  // 1 (local). Daily limits not already exceeded — today's usage.csv, UTC (T11).
  const daily = usage.checkDailyLimits(ctx.cwd, policy.limits, {
    warn: (msg) => ctx.stderr(`verity-worker: warn: ${msg}`),
  });
  // Stage 21 (#58, ADR-0008): an unverifiable budget whose every unknown-cost
  // run ended PARKED at the unknown-cost gate is not refused HERE — the gate
  // comment told the operator that `verity:approved` resumes the run, and the
  // startup breaker must not outrank the approval its own gate asked for
  // ("'gate' costs one human approval per run", ADR-0008). The refusal is
  // DEFERRED: runOnce refuses with this exact failure unless the scanner
  // selects a P1 item (one carrying the single-use approval). Every other
  // daily-limit failure — verified overspend, run caps, ungated unknown cost —
  // still refuses right here, before any gh call, exactly as stage 18 built it.
  let deferredDaily = null;
  if (!daily.ok) {
    if (daily.slug !== 'unknown-cost-budget' || daily.approvable !== true) {
      return daily;
    }
    deferredDaily = daily;
  }
  // The start is allowed, but not because the budget was verified: under
  // unknown_cost_behavior 'allow_with_token_limit' the USD breaker is inert by
  // the operator's own consent (ADR-0008). Say so rather than letting a $x.xx
  // total in usage.csv look like the whole day's spend.
  if (daily.note) {
    ctx.stderr(`verity-worker: warn: ${daily.note}`);
  }

  // Stage 85 (ADR-0029; stage-83 review): on the LOCAL substrate checks 2–4
  // get honest local equivalents — never a fabricated pass, never a gh spawn:
  //   2/3. preflight auth + bot identity: there is no GitHub to authenticate
  //        against and no bot account to resolve. botLogin is NULL (the run's
  //        honest marker — the ledger/summary already record the substrate via
  //        the committed policy; a fabricated login is forbidden). Every
  //        downstream consumer tolerates null: the scanner's P4 author filter
  //        is skipped on a null botLogin by its own contract, and the
  //        bot-is-human check has nothing to compare.
  //   4.   circuit breaker: the label vocabulary is unchanged (contract
  //        local-work-item v1 — labels are free strings), so the breaker reads
  //        as "any OPEN work-item record carrying verity:circuit-open" — the
  //        same derivation stage 84's operator snapshot uses for
  //        autonomy.circuit_open, and the read `operator act circuit open`
  //        now arms (stage 85). An unreadable store fails CLOSED (halt), the
  //        gh path's own rule.
  if (ctx.substrate === 'local') {
    ctx.stderr(
      'verity-worker: note: local substrate — no GitHub to authenticate against; preflight auth skipped and bot identity is null, never fabricated (stage 85, ADR-0029)',
    );
    let snap;
    try {
      snap = substrateLocal.fetchLocalSnapshot(ctx.cwd);
    } catch (err) {
      return {
        ok: false,
        slug: 'circuit-open',
        message: `could not check the circuit breaker (failing closed): ${oneLine(err.message)}`,
      };
    }
    if (snap.verified !== true) {
      const detail = (snap.failures || [])
        .map((f) => f.detail)
        .filter(Boolean)
        .join('; ');
      return {
        ok: false,
        slug: 'circuit-open',
        message: `could not check the circuit breaker (failing closed): the local record store could not be honestly read${detail ? ` — ${detail}` : ''}`,
      };
    }
    const open = (snap.issues || []).filter(
      (i) => i.state === 'OPEN' && (i.labels || []).includes(CIRCUIT_LABEL),
    );
    if (open.length > 0) {
      const nums = open.map((i) => `#${i.number}`).join(', ');
      return {
        ok: false,
        slug: 'circuit-open',
        message: `circuit breaker is open: work-item record ${nums} carries label ${CIRCUIT_LABEL} — close it (\`verity operator act circuit close <n>\`) to resume autonomy`,
      };
    }
    return { ok: true, botLogin: null, deferredDaily };
  }

  // 2. `gh auth status` ok — any failure (not logged in, bad token, no gh) is fatal.
  try {
    gh.run(['auth', 'status'], { cwd: ctx.cwd });
  } catch (err) {
    return {
      ok: false,
      slug: 'gh-auth',
      message: `gh auth status failed: ${oneLine(err.message)}`,
    };
  }

  // 3. Resolve the bot identity (the scanner's P4 no-self-feeding rule needs it
  //    too). A failed lookup is an auth/credential problem → same slug.
  let botLogin = null;
  try {
    botLogin = gh.json(['api', 'user'], { cwd: ctx.cwd }).login || null;
  } catch (err) {
    return {
      ok: false,
      slug: 'gh-auth',
      message: `could not resolve bot identity via gh api user: ${oneLine(err.message)}`,
    };
  }
  // Bot login ∉ policy humans. GitHub logins are case-insensitive, so the
  // comparison is too — `Verity-Bot` in humans still blocks token `verity-bot`.
  const human = (policy.humans || []).find(
    (h) => String(h).toLowerCase() === String(botLogin).toLowerCase(),
  );
  if (botLogin !== null && human !== undefined) {
    return {
      ok: false,
      slug: 'bot-is-human',
      message: `bot login '${botLogin}' matches '${human}' in the policy humans list — the worker must run with a dedicated bot account's GH_TOKEN, never a human's; fix .verity/autonomy.yml humans or switch the token`,
    };
  }

  // 4. Circuit breaker: any OPEN issue labeled verity:circuit-open halts the
  //    worker. An unreadable breaker fails closed (halt) — never open. The
  //    query targets the --repo repository (GH_REPO, set in runOnce — stage
  //    29), never the cwd's remotes: a remote-less clone must not die HERE
  //    masquerading as a breaker fault, it refuses later — truthfully — as
  //    `git-unprovidable` (ADR-0012). The read-failure message below names
  //    what could not be READ; only the branch after it may claim the switch
  //    was actually thrown.
  let circuit;
  try {
    circuit = gh.json(
      ['issue', 'list', '--label', CIRCUIT_LABEL, '--state', 'open', '--json', 'number'],
      { cwd: ctx.cwd },
    );
  } catch (err) {
    return {
      ok: false,
      slug: 'circuit-open',
      message: `could not check the circuit breaker (failing closed): ${oneLine(err.message)}`,
    };
  }
  if (circuit.length > 0) {
    const nums = circuit.map((i) => `#${i.number}`).join(', ');
    return {
      ok: false,
      slug: 'circuit-open',
      message: `circuit breaker is open: issue ${nums} carries label ${CIRCUIT_LABEL} — close it to resume autonomy`,
    };
  }

  return { ok: true, botLogin, deferredDaily };
}

// --- the run loop (§4.4) ------------------------------------------------------

// `target` is the gate's GitHub item number (the dispatch decision's issue/PR,
// or the trust ladder's PR) — NOT necessarily the run's locked anchor.
function gatePause(ctx, { runId, policy, target, gate, pending, parked = null, approval }) {
  if (target === null) {
    ctx.stderr('verity-worker: note: gated with no GitHub target — gate label/comment skipped');
    return;
  }
  addLabel(ctx, target, GATE_LABEL);
  postComment(
    ctx,
    target,
    formatGateComment({
      runId,
      gate,
      pending,
      mentions: policy.notify?.mention || [],
      parked,
      approval,
    }),
  );
}

// The cross-tick half of the no-progress strike: read the item's run-summary
// trail once. BEST-EFFORT — a trail we cannot read yields 0, because "we could
// not prove repetition" must not become "we refuse to work". The within-run
// streak still bounds a single run, and max_runs_per_day still bounds the day;
// the failure is logged, never silent.
function priorRepeats(ctx, item, role) {
  if (!lockable(item)) {
    return 0;
  }
  // Stage 85 (ADR-0029): the cross-tick trail is the §7 comment trail, which
  // the local substrate does not carry (no comment surface, contract v1).
  // 0 is the documented FLOOR ("we could not prove repetition" must not become
  // "we refuse to work"): the within-run streak still bounds a single run and
  // max_runs_per_day still bounds the day — the guard can only fire late,
  // never early. Never a fabricated count.
  if (ctx.substrate === 'local') {
    return 0;
  }
  try {
    return countRepeatedRole(locks.readComments(item, { repo: ctx.repo, cwd: ctx.cwd }), role);
  } catch (err) {
    ctx.stderr(
      `verity-worker: warn: could not read the no-progress trail on #${item.number}: ${oneLine(err.message)}`,
    );
    return 0;
  }
}

function runLoop(ctx, { policy, runId, item, budgetApproved = false }) {
  const t0 = monotonicMs(); // monotonic: elapsed never shrinks (ADR-0008)
  // Stage 54 (ADR-0024): the frozen resolver — the base config (run-wide reads
  // still use `agentCfg.provider`/`.model`) plus `agentForRole(role)` for the
  // per-role dispatch below. Resolved ONCE here; nothing re-reads policy mid-run.
  const agentCfg = resolveEffectiveAgent(policy);
  const agentForRole = agentCfg.agentForRole;
  // Stage 86 (ADR-0030): the resolved gate runner rides the run context like
  // ctx.substrate — stamped ONCE from the frozen policy, consumed by
  // runLocalGates below. 'localhost' executes via the stage-87 act runner
  // and 'remote:<name>' via the stage-89 SSH act runner; any runner the
  // engine cannot honestly serve (an unreachable/unprovisionable remote, an
  // unprovisionable localhost) refuses at the gate call site rather than
  // silently executing direct. Absent (unit callers passing raw
  // pre-stage-86 policies) reads as the direct runner — byte-identical.
  ctx.gateRunner = policy.gate_runner;
  const roles = [];
  // Stage 3 telemetry: one entry per agent-exec invocation (role, outcome,
  // tokens, est_usd, wall_secs, tool_calls) — SUMMARIZE writes one usage.csv
  // row per entry, all sharing this run's run_id.
  const invocations = [];
  const tokens = { in: 0, out: 0 };
  let estUsd = null;
  let lastPr = null;
  const mergedPrs = []; // PRs auto-merged by the trust ladder this run (audit)
  // Where labels/comments land: the locked item, else the first issue/PR target.
  let anchor = lockable(item) ? item.number : null;

  // P1 approved-resume: consume the single-use token (§1). The gate label is
  // removed WITH it — leaving `verity:awaiting-approval` behind would make the
  // next `verity next` call re-gate the item the human just approved.
  //
  // Stage 32 (canary run 5, defect N3): consumption is EFFECT-CONDITIONAL — the
  // two labels come off exactly ONCE, and only when the run actually reaches the
  // work the approval authorized (a dispatch that genuinely spawned, or a stage
  // 31 parked-result resume). Consuming at the TOP of the loop (as this did
  // before) burned the approval AND erased the visible pause on a run that then
  // REFUSED before any work: the `state:unverified` pre-dispatch gate below, or
  // a pre-SPAWN infra refusal such as `unenforceable-policy` (agent-exec exit 30,
  // ZERO provider spawns) that comes back FROM the dispatch call itself. Such a
  // refusal must leave BOTH labels exactly as it found them — the approval
  // survives for the next healthy tick and stage 27's announce-once stays quiet.
  // `consumeApproval` is idempotent (the flag) and P1-only, so the chained
  // multi-role healthy path consumes once, at its first real dispatch, exactly
  // as before.
  //
  // Known edge (T14 integration finding), now with two distinct regimes:
  // GitHub's label-FILTERED list queries are search-index backed and eventually
  // consistent, so an approval applied seconds before a tick can be missed by
  // the scanner's P1 query.
  //   • ORDINARY (non-deferred) scan: the miss is COSMETIC. The P5 dependency
  //     engine reads fresh `--json labels` and still treats the approved item
  //     as plain work, so the work proceeds correctly; only the token
  //     consumption is skipped (labels linger on the item). Accepted for v1 —
  //     this normal-path lag is deliberately NOT worked around.
  //   • DEFERRED daily unknown-cost refusal (stage 21): the same miss was a
  //     HARD `30 unknown-cost-budget` exit — the deferred refusal fires unless
  //     the scan yields a P1 pick, so a lagged approval refused a true-but-not-
  //     yet approval (canary run 5, tick 3). Stage 33 covers that regime: before
  //     the deferred refusal fires, runOnce re-checks the awaiting-approval
  //     carriers with a bounded FRESH (non-search) read and proceeds on a
  //     confirmed approval. Under the documented cron cadence the index has long
  //     settled and neither regime is exercised.
  let approvalConsumed = false;
  const consumeApproval = () => {
    if (item.tier !== 'P1' || approvalConsumed) {
      return;
    }
    approvalConsumed = true;
    removeLabel(ctx, item.number, APPROVED_LABEL);
    removeLabel(ctx, item.number, GATE_LABEL);
  };

  // Stage 31 (ADR-0014): the approval this P1 run just consumed may be
  // answering a POST-COMPLETION unknown-cost park — in which case the role's
  // result already exists on disk and was already paid for. Read the parked
  // pointer from the item's own gate-comment trail ONCE; the loop below
  // consumes it (at most once) instead of re-dispatching, or announces the
  // repurchase when the resume must refuse. Non-P1 runs never look: without a
  // consumed approval there is nothing that could legitimately resume.
  let parkedPointer = item.tier === 'P1' && lockable(item) ? readParkedPointer(ctx, item) : null;
  let resumedFrom = null; // { runId, role } once a parked result was consumed
  let repurchase = null; // the loud reason a refused resume dispatched fresh
  // Stage 111 (ADR-0014 amended): the pointer a resume consumed (its verified
  // head re-anchors any re-park and pins the approved merge), and whether it
  // was a completed review's review:merge park — the ONLY park whose approval
  // is a trust-0 merge decision, and whose token consumption is deferred to
  // the trust ladder (consumed on a merge or a re-gate; LEFT in place when the
  // approved merge only waits for CI).
  let resumedPointer = null;
  let reviewMergeResume = false;
  let resumedRecord = null; // the local park record the resumed pointer matched (F1/F6)
  // Round 3 (N1b): the resumed approve verdict's push check — null when none
  // applied; { verified, reason, pr, events } otherwise (resumeParkedResult).
  let resumedPushCheck = null;
  // Stage 111 review F2: the PR head read BEFORE a review is dispatched — the
  // head the review examined. A fresh review's pointer anchors to it, never to
  // the head read at park time (a push landing mid-review must not become the
  // head an approval merges). { pr, head } | null; head 'unknown' if unread.
  let reviewedHead = null;

  // Stage 19: what `verity next` should do with a PR whose CI is UNVERIFIABLE.
  // Normally the policy decides (limits.unverified_ci_behavior, default-closed
  // → the ci:unverified gate). A P1 item is different: a human just applied
  // `verity:approved` to this exact item and this run consumes that token when
  // it reaches real work (stage 32, `consumeApproval` below), so the human
  // decision the gate asks for has already been made — for THIS RUN only, since
  // the token is single-use. Without this the gate would be a dead
  // end: approving it would re-derive the same gate on the next tick forever
  // (cheaply, but forever), and the "approve:" line the gate comment prints
  // would be a lie. It does NOT lower the merge bar — the trust ladder still
  // demands trust.checksGreen(), which an unverified PR can never satisfy.
  const nextFlags = { cwd: ctx.cwd };
  if (item.tier === 'P1') {
    nextFlags['unverified-ci'] = 'allow_without_merge';
  }
  // Stage 24 (ADR-0013): a CONTAINED dispatch cannot read GitHub, so the facts
  // its workflow needs must travel with it — ask `verity next` to attach them
  // (derived from the same verified snapshot as the decision itself). Claude
  // dispatches never ask and never receive: its harness reads GitHub itself,
  // and agent-exec rejects the flag for it outright.
  // Stage 54 (ADR-0024): we don't know which role `verity next` will pick until
  // it answers, so REQUEST facts whenever ANY role this run could dispatch as
  // codex (the base, or a per-role override). Attaching them stays PER ROLE at
  // dispatch (only a codex role's invocation gets --state-snapshot). With no
  // roles map this reduces to `base.provider === 'codex'` — byte-identical.
  // Stage 94 (ADR-0031): the question is asked of the TRUST TABLE, not of the
  // provider id — "does this runtime perform its own GitHub reads?". codex's
  // entry says no and claude's says yes, so this is byte-identical today; an
  // un-tiered provider (no entry) requests nothing here and is refused outright
  // at the dispatch gate below.
  const needsAttachedFacts = (p) => tiers.getTier(p)?.performs_own_github_reads === false;
  const requestFacts =
    needsAttachedFacts(agentCfg.provider) ||
    autonomy.KNOWN_AGENT_ROLES.some((r) => needsAttachedFacts(agentForRole(r).provider));

  // No-progress strike state. The cross-tick count is read ONCE, from the
  // item's run-summary trail, on the run's first dispatch decision (it cannot
  // change mid-run); after that only the within-run streak grows.
  let repeats = null;
  let repeatKey = null;

  const summary = (outcome, result, gate = null, extra = {}) => ({
    runId,
    repo: ctx.repo,
    item: { kind: item.kind, number: item.number ?? null, tier: item.tier },
    anchor,
    outcome,
    gate,
    result,
    roles,
    invocations,
    // Stage 53: run-level provenance for the zero-invocation fallback row
    // (entryFromSummary reads these). Worker-wide agentCfg; a null model writes
    // '' at the usage layer, never a fabricated value.
    provider: agentCfg.provider,
    model: agentCfg.model,
    tokens,
    // Stage 30 (the third occurrence of the null-vs-zero class — ended here,
    // structurally): a run whose loop performed ZERO provider dispatches has a
    // VERIFIED cost of $0 — the same truth stage 22's announcement summary in
    // runOnce records. ADR-0008's "null never counts as $0" is about MODEL
    // runs whose provider reported no cost; serializing null for a
    // dispatch-free exit (parked-success idle, the stage-20 infra stop, a
    // pre-dispatch gate) writes an UNGATED unknown-cost ledger row, and the
    // startup breaker then refuses `30 unknown-cost-budget` NON-approvably
    // for the rest of the UTC day (canary run 5, ticks 6/9/11 → the tick-13
    // wedge). Derived from the run's own invocation list so EVERY exit —
    // present and future — inherits the rule; a run with ≥1 invocation keeps
    // the accumulator's semantics exactly: unknown stays unknown, and stage
    // 31's resumed results already report their own verified numeric 0.
    est_usd: invocations.length === 0 ? 0 : estUsd,
    wall_secs: Math.round((monotonicMs() - t0) / 1000),
    // Stage 21: consent is recorded, not implied — a run that proceeded past
    // the unverifiable-budget refusal on a consumed `verity:approved` says so
    // in its own §7 summary (formatRunSummary renders the line).
    ...(budgetApproved ? { unknown_cost_budget_approved: true } : {}),
    // Stage 31 (ADR-0014): likewise for a consumed parked result, and for the
    // announced repurchase when the resume had to refuse.
    ...(resumedFrom !== null ? { resumed_from: resumedFrom } : {}),
    ...(repurchase !== null ? { repurchase } : {}),
    // Stage 111: a review:merge park's configuration-true approval line.
    ...extra,
  });
  const gatedResult = (gate) =>
    `${lastPr === null ? '' : `PR #${lastPr} opened, `}gated at ${gate}`;

  let first = true;
  for (;;) {
    // Ground truth every iteration — with one extension: a P4 request's first
    // role is `plan` on the request issue (the dependency engine knows stages,
    // not requests; planning is what turns the request INTO stages).
    let plan;
    // Stage 73 (#202): the anti-thrash fix is RETIREMENT, not a stage-count
    // guard here. A P4 selection means the scanner found an OPEN `verity:request`
    // — and a request is only still labeled while it is UN-planned, because a
    // successful plan retires the label below (so the P4 tier never re-selects
    // it). Synthesizing `plan` unconditionally for a P4-first iteration is
    // therefore correct: every P4-selected request genuinely needs planning.
    // This is deliberately NOT keyed on `readStages().length === 0` — a global
    // stage-count guard would block Mode B recurring intake (a NEW pending
    // request must plan into new stages even when prior work's stages exist).
    if (first && item.tier === 'P4') {
      plan = {
        schema: 1,
        action: 'work',
        role: 'plan',
        args: [String(item.number)],
        gate: null,
        target: { kind: 'issue', number: item.number },
        reason: `request #${item.number} needs planning`,
      };
    } else {
      plan = next.dispatch([], nextFlags, requestFacts ? { withFacts: true } : {});
    }
    first = false;
    // Stage 54 (ADR-0024): this iteration's role runs under ITS OWN resolved
    // config — base overridden by agent.roles[plan.role]. A pure lookup into
    // the frozen cache (no policy re-read). For idle/gated iterations plan.role
    // may be absent; agentForRole then returns the base, and those paths return
    // before it is used for dispatch/provenance anyway.
    const roleCfg = agentForRole(plan.role);
    if (anchor === null && plan.target !== null && plan.target.kind !== 'stage') {
      anchor = plan.target.number;
    }
    // Where a gate label/comment would land this iteration: the dispatch
    // decision's GitHub item (issue/PR), else the run's anchor.
    const gateTarget =
      plan.target !== null && plan.target.kind !== 'stage' ? plan.target.number : anchor;

    if (plan.action === 'idle') {
      // A run that reached idle genuinely RAN and found no work remaining (a
      // clean completion, not a refusal) — it consumes exactly as it did when
      // consumption sat at the top of the loop, so the approved item is not
      // re-selected on the next tick to summarize idle again (stage 32).
      consumeApproval();
      const mergedNote =
        mergedPrs.length > 0 ? ` — auto-merged PR ${mergedPrs.map((n) => `#${n}`).join(', ')}` : '';
      return summary('success', `${plan.reason || 'no work remaining'}${mergedNote}`);
    }
    // Stage 20 (issue #60): the dependency engine could not READ GitHub — the
    // decision below it is derived from a snapshot nobody observed. This is
    // deliberately NOT the GATE_PAUSE path: that writes a label and a comment
    // to the very GitHub that just proved unreachable, and the decision carries
    // no target to write them to. Stop as INFRA — exit 30, no needs-human label
    // (an unreadable API is not the item's fault), and the point of the whole
    // stage: zero model runs dispatched against unverified state.
    // Stage 32: this is a PRE-WORK refusal — deliberately NO consumeApproval()
    // here. The approval and the gate announcement survive for the next tick.
    if (plan.action === 'gated' && plan.gate === next.STATE_GATE) {
      return summary('infra', `refusing to dispatch on unverified GitHub state: ${plan.reason}`);
    }
    if (plan.action === 'gated') {
      // A human gate on this decision — a pause, not a refusal: consume as
      // before (the item now carries the gate label and must not be re-picked
      // as a P1 next tick, stage 32).
      consumeApproval();
      gatePause(ctx, { runId, policy, target: gateTarget, gate: plan.gate, pending: plan.reason });
      return summary('gated', gatedResult(plan.gate), plan.gate);
    }

    // Stage 31 (ADR-0014): before paying for a dispatch, check whether the
    // consumed approval was answering a parked COMPLETED result for exactly
    // this decision (same role, same PR). At most one attempt per run — the
    // pointer is cleared whichever way it goes, mirroring the single-use
    // token that authorized it. A refused resume falls through to the normal
    // dispatch below, announced as a repurchase (never a silent re-buy, and
    // never a wedged approval).
    let res = null;
    let resumed = false;
    if (
      parkedPointer !== null &&
      plan.role === parkedPointer.role &&
      plan.target !== null &&
      plan.target.kind === 'pr' &&
      plan.target.number === parkedPointer.pr
    ) {
      const pointer = parkedPointer;
      const isReviewMergePark =
        pointer.role === 'review' && pointer.gate === gateNameFor('review', policy);
      const attempt = resumeParkedResult(ctx, {
        agentCfg: roleCfg,
        pointer,
        requireVerdict: isReviewMergePark,
      });
      parkedPointer = null;
      if (attempt.res !== null) {
        res = attempt.res;
        resumed = true;
        resumedFrom = attempt.from;
        resumedPointer = pointer;
        resumedRecord = attempt.record;
        resumedPushCheck = attempt.pushCheck;
        reviewMergeResume = isReviewMergePark;
        // Stage 32: resolving the parked COMPLETED result IS the deferred work
        // the approval authorized (stage 31) — consume here, exactly once.
        // Stage 111: except a review:merge park, whose token the trust ladder
        // below consumes (merge or re-gate) or deliberately keeps (approved at
        // trust 0, CI not yet green) — the ladder is reached unconditionally
        // from here (a resumed review is a verified-zero-cost success).
        if (!reviewMergeResume) {
          consumeApproval();
        }
        ctx.stderr(
          `verity-worker: note: resuming the parked ${attempt.from.role} result of run ${attempt.from.runId} — zero new model runs, verified zero new cost (ADR-0014)`,
        );
      } else {
        repurchase = attempt.reason;
        ctx.stderr(
          `verity-worker: warn: ${attempt.reason} — refusing the resume; the approval buys a FRESH ${plan.role} dispatch at full price (ADR-0014)`,
        );
      }
    }

    if (res === null) {
      const tripped = checkLimits(
        { chained: roles.length, tokens: tokens.in + tokens.out },
        policy.limits,
        monotonicMs() - t0,
      );
      if (tripped !== null) {
        // A per-run limit almost always trips AFTER ≥1 dispatch already consumed
        // (a no-op here). If it ever trips before the run's first dispatch, this
        // keeps consumption byte-identical to the old top-of-loop behavior — it
        // is a run-limit stop, not one of stage 32's protected refusals.
        consumeApproval();
        return summary('limit_hit', `stopped at per-run limit ${tripped}`);
      }

      // Stage 19 no-progress strike, checked BEFORE the dispatch so the refused
      // run costs nothing. The key is role + GitHub target: re-running the same
      // role against the same object with nothing changed is not a retry, it is
      // the livelock. Escalate to a human (the item is then invisible to every
      // scanner tier, §4.2) rather than spending another model run.
      const key = `${plan.role}@${plan.target === null ? 'none' : `${plan.target.kind}:${plan.target.number}`}`;
      if (repeats === null) {
        repeats = priorRepeats(ctx, item, plan.role);
        repeatKey = key;
      } else if (key === repeatKey) {
        repeats += 1;
      } else {
        repeats = 0;
        repeatKey = key;
      }
      if (repeats >= MAX_REPEAT_DISPATCHES) {
        // The no-progress strike ESCALATES to a human (needs-human makes the
        // item scanner-invisible), so it is not one of stage 32's protected
        // pre-work refusals — the human now owns the item. Consume as before
        // (a no-op when a prior dispatch this run already did).
        consumeApproval();
        if (anchor !== null) {
          addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
        }
        return summary(
          'failed',
          `no progress: role ${plan.role} has already been dispatched ${repeats} times against the same target with nothing changing (${plan.reason}) — refusing to spend another model run, labeled ${NEEDS_HUMAN_LABEL}`,
        );
      }

      // Stage 54 (ADR-0024): each dispatch carries THIS ROLE's resolved config
      // (roleCfg = base overridden by agent.roles[plan.role]) — provider,
      // optional model/sandbox/approval overrides (non-null only — omitted-in
      // keeps the claude path byte-identical), and the REMAINING wall-clock
      // budget as a hard subprocess deadline (ADR-0008). With no roles map
      // roleCfg IS the base, so every flag below is byte-identical to today.
      const dispatchFlags = {
        cwd: ctx.cwd,
        'run-id': runId,
        agent: roleCfg.provider,
        'timeout-secs': remainingTimeoutSecs(policy.limits, monotonicMs() - t0),
      };
      if (roleCfg.model !== null && roleCfg.model !== undefined) {
        dispatchFlags.model = roleCfg.model;
      }
      if (roleCfg.sandbox !== null && roleCfg.sandbox !== undefined) {
        dispatchFlags.sandbox = roleCfg.sandbox;
      }
      if (roleCfg.approval !== null && roleCfg.approval !== undefined) {
        dispatchFlags.approval = roleCfg.approval;
      }
      // ADR-0011: the operator's acknowledged enforcement gaps, omitted-in — an
      // empty/absent list never reaches agent-exec, so the claude path and every
      // pre-stage-11 policy dispatch byte-identically.
      const acked = roleCfg.acknowledged_enforcement_gaps;
      if (Array.isArray(acked) && acked.length > 0) {
        dispatchFlags['acknowledge-gaps'] = acked.join(',');
      }
      // ADR-0011 tier 2, omitted-in the same way: only an explicit `2` travels,
      // so every pre-stage-14 policy dispatches byte-identically at tier 1.
      if (roleCfg.containment_tier === 2) {
        dispatchFlags['containment-tier'] = 2;
      }
      // ADR-0026 (stage 64): worker-owned work-item reconciliation, omitted-in like
      // every other knob — only an explicit true travels, so pre-stage-63 policy
      // dispatches byte-identically (no flag). agent-exec gates the flag to the plan role.
      if (roleCfg.reconcile_work_items === true) {
        dispatchFlags['reconcile-work-items'] = true;
      }
      // Stage 96 (ADR-0033, #189): the file-side sibling — the engine commits a
      // git_write:false role's intent artifacts after it returns. Omitted-in the
      // same way: only an explicit true travels, so every pre-stage-96 policy
      // dispatches byte-identically. agent-exec gates the flag to the tabled roles.
      if (roleCfg.commit_intent_artifacts === true) {
        dispatchFlags['commit-intent-artifacts'] = true;
      }
      // Stage 81 (ADR-0029): the resolved delivery substrate, omitted-in like
      // every other knob — only 'local' travels (github/absent dispatches carry
      // no flag, byte-identical), and agent-exec then narrows the role's
      // capability projection: no github_read/github_write/network on the local
      // substrate. Live since stage 83: assertSubstrateSupported admits
      // 'local' (the driver completed across stages 80–82).
      if (ctx.substrate === 'local') {
        dispatchFlags.substrate = 'local';
      }
      // ADR-0013 (stage 24), omitted-in like every other codex-only knob, now
      // PER ROLE (ADR-0024): the Verity-read GitHub facts ride along ONLY for a
      // contained CODEX dispatch that has them (the P4 first-iteration plan is
      // synthesized without consulting the dependency engine, so it carries
      // none). A claude role never gets the flag even if a decision carried
      // facts — provider-checked, so the claude path stays byte-identical.
      // Stage 94 (ADR-0031): table-checked rather than id-checked — the flag
      // rides only for a runtime whose entry says it does NOT perform its own
      // GitHub reads (codex today; byte-identical).
      if (needsAttachedFacts(roleCfg.provider) && plan.facts !== undefined) {
        dispatchFlags['state-snapshot'] = plan.facts;
      }
      // Stage 94 (ADR-0031): the WORKER-ORIGIN marker. agent-exec cannot tell a
      // human's explicit `--agent <id>` from an unattended worker dispatch, and
      // the two have different trust bars: the registry makes a driver usable
      // interactively, the TABLE is what clears it for unattended selection. So
      // the discriminator is mechanical and explicit — this flag, which the
      // worker always passes and a human never does. Its ABSENCE is exactly
      // today's behavior (an interactive run is unaffected).
      dispatchFlags['worker-dispatch'] = true;
      // Stage 111 review F2: pin down the head this review will examine,
      // before it runs. Read once, bounded (prHeadSha: gh.run's timeout, or
      // git on local); an unreadable head records 'unknown', which no resume
      // ever honours (fail closed — the approval then re-reviews).
      // Local substrate: no pointer is ever honoured there (no comment trail),
      // so no read is taken — no new git spawn on that path.
      // Round 3 (N1b): the same response also yields GitHub's timestamp for
      // the read (prHeadRead) — a head with no readable timestamp is recorded
      // 'unknown' too (a later push could not be ruled out).
      reviewedHead = null;
      if (
        ctx.substrate !== 'local' &&
        plan.role === 'review' &&
        plan.target !== null &&
        plan.target.kind === 'pr'
      ) {
        let head = 'unknown';
        let at = null;
        try {
          const read = prHeadRead(ctx, plan.target.number);
          if (read.head !== null && read.at !== null) {
            head = read.head;
            at = read.at;
          } else {
            ctx.stderr(
              `verity-worker: warn: PR #${plan.target.number}'s pre-review head read carried no ${read.head === null ? 'head SHA' : 'GitHub updatedAt timestamp'} — its verdict records head 'unknown', so an approval re-reviews rather than resumes (stage 111)`,
            );
          }
        } catch (err) {
          ctx.stderr(
            `verity-worker: warn: could not read PR #${plan.target.number}'s head before the review — its verdict records head 'unknown', so an approval re-reviews rather than resumes (${oneLine(err.message)})`,
          );
        }
        reviewedHead = { pr: plan.target.number, head, at };
      }
      res = agentExec.dispatch([plan.role, ...plan.args], dispatchFlags);
      // Stage 32 — the consumption point for a FRESH dispatch, and the
      // pre-work-vs-mid-work discriminator. A dispatch that spawned a model
      // (any success/gated/failed, OR an infra_error AFTER the model ran) IS
      // the work the approval authorized → consume, exactly once. A PRE-spawn
      // infra refusal (`unenforceable-policy` and its siblings) comes back FROM
      // this very call with ZERO spawns; agent-exec's stage-30 rule reports it
      // as a VERIFIED est_usd:0 (a genuine mid-run infra crash keeps est_usd
      // null — unknown, ADR-0008, contracts/agent-result.md), so that one
      // shape — and only that shape — leaves both labels intact.
      const preSpawnRefusal = res.outcome === 'infra_error' && res.est_usd === 0;
      if (!preSpawnRefusal) {
        consumeApproval();
      }
    }
    // A resumed role reads `<role> (resumed)` in the §7 roles line: honest
    // about what happened, and deliberately NOT the bare role name — the
    // stage-19 no-progress trail counts consecutive DISPATCHES of one role,
    // and a resume dispatched nothing (countRepeatedRole treats the annotated
    // name as a different entry, breaking the streak rather than inflating it).
    roles.push(resumed ? `${plan.role} (resumed)` : plan.role);
    invocations.push({
      role: plan.role,
      outcome: res.outcome,
      tokens: { in: res.tokens?.in || 0, out: res.tokens?.out || 0 },
      est_usd: typeof res.est_usd === 'number' ? res.est_usd : null,
      wall_secs: res.wall_secs || 0,
      tool_calls: res.tool_calls || 0,
      // Stage 53: provenance of the agent that produced this row. Stage 54
      // (ADR-0024) makes it PER ROLE — this role's resolved provider/model
      // (base overridden by agent.roles[plan.role]). A null model (the claude
      // default) is written as '' by the usage writer.
      provider: roleCfg.provider,
      model: roleCfg.model,
    });
    tokens.in += res.tokens?.in || 0;
    tokens.out += res.tokens?.out || 0;
    if (typeof res.est_usd === 'number') {
      estUsd = (estUsd ?? 0) + res.est_usd;
    }
    if (res.artifacts && Number.isInteger(res.artifacts.pr)) {
      lastPr = res.artifacts.pr;
    }
    // ADR-0013 (stage 24): perform the GitHub writes this result DECLARED,
    // before any outcome branching — a review's findings belong on the PR
    // whether the run then merges, gates, or pauses at the unknown-cost gate
    // (the human deciding at that gate needs them most). Default-closed and
    // best-effort inside; never changes the outcome.
    // Stage 31 (ADR-0014): except on a RESUME — those writes were performed
    // when the result parked (effects run before outcome branching, so they
    // always precede the park). Re-posting would duplicate the findings
    // comment, the exact canary-run-5 noise this stage removes.
    if (resumed) {
      if (res.artifacts?.effects !== undefined) {
        ctx.stderr(
          `verity-worker: note: GitHub effects declared by the resumed ${plan.role} result were already performed when it parked — not re-posted (ADR-0014)`,
        );
      }
    } else {
      // Stage 111 review round 3 (N2): a REVIEW dispatched for a PR whose
      // verdict names ANOTHER PR (F11) is never acted on — and its findings
      // are not written to the model-named PR either: they land on the PR the
      // review was dispatched for, where its gate is posted.
      let effectsPr = lastPr;
      if (
        plan.role === 'review' &&
        plan.target !== null &&
        plan.target.kind === 'pr' &&
        Number.isInteger(res.artifacts?.pr) &&
        res.artifacts.pr !== plan.target.number
      ) {
        effectsPr = plan.target.number;
        ctx.stderr(
          `verity-worker: warn: the review dispatched for PR #${plan.target.number} names PR #${res.artifacts.pr} — its findings are posted on PR #${plan.target.number}, never on the PR the model named (stage 111)`,
        );
      }
      performResultEffects(ctx, { runId, role: plan.role, res, pr: effectsPr });
    }

    // Stage 37 (canary run 6, finding N1): where a POST-dispatch park announces
    // its gate. `gateTarget` is null when the dispatch was a stage with no
    // work-item issue (a non-lockable anchor) — but a PR may have been opened
    // THIS run (`lastPr`, captured just above), and that PR is exactly the item
    // an operator can approve on. Fall back to it so the label + comment + the
    // stage-31 parked pointer land there instead of being silently skipped
    // (`gatePause`'s null-target path), which wedged the day. Only for the parks
    // BELOW: the pre-dispatch plan-gate keeps `gateTarget` (there `lastPr` is a
    // stale prior iteration's PR, not this decision's), and review:merge already
    // does its own `pr ?? gateTarget`.
    const gateAnchor = gateTarget ?? lastPr;

    // Stage 76: a builder's job ends at "PR open + CI green"; the review:merge gate
    // belongs to the reviewer/worker trust ladder (T13), never the builder. A build
    // role that self-reports `gated` (mis-declaring the merge gate it must hand OFF
    // to) opened its PR and is DONE — coerce to the success handoff so the next tick
    // dispatches review, instead of parking at a human gate that blocks review from
    // EVER running (which wedges build-through under review.trust >= 1). Guarded on a
    // real PR number so a genuine no-PR build failure is untouched. The unknown-cost
    // gate is a SEPARATE post-completion checkpoint (stage 25/31), not this branch,
    // so this never swallows a legitimate cost pause.
    // Stage 81 (ADR-0029): the guard predicate is substrate-aware — on 'local'
    // the delivered-for-review evidence is the pushed stage branch (no PR
    // exists to number); github keeps the original real-PR-number guard,
    // byte-identically (buildMisdeclaredHandoff above).
    if (plan.role === 'build' && buildMisdeclaredHandoff(res, ctx.substrate)) {
      const delivered = Number.isInteger(res.artifacts?.pr)
        ? `PR #${res.artifacts.pr}`
        : `pushed stage branch ${res.git_lifecycle?.branch}`;
      ctx.stderr(
        `verity-worker: note: build role mis-declared a merge gate — treating ${delivered} as a success handoff to review (T13: builders never own the merge gate)`,
      );
      res.outcome = 'success';
      res.gate = null;
    }

    if (res.outcome === 'gated') {
      const gate = gateNameFor(plan.role, policy);
      gatePause(ctx, {
        runId,
        policy,
        target: gateAnchor,
        gate,
        pending: `role ${plan.role} stopped at a human gate — ${plan.reason}`,
      });
      return summary('gated', gatedResult(gate), gate);
    }
    if (res.outcome === 'failed') {
      // Stage 25 (#71): a FAILED role that reported no cost spends the same
      // unverifiable dollars a successful one does, but this branch returns
      // BEFORE the ADR-0008 unknown-cost block below — so the run's ledger
      // rows landed UNGATED, and the next tick's startup breaker refused
      // `30 unknown-cost-budget` with approvable:false for the rest of the
      // UTC day, on stderr alone: nothing on GitHub to see, nothing to
      // approve. Park the unknown-cost FACT at the same gate stage 21 built
      // for the success path — the label + comment make the refusal visible
      // (stage 22's machinery, no parallel channel), and the gate stamp on
      // the run's usage rows makes the deferred refusal approvable: one
      // single-use `verity:approved`, consumed like any other P1 resume and
      // recorded in that run's §7 `budget:` line. The run's OUTCOME stays
      // failed/failed_once (the 2-strike rule below is untouched). 'fail'
      // still has no approval mechanism (stage 21 parity), and under
      // allow_with_token_limit the breaker never wedges, so only the default
      // 'gate' pauses here — claude, whose costs are real numbers, never
      // enters this block at all.
      const behavior = policy.limits.unknown_cost_behavior || 'gate';
      const costGate =
        typeof res.est_usd !== 'number' &&
        behavior !== 'fail' &&
        behavior !== 'allow_with_token_limit'
          ? UNKNOWN_COST_GATE
          : null;
      if (costGate !== null) {
        gatePause(ctx, {
          runId,
          policy,
          target: gateAnchor,
          gate: costGate,
          pending: `role ${plan.role} FAILED with its cost unknown (est_usd null), so today's spend can no longer be verified and the daily breaker will refuse the next start — unknown_cost_behavior 'gate' prices continuing at one single-use approval (ADR-0008)`,
        });
      }
      // 2-strike rule: prior strikes are `unlock:* outcome:failed*` comments on
      // the item (worker stays stateless); the current failure is strike +1.
      // Stage 85 (ADR-0029): the unlock-comment trail has no local surface
      // (contract v1 carries no comments), so prior strikes read the same
      // honest FLOOR of 0 as priorRepeats — a local failure is strike 1 and
      // retries next tick; the failed outcome itself is still recorded in the
      // usage ledger and the run log. Never a fabricated count.
      const prior =
        lockable(item) && ctx.substrate !== 'local'
          ? locks.countFailures(item, { repo: ctx.repo, cwd: ctx.cwd })
          : 0;
      const strikes = prior + 1;
      if (strikes >= 2) {
        if (anchor !== null) {
          addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
        }
        return summary(
          'failed',
          `role ${plan.role} failed (strike ${strikes} — labeled ${NEEDS_HUMAN_LABEL}): ${oneLine(res.error)}`,
          costGate,
        );
      }
      return summary(
        'failed_once',
        `role ${plan.role} failed (strike 1 — will retry on next wake-up): ${oneLine(res.error)}`,
        costGate,
      );
    }
    if (res.outcome === 'infra_error') {
      // Infra is not the item's fault: NO needs-human label.
      return summary('infra', `infra error in role ${plan.role}: ${oneLine(res.error)}`);
    }

    // ADR-0008 (stage 9): est_usd null means UNKNOWN, never $0 — the
    // accumulator above skipped it, so the daily budget breaker cannot see
    // this spend. limits.unknown_cost_behavior decides what happens next:
    //   gate (default)          → the existing GATE_PAUSE path: human-gated
    //                             until cost accounting is proven
    //   fail                    → stop the run as a failure (loud, exit 20)
    //   allow_with_token_limit  → proceed; token ceilings remain the bound
    // This runs BEFORE the trust ladder so an unknown-cost review can never
    // reach the merge decision (fail closed).
    if (typeof res.est_usd !== 'number') {
      const behavior = policy.limits.unknown_cost_behavior || 'gate';
      if (behavior === 'fail') {
        return summary(
          'failed',
          `role ${plan.role} completed with unknown cost (est_usd null) and limits.unknown_cost_behavior is 'fail' — stopping the run (ADR-0008)`,
        );
      }
      if (behavior !== 'allow_with_token_limit') {
        gatePause(ctx, {
          runId,
          policy,
          target: gateAnchor,
          gate: UNKNOWN_COST_GATE,
          pending: `role ${plan.role} completed but its cost is unknown (est_usd null) — unknown_cost_behavior 'gate' pauses for a human until cost accounting is proven (ADR-0008)`,
          // Stage 31 (ADR-0014): this is a POST-COMPLETION park — the role
          // finished and its T05 result persists under ~/.verity/logs — so
          // the gate records the durable pointer an approval resumes from.
          // The stage-25 failed-run park above records none: a failure's
          // approval lets the day proceed, it never replays the failure.
          // Stage 111 review F1/F2/F11: every posted pointer is recorded
          // locally first; a REVIEW's pointer anchors to the head read before
          // it ran and exists only for the PR it was dispatched for.
          parked: recordPark(
            ctx,
            plan.role === 'review'
              ? reviewParkPointer(ctx, {
                  pr: lastPr,
                  targetPr:
                    plan.target !== null && plan.target.kind === 'pr' ? plan.target.number : null,
                  reviewedHead,
                }).parked
              : parkedResultPointer(ctx, { role: plan.role, pr: lastPr }),
            { gate: UNKNOWN_COST_GATE, runId },
          ),
        });
        return summary('gated', gatedResult(UNKNOWN_COST_GATE), UNKNOWN_COST_GATE);
      }
    }

    // T13 — trust ladder (§4.5). The review agent has NO merge tool (T06); a
    // completed review only REPORTS its verdict via the T05 marker
    // (artifacts.verdict). The merge/gate decision is deterministic code here.
    if (plan.role === 'review') {
      const verdict =
        typeof res.artifacts?.verdict === 'string' ? res.artifacts.verdict.toLowerCase() : null;
      const pr = Number.isInteger(res.artifacts?.pr) ? res.artifacts.pr : lastPr;
      const gate = gateNameFor('review', policy);
      // Stage 81 (ADR-0029 §3): the stage-79 substrate travels inside the same
      // injectable ghOpts bag trust already takes — on 'local' checksGreen
      // reads the stage-80 snapshot and trust.merge performs the engine's
      // --no-ff merge; 'github' (and the undefined of a unit-built ctx) leaves
      // every gh call byte-identical. Live since stage 83:
      // assertSubstrateSupported admits 'local' (the driver is complete).
      // Stage 84 (stage-81 review finding 2): the stamp is LOCAL-ONLY — a
      // github run's ghOpts carries no substrate key, so the bag every gh call
      // receives stays exactly what it was before ADR-0029 (no
      // contract-adjacent pollution riding along on github substrates).
      const ghOpts =
        ctx.substrate === 'local' ? { cwd: ctx.cwd, substrate: 'local' } : { cwd: ctx.cwd };
      const trustLevel = policy.review.trust;
      // Stage 94 (ADR-0031): the ladder is now PROVENANCE-aware. Until this
      // stage nothing in this path asked WHICH RUNTIME produced the verdict —
      // `res.artifacts.verdict` was a self-reported string from whatever
      // provider had just run, and it reached a real `trust.merge`. Merge
      // authority is now a trust-table property of the provider that produced
      // the verdict (the RESOLVED provider for the `review` role, not the base):
      // a runtime without it GATES, exactly as an absent/unknown verdict does
      // today — it never silently merges and never loops back into review.
      // claude and codex both carry `merge_authority: true`, so no current run
      // changes.
      const reviewEntry = tiers.getTier(roleCfg.provider);
      const hasMergeAuthority = reviewEntry !== null && reviewEntry.merge_authority === true;

      // Stage 111 review F11: the PR the dependency engine dispatched this
      // review FOR. The verdict's own `artifacts.pr` is a model claim; a
      // verdict naming a different PR is never acted on (no merge, no pointer).
      const targetPr =
        plan.target !== null && plan.target.kind === 'pr' ? plan.target.number : null;
      const prMismatch = pr !== null && targetPr !== null && pr !== targetPr;

      // Stage 111 (ADR-0014 amended 2026-09-27, #291): the trust-0 approval
      // fact. TRUE only when every link holds: this run resumed a completed
      // review's review:merge park (so the verdict is the exact one the human
      // read, on a head re-verified unchanged, from a BOT-authored gate comment
      // matching the local park record — review F1), for this PR, which is the
      // PR the decision targets (F11), on a decision the dependency engine
      // derived from the label gate (`plan.approved`), for a P1 item whose
      // single-use token this run holds — AND (review F3/F4) that token's
      // latest `labeled` event is newer than the gate comment it answers, by an
      // actor that is not the bot (and is in `humans:` when configured). A
      // moved head never gets here (the resume refused → a FRESH review, whose
      // verdict no human has seen, re-gates) — an approval never merges a head
      // it did not examine. A refused label buys a zero-cost RE-GATE: the
      // resumed verdict gates again (a new bot gate comment) and the stale
      // token is consumed, so only a label applied after that comment merges.
      const approvalCandidate =
        reviewMergeResume &&
        resumedPointer !== null &&
        resumedPointer.pr === pr &&
        targetPr === pr &&
        plan.approved === true &&
        item.tier === 'P1';
      // Round 3 (N1b): a resumed approve verdict whose PR timeline could not
      // be read to rule out a push after the review's head read never merges
      // (any trust) — it re-gates at zero cost, the pointer kept, exactly as
      // an unreadable label timeline does (F3). A push FOUND never gets here:
      // the resume refused and this is a fresh review.
      const pushUnverified =
        resumedPointer !== null && resumedPushCheck !== null && resumedPushCheck.verified !== true;
      let approvalEvent = null; // the verified `labeled` event ({ at, actor })
      let approvalRefusal = null;
      if (
        approvalCandidate &&
        hasMergeAuthority &&
        verdict === 'approve' &&
        trustLevel === 0 &&
        pushUnverified
      ) {
        approvalRefusal = resumedPushCheck.reason;
      } else if (
        approvalCandidate &&
        hasMergeAuthority &&
        verdict === 'approve' &&
        trustLevel === 0
      ) {
        // The label lives on the ITEM (`item.number`); the push check read the
        // merge target's timeline (`resumedPushCheck.pr`). Same number ⇒ the
        // same timeline, read once this tick.
        const judged = verifyApprovalEvent(
          ctx,
          policy,
          item.number,
          resumedPointer.commentAt,
          resumedPushCheck !== null && resumedPushCheck.pr === item.number
            ? resumedPushCheck.events
            : null,
        );
        if (judged.ok) {
          approvalEvent = judged;
        } else {
          approvalRefusal = judged.reason;
          ctx.stderr(
            `verity-worker: warn: \`${APPROVED_LABEL}\` on #${item.number} is not honoured as the trust-0 merge decision: ${judged.reason} — the parked verdict re-gates at zero cost (stage 111)`,
          );
        }
      }
      const approvedMerge = approvalCandidate && approvalEvent !== null;
      let green = null; // the green reading, when the ladder takes one
      let decision;
      if (!hasMergeAuthority) {
        decision = {
          merge: false,
          gate: true,
          reason: `the review verdict came from provider '${roleCfg.provider}', which has no merge authority in the engine's provider trust table (ADR-0031) — a verdict from a runtime not cleared to merge never reaches trust.merge; gating for a human`,
        };
      } else if (verdict !== 'approve') {
        // Fail closed: a review success without an explicit approve verdict
        // gates — it never merges, and never loops back into review.
        decision = trust.decideMerge(verdict, trustLevel, null, null);
      } else if (pr === null) {
        decision = {
          merge: false,
          gate: true,
          reason: 'approve verdict carries no PR number — cannot act deterministically',
        };
      } else if (prMismatch) {
        decision = {
          merge: false,
          gate: true,
          reason: `the approve verdict names PR #${pr}, but this review was dispatched for PR #${targetPr} — a verdict about another PR is never acted on (fail closed)`,
        };
      } else if (pushUnverified && trustLevel !== 0) {
        // Trust 0 reaches its own branch below: approvalRefusal already holds
        // this reason, so decideMerge gates without an approval.
        decision = {
          merge: false,
          gate: true,
          reason: `the resumed approve verdict is not acted on: ${resumedPushCheck.reason}`,
        };
      } else if (trustLevel === 1) {
        const classification = trust.classify(pr, policy, ghOpts);
        green = classification.checks_green;
        decision = trust.decideMerge(verdict, 1, classification, green);
      } else if (trustLevel === 2) {
        green = trust.checksGreen(pr, ghOpts);
        decision = trust.decideMerge(verdict, 2, null, green);
      } else if (trustLevel === 0) {
        // Stage 111: trust 0 reads green exactly as trust 2 does — the merge
        // an approval completes still demands a VERIFIED green reading, and
        // the gate copy needs it to say something true.
        green = trust.checksGreen(pr, ghOpts);
        decision = trust.decideMerge(verdict, 0, null, green, { approved: approvedMerge });
      } else {
        // anything unknown — decideMerge fails closed on those.
        decision = trust.decideMerge(verdict, trustLevel, null, null);
      }

      // Stage 111 review F6: an approved trust-0 merge that does not land (CI
      // still not green, or GitHub refused the merge) keeps the label so the
      // next tick retries — but not forever. Each such tick bumps the attempt
      // counter on the local park record (per parked verdict ⇒ per head); the
      // MAX_APPROVED_MERGE_ATTEMPTS'th parks the item `verity:needs-human`
      // (scanner-invisible) with the token consumed and NO gate comment. A
      // counter that cannot be recorded fails closed to the same park. Returns
      // the run summary to end with, or null to carry on retrying.
      // Round 3 (N4): the count is per parked verdict ONLY — a newer label
      // does not restart it, and a refused label's zero-cost re-gate carries
      // it forward (recordPark below), so no label (trusted or not) buys a
      // fresh budget. It restarts only when the bound fires: the item is then
      // parked needs-human, which only a human clearing it can undo.
      const boundApprovedMerge = (why) => {
        const prev = resumedRecord?.approval;
        const attempts =
          (prev !== null && typeof prev === 'object' && Number.isInteger(prev.attempts)
            ? prev.attempts
            : 0) + 1;
        let unrecorded = null;
        if (attempts < MAX_APPROVED_MERGE_ATTEMPTS) {
          try {
            writeParkRecord({ ...resumedRecord, approval: { at: approvalEvent.at, attempts } });
            return null;
          } catch (err) {
            unrecorded = oneLine(err.message);
          }
        } else {
          try {
            writeParkRecord({ ...resumedRecord, approval: null });
          } catch {
            // Best effort: a counter left at the bound only parks sooner.
          }
        }
        consumeApproval();
        addLabel(ctx, anchor ?? pr, NEEDS_HUMAN_LABEL);
        const cause =
          unrecorded === null
            ? `the approved trust-0 merge of PR #${pr} has not landed after ${attempts} approval tick(s) (bound ${MAX_APPROVED_MERGE_ATTEMPTS}; this tick: ${why})`
            : `the approved trust-0 merge of PR #${pr} did not land (${why}) and the attempt counter could not be recorded (${unrecorded}) — failing closed`;
        return summary(
          'failed',
          `${cause} — stopped retrying, \`${APPROVED_LABEL}\` consumed, labeled ${NEEDS_HUMAN_LABEL}; merge on GitHub, or fix the cause, clear ${NEEDS_HUMAN_LABEL} and apply \`${APPROVED_LABEL}\` again`,
        );
      };

      if (decision.merge) {
        if (approvedMerge) {
          // Stage 111: the human's trust-0 merge, pinned to the head the
          // approved verdict examined (GitHub refuses if it moved since the
          // green reading). A failed merge is reported, never retried here,
          // and LEAVES the token: the next tick re-verifies head + CI from
          // scratch (a merge that actually landed closes the PR, so the item
          // is simply never re-selected — no duplicate merge is possible) —
          // bounded by boundApprovedMerge (review F6).
          try {
            mergePr(ctx, pr, ghOpts, { matchHead: resumedPointer.head });
          } catch (err) {
            const bounded = boundApprovedMerge(`GitHub refused the merge: ${oneLine(err.message)}`);
            if (bounded !== null) {
              return bounded;
            }
            ctx.stderr(
              `verity-worker: warn: the approved trust-0 merge of PR #${pr} failed: ${oneLine(err.message)} — \`verity:approved\` left in place`,
            );
            return summary(
              'infra',
              `PR #${pr}: the approved trust-0 merge failed (${oneLine(err.message)}) — \`${APPROVED_LABEL}\` left in place; the next tick re-verifies the head and CI and retries`,
            );
          }
        } else if (reviewMergeResume && resumedPointer !== null) {
          // A resumed review:merge verdict merging under trust 1/2 is pinned to
          // the head the resume just verified, exactly as at trust 0.
          mergePr(ctx, pr, ghOpts, { matchHead: resumedPointer.head });
        } else {
          mergePr(ctx, pr, ghOpts);
        }
        consumeApproval(); // no-op unless a review:merge resume deferred it
        mergedPrs.push(pr);
        continue; // success → chain: the merged PR may unblock the next stage.
      }
      // Stage 111 token discipline: approved at trust 0 but CI not green is
      // the ONE gate that keeps `verity:approved` — the human decision is
      // made; only CI is outstanding, so the next tick retries the merge
      // without asking again (bounded, review F6). It posts NO new gate
      // comment: the pause the label answers must stay the latest bot gate
      // comment, or the kept label would read as older than its own gate
      // (review F3) — and a comment per waiting tick is the spam F6 bounds.
      // Every other re-gate consumes (no-op when a fresh dispatch already did).
      const keepApproval =
        approvedMerge &&
        hasMergeAuthority &&
        verdict === 'approve' &&
        pr !== null &&
        trustLevel === 0 &&
        green !== true;
      if (keepApproval) {
        const bounded = boundApprovedMerge('checks are not green');
        if (bounded !== null) {
          return bounded;
        }
        const hint = approvalHint({
          trust: trustLevel,
          verdict,
          greenKnown: green,
          mergeAuthority: hasMergeAuthority,
          approved: true,
        });
        return summary(
          'gated',
          `PR #${pr} reviewed, gated at ${gate} — ${decision.reason}; \`${APPROVED_LABEL}\` left in place (no new gate comment)`,
          gate,
          { approval_hint: hint },
        );
      }
      consumeApproval();
      // Stage 111 (ADR-0014 amended): a COMPLETED review with a verdict parks
      // its result — the approval resumes it at zero cost on an unchanged head.
      // A resumed result re-parks under the run that produced it and the head
      // the resume just verified; a fresh one anchors to the head read BEFORE
      // the review ran (review F2). A verdict about another PR parks nothing
      // (F11). Every posted pointer is recorded locally first (F1).
      // Round 3: a resumed verdict's re-park carries its record's pre-dispatch
      // head-read time (N1b) and attempt counter (N4) forward.
      let parked = null;
      let headNote = null;
      let carriedApproval = null;
      if (verdict !== null && verdict !== '' && Number.isInteger(pr) && !prMismatch) {
        if (resumedPointer !== null) {
          parked = {
            role: 'review',
            pr,
            head: resumedPointer.head,
            runId: resumedPointer.runId,
            headReadAt: resumedRecord?.head_read_at ?? null,
          };
          carriedApproval = resumedRecord?.approval ?? null;
        } else {
          const anchored = reviewParkPointer(ctx, { pr, targetPr, reviewedHead });
          parked = anchored.parked;
          headNote = anchored.note;
        }
      }
      parked = recordPark(ctx, parked, { gate, runId, approval: carriedApproval });
      const hint = approvalHint({
        trust: trustLevel,
        verdict,
        greenKnown: green,
        mergeAuthority: hasMergeAuthority,
        approved: false,
        hasPr: pr !== null,
        // readParkedPointer never finds a pointer on the local substrate, and
        // resumeParkedResult refuses an 'unknown' head or a head that moved
        // during the review: either way the approval cannot resume this
        // verdict, so the copy must not promise a merge.
        resumable:
          parked !== null &&
          /^[0-9a-f]{6,40}$/.test(parked.head) &&
          ctx.substrate !== 'local' &&
          headNote === null,
      });
      // Stage 36 (issue #91): an `escalate` verdict is an architectural /
      // frozen-contract blocker, distinct from a code-rework request. When the
      // review.escalate_routing kill-switch is ON (default OFF), PARK the work
      // item for a human — apply verity:needs-human to the ANCHOR (guarded like
      // the failed-strike path) and name the next role in the gate — reusing
      // stage 27's needs-human mechanism verbatim (no new label, no scanner
      // change). The PR itself stays gated with its findings comment (target
      // remains pr ?? gateTarget). Flag OFF, or any non-escalate gate
      // (request_changes / unknown / absent), routes EXACTLY as today: a plain
      // gate, no needs-human, no next-role naming.
      const escalateRouting = decision.escalate === true && policy.review.escalate_routing === true;
      if (escalateRouting && anchor !== null) {
        addLabel(ctx, anchor, NEEDS_HUMAN_LABEL);
      }
      let gateReason = escalateRouting
        ? `${decision.reason} — parked for a human (labeled ${NEEDS_HUMAN_LABEL}); resolve via /verity:plan (contract/ADR amendment)`
        : decision.reason;
      if (approvalRefusal !== null) {
        gateReason = `${gateReason} — \`${APPROVED_LABEL}\` was not honoured as the merge decision (${approvalRefusal}); apply it again after this comment`;
      }
      if (headNote !== null) {
        gateReason = `${gateReason} — ${headNote}`;
      }
      // F11: a verdict naming another PR gates on the PR this review was FOR.
      const gateOn = prMismatch ? targetPr : (pr ?? gateTarget);
      const reviewed = prMismatch ? targetPr : pr;
      gatePause(ctx, {
        runId,
        policy,
        target: gateOn,
        gate,
        pending: `review of ${reviewed === null ? 'the PR' : `PR #${reviewed}`} completed — ${gateReason}`,
        parked,
        approval: hint,
      });
      return summary(
        'gated',
        `${reviewed === null ? '' : `PR #${reviewed} reviewed, `}gated at ${gate} — ${gateReason}`,
        gate,
        { approval_hint: hint },
      );
    }
    // Stage 73 (#202): retirement is the SOLE anti-thrash mechanism. A
    // successful plan on a P4 request that produced stages retires the request's
    // `verity:request` trigger, so the P4 scanner tier never re-selects the
    // now-planned request (later ticks fall to P5, the dependency engine, and
    // do the REAL next step). Because retirement is per-request, an un-planned
    // request stays labeled and DOES plan, and a NEW request still plans even
    // when prior work's stages exist (Mode B intake) — a stage-count guard on
    // the synthesis above would have wrongly blocked that. Reaching here means
    // res.outcome === 'success' (gated/failed/infra returned above), so
    // retirement fires ONLY after a successful plan — a failed/limit_hit plan
    // never gets here and can never strand an un-planned request with its
    // trigger removed. Guarded on readStages > 0 (a plan that produced no stages
    // keeps its label). Worker-side gh write (the contained plan role cannot
    // relabel); idempotent via removeLabel's 404 tolerance.
    if (plan.role === 'plan' && item.tier === 'P4' && ledger.readStages(ctx.cwd).length > 0) {
      removeLabel(ctx, item.number, REQUEST_LABEL);
    }
    // Stage 82 (ADR-0029 §4): a completed LOCAL build gets its gates run HERE —
    // engine-performed, synchronously, where the github path would wait on CI —
    // so the re-consulted dependency engine below reads a verified green/red
    // instead of UNKNOWN. Reaching this line means res.outcome === 'success'
    // (gated/failed/infra returned above; the stage-76 handoff coercion has
    // already applied). github/absent substrates never enter (byte-identical).
    if (ctx.substrate === 'local' && plan.role === 'build') {
      runLocalGates(ctx, plan, res);
    }
    // success → chain: re-consult the dependency engine.
  }
}

// Stage 112: the worker's ONE merge call, around trust.merge (merge authority
// and the argv — pinned or not — are trust's, unchanged). trust.merge never
// re-issues a merge whose call failed ambiguously; it re-reads the PR, and a
// merge GitHub confirms landed comes back `confirmed_by: 'pr-view'` — said on
// the run log so a merge reported through a timeout is never silent.
function mergePr(ctx, pr, ghOpts, opts) {
  const res = opts === undefined ? trust.merge(pr, ghOpts) : trust.merge(pr, ghOpts, opts);
  if (res?.confirmed_by === 'pr-view') {
    ctx.stderr(
      `verity-worker: note: the merge call for PR #${pr} failed ambiguously (it may have landed) and was not re-issued; \`gh pr view\` confirms it MERGED${opts?.matchHead ? ` at the pinned head ${opts.matchHead}` : ''} (stage 112)`,
    );
  }
  return res;
}

// SUMMARIZE: post the §7 comment (append-only, one per run), write the usage
// ledger row (T11). Posting is best-effort — a comment failure must not change
// the run's outcome (the lock release in runOnce's finally is the §8.1
// invariant, not this).
function summarize(ctx, policy, summary) {
  const body = formatRunSummary(summary);
  if (summary.anchor === null) {
    ctx.stdout(body);
  } else {
    try {
      postComment(ctx, summary.anchor, body);
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: failed to post run summary on #${summary.anchor}: ${oneLine(err.message)}`,
      );
    }
  }
  recordUsage(ctx, policy, summary);
}

// Stage 33 (canary run 5, defect N4): the deferred-refusal fresh-read fallback.
//
// The scanner's P1 tier finds approved items with a label-FILTERED list query
// (`gh issue|pr list --label verity:approved`), which GitHub serves from a
// SEARCH INDEX that lags label writes by seconds-to-minutes. Pre-stage-21 that
// lag was cosmetic (see the note in runLoop). Stage 21 made it load-bearing:
// under a DEFERRED daily unknown-cost refusal a P1 pick missed to index lag
// becomes a hard `30 unknown-cost-budget` exit — the operator applies
// `verity:approved` exactly as the gate comment instructs, the lagged search
// misses it, and the tick refuses a true-but-not-yet approval indistinguishably
// from the broken-approval bug this series fixed.
//
// This bounded, NON-search re-check runs ONLY when a deferred refusal is about
// to fire (both throw sites in runOnce route through it). The asymmetry that
// makes it reliable and cheap: the carrier's `verity:awaiting-approval` label
// was applied at GATE time on a PRIOR tick, so it has long settled in the
// search index — only the freshly-added `verity:approved` is missing. So:
//   1. enumerate plausible carriers with `list --label verity:awaiting-approval`
//      (open issues AND PRs — mirroring the P1 tier's two-kind coverage); this
//      settled label makes the list reliable.
//   2. for each carrier (bounded — a handful of parked gates; NO pagination),
//      do a FRESH per-item read (`gh <noun> view N --json labels`, via
//      scanner.fetchTargetLabels) that reads the primary DB, not the index, and
//      reflects the just-applied `verity:approved` immediately.
//   3. if a fresh read shows `verity:approved`, normalize the carrier into the
//      P1 item shape and return it — it then flows through the EXISTING P1
//      downstream path (budgetApproved, consumeApproval, the budget line,
//      locking, summary) with semantics identical to a normal P1 pick.
// Cost bound: one `list` per kind (2) + at most one `view` per awaiting-approval
// carrier. Fail CLOSED — a list/read error yields no recovery, so the deferred
// refusal fires byte-identically, exactly as before this fallback existed.
function recheckApprovedCarrier(ctx) {
  // Stage 85 (ADR-0029): on the LOCAL substrate the "fresh non-search read" IS
  // the record store — committed files are strongly consistent, so the primary
  // read and the settled-label enumeration are the same act: OPEN records
  // carrying the awaiting gate, of which any also carrying `verity:approved`
  // is a confirmed P1 carrier. Same FIFO pick, same fail-CLOSED direction (a
  // store the engine cannot read yields no recovery and the deferred refusal
  // fires unchanged). Zero gh spawns; github below is byte-identical.
  if (ctx.substrate === 'local') {
    try {
      const approved = substrateLocal
        .listWorkItems(ctx.cwd)
        .filter(
          (rec) =>
            rec.state === 'OPEN' &&
            rec.labels.includes(GATE_LABEL) &&
            rec.labels.includes(APPROVED_LABEL),
        )
        .map((rec) =>
          scanner.normalize(
            { number: rec.number, title: rec.title, labels: rec.labels, createdAt: rec.created_at },
            'issue',
            'P1',
          ),
        );
      if (approved.length === 0) {
        return null;
      }
      approved.sort(scanner.byCreatedAt);
      return approved[0];
    } catch (err) {
      ctx.stderr(
        `verity-worker: warn: deferred-refusal re-check could not read the local record store (${oneLine(err.message)}) — refusing as usual`,
      );
      return null;
    }
  }
  const ghOpts = { cwd: ctx.cwd };
  const carriers = [];
  for (const kind of ['issue', 'pr']) {
    let raws;
    try {
      raws = gh.json(
        [
          kind,
          'list',
          '--label',
          GATE_LABEL,
          '--state',
          'open',
          '--json',
          'number,labels,title,createdAt',
        ],
        ghOpts,
      );
    } catch (err) {
      // The settled-label enumeration itself failed — fail closed (refuse as
      // today) rather than guess. The freshly-added approval regime is exactly
      // the search whose lag we are working around, so we never widen to it.
      ctx.stderr(
        `verity-worker: warn: deferred-refusal re-check could not list ${kind} carriers (${oneLine(err.message)}) — refusing as usual`,
      );
      return null;
    }
    for (const raw of raws) {
      carriers.push({ raw, kind });
    }
  }
  const approved = [];
  for (const c of carriers) {
    // Fresh per-item read via the shared helper (gh.cjs already retries transient
    // errors before throwing). A no-op `log` makes a per-carrier read failure a
    // SILENT fail-closed SKIP: this path is ABOUT TO refuse (exit 30) or to
    // announce a recovery — the loud signal is that outcome, not a probe miss,
    // and a missed carrier only costs one self-healing re-run. The seam doubles
    // as gh.cjs's per-attempt status logger, so passing it also keeps the
    // re-check from chattering onto the refusal's single §8.2 stderr line.
    const fresh = scanner.fetchTargetLabels(
      { kind: c.kind, number: c.raw.number },
      { ...ghOpts, log: () => {} },
    );
    if (fresh?.includes(APPROVED_LABEL)) {
      const item = scanner.normalize(c.raw, c.kind, 'P1');
      // Use the FRESH labels: the list raw is search-lagged and would omit the
      // just-applied approval, but the item's labels must tell the truth.
      item.labels = fresh;
      approved.push(item);
    }
  }
  if (approved.length === 0) {
    return null;
  }
  // Deterministic pick — the scanner's own FIFO tie-break (oldest first).
  approved.sort(scanner.byCreatedAt);
  return approved[0];
}

// One full --once run. Returns { exitCode, outcome, result }.
function runOnce(ctx) {
  // Stage 29 (canary §4 re-run, defect 6): the worker is POINTED at a
  // repository (--repo owner/name is required), yet every gh subcommand that
  // "operates on a local repository" — the §4.1 circuit-breaker query, the
  // §4.2 scanner queries, the ledger reads behind `verity next`, the trust
  // ladder's pr calls — resolved its target from the CWD's git remotes:
  // stage 23's disease (trusting the cwd over the pointed-at repo) surviving
  // past the `verity state` fix. A clone with NO remotes then died inside the
  // breaker CHECK and refused `circuit-open` for a fault that has nothing to
  // do with the kill switch, making ADR-0012's truthful `git-unprovidable`
  // refusal unreachable. Thread the pointed-at repository the way gh
  // documents for scripts: GH_REPO outranks local-remote resolution for every
  // gh subprocess this run spawns (one site finishes stage 23's threading —
  // scanner, locks, ledger, git-lifecycle included) while leaving the pinned
  // §4.1/§4.2 command shapes byte-identical. Repo-agnostic calls
  // (`auth status`, `api user`, explicit `api repos/...` paths) ignore it by
  // construction.
  //
  // Stage 34 (canary run 5, defect N5): this ONE export is also how the scan
  // path's ledger reads target the pointed-at repository — the ledger's own
  // repo resolution (resolveRepo, ledger.cjs) consumes the same GH_REPO as its
  // middle precedence rung and re-emits it EXPLICITLY on each read's argv,
  // because gh's env override never reaches `repo view` (no -R flag). So a
  // remoteless clone with --repo now gets a VERIFIED snapshot, proceeds to
  // dispatch, and refuses at the git-lifecycle grant check with ADR-0012's
  // `git-unprovidable` naming the missing remote — instead of dying
  // `state-unverified` at the scan with the truthful refusal unreachable.
  if (typeof ctx.repo === 'string' && ctx.repo !== '') {
    process.env.GH_REPO = ctx.repo;
  }
  let policy;
  try {
    policy = autonomy.loadPolicy(ctx.cwd, {
      warn: (msg) => ctx.stderr(`verity-worker: warn: ${msg}`),
    });
  } catch (err) {
    // Startup checks fail fast with exit 30 (§4.1) — even though `verity
    // autonomy validate` itself exits 20 for the same problem.
    throw new WorkerError(oneLine(err.message), 'bad-policy');
  }
  if (policy.mode === 'manual') {
    ctx.stdout(autonomy.WORKER_DISABLED_MESSAGE);
    return { exitCode: 0, outcome: 'disabled', result: autonomy.WORKER_DISABLED_MESSAGE };
  }
  // Stage 80 (ADR-0029): stamp the resolved substrate on the run context so
  // the item ops above dispatch without re-reading the policy. Stamped BEFORE
  // the check below on purpose — the check is the flow control, the stamp is
  // bookkeeping.
  ctx.substrate = policy.substrate;
  // Stage 85 (operator-smoke runs 4/5): export the run's FROZEN substrate to
  // every child this run spawns — the GH_REPO export's exact pattern, one
  // line below it in spirit. A dispatched role shells engine commands from a
  // stage-branch checkout whose tree can PREDATE the substrate policy (the
  // smoke's skew: stage branches fork off origin/<default>), and a cwd
  // re-derivation there flipped `verity state`/`verity stage pr`/`verity
  // operator snapshot` onto the github paths mid-local-run. The pin is the
  // run's own resolution traveling with the run (substrate-local
  // pinnedSubstrate honors ONLY the value 'local'); github runs export
  // nothing — byte-identical.
  // Stage 90: non-local runs also CLEAR an inherited pin. An operator shell
  // that still carries VERITY_SUBSTRATE=local after a local run (or a wrapper
  // script that exported it) would otherwise leak the stale pin to every
  // child of a github run — and pinnedSubstrate honors it: the stage-85
  // cwd-flip hazard in reverse. Deleting an absent var is a no-op, so a
  // clean environment stays byte-identical.
  if (ctx.substrate === 'local') {
    process.env.VERITY_SUBSTRATE = 'local';
  } else {
    // Assigning undefined would set the env var to the string "undefined".
    delete process.env.VERITY_SUBSTRATE;
  }
  // Stage 79 (ADR-0029): a policy selecting a substrate this engine cannot
  // drive is refused ONCE, here at policy resolution — before any gh call,
  // scan, label, or lock, exactly like the bad-policy refusal above and the
  // tier gate below. Stage 83 lifted the refusal for 'local' (drivers landed
  // in stages 80–82); unknown values still refuse fail-closed.
  assertSubstrateSupported(policy);
  // ADR-0011: unattended codex autonomy is refused below tier 2 — before any
  // gh call, scan, label, or lock, exactly like the bad-policy refusal above.
  assertContainmentTier(policy, resolveEffectiveAgent(policy));
  locateLedger(ctx); // stage 112: an unlocatable ledger refuses the run (infra) — never read as zero
  prepareLedger(ctx); // stage 108: seed the git-dir ledger once, before the daily-limit check reads it
  const checks = startupChecks(ctx, policy); // the rest of §4.1: daily limits, auth, identity, breaker
  if (!checks.ok) {
    throw new WorkerError(checks.message, checks.slug);
  }
  // Stage 111 review F1: the bot identity rides the run context — a parked
  // pointer is honoured only from a gate comment this login authored (null ⇒
  // none is: the local substrate, or an identity the lookup could not name).
  ctx.botLogin = checks.botLogin ?? null;

  const runId = makeRunId();
  // The scanner's P5 tier yields nothing for a GATED decision, so a repository
  // parked at a gate would read as plain idle. Capture the decision it computed
  // (the seam already exists; this costs no extra gh call) so the gate can be
  // ANNOUNCED on GitHub when nobody has been told yet (stage 22 below), and so
  // the steady-state idle line can say WHY — a stage stopped at the stage-19
  // ci:unverified gate must never look like "nothing to do".
  let p5Decision = null;
  // Stage 28: the scanner's P4 no-self-feeding rule is by design, but its
  // silence was not — in a single-account setup (operator == bot) an open
  // `verity:request` read as plain "no eligible work" and the operator could
  // not tell "no work exists" from "your request was filtered". The scanner
  // reports the drop through its warn seam; it surfaces HERE, as a stderr
  // note on every tick that filtered something, and below as a qualified
  // idle reason. Stdout/log only — never a comment on the skipped issues.
  let selfSkipNote = null;
  let item = scanner.scan({
    cwd: ctx.cwd,
    botLogin: checks.botLogin,
    // Stage 85 (ADR-0029): the resolved substrate rides into the scanner so
    // its tier queries read the local record store instead of gh on 'local'
    // (github: byte-identical queries). The lock predicate is likewise
    // substrate-aware — the §4.3 lock protocol is a GitHub-comment protocol
    // with NO local surface (contract v1 carries no comments), so on local
    // nothing reads as locked and the run proceeds locklessly (announced at
    // the acquire site below; single-operator store, sequential --once ticks).
    substrate: ctx.substrate,
    isLocked: (it) =>
      lockable(it) &&
      ctx.substrate !== 'local' &&
      locks.isFreshlyLocked(it, { repo: ctx.repo, cwd: ctx.cwd }),
    warn: (msg) => {
      selfSkipNote = msg;
      ctx.stderr(`verity-worker: note: ${msg}`);
    },
    nextDecision: () => {
      p5Decision = next.dispatch([], { cwd: ctx.cwd });
      return p5Decision;
    },
  });

  // Stage 33: before a DEFERRED daily unknown-cost refusal fires — at either
  // throw site below, the empty-scan (`item === null`) path or the non-P1
  // fell-through path — do the bounded non-search re-check for a P1 approval the
  // search index missed to lag. A recovery REPLACES `item` with the P1 carrier
  // and flows through the ordinary P1 path unchanged (budgetApproved,
  // consumeApproval, the budget line, locking, summary); no recovery leaves
  // `item` exactly as the scan returned it, so every existing refusal / idle /
  // gate-announcement branch below stays byte-identical. Skipped when `verity
  // next` could not verify state at all (a state-unverified gate on an empty
  // scan): that is a read-failure refusal of its own (thrown below), not the
  // deferred budget refusal, and the re-check's reads would fail there too.
  const deferredArmed = checks.deferredDaily !== null && checks.deferredDaily !== undefined;
  const stateGatePending =
    item === null && p5Decision !== null && p5Decision.gate === next.STATE_GATE;
  if (deferredArmed && !stateGatePending && (item === null || item.tier !== 'P1')) {
    const recovered = recheckApprovedCarrier(ctx);
    if (recovered !== null) {
      ctx.stderr(
        `verity-worker: note: a P1 ${APPROVED_LABEL} on ${recovered.kind} #${recovered.number} was missed by the search-indexed scan (index lag) but confirmed by a fresh read — proceeding on it rather than refusing the deferred budget (stage 33)`,
      );
      item = recovered;
    }
  }

  if (item === null) {
    // Stage 20 (issue #60): the P5 tier could not read GitHub state at all, so
    // "no eligible work" would be the same confident falsehood one layer up —
    // and an idle exit 0 is precisely what a cron-driven worker's operator
    // reads as "all quiet". Refuse instead, before any lock or label.
    if (p5Decision !== null && p5Decision.gate === next.STATE_GATE) {
      throw new WorkerError(p5Decision.reason, 'state-unverified');
    }
    // Stage 21: the scan found no approved item, so the deferred unverifiable-
    // budget refusal fires now — an idle exit 0 would read as "all quiet" on a
    // day whose spend nobody can verify. Deliberately BEFORE the gate
    // announcement below: this refusal is read-only (no lock, label, or
    // comment), exactly as stage 21 built it.
    if (checks.deferredDaily !== null && checks.deferredDaily !== undefined) {
      throw new WorkerError(checks.deferredDaily.message, checks.deferredDaily.slug);
    }
    // Stage 22 (issue #59): a gated P5 decision the human has never been told
    // about. The scanner yields no item for a gated decision, so before this
    // branch a repository whose ONLY finding was e.g. the stage-19
    // ci:unverified gate parked as plain `idle` — correct refusal, visible
    // nowhere but stdout, which a cron-driven worker's operator never reads.
    // Announce it ONCE through the machinery every other gate already uses —
    // GATE_PAUSE (label + comment + approval instruction on the decision's
    // GitHub target) and the §7 SUMMARIZE — and report the run as GATED, not
    // idle: "idle" means no work exists, and that is not what happened.
    // `announced` is the dependency engine saying the gate label is already on
    // the target (this very announcement on a previous tick, or a human's own
    // label), so the steady state below stays quiet: no re-label, no comment
    // spam while the run waits for the approval its comment asked for. The
    // approval then flows exactly as for any other gate — `verity:approved`
    // makes the item a P1 pick on the next tick, which consumes the token.
    if (p5Decision !== null && p5Decision.action === 'gated' && p5Decision.announced !== true) {
      const target =
        p5Decision.target !== null && p5Decision.target.kind !== 'stage'
          ? p5Decision.target.number
          : null;
      gatePause(ctx, { runId, policy, target, gate: p5Decision.gate, pending: p5Decision.reason });
      const summary = {
        runId,
        repo: ctx.repo,
        item: { kind: p5Decision.target?.kind ?? 'stage', number: target, tier: 'P5' },
        anchor: target,
        outcome: 'gated',
        gate: p5Decision.gate,
        result: `gated at ${p5Decision.gate} — ${p5Decision.reason}`,
        roles: [],
        invocations: [],
        // Stage 53: record the run's configured provenance even on this
        // zero-dispatch gate announcement — the run HAD an agent config; a null
        // model writes '' at the usage layer, never a fabricated value.
        provider: resolveEffectiveAgent(policy).provider,
        model: resolveEffectiveAgent(policy).model,
        tokens: { in: 0, out: 0 },
        // A VERIFIED zero, not an unknown: this run dispatched no model, so
        // its cost is genuinely $0. Recording null here would serialize to an
        // unknown-cost ledger row stamped with THIS gate (not 'unknown-cost'),
        // which stage 21's rollup reads as UNGATED unknown spend — and the
        // next tick's startup breaker would then exit 30 unknown-cost-budget,
        // unapprovable, wedging the very operator the gate comment just asked
        // to approve. ADR-0008's "null never counts as $0" is about model runs
        // whose provider reported no cost; a run with zero dispatches is not
        // one of those.
        est_usd: 0,
        wall_secs: 0,
      };
      summarize(ctx, policy, summary);
      ctx.stdout(`verity-worker: ${runId} gated — ${summary.result}`);
      return { exitCode: EXIT_CODES.gated, outcome: 'gated', result: summary.result };
    }
    // Stage 28: a bare "no eligible work" is a half-truth when the P4 filter
    // dropped the operator's own request this very scan — qualify it.
    let why = 'no eligible work';
    if (p5Decision !== null && p5Decision.action === 'gated') {
      why = `no eligible work — gated at ${p5Decision.gate}: ${p5Decision.reason}`;
    } else if (p5Decision !== null && p5Decision.status === next.WAITING_FOR_CI) {
      // Stage 68 (ADR-0027): the ci:unverified gate is DEFERRED — the PR is
      // fresh and CI is still registering. This is NOT "nothing to do" and NOT a
      // gate: no label, no comment, no model run — the next tick re-reads the
      // (by then registered) checks. Say so on stdout, exit 0.
      why = p5Decision.reason;
    } else if (selfSkipNote !== null) {
      why = `no eligible work — ${selfSkipNote}`;
    }
    ctx.stdout(`verity-worker: idle — ${why}`);
    return { exitCode: 0, outcome: 'idle', result: why };
  }

  // Stage 21 (#58, ADR-0008): the deferred unverifiable-budget refusal is
  // resolved by the scan itself. A P1 item means a human applied the single-use
  // `verity:approved` the unknown-cost gate comment asked for — exactly the
  // per-run decision ADR-0008 prices 'gate' at — so THIS run proceeds and says
  // so out loud (the token is consumed in runLoop as for any P1 resume, so the
  // next unverifiable run gates again). Anything else refuses with stage 18's
  // failure, unchanged and still read-only (no lock, label, or comment yet).
  let budgetApproved = false;
  if (checks.deferredDaily !== null && checks.deferredDaily !== undefined) {
    if (item.tier !== 'P1') {
      throw new WorkerError(checks.deferredDaily.message, checks.deferredDaily.slug);
    }
    budgetApproved = true;
    ctx.stderr(
      `verity-worker: warn: daily budget cannot be verified (${checks.deferredDaily.totals.unknown_cost_runs} unknown-cost run(s) today, UTC) — proceeding on the operator's single-use ${APPROVED_LABEL} on ${item.kind} #${item.number}; the approval covers this run only (ADR-0008)`,
    );
  }

  let acquired = false;
  if (lockable(item) && ctx.substrate === 'local') {
    // Stage 85 (ADR-0029): the §4.3 lock is a GitHub-comment protocol —
    // contract local-work-item v1 (frozen) carries no comments, so there is no
    // local lock surface to write. Proceed WITHOUT a lock, out loud (the same
    // honest shape the non-lockable stage path takes): a single-operator local
    // store runs `--once` ticks sequentially, and stage 84's operator snapshot
    // reports worker.lock as honestly absent for the same reason.
    ctx.stderr(
      'verity-worker: note: local substrate has no lock surface (the §4.3 lock is a GitHub-comment protocol; contract local-work-item v1 carries no comments) — proceeding without a lock (stage 85, ADR-0029)',
    );
  } else if (lockable(item)) {
    const lock = locks.acquire(item, {
      runId,
      ttlMinutes: policy.limits.max_wall_clock_min, // ×1.5 headroom applied in locks
      repo: ctx.repo,
      cwd: ctx.cwd,
    });
    if (!lock.acquired) {
      // §8.5: accidental double-start — the second instance exits 0 "locked".
      ctx.stdout(
        `verity-worker: locked — ${item.kind} #${item.number} held by ${lock.holder.runId} (expires ${lock.holder.expires})`,
      );
      return { exitCode: 0, outcome: 'locked', result: 'item locked by another run' };
    }
    acquired = true;
  } else {
    ctx.stderr(
      `verity-worker: note: ${item.kind} target has no work-item issue — proceeding without a GitHub lock`,
    );
  }

  let outcome = 'infra'; // what the unlock comment says if we crash mid-loop
  try {
    const summary = runLoop(ctx, { policy, runId, item, budgetApproved });
    outcome = summary.outcome;
    summarize(ctx, policy, summary);
    ctx.stdout(`verity-worker: ${runId} ${outcome} — ${summary.result}`);
    return { exitCode: EXIT_CODES[outcome], outcome, result: summary.result };
  } finally {
    if (acquired) {
      locks.release(item, { runId, outcome, repo: ctx.repo, cwd: ctx.cwd }); // never throws (§8.1)
    }
  }
}

// --- CLI ----------------------------------------------------------------------

function parseWorkerArgs(argv) {
  const opts = { repo: null, once: false, watch: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') {
      i += 1;
      opts.repo = argv[i];
    } else if (a === '--cwd') {
      i += 1;
      opts.cwd = argv[i];
    } else if (a === '--once') {
      opts.once = true;
    } else if (a === '--watch') {
      opts.watch = true;
    } else {
      throw new WorkerError(`unknown argument '${a}' — ${USAGE}`, 'usage');
    }
  }
  return opts;
}

function main(argv) {
  const stdout = (line) => process.stdout.write(`${line}\n`);
  const stderr = (line) => process.stderr.write(`${line}\n`);
  try {
    const opts = parseWorkerArgs(argv);
    if (opts.watch) {
      throw new WorkerError('--watch is not implemented yet (T17) — use --once', 'not-implemented');
    }
    // Stage 52 (#135): the shared slug check. The old inline
    // /^[^/\s]+\/[^/\s]+$/ accepted 'acme/widget?' and 'acme/widget#', which
    // `gh api` truncates — retargeting apiBase (index.cjs) and locks.cjs.
    if (!gh.isRepoSlug(opts.repo)) {
      throw new WorkerError(`--repo owner/name is required — ${USAGE}`, 'usage');
    }
    if (!opts.once) {
      throw new WorkerError(`--once is required (the only implemented mode) — ${USAGE}`, 'usage');
    }
    const { exitCode, outcome, result } = runOnce({
      repo: opts.repo,
      cwd: opts.cwd,
      stdout,
      stderr,
    });
    if (exitCode !== 0) {
      stderr(`verity-worker: ${exitCode} ${ERROR_SLUGS[outcome] || 'error'}: ${oneLine(result)}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    const code = err instanceof WorkerError ? err.exitCode : 30;
    const slug = err instanceof WorkerError ? err.slug : 'internal';
    stderr(`verity-worker: ${code} ${slug}: ${oneLine(err.message)}`);
    process.exitCode = code;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  APPROVAL_ACTION,
  approvalHint,
  CIRCUIT_LABEL,
  ERROR_SLUGS,
  EXIT_CODES,
  GATE_COMMENT_PREFIX,
  GATE_LABEL,
  MAX_APPROVED_MERGE_ATTEMPTS,
  MAX_REPEAT_DISPATCHES,
  NEEDS_HUMAN_LABEL,
  OUTCOME_BADGES,
  PARKED_POINTER_RE,
  RECOGNIZED_EFFECTS,
  UNKNOWN_COST_GATE,
  USAGE,
  WorkerError,
  assertContainmentTier,
  assertSubstrateSupported,
  buildMisdeclaredHandoff,
  checkLimits,
  countRepeatedRole,
  formatFindingsComment,
  formatGateComment,
  formatRunSummary,
  performResultEffects,
  gateNameFor,
  judgeApprovalEvent,
  latestGatePause,
  main,
  makeRunId,
  parkRecordMismatch,
  parkRecordPath,
  parseGatePause,
  parkedResultPointer,
  parseWorkerArgs,
  prHeadRead,
  prHeadSha,
  pushesSince,
  PUSH_EVENTS,
  readParkRecord,
  readParkedPointer,
  readTimeline,
  TIMELINE_MAX_PAGES,
  TIMELINE_PER_PAGE,
  recheckApprovedCarrier,
  recordUsage,
  resumeParkedResult,
  remainingTimeoutSecs,
  resolveEffectiveAgent,
  runLocalGates,
  runLoop,
  summaryRoles,
  runOnce,
  startupChecks,
};
