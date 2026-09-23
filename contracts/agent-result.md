# Contract: agent-result

- **Status:** frozen v1
- **Owner:** `verity/bin/lib/agents/result-contract.cjs` (provider drivers produce
  it; `agent-exec.cjs` emits it; the worker consumes it)
- **Related:** ADR-0005 §"one seam", ADR-0008 (null cost), SKETCH §3.3

The single object every provider driver must return and the ONLY thing that
crosses from a model runtime back into deterministic Verity. Provider events,
JSONL grammars, and CLI exit conventions never leak past this shape.

**v1 freezes the current, already-shipped `agent-exec` result object** (the
shape the worker, usage ledger, and tests depend on today). Codex fields are
additive on top of it.

## Exposes

One JSON object on `agent-exec` stdout per invocation — emitted for role
outcomes AND infra failures alike, so callers always get exactly one parseable
object. Exit-code mapping is part of the contract: `success` → 0, `gated` → 10,
`failed` → 20, `infra_error` → 30.

## Consumes

- The provider's raw transcript (retained verbatim on disk — Claude:
  `~/.verity/logs/<run-id>/<role>.jsonl`; Codex adds
  `<role>.codex.jsonl` + `<role>.final.json` per ADR-0005/§19.2 naming).
- The role's in-band outcome marker
  (`{"verity":1,"outcome":"success|gated|failed","gate":…,"artifacts":…,"reason":…}`,
  last line of the final message — the existing RESULT_CONTRACT footer) OR a
  provider structured-output file validated against
  `schemas/agent-result.schema.json`. Both normalize into this contract;
  neither consumer-visible shape changes.
- Outcome vocabulary per layer (documented additively, ADR-0035): the Claude
  text marker's `outcome` is `success|gated|failed` (`result-contract.cjs`
  `OUTCOMES`); the provider structured-output file's `outcome` is
  `completed|gated|failed|no-op` plus a REQUIRED `summary: string` (the schema
  and the structured marker). At normalization `completed` and `no-op` map to
  wire `success`, and `summary` is dropped — it is never carried onto the wire.
  The wire vocabulary below is always `success|gated|failed|infra_error`.

## Schema / wire

v1 fields (all REQUIRED, exactly as shipped today):

```json
{
  "schema": 1,
  "role": "plan",
  "outcome": "success | gated | failed | infra_error",
  "tokens": { "in": 0, "out": 0 },
  "est_usd": null,
  "wall_secs": 12,
  "tool_calls": 7,
  "artifacts": {},
  "error": null
}
```

Semantics that are part of the freeze:

- `tokens.in` includes cache-creation and cache-read input tokens (the
  existing Claude normalization); providers must fold their own usage fields
  into these two totals.
- `est_usd` is `number | null`. **`null` means unknown — writing `0` for
  unknown cost is a contract violation** (ADR-0008: zero means free, and the
  budget breaker believes it).
- `artifacts` is a plain object of GitHub objects created/updated (best
  effort); `error` is `string | null` and non-null iff `outcome` is `failed`
  or `infra_error`.
- `artifacts` may additionally carry (additive v1.x, ADR-0035):
  `artifacts.paths: string[]` — relative repo paths reported by the provider's
  structured output, folded in at normalization — and `artifacts.pr: number`,
  set by the `git_lifecycle` step (the PR Verity opened for the run).
- Infra failures also print one machine-parsable stderr line:
  `verity-agent-exec: 30 <slug>: <message>`.

Additive v1.x fields (OPTIONAL — consumers must tolerate their absence, and
their presence, without behavior change when absent):

```json
{
  "provider": "claude | codex",
  "timed_out": false,
  "transcript_path": ".../plan.codex.jsonl",
  "final_message_path": ".../plan.final.json",
  "usage_detail": {
    "input_tokens": 1234,
    "cached_input_tokens": 500,
    "output_tokens": 450,
    "reasoning_output_tokens": 200,
    "total_tokens": 1884
  }
}
```

Further additive v1.x fields (OPTIONAL, same tolerance rule; documented per
ADR-0035 — each is already emitted by `agent-exec.cjs`):

```json
{
  "containment_tier": "<string>",
  "enforcement_gaps_acknowledged": [],
  "containment_rejected": [],
  "containment_merged": ["<relative path>"],
  "enforcement_violations": [],
  "enforcement_reverted": [],
  "git_lifecycle": {},
  "work_items": {},
  "intent_artifacts": {
    "outcome": "committed | noop | skipped | failed",
    "sha": "<optional>",
    "files": [],
    "branch": "<optional>",
    "pushed": false,
    "reason": "<optional>",
    "error": "<optional>"
  }
}
```

- `containment_tier` — string, which ADR-0011 containment guarantee applied
  (providers with tiers only). `enforcement_gaps_acknowledged` — array.
- `containment_rejected` — array; `containment_merged` — `string[]` (the
  paths deterministic Verity code propagated).
- `enforcement_violations` — array; `enforcement_reverted` — array.
- `enforcement_violations`, `enforcement_reverted` and `containment_rejected`
  appear only when `outcome` is `failed` or `infra_error` (a containment
  breach outranks the role's own claim of success).
- `git_lifecycle` — object, the Verity-performed git lifecycle result
  (ADR-0012); a PR it opened is also surfaced as `artifacts.pr`.
- `work_items` — object; plan role only, flag-gated (ADR-0026).
- `intent_artifacts` — object (ADR-0033): `outcome` ∈
  `committed | noop | skipped | failed`; `sha`, `files`, `branch`, `pushed`,
  `reason`, `error` are optional.

Fail-closed normalization rules (binding on every driver): invalid JSON,
schema-invalid structured output, a missing result file, or a completed
process with no valid result all normalize to `infra_error` — never to
`success`, never to a silent no-op. A timeout is a `failed`/`infra_error`
with `timed_out: true`, never `success`.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.

Amended additively 2026-09-23 per ADR-0035: documented the already-emitted
optional v1.x fields, the per-layer outcome vocabulary (structured marker
`completed|no-op` → wire `success`; `summary` not carried), and
`artifacts.paths` / `artifacts.pr`.
