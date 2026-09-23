---
name: verity:revisit
description: Revisit — come back to any project after time away: report where it stands, re-audit prior decisions against today's models, and propose a refreshed backlog. Read-only; hands proposals to the plan role.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - Task
---
<objective>
Run the Revisit audit: the one command for "I'm back — where does this stand, what
is next, and what should be done better now that models are better than the one
that built it." It works on any repository, in one of two modes picked by a single
probe — `verity identity get`:

- **Verity mode** (`.verity/identity.json` present): orient from the spine (state,
  status, stages, contracts, ADRs, handoffs, golive, doctor, GitHub), then re-audit
  every prior decision as a claim to re-verify.
- **Adoption mode** (no identity manifest): the proposal-only projection of the
  Retrofit Planner (ADR-0032) — analyze the codebase, derive identity *candidates*,
  list contract candidates and the missing spine, and emit a hardening-first backlog.
  It locks nothing, freezes nothing, scaffolds nothing.

The role's ONLY output is one dated report: `docs/revisit/<YYYY-MM-DD>-revisit.md`.
It never writes `stage-instructions/` (plan), `contracts/` (architect), `STATUS.md`
(ship), `.verity/identity.json` (vision), or project code (build). Proposals are
handed to `/verity:plan` — the only place stages are born.
</objective>

<rules>
- A prior model's decision is a claim, not a fact. Verify against source.
- If you cannot verify, say `unverified` and why. Never fill a gap with a
  plausible answer.
- Do not run `verity map`, `verity stage new`, `verity contract new`,
  `verity adr new`, `verity identity lock`, or `verity scaffold`. Those belong to
  other roles; name the role instead.
- Delegate bulk reading (the source sweep, the codebase analysis) to a sub-agent
  and take back a summary; keep the verdicts and the report in this loop.
</rules>

<process>
1. **Probe the mode.**
   ```bash
   verity identity get
   ```
   Success → Verity mode. The "no identity manifest" error → Adoption mode. Any
   other error → stop and report it; do not guess a mode.

2. **Verity mode — where it stands.** Run and read (all JSON):
   ```bash
   verity state; verity next; verity status; verity stage list
   verity contract list; verity adr list; verity handoff list
   verity golive; verity doctor
   git log --oneline -30; git status --short
   gh issue list --state open; gh pr list --state open; gh release list --limit 5   # when gh is available
   ```
   Read `STATUS.md`, `README.md`, the head of `CHANGELOG.md`, and
   `docs/handoff/README.md`. Write the **Standing** section: release and runtime
   truth; stages by status (merged / in-PR / spec-only) and the last three merged;
   open issues and PRs with age; unmet golive items; doctor failures.
   **Every `verity state` refusal is reported as "unverified: <reason>", never as
   empty** — `state` fails closed offline (ADR-0029), and `verity next` returning
   `gate: "state:unverified"` means "could not check", not "no open work".

3. **Verity mode — re-audit.** Treat each prior decision as a claim. Build a
   claim/reality table with one row per:
   - ADR — still true? superseded in code?
   - frozen contract — has any consumer drifted from it?
   - the golive manual list — which "fine for now" items were never closed?
   - test honesty — skipped / `.only` / pending tests, tests that assert nothing,
     CI config vs. what `npm test` actually runs;
   - dependency drift — `npm outdated`, `npm audit` when allowed; otherwise
     "not checked";
   - docs rot — README claims vs. source.
   Delegate the source sweep to a sub-agent; keep the verdicts.

4. **Adoption mode — analysis.** Delegate a structure / stack / topology sweep.
   Derive **identity candidates** (`name`, `slug`, `owner`, `image_prefix`) from
   `package.json`, the git remote, and CI, and **flag inconsistencies** (casing
   splits, owner-vs-remote mismatch, partial renames). List **contract candidates**
   (the implicit wire / schema / auth seams). List the **missing spine**: hygiene
   CI, test CI, issue templates, `STATUS.md`, `docs/handoff/`, CODEOWNERS,
   `.verity/`. Identify what "green in a clean CI-like env" would require
   (ephemeral DB, migrate-from-zero, lint, secret scan).

5. **Proposals.** In both modes, emit a numbered list. Each proposal carries:
   title; type (`feature|bug|chore`); why now (one sentence, evidence-linked to
   the table); size (S/M/L); depends-on (other proposals). Order: hardening first.
   **Adoption mode's proposal 1 is always "First green on legacy code (blocking
   gate)"** and every other adoption proposal depends on it. Never more than
   twelve proposals; roll the rest into a "later" list.

6. **Write the report** to `docs/revisit/<YYYY-MM-DD>-revisit.md` — create the
   directory; never overwrite a same-day report (suffix `-2`, `-3`, …). Reports
   are dated and never edited in place: the newest one is the one that matters,
   older ones are history. Fixed sections, in this order:
   - `# Revisit — <project> — <date>`
   - `## Mode`
   - `## Standing` (Verity mode) or `## Analysis` (Adoption mode)
   - `## Claim / reality`
   - `## Proposals`
   - `## Later`
   - `## Unverified` — everything the role could not check and why
   - `## Handoff`

7. **Handoff.** Print the report path and the next command.
   - Verity mode: `/verity:plan` with proposal N.
   - Adoption mode: `/verity:vision` (lock the identity from the candidates) →
     `/verity:architect` (freeze the contract candidates) → `/verity:plan`
     (proposal 1 first).
   Say explicitly that the role changed nothing else. In headless runs the engine
   commits your report after you return (ADR-0033); interactively, commit it yourself.
</process>
