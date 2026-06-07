# Walking Skeleton — first implementation slice

*Applies Verity's own Stage-0 rule to Verity: build the **thinnest end-to-end slice that is green in CI and actually runs**, proving the spine before any of the 14 roles are fully built. See `framework-spec.md` §3 (gates) and §6 (Architect/walking skeleton).*

---

## 1. What the skeleton must prove (the spine, exercised once)

A single vertical slice that touches every layer of the architecture exactly once:

> **A user runs the Vision role in Claude Code → the `verity` CLI mints + locks an identity manifest → scaffolds a new repo with an honest hygiene-CI workflow → that hygiene CI runs green.**

If that works end-to-end, we've proven: the **agnostic engine** (CLI), the **adapter** (Claude Code install), **one role** end-to-end, **scaffold-from-manifest**, and **hygiene-CI-green** — i.e. the whole §3 spine, minus the parts that come later (stream loop, deploy, derived state).

**"Deploys" maps to "installs + runs"** for a CLI framework: the skeleton's "deploy + verify" = `verity` installs into Claude Code and the `/verity:vision` command is invocable and does its job.

## 2. Scope — explicitly IN vs OUT

**IN (the thinnest set):**
- A `verity` CLI dispatcher (Node CJS) with: `identity check`, `identity lock`, `identity get`, `scaffold init`, `config ensure/get`, and the carried utilities `slug` / `timestamp` / `verify-path`.
- One role command — **Vision** — installed into Claude Code by the adapter.
- A scaffold that emits a **hygiene CI** workflow (lint + secret-scan + the test runner) that is *honestly green on a near-empty repo*.
- One real passing test (the test runner), and Verity's own repo green under that hygiene CI.

**OUT (deferred — NOT in the skeleton):**
- The other 13 roles; the stream loop; Stage Manager/Executor; Reviewer; Release/Deploy Operator; deploy/`STATUS.md`; the UI-smoke gate.
- GitHub-derived state beyond a trivial `state view` stub (full Ledger comes later).
- Codex / OpenCode / Gemini adapters (Claude Code reference only).
- Hooks (Claude-only, optional — degrade/skip for the skeleton).
- The feature catalog, capability registry beyond a stub, the Gantt view.

## 3. Minimal CLI surface (subset of `framework-spec.md` §9)

| Command | Class | Does (skeleton scope) |
|---|---|---|
| `verity identity check <slug>` | DERIVE | validate slug vs union constraints (lowercase, hyphen, starts-with-letter, ≤63, no underscore) + availability (`gh repo view`, `npm view`); returns JSON {valid, available, issues[]} |
| `verity identity lock <name> <slug> [--owner …]` | AUTHOR | write the immutable identity manifest (`verity.json` or `.verity/identity.json`) |
| `verity identity get [field]` | DERIVE | read the manifest |
| `verity scaffold init` | AUTHOR | from the manifest, generate: `README.md`, `LICENSE`, `.gitignore`, **`.github/workflows/ci.yml` (hygiene)**, `.github/ISSUE_TEMPLATE/bug_report.yml`, `STATUS.md` stub, `verity.json` |
| `verity config ensure/get` | AUTHOR/DERIVE | framework config (carried from 1.4) |
| `verity slug <text>` · `timestamp` · `verify-path <p>` | util | carried verbatim from 1.4 |
| `verity state view` | DERIVE | **stub** — returns a minimal projection (enough to prove the read-only-derive shape; full Ledger later) |

Conventions carried from 1.4 `sdd-tools`: `--raw`, `--cwd`, JSON default, large-output→tempfile, exit 0/1.

## 4. Lift from 1.4 vs build new

| Lift from spec-driven-devops 1.4 (mostly verbatim) | Build new for Verity |
|---|---|
| CLI dispatcher pattern (`sdd-tools.cjs` → `verity.cjs`): routing, `--raw`/`--cwd`, JSON/tempfile | `identity` command (slug validation + `gh`/`npm` availability + manifest write) |
| `generate-slug`, `current-timestamp`, `verify-path` | `scaffold init` (generate files from the manifest) |
| `config.cjs` (config ensure/get) | The **hygiene `ci.yml`** template (honest-green: lint + secret-scan + test runner) |
| The **installer** (`bin/install.js`) = the Runtime Adapter — installs commands into Claude Code | The **Vision** role command (`commands/verity/vision.md`) |
| `scripts/run-tests.cjs` test runner + `assert`/`assertEqual` | `verity.json` identity-manifest schema |
| Repo layout (`bin/`, `<pkg>/bin/lib/`, `commands/`, `templates/`, `scripts/`) | `STATUS.md` stub template |

## 5. The Vision role (thinnest version)

`commands/verity/vision.md` — installed to Claude Code as `/verity:vision`. Skeleton flow (ideation trimmed to "take a project name"):
1. Ask the user for a project name + one-line description.
2. `verity slug "<name>"` → propose a slug; `verity identity check <slug>` → validate + availability; surface conflicts.
3. On confirm → `verity identity lock <name> <slug>` (writes `verity.json`).
4. `verity scaffold init` → lay the repo (README/LICENSE/.gitignore/hygiene CI/issue template/STATUS stub).
5. `git init` + initial commit (the bootstrap commit, before any protection — per §3 ordering).
6. Report: identity locked, files scaffolded, "push + watch hygiene CI go green."

*(Full Vision — repo creation via `gh`, availability across registries, the rich vision doc — layers on after the skeleton.)*

## 6. The hygiene CI workflow (honest-green, the §3 progressive-gate start)

`.github/workflows/ci.yml` emitted by `scaffold init` — genuinely green on a near-empty repo, no faked pass:
- `lint` — a pinned linter (e.g. `ruff`/`eslint` per stack; for Verity's own JS: a pinned linter) — **pinned version** (the 1.4 ruff-drift lesson).
- `secret-scan` — gitleaks, with `permissions: pull-requests: read` (the D4 fix baked in from commit #1).
- `test` — runs the project's test runner; on a near-empty repo this is one trivial real test (not a vacuous pass).
- Triggers: `pull_request` **and** `push: [main]` (so even bypassed merges get a signal — the branch-protection-may-be-unavailable lesson).

## 7. Acceptance criteria (Stage-0 "done = green + runs")

- [ ] `verity` CLI dispatches all §3 commands; `identity check` correctly accepts a valid slug and rejects an invalid one (underscore/uppercase/leading-digit).
- [ ] `scaffold init` produces a hygiene `ci.yml` + the file set, from the manifest.
- [ ] At least one **real** test passes via the test runner.
- [ ] **Verity's own repo is green under its own hygiene CI** (Verity is scaffolded consistent with what it emits — dogfood).
- [ ] The installer installs `/verity:vision` into Claude Code and it is invocable.
- [ ] Running `/verity:vision` end-to-end scaffolds a *target* repo whose hygiene CI goes **green** — i.e. **Verity can bootstrap a repo.**

## 8. Build order (each step ends green)

1. **Repo skeleton + test runner + hygiene CI on `verity-framework` itself** → push, watch it go green. *(Verity's own walking skeleton starts with Verity's own green CI.)*
2. **`verity` dispatcher + utilities** (`slug`/`timestamp`/`verify-path`, `config`) — lifted from 1.4; one test each.
3. **`identity check`/`lock`/`get`** — slug validation + availability + manifest write; tests.
4. **`scaffold init`** — templates (incl. the hygiene `ci.yml` it emits); test that output contains the workflow.
5. **Adapter: install `/verity:vision`** into Claude Code (extend 1.4's installer).
6. **Run the Vision flow end-to-end** → scaffold a throwaway target repo → confirm its hygiene CI goes green. Skeleton proven.

## 9. Repo layout (skeleton)
```
verity-framework/
  package.json            # name: verity-framework, bin: { verity: bin/install.js? } — see note
  bin/install.js          # the Runtime Adapter / installer (lifted from 1.4)
  verity/
    bin/verity.cjs        # the CLI dispatcher
    bin/lib/{core,identity,scaffold,config,state}.cjs
    templates/            # README/LICENSE/.gitignore/ci.yml/issue-template/STATUS stub
    workflows/            # role workflow prose (vision)
  commands/verity/vision.md   # the Vision role command (installed by the adapter)
  scripts/run-tests.cjs   # test runner (lifted from 1.4)
  tests/                  # identity + scaffold tests
  docs/                   # design docs (this folder)
```
*Note: 1.4 used `bin` for the installer and `<pkg>/bin/sdd-tools.cjs` for the CLI. Resolve the `package.json bin` mapping during step 2 (installer vs the `verity` engine binary).*

## 10. Open (implementation-time)
- `package.json bin` wiring: one entry (`verity`) that subcommands install vs run, or two binaries?
- Manifest filename/location: `verity.json` (root) vs `.verity/identity.json`.
- Linter choice for Verity's own JS (eslint vs biome) — pin whichever.
- Whether `state view` stub reads anything real yet, or returns an empty projection until Ledger is built.
