# Autonomy Guide

Verity autonomy lets a headless **worker** (`verity-worker`) advance your project
on its own: it picks up labeled work from GitHub, runs the same Verity roles you
would invoke by hand, and pauses at human gates. This guide covers everything an
operator needs — starting with how to stop it.

---

## Kill switch (read this first)

Two ways to halt the worker. Both take effect at its **next wake-up** (the worker
is stateless between ticks; there is no long-running process to kill in cron mode):

1. **Open the circuit breaker** — add the label `verity:circuit-open` to any open
   issue in the repo (create a fresh issue for it if you like):

   ```bash
   gh issue create --title "HALT autonomy" --label verity:circuit-open
   ```

   Every subsequent worker start fails fast with exit 30 `circuit-open` and does
   nothing else — no scanning, no locks, no comments. Close the issue (or remove
   the label) to resume.

2. **Turn autonomy off in policy** — from the repo:

   ```bash
   verity autonomy set mode manual
   ```

   `mode: manual` is the default and means "autonomy disabled": the worker exits 0
   immediately with the message `autonomy disabled`, and every other Verity command
   behaves exactly as it did before autonomy existed.

A mid-run worker that you `kill -9` is also safe: its GitHub lock expires
(`expires:` timestamp in the lock comment, 1.5× `max_wall_clock_min`), and the
next tick reclaims it cleanly. This is exercised by the integration test
(`scripts/integration-autonomy.cjs`).

---

## What autonomy is

Without autonomy, you drive Verity's roles by hand (`/verity:plan`,
`/verity:build`, `/verity:review`, …). With autonomy, `verity-worker --once`
performs **one tick**:

1. **Startup checks** (fail fast, read-only): policy valid, mode ≠ manual, daily
   usage limits not exceeded, `gh` authenticated, bot identity is not a listed
   human, circuit breaker closed.
2. **Scan** for the highest-priority eligible work item (approved resumes first,
   then PRs awaiting review, ready stages, new `verity:request` issues, then
   whatever the dependency engine says is next).
3. **Lock** the item (label `verity:in-progress` + a `lock:<run-id> expires:<ts>`
   comment — state lives in GitHub, the worker keeps none).
4. **Loop**: ask `verity next --json` what to do, run that role headlessly via
   `verity agent-exec` (the only place an AI agent is invoked), repeat — until
   idle, a human gate, a failure, or a per-run limit.
5. **Summarize**: one audit comment per run (roles, outcome, tokens, est. cost,
   wall time), one usage-ledger row appended per role invocation (all sharing
   the run id; see [Usage & cost tracking](#usage--cost-tracking)), lock
   released — always, even on crash paths.

Every action the worker takes is bot-attributed, comment-audited, and priced.

## Modes

Set in `.verity/autonomy.yml` (`verity autonomy show` prints the effective
policy, defaults merged):

| Mode | Behavior |
| --- | --- |
| `manual` (default) | Autonomy off. Worker exits 0 immediately. Zero behavior change for existing users. |
| `supervised` | Worker advances work and chains roles (`auto_advance`), but every gate (`review:merge`, `ship:prod`, `golive`) pauses for a human. The recommended starting mode. |
| `autonomous` | Same machinery with higher trust settings doing more on its own. Only after a successful supervised canary. |

```bash
verity autonomy set mode supervised
verity autonomy validate          # schema-check the file, exit 0/20
```

## Trust ladder (who merges)

Merge authority lives in the **worker's deterministic code**, never in the review
agent — the review role's tool allowlist contains no merge-capable tool; it only
reports a verdict.

| `review.trust` | After a review verdict of "approve" |
| --- | --- |
| `0` (default) | Never merges on its own. Gates at `review:merge`; the human decides. Applying `verity:approved` to that gate **is** the merge decision (stage 111, ADR-0014 amended): the next tick resumes the parked verdict and merges only if it is `approve`, the PR head is still the one the review examined, the label was applied after the gate comment by a human account (not the bot; one listed in `humans:` if set), and checks are verified green (zero new model runs, merge pinned to the reviewed head). Or merge the PR yourself on GitHub. Enable branch protection ("require 1 review") as the backstop. |
| `1` | Auto-merges only **low-risk** PRs: every changed file matches `low_risk.allowed_paths`, none matches `protected_paths` (a protected hit always vetoes), `additions+deletions ≤ max_changed_lines`, and checks are green when `require_ci_green`. Everything else gates. |
| `2` | Merges any approved PR with green checks. |

`protected_paths` always includes `.github/**` and `.verity/**` — the loader
forces them back in even if the file removes them. Raising trust requires
`verity autonomy set review.trust <n> --confirm` and records an ADR.

## Review verdicts (how a review routes)

The review role reports a verdict; the worker's deterministic code routes it.

| Verdict | Routes to | Merges? |
| --- | --- | --- |
| `approve` | The trust ladder above (may merge, may gate) | Only per the ladder |
| `request_changes` | Gates at `review:merge`; hand back to `/verity:build` | Never |
| `escalate` | Gates at `review:merge`. With `review.escalate_routing: true` it also **parks the work item** (`verity:needs-human`) and names `/verity:plan` for a contract/ADR amendment | Never (not even with `verity:approved`) |
| unknown / absent | Gates at `review:merge` (fail-closed) | Never |

`review.escalate_routing` defaults **false** (dark-launched): while off, an
`escalate` verdict routes exactly like `request_changes` — a plain gate, no
`verity:needs-human`. An escalation fails safe (worst case: an unnecessary human
look), so it never merges at any trust level.

## Label vocabulary

`verity install` creates these eight labels (idempotently — colors/descriptions
are updated in place, labels are never deleted):

| Label | Meaning |
| --- | --- |
| `verity:request` | Human-approved inbound work; the worker may plan it |
| `verity:ready` | Stage/work item ready for build |
| `verity:in-progress` | Locked by a worker run |
| `verity:awaiting-approval` | Paused at a human gate |
| `verity:approved` | Human approved; worker resumes (single-use — consumed on resume) |
| `verity:needs-human` | 2 failures; worker skips the item until cleared |
| `verity:circuit-open` | Budget/safety breaker tripped; worker halts entirely |
| `verity:trust-demoted` | Auto-demotion audit marker (v2) |

The worker never touches an item carrying `verity:needs-human`, and never starts
at all while any open issue carries `verity:circuit-open`.

## Approval flow

When a run hits a human gate, the worker:

- labels the gate's target (the PR for `review:merge`) `verity:awaiting-approval`,
- posts a ⏸️ comment saying exactly what is pending and how to approve,
- @mentions everyone in `notify.mention`,
- posts the run summary and releases the lock.

To approve, **apply the label `verity:approved`**. The next tick picks approved
items up first (P1), removes both labels (the token is single-use), and
continues.

### Approving a `review:merge` gate (stage 111, ADR-0014 amended)

A `review:merge` gate after a completed review **parks the review's result**,
exactly like the `unknown-cost` gate below: the ⏸️ comment carries a
``parked: role `review` result of run … at PR #N head <sha>`` line, where
`<sha>` is the PR head read **before** the review ran — the head the verdict
examined. Applying `verity:approved` then **resumes that verdict** instead of
buying a new review. If the head moved while the review ran, the review may
have read either head, so **no** pointer is recorded: an approval buys a fresh
review, even if the branch is later force-pushed back to the old head.

The worker trusts that pointer only when (stage 111 review):

- the ⏸️ comment was written by the worker's own bot account (a comment anyone
  else posts in the same format is ignored; with no known bot identity nothing
  is resumed), and
- it matches the park record the worker wrote on its own host when it posted
  it — `~/.verity/logs/<run>/park.json` (run id, PR, head, gate, bot login,
  the GitHub time of the pre-review head read, the retry counter; no
  secrets). An edited comment, or one naming a run this host never parked,
  does not match, and the approval buys a fresh review instead, and
- for an `approve` verdict (any trust), the PR's timeline shows **no push**
  since the review read its head: no `head_ref_force_pushed`,
  `head_ref_restored`, `head_ref_deleted` or `committed` event (nor
  `base_ref_force_pushed` / `base_ref_changed`, if GitHub serves them) at or
  after that read. The read's time is GitHub's own `updatedAt` from the same
  `gh pr view` that read the head, compared with GitHub's `created_at` on the
  events, so the worker host's clock plays no part. `committed` events carry
  only git dates, which the pusher sets, so they are a secondary signal. A head
  that goes back to the reviewed SHA always needs a force-push, which GitHub
  timestamps itself. A push found this way is treated like a moved head: a
  loud fresh review. A park recorded before this check existed (no read time)
  also re-reviews. If the PR's timeline cannot be read, the tick does not
  merge: the verdict re-gates at zero cost and says why.

At trust 0 the label itself is also checked, from the item's timeline: its
latest `labeled` event must be **newer than that gate comment**, by an account
that is **not the worker's bot**, and — when `humans:` is set — by a login
**listed in `humans:`**. A label that fails any of these (applied before or
while the gate was posted, applied by the bot, applied by a triage-only
account or integration) does not merge: the parked verdict re-gates at zero
cost, the label is consumed, and the new gate comment says why. Apply the
label again after that comment. If the timeline cannot be read, the tick
re-gates the same way. In a single-account setup (operator and bot are the
same login) the label never merges; merge on GitHub.

What the approval then does:

- **Head unchanged** → zero new model runs; the summary says `resumed:`.
  - At trust 0 with an `approve` verdict and verified-green checks, the tick
    **merges** (`gh pr merge --squash --match-head-commit <sha>`, so GitHub
    refuses if the branch moved after the green reading). The label is
    consumed by the merge.
  - At trust 0 with an `approve` verdict but checks **not** green, it
    **leaves `verity:approved` in place** and posts only its run summary (no
    new gate comment) — the next tick retries the merge once CI is green,
    without asking you again.
  - Any other verdict (`request_changes`, `escalate`, unknown) re-gates at zero
    cost. Approval never overrides a verdict, and never lowers a trust-1 risk
    refusal. At trust 1/2 a resumed `approve` verdict re-runs the ladder, which
    may merge it (low risk and green at trust 1; green at trust 2).
  - A merge that GitHub refuses (conflict, protection, moved head) ends the
    tick as `infra` with the reason and leaves the label; the next tick
    re-verifies from scratch.
  - Retries are bounded: after **3** approval ticks for the same parked
    verdict that could not land the merge (CI still not green, or GitHub
    refused), the worker stops, consumes the label and parks the item
    `verity:needs-human` without another gate comment. Applying the label again
    does not restart the count, and neither does a refused label's re-gate.
    Only the `verity:needs-human` park resets it. Fix the cause, clear
    `verity:needs-human` and apply `verity:approved` again, or merge on
    GitHub.
- **Head moved** (including a push that landed while the review ran, or any
  push since the review read the head, even one that put the reviewed SHA
  back), pointer unreadable or unmatched, or parked file gone → a loud
  `repurchase:` fallback to a fresh review at full price. The fresh verdict
  gates again for you, so the approval never merges a head that no review
  examined and no human saw the verdict for.
- A review verdict that names a PR other than the one the review was
  dispatched for is never acted on: it gates with no pointer, on the PR the
  review was dispatched for. Its findings comment is posted there too, never
  on the PR the model named.
- An `unknown-cost` approval consents to the **cost** only: the resumed review
  then parks at `review:merge`, and merging takes a second approval.

The local substrate has no comment trail, so there is no pointer and an
approval there always buys a fresh review (which re-gates).

The ⏸️ comment's `approve:` line for a `review:merge` gate is always true for
its configuration:

| Configuration | `approve:` line |
| --- | --- |
| trust 0, `approve`, checks green (or not read) | apply label `verity:approved` from a human account (never the worker's bot; one listed in `humans:` if set) — the next tick merges when CI is green (zero new model runs) |
| trust 0, `approve`, no resumable pointer (head unreadable, or the local substrate) | merge the PR yourself, or apply `verity:approved` to re-review at full price — this park has no resumable pointer, so an approval cannot merge |
| trust 0, `approve`, checks not green | CI is not green; apply `verity:approved` once it is, from a human account (never the worker's bot; one listed in `humans:` if set), or merge on GitHub |
| trust 0, `approve`, approved but checks not green (label kept; run summary only) | `verity:approved` stays applied — the next tick merges once CI is green (zero new model runs), or merge on GitHub |
| trust 0, `approve`, the head moved while the review ran | the no-resumable-pointer line below; the gate reason names the moved head |
| `request_changes` (any trust) | the review asked for changes: push a fix (new head) and apply `verity:approved` to re-review, or merge on GitHub; approving the unchanged head re-gates at zero cost |
| `escalate` (any trust) | architectural / frozen-contract blocker: resolve via /verity:plan; approval does not merge |
| provider without merge authority (ADR-0031) | merge on GitHub; a verdict from this runtime never merges |
| trust 1, `approve` | merge on GitHub, or apply `verity:approved` to re-run the trust ladder on this approve verdict at zero cost — at trust 1 it merges only a low-risk PR with green checks; an approval never overrides the risk classification |
| trust 2, `approve`, checks not green | CI is not green; apply `verity:approved` once it is to re-run the trust ladder on this approve verdict at zero cost — it merges if checks are green by then (or merge on GitHub) |
| unknown / absent verdict | re-review (absent: a fresh review at full price) or merge on GitHub |
| any non-`approve` verdict, or trust 1/2 `approve`, with no resumable pointer | the same copy, but ending "this park has no resumable pointer, so any approval re-reviews at full price" (never "re-gates at zero cost") |
| `approve` verdict that named no PR | merge on GitHub; the approve verdict named no PR, so Verity cannot act on it — an approval only buys a fresh review at full price |

What the label *does* in each row is decided once, by
`trust.approvalConsequence`; the `approve:` line only words it. The same
decision is what `verity operator act approve` reports (below), so the gate
comment and the act verb never disagree.

#### `verity operator act approve` — `effect.consequence` (operator-act v2, ADR-0037)

`verity operator act approve <n>` applies `verity:approved` and nothing else:
no verb merges (the frozen act contract, now
[`contracts/operator-act-v2.md`](../contracts/operator-act-v2.md) — v1's "trust 0
never merges" sentence described the ladder of its day and is superseded). The
**worker** is the sole merge path. Since 1.7.0 the verb's JSON also reports what
the worker's next tick will do with the label, as `effect.consequence`:

| `consequence` | When |
| --- | --- |
| `merge-when-green` | trust 0, parked `approve` verdict, PR head unchanged, and the label's latest `labeled` event is newer than the gate comment, by a non-bot account (listed in `humans:` if set) — the next tick merges once CI is green (zero new model runs) |
| `resume` | a parked non-`approve` verdict re-gates at zero cost |
| `re-review` | the head moved, the PR was pushed to since the review read its head (`approve` verdicts), the pause recorded no pointer or head (or its record has no head-read time), the pointer does not match its park record, or the parked result carries no verdict — a fresh review at full price |
| `gate` | the label cannot advance the item: verdict `escalate`, a review runtime without merge authority (ADR-0031), or (trust 0) a label the worker will not honour — applied before the gate comment, by the bot, or by an account not in `humans:` |
| `unknown` | an input could not be read — the policy, the gate-comment trail, the PR's or the item's timeline, the PR head, the park record or parked result (both live under the worker host's `~/.verity/logs`), the local substrate (no comment trail); no gate comment could be authenticated against a park record on this host; the item's latest gate is not a `review:merge` park; or trust 1/2 with an `approve` verdict (the ladder may merge on inputs the verb does not read). Never a guess. |

The act verb does not know the worker's bot login; it learns it from the
worker host's park records (the author of a ⏸️ comment whose pointer matches a
record naming that author). Run it on the worker host, or expect `unknown`.
The prediction's reads are read-only and bounded by `gh`'s per-call timeout,
taken only after the label write succeeds; a failed write reports no
consequence. The `reason` string names the consequence. Checks are not read:
no value depends on them.

Other gates (`ci:unverified`, `unknown-cost`, role-declared) keep the plain
``apply label `verity:approved` `` line — there the label does advance the item.

> In v1 **the label is the only approval token the worker honors** — under the
> Actions driver a comment *wakes* the worker promptly (the workflow triggers on
> `issue_comment`), but nothing yet translates the comment text into an
> approval. Use the label.

## Running it: cron recipe

The v1 driver is one cron line on any machine with `git`, `gh` (authenticated as
the bot), and the repo cloned:

```cron
*/30 * * * * cd /path/to/repo && GH_TOKEN=$(cat ~/.verity-bot-token) verity-worker --repo owner/name --once >> ~/verity-worker.log 2>&1
```

Notes:

- `--once` does one tick and exits; overlap protection comes from the GitHub
  lock protocol (an accidental second start exits 0 "locked" within one scan).
- Run it from the repo clone — the files, git history, and the Verity-performed
  stage lifecycle (ADR-0012) live there. GitHub state, though, targets the
  `--repo` repository for every `gh` call the tick makes — never a cwd-derived
  remote — so a clone with no usable remote refuses truthfully as
  `git-unprovidable` instead of dying inside the circuit-breaker check.
- The headless agent (`verity agent-exec`) needs Anthropic auth in its environment —
  either `ANTHROPIC_API_KEY` (pay-per-token) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription).
  See [Agent auth: API key vs subscription](#agent-auth-api-key-vs-subscription).
- No machine handy? Use the GitHub Actions driver below instead.

## Running it: GitHub Actions

`verity install --actions` (run from the repo) scaffolds
`.github/workflows/verity-worker.yml` — a workflow that runs
`verity-worker --once` on a 30-minute schedule **and** whenever an issue/PR is
opened or labeled or a comment lands, so approvals are picked up within seconds
instead of waiting for the next cron tick.

Setup:

1. Scaffold and commit the workflow:

   ```bash
   verity install --actions --bot yourorg-verity-bot   # default login: verity-bot
   # add --auth subscription to run on a Claude plan instead of an API key
   git add .github/workflows/verity-worker.yml && git commit -m "chore: verity Actions driver"
   ```

   `--bot` templates the workflow's self-event guard
   (`if: github.actor != '<bot>'`) — it must be the **login of the bot account**
   that owns `VERITY_BOT_TOKEN`, or the bot's own labels/comments will
   re-trigger the workflow in a loop. The scaffold is idempotent (re-running it
   is a no-op); if the file has local edits it refuses to overwrite — re-run
   with `--force` to regenerate.

2. Create the bot machine account exactly as in
   [Bot-account setup](#bot-account-setup) below.

3. Add two **repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Purpose |
   | --- | --- |
   | `VERITY_BOT_TOKEN` | The bot account's token (repo write + `workflow` scope). Used for checkout and every `gh` call — keeps all worker actions bot-attributed. |
   | `ANTHROPIC_API_KEY` *(api-key auth)* | The headless agent's API key. This is the one that spends money. |
   | `CLAUDE_CODE_OAUTH_TOKEN` *(subscription auth)* | OAuth token from `claude setup-token`; runs the agent on a Claude plan instead. Add this **instead of** the API key when you scaffolded with `--auth subscription`. |

   Add **one** of the two agent secrets — whichever matches your `--auth` choice. Don't set
   both: an `ANTHROPIC_API_KEY` always wins over the OAuth token and forces pay-per-token.

4. Set the policy as usual (`mode: supervised`, `humans:`, limits) and make sure
   the labels exist (`verity install` creates them).

Budget guardrails are on by default: the job's `timeout-minutes: 50` hard-caps a
runaway run at the Actions level, and the worker's own startup checks refuse to
run once today's usage-ledger totals exceed `limits.max_usd_per_day` /
`max_runs_per_day` (exit 30 `daily-limit`) — or once today's costs cannot be
verified at all (exit 30 `unknown-cost-budget`, see [Limits](#limits)).

**Coexistence with cron — no double work.** The workflow's `concurrency` group
(`verity-<owner>/<repo>`, `cancel-in-progress: false`) serializes Actions runs:
when the schedule and an event fire together, GitHub queues the second run
instead of racing. Across drivers (an Actions run and a cron tick on another
machine), the worker's GitHub **lock protocol** is the fence — the second
instance exits 0 `locked` within one scan. Running both drivers is safe; it just
means more (cheap, idle) ticks.

The kill switch works identically: a `verity:circuit-open` label halts every
tick regardless of driver. To stop the Actions driver itself, disable the
workflow (`gh workflow disable verity-worker.yml`) or delete the file.

## Agent auth: API key vs subscription

The headless agent (`verity agent-exec`, which runs `claude -p`) needs Anthropic
credentials in its environment. There are two ways to provide them — pick one:

| | **API key** (default) | **Subscription** |
| --- | --- | --- |
| Env var | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Where it comes from | console.anthropic.com | `claude setup-token` (≈1-year token), on a box logged into your Claude Pro/Max plan |
| Billing | Pay-per-token, no ceiling | Draws from your plan's **monthly Agent SDK credit** ($20 Pro / $100 Max 5× / $200 Max 20×) |
| When the budget runs out | Keeps going (until `max_usd_per_day` halts the worker) | Worker **stops** until the next cycle — no silent fall-back to paid API |
| GitHub Actions | ✅ supported | ✅ supported (store the token as the `CLAUDE_CODE_OAUTH_TOKEN` secret) |
| `--auth` flag | `--auth api-key` (default) | `--auth subscription` |

**Use the API key** for unattended / high-volume / Actions runs where you don't
want the worker to pause when a credit runs out. **Use the subscription** to run
on the Claude plan you already pay for, accepting that the worker idles once the
monthly Agent SDK credit is spent.

> **Never set both.** If `ANTHROPIC_API_KEY` is present it takes precedence over
> `CLAUDE_CODE_OAUTH_TOKEN`, silently forcing pay-per-token billing even when you
> meant to use the subscription.

For a cron / manual worker, export the chosen var in the worker's environment
(a box already logged in via `claude login` can rely on its stored subscription
session, but an explicit `CLAUDE_CODE_OAUTH_TOKEN` survives session expiry and
won't break an unattended loop). For Actions, `verity install --actions
[--auth subscription]` wires the right secret into the generated workflow.

## Bot-account setup

Run the worker as a **dedicated machine user**, never as yourself:

1. Create a separate GitHub account (e.g. `yourorg-verity-bot`) and give it write
   access to the repo.
2. Mint a token for that account and export it as `GH_TOKEN` for the worker only.
3. List every human in `.verity/autonomy.yml` `humans:`. The worker refuses to
   start (exit 30 `bot-is-human`) if its token's login matches a listed human —
   this is what keeps bot actions attributable and stops the worker from
   treating a human's actions as its own (and vice versa: requests authored by
   the bot are never self-planned).
4. Add the bot to `notify.mention`? No — mention humans there; the bot is the
   one doing the mentioning.

## Self-authored requests are skipped (single-account setups)

The scanner's P4 tier **never picks up a `verity:request` authored by the bot
login itself** — the no-self-feeding rule. It exists because a worker that can
file requests and then work them has closed the loop the tiers are built to
keep open: it would be feeding itself work, which is exactly the runaway the
priority ladder and human-authored intake are there to prevent. The rule is
load-bearing and has no bypass knob.

The practical consequence bites in a **single-account setup** (you run the
worker under your own login instead of a bot account): every request you file
is, as far as GitHub is concerned, authored by the bot — so every request is
filtered, and the tick ends idle. Since stage 28 the worker says so instead of
staying silent: the tick prints
`verity-worker: note: skipped N self-authored request(s) (no self-feeding; see docs)`
on stderr, and an idle tick reads
`idle — no eligible work — skipped N self-authored request(s) …` rather than a
bare "no eligible work". Diagnostics only — the skipped issues are never
commented on.

If you see that note, you have three supported paths:

- **Use a second account** — the [bot-account setup](#bot-account-setup) above.
  Requests you file from your human account are then eligible; the worker's
  own login stays filtered, as designed.
- **Hand-seed stages instead of requests** — `verity stage new "<title>"`
  (what the canary runs did). Stage files need no author at all: the P5
  dependency engine picks them up regardless of login.
- **Let `verity init` file the request** — a request `verity init` filed is
  listed in `.verity/intake.json` and is eligible under the same login
  ([operator-init contract](../contracts/operator-init.md), ADR-0038). That
  committed intake register is the only exception to the rule: the scanner
  keeps a bot-authored `verity:request` only when its number is listed in the
  register **committed on the default branch** (`origin/HEAD`), never a
  working-tree copy. `origin/HEAD` must be a symbolic ref into
  `refs/remotes/origin/` (what `git clone`, `git remote set-head` and
  `verity init` write); one that points at a local branch, or is not symbolic,
  trusts nothing and prints one warning. Listing a number means landing an edit
  to `.verity/**` on the default branch — a forced protected path that gates
  for a human at trust 0 and 1 — so, provided the local ref store is intact, a
  role cannot enrol its own request. A role able to write `.git/` directly is
  outside this guarantee, as it already is for hooks. When an entry is accepted
  the note carries both counts:
  `skipped N self-authored request(s), accepted M engine-registered (see docs/autonomy.md)`.
  A register that cannot be read, or fails its schema, trusts nothing and
  prints one warning. A project without a register behaves exactly as before.

There is still no bypass knob: no policy key trusts bot-authored requests in
general; only the enumerated, committed register entries are eligible.

`verity operator snapshot` shows pending intake: `queue.requests_pending` and
`queue.requests_parked` count OPEN `verity:request` items (split on
`verity:needs-human`; `null` when GitHub was not observed), and when no stage
has a next action but a request is pending, `next` is the worker's own P4 step,
`plan` on the lowest-numbered pending request (the human render reads
`waiting to be planned (N request(s) pending)`). The counts are as labelled:
they do not re-apply the self-authored filter above.

### Spec-soundness gate (stage 115, ADR-0038 D4)

Before it decomposes a request `verity init` filed, the plan role judges
whether the spec is buildable: goal, users, core flows, the data kept,
constraints, and what "done" looks like. An architecture the spec does not
imply is a gap, never a decision the role makes for you. When the spec is not
buildable the role writes no stage file and reports
`{"verity":1,"outcome":"gated","gate":"spec-unsound","reason":"<one gap per line>"}`.

**What parks.** The worker labels the request `verity:needs-human`, not
`verity:awaiting-approval`: approving would only run the same plan on the same
spec. `verity:request` stays on, no strike is counted (the park also resets
the no-progress count), and the engine commits nothing for that run. Any other
gated result, and a sound spec, go exactly the way they went before.

**What the comment looks like** (github):

```
⏸️ **verity-worker** `<run-id>` — paused at human gate `spec-unsound`
pending: request #<n> — the plan role judged the spec not buildable as written; …

## Spec gaps
- no data model for orders
- success criterion missing

amend `docs/spec.md`, then `verity operator act clear-needs-human <n>` — the next tick re-plans
```

Each gap is passed through the secret redactor before it is posted. On the
local substrate there is no comment: the park is the record's label (its
commit subject ends `(spec-unsound)`) and the gaps are printed to the run log.
The run's usage rows carry gate `spec-unsound`.

**How to resume.** Amend the spec, then clear the park
(`verity operator act clear-needs-human <n>`, or the Console's clear control).
The next tick selects the request again and plans it. A sound spec goes straight
to the thin first slice (Mode A).
`verity operator gates` lists the park as a `spec-unsound` gate with
`allowed_actions: ["clear-needs-human"]` and the gaps in `gaps[]` (`[]` on
local), and `snapshot.queue.requests_parked` counts it.

## Usage & cost tracking

Every run appends one row **per role invocation** to the usage ledger
(`<git-dir>/verity/usage.csv`, or `.verity/usage.csv` outside git; see below)
(`timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate,provider,model`),
all rows of a run sharing its `run_id`. `gate` is the human gate the *run* ended paused at, if any — the
same value on every row of the run; it is how the startup breaker can tell an
unknown-cost run that already asked a human (parked at the `unknown-cost`
gate) from unknown spend that slipped through ungated. Pre-existing ledgers
keep working: the schema evolves additively-only, so old 9-column rows (one
per run, no `tool_calls`/`role`), 11-column rows (no `gate`) and 12-column rows
(no `provider`/`model`) parse and roll up alongside new ones without migration.
`provider`/`model` record which agent produced each row (provenance only —
never summed); an unknown value, including a null model, reads as empty.
Inspect with:

```bash
verity usage --days 7            # runs, tokens, est USD, tool calls, outcomes histogram
verity usage --days 7 --json
verity usage --days 7 --by-role  # adds per-role totals (tokens, est USD, tool calls)
```

**The ledger is runtime state, never committed** (since 1.6, stage 108,
ADR-0036). Inside a git repository the ledger lives in the git directory, at
`<git-dir>/verity/usage.csv` (usually `.git/verity/usage.csv`). Checkout, merge,
reset, clean and stash never touch the git directory, so every branch the worker
checks out sees the same rows. Each `git worktree add` checkout has its own git
directory and so its own ledger. Outside a git repository the ledger is
`.verity/usage.csv` in the working directory, as before. `verity usage --json`
reports the file in use as `path`. Every reader resolves the same file: the daily
breakers, `verity operator usage|runs|snapshot`, the console and the benchmark
scorecard. The scaffold `.gitignore` still ignores `.verity/usage.csv`, so a
stray copy in the tree is never committed.

Older versions wrote `.verity/usage.csv` in the working tree and committed each
run's rows (`chore(verity): usage <run-id>`) on the stage branch the run had just
built on. The next stage branch, forked from the merged default branch, did not
have that commit, so the rows vanished from the file. The policy key
`commit_usage` is still accepted so older policies load, but it is ignored, and
setting it to `true` prints one warning. The ledger is per checkout: a fresh
clone starts empty.

On its first run in a repository from before 1.6, the worker seeds the new
ledger once. It merges the old `.verity/usage.csv` and the rows of every old
`chore(verity): usage` commit into it, and logs `seeded ledger: N rows`. This
only reads git: the worker makes no commit and writes nothing in the working
tree. If the tree still tracks `.verity/usage.csv`, the worker prints one warning
naming `verity usage untrack`. Two verbs are available to the operator:

```bash
verity usage untrack [--json]   # stop tracking the stale in-tree file: one commit (.gitignore + removal); no-op if already untracked
verity usage recover [--json]   # merge the in-tree file and every old `chore(verity): usage` commit into the live ledger
```

`untrack` is for the operator; the worker never runs it. It makes one commit,
authored by the bot identity, that adds the ignore line to `.gitignore` and
removes `.verity/usage.csv` from git. The file on disk is kept. Ship it the way
you ship any other change (for example, on a branch through a reviewed PR). The
commit is built from `HEAD`'s `.gitignore` plus the ignore line, so unrelated
`.gitignore` edits you have not committed are never included, and no git hooks
run. Your working `.gitignore` is refreshed only if you had not changed it. It
refuses, with `ok: false` and exit 1, while a merge, cherry-pick, revert,
rebase, cherry-pick/revert sequence (`sequencer/`) or bisect (`BISECT_LOG`) is
in progress. Until the change is merged, the tracked file is stale
history: nothing writes to it and only `recover` reads it.

`recover` writes only the live ledger and never changes the in-tree file. It
writes a temporary file beside the ledger and renames it into place. Just
before the rename it reads the live ledger again and keeps any row a worker
appended in the meantime, and a `recover` killed mid-write leaves the previous
ledger intact. It
reports `path`, `commits_scanned`, `tree_rows` (rows in the in-tree file),
`rows_before`, `rows_added` and `rows_after`. A second run adds nothing. A
commit whose ledger cannot be read is skipped and counted (`commits_skipped`),
and so is a malformed row (`rows_skipped`). `verity doctor` shows a warning row
while `.verity/usage.csv` is still tracked.

**Honest-measurement note:** this telemetry covers **headless runs only** —
role invocations that pass through `verity agent-exec` (i.e. the worker).
Interactive slash-command sessions (`/verity:build` etc. in a live Claude Code
session) never touch agent-exec, so their tokens and tool calls are not
measured here; measuring them is a host-side concern. Read exit-gate numbers
accordingly.

The worker reads the same ledger at startup: if today's totals already exceed
`limits.max_usd_per_day` or `limits.max_runs_per_day`, it refuses to start
(exit 30 `daily-limit`) until the UTC day rolls over.

**A ledger that cannot be located is a refusal, never an empty ledger** (stage
112). The in-tree fallback (`.verity/usage.csv`) is used only when git says the
directory is **not a git repository**, or when no `.git` exists anywhere above
it. Any other git failure inside a repository throws instead of falling back:
a `safe.directory` "detected dubious ownership" refusal (cron or a console
running as another user, containers), a malformed config, a timeout, or a
missing `git` binary. Falling back there would make that process read a stale
or empty file while every other process uses the git-dir ledger, and the daily
breaker would under-read. Instead:

- the worker refuses the run before the daily-limit check, before any GitHub
  call and before any dispatch: `verity-worker: 30 ledger-path: cannot locate
  the usage ledger: …`, naming git's error;
- `verity usage`, `verity usage recover`, `verity usage untrack`,
  `verity operator runs|run|usage` fail with a non-zero exit and the same message;
- `verity operator snapshot` reports the ledger-derived fields as `null`
  (unknown), as it already does for an unreadable ledger.

Fix the git error (for dubious ownership: `git config --global --add
safe.directory <repo>` for the user the worker runs as) and run again. `est_usd` is **verified**
spend — runs whose cost the runtime never reported are counted separately as
`unknown_cost_runs` and never summed as $0 (see [Limits](#limits)).

## Limits

Per-run and per-day circuit breakers, all in `.verity/autonomy.yml` (defaults
shown):

```yaml
limits:
  max_chained_roles: 6        # roles chained within one tick
  max_tokens_per_run: 2000000
  max_wall_clock_min: 45      # also sets the lock TTL (×1.5)
  max_runs_per_day: 24
  max_usd_per_day: 25.00
  unknown_cost_behavior: gate # gate | allow_with_token_limit | fail
  # unverified_ci_behavior: gate   # gate (default, omit it) | allow_without_merge
```

A tripped per-run limit ends the tick with outcome `limit_hit` (exit 0, summary
posted); the remaining work simply waits for the next wake-up. Failures follow a
2-strike rule: the first failure retries next tick, the second labels the item
`verity:needs-human` and the worker skips it until a human clears the label.

**No progress is its own limit.** `verity next` is re-derived from GitHub every
iteration, so a state that never changes yields the same decision forever. If
the worker is about to dispatch the **same role at the same target** for the
third time in a row — counted across ticks from its own run-summary comments on
the item, plus within the current tick — it refuses *before* spending the model
run, labels the item `verity:needs-human`, and exits 20 with a summary saying
`no progress: …`. Two identical dispatches are still allowed, so a role keeps
its retry. Clear the label once you have fixed whatever was not advancing.

**Unknown cost is not $0** (ADR-0008). Some runtimes — Codex in particular —
report token usage but no dollar figure, so their ledger rows carry an *empty*
`est_usd` cell. That cell is never summed as zero: `verity usage` reports the
verified spend plus a count of unverifiable runs, and the daily budget breaker
refuses to certify a total it knows is incomplete. `unknown_cost_behavior`
decides what that costs you when `max_usd_per_day` is set and today's ledger
holds unknown-cost runs:

| value | effect on the budget breaker |
|---|---|
| `gate` *(default)* | the worker refuses to start — exit 30 `unknown-cost-budget` — because the ceiling cannot be checked; **approvable** when every unverifiable run ended parked at the `unknown-cost` gate (see below) |
| `fail` | same refusal (the value governs in-run handling; an unverifiable budget is never waved through, and `fail` has no approval mechanism) |
| `allow_with_token_limit` | the worker starts and logs that the USD breaker is **inert by consent** — you have accepted the token ceilings as the bound |

**Approving the `unknown-cost` gate actually resumes the run.** Under `gate`,
a run whose cost comes back unknown pauses at the `unknown-cost` gate and its
comment tells you how to approve. That approval is exactly the per-run human
decision ADR-0008 prices the knob at, so the startup breaker does not outrank
it: when *every* unverifiable run in today's ledger ended parked at that gate,
the refusal is deferred past the scan, and a pending single-use
`verity:approved` lets **that one run** proceed — the consumption is named in
the run's summary (`budget:` line), and the next unverifiable run gates again.
No approval pending (or any unknown-cost spend that never gated) and the
worker refuses exactly as before, before taking any lock or writing any label.

Genuine overspend is still reported as overspend: if the *verified* portion of
today's spend already meets `max_usd_per_day`, that is a plain `daily-limit`
trip regardless of this knob — no approval masks it.

**Every GitHub and git call has a deadline.** `max_wall_clock_min` is checked
*between* role dispatches, so it cannot interrupt a call that never returns —
on a lost network that used to mean a worker alive for hours with nothing to
show. Since 1.6 every `gh`/`git` subprocess on the worker path is killed
(SIGTERM) at a fixed deadline, and git never prompts (`GIT_TERMINAL_PROMPT=0`):

| call | deadline | on timeout |
|---|---|---|
| `gh` reads and label adds/removes | 60 s per attempt | retried like any transient failure (below), then fails loud |
| `gh` writes that are not idempotent (comments, lock/unlock lines, issue and PR creates, merges) | 60 s per attempt | **never retried** — the write may have landed; resolved as described below (stage 112) |
| `git fetch` / `pull` / `push` / `clone` / `ls-remote` | 5 min | `ok:false`, reason `timeout` — the same fail-closed refusal a failed push gets |
| every other `git` (status, commit, checkout, rev-parse…) | 60 s | as above |

The `gh` layer retries **transient** failures up to 3 times with jittered
backoff: HTTP 5xx, a secondary rate limit, a call killed at its deadline
(`timeout`), and a **network-level error** (`network` — `network is
unreachable`, `dial tcp`, `no such host`, `i/o timeout`, `EAI_AGAIN`,
`connection refused/reset`, `TLS handshake timeout`, `could not resolve host`).
A 5-second blip therefore costs one backoff, not the tick; a real outage costs
at most four bounded attempts before the tick ends as `infra` and the error
names the class. HTTP 4xx and everything else still fail fast. Set
`VERITY_GH_LOG=1` to get one `verity:gh status=… reason=…` line per attempt on
stderr (the benchmark harness turns it on for every tick). The status reads
behind `verity state`/`operator snapshot` are bounded the same way; a read that
times out is reported as `network` under [Unreadable state](#unreadable-state).

**A timeout never duplicates a write** (stage 112). A write that timed out may
still have reached GitHub, so retrying it can apply it twice: a doubled run
summary used to read as two runs to the no-progress breaker, and a retried merge
that had landed was reported as a failed merge. The retry policy therefore
depends on whether the call is idempotent:

| failure | idempotent call (reads, label add/remove, label edit) | non-idempotent write (comment, lock line, issue/PR/release create, merge) |
|---|---|---|
| **pre-connect**: `network is unreachable`, `no such host`, `EAI_AGAIN`, `could not resolve host`, `connection refused`, secondary rate limit | retried | retried (the request never reached GitHub) |
| **ambiguous**: killed at the deadline (`timeout`), `i/o timeout`, `connection reset`, `TLS handshake timeout`, HTTP 5xx | retried | **not retried**: fails at once with `ambiguous: true` |

What each write does after an ambiguous failure:

- **Merge** (`trust.merge`, every worker merge path): re-reads
  `gh pr view --json state,mergedAt,mergeCommit` (plus `headRefOid` for a
  head-pinned merge). If GitHub reports the PR `MERGED` (at the pinned head,
  when pinned), the merge counts as done and the run log says it was
  `confirmed by gh pr view`. Otherwise the original error stands. The merge is
  never issued a second time.
- **Lock acquire**: re-reads the lock trail. If our exact `lock:<run-id>` line is
  there, the lock is held; otherwise the original error stands.
- **PR create**: runs `gh pr list --head <branch>`. GitHub allows one open PR per
  branch, so a PR found there is adopted.
- **Issue create** (work-item reconcile): there is no safe key to read it back,
  so the stage's create fails loudly (`work-item-reconcile-failed … may exist;
  not re-created`). The next reconcile lists the issue if it did land.
- **Run summary, findings comment**: best effort as before. One stderr warning,
  no retry.
- **Unlock line**: reported like any failed unlock and never re-posted (a
  doubled `outcome:failed` line would count as two strikes).

The no-progress breaker also counts **distinct runs** (run id plus roles), not
comment copies, so a duplicated summary from any cause cannot trip
`MAX_REPEAT_DISPATCHES`. The interactive `verity review merge` has never
retried its merge: a timeout there is reported as a failed merge, so check the
PR on GitHub before you run it again.

## Unverified CI

**"No CI" is not "CI red."** A pull request's check rollup has three readings,
not two:

| reading | what Verity saw | what it means |
|---|---|---|
| **green** | checks reported, all acceptable | verified green — the only state that may merge |
| **red** | checks reported, at least one failing or pending | verified not-green |
| **unknown** | **no checks reported at all** | Verity cannot verify this PR *in either direction* |

Before this was distinguished, `unknown` was reported as red. On a repository
with no CI configured, that meant a stage could never leave `building`, so every
tick answered it with `role: build` and spent a full model run getting nowhere —
`test` and `review` were unreachable (issue #50, observed on the 2026-07-31
canary).

**Unknown is never treated as green.** Reading an empty check set as green would
be strictly worse than the bug it replaced, because the worker would then merge
on CI that nobody ever ran. Every consumer of the reading decides explicitly:

| call site | what it does with `unknown` |
|---|---|
| `ledger.rollupState()` | *produces* the three states; the boolean `rollupGreen()` is `=== green`, so unknown collapses to not-green |
| `ledger.deriveStatus()` | folds unknown in with red — the stage vocabulary has no word for "unverifiable", and it must not read `in-review` |
| `next.decide()` | **gates** at `ci:unverified` (or, under the knob below, advances to `review`) — this is where a model run would be spent, so this is where the third state is spent |
| `trust.checksGreen()` / `trust.decideMerge()` | not green → never merges. Deliberately still a boolean: the *only* question a merge gate may ask is "did Verity verify this is green?" |
| `review.canMerge()` / `verity review merge` | refuses, with a diagnostic naming the missing CI instead of a phantom failing check |
| `verity-worker` | takes the ordinary GATE_PAUSE path — label, comment, `⏸️ gated` summary — so the pause is visible in the run's outcome and in `verity next` |

So on a repository with no CI the chain runs `plan → build`, opens the PR, and
then **stops for a human** at gate `ci:unverified`: Verity cannot claim the
stage is green, so it does not pretend either way. Approving the gate
(`verity:approved`) consents for that one run — the stage advances to
`review`, and the merge itself is still gated, because merging
requires a *verified* green reading that an unchecked PR can never produce.

### Registration grace (a just-opened PR is not a no-CI repo)

An empty check rollup has **two** indistinguishable causes: (a) the repository
has no CI configured — the genuine "cannot verify" case the gate is for — and
(b) GitHub has **not yet registered** the checks for a *just-opened* PR (a race
of a few seconds to tens of seconds between opening the PR and Actions reporting
its check runs). A fast worker hits (b) routinely: it evaluates `verity next`
seconds after opening the PR, sees the empty rollup, gates `ci:unverified`, and
parks a perfectly healthy stage for a human — CI goes green moments later but the
stage never reaches review (issue #192; confirmed live 2026-08-11 on Codex
fixture D — checks started 7–18s *after* the evaluation).

So `next.decide` applies a bounded **CI-registration grace**
(`CI_REGISTRATION_GRACE`, default 90s) *at the gate decision only* — **not** to
the CI-green model. When a PR that would gate `ci:unverified` was opened within
the grace (its `createdAt`, stamped by `ledger.fetchSnapshot`, is younger than
the window), the stage reports **`waiting_for_ci`** instead: a non-terminal
"CI in flight" status — no `awaiting-approval` label, no human park, no model
run. The next evaluation re-reads the now-registered checks. Once the PR is
**older** than the grace with a **still-empty** rollup, it becomes the genuine
`ci:unverified` gate exactly as before — the no-CI case is preserved, merely
delayed by the grace.

The grace **defers the gate; it never advances a stage to review or merge.**
`waiting_for_ci` is not green, so review/merge still require a verified-green
rollup — `rollupState`/`ciStateOf` are unchanged (empty ⇒ unknown ⇒ never
green). It is **fail-closed**: a PR with no `createdAt` (an old or injected
snapshot) gates exactly as today — "no timestamp" is never read as "recent".
The clock is injected (`opts.now`, defaulted to `Date.now()` only at the
outermost caller), so the decision stays pure and deterministic in tests. The
benchmark drive loop treats `waiting_for_ci` as "keep driving" and takes a small
bounded wait between such ticks so it does not spin its tick budget while CI
registers.

If your repository legitimately has no CI and you do not want that pause every
time, opt in explicitly:

```yaml
limits:
  unverified_ci_behavior: allow_without_merge
```

| value | effect |
|---|---|
| *absent* / `gate` *(default)* | pause at the `ci:unverified` human gate |
| `allow_without_merge` | let the stage advance to `review` instead of looping on `build` |

The knob is **default-closed** — absence, and any value other than the exact
opt-in, gates. Neither value can merge on unverified CI.

## Unreadable state

**"We could not look" is not "there is nothing there."** Verity derives every
stage's status by correlating local stage specs with GitHub issues and PRs. When
that read fails, there is no honest answer to give.

Before this was distinguished, the ledger swallowed the failure whole — `gh`'s
stderr was discarded outright — and every unread list became an empty one. So an
unreachable GitHub produced a *confident falsehood*:

```
$ verity state stage 1                                   # gh working
{ "status": "building", "issue": 1, "pr": 2 }

$ PATH=<gh that exits 1> verity state stage 1
{ "status": "planned", "issue": null, "pr": null }       exit 0, stderr empty
```

That is worse than a failure, because every consumer believes it. On the
2026-07-31 canary the `review` role was told "no PR or linked issue exists"
while PR #2 was open: it could not review, failed twice, and burned a
no-progress strike — the root cause of that run's chain stall (issue #60).

**The snapshot now records whether it was observed.** `fetchSnapshot()` stamps
`verified`, and lists a `{ source, reason, detail }` for every read that failed;
a read that failed is `null`, never `[]`. **A partial answer counts as
unverified** — issues without PRs derives a stage that has "no PR", which is the
same falsehood in half.

| call site | what it does with an unverified snapshot |
|---|---|
| `verity state` (`view`/`next`/`stage`/`summary`/`graph`) | **refuses** — exit 30, nothing on stdout, the reason on stderr. This is the boundary a human and a role read, and there is no partial answer here a caller cannot misread; emitting an object at all is the invitation |
| `next.decide()` / `verity next` | **gates** at `state:unverified` (exit 10), checked before every other reading. Deliberately not `idle`: idle asserts Verity looked and found no work |
| `verity-worker` run loop | stops as `infra` (exit 30) **before dispatching** — a wasted model run against a state nobody verified is strictly worse than a clear stop. Not the GATE_PAUSE path: labeling and commenting would write to the very API that just failed |
| `verity-worker` startup | when the scan selects nothing, refuses with slug `state-unverified` (exit 30) rather than reporting `idle` — on a cron worker, an idle exit 0 reads as "all quiet" |
| `scanner` P5 | yields no item (only an `action: work` decision does), so nothing is locked or labeled |
| `ledger.project()` | derives, unchanged — it is the pure derive layer and its shape is byte-frozen by `verity state view`. Callers that turn a projection into an *answer* gate on `ledger.snapshotVerified()` first |
| `ledger.deriveStatus()`, `release`, `review`, `trust` | untouched. `release` reads git tags only; the merge gates run their own `gh` calls and already fail closed on any error |

There is **no opt-out knob.** `limits.unverified_ci_behavior` is a judgement
about a repository that legitimately has no CI; it is not a licence to dispatch
against a state nobody observed, and it cannot turn one into work.

**The diagnostic survives, the credential does not.** The failure reason is
classified into terms you can act on — `auth`, `network`, `rate-limit`,
`no-repo`, `gh-not-installed`, `no-target-dir` (the `--cwd` you named does not
exist — indistinguishable from a missing `gh` at the syscall, and only one of
them means "reinstall gh"), `http-<code>` — and the first line of `gh`'s
stderr travels with it, redacted: GitHub token shapes (`ghp_`/`gho_`/`ghu_`/
`ghs_`/`ghr_`, `github_pat_`, classic 40-hex) and anything following an
`Authorization`/`Bearer`/`token` keyword are replaced before the text is ever
printed, logged, or posted to a comment.

An injected snapshot (tests, embedders) carries no `verified` field and reads as
verified — the same rule `ciStateOf()` applies to the legacy CI boolean, so an
old-shaped snapshot can never manufacture the new state and no existing consumer
changes behavior.

## Contained roles: Verity talks to GitHub

**A role computes; Verity talks to GitHub** (ADR-0013, extending ADR-0012's
"the model edits files; Verity performs git"). The tier-1 sandbox denies a
codex role all network access by construction — that is the point of
containment (ADR-0011), and it is never widened — so a contained role can
neither run `verity state`/`gh` to read GitHub nor `gh pr comment` to write it.
The canary §4 re-run proved both halves fatal: review's own comment died on the
network, and build's first act was a (correctly) fail-closed state read.

**Reads move before the dispatch.** For a codex dispatch the worker asks
`verity next` to attach the facts the role's workflow needs — stage status,
the unblocked `next` list, dependency statuses, the PR and its three-state CI
reading — derived from the *same verified snapshot* the dispatch decision came
from, so the fail-closed rules above stay binding: an unverified snapshot
gates, and a gate dispatches nobody. The facts travel to `agent-exec` as
`--state-snapshot` and render into the prompt as the `verityPerformsGitHub`
preamble ("GitHub is Verity's job on this run") plus a
`<github-state-snapshot>` block. Snapshots are point-in-time: the role acts on
state as of dispatch, and the worker's post-run deterministic checks (trust
ladder, CI verification) remain the guard against staleness.

**Writes move after the result.** The T05 marker's `artifacts` gains one
additive, **default-closed** channel: `"effects"`. Absent field = nothing
performed. Recognized today: `findings_comment` — the review findings body the
role would have posted with `gh pr comment`; the worker posts it on the PR,
attributed to the run (`🔎 verity-worker <run-id> — … posted by Verity on the
role's behalf`). An effect the worker does not recognize is **ignored with a
logged note — never executed, never guessed at, never fatal**. Merge authority
is not an effect and never will be: the trust ladder stays the only merge path.

**Intent artifacts are committed after the result** (ADR-0033, #189 — the
file-side sibling of the ADR-0026 work-item reconcile). `plan` and `revisit`
are `git_write: false` by contract, so nothing ever committed what they wrote:
plan's `stage-instructions/`, `contracts/`, `feature-assessments/`,
`docs/adr/` and revisit's `docs/revisit/` stayed dirty and unpushed on both
providers and both substrates. With `agent.commit_intent_artifacts: true`
(default **off**; per-role override under `agent.roles`), the worker passes
`--commit-intent-artifacts` on the roles it dispatches (`plan`; the worker
never dispatches `revisit`, whose engine commit is reachable only by a direct
`verity agent-exec revisit --commit-intent-artifacts`) and, after the role
returns with `success` or `failed` — never on a timeout — the **engine** stages
only those engine-owned roots (`git add --ignore-removal`, never deletions,
never paths outside them), commits under the `verity-worker` identity, and
pushes to the substrate's `origin` (the local bare origin on
`substrate: local`). It commits only on the default branch: a checkout parked
elsewhere, or a detached HEAD, is refused and reported, never committed.
Nothing new under the roots is a no-op, never an empty commit. A commit or
push failure leaves the run's outcome unchanged, prints one
`intent-artifacts-commit-failed` / `intent-artifacts-push-failed` stderr line,
and is recorded on the result's optional `intent_artifacts` field. The step
runs after the invariants verdict and before the work-item reconcile, so
`[stage N]` issues reference tracked files and the engine's own ref movement is
never read as a role violation. Interactive `/verity:plan` and
`/verity:revisit` runs are unchanged — a human commits by hand, as now.

Claude (uncontained) dispatches are unaffected — the flag is rejected for the
claude driver rather than silently ignored, its prompts render byte-identically,
and its harness keeps performing its own GitHub reads.

## Local substrate gates (`.verity/gates.json`)

> Stage 82 (ADR-0029 §4). **Dark today:** the worker still refuses
> `substrate: local` at startup (the stage-79 seam's fail-closed placeholder);
> the runner, the record format, and the scaffolded CI consumption below are
> live as engine surface and land fully when the local substrate flips on.

On the **local delivery substrate** (`substrate: local` in
`.verity/autonomy.yml`, ADR-0029) there is no GitHub CI to answer "is this
branch green?". The answer comes instead from a **committed, single-source
gate definition** executed by the engine:

```json
{
  "schema": 1,
  "gates": [
    { "name": "test", "command": "npm test" },
    { "name": "lint", "command": "npx biome ci ." }
  ]
}
```

- **Location:** `.verity/gates.json`, committed to the repo.
- **Ordered:** gates run top to bottom and **stop at the first failure** —
  gates that never ran are simply absent from the run's record (the record is
  red anyway via its nonzero entry).
- **Exit-code judged only** (the ADR-0028 test-honesty invariant): each
  command runs with inherited stdio — output is never piped, never parsed. A
  gate that prints `PASS` and exits 1 is a **failure**.
- **Absent ⇒ UNKNOWN, never green:** no definition, an unreadable one, or an
  empty gate list refuses the run and writes **no record** — the branch reads
  `ci:unverified` and gates, exactly as an unchecked PR does today. There is
  no default gate list.

`verity gates run [--branch <branch>]` executes the definition **committed at
the branch head** and writes the SHA-pinned gate-run record
`.verity/gate-runs/<branch-slug>.json` (contract `local-work-item` v1) that
the local snapshot driver reads. The record claims exactly the head the gates
ran against: a dirty working tree, a head that moves mid-run, or gates that
modify tracked files all **refuse the record** (fail closed), and a record
whose `sha` no longer equals the branch head reads UNKNOWN — staleness is
detectable by SHA alone. The record is committed on the default branch (never
on the branch it judges, which would immediately stale it). On the local
substrate the worker runs this automatically after a build role completes a
stage branch — where the GitHub path would wait on CI checks.

`verity gates run --no-record` runs the working tree's definition where the
checkout stands and reports by exit code only (no record) — this is what CI
does: the **scaffolded workflow's `gates` job executes the same definition**
via the committed `.verity/run-gates.cjs`, so graduation-day CI replays the
commands that were green locally, and "tests exist but CI never runs them"
(the issue-#203 defect class) is impossible by construction. With no
definition the job **fails loudly with instructions** — never a silently
green empty job.
