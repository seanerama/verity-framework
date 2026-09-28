# Contract: operator-act (v2)

- **Status:** frozen v2 (2026-09-27; supersedes `operator-act.md` v1 for engines ≥ 1.7.0 — ADR-0037)
- **Owner:** operator actions (`verity/bin/lib/operator-act.cjs`, stage 50) — the
  ONLY write surface of the operator seam, kept in a SEPARATE module so the
  projection (`operator.cjs`) stays pure-read. Each verb is a thin, allowlisted
  wrapper over an action an operator can already perform by hand (a label
  POST/DELETE, or launching the worker). Governing ADRs: 0012 (Verity performs
  GitHub effects), 0013 (model claims don't move state; deterministic worker owns
  merge). Tracking: verity-dev #125-adjacent.

## Exposes

`verity operator act <verb> [target] [flags] [--json]` — a fixed, allowlisted set
of write verbs, each mapping to ONE existing GitHub-label or worker operation:

| verb | effect (the exact operation) |
|---|---|
| `approve <n>` | POST label `verity:approved` on item `n` (the single-use resume token) |
| `reject <n>` | DELETE `verity:approved` + `verity:awaiting-approval`, POST `verity:needs-human` on `n` (decline + park) |
| `request-changes <n> [--note S]` | POST `verity:needs-human` on `n` + a comment carrying `S` (park with rework intent) |
| `needs-human <n>` | POST `verity:needs-human` on `n` (park) |
| `clear-needs-human <n>` | DELETE `verity:needs-human` on `n` (unpark) |
| `circuit open <n>` | POST `verity:circuit-open` on open issue `n` (the worker halts, fail-closed) |
| `circuit close <n>` | DELETE `verity:circuit-open` on issue `n` (resume) |
| `run-once` | spawn `verity-worker --repo <repo> --once` (one deterministic tick) |

**Invariants (never weaken) — the safety spine of the whole Console:**

1. **No merge authority in this seam — EVER.** No verb merges, closes a PR, or
   grants merge. `approve` only applies the single-use resume token
   `verity:approved`; what that token DOES is decided by the deterministic worker's
   trust ladder (T13; ADR-0014 as amended 2026-09-27), never here. At trust 0 the
   ladder merges only a head that a completed review approved, that a human
   approved with this token, and whose checks are green — the human's token IS the
   merge decision, and it is applied by the worker on its next tick, not by this
   verb. At trust 1/2 the ladder is unchanged. There is no UI-only approval token,
   no `merge_authority_granted`. The deterministic worker remains the sole merge
   path. (v1 said "trust 0 STILL never merges (ADR-0013)": that sentence described
   the ladder of its day and mis-cited ADR-0013, which is about sandboxed roles not
   reaching GitHub; the act seam does not define trust semantics — ADR-0037.)
2. **Allowlist only.** The verb set above is exhaustive; an unknown verb is a hard
   error (no arbitrary label/command passthrough, no generic `gh` proxy).
3. **Doable by hand.** Every verb equals a label POST/DELETE (the same
   `gh api …/labels` the worker's `addLabel`/`removeLabel` and a human already
   use) or `verity-worker --once`. The wrapper adds convenience + a structured
   audit result, NOT new power.
4. **Fail-closed & honest.** A GitHub/worker operation that fails is reported as
   `ok:false` with a `reason` and a non-zero exit — NEVER a false success. No
   token/credential shape appears in any field (redacted).
5. **Idempotent where meaningful.** Applying a label already present, or removing
   one already absent, is a no-op `ok:true` (the underlying `gh api` is treated
   idempotently), so a Console retry is safe.
6. **Input-validated.** `target` must be a positive integer; a value that is not
   (a flag-shaped string, a non-number) is refused before any effect — the
   `--repo`-injection lesson (ledger) applied to targets.
7. **`run-once` launches, it does not model.** It spawns the worker, which may
   spend under ITS OWN limits/gates (ADR-0008); `operator act` itself never
   invokes a model and makes no spend decision.

## Consumes

1. **GitHub label ops** — `gh.run(['api','-X','POST'|'DELETE', '<base>/labels…'])`,
   the same primitive `verity/worker/index.cjs` `addLabel`/`removeLabel` (lines
   243–252) and `locks.cjs` use. `<base>` from the resolved repo + target number.
2. **Label vocabulary** — `verity:approved` / `verity:awaiting-approval` /
   `verity:needs-human` / `verity:circuit-open` (`labels.cjs` `LABELS`).
3. **Repo resolution** — `--repo`/`--gh-repo`/`GH_REPO` (the read side's rule).
4. **Worker** — `verity-worker --repo <repo> --once` (child process) for `run-once`.

## Schema / wire

`verity operator act <verb> [target] --json` → exactly one compact JSON object:

```json
{
  "schema": 1,
  "action": "approve",
  "target": 42,
  "effect": { "kind": "label-add", "label": "verity:approved", "item": 42,
             "consequence": "merge-when-green" },
  "ok": true,
  "reason": "applied verity:approved to #42 — the worker's trust ladder decides what the token does on its next tick (consequence: merge-when-green)"
}
```

- **`action`** is the verb; **`target`** the item number (`null` for `run-once`).
- **`effect`** names the concrete operation: `kind` ∈ `label-add` / `label-remove`
  / `label-swap` (reject: removes + adds) / `comment` / `worker-tick`; plus the
  label(s)/item or the spawned command. A multi-step verb (`reject`,
  `request-changes`) returns an `effects` array in effect-order.
- **`effect.kind` notes (additive, ADR-0035):** `label-swap` is reserved — not
  emitted in v1 (ADR-0035). `reject` is expressed as an `effects[]` array of
  `label-remove` (`verity:approved`), `label-remove`
  (`verity:awaiting-approval`), `label-add` (`verity:needs-human`), in that
  order. A `worker-tick` effect carries `command: string | null` (the spawned
  command line, `null` when refused), `exitCode: number | null`,
  `outcome: string` (`refused` / `spawn-error` when the worker never ran;
  otherwise the tick's own outcome, e.g. `ok` / `failed` / `unknown`) and an
  optional `summary: string` (first line of the worker's stdout).
- **`effect.consequence`** (v2; on `approve` only; OPTIONAL — consumers tolerate
  its absence) — what the worker's NEXT tick will do with the token, computed by
  the engine from the same inputs as the worker's gate copy (trust level, the parked
  review verdict and its head, checks): `merge-when-green` (approve verdict,
  trust 0, head unchanged), `resume` (a parked non-approve verdict re-gates at zero
  cost), `re-review` (head moved or no parked verdict), `gate` (the token cannot
  advance this item, e.g. verdict `escalate` or a provider without merge
  authority), or `unknown` (the inputs could not be read — never a guess). A
  consumer's copy for the approve control MUST derive from this field, not from
  a hard-coded trust rule.
- **`ok`** — `true` only if every underlying operation succeeded; else `false`
  with `reason` naming what failed (redacted). Exit code 0 on ok, non-zero on
  failure (fail-closed).
- **`run-once`** returns the worker's own outcome summary (`{ exitCode, outcome }`)
  under `effect`, not a merge claim.

## Versioning

Frozen at **v2** (2026-09-27, ADR-0037). Additive-only from here; a breaking change
(including ADDING a verb that grants new authority) is a NEW contract, not an edit
(framework-spec §4.3). v2 differs from v1 in exactly two ways: invariant 1 no
longer asserts a trust-ladder behaviour ("trust 0 never merges") that ADR-0014's
2026-09-27 amendment retired, and `effect.consequence` is added (optional) so a
consumer can render honest copy from data. Verbs, effects, exit codes and every
other invariant are byte-identical to v1. Consumers: the Console's Approvals /
Runs / Policy controls; a v1 consumer keeps working (the wire shape is a superset)
but must not display "does not merge at trust 0".
