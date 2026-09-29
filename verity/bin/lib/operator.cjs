// Operator snapshot — `verity operator snapshot --json` (stage 47,
// contracts/operator-snapshot.md, frozen v1). A single READ-ONLY projection: it
// RECOMPOSES Verity's already-externalised state into one operator-facing
// snapshot and adds NO independent lifecycle inference. Consumers (the Verity
// Console, cron reports, `jq`) render it; they never recompute it.
//
// Invariants (contract §Invariants), each enforced below:
//   1. Read-only. No git/gh writes, no fs writes, no label/comment/PR mutation.
//      Every source call here is a pure read (ledger.fetchSnapshot, usage
//      rollup, autonomy.loadPolicy, doctor probes, engine-meta).
//   2. Not a second state machine. `next` is `next.decide` projected verbatim
//      (via next.dispatch with the SAME injected snapshot), never re-derived —
//      so snapshot.next can never disagree with `verity state next`.
//   3. Evidence provenance (ADR-0013). Every field is Verity- or GitHub-observed
//      — never an agent's self-claim.
//   4. Honest-unknown / fail-closed (ADR-0008). Unreachable GitHub ⇒ online:false
//      + health.github "unavailable" + queue counts nulled (never a fabricated
//      all-zero "all clear"). Unverified cost ⇒ null, NEVER 0. Any unobserved
//      field ⇒ null.
//   5. Secret redaction. The whole output passes through ledger.redact before it
//      leaves the process — no token/credential shape can leak in any reason.
//   6. Determinism of source, except `generated_at`.
//
// Kill-switch / dark-launch: `operator` is a net-new, read-only noun. NOTHING in
// the worker/scanner/trust paths calls this module; removing the single
// `operator` line from verity.cjs's COMMANDS fully disables it with zero
// lifecycle impact.
const ledger = require('./ledger.cjs');
const next = require('./next.cjs');
const autonomy = require('./autonomy.cjs');
const usage = require('./usage.cjs');
const doctor = require('./doctor.cjs');
// Stage 48: trust.classify is imported for READ evidence only (it does one
// `gh pr view`/`gh pr diff` per gated PR) — NEVER to drive a merge. It is
// injectable via opts.classify so the contract test runs with zero network.
const trust = require('./trust.cjs');
// Stage 80 (ADR-0029): the snapshot acquirer is the delivery-substrate seam —
// fetchSubstrateSnapshot routes 'local' policies to the local driver and
// everything else to ledger.fetchSnapshot with identical args (byte-identical).
// The projections below stay substrate-blind: they consume the snapshot shape,
// never the substrate.
const substrateLocal = require('./substrate-local.cjs');
// Stage 115 (ADR-0038 D4): the spec-soundness gate's one text shape — the
// worker writes the gate comment with it, `gates` reads `gaps[]` back with it.
const specSoundness = require('./spec-soundness.cjs');

const SCHEMA = 1;

const NEEDS_HUMAN_LABEL = 'verity:needs-human';
const AWAITING_APPROVAL_LABEL = 'verity:awaiting-approval';
const APPROVED_LABEL = 'verity:approved';
const IN_PROGRESS_LABEL = 'verity:in-progress';
const CIRCUIT_OPEN_LABEL = 'verity:circuit-open';
const REQUEST_LABEL = 'verity:request';

// Repository resolution, mirroring ledger.resolveRepo (not exported): an
// explicit --repo/--gh-repo wins, then the GH_REPO env var, then null (the
// snapshot itself was resolved from the cwd's git remotes — that name is not
// surfaced by fetchSnapshot, so it stays null rather than being guessed).
function resolveRepo(explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }
  const env = process.env.GH_REPO;
  return typeof env === 'string' && env !== '' ? env : null;
}

// Normalize one GitHub label (string or {name}) to a lowercased name.
function labelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').toLowerCase();
}

// Every label carried by a GitHub item, lowercased.
function itemLabels(item) {
  return new Set((item?.labels || []).map(labelName));
}

// The union of a stage's work-item issue AND its PR labels — the same union
// next.cjs reads for the gate vocabulary (a gate label lives on whichever item
// the worker targeted).
function stageLabelUnion(stage, snapshot) {
  const set = new Set();
  const add = (item) => {
    for (const l of itemLabels(item)) {
      set.add(l);
    }
  };
  if (stage.issue !== null && stage.issue !== undefined) {
    add((snapshot.issues || []).find((i) => i.number === stage.issue));
  }
  if (stage.pr !== null && stage.pr !== undefined) {
    add((snapshot.prs || []).find((p) => p.number === stage.pr));
  }
  return set;
}

// Is `label` present anywhere in the snapshot's issues or PRs? Bounded — reads
// only labels already in the snapshot, never a per-item network fan-out.
function snapshotHasLabel(snapshot, label) {
  const has = (item) => itemLabels(item).has(label);
  return (snapshot.issues || []).some(has) || (snapshot.prs || []).some(has);
}

// Queue buckets, GitHub-observed only. Each NON-MERGED stage is classified into
// EXACTLY ONE bucket by precedence (labels first — an explicit human/worker
// state outranks a derived one), so buckets never overlap or double-count:
//   needs_human       > awaiting_approval > in_progress > waiting_for_ci
//   > ready (unblocked) > blocked (deps unmet)
// Honest-unknown (ADR-0008 / contract invariant 4): when GitHub is unreachable
// (`online:false`) the counts were NOT observed, so every bucket is null — never
// a zero-filled all-clear.
// The per-stage bucket decision — the CORRECTNESS SPINE shared by `computeQueue`
// (which COUNTS) and `work` (which ITEMIZES), so a count can never disagree with
// its list (contract §Invariants: counts == list). Each NON-MERGED stage lands in
// EXACTLY ONE bucket by precedence (labels first — an explicit human/worker state
// outranks a derived one):
//   needs_human > awaiting_approval > in_progress > waiting_for_ci
//   > ready (unblocked) > blocked (deps unmet)
// Returns null for a merged stage (not a queue member).
function bucketOf(stage, labels, unblocked) {
  if (stage.status === 'merged') {
    return null;
  }
  if (labels.has(NEEDS_HUMAN_LABEL)) {
    return 'needs_human';
  }
  if (labels.has(AWAITING_APPROVAL_LABEL) && !labels.has(APPROVED_LABEL)) {
    return 'awaiting_approval';
  }
  if (labels.has(IN_PROGRESS_LABEL)) {
    return 'in_progress';
  }
  if (stage.status === 'building') {
    // deriveStatus: an OPEN PR whose CI is not green is `building` — i.e.
    // still waiting on CI (or a further build) before it can be reviewed.
    return 'waiting_for_ci';
  }
  if (unblocked.has(stage.number)) {
    return 'ready';
  }
  return 'blocked';
}

// Queue buckets, GitHub-observed only — COUNTED via bucketOf so the snapshot's
// counts and `work`'s itemized list share one classifier. Honest-unknown
// (ADR-0008 / contract invariant 4): when GitHub is unreachable (`online:false`)
// the counts were NOT observed, so every bucket is null — never a zero-filled
// all-clear.
function computeQueue(proj, snapshot, online) {
  if (!online) {
    return {
      ready: null,
      in_progress: null,
      waiting_for_ci: null,
      awaiting_approval: null,
      needs_human: null,
      blocked: null,
    };
  }
  const unblocked = new Set(proj.next);
  const q = {
    ready: 0,
    in_progress: 0,
    waiting_for_ci: 0,
    awaiting_approval: 0,
    needs_human: 0,
    blocked: 0,
  };
  for (const s of proj.stages) {
    const bucket = bucketOf(s, stageLabelUnion(s, snapshot), unblocked);
    if (bucket !== null) {
      q[bucket] += 1;
    }
  }
  return q;
}

// Stage 114 (ADR-0038 D7; operator-snapshot additive note 2026-09-29): pending
// intake. OPEN `verity:request` items, split on `verity:needs-human` —
// GitHub-observed labels from the snapshot's OWN issue fetch (github) or the
// record store the local snapshot already lists (local); no new read. They
// count requests AS LABELLED: the scanner's P4 author/register filter is
// deliberately not re-derived here (contract note). Honest-unknown: offline,
// or an issue list the snapshot could not read (null), ⇒ both null. `oldest`
// is the LOWEST pending number — the deterministic stand-in for the scanner's
// createdAt FIFO, because the snapshot's issue fetch carries no createdAt (and
// this projection adds no fetch to get one).
function computeRequests(snapshot, online) {
  if (!online || !Array.isArray(snapshot.issues)) {
    return { pending: null, parked: null, oldest: null };
  }
  let pending = 0;
  let parked = 0;
  let oldest = null;
  for (const issue of snapshot.issues) {
    if (String(issue?.state || '').toUpperCase() !== 'OPEN') {
      continue;
    }
    const labels = itemLabels(issue);
    if (!labels.has(REQUEST_LABEL)) {
      continue;
    }
    if (labels.has(NEEDS_HUMAN_LABEL)) {
      parked += 1;
    } else {
      pending += 1;
      if (Number.isInteger(issue.number) && (oldest === null || issue.number < oldest)) {
        oldest = issue.number;
      }
    }
  }
  return { pending, parked, oldest };
}

// The worker's OWN P4 synthesis (worker/index.cjs, the `first && item.tier ===
// 'P4'` branch): plan on the request issue. Mirrored, not re-derived — used
// only when next.decide has no action and a request is pending.
function requestNext(number) {
  return {
    role: 'plan',
    target_type: 'issue',
    target: number,
    reason: `request #${number} needs planning`,
  };
}

// kind (next.decide target) → contract target_type.
function mapTargetType(kind) {
  if (kind === 'pr') {
    return 'pull_request';
  }
  if (kind === 'issue') {
    return 'issue';
  }
  if (kind === 'stage') {
    return 'stage';
  }
  return null;
}

// Project a next.decide() decision onto the contract's `next`. `null` only when
// there is genuinely no next action (idle); a gate IS a next action and is
// projected (a state:unverified gate carries no role/target, so those null).
function projectNext(decision) {
  if (!decision || decision.action === 'idle') {
    return null;
  }
  const kind = decision.target ? decision.target.kind : undefined;
  const number =
    decision.target && typeof decision.target.number === 'number' ? decision.target.number : null;
  return {
    role: decision.role ?? null,
    target_type: mapTargetType(kind),
    target: number,
    reason: decision.reason ?? null,
  };
}

// Effective-autonomy view. Policy is a LOCAL read (autonomy.loadPolicy), so it
// works offline; a policy that cannot be parsed reflects honestly as nulls
// (never a crash). `circuit_open` is true when the breaker is tripped: a live
// `verity:circuit-open` label (GitHub-observed) OR `mode: manual` (the worker
// halts immediately in manual). When neither the label nor the policy can be
// observed, it is null (unknown), not a confident `false`.
function computeAutonomy(policy, snapshot, online) {
  const circuitLabel = online && snapshotHasLabel(snapshot, CIRCUIT_OPEN_LABEL);
  let circuitOpen;
  if (circuitLabel) {
    circuitOpen = true;
  } else if (policy) {
    circuitOpen = policy.mode === 'manual';
  } else {
    circuitOpen = null;
  }
  return {
    mode: policy ? (policy.mode ?? null) : null,
    circuit_open: circuitOpen,
    trust: policy ? (policy.review?.trust ?? null) : null,
  };
}

// Today's (UTC) run + cost totals. ADR-0008 is a HARD gate: `verified_cost_usd`
// is the sum of costs Verity DETERMINISTICALLY verified today, and it is `null`
// ("unknown") whenever there is nothing verified — NEVER coerced to 0. It is a
// number only when at least one row today reported a known cost; if every row
// was unknown-cost (est_usd null), the rollup's est_usd is a meaningless 0 and
// must stay null. With no usage.csv at all, runs_today is honestly 0 but
// verified_cost_usd stays null (we did not verify $0, we saw nothing).
// ADR-0008 verified spend from a usage rollup: a number ONLY when at least one
// row today reported a known cost; `null` ("unknown") whenever there is nothing
// verified — NEVER coerced to 0 (an all-unknown day's est_usd is a meaningless
// 0). The single source both `computeLimits` and `computeGateCost` read, so the
// snapshot and the gates can never price the same day two different ways.
function verifiedCostOf(totals) {
  if (totals && totals.runs > 0) {
    const hasKnownCostRow = totals.unknown_cost_rows === 0 || totals.est_usd > 0;
    return hasKnownCostRow ? totals.est_usd : null;
  }
  return null;
}

function computeLimits(cwd, policy) {
  let totals = null;
  try {
    totals = usage.todayTotals(cwd);
  } catch {
    totals = null;
  }
  return {
    runs_today: totals ? totals.runs : null,
    max_runs: policy ? (policy.limits?.max_runs_per_day ?? null) : null,
    verified_cost_usd: verifiedCostOf(totals),
    max_cost_usd: policy ? (policy.limits?.max_usd_per_day ?? null) : null,
    unknown_cost_runs: totals ? totals.unknown_cost_runs : null,
  };
}

// A gate's cost, per ADR-0008: `verified_cost_usd` is today's verified spend (or
// null when nothing is verifiable), and `unknown_cost` is true whenever the cost
// could not be verified — null cost and `unknown_cost:true` always travel
// together (null = unknown, NEVER 0). Read-only rollup; a missing/unreadable
// usage.csv is honest-unknown, not $0.
function computeGateCost(cwd) {
  let totals = null;
  try {
    totals = usage.todayTotals(cwd);
  } catch {
    totals = null;
  }
  const verified = verifiedCostOf(totals);
  return { verified_cost_usd: verified, unknown_cost: verified === null };
}

// Runtime + doctor health. `checks` is one doctor.runChecks() pass (read-only
// host probes — never throws); the runtime binary's own row decides
// availability, while the overall pass/fail decides health.doctor. Unknown
// fields (no selection, no checks) are null/"unknown", never a guess.
//
// Stage 85 (ADR-0029): on the LOCAL substrate the `gh` dependency row reads
// SKIPPED-FOR-SUBSTRATE (doctor.runChecks opts.substrate — the one shared
// mechanism, also behind `verity doctor` and `operator diagnostics`): gh is
// not a local-substrate dependency (the whole point of the substrate), its
// absence must not fail local health, and its `gh auth status` auth probe
// calls GitHub, which a local snapshot read (the benchmark's default reader
// shells this projection every drive tick) must never do. github:
// byte-identical probe list.
function computeRuntime(flags, policy, local) {
  let selection = null;
  try {
    selection = doctor.resolveAgent(flags || {});
  } catch {
    selection = null;
  }
  const agent = selection ? selection.agent : null;
  let checks = null;
  try {
    checks = doctor.runChecks({
      agent: agent || 'claude',
      ...(local === true ? { substrate: 'local' } : {}),
    });
  } catch {
    checks = null;
  }
  let status = 'unknown';
  if (checks && agent) {
    const row = checks.find((c) => c.name === agent);
    if (row) {
      status = row.present ? 'available' : 'unavailable';
    }
  }
  const runtime = {
    harness: agent,
    // No deterministic detector exists for profile — honest unknown.
    profile: null,
    // Verity's own authoritative provider/model config (defaults to null model).
    provider: policy ? (policy.agent?.provider ?? null) : null,
    model: policy ? (policy.agent?.model ?? null) : null,
    status,
  };
  const doctorHealth = checks ? (doctor.exitCodeFor(checks) === 0 ? 'pass' : 'fail') : null;
  return { runtime, doctorHealth };
}

// Worker liveness. There is no cheap in-process worker detector and no cron
// cadence knowable here, and resolving the live lock HOLDER (a GitHub-comment
// read per locked item) would be an unbounded network fan-out this bounded
// projection refuses — so `state` is best-effort "idle" and every unobserved
// field is null (contract: nulls are first-class "unknown"). The `in_progress`
// queue bucket already surfaces that an item is locked.
//
// Stage 85 (ADR-0029): on the LOCAL substrate the worker's §7 run-summary
// route is the usage ledger (worker postComment has no local comment surface;
// its structured facts land in the usage ledger — usage.ledgerPath, the
// git-dir sidecar since stage 108 — via recordUsage) — so
// `last_tick`/`last_outcome` RESOLVE from the ledger's newest folded run,
// exactly the operator-run derivation (foldRun: the latest row carries the
// run-level outcome). An empty/missing ledger stays honestly null, and so
// (stage 112) does one whose location git could not resolve (LedgerPathError):
// unobserved, never a fabricated value. `lock`
// stays null WITH a reason: the local worker takes no lock at all (the §4.3
// lock is a GitHub-comment protocol; contract local-work-item v1 carries no
// comments), so there is no lock surface to read — never a fabricated
// "unlocked" claim beyond the contract's null. The github path is
// byte-identical (`local` false ⇒ the constant shape above).
function computeWorker(cwd, local) {
  const base = {
    state: 'idle',
    last_tick: null,
    next_tick: null,
    last_outcome: null,
    lock: null,
  };
  if (local !== true) {
    return base;
  }
  let ledgerData;
  try {
    ledgerData = usage.readUsage(cwd);
  } catch (err) {
    if (err instanceof usage.LedgerPathError) {
      return base;
    }
    throw err;
  }
  if (!ledgerData.exists || ledgerData.rows.length === 0) {
    return base;
  }
  const folded = [...groupByRunId(ledgerData.rows).values()].map(foldRun);
  folded.sort((a, b) => b.completed_ts - a.completed_ts);
  base.last_tick = folded[0].completed_at;
  base.last_outcome = folded[0].outcome;
  return base;
}

// Deep-redact every string in the output through the engine redactor so no
// token shape or Authorization/Bearer/token line can survive in any field,
// reason, or error. Non-strings (numbers, booleans, null) pass untouched —
// crucially null stays null (ledger.redact would coerce it to '').
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

// The projection. PURE READ — composes existing derivations, mutates nothing.
//   opts.snapshot  inject a GitHub snapshot fixture (the ledger.project seam) —
//                  zero network for tests/embedders.
//   opts.repo      resolved repository (--repo/--gh-repo), honored the way
//                  ledger/next do (flag → GH_REPO → cwd remotes).
//   opts.flags     the CLI flags, forwarded to next.dispatch so its
//                  resolveUnverifiedCi (flag → policy) is reused verbatim.
function snapshot(cwd, opts = {}) {
  const repo = opts.repo;
  let policy = null;
  try {
    policy = autonomy.loadPolicy(cwd);
  } catch {
    policy = null;
  }
  // Stage 84 (ADR-0029 consequence): resolve the delivery substrate ONCE, from
  // the policy read this projection ALREADY performs (stage 79 stamps
  // `substrate` on every effective policy) — no new I/O on any path, and one
  // loadPolicy read FEWER than routing through resolveSubstrate. An unreadable
  // policy resolves 'github' (fail toward today's engine, resolveSubstrate's
  // own rule). opts.substrate is the test seam.
  // Stage 85: the engine-set pin (substrateLocal.pinnedSubstrate — the
  // worker's frozen-run export) outranks the cwd policy read here too: a role
  // shelling `verity operator snapshot` from a stage-branch checkout that
  // predates the policy must not flip to the github paths mid-local-run.
  // Default-absent ⇒ byte-identical.
  const substrate =
    opts.substrate === undefined
      ? (substrateLocal.pinnedSubstrate() ?? (policy ? policy.substrate : 'github'))
      : opts.substrate;
  const local = substrate === 'local';
  // fetchSnapshot NEVER throws — an unreachable GitHub returns online:false.
  const snap = opts.snapshot || substrateLocal.fetchSubstrateSnapshot(cwd, { repo, substrate });
  const online = snap.online !== false;
  const proj = ledger.project(cwd, { snapshot: snap });

  // `next` is next.decide PROJECTED — literally the same decision `verity next`
  // makes, obtained by calling next.dispatch with the SAME injected snapshot so
  // it can never diverge (contract invariant 2). resolveUnverifiedCi (flag →
  // policy) is reused verbatim inside next.dispatch.
  // Stage 69 (ADR-0027): stamp the clock ONCE at this operator entry and thread
  // it into next so the ci:unverified recency grace applies through the operator
  // projection — a just-opened empty-CI PR reads `waiting_for_ci`, not a gate.
  // Matches next.dispatch's own default; injectable via opts.now/opts.ciGraceMs
  // so the contract tests drive the guard without the wall clock.
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const nextFlags = { ...(opts.flags || {}), cwd, repo };
  const decision = next.dispatch([], nextFlags, { snapshot: snap, now, ciGraceMs: opts.ciGraceMs });

  const { runtime, doctorHealth } = computeRuntime(opts.flags, policy, local);
  const requests = computeRequests(snap, online);
  let nextAction = projectNext(decision);
  if (nextAction === null && requests.oldest !== null) {
    nextAction = requestNext(requests.oldest);
  }

  const result = {
    schema: SCHEMA,
    // Stage 84 (ADR-0029: degrade honestly, never fabricate): on the LOCAL
    // substrate no `owner/project` GitHub repository exists, so the field is
    // the contract's honest null — a lingering GH_REPO env var (or --repo)
    // must never dress a local-only run as a GitHub one. github path
    // byte-identical.
    repository: local ? null : resolveRepo(repo) || snap.repository || null,
    // The ONE allowed wall-clock field (contract invariant 6).
    generated_at: new Date().toISOString(),
    online,
    autonomy: computeAutonomy(policy, snap, online),
    runtime,
    worker: computeWorker(cwd, local),
    // Stage 114: the two additive request counts ride at the END of `queue`
    // (the six stage buckets keep their order and meaning).
    queue: {
      ...computeQueue(proj, snap, online),
      requests_pending: requests.pending,
      requests_parked: requests.parked,
    },
    next: nextAction,
    limits: computeLimits(cwd, policy),
    health: {
      doctor: doctorHealth,
      // Stage 84 (ADR-0029): on local, GitHub was never consulted — reporting
      // "available" would fabricate a health reading of a service this run
      // does not touch, and "unavailable" would fabricate an outage. The
      // contract's null ("unknown/not observed") is the honest value.
      // (`online` itself stays true on local: the local store has no network
      // to be offline from; per-record read failures surface via the
      // snapshot's failures[], not a fabricated offline.)
      github: local ? null : online ? 'available' : 'unavailable',
      runtime: runtime.status,
      policy: policy ? 'valid' : 'invalid',
    },
  };

  return redactDeep(result);
}

// Is this snapshot's `next` the mirrored P4 synthesis (requestNext above)?
function isRequestNext(snap) {
  const n = snap?.next;
  return (
    n !== null &&
    typeof n === 'object' &&
    n.role === 'plan' &&
    n.target_type === 'issue' &&
    n.reason === `request #${n.target} needs planning` &&
    typeof snap.queue?.requests_pending === 'number' &&
    snap.queue.requests_pending > 0
  );
}

// Human render of a snapshot (stage 114) — the non-`--json` default of
// `verity operator snapshot`. NOT contractual (the contract's wire is the
// `--json` object; this render MAY change). A pure function of the projection:
// it adds no read and no inference. A null count prints `?` (unknown), never 0.
function renderSnapshot(snap) {
  const v = (x) => (x === null || x === undefined ? '?' : String(x));
  const q = snap.queue || {};
  const lines = [];
  lines.push(
    `verity operator snapshot — ${snap.repository || '(no GitHub repository)'} — ${
      snap.online ? 'online' : 'OFFLINE (state unknown, not "nothing to do")'
    }`,
  );
  const a = snap.autonomy || {};
  lines.push(
    `  autonomy: mode ${v(a.mode)}, trust ${v(a.trust)}, circuit ${
      a.circuit_open === true ? 'OPEN' : a.circuit_open === false ? 'closed' : '?'
    }`,
  );
  lines.push(
    `  queue: ready ${v(q.ready)}, in progress ${v(q.in_progress)}, waiting for CI ${v(
      q.waiting_for_ci,
    )}, awaiting approval ${v(q.awaiting_approval)}, needs human ${v(q.needs_human)}, blocked ${v(
      q.blocked,
    )}`,
  );
  lines.push(`  requests: ${v(q.requests_pending)} pending, ${v(q.requests_parked)} parked`);
  let status;
  if (!snap.online) {
    status = 'unknown — GitHub was not observed';
  } else if (isRequestNext(snap)) {
    status = `waiting to be planned (${q.requests_pending} request(s) pending)`;
  } else if (snap.next === null || snap.next === undefined) {
    status = 'idle';
  } else {
    const n = snap.next;
    const where =
      n.target === null || n.target === undefined
        ? ''
        : ` ${n.target_type === 'pull_request' ? 'PR' : n.target_type || ''} #${n.target}`;
    status = `next ${v(n.role)}${where} — ${v(n.reason)}`;
  }
  lines.push(`  status: ${status}`);
  const l = snap.limits || {};
  const cost = l.verified_cost_usd === null ? 'unknown' : `$${l.verified_cost_usd}`;
  lines.push(
    `  limits: runs today ${v(l.runs_today)}/${v(l.max_runs)}, verified cost ${cost}/$${v(
      l.max_cost_usd,
    )}, unknown-cost runs ${v(l.unknown_cost_runs)}`,
  );
  const h = snap.health || {};
  lines.push(
    `  health: doctor ${v(h.doctor)}, github ${v(h.github)}, runtime ${v(h.runtime)}, policy ${v(
      h.policy,
    )}`,
  );
  return `${lines.join('\n')}\n`;
}

// checks_green (trust.classify) → contract `ci`. true → "green", false → "red",
// null/undefined → "unverified" (no checks were reported — never silently
// "green"; mirrors deriveStatus's three-state CI notion).
function ciFromChecksGreen(green) {
  if (green === true) {
    return 'green';
  }
  if (green === false) {
    return 'red';
  }
  return 'unverified';
}

// `verity operator work --json` — the itemized live queue behind
// `snapshot.queue`'s counts (contracts/operator-gate.md). One object per
// NON-MERGED stage; `bucket` from the SHARED bucketOf so it tallies exactly to
// the counts; `next` is the SAME next.decide mapping projected per stage (or
// null for a merged/parked/blocked stage). PURE READ. Honest-unknown: an
// unreachable GitHub yields [] (never a confident "no work"), no throw.
function work(cwd, opts = {}) {
  const repo = opts.repo;
  const snap = opts.snapshot || substrateLocal.fetchSubstrateSnapshot(cwd, { repo });
  if (snap.online === false) {
    return [];
  }
  const proj = ledger.project(cwd, { snapshot: snap });
  const unblocked = new Set(proj.next);
  const unverifiedCi = next.resolveUnverifiedCi(opts.flags || {}, cwd);
  // Stage 69 (ADR-0027): stamp the clock ONCE and thread it into the per-stage
  // mapping so a just-opened empty-CI PR's `next` defers (waiting_for_ci) within
  // the registration grace instead of projecting a ci:unverified gate. Injectable
  // via opts.now/opts.ciGraceMs for the contract tests.
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  const items = [];
  for (const s of proj.stages) {
    if (s.status === 'merged') {
      continue;
    }
    const labels = stageLabelUnion(s, snap);
    const bucket = bucketOf(s, labels, unblocked);
    // `next` mirrors decide() exactly: only an unblocked, non-parked stage has a
    // decision (a blocked or human-parked stage's next is null — the worker will
    // not act on it), and it is the REAL per-stage mapping, not a fork.
    let decision = null;
    if (unblocked.has(s.number) && !labels.has(NEEDS_HUMAN_LABEL)) {
      decision = next.decideStage(s.number, s, labels, snap, {
        unverifiedCi,
        now,
        ciGraceMs: opts.ciGraceMs,
      });
    }
    items.push({
      schema: SCHEMA,
      stage: s.number,
      title: s.title ?? null,
      type: s.type ?? null,
      status: s.status,
      bucket,
      issue: s.issue ?? null,
      pull_request: s.pr ?? null,
      next: projectNext(decision),
      // Stage 111 (#293, additive — contracts/operator-gate.md v1, schema
      // unchanged): the stage's declared dependencies, exactly as `verity
      // state` derives `dependsOn` (ledger.parseStageFile: `**Depends on:**`,
      // `none` ⇒ []). Present on EVERY item so a consumer can draw edges.
      depends_on: Array.isArray(s.dependsOn) ? [...s.dependsOn] : [],
    });
  }
  return redactDeep(items);
}

// Read-per-gate evidence via trust.classify (injected as `classifyFn`), enforcing
// honest-unknown: a PR whose classification cannot be read leaves every observed
// field null and risk null — NEVER a fabricated "low risk / 0 files". Cost is the
// shared ADR-0008 rollup. classify is READ ONLY here — never a merge path.
function gateEvidence(stage, classifyFn, policy, ghOpts, cost) {
  const evidence = {
    files_changed: null,
    protected_paths: null,
    changed_lines: null,
    ci: null,
    verified_cost_usd: cost.verified_cost_usd,
    unknown_cost: cost.unknown_cost,
  };
  let risk = null;
  if (stage.pr !== null && stage.pr !== undefined && policy) {
    try {
      const c = classifyFn(stage.pr, policy, ghOpts);
      if (c) {
        risk = c.risk ?? null;
        evidence.files_changed = Array.isArray(c.files) ? c.files.length : null;
        // `reasons` carries the protected-path hits (and any other failed
        // low-risk condition) verbatim — Verity/GitHub-observed, ADR-0013.
        evidence.protected_paths = Array.isArray(c.reasons) ? c.reasons : null;
        evidence.changed_lines = typeof c.changed_lines === 'number' ? c.changed_lines : null;
        evidence.ci = ciFromChecksGreen(c.checks_green);
      }
    } catch {
      // Evidence could not be read → the observed fields stay null (honest
      // unknown). NEVER fabricate a low-risk/green/0 reading.
    }
  }
  return { risk, evidence };
}

// One gate object (contracts/operator-gate.md wire) for a gated stage, given its
// already-derived {role, gate, reason} descriptor. `merge_authority_granted` is
// ALWAYS false (this is not an approval path); `allowed_actions` is descriptive.
function buildGate(stage, descriptor, ctx) {
  const { classifyFn, policy, ghOpts, cost, repoName, snap } = ctx;
  const role = descriptor.role ?? null;
  const { risk, evidence } = gateEvidence(stage, classifyFn, policy, ghOpts, cost);
  const keyNumber = stage.pr ?? stage.issue ?? stage.number;
  const issueObj =
    stage.issue !== null && stage.issue !== undefined
      ? (snap.issues || []).find((i) => i.number === stage.issue)
      : null;
  return {
    schema: SCHEMA,
    gate_id: `gate-${keyNumber}-${role ?? 'gate'}`,
    work_item:
      stage.issue !== null && stage.issue !== undefined
        ? { type: 'issue', number: stage.issue, title: issueObj?.title ?? null }
        : null,
    pull_request:
      stage.pr !== null && stage.pr !== undefined
        ? {
            number: stage.pr,
            url: repoName ? `https://github.com/${repoName}/pull/${stage.pr}` : null,
          }
        : null,
    stage: stage.number,
    role,
    gate: descriptor.gate ?? null,
    reason: descriptor.reason ?? null,
    risk,
    evidence,
    // NOT an approval path (contract invariant 2): approving resumes the
    // deterministic worker, which still merges per the trust ladder — this seam
    // grants no merge authority, ever.
    next_on_approve: { action: 'resume-worker', merge_authority_granted: false },
    allowed_actions: ['approve', 'reject', 'request-changes', 'needs-human'],
  };
}

// {role, gate, reason} for a label-gated stage. An awaiting_approval gate reuses
// next.decideStage's EXACT mapping (so the reason reads identically to
// `verity next`); a needs_human stage is parked (decideStage never emits that
// gate), so its descriptor is derived from the stage's own status.
function gateDescriptor(stage, labels, bucket, unverifiedCi, snap, now, ciGraceMs) {
  const statusRole = stage.status === 'in-review' ? 'review' : 'build';
  if (bucket === 'needs_human') {
    return {
      role: statusRole,
      gate: 'needs-human',
      reason: `stage ${stage.number} parked for a human (${NEEDS_HUMAN_LABEL})`,
    };
  }
  // Stage 69 (ADR-0027): thread the operator's stamped clock so the reason still
  // reads identically to `verity next` (which now defers within the grace).
  const d = next.decideStage(stage.number, stage, labels, snap, { unverifiedCi, now, ciGraceMs });
  return { role: d.role ?? statusRole, gate: d.gate ?? null, reason: d.reason ?? null };
}

// --- Stage 115 (ADR-0038 D4): the spec-soundness gate on a request ----------
//
// A request the plan role judged unbuildable is parked `verity:needs-human`
// with `verity:request` kept. It surfaces here exactly per the operator-gate
// contract's 2026-09-29 additive note — role plan, no stage, no PR, no risk,
// every evidence field null, no approval (`next_on_approve: null`), the one
// action `clear-needs-human`, and the OPTIONAL `gaps[]`. Membership is the
// park the WORKER recorded, never the labels alone (a request can be parked
// for other reasons — a no-progress strike, a human — and those are not this
// gate):
//   - github: the item's latest worker gate comment is a spec-unsound one. A
//     gate comment counts as the worker's only when its author also wrote the
//     `lock:<run-id>` comment of the run the gate comment names (the worker
//     locks the request before it plans it) — text alone never qualifies.
//     One bounded comment read per parked request, and only for those; an
//     unreadable trail surfaces nothing for that request (it stays counted in
//     snapshot.queue.requests_parked).
//   - local: the record's newest `+verity:needs-human` label commit carries
//     the spec-unsound note (contract local-work-item v1 has no comment
//     surface); `gaps` is `[]` — the gaps are on the run log.
const RUN_GATE_LINE_RE = /^⏸️ \*\*verity-worker\*\* `([A-Za-z0-9][A-Za-z0-9._-]*)` — /;
const LOCK_LINE_RE = /^lock:(\S+)\s/;

function commentLogin(c) {
  const login = c !== null && typeof c === 'object' ? c.user?.login : null;
  return typeof login === 'string' && login !== '' ? login.toLowerCase() : null;
}

// The latest worker gate comment on a request's trail (ascending), when it is
// a spec-unsound one: { gaps } — else null.
function latestSpecUnsound(trail) {
  const list = Array.isArray(trail) ? trail : [];
  const lockAuthors = new Map(); // run id → Set<login>
  for (const c of list) {
    const m = LOCK_LINE_RE.exec(typeof c?.body === 'string' ? c.body : '');
    const login = commentLogin(c);
    if (m !== null && login !== null) {
      if (!lockAuthors.has(m[1])) {
        lockAuthors.set(m[1], new Set());
      }
      lockAuthors.get(m[1]).add(login);
    }
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i];
    const body = typeof c?.body === 'string' ? c.body : '';
    const m = RUN_GATE_LINE_RE.exec(body.split('\n')[0]);
    const login = commentLogin(c);
    if (m === null || login === null || !lockAuthors.get(m[1])?.has(login)) {
      continue; // not a gate comment, or not the worker's own
    }
    const parsed = specSoundness.parseGateComment(body);
    return parsed === null ? null : { gaps: parsed.gaps };
  }
  return null;
}

function specUnsoundGate(issue, gaps) {
  const n = issue.number;
  return {
    schema: SCHEMA,
    gate_id: `gate-${n}-plan`,
    work_item: { type: 'issue', number: n, title: issue.title ?? null },
    pull_request: null,
    stage: null,
    role: 'plan',
    gate: specSoundness.SPEC_UNSOUND_GATE,
    reason: `request #${n} parked at the spec-soundness gate \`${specSoundness.SPEC_UNSOUND_GATE}\` (${NEEDS_HUMAN_LABEL}) — ${specSoundness.resumeHint(n)}`,
    risk: null,
    evidence: {
      files_changed: null,
      protected_paths: null,
      changed_lines: null,
      ci: null,
      verified_cost_usd: null,
      unknown_cost: null,
    },
    next_on_approve: null,
    allowed_actions: ['clear-needs-human'],
    gaps,
  };
}

function specUnsoundGates(cwd, snap, { local, repo, readComments, labelAddNote }) {
  const out = [];
  for (const issue of Array.isArray(snap.issues) ? snap.issues : []) {
    if (String(issue?.state || '').toUpperCase() !== 'OPEN' || !Number.isInteger(issue.number)) {
      continue;
    }
    const labels = itemLabels(issue);
    if (!labels.has(REQUEST_LABEL) || !labels.has(NEEDS_HUMAN_LABEL)) {
      continue;
    }
    if (local) {
      const r = labelAddNote(cwd, issue.number, NEEDS_HUMAN_LABEL);
      if (r.ok && r.note === specSoundness.LOCAL_LABEL_NOTE) {
        out.push(specUnsoundGate(issue, []));
      }
      continue;
    }
    let trail;
    try {
      trail = readComments(issue.number, { repo, cwd });
    } catch {
      continue; // unobservable: never a fabricated gate
    }
    const found = latestSpecUnsound(trail);
    if (found !== null) {
      out.push(specUnsoundGate(issue, found.gaps));
    }
  }
  return out;
}

// `verity operator gates --json` — the work items paused at a human gate
// (contracts/operator-gate.md), each enriched with the evidence to decide. One
// object per gated item: a stage bucketed awaiting_approval / needs_human, OR a
// next.decide `action:'gated'` decision (e.g. ci:unverified) that targets a
// non-merged stage. PURE READ; classify is READ evidence only. Honest-unknown:
// an unreachable GitHub yields [] (never a confident "no gates"), no throw.
function gates(cwd, opts = {}) {
  const repo = opts.repo;
  let policy = null;
  try {
    policy = autonomy.loadPolicy(cwd);
  } catch {
    policy = null;
  }
  // Stage 84 (ADR-0029 consequence): the substrate, from the policy read this
  // projection already performs (no new I/O; unreadable policy ⇒ 'github',
  // fail toward today's engine). opts.substrate is the test seam.
  // Stage 85: the engine-set pin outranks the cwd re-derivation (see
  // snapshot()); default-absent ⇒ byte-identical.
  const substrate =
    opts.substrate === undefined
      ? (substrateLocal.pinnedSubstrate() ?? (policy ? policy.substrate : 'github'))
      : opts.substrate;
  const local = substrate === 'local';
  const snap = opts.snapshot || substrateLocal.fetchSubstrateSnapshot(cwd, { repo, substrate });
  if (snap.online === false) {
    return [];
  }
  const proj = ledger.project(cwd, { snapshot: snap });
  const unblocked = new Set(proj.next);
  const unverifiedCi = next.resolveUnverifiedCi(opts.flags || {}, cwd);
  // Stage 69 (ADR-0027): one stamped clock threaded into BOTH per-stage
  // descriptors and the whole-queue next.decide below, so a just-opened empty-CI
  // PR does not surface as a spurious ci:unverified gate within the registration
  // grace. Injectable via opts.now/opts.ciGraceMs for the contract tests.
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const classifyFn = opts.classify || trust.classify;
  const ctx = {
    classifyFn,
    policy,
    // Stage 84 (stage-81 review finding 2's rule): the substrate stamp rides in
    // ghOpts ONLY on local — trust.classify's local path reads it; a github
    // run's ghOpts bag stays exactly what it was (no contract-adjacent
    // pollution on every gh call).
    ghOpts: local ? { cwd, substrate: 'local' } : { cwd, repo },
    cost: computeGateCost(cwd),
    // Stage 84 (ADR-0029: never fabricate): no GitHub repo name exists on
    // local — a lingering GH_REPO/--repo must not mint a fabricated
    // github.com pull_request.url for a local-only PR number.
    repoName: local ? null : resolveRepo(repo) || snap.repository || null,
    snap,
  };

  const out = [];
  const emitted = new Set();
  for (const s of proj.stages) {
    if (s.status === 'merged') {
      continue;
    }
    const labels = stageLabelUnion(s, snap);
    const bucket = bucketOf(s, labels, unblocked);
    if (bucket !== 'awaiting_approval' && bucket !== 'needs_human') {
      continue;
    }
    out.push(
      buildGate(s, gateDescriptor(s, labels, bucket, unverifiedCi, snap, now, opts.ciGraceMs), ctx),
    );
    emitted.add(s.number);
  }

  // A next.decide gated decision (ci:unverified / a fresh gate) whose target
  // maps to a non-merged stage not already surfaced by a label above.
  const decision = next.decide(proj, snap, { unverifiedCi, now, ciGraceMs: opts.ciGraceMs });
  if (
    decision &&
    decision.action === 'gated' &&
    decision.target &&
    typeof decision.target.number === 'number'
  ) {
    const t = decision.target;
    const st = proj.stages.find((x) =>
      t.kind === 'pr'
        ? x.pr === t.number
        : t.kind === 'issue'
          ? x.issue === t.number
          : x.number === t.number,
    );
    if (st && st.status !== 'merged' && !emitted.has(st.number)) {
      const descriptor = {
        role: decision.role ?? null,
        gate: decision.gate ?? null,
        reason: decision.reason ?? null,
      };
      out.push(buildGate(st, descriptor, ctx));
      emitted.add(st.number);
    }
  }

  // Stage 115: requests parked at the spec-soundness gate (after every stage
  // gate, so the stage gates' order is unchanged). Injectable readers for the
  // contract tests: opts.readComments (github), opts.labelAddNote (local).
  out.push(
    ...specUnsoundGates(cwd, snap, {
      local,
      repo: resolveRepo(repo) || undefined,
      readComments: opts.readComments || ((n, o) => require('./locks.cjs').readComments(n, o)),
      labelAddNote: opts.labelAddNote || substrateLocal.labelAddNote,
    }),
  );

  return redactDeep(out);
}

// --- Runs (contracts/operator-run.md, frozen v1, stage 49) -------------------
// The read-only run-history seam behind the Console's Runs view. `runs` lists
// recent worker runs (most-recent-first); `run <id>` returns one, or an honest
// not-found. Both RECOMPOSE the local usage ledger (usage.ledgerPath — the
// git-dir sidecar since stage 108) via usage.readUsage and add no new state —
// no network, no writes. Stage 112: a ledger git cannot locate
// (LedgerPathError) is an error with a non-zero exit, never an empty list.

// Fold the usage rows that share a run_id (a multi-role run spans one row per
// role invocation) into ONE run descriptor. The `last` row (latest timestamp)
// carries the run-level outcome/gate/completion; roles union across rows;
// tokens/tool_calls sum; wall_secs is the MAX — the honest wall-clock of a run
// whose invocations overlap in real time, never their sum. Cost obeys ADR-0008:
// if ANY folded row is unknown-cost (est_usd null) the run's verified_cost_usd
// stays `null` with unknown_cost:true (any-unknown ⇒ unknown); otherwise the
// KNOWN costs sum (a verified 0 stays 0 — never coerced from null).
function foldRun(groupRows) {
  let last = groupRows[0];
  for (const r of groupRows) {
    if (r.ts >= last.ts) {
      last = r;
    }
  }
  const roles = [];
  const seen = new Set();
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let wallSecs = 0;
  let anyUnknown = false;
  let knownCost = 0;
  for (const r of groupRows) {
    for (const role of r.roles) {
      if (!seen.has(role)) {
        seen.add(role);
        roles.push(role);
      }
    }
    tokensIn += r.tokens_in;
    tokensOut += r.tokens_out;
    toolCalls += r.tool_calls;
    if (r.wall_secs > wallSecs) {
      wallSecs = r.wall_secs;
    }
    if (r.est_usd === null) {
      anyUnknown = true;
    } else {
      knownCost += r.est_usd;
    }
  }
  return {
    run_id: last.run_id,
    repo: last.repo,
    roles,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tool_calls: toolCalls,
    wall_secs: wallSecs,
    outcome: last.outcome,
    gate: last.gate === '' ? null : last.gate,
    completed_at: last.timestamp,
    completed_ts: last.ts,
    verified_cost_usd: anyUnknown ? null : Number(knownCost.toFixed(4)),
    unknown_cost: anyUnknown,
  };
}

// Project one folded run onto the contract wire shape. `started_at` is
// DETERMINISTIC — completed_at minus wall_secs — so a consumer never reverses
// the math; `wall_secs` is exposed raw too. `runtime`/`model` are honestly
// `null` (ADR-0013): the ledger does not record them, so they are never guessed
// from a model's self-claim.
function projectRun(f) {
  const startedAt = new Date(Date.parse(f.completed_at) - f.wall_secs * 1000).toISOString();
  return {
    schema: SCHEMA,
    run_id: f.run_id,
    repository: f.repo,
    roles: f.roles,
    started_at: startedAt,
    completed_at: f.completed_at,
    wall_secs: f.wall_secs,
    outcome: f.outcome,
    gate: f.gate,
    usage: {
      input_tokens: f.tokens_in,
      output_tokens: f.tokens_out,
      tool_calls: f.tool_calls,
      verified_cost_usd: f.verified_cost_usd,
      unknown_cost: f.unknown_cost,
    },
    runtime: null,
    model: null,
  };
}

// Group usage rows by run_id (insertion order preserved for stable ties).
function groupByRunId(rows) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.run_id);
    if (g) {
      g.push(r);
    } else {
      groups.set(r.run_id, [r]);
    }
  }
  return groups;
}

// `verity operator runs [--days N] [--limit N] --json` — recent worker runs,
// most-recent-first by completed_at, projected from the local usage ledger.
// Defaults: --days 7 (UTC calendar days including today, the usage rollup
// convention) and --limit 50. A missing/empty usage.csv ⇒ [] (never a throw —
// no fabricated history). PURE READ.
function runs(cwd, opts = {}) {
  const days = opts.days ?? 7;
  const limit = opts.limit ?? 50;
  const ledgerData = usage.readUsage(cwd);
  if (!ledgerData.exists || ledgerData.rows.length === 0) {
    return [];
  }
  // UTC-day window via usage's own startOfUtcDay — the single date-math source,
  // identical to summarizeUsage's `since` (no hand-rolled date math here).
  const now = opts.now || new Date();
  const since = usage.startOfUtcDay(now) - (days - 1) * 86_400_000;
  const windowed = ledgerData.rows.filter((r) => r.ts >= since);
  const folded = [...groupByRunId(windowed).values()].map(foldRun);
  // Strictly most-recent-first by completed_at (contract §Ordering).
  folded.sort((a, b) => b.completed_ts - a.completed_ts);
  return redactDeep(folded.slice(0, limit).map(projectRun));
}

// `verity operator run <run-id> --json` — the single folded run whose run_id
// matches, projected identically. Unknown id (or missing/empty ledger) ⇒ null
// (honest not-found — NEVER a fabricated row). Not windowed: a lookup by id
// spans the whole ledger. PURE READ.
function run(cwd, id, opts = {}) {
  void opts;
  const ledgerData = usage.readUsage(cwd);
  if (!ledgerData.exists || ledgerData.rows.length === 0) {
    return null;
  }
  const matching = ledgerData.rows.filter((r) => r.run_id === id);
  if (matching.length === 0) {
    return null;
  }
  return redactDeep(projectRun(foldRun(matching)));
}

// --- Inspect (contracts/operator-inspect.md, frozen v1, stage 51) -------------
// The read-only drill-down seam behind the snapshot: the Console's Policy,
// Usage, and Health views. Three projections that RECOMPOSE existing internal
// derivations (autonomy.loadPolicy, usage.summarizeUsage, doctor.runChecks) into
// stable, Console-facing shapes — adding no new state, writing nothing. Governing
// ADRs: 0008 (cost honesty), 0013 (provenance). All three pass through redactDeep.

// `verity operator policy --json` — the effective (DEFAULTS + user) autonomy
// policy, projected to the frozen shape, or an honest valid:false when the file
// cannot be parsed. autonomy.loadPolicy is a LOCAL read (works offline) that
// THROWS PolicyError on an invalid `.verity/autonomy.yml`. Fail-honest (contract
// invariant 3): a throw ⇒ { valid:false, reason, policy:null } — NEVER a
// fabricated default presented as the user's live policy. The top-level
// mode/trust/limits/review are convenience projections of the full effective
// `policy`, which is carried verbatim for the Console's less-common needs.
function policy(cwd, opts = {}) {
  void opts;
  let p = null;
  try {
    p = autonomy.loadPolicy(cwd);
  } catch (err) {
    return redactDeep({
      schema: SCHEMA,
      valid: false,
      reason: err.message,
      policy: null,
    });
  }
  return redactDeep({
    schema: SCHEMA,
    valid: true,
    mode: p.mode ?? null,
    trust: p.review?.trust ?? null,
    limits: {
      max_runs_per_day: p.limits?.max_runs_per_day ?? null,
      max_usd_per_day: p.limits?.max_usd_per_day ?? null,
      // The ADR-0008 gating knob — always present in the effective policy
      // (defaults to 'gate'); surfaced beside the usually-unset
      // unverified_ci_behavior so a Policy view sees the live unknown-cost rule.
      unknown_cost_behavior: p.limits?.unknown_cost_behavior ?? null,
      unverified_ci_behavior: p.limits?.unverified_ci_behavior ?? null,
    },
    review: { escalate_routing: p.review?.escalate_routing ?? null },
    policy: p,
  });
}

// `verity operator usage [--days N] [--by-role] --json` — the usage-ledger rollup
// over a UTC-day window (default 7), projected to the frozen shape. ADR-0008
// (contract invariant 2): `verified_cost_usd` is the summary's est_usd — the
// KNOWN-cost sum, exposed under an honest name — and it is ALWAYS reported beside
// `unknown_cost_runs` (the count of runs whose cost could not be verified); the
// unknown count is NEVER dropped or coerced into the sum. A missing ledger is
// honest-zero, not a throw: summarizeUsage already zeroes an absent/empty
// ledger file (usage.ledgerPath) — but one git cannot LOCATE (LedgerPathError,
// stage 112) throws, as does a genuinely bad --days.
// `by_role` is null unless --by-role was passed.
function usage_(cwd, opts = {}) {
  const s = usage.summarizeUsage(cwd, { days: opts.days ?? 7, byRole: !!opts.byRole });
  return redactDeep({
    schema: SCHEMA,
    days: s.days,
    since: s.since,
    timezone: s.timezone,
    runs: s.runs,
    tokens_in: s.tokens_in,
    tokens_out: s.tokens_out,
    tool_calls: s.tool_calls,
    verified_cost_usd: s.est_usd,
    unknown_cost_runs: s.unknown_cost_runs,
    outcomes: s.outcomes,
    by_role: opts.byRole ? (s.by_role ?? null) : null,
    skipped_rows: s.skipped_rows,
  });
}

// `verity operator diagnostics --json` — the doctor host-preflight, projected to
// the frozen shape: the per-check rows verbatim (name/present/version/ok/detail)
// plus an `overall` pass/fail. runChecks runs READ-ONLY host probes (never
// throws). Fail-honest (contract invariant 3): a failing check keeps ok:false on
// its row and forces overall:"fail" — overall is "pass" iff doctor.exitCodeFor
// (all checks ok) is 0.
function diagnostics(cwd, opts = {}) {
  // Stage 85 (ADR-0029): the cwd's resolved substrate rides into runChecks so
  // a local repo's gh row reads skipped-for-substrate (not probed — its auth
  // probe would call GitHub; never a silent vanish, the row stays with its
  // reason in `detail`). opts.substrate is the test seam; github/unreadable
  // policy resolves 'github' — byte-identical probes.
  const substrate =
    opts.substrate === undefined ? substrateLocal.resolveSubstrate(cwd) : opts.substrate;
  const checks = doctor.runChecks({ ...opts, substrate });
  return redactDeep({
    schema: SCHEMA,
    overall: doctor.exitCodeFor(checks) === 0 ? 'pass' : 'fail',
    checks,
  });
}

// Parse the --days/--limit window flags (defaults 7 / 50), rejecting a
// non-positive-integer value with a clear usage error.
function parseWindow(flags) {
  let days = 7;
  if (flags.days !== undefined) {
    days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(`--days must be a positive integer, got '${flags.days}'`);
    }
  }
  let limit = 50;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit must be a positive integer, got '${flags.limit}'`);
    }
  }
  return { days, limit };
}

// CLI: `verity operator {snapshot|work|gates|runs|run <id>} [--json]
// [--repo owner/name] [--days N] [--limit N]`. All read-only. Unknown verb → a
// clear error; `run` with no id → a clear usage error.
function dispatch(args, flags = {}) {
  // Stage 50: `act` is the operator seam's ONLY write surface. It lives in a
  // SEPARATE module (operator-act.cjs) so this projection stays pure-read; we
  // merely DELEGATE. Removing this one line disables the entire write surface.
  if (args[0] === 'act') {
    return require('./operator-act.cjs').dispatch(args.slice(1), flags);
  }
  const verb = args[0] || 'snapshot';
  const cwd = flags.cwd || process.cwd();
  const repo = flags.repo || flags['gh-repo'];
  if (verb === 'snapshot') {
    return snapshot(cwd, { repo, flags });
  }
  if (verb === 'work') {
    return work(cwd, { repo, flags });
  }
  if (verb === 'gates') {
    return gates(cwd, { repo, flags });
  }
  if (verb === 'runs') {
    return runs(cwd, { ...parseWindow(flags), flags });
  }
  if (verb === 'run') {
    const id = args[1];
    if (typeof id !== 'string' || id === '') {
      throw new Error('operator run requires a <run-id>: verity operator run <run-id> --json');
    }
    return run(cwd, id, { flags });
  }
  if (verb === 'policy') {
    return policy(cwd, { flags });
  }
  if (verb === 'usage') {
    // --days (integer) forwards raw so summarizeUsage owns the validation (a bad
    // value surfaces as a usage error); a missing ledger is zeroed there, never a
    // throw. --by-role toggles the by_role breakdown.
    const days = flags.days !== undefined ? Number(flags.days) : undefined;
    return usage_(cwd, { days, byRole: !!flags['by-role'], flags });
  }
  if (verb === 'diagnostics') {
    return diagnostics(cwd, flags);
  }
  throw new Error(
    `unknown operator verb: ${verb || '(none)'} — use snapshot, work, gates, runs, run, policy, usage, or diagnostics`,
  );
}

module.exports = {
  SCHEMA,
  snapshot,
  renderSnapshot,
  work,
  gates,
  runs,
  run,
  policy,
  usage: usage_,
  diagnostics,
  dispatch,
};
