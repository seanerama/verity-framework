// Stage 94 (ADR-0031) — provider trust is an explicit ALLOWLIST; an un-tiered
// runtime is refused.
//
// THE REPRODUCTION this file locks out: "a third provider gets maximum trust by
// omission." Before this stage every containment decision in the engine was a
// DENYLIST OF ONE PROVIDER — `provider === 'codex'` at worker/index.cjs:559,
// :567, :1252-1253 and :1513, `provider !== 'codex'` at autonomy.cjs:665, :742,
// :1048 — so any provider that was not codex landed on the CLAUDE side of every
// branch, which is the maximum-trust tier (harness-enforced restrictions, its
// own GitHub reads, no containment tier). The only thing holding the line was
// an enum, so the correct-looking way to add a runtime was to widen it, and the
// runtime arrived fully trusted in a two-value diff. The merge ladder
// (worker/index.cjs:1727+) was not provider-aware at all: a self-reported
// `approve` string from any runtime reached a real `trust.merge`.
//
// Every test below is hermetic: no network, no real provider binaries, no gh.
// The injection seam is the tiers MODULE OBJECT — the engine's consumers call
// `tiers.getTier(...)` through the imported namespace, so a test can substitute
// a fake table for one call and drive the ENGINE PATH (not the enum) into its
// refusal. The real table is always restored in a finally block.
const fs = require('node:fs');
const path = require('node:path');

const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const tiers = require('../verity/bin/lib/agents/tiers.cjs');
const registry = require('../verity/bin/lib/agents/index.cjs');
const { exitCodeFor } = require('../verity/bin/lib/agents/result-contract.cjs');
const autonomy = require('../verity/bin/lib/autonomy.cjs');
const doctor = require('../verity/bin/lib/doctor.cjs');
const worker = require('../verity/worker/index.cjs');

// A fake runtime id that is deliberately NOT in the registry and NOT in the
// table — the shape a fourth provider arrives in.
const UNTIERED = 'grok';

// Swap `tiers.getTier` for the duration of one call. This is how a test reaches
// the engine paths that the (now table-sourced) autonomy enum would otherwise
// keep it away from — the point of the regression is that the ENGINE refuses,
// not that a schema enum happens to be short.
function withTable(table, fn) {
  const realGetTier = tiers.getTier;
  tiers.getTier = (id) => (Object.hasOwn(table, id) ? table[id] : null);
  try {
    return fn();
  } finally {
    tiers.getTier = realGetTier;
  }
}

const entry = (over = {}) => ({
  harness_enforced: true,
  performs_own_github_reads: true,
  consumes_capability_policy: false,
  required_containment_tier: null,
  worker_selectable: true,
  merge_authority: true,
  ...over,
});

// --- 1. the table itself ------------------------------------------------------

test('tiers: claude and codex carry exactly the profile their === codex branches implemented', () => {
  assertEqual(
    JSON.stringify(tiers.getTier('claude')),
    JSON.stringify({
      harness_enforced: true,
      performs_own_github_reads: true,
      consumes_capability_policy: false,
      required_containment_tier: null,
      worker_selectable: true,
      merge_authority: true,
    }),
    'claude is the reference entry (harness-enforced, self-performing, tier-less, cleared)',
  );
  assertEqual(
    JSON.stringify(tiers.getTier('codex')),
    JSON.stringify({
      harness_enforced: false,
      performs_own_github_reads: false,
      consumes_capability_policy: true,
      required_containment_tier: 2,
      worker_selectable: true,
      merge_authority: true,
    }),
    'codex carries its ADR-0011/0013 profile — no behavior change',
  );
  assertEqual(tiers.getTier(UNTIERED), null, 'an un-vetted provider has NO entry');
  assertEqual(tiers.getTier(undefined), null, 'a non-string provider is un-tiered, never claude');
  assertEqual(tiers.getTier(null), null, 'null is un-tiered');
  // The table must be immutable at runtime: a mutable trust table is a trust
  // table a running process can be talked into widening.
  assert(Object.isFrozen(tiers.TRUST_TABLE), 'the table is frozen');
  assert(Object.isFrozen(tiers.TRUST_TABLE.codex), 'each entry is frozen');
});

test('tiers: the table is ENGINE-owned — no driver declares its own tier (ADR-0031 §4)', () => {
  const TIER_FIELDS = [
    'harness_enforced',
    'performs_own_github_reads',
    'consumes_capability_policy',
    'required_containment_tier',
    'worker_selectable',
    'merge_authority',
    'trust_tier',
    'containmentTier',
  ];
  for (const driver of ['claude.cjs', 'codex.cjs']) {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'verity', 'bin', 'lib', 'agents', driver),
      'utf8',
    );
    for (const field of TIER_FIELDS) {
      assert(
        !src.includes(field),
        `${driver} must not mention '${field}' — the claim and the claimant must be different files (ADR-0031 §4)`,
      );
    }
  }
});

test('tiers: the refusal reads as NOT VETTED, never as "unknown provider"', () => {
  let thrown = null;
  try {
    tiers.requireTier(UNTIERED, 'worker dispatch');
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== null, 'requireTier throws on an un-tiered provider');
  assertEqual(thrown.slug, 'untiered-provider', 'stable slug');
  assertEqual(thrown.exitCode, 30, 'the infra exit code (contracts/agent-result.md)');
  const msg = thrown.message;
  assert(msg.includes(`'${UNTIERED}'`), 'the message names the provider');
  assert(msg.includes('has not been VETTED'), 'it says NOT VETTED — a contributor reads the ADR');
  assert(
    !msg.includes('unknown provider'),
    'it never says "unknown provider" — that invites an enum edit',
  );
  assert(msg.includes('worker dispatch'), 'it names what was refused');
  assert(msg.includes('verity/bin/lib/agents/tiers.cjs'), 'it points at where a tier is added');
  assert(msg.includes('ADR-0031'), 'it points at the ADR');
  assert(msg.includes('widening an enum grants nothing'), 'it forecloses the enum-widening move');
  // A tiered provider comes back unchanged.
  assertEqual(
    tiers.requireTier('codex', 'worker dispatch'),
    tiers.getTier('codex'),
    'a vetted provider is returned, not thrown',
  );
});

// --- 2. no list drift ---------------------------------------------------------

test('tiers: registry ⊇ table, and enum == JSON schema == workerSelectableProviders()', () => {
  const selectable = tiers.workerSelectableProviders();
  assertEqual(JSON.stringify(selectable), JSON.stringify(['claude', 'codex']), 'today s list');
  // Registry membership is REACHABILITY; the table is TRUST. Trust may never
  // name a runtime that has no driver.
  for (const id of Object.keys(tiers.TRUST_TABLE)) {
    assert(registry.listProviders().includes(id), `${id} is trusted but has no driver`);
  }
  // The three lists that used to drift now all read from the table.
  assertEqual(
    JSON.stringify(autonomy.AGENT_PROVIDER_VALUES),
    JSON.stringify(selectable),
    'the autonomy agent.provider enum is sourced from the table',
  );
  assertEqual(
    JSON.stringify(doctor.SUPPORTED_AGENTS),
    JSON.stringify(selectable),
    'doctor SUPPORTED_AGENTS is sourced from the table',
  );
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'schemas', 'autonomy.schema.json'), 'utf8'),
  );
  assertEqual(
    JSON.stringify(schema.properties.agent.properties.provider.enum),
    JSON.stringify(selectable),
    'the JSON schema base enum matches the table',
  );
  assertEqual(
    JSON.stringify(
      schema.properties.agent.properties.roles.patternProperties['^(build|plan|review)$'].properties
        .provider.enum,
    ),
    JSON.stringify(selectable),
    'the JSON schema per-role enum matches the table',
  );
});

// --- 3. autonomy validate refuses an un-tiered provider -----------------------

test('autonomy: an un-tiered provider is REFUSED by validatePolicy, with its own distinct error', () => {
  const errors = autonomy.validatePolicy({ agent: { provider: UNTIERED } });
  const untiered = errors.filter((e) => e.includes('has not been VETTED'));
  assertEqual(
    untiered.length,
    1,
    `exactly one provider-trust error (got ${JSON.stringify(errors)})`,
  );
  assert(
    untiered[0].startsWith('agent.provider:'),
    'reported against the key that names the provider',
  );
  assert(untiered[0].includes('ADR-0031'), 'the un-vetted wording cites the ADR');
  // The (now table-sourced) enum ALSO refuses — belt and braces. The enum is no
  // longer the thing holding the line, but it must not stop refusing either.
  assert(
    errors.some((e) => e.includes('must be one of claude|codex')),
    'the table-sourced enum still refuses the value structurally',
  );
  assert(
    !errors.some((e) => e.includes('only meaningful with agent.provider')),
    'an un-tiered provider never falls into the "only meaningful with codex" wording',
  );
});

test('autonomy: an un-tiered PER-ROLE provider is refused too — an override is not a back door', () => {
  const errors = autonomy.validatePolicy({
    agent: { provider: 'claude', roles: { review: { provider: UNTIERED } } },
  });
  const untiered = errors.filter((e) => e.includes('has not been VETTED'));
  assertEqual(
    untiered.length,
    1,
    `exactly one per-role provider-trust error (got ${JSON.stringify(errors)})`,
  );
  assert(untiered[0].startsWith('agent.roles.review.provider:'), 'reported against the role key');
  assert(untiered[0].includes("worker dispatch of role 'review'"), 'it names the refused role');
});

test('autonomy: BYTE-IDENTICAL claude — every existing validation error string is unchanged', () => {
  assertEqual(
    JSON.stringify(
      autonomy.validatePolicy({ agent: { provider: 'claude', sandbox: 'read-only' } }),
    ),
    JSON.stringify([
      'agent.sandbox: only meaningful with agent.provider codex — set the provider first or remove the override',
    ]),
    'sandbox knob under claude',
  );
  assertEqual(
    JSON.stringify(autonomy.validatePolicy({ agent: { provider: 'claude', approval: 'never' } })),
    JSON.stringify([
      'agent.approval: only meaningful with agent.provider codex — set the provider first or remove the override',
    ]),
    'approval knob under claude',
  );
  assertEqual(
    JSON.stringify(
      autonomy.validatePolicy({
        agent: { provider: 'claude', acknowledged_enforcement_gaps: ['network'] },
      }),
    ),
    JSON.stringify([
      'agent.acknowledged_enforcement_gaps: only meaningful with agent.provider codex — claude restrictions are enforced by its own harness allowlist (ADR-0011)',
    ]),
    'gap acknowledgement under claude',
  );
  assertEqual(
    JSON.stringify(autonomy.validatePolicy({ agent: { provider: 'claude', containment_tier: 2 } })),
    JSON.stringify([
      'agent.containment_tier: only meaningful with agent.provider codex — claude has no ADR-0011 containment tiers (its write-time restriction is enforced by its own harness allowlist)',
    ]),
    'containment tier under claude',
  );
  assertEqual(
    JSON.stringify(
      autonomy.validatePolicy({
        agent: { provider: 'claude', roles: { build: { sandbox: 'read-only' } } },
      }),
    ),
    JSON.stringify([
      'agent.roles.build.sandbox: only meaningful with codex — this role resolves to provider claude (set agent.roles.build.provider: codex or remove the override)',
    ]),
    'per-role sandbox under a claude role',
  );
  // An ABSENT provider still resolves to claude and validates identically.
  assertEqual(
    JSON.stringify(autonomy.validatePolicy({ agent: { containment_tier: 2 } })),
    JSON.stringify([
      'agent.containment_tier: only meaningful with agent.provider codex — claude has no ADR-0011 containment tiers (its write-time restriction is enforced by its own harness allowlist)',
    ]),
    'absent provider resolves to claude, byte-identical',
  );
  // And a well-formed codex config still validates clean.
  assertEqual(
    JSON.stringify(
      autonomy.validatePolicy({
        agent: { provider: 'codex', sandbox: 'read-only', containment_tier: 2 },
      }),
    ),
    '[]',
    'codex knobs remain meaningful',
  );
});

// --- 4. the worker autonomous-mode gate --------------------------------------

// assertContainmentTier takes (policy, resolvedAgent) — build the resolver the
// worker builds, so the test drives the real gate, not a paraphrase of it.
function assertTier(policyAgent, mode = 'autonomous') {
  const policy = { mode, agent: policyAgent };
  let thrown = null;
  try {
    worker.assertContainmentTier(policy, worker.resolveEffectiveAgent(policy));
  } catch (err) {
    thrown = err;
  }
  return thrown;
}

test('worker: mode autonomous REFUSES an un-tiered provider before any tier arithmetic', () => {
  const thrown = assertTier({ provider: UNTIERED });
  assert(thrown !== null, 'the run is refused');
  assertEqual(thrown.slug, 'untiered-provider', 'machine-readable slug');
  assertEqual(thrown.exitCode, 30, 'exit 30');
  assert(thrown.message.includes('has not been VETTED'), 'not-vetted wording');
  assert(thrown.message.includes("mode 'autonomous'"), 'names what was refused');
  // THE PRE-CHANGE BEHAVIOR, asserted as the thing that must never come back:
  // a denylist of one provider admitted this config silently, because 'grok'
  // is not 'codex' and the branch simply did not fire.
  assert(
    !(UNTIERED === 'codex'),
    'sanity: the old `provider === codex` branch could never fire for this provider',
  );
  // A per-role un-tiered override is refused the same way.
  const perRole = assertTier({ provider: 'claude', roles: { build: { provider: UNTIERED } } });
  assert(perRole !== null && perRole.slug === 'untiered-provider', 'per-role refusal');
  assert(
    perRole.message.includes('agent.roles.build.provider'),
    'the per-role refusal names the role key',
  );
  // Supervised mode is untouched — this gate is about UNATTENDED runs only.
  assertEqual(assertTier({ provider: UNTIERED }, 'supervised'), null, 'supervised is unaffected');
});

test('worker: BYTE-IDENTICAL codex — the tier-2 refusals keep their slug and wording', () => {
  const base = assertTier({ provider: 'codex', containment_tier: 1 });
  assertEqual(base.slug, 'containment-tier-required', 'the historic slug');
  assertEqual(
    base.message,
    "fail-closed: mode 'autonomous' with agent.provider codex requires ADR-0011 tier-2 containment (a disposable shaped workspace + gated merge-back), but agent.containment_tier is 1 — unattended codex autonomy is REFUSED at tier 1, which catches a protected-path write only after it happened. Set agent.containment_tier: 2 in .verity/autonomy.yml, or run in mode 'supervised'",
    'the base message body is byte-unchanged',
  );
  const perRole = assertTier({
    provider: 'claude',
    roles: { review: { provider: 'codex', containment_tier: 1 } },
  });
  assertEqual(perRole.slug, 'containment-tier-required', 'the historic slug, per role');
  assertEqual(
    perRole.message,
    "fail-closed: mode 'autonomous' with a per-role agent.provider codex (role 'review') requires ADR-0011 tier-2 containment (a disposable shaped workspace + gated merge-back), but this role resolves to agent.containment_tier 1 — a per-role codex override can NEVER bypass tier-2. Set agent.roles.review.containment_tier: 2 (or agent.containment_tier: 2) in .verity/autonomy.yml, or run in mode 'supervised'",
    'the per-role message body is byte-unchanged',
  );
  assertEqual(assertTier({ provider: 'codex', containment_tier: 2 }), null, 'tier 2 proceeds');
  assertEqual(assertTier({ provider: 'claude' }), null, 'claude has no tiers and proceeds');
  assertEqual(
    assertTier({ provider: 'claude', containment_tier: 1 }),
    null,
    'a tier value on a tier-less provider is not the worker gate’s business (autonomy validate owns it)',
  );
});

// --- 5. the dispatch-level refusal (registry ≠ table) -------------------------

// The agent-exec trust gate runs BEFORE role resolution, so an unresolvable
// role name is a clean, spawn-free way to prove WHICH refusal fired.
function dispatchWith(flags) {
  const errs = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    errs.push(String(chunk));
    return true;
  };
  try {
    return { res: agentExec.dispatch(['no-such-role'], { 'run-id': 'tt1', ...flags }), errs };
  } finally {
    process.stderr.write = realWrite;
  }
}

test('agent-exec: registry-present + table-absent runs interactively and is REFUSED for the worker', () => {
  // 'claude' is in the registry; the injected table has no entry for it — the
  // exact state a freshly contributed host should sit in.
  withTable({}, () => {
    const interactive = dispatchWith({ agent: 'claude' });
    assertEqual(
      interactive.res.error.includes('no command file'),
      true,
      'an explicit interactive --agent run is NOT refused by the trust gate (it reaches role resolution)',
    );

    const worker = dispatchWith({ agent: 'claude', 'worker-dispatch': true });
    assertEqual(worker.res.outcome, 'infra_error', 'the worker dispatch is refused');
    assertEqual(exitCodeFor(worker.res), 30, 'exit 30 (contracts/agent-result.md infra shape)');
    assertEqual(worker.res.est_usd, 0, 'a pre-spawn refusal is a VERIFIED $0, never unknown');
    assertEqual(worker.res.role, 'no-such-role', 'the §3.3 result object is complete');
    assertEqual(worker.res.schema, 1, 'schema 1');
    assert(worker.res.error.includes('has not been VETTED'), 'not-vetted wording');
    assert(
      worker.errs.join('').includes('verity-agent-exec: 30 untiered-provider:'),
      'one machine-parsable stderr line (§8.2), not a thrown stack',
    );
  });
});

test('agent-exec: a tiered-but-not-worker_selectable provider is refused for the worker only', () => {
  withTable({ claude: entry({ worker_selectable: false }) }, () => {
    const res = dispatchWith({ agent: 'claude', 'worker-dispatch': true }).res;
    assertEqual(res.outcome, 'infra_error', 'refused');
    assert(res.error.includes('worker_selectable: false'), 'the reason names the cleared-ness');
    assertEqual(
      dispatchWith({ agent: 'claude' }).res.error.includes('no command file'),
      true,
      'the interactive run is unaffected',
    );
  });
});

test('agent-exec: BYTE-IDENTICAL today — the flag is inert for claude and codex', () => {
  for (const agent of ['claude', 'codex']) {
    for (const flags of [{ agent }, { agent, 'worker-dispatch': true }]) {
      const res = dispatchWith(flags).res;
      assertEqual(
        res.error.includes('no command file'),
        true,
        `${agent} ${JSON.stringify(flags)}: a vetted provider passes the trust gate untouched`,
      );
    }
  }
  // An unknown AGENT ID is still the registry's own refusal, not the table's —
  // the two gates stay distinguishable in the operator's error text.
  const unknown = dispatchWith({ agent: UNTIERED, 'worker-dispatch': true }).res;
  assert(unknown.error.includes('unsupported agent'), 'registry refusal, with its own wording');
});

// --- 6. the merge ladder (the one genuinely new behavior) --------------------

// One in-process review run at trust 2 with green checks — the inputs that
// merge today — parameterized on the reviewing provider's merge_authority.
function reviewRun(table) {
  const agentExecMod = require('../verity/bin/lib/agent-exec.cjs');
  const nextMod = require('../verity/bin/lib/next.cjs');
  const trustMod = require('../verity/bin/lib/trust.cjs');
  const ghMod = require('../verity/bin/lib/gh.cjs');

  const policy = JSON.parse(JSON.stringify(autonomy.DEFAULTS));
  policy.mode = 'supervised';
  policy.review.trust = 2;
  policy.limits.unknown_cost_behavior = 'allow_with_token_limit';

  const merges = [];
  const orig = {
    dispatch: agentExecMod.dispatch,
    next: nextMod.dispatch,
    merge: trustMod.merge,
    checksGreen: trustMod.checksGreen,
    ghRun: ghMod.run,
    ghJson: ghMod.json,
  };
  let nextCalls = 0;
  agentExecMod.dispatch = (args) => ({
    schema: 1,
    role: args[0],
    outcome: 'success',
    tokens: { in: 10, out: 5 },
    est_usd: 0.01,
    wall_secs: 1,
    tool_calls: 0,
    artifacts: { pr: 114, verdict: 'approve' },
    error: null,
  });
  nextMod.dispatch = () => {
    nextCalls += 1;
    return nextCalls === 1
      ? {
          schema: 1,
          action: 'work',
          role: 'review',
          args: ['114'],
          gate: null,
          target: { kind: 'pr', number: 114 },
          reason: 'PR in review',
        }
      : {
          schema: 1,
          action: 'idle',
          role: null,
          args: [],
          gate: null,
          target: null,
          reason: 'done',
        };
  };
  trustMod.checksGreen = () => true;
  trustMod.merge = (pr) => {
    merges.push(pr);
  };
  ghMod.run = () => ({ stdout: '', stderr: '', status: 0 });
  ghMod.json = () => ({});
  try {
    const summary = withTable(table, () =>
      worker.runLoop(
        { repo: 'o/r', cwd: '/tmp', stdout() {}, stderr() {} },
        { policy, runId: 'run-merge-authority', item: { kind: 'pr', number: 114, tier: 'P1' } },
      ),
    );
    return { summary, merges };
  } finally {
    agentExecMod.dispatch = orig.dispatch;
    nextMod.dispatch = orig.next;
    trustMod.merge = orig.merge;
    trustMod.checksGreen = orig.checksGreen;
    ghMod.run = orig.ghRun;
    ghMod.json = orig.ghJson;
  }
}

test('worker merge ladder: merge_authority true merges — identical to today', () => {
  const { summary, merges } = reviewRun({ claude: entry({ merge_authority: true }) });
  assertEqual(
    JSON.stringify(merges),
    JSON.stringify([114]),
    'exactly one merge of the reviewed PR',
  );
  assertEqual(summary.outcome, 'success', 'the run succeeds and chains');
});

test('worker merge ladder: merge_authority FALSE gates — trust.merge is never called', () => {
  const { summary, merges } = reviewRun({ claude: entry({ merge_authority: false }) });
  assertEqual(merges.length, 0, 'a runtime without merge authority NEVER reaches trust.merge');
  assertEqual(summary.outcome, 'gated', 'it gates — the same outcome an unknown verdict produces');
  assert(summary.gate !== null, 'the gate is named, so a human can resolve it');
  assert(
    String(summary.result).includes('no merge authority'),
    `the reason explains the refusal (got: ${summary.result})`,
  );
  assert(String(summary.result).includes('ADR-0031'), 'the reason cites the ADR');
  assert(String(summary.result).includes("'claude'"), 'the reason names the provider');
});

test('worker merge ladder: an UN-TIERED reviewing provider gates too (absence never grants merge)', () => {
  const { summary, merges } = reviewRun({});
  assertEqual(merges.length, 0, 'no table entry ⇒ no merge authority ⇒ no merge');
  assertEqual(summary.outcome, 'gated', 'it gates');
});

test('worker merge ladder: the REAL table preserves today’s behavior for claude and codex', () => {
  for (const id of ['claude', 'codex']) {
    assertEqual(
      tiers.getTier(id).merge_authority,
      true,
      `${id} keeps merge authority — no current run changes (ADR-0031 Consequences)`,
    );
  }
});

// --- 7. doctor is honest about the registry/table gap ------------------------

test('doctor: a registry-present, table-absent provider is surfaced, not hidden', () => {
  // Zero rows today (registry and table agree) — so every current doctor
  // invocation is byte-identical.
  assertEqual(
    JSON.stringify(doctor.providerTrustChecks({ providers: ['claude', 'codex'] })),
    '[]',
    'no rows while every registered driver is tiered',
  );
  const rows = doctor.providerTrustChecks({ providers: ['claude', 'codex', UNTIERED] });
  assertEqual(rows.length, 1, 'one row for the un-tiered driver');
  assertEqual(rows[0].name, `provider-trust:${UNTIERED}`, 'row names the provider');
  assertEqual(rows[0].ok, true, 'registry-only is a DELIBERATE state, not a broken install');
  assert(rows[0].detail.includes('usable interactively'), 'it says what still works');
  assert(rows[0].detail.includes('REFUSED for the unattended worker'), 'and what does not');
  assert(rows[0].detail.includes('ADR-0031'), 'and where the decision lives');
});
