# Contract: operator-init

- **Status:** frozen v1 (2026-09-29; ADR-0038; request #304)
- **Owner:** the `verity init` verb (engine; a new `verity/bin/lib/init.cjs`
  composing existing engine operations — identity, scaffold, gates, autonomy
  policy, git lifecycle, `substrate-local.provisionBareOrigin`, labels, and the
  intake write). It is the ONLY non-interactive project-creation surface. It is
  NOT part of `operator-act` (v2 stays byte-stable; ADR-0038 D1). Governing ADRs:
  0012/0013 (Verity performs git/gh effects), 0028 (console-driven Fresh), 0029
  (local substrate), 0038.

## Exposes

```
verity init <path> --spec <file> --name <name> --owner <owner>
            [--slug <slug>] [--substrate github|local] [--private|--public]
            [--start] [--json]
```

Creates a Verity project at `<path>` from a spec file, ready for the autonomy
worker to plan and build, with no vision/architect chat session. In a FIXED step
order (each step is one existing engine operation):

| # | step | effect |
|---|---|---|
| 0 | `preflight` | pure checks; refuses with ZERO effects (see invariant 1) |
| 1 | `identity` | `identity lock <name> <slug> --owner <owner>` in `<path>` |
| 2 | `scaffold` | `scaffold init --description <first heading or line of the spec>` |
| 3 | `spec` | copy the spec to `docs/spec.md` (verbatim) |
| 4 | `gates` | write the default `.verity/gates.json` (the scaffold's CI gates, stage-82 format) |
| 5 | `policy` | write the starter `.verity/autonomy.yml` (see invariant 6) |
| 6 | `git` | `git init`, `git add -A`, initial commit |
| 7 | `remote` | github: `gh repo create <owner>/<slug> --source=. --push` (+ `remote set-head`); local: `provisionBareOrigin` |
| 8 | `labels` | github: the Verity label set (`ensureLabels`); local: `skipped:true` (records carry labels) |
| 9 | `intake` | file the `verity:request` intake (issue on github; work-item record on local), plus `verity:circuit-open` unless `--start` |
| 10 | `register` | write `.verity/intake.json`, commit `chore(verity): register intake #<n>`, push to the default branch |

**Invariants (never weaken):**

1. **Refuse before effect.** `preflight` runs every check below with no write of
   any kind; a failure yields `outcome:"refused"`, exit **2**, `steps` containing
   only the preflight entry, and NOTHING on disk, in git, or on GitHub:
   `<path>` exists and is non-empty (a missing path is created); `<path>` is inside
   an existing git work tree (an embedded repo would mix state — #303);
   `<path>/.verity/identity.json` (or the identity file `identity lock` writes)
   already exists; `--spec` is unreadable or empty; `<name>`/`<owner>`/`<slug>` fail
   `identity lock`'s own validation; `--substrate` is not `github`|`local`;
   `--private` and `--public` both given; on `github`, `gh auth status` fails.
2. **No model spend, no role dispatch, no worker spawn.** `init` never invokes an
   agent and never starts the worker. (ADR-0008 parity with `operator-act`
   invariant 7.)
3. **Verity performs every effect** (ADR-0012/0013): file writes, git, `gh`. The
   spec's content is never interpreted; its first heading/line is used as the
   description string only.
4. **Honest partial state.** After preflight, `steps[]` lists every step that RAN,
   in table order; the first `ok:false` names the failure in `detail` and sets the
   top-level `reason`; steps after it are ABSENT, never reported `ok:true` by
   assumption. `outcome:"failed"`, exit **1**. Fields the failed run did not
   establish are `null`. A consumer can show exactly what exists.
5. **No ambiguous re-issue** (stage 112 discipline). `gh repo create` and `gh
   issue create` are never retried after an ambiguous failure (timeout, 5xx, EOF);
   the verb reads back (`gh repo view` / the `verity:request` list) and reports
   `confirmed_by` on the step when the read confirms the write landed. A confirmed
   write is `ok:true`; an unconfirmed one is `ok:false` with the ambiguity named.
6. **Inert by default.** The intake item carries `verity:circuit-open` unless
   `--start` is passed, so the worker's startup breaker halts every tick until the
   operator closes the circuit (`operator act circuit close <n>` — operator-act v2).
   The starter policy is `mode: supervised`, `review.trust: 0`, `substrate` as
   chosen, `commit_intent_artifacts` and `reconcile_work_items` as the benchmark
   sets them, and `limits.unknown_cost_behavior: allow_with_token_limit`. `init`
   never sets a trust above 0.
7. **The register is the trust anchor** (ADR-0038 D2). `.verity/intake.json` is
   committed on the default branch and pushed BEFORE `init` returns `ok:true`; a
   request the register does not list is subject to the no-self-feeding rule
   exactly as today. `init` writes the register on BOTH substrates.
8. **Idempotent-or-refusing.** Re-running on the same `<path>` is refused by
   invariant 1 (`path-not-empty` / `identity-exists`). There is no `--force`.
9. **Secrets never appear.** No credential is written to the tree; output passes
   the engine redactor; the only identity material in the result is the GitHub
   owner and repo names. github repos default to `--private`.
10. **Input-validated, local-path only.** `<path>` is resolved to an absolute path
    and must be a local directory; `--spec` is a local file. No URL, no remote
    fetch.

## Consumes

1. **Identity** — `verity identity lock` (name/slug/owner validation and the
   lock file; refuses an existing lock).
2. **Scaffold** — `verity scaffold init --description`; the gates definition it
   ships (stage 82 `.verity/gates.json` format).
3. **Policy writer** — `autonomy.toYaml` with the starter keys of invariant 6.
4. **Git lifecycle** — the same init/commit/push primitives `benchmark provision`
   uses (stage 77 set-head quirk included), so stage branches fork from
   `origin/<default>`.
5. **Remote** — github: `gh repo create`, `ensureLabels` (`labels.cjs`); local:
   `substrate-local.provisionBareOrigin` (throws on any half-wired state).
6. **Intake carrier** — github: `gh issue create --label verity:request` (+ the
   circuit label); local: a work-item record per contract `local-work-item` v1
   (`.verity/work-items/<n>.json`, labels on the record).
7. **Label vocabulary** — `verity:request`, `verity:circuit-open` (`labels.cjs`).
8. **Register** — `.verity/intake.json` (schema below), read by the scanner's P4
   tier (ADR-0038 D2) and by the plan prompt for the spec pointer (D3).

## Schema / wire

`verity init … --json` → exactly one compact JSON object on stdout:

```json
{
  "schema": 1,
  "ok": true,
  "outcome": "ok",
  "path": "/home/me/projects/x",
  "identity": { "name": "X", "slug": "x", "owner": "me" },
  "substrate": "github",
  "repo": "me/x",
  "remote": "https://github.com/me/x",
  "default_branch": "main",
  "spec": { "path": "docs/spec.md", "commit": "3f1c2ab", "title": "X: a thing that does Y" },
  "intake": { "number": 1, "kind": "issue", "url": "https://github.com/me/x/issues/1",
              "labels": ["verity:request", "verity:circuit-open"], "registered": true },
  "policy": { "path": ".verity/autonomy.yml", "mode": "supervised", "trust": 0,
              "circuit_open": true },
  "steps": [
    { "step": "preflight", "ok": true },
    { "step": "identity",  "ok": true },
    { "step": "scaffold",  "ok": true },
    { "step": "spec",      "ok": true },
    { "step": "gates",     "ok": true },
    { "step": "policy",    "ok": true },
    { "step": "git",       "ok": true, "detail": "initial commit 3f1c2ab" },
    { "step": "remote",    "ok": true },
    { "step": "labels",    "ok": true },
    { "step": "intake",    "ok": true },
    { "step": "register",  "ok": true, "detail": "commit 9a0b1cd pushed to main" }
  ],
  "reason": null
}
```

- **`outcome`** ∈ `ok` / `refused` / `failed`; **`ok`** is `true` iff `outcome`
  is `ok`. Exit code **0** / **2** / **1** respectively.
- **`steps[].step`** is the fixed vocabulary of the table, in table order, and
  only steps that ran appear. `ok:false` carries `detail` (redacted). A step that
  does not apply on the substrate (`labels` on local) is `{ ok:true, skipped:true }`.
  A step confirmed by read-back after an ambiguous failure carries
  `confirmed_by: "repo-view" | "issue-list"`.
- **`repo`** is `owner/slug` on github, `null` on local. **`remote`** is the
  GitHub URL on github, the bare repository's absolute path on local.
- **`intake.kind`** ∈ `issue` (github) / `record` (local); `url` is `null` on
  local. **`intake.labels`** lists exactly what was applied (with `--start`, the
  circuit label is absent and `policy.circuit_open` is `false`).
- **`spec.title`** is the description string derived from the spec (first
  Markdown heading, else first non-empty line, trimmed to 200 characters).
- **`reason`** is `null` on `ok`; on `refused`/`failed` it is one redacted
  sentence naming the failing check or step (`preflight: path is not empty` /
  `remote: gh repo create failed: …`).
- **Any field not established is `null`**, never a plausible default.

**The intake register** — `.verity/intake.json`, committed:

```json
{
  "schema": 1,
  "requests": [
    { "number": 1, "kind": "issue", "spec": "docs/spec.md", "spec_commit": "3f1c2ab",
      "filed_by": "verity init", "engine": "1.8.0", "filed_at": "2026-09-29T18:00:00Z" }
  ]
}
```

- `requests[]` is append-only; `number` is the intake item's number on its
  carrier (issue number / record number). The scanner's P4 tier keeps a
  bot-authored `verity:request` IFF its `number` appears here at the worker's
  checkout of the default branch (ADR-0038 D2); every other rule of the tier is
  unchanged. `filed_by` is a fixed vocabulary, `verity init` in v1 (a later
  engine-filed intake verb adds its own value additively).

**The intake item** — github issue: title `[request] <spec.title>`; body: a
pointer paragraph naming `docs/spec.md` at `spec_commit` and instructing the
reader to read the file first, followed by nothing else (the spec is NOT pasted).
Local record: `{ number, title: "[request] <spec.title> — spec: docs/spec.md",
state: "OPEN", labels: [...] }` per `local-work-item` v1.

## Versioning

Frozen at **v1** (2026-09-29, ADR-0038). Changes are **additive only** — a
breaking change (including a step that performs a new kind of effect, a
`--force` that bypasses a preflight refusal, or any trust above 0 in the starter
policy) is a NEW contract, not an edit (framework-spec §4.3). Consumers: the
Console's "New project" flow (first); `benchmark provision` MAY be re-based on
this verb later, evidence-gated (ADR-0038 Consequences).

Amended additively 2026-09-29 (plan verification for stage 113, assessment
`feature-assessments/verity-init-console-driven-fresh-assessment.md`):
(a) **step 4 `gates`** — the scaffold ships NO default gate list by design
(`scaffold.cjs:22-29`: a default gate would be a fabricated green; ADR-0028 has the
stage that lands the stack define the gates). v1 therefore writes `.verity/gates.json`
ONLY from explicit, repeatable `--gate <name>=<command>` flags (argv order kept,
stage-82 format); with none, the step reports `{ "step": "gates", "ok": true,
"skipped": true, "detail": "…" }` and the walking-skeleton stage the plan role writes
defines the gates. The table row's "write the default `.verity/gates.json`" reads
accordingly. (b) **preflight** gains `git-identity`: a resolvable git `user.name` and
`user.email` for the initial commit, refused before effect like every other check.
Neither changes a wire field; `schema` stays `1`.

Amended additively 2026-09-29 (architect, after stage 113 merged — 2c12c01, PR #308):
**the v1 refusal vocabulary is pinned.** `reason` on `outcome:"refused"` begins with
one of exactly these tokens (`init.cjs` `REFUSALS`): `invalid-path`, `unknown-flag`,
`identity-exists`, `path-not-empty`, `inside-work-tree`, `spec-unreadable`,
`invalid-name`, `invalid-slug`, `invalid-owner`, `invalid-substrate`,
`visibility-conflict`, `invalid-gate`, `git-identity`, `gh-auth`. The `detail` that
follows names the check in words and never echoes a credential-shaped string. Two
tokens are deliberately overloaded in v1 and consumers MUST NOT infer more than the
token says: a spec carrying a credential shape, a non-regular or oversized spec, and
an unreadable spec all report `spec-unreadable`; an existing `<path>-origin.git` on
the local substrate reports `path-not-empty`. A more specific token (e.g.
`spec-secret`, `origin-exists`) MAY be added additively later, so a consumer matches
known tokens and treats an unknown token as "refused, read `detail`". Also pinned by
the build: preflight refuses control characters and U+2028/U+2029 in `--name`,
`<path>`, `--gate` and the spec's title line, and a credential shape in `--name`,
`--gate` or the spec (invariant 9). `schema` stays `1`.

Amended additively 2026-09-29 (architect, after stage 113 merged; run evidence
below): **invariant 6's "`commit_intent_artifacts` and `reconcile_work_items` as
the benchmark sets them" is pinned to `agent.commit_intent_artifacts: true` and
`agent.reconcile_work_items: true`.** The benchmark never writes either key
(`benchmark.cjs` `writeVariant`; `benchmark.json` carries neither), so the engine
defaults (`false`) applied to fixture A (`a-20260925-160754`), and its plan role — a
`git_write:false` role by contract — left its stage files UNCOMMITTED; they reached
`main` only because the stage-1 build's `git add -A` swept them into the stage
branch (commit 1697de9 in that repo adds `stage-instructions/` alongside the
skeleton). A project created by `verity init` must not depend on that accident:
ADR-0033 (`commit_intent_artifacts`) exists so the engine commits and pushes the
plan role's intent artifacts to the default branch, and ADR-0026
(`reconcile_work_items`) so `[stage N]` work items exist for the Console's `operator
work`. Stage 113 wrote both as `false` (a literal reading of the old wording); stage
114 flips them. Not a wire field; `schema` stays `1`.
