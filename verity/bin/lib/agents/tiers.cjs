// Provider TRUST table (stage 94, ADR-0031) — the one place Verity declares how
// much it trusts a model runtime.
//
// Before this module every containment decision in the engine was written as a
// DENYLIST OF ONE PROVIDER (`provider === 'codex'` / `!== 'codex'`), so a fourth
// provider landed on the claude side of every branch — the MAXIMUM-trust tier —
// by construction, silently, in a diff whose reviewable surface was two enum
// values. A denylist grants trust by default; every other Verity posture
// (T06 deny-by-default, ADR-0007 "absence never grants anything",
// contracts/role-capability-policy.md "every capability key defaults to false
// when absent") is the opposite. So trust is an ALLOWLIST: a provider with no
// entry here is REFUSED for worker selection and for `mode: autonomous`.
//
// TWO SEPARATE GATES (ADR-0031 §5):
//   - the REGISTRY (./index.cjs `PROVIDERS`) makes a driver REACHABLE by an
//     explicit, interactive `verity agent-exec --agent <id>`;
//   - THIS TABLE, with `worker_selectable: true`, is what lets the UNATTENDED
//     worker choose it and what lets it run under `mode: autonomous`.
// A new runtime may ship registry-only — usable, un-trusted, refused by the
// worker — which is precisely what an incoming host contribution should be.
//
// THE TABLE IS ENGINE-OWNED (ADR-0031 §4). A driver must NEVER declare its own
// tier: self-declaration reproduces the fail-open, because the artifact making
// the trust claim would be authored by the same party asking for the trust. The
// vetting a `harness_enforced: true` represents is a HUMAN REVIEW of the
// runtime's real permission behavior, not a field a contributor fills in. Do
// not read tier fields off the provider object, and do not add tier fields to
// claude.cjs / codex.cjs.
//
// ADDING AN ENTRY IS AN ADR-GATED DECISION, not a merge conflict to resolve.
// Adding a runtime is a registry entry + a driver + fixtures (ADR-0005);
// GRANTING IT TRUST is a separate, ADR-gated entry here backed by committed
// evidence of the runtime's real enforcement behavior (ADR-0031 §6).
const { AgentExecError } = require('./result-contract.cjs');

// Entry fields are named for what they MEAN, never for the provider they
// happen to describe today:
//
//   harness_enforced            the runtime enforces the role's capability
//                               restrictions ITSELF, so there is no enforcement
//                               gap for the operator to acknowledge (ADR-0011).
//   performs_own_github_reads   the runtime reads GitHub itself, so it neither
//                               needs nor accepts a `--state-snapshot`
//                               (ADR-0013).
//   consumes_capability_policy  the runtime consumes the runtime-neutral
//                               capability policy, so `sandbox` / `approval`
//                               overrides are meaningful (ADR-0007).
//   required_containment_tier   the MINIMUM ADR-0011 tier this runtime must run
//                               at under `mode: autonomous`; `null` means the
//                               concept does not apply to it.
//   worker_selectable           the unattended worker may choose this provider.
//   merge_authority             a `review` verdict from this runtime may reach
//                               `trust.merge` (ADR-0031 Consequences: the T13
//                               ladder gains a provider gate).
//
// claude is the REFERENCE entry (harness-enforced, self-performing, tier-less,
// cleared); codex carries exactly the profile its `=== 'codex'` branches already
// implemented — NO behavior change for either.
const TRUST_TABLE = Object.freeze({
  claude: Object.freeze({
    harness_enforced: true,
    performs_own_github_reads: true,
    consumes_capability_policy: false,
    required_containment_tier: null,
    worker_selectable: true,
    merge_authority: true,
  }),
  codex: Object.freeze({
    harness_enforced: false,
    performs_own_github_reads: false,
    consumes_capability_policy: true,
    required_containment_tier: 2,
    worker_selectable: true,
    merge_authority: true,
  }),
});

// The entry, or null when the provider has NOT been vetted. Callers must treat
// null as a REFUSAL, never as "no special handling needed" — that inference is
// the exact fail-open ADR-0031 closes.
function getTier(providerId) {
  if (typeof providerId !== 'string') {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(TRUST_TABLE, providerId)
    ? TRUST_TABLE[providerId]
    : null;
}

// The refusal text. The WORDING is load-bearing: it must read as "this provider
// has NOT BEEN VETTED", never as "unknown provider" — a contributor who reads
// the latter adds an enum value (the exact move ADR-0031 exists to stop); a
// contributor who reads the former reads the ADR. `context` names the thing
// being refused (e.g. "mode 'autonomous'", "unattended worker dispatch").
function untieredProviderMessage(providerId, context) {
  const id = typeof providerId === 'string' ? providerId : JSON.stringify(providerId);
  return `provider '${id}' has no entry in the engine's provider trust table — it has not been VETTED, so it is refused for ${context} (fail closed, ADR-0031). Registry membership makes a runtime reachable by an explicit interactive \`verity agent-exec --agent ${id}\`; TRUST is a separate, ADR-gated entry in verity/bin/lib/agents/tiers.cjs backed by committed evidence of the runtime's real enforcement behavior — widening an enum grants nothing. Trusted providers: ${Object.keys(TRUST_TABLE).join(', ')}`;
}

// The entry, or THROW. Used by the agent-exec-side callers, whose thrown errors
// already map onto the exit-30 infra path (contracts/agent-result.md). The
// worker constructs its own WorkerError from `untieredProviderMessage` with the
// same `untiered-provider` slug — one message, two error classes.
function requireTier(providerId, context) {
  const entry = getTier(providerId);
  if (entry === null) {
    throw new AgentExecError(untieredProviderMessage(providerId, context), 'untiered-provider');
  }
  return entry;
}

// The ONE source of the provider list that `autonomy.cjs` (the `agent.provider`
// enum), `schemas/autonomy.schema.json`, and `doctor.cjs` (SUPPORTED_AGENTS)
// render — so the three lists that used to drift cannot.
function workerSelectableProviders() {
  return Object.keys(TRUST_TABLE).filter((id) => TRUST_TABLE[id].worker_selectable === true);
}

// The providers for which a given trust property holds — used to render knob
// rejection messages that name WHY a knob does not apply ("only meaningful with
// agent.provider codex") from the table instead of from a hardcoded id, so the
// wording cannot drift from the policy as the table grows.
function providersWith(prop, value = true) {
  return Object.keys(TRUST_TABLE).filter((id) => TRUST_TABLE[id][prop] === value);
}

module.exports = {
  TRUST_TABLE,
  getTier,
  requireTier,
  untieredProviderMessage,
  workerSelectableProviders,
  providersWith,
};
