# Interview: building the CI/CD + multi-agent flow

**Purpose.** We are designing a new, clean-room spec-driven development framework (a successor to "SDD 1.4") for **beyond-MVP, production** projects. It is **GitHub-native**, treats **CI/CD as the spine**, and supports **multiple agents/machines** collaborating on one repo. The design is being generalized from a real project *you* helped build — the one whose departures from the standard single-agent flow were logged as divergences **D1–D9**.

You lived that build. This questionnaire exists to capture the concrete reality behind those divergences so the new framework's roles and gates match what actually worked (and avoids what didn't).

---

## How to answer (please read)

- **Answer from the real repo, git history, CI runs, Issues, and PRs — not from memory or assumption.** Cite concrete evidence: file paths, commit SHAs, PR numbers, workflow names, issue numbers, settings screens.
- When useful, **paste the actual artifact** (a workflow YAML, an issue template, a branch-protection config, an example PR description, the `STATUS.md`). Look for the 📎 markers.
- **Separate three things explicitly:** (1) *what we actually did*, (2) *what bit us / what broke*, (3) *what you'd design differently if starting over*.
- If you don't know or it never came up, say **"N/A"** or **"didn't happen"** — do **not** invent an answer. Gaps are valuable data.
- Write answers inline under each **Answer:** line. Keep the section/numbering structure intact.
- ⭐ = highest-value question. If you're short on time, do the starred ones first.
- Tags like `[informs: Architect]` show which framework role/decision the answer shapes — ignore if not useful.

> **Evidence basis for all answers below.** Repo `smahoney-specdev/Switchboard`, private, GitHub free plan. Created `2026-05-28T13:28:06Z` (initial commit `089a1e9` "Initial commit — Switchboard v0.1.0"). At time of interview: **186 commits**, **51 PRs** (50 merged, 1 closed-unmerged), **14 issues** (#52 open), **18 tags** (`v0.2.0`→`v0.4.2`), **0 GitHub Releases**, build window ~10 days (2026-05-28 → 2026-06-07). Author identities: `seanerama` (141 commits), `Sean Mahoney` web-UI (35), `smahoney-specdev` (13); **132/186 commits (71%) carry a `Co-Authored-By: Claude` trailer** — this was machine-assisted, agent-driven development throughout.

---

## A. Project shape & context

A1. ⭐ What was the app, in two sentences? What problem did it solve and who used it? `[informs: Vision]`
**Answer:**
Switchboard is an internal, chat-based **AI orchestrator** for ~10 US Signal staff (`sdd-output/project-state.md`): a user talks to one chat UI, and behind it Claude decides when to call one of four specialist **sub-agents** (each owning a domain — CRM/client tracking, product knowledge, etc.). It replaces "ask a person / dig through systems" with a single conversational front door that owns auth, logging, the Claude tool-use loop, and per-user token budgeting. Internal line-of-business tool, not public SaaS.

A2. ⭐ What was the tech stack and the **service topology** (monolith / modular-monolith / N services)? List the services and what each does. `[informs: Architect/topology]`
**Answer:**
**Stack:** Python 3.12, FastAPI/Starlette, server-rendered Jinja2 + HTMX (no SPA/build step), Postgres 16, Docker Compose, Caddy (TLS + LB), Alembic migrations, `uv`/`pip -e` packaging, `ruff` lint/format, `pytest`. Hosted on Azure VMs, images in GHCR.

**Topology = orchestrator + N sidecar services** (8 runtime containers). From `release.yml` matrix and `docs/AZURE_GITHUB_SETUP.md`:
- **gateway** — the orchestrator: chat UI, auth/sessions, Claude tool-use loop (`run_chat_turn`), logging, token accounting. Runs **2 replicas** (`gateway_prod_1/2`) behind Caddy; stateless by design (Stage 6).
- **worker** — async job runner (ingest/doc-build queue; Stage 5).
- **4 sub-agents** behind one frozen HTTP/JWT wire contract (`/health·/invoke·/ingest`): **client_tracking** (CRM, real), **product_knowledge** (real), **service_knowledge** (stub), **doc_builder** (stub). Each built from one shared `sub-agents/Dockerfile.subagent` parameterized by a `ROLE` build-arg.
- **Caddy** — edge TLS (Let's Encrypt) + load-balances the two gateway replicas.
- **Postgres 16 + pgBackRest** — on a *separate* VM (see A3).

Best label: **modular monolith-of-services** — the gateway is the monolith, the sub-agents are contract-isolated satellites. The sub-agent wire contract (`shared/subagent_contract/v1`) was **frozen at v1 and never broken** across the whole build; every feature that touched a sub-agent was an *additive* v1 extension.

A3. Where did it deploy (cloud, platform, runtime), and roughly what scale / uptime expectation? `[informs: Architect non-functionals, Deployer]`
**Answer:**
**Azure, two VMs, Docker Compose runtime** (`STATUS.md` "Live deployment"):
- **VM1 (app host, "cattle")** — public IP `135.119.65.172`, FQDN `switchboard.centralus.cloudapp.azure.com`. Runs the whole app stack + Caddy + monitoring (Prometheus/Alertmanager).
- **VM2 (data host, "pet")** — private IP `10.0.2.4`, **no public IP** (reachable only via VM1 as SSH jump host). Postgres 16 + pgBackRest with continuous WAL archiving + base backups to Azure Blob (`swbsmahoney`/`pgbackrest`, centralus).

**Scale:** ~100 staff browsers cited as the peak target (`AZURE_GITHUB_SETUP.md` mermaid), realistically ~10 active users. **Uptime: deliberately NOT 24/7** — both VMs are **powered off most nights** to save cost ("up on weekends"). This is the single most flow-relevant non-functional: every agent had to handle "the app/SSH is unreachable because the VMs are deallocated, start them first."

A4. How many distinct agents/machines touched the repo, and what was each responsible for? How did that change over time (the D7→D8 consolidation)? `[informs: multi-agent model]`
**Answer:**
**(a) What we did.** Two machines for the first stretch (D7, 2026-06-01):
- **Build/dev machine** (this one) — architect, plan, build stages, fix, version-bump, tag, build images, deploy to the VMs, verify, maintain `STATUS.md`. GitHub identity mostly `seanerama`.
- **Testing/handoff machine** — end-user/UX testing, filing GitHub Issues as the defect channel. Its PRs and early fixes show as author `smahoney-specdev` (PRs #8–#19, `test-fixtures/synthetic-client-data` #15).

The split is visible in the git authors (two distinct identities) and in PR authorship: the early bug-fix wave (#7,#9,#13,#14 etc.) was filed-by-tester / fixed-as `smahoney-specdev`, while feature/stage work is `seanerama`.

**(b) What changed (D8, 2026-06-03).** The **testing machine went away** — the operator lost access (`sdd-output/tester-handoff.md`: "The testing machine is gone — its operator lost access. From now on, everything runs on this one machine."). The strict "tester writes no code, output = issues only" wall was relaxed; build+fix+deploy+test collapsed onto one machine.

**(c) D9 re-validation (2026-06-06).** A second agent system rejoined *on demand* for one feature — it authored the help agent as **PR #51** off `sdd/stage-15-help-agent`; this machine reviewed/merged/tagged/deployed it. So the final model is **single-agent by default, multi-agent opt-in per-feature via fork/branch→PR**.

A5. Over the life of the project, roughly how many stages, PRs, issues, and releases? `[informs: scale assumptions]`
**Answer:**
- **Stages:** 15. `sdd-output/stage-instructions/` holds stage-1 through stage-14; the help agent is "Stage 15" (PR #51 title). Stages 1–9 = hardening/retrofit foundation; 10–15 = post-plan feature stages added via the Feature Manager intake.
- **PRs:** 51 total — 50 merged, **PR #4 closed-unmerged** (a CI-bootstrap attempt), plus #43 and #46 were closed and **re-homed** as #44/#47 (stacked-PR casualties, see L3/H3).
- **Issues:** 14 total — 13 closed, **#52 open**. Labels in use: `bug`, `enhancement`, `needs-triage`, `ui`, `help-bot`.
- **Releases:** **18 tags** `v0.2.0`→`v0.4.2`, but **0 GitHub Releases objects** — "release" meant *a git tag that triggers `release.yml`*, never the GitHub Releases UI. (13 of the 18 tags are in the `v0.3.x` band — lots of small ship-fix-ship increments.)

---

## B. Identity, repo creation & scaffolding

B1. ⭐ How was the repo first created and named? Was there a single **slug/name** convention, and did it propagate consistently to: repo name, package name, container/GHCR image paths, branch names, environment names, DNS/subdomains, secret names? Where did it NOT propagate cleanly? `[informs: Vision/identity]`
**Answer:**
**(a) What we did.** Slug = **`switchboard`**, applied broadly and mostly consistently:
- Repo: `smahoney-specdev/Switchboard`.
- GHCR images: `ghcr.io/smahoney-specdev/switchboard-<component>` (hyphen-joined: `switchboard-gateway`, `switchboard-client_tracking`, …) — set in `release.yml:59`.
- DNS/FQDN: `switchboard.centralus.cloudapp.azure.com`.
- Azure RG `switchboard-prod`, Blob storage `swbsmahoney`/`pgbackrest`, pgBackRest stanza `switchboard`.
- Branch names: convention-driven but **not slug-prefixed** — `sdd/stage-N-*`, `feat/*`, `fix/*`, `chore/*`.

**(b) Where it did NOT propagate cleanly:**
1. **Case split** — GitHub repo is `Switchboard` (capital S) but every image/DNS/stanza is lowercase `switchboard`. GHCR *requires* lowercase, so the owner slug also had to be lowercased (`GHCR_OWNER=smahoney-specdev`). Two casings to remember.
2. **Owner vs auth identity mismatch** — images live under `smahoney-specdev`, but the `gh` CLI authenticates as `seanerama`. This bit deploys repeatedly: `gh auth token` lacks `read:packages`, so digest pulls needed a *different* PAT logged into `docker login ghcr.io -u smahoney-specdev`. A persistent papercut, captured in memory `github-account-and-plan`.
3. **Product name lag** — an early rebrand "AI App Server" → "Switchboard - Alpha" (PR #31) only touched UI templates; the FastAPI/OpenAPI title, `main.py` startup logs, and the model-facing product description in `system_prompt.py` **still said "AI App Server"** afterward (noted in `STATUS.md` v0.3.2). The slug didn't reach the model-facing strings.

**(c) Design differently.** Lock an **identity manifest** at vision time — one immutable record fixing `{repo, slug (lowercase-canonical), image-prefix, dns, env names, secret names, registry-owner}` — and *generate* the scaffold from it so casing and owner-vs-auth can't drift. And decide the registry-owner ↔ git-auth identity question on day one.

B2. Did you ever have to **rename** the project/slug or any of the above? What broke, and how painful was it? `[informs: "lock identity as immutable"]`
**Answer:**
**No hard slug rename** — `switchboard` was stable from `089a1e9`. The only rename was the **display name** "AI App Server" → "Switchboard - Alpha" (PR #31, v0.3.2). It was low-pain *because it was cosmetic* — but it was also **incomplete** (B1c): UI got renamed, backend/model-facing strings didn't, leaving a split-brain product name. So the lesson isn't "renames are painful," it's "**partial renames leave inconsistency debt**" — proof that the name was *not* a single source of truth. N/A on infrastructure renames (image paths/DNS/secrets never moved).

B3. 📎 What did the initial repo scaffold contain on day one (before any feature code)? List files/dirs (README, LICENSE, CODEOWNERS, `.github/`, issue templates, CI, config, config). Paste the initial commit's file tree if you can. `[informs: scaffold layer-1]`
**Answer:**
**Critically: day-one was NOT a thin scaffold — it was a ~50-file working gateway** (`git ls-tree 089a1e9`). The repo was *born at v0.1.0 with a running app*, then retrofitted into SDD (path = "existing project"). Initial tree (abridged):

```
.env.dev.example  .env.prod.example  .gitignore  LICENSE  README.md
caddy/.env.example  caddy/Caddyfile.dev  caddy/Caddyfile.prod
config/crontab-ai-server  config/logrotate-ai-server.conf
docker-compose.caddy.yml  docker-compose.dev.yml  docker-compose.prod.yml
docs/ENV.md  docs/MAINTAINER_AGENT_NOTES.md  docs/OPS.md  docs/SUB_AGENT_CONNECTION.md
gateway/Dockerfile  gateway/alembic.ini
gateway/app/{auth,claude_loop,config,db,models,main,middleware,rate_limit,
             routes_auth,routes_chat,routes_sessions,routes_ui,routes_upload,
             system_prompt,token_accounting,tools,sse,log_sink_pg,...}.py
gateway/app/static/{css,icons,js}/...   gateway/app/templates/...
gateway/app/scripts/bootstrap_user.py
```

**What was MISSING on day one (and is the actual answer to "scaffold layer-1"):**
- ❌ **No `.github/workflows/`** — no CI at all.
- ❌ **No `.github/ISSUE_TEMPLATE/`** — no defect channel.
- ❌ **No `CODEOWNERS`**.
- ❌ **No `sdd-output/`, no `STATUS.md`, no `docs/handoff/`** — none of the coordination machinery.
- ✅ Had: `LICENSE`, `README.md`, `.gitignore`, env examples, compose files, Dockerfiles, and a `docs/MAINTAINER_AGENT_NOTES.md` (so "an agent will maintain this" was anticipated from the start).

This is the single biggest structural finding: **the app existed before the pipeline did.** Everything in C2/D4 (the first CI run failing on 4 checks) flows directly from CI being bolted on *after* ~9 stages of code already existed.

B4. What scaffolding did you wish existed from the start but had to add later? `[informs: scaffold completeness]`
**Answer:** Every coordination/quality primitive was added late, and each addition is a dated divergence:
- **CI workflows** (`ci.yml`/`release.yml`) — added ~Stage 1 retrofit, first ran 2026-05-29 (D4).
- **Issue templates** (`.github/ISSUE_TEMPLATE/bug_report.yml`) — added with D2 so a *different* agent could act on a defect.
- **`STATUS.md`** — added (D6) because `sdd-output/` couldn't carry runtime/deploy state.
- **Tracked `sdd-output/`** — had to un-ignore it (D1) so SDD state synced across machines.
- **`docs/handoff/`** + `docs/handoff/README.md` agent-quickstart — added so a joining agent had an entry point.
- **A pinned linter** — `ruff==0.15.15` (`ci.yml:30`), added only after an unbounded range silently turned clean files red.
- **Branch protection** — *still* missing (free-plan blocked, B5/D3).

Wish-list, ranked: **CI + a walking skeleton first**, issue template + STATUS.md second, identity manifest third.

B5. Was branch protection on `main` enabled at creation or later? What was the ordering pain (e.g., first commit had nowhere to land)? `[informs: scaffold + protection ordering]`
**Answer:**
**Never enabled — to this day.** `gh api .../branches/main/protection` → **404 Not Found**; `gh api .../rulesets` → **403 "Upgrade to GitHub Pro or make this repository public."** The repo is **private on the free plan**, where branch protection and rulesets are paywalled (memory `github-account-and-plan`; `AZURE_GITHUB_SETUP.md` Part A status note).

So the ordering pain was *not* "first commit had nowhere to land" — it was the opposite: **the gate was never installable, so "merge only when green" stayed an honor-system convention enforced by the agent, not by GitHub.** PR #4 (`ci/verify-checks`, closed-unmerged) was an explicit attempt to "register check names" to bootstrap protection — it couldn't be completed. The 8 required check contexts are written down in `AZURE_GITHUB_SETUP.md` (lines 91–94), **ready to apply the instant the repo goes Pro or public**, but the rule object does not exist. This is the framework's most important real-world constraint: **on the most common hobby/internal tier, the integration gate you design must degrade to honor-system + CI-visible, because the platform won't enforce it.**

---

## C. CI introduction & the definition of "done" (D4)

C1. ⭐⭐ **When** in the project did CI first actually run (not "exist as config" — *run green on a real PR*)? How many stages had already been marked "done" before that first real run? `[informs: CI timing, walking-skeleton]`
**Answer:**
**CI first *ran* 2026-05-29** (earliest Actions runs: `CI` on `ci/verify-checks` = **failure**, `CI` push to main = **failure**, `Release` on tag `v0.2.0` = **failure**). It did **not run green** until after **PR #5** (`fix/two-vm-ops-and-cicd-docs`), which itself logged **4 consecutive failing CI runs** (2026-06-01 19:02→19:44) before going green and merging at 2026-06-01T19:47.

**Stages already marked "done" before the first green run: all of Stages 1–9.** Per `STATE.md` and D4, the Stage Manager had marked Stages 1–9 complete ("code + tests + CI **config**") on 2026-05-29 — but the first *real* CI execution had never happened. So **9 of ~15 stages were "done" before CI was ever green.** This is the empirical core of D4.

C2. ⭐⭐ When CI first ran for real, what failed? (D4 listed: lint not clean, gitleaks missing `pull-requests: read`, two colliding `conftest.py`, a stub log-sink bug, gateway suite not CI-runnable: no `DB_URL`/migration, `env.py +asyncpg` bug, async-fixture debt.) For each: was it a latent bug hidden by CI never running, or a CI-config problem? `[informs: "done = green" gate]`
**Answer:** Mix of both — classified from PR #5's commits and `STATUS.md` "Repo changes merged this session":

| Failure | Class | Evidence / fix |
|---|---|---|
| Lint not actually clean (`ruff check`) | **Latent code debt** — "clean" was never verified | repo-wide `ruff check --fix` + `ruff format` + 5 manual fixes (PR #5) |
| gitleaks missing `pull-requests: read` | **CI-config** | added `permissions: pull-requests: read` (`ci.yml:13`) |
| Two colliding `tests/conftest.py` (`ImportPathMismatchError`) | **CI-config × test-design** | split `gateway-tests` into two pytest sessions (`ci.yml:91-93`) |
| Stub log-sink dir bug | **Latent bug** hidden by never-run | sink re-derives date path + `mkdir`s per write |
| Gateway suite not CI-runnable: no `DB_URL` | **CI-config (env)** | set `DB_URL`/`INTEGRATION_DB_URL` + Postgres service (`ci.yml:52-71`) |
| No migration step in CI | **CI-config** | added `alembic upgrade head` (`ci.yml:84-85`) |
| `env.py` `+asyncpg` normalization (`MissingGreenlet`) | **Latent bug** in migration config | normalize `+asyncpg`→`+psycopg` for DDL |
| async-fixture debt (event-loop scope, isolation, stale asserts) | **Latent test-design debt** | the largest one — tracked as **issue #6**, not fixed until **PR #32** (v0.3.2), plus it revealed a *real* prod bug (`auth_sessions.ip` INET column rejecting `"unknown"`) |

**Verdict:** roughly half CI-config (env/permissions/collisions) and half latent bugs/debt that *only existed because tests had never executed*. The async-fixture one (#6) is the headline: "tests exist" had masked both broken fixtures **and** a latent production INET bug for 9 stages. The lag from "marked done" (2026-05-29) to "actually green" (#6 closed in PR #32, 2026-06-03) was **~5 days**.

C3. ⭐ Was there ever a **"walking skeleton"** — a thinnest end-to-end slice that compiled, ran, passed one real test, went green in CI, and deployed — early on? If not, do you wish there had been, and where would it have helped? `[informs: walking-skeleton deliverable]`
**Answer:**
**No — didn't happen, and this is the #1 design lesson.** The repo started as a *fat* skeleton (a whole working gateway at v0.1.0, B3) with **no CI and no deploy proof**. The first end-to-end "green CI + actually deployed" moment was **`v0.2.0` (2026-05-29) → fully verified only after PR #5 (2026-06-01)** — i.e. the "skeleton" walked *days after most of the body was built.*

**Where a real walking skeleton would have helped, concretely:**
- It would have forced `DB_URL`/migration/Postgres-service wiring *before* 9 stages of code piled on top, killing the entire D4 failure cluster at the root.
- It would have exercised `release.yml` → GHCR → digest-pin → `deploy.sh` → `verify_deploy.sh` on a one-route app, surfacing the **trivy tag bug** (`@0.28.0`→`@v0.36.0`), the **HTMX placeholder bug** (real HTMX never vendored, shipped a 472-byte stub — not caught until **v0.3.1**), and the **GHCR-owner-vs-`gh`-auth** pull problem while they were cheap.
- Strong recommendation: make **"thinnest vertical slice green in CI and deployed by digest"** a *mandatory Stage 0 gate* that blocks all feature stages. In this build, CI/CD was *Stage 1* but treated as config, not as a proven running pipeline — that gap is the whole of D4.

C4. How did you eventually define "this stage is actually done"? Did it become "CI green," and was that enforced or honor-system? `[informs: completion gate]`
**Answer:**
It became **"PR is 8/8 CI green, then merge"** — `docs/handoff/README.md` §5 states it as a rule: "open a PR. **CI must be 8/8 green** … Merge (squash/merge + delete branch)." Feature assessments bake it into acceptance conditions (e.g. admin-panel assessment condition #6: "PR CI green, issue #6 excepted"). So the *definition* hardened to green-CI (D4's proposed change, adopted).

**Enforcement: honor-system, not platform-enforced** (B5/D3) — branch protection is paywalled, so nothing technically blocked a red merge. The agent enforced it by convention. CI *did* run on every PR **and on push to main** (`ci.yml:8-9`), so even the `/sdd:merge` paths that bypassed PRs (e.g. Stage 14 → `main` directly, `STATUS.md` v0.3.9) still got a CI signal — just *after* landing, not as a gate. Net: **"done = green" was a real norm with a real signal but a missing enforcement point.**

C5. Did you ever mark something done that wasn't, and discover it downstream? What was the cost/lag? `[informs: verification role]`
**Answer:** Yes, repeatedly — this is the recurring failure mode:
- **Stages 1–9 "done" with red/never-run CI** — discovered at first real run; lag ~3–5 days to fully green (#6 → PR #32). (C1/C2.)
- **HTMX never vendored** — admin dashboard shipped with a placeholder JS stub, so all `hx-*` were inert and the dashboard hung on "Loading…". Marked done in v0.3.0, discovered in use, hotfixed in **v0.3.1**. A guard test (`test_static_assets_unit.py`) was added to block re-shipping the stub.
- **v0.3.9 UI refresh "shipped" but invisible** — assets were cached; users saw no change because URLs were unversioned. Discovered downstream, fixed by cache-busting in **v0.3.10** (`?v={{app_version}}`).
- **v0.4.0/v0.4.1 help agent "done" but the File-issue button was dead** — `chat_detail` never set `help_mode`, so `help-chat.js` didn't load; the button silently did nothing. Discovered by a human clicking it; hotfixed in **v0.4.2** (`a6bae47`).

**Pattern:** automated CI caught *backend/contract* regressions well, but **"done" repeatedly meant "code merged," not "feature observably works in the deployed app."** The cost was a steady stream of `vX.Y.(Z+1)` hotfix releases (the v0.3.x band has 13 tags largely for this reason). This is the strongest argument in the whole interview for a **post-deploy human/agent verification role** distinct from CI (see N2).

---

## D. CI/CD pipeline mechanics

D1. ⭐ 📎 Paste your main CI workflow file(s) (`.github/workflows/*.yml`). What jobs/checks ran, in what order, on what triggers (PR, push, tag)? `[informs: CI gate composition]`
**Answer:**
Two workflows. **`CI`** (the PR gate) and **`Release`** (tag → images). Jobs run in **parallel** (no inter-job `needs:`); "order" is really "8 independent checks must all be green."

**Triggers:** `CI` on `pull_request` **and** `push: [main]` (`ci.yml:6-9`); `Release` on `push: tags: ["v*"]` (`release.yml:7-9`).

**The 8 CI check contexts** (matrix jobs expand): `lint`, `secret-scan`, `gateway-tests`, `subagent-tests (client_tracking)`, `subagent-tests (product_knowledge)`, `contract-tests (stub_common)`, `contract-tests (client_tracking)`, `contract-tests (product_knowledge)`.

📎 **`.github/workflows/ci.yml`:**
```yaml
name: CI
# PR gate: lint + format + unit/integration tests + secret scan.
# A red result blocks merge (configure branch protection to require these jobs).
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read   # gitleaks-action lists PR commits via the API on pull_request
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Install ruff
        # Pinned: an unbounded range let CI pull a newer ruff whose formatter
        # rules differ, turning previously-clean files red without any code change.
        run: pip install "ruff==0.15.15"
      - name: Lint
        run: ruff check .
      - name: Format check
        run: ruff format --check .
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
  gateway-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: ci, POSTGRES_PASSWORD: ci, POSTGRES_DB: ci }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U ci" --health-interval 10s
          --health-timeout 5s --health-retries 5
    env:
      INTEGRATION_DB_URL: postgresql+asyncpg://ci:ci@localhost:5432/ci
      DB_URL: postgresql+asyncpg://ci:ci@localhost:5432/ci
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Install gateway + stub_common (dev extras)
        run: |
          pip install --upgrade pip
          pip install -e "gateway[dev]" -e "sub-agents/stub_common[dev]"
      - name: Migrate (create schema in the CI Postgres)
        run: cd gateway && alembic upgrade head
      - name: Tests
        # Two suites each ship a tests/conftest.py → collide under one pytest run.
        run: |
          pytest gateway/tests
          pytest sub-agents/stub_common/tests
  subagent-tests:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { agent: [client_tracking, product_knowledge] }
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      PYTHONPATH: ${{ github.workspace }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install --upgrade pip && pip install -e "sub-agents/${{ matrix.agent }}[dev]"
      - name: Tests (skip live-API integration)
        working-directory: sub-agents/${{ matrix.agent }}
        run: python -m pytest tests -m "not integration"
  contract-tests:
    # Stage 9: every sub-agent must conform to the frozen v1 HTTP/JWT contract.
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { agent: [stub_common, client_tracking, product_knowledge] }
    env: { PYTHONPATH: ${{ github.workspace }} }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install --upgrade pip && pip install -e "sub-agents/${{ matrix.agent }}[dev]"
      - name: Contract conformance
        working-directory: sub-agents/${{ matrix.agent }}
        run: python -m pytest tests -k "contract or stub_endpoints" -m "not integration"
```
(See F2 for `release.yml`.) Note `cancel-in-progress: true` — a fresh push cancels the prior run, which is why some PR run histories show `cancelled`.

D2. Which checks were **hygiene** (meaningful even on a near-empty repo: secret scan, lint, build, dep-pinning/lockfile) vs **test** vs **deploy**? Did the set of required checks grow over time? `[informs: progressive gate]`
**Answer:**
- **Hygiene** (would pass/matter on a near-empty repo): `lint` (ruff check + format, **pinned `0.15.15`**) and `secret-scan` (gitleaks). These are the two that belong in a Stage-0 skeleton.
- **Test**: `gateway-tests` (unit + Postgres-backed integration via a service container + alembic migrate), `subagent-tests` (×2, live-API integration skipped via `-m "not integration"`), `contract-tests` (×3, frozen-v1 conformance).
- **Deploy** (separate workflow, not a merge gate): `Release` builds 6 images, Trivy-scans HIGH/CRITICAL, emits digests.

**Did the set grow?** Yes, but mostly *early* — the 8 contexts were established during the Stage 1/PR #5 retrofit and stayed stable. The **substance** within jobs grew: Postgres service + migration step were added (D4); the `contract-tests` job is explicitly "Stage 9"; `release.yml` later gained the **Stage 15 source-snapshot bake** (`release.yml:69-71`). No image **build** check runs in the PR gate — images are only built on tag. (A gap: a PR can be 8/8 green and still produce an unbuildable image; the missing `./source-snapshot` for local gateway builds is exactly this class of problem.)

D3. 📎 What were your **branch-protection settings** on `main` (required checks, required reviews, linear history, who could merge, etc.)? `[informs: integration gate]`
**Answer:**
📎 **There are none — the API returns:**
```
$ gh api repos/smahoney-specdev/Switchboard/branches/main/protection
HTTP 404: Not Found
$ gh api repos/smahoney-specdev/Switchboard/rulesets
HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.
```
**Designed-but-unapplied config** (`AZURE_GITHUB_SETUP.md` Part A, ready to paste the moment the repo is Pro/public):
- Required status checks (exact contexts): `lint`, `secret-scan`, `gateway-tests`, `subagent-tests (client_tracking)`, `subagent-tests (product_knowledge)`, `contract-tests (stub_common)`, `contract-tests (client_tracking)`, `contract-tests (product_knowledge)`.
- Require a PR before merge.
- (Reviews/linear-history/who-can-merge were never specified — single-owner repo, so "required reviewers" was moot; the agent self-reviewed.)

**The whole integration gate ran on honor-system + visible CI.** For the framework: treat platform-enforced protection as *optional infrastructure that may be unavailable*, and make the agent's merge discipline + push-to-main CI the actual floor.

D4. ⭐ How were changes integrated — PR-per-stage? PR-per-issue? Direct pushes ever? What was the merge strategy (squash/merge/rebase, delete-branch-on-merge)? `[informs: integration model D3]`
**Answer:**
**Mixed, by work-type:**
- **PR-per-stage** for feature stages (`sdd/stage-N-*` → `main`): #22 (Stage 10), #39 (Stage 11), #42/#44 (Stage 12), #45/#47 (Stage 13), #51 (Stage 15).
- **PR-per-issue / PR-per-batch** for fixes: #23 (#21), #32 (#6), or batched (#35 = "#34/#27/#24", #36 = "#33/#29/#28").
- **Direct push to `main` did happen** — Stage 14 landed via `/sdd:merge` with **no PR** (`STATUS.md` v0.3.9: "merged straight to `main` … CI on push-to-main passed"). Because `ci.yml` triggers on `push: [main]`, these still got a CI signal — *post-hoc*, not gating. (Memory: `sdd-merge-bypasses-pr`.)

**Merge strategy:** **squash + delete-branch-on-merge** (`docs/handoff/README.md` §5: "Merge (squash/merge + delete branch). Issues auto-close via `Closes #NN`."). 46 of 186 commits are merges, but feature history is squashed so `main` reads cleanly.

**The strategy bit back twice (H3/L3):** squash-delete-branch on a **stacked** base PR auto-closed the child PR and orphaned it — #43 (child of #42) and #46 (child of #45) both had to be **re-homed** as fresh PRs #44/#47. Captured in memory `stacked-pr-delete-branch-gotcha`.

D5. How long did CI take, and did slowness ever push you to skip/short-circuit it? `[informs: gate ergonomics]`
**Answer:**
**Didn't happen / N/A on "slowness forced skipping."** No evidence in 160 CI runs or any commit/STATUS note of CI being skipped for speed. CI is 8 small parallel ubuntu jobs (pip installs + pytest + a Postgres service); `concurrency: cancel-in-progress` means superseding pushes auto-cancel stale runs (the source of the `cancelled` results, not deliberate skips). The *gate* was occasionally short-circuited, but for a **structural** reason (no branch protection → direct `/sdd:merge` to main, D4), never for a **speed** reason. Exact wall-clock times weren't recorded.

D6. Did you pin dependencies and commit lockfiles? Did unpinned/drifting deps ever cause a non-reproducible build? `[informs: hygiene gate]`
**Answer:**
**Partially — and yes, drift bit us, which is precisely why one pin exists.** The headline incident: `ruff` was installed from an **unbounded range**, CI pulled a newer formatter, and **previously-clean files went red with zero code change** — fixed by hard-pinning `ruff==0.15.15` with a comment explaining exactly that (`ci.yml:28-30`). Runtime reproducibility was instead achieved at the **image layer**: prod *never builds on host* and runs **digest-pinned** images (`@sha256:…` in `.env.prod`), so the deployed artifact is byte-exact regardless of dep drift (`deploy.sh` header; `release.yml` digest emission). Python deps were `pip install -e` from `pyproject.toml`; I did **not** see a committed `uv.lock`/`requirements.lock` for the Python tree. So: **toolchain pinning = reactive (after it broke), runtime pinning = strong (digests), dependency lockfile = a gap.** Design differently: lockfile + pinned toolchain as a **Stage-0 hygiene gate**, not a post-incident patch.

---

## E. Release management

E1. ⭐ How did you cut releases? Walk through the v0.4.0 → v0.4.1 → v0.4.2 sequence from D9 (dark-launch → enable → hotfix). Who/what bumped versions and tagged? `[informs: release role/gate]`
**Answer:**
**Release = a human-driven, hand-bumped git tag that triggers `release.yml`.** The agent (this machine) did every step manually; nothing was automated. The canonical recipe (`docs/handoff/feature-help-agent.md` "Pointers", `STATUS.md` coordination notes): **edit `gateway/app/version.py` → commit `chore(release):` → `git tag vX.Y.Z && git push --tags` → wait for `release.yml` to build+scan+push images → copy the `@sha256` digest from the run summary into `.env.prod` on VM1 → `scripts/deploy.sh`.**

The D9 sequence, all on **2026-06-06**, all `seanerama`:
- **v0.4.0** (`2a0bb42`, `chore(release): gateway v0.4.0 — in-app help agent (#51), shipped dark (HELP_AGENT_ENABLED=false)`) — merged PR #51, bumped version, tagged, built, deployed **DARK**: code live but kill-switch off, so `/help` 404s and the `kind='chat'` path is byte-identical. Verified both routes 404.
- **v0.4.1** (`9d79182`, `build(help): bake source snapshot into gateway image + shared FAQ volume`) — the **enable** step: added the `git archive HEAD` snapshot bake to `release.yml`, mounted the `help_kb_prod` FAQ volume, set `HELP_AGENT_ENABLED=true` + `HELP_GITHUB_TOKEN` in `.env.prod`. Verified `/help` now 401 (was 404).
- **v0.4.2** (`a6bae47`, `fix(help): render help sessions in help mode on /chat/{id}`) — the **hotfix**: the File-issue button was dead (`chat_detail` didn't set `help_mode`); one-file fix in `routes_ui.py`, re-tag, rebuild, redeploy.

This is textbook **dark-launch → enable-by-flag → hotfix**, executed as three separate tag-and-deploy cycles within hours. The "release role" was entirely the maintainer agent + the `release.yml` automation it triggers.

E2. Was versioning manual or automated? Conventional commits / changelog generation / release-please / semantic-release / by hand? `[informs: release automation]`
**Answer:**
**By hand.** Commits *are* Conventional Commits (strict `type(scope): … [#PR]`, with `chore(release):` for bumps — 9 of them), but **no `release-please`/`semantic-release`/changelog generator** ran. The version string is hand-edited in `gateway/app/version.py`; the tag is hand-pushed. The "changelog" is **`STATUS.md`**, hand-maintained as nested `<details>` blocks per release.

**This bit us:** versions drifted from reality. `version.py` sat at `0.1.0` across *all* of v0.2.x→v0.3.1 (never bumped), so `/health` and `/version` **misreported the running version** until PR #32 corrected `0.1.0 → 0.3.2`. And v0.3.10/v0.3.11 collided — a PR bumped to `0.3.10` which was already taken, forcing a manual correction to `0.3.11` (`STATUS.md`). **Design differently:** derive the version from the tag (or vice-versa) automatically so the binary can't lie about itself, and auto-generate the changelog from Conventional Commits.

E3. ⭐ What did your **hotfix** path look like under branch protection + CI? Did the gates help or get in the way during an urgent fix? `[informs: hotfix flow]`
**Answer:**
**The hotfix path was *fast precisely because there was no enforced branch protection*** (D3) — that's an honest, double-edged finding. v0.4.2 (`a6bae47`): branch → one-file `routes_ui.py` fix → CI green → merge → bump → tag → rebuild gateway image → re-pin `GATEWAY_DIGEST` → `deploy.sh` → done, within the same session. CI (the part that *did* exist) **helped** — it stayed green and gave confidence — and never got in the way (8 fast parallel jobs, D5). Same story for the v0.3.1 HTMX hotfix and v0.3.10 cache-bust.

What I *can't* report is "did enforced protection get in the way during urgency," because **it never existed** — so the framework gets a real data point but not from friction: the hotfixes were unblocked because the human-in-the-loop was the gate. The risk that buys (a red hotfix *could* have merged) never materialized, but it was structurally possible. **Design differently:** allow a fast-path that *requires CI green* but waives review/PR for a flagged hotfix, so urgency doesn't tempt you to bypass the *test* signal along with the *review* signal.

E4. Did you use feature flags / dark launches (D9 "v0.4.0 dark")? How were they managed? `[informs: deploy/release]`
**Answer:**
**Yes — kill-switch env flags were the standard pattern for risky features**, default-off, set per-environment in `.env.prod` on VM1 (never in git). Confirmed instances:
- `HELP_AGENT_ENABLED` (default false) — shipped v0.4.0 dark, flipped true in v0.4.1. When off, the `/help` router isn't even mounted (`main.py`), so routes 404 and the code path is inert.
- `ADMIN_PANEL_ENABLED` (default off) — Stage 10 admin panel; assessment condition #7 mandated it.

Management = **plain env vars read by `config.py`, toggled by editing `.env.prod` and redeploying.** No flag service, no per-user targeting, no runtime toggle (flip = redeploy). Feature assessments *required* a kill-switch as an acceptance condition for net-new feature stages — so "dark launch behind a default-off flag" was a deliberate, repeated discipline, not a one-off. Simple and effective for this scale; the only cost is "toggle requires a redeploy."

---

## F. Environments, deploy & rollback

F1. ⭐ What environments existed (dev/staging/prod)? How were they provisioned and named relative to the slug? `[informs: environments as first-class]`
**Answer:**
**Two environments: `dev` and `prod`. No staging.** They're expressed as **separate compose files + env files**, not separate clusters:
- `docker-compose.dev.yml` + `.env.dev` (+ `dev_up.sh`, `Caddyfile.dev`) — local/dev stack, container names like `client_tracking_dev`.
- `docker-compose.prod.yml` + `.env.prod` (+ `Caddyfile.prod`) — the live Azure stack, container names `gateway_prod_1/2`, etc.
- `docker-compose.caddy.yml` — the edge.

Naming relative to slug: env is a **suffix on container/volume names** (`_prod`/`_dev`) and a filename discriminator (`.env.prod`). GHCR images are env-agnostic (same digest deploys anywhere); the environment is purely "which compose + which env-file + which host."

**The notable gap (and the cost):** **no staging meant `prod` *was* the test bed for "does it actually render."** Every "done-but-broken" discovery in C5 (HTMX stub, cache staleness, dead help button) was found *in production* because there was nowhere else to find it. For the framework: a **staging environment that mirrors prod's image-by-digest deploy** is the missing third environment that would have caught most C5 hotfixes pre-prod.

F2. 📎 How did deploy actually work end to end? (Build image → push GHCR → deploy where → how verified?) Paste the deploy workflow/runbook if there is one. `[informs: Deployer role]`
**Answer:**
**Flow:** `git tag v*` → **`release.yml`** builds each of 6 images **once**, pushes to GHCR as `switchboard-<component>` with a semver tag + an immutable `sha-<gitsha>` tag, **Trivy-scans** (fail on HIGH/CRITICAL), and prints the `@sha256` digest to the run summary → human copies digests into **`.env.prod`** on VM1 → **`scripts/deploy.sh`** pulls those exact digests, runs migrations, recreates, and verifies. **Prod never builds on host** — it runs the precise digest CI pushed.

📎 **`.github/workflows/release.yml`** (the build/push/scan half):
```yaml
name: Release
# On a version tag: build each image ONCE, push to GHCR with a semver tag
# and an immutable sha-<gitsha> tag, then scan. The digest emitted here is
# what docker-compose.prod.yml pins (see docs/OPS.md).
on:
  push:
    tags: ["v*"]
permissions: { contents: read, packages: write }
env: { REGISTRY: ghcr.io }
jobs:
  build-push-scan:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - { component: gateway,          dockerfile: gateway/Dockerfile,           role: "" }
          - { component: worker,           dockerfile: worker/Dockerfile,            role: "" }
          - { component: client_tracking,  dockerfile: sub-agents/Dockerfile.subagent, role: client_tracking }
          - { component: product_knowledge,dockerfile: sub-agents/Dockerfile.subagent, role: product_knowledge }
          - { component: service_knowledge,dockerfile: sub-agents/Dockerfile.subagent, role: service_knowledge }
          - { component: doc_builder,      dockerfile: sub-agents/Dockerfile.subagent, role: doc_builder }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with: { registry: ${{ env.REGISTRY }}, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - name: Image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/switchboard-${{ matrix.component }}
          tags: |
            type=semver,pattern={{version}}
            type=sha,prefix=sha-
      # Stage 15: bake a read-only source snapshot into the gateway image so the
      # help agent's code_search/code_read see exactly the deployed tree.
      - name: Stage source snapshot (gateway only)
        if: matrix.component == 'gateway'
        run: git archive HEAD --prefix=source-snapshot/ | tar -x
      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          build-args: ${{ matrix.role != '' && format('ROLE={0}', matrix.role) || '' }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: false
      - name: Trivy image scan (fail on HIGH/CRITICAL)
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          image-ref: ${{ env.REGISTRY }}/${{ github.repository_owner }}/switchboard-${{ matrix.component }}@${{ steps.build.outputs.digest }}
          severity: HIGH,CRITICAL
          exit-code: "1"
          ignore-unfixed: true
      - name: Record digest in run summary
        run: |
          { echo "### ${{ matrix.component }}"; echo; echo '```';
            echo "switchboard-${{ matrix.component }}@${{ steps.build.outputs.digest }}";
            echo '```'; echo "Pin this in \`docker-compose.prod.yml\` (via the *_DIGEST env vars)."; } >> "$GITHUB_STEP_SUMMARY"
```

📎 **`scripts/deploy.sh`** (the host side, on VM1):
```bash
#!/usr/bin/env bash
# Deploy (or roll back) the prod stack to a set of pinned image digests.
# Prod never builds on the host — it runs the exact images CI pushed to GHCR.
# Image digests are read from .env.prod (GHCR_OWNER + *_DIGEST).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose --env-file .env.prod -f docker-compose.prod.yml"
echo ">> Pulling pinned images...";      $COMPOSE pull
echo ">> Running database migrations..."; $COMPOSE run --rm gateway_prod_1 alembic upgrade head
echo ">> Recreating services...";         $COMPOSE up -d --remove-orphans
echo ">> Verifying deploy...";            scripts/verify_deploy.sh
echo ">> Deploy complete. Running digests:"; $COMPOSE images
```

**The manual seam that bit us:** the digest hop is **copy-paste by a human** (run-summary → `.env.prod` via `sed`), and GHCR pulls need a *different* identity than `gh` (the `read:packages` PAT, B1b). That hand-off is where deploy friction concentrated.

F3. How did you **verify** a deploy succeeded (health checks, smoke tests)? Ever deploy something broken? `[informs: deploy verification gate]`
**Answer:**
**`scripts/verify_deploy.sh`** runs as the last step of `deploy.sh` — it checks `/health` (reports `version`, `db: ok`, and all 4 sub-agents ok) plus container health. There are also `scripts/smoke.sh` / `smoke_stage1.sh`. A deploy is "verified" when `verify_deploy.sh` is fully green and `/health` reports the expected version.

**Ever deploy something broken? Yes — but the breaks were *below the health check's resolution*:**
- `/health` is **green for the dead help button, the HTMX stub, and the cache-stale CSS** — those are UI/JS-layer failures (C5) that a backend health probe simply can't see.
- A recurring **benign false-negative**: right after recreate, `verify_deploy.sh` prints `FAIL: prod /health unreachable` because Caddy is re-resolving the new gateway replica IPs; waiting for both replicas healthy and re-running goes green (memory `deploy-verify-transient-race`; `STATUS.md` v0.3.5).

So the verification gate caught *infra/contract* breakage reliably and *rendered-UI-actually-works* breakage **never**. The framework needs a verification tier that drives the actual UI (a headless click of the real button), not just an HTTP health endpoint.

F4. What was the **rollback** story when a deploy went bad (e.g., the v0.4.2 hotfix)? `[informs: rollback/SRE]`
**Answer:**
**Rollback = re-pin the previous digests and re-run `deploy.sh`** — the same mechanism as forward deploy, run backwards (`deploy.sh` header: "To roll back, restore the previous digests and re-run."). The discipline that makes it work: **before every deploy, `.env.prod` is backed up to `.env.prod.bak.pre-vX.Y.Z`** (every release in `STATUS.md` records its predecessor backup, e.g. v0.4.2's prior env at `.env.prod.bak.pre-v0.4.2`). Because images are immutable digests in GHCR, restoring the old `.env.prod` + `deploy.sh` reverts to the byte-exact previous release "in minutes" (the Stage-1 rollback drill, `AZURE_GITHUB_SETUP.md` A.7).

**In practice we rolled *forward*, not back.** v0.4.2 itself was a forward hotfix, not a rollback of v0.4.1; the v0.3.1 HTMX and v0.3.10 cache fixes were also roll-forwards. The rollback path was **drilled and ready but rarely the chosen tool** — when a fix is one file and CI is fast, forward-fixing beat reverting. **Migrations are the asterisk:** rollback re-pins images but `alembic upgrade head` already ran; every migration in this build was deliberately **additive** (e.g. `0009`/`0010` server-default columns) specifically so an image rollback doesn't strand the schema. That additive-only discipline is what *made* digest rollback safe.

F5. The D9 GHCR visibility / image-digest tracking — what operational facts about a running deploy did a second agent need to act safely? `[informs: STATUS.md / runtime state]`
**Answer:** Exactly the facts `STATUS.md` carries that `git` cannot — a second agent acting safely needed:
1. **What's actually live** — the current version (`v0.4.2`) and the **deployed `GATEWAY_DIGEST`** (`sha256:f12d37…`), so it knows `main` == deployed.
2. **Where the previous digest is** — the `.env.prod.bak.pre-vX.Y.Z` rollback breadcrumb.
3. **Topology + addresses** — VM1 public IP/FQDN, VM2 private IP (jump-only), 2 gateway replicas.
4. **Where secrets live and that they're *not* in git** — `.env.prod` on VM1 (perms 600), `.env.data` on VM2, and which secret lives in two places (`POSTGRES_PASSWORD`) so you coordinate before rotating.
5. **The nightly-shutdown fact** — "if SSH/health is unreachable, the VMs are deallocated; start them first." Without this a second agent misreads a normal-night outage as an incident.
6. **Coordination protocol** — "coordinate before tagging/redeploying if >1 agent active; update = edit `*_DIGEST` → `deploy.sh`; rollback = restore + re-run."
7. **Known live caveats** — the FAQ volume not in pgBackRest, the transient Caddy verify race, the throwaway `admin` account.

The through-line: **runtime/ops truth lives nowhere in the source tree**, so D6's `STATUS.md` is the artifact that makes a deploy *legible* to anyone who didn't perform it. (See G3 for the full paste.)

---

## G. State & status artifacts (D1, D6)

G1. ⭐⭐ You committed `sdd-output/` (D1) so SDD state synced across machines. What exactly lived in it, and did committing it cause **merge conflicts** in `STATE.md`/`project-state.md` when two agents advanced state? Show a real conflict if you have one. `[informs: state concurrency — THE open question]`
**Answer:**
**What lives in `sdd-output/`** (`.gitignore` has no `sdd-output` entry — confirmed un-ignored, D1): `STATE.md` (machine state — YAML frontmatter: `current_phase`, `completed_roles`, `active_roles`, progress %), `project-state.md` (retrofit current-state analysis), `project-plan.md`, `config.json`, `sdd-flow-divergences.md` (D1–D9), **`stage-instructions/`** (stage-1…14), **`contracts/`** (12 internal interface contracts), **`feature-assessments/`** (5), `design-system.md`, `tester-handoff.md`, `testing-agent-onboarding.md`, `ux-feedback/session-1.md`.

**Did committing it cause conflicts? YES — and `STATE.md` was the exact collision point, just as the open question predicted.** No conflict markers were ever *committed* (clean history), but the conflicts were real and were resolved by **abandoning PRs**:
- **`STATUS.md` v0.3.8 (Stage 13), verbatim:** "#45 merged WITHOUT `--delete-branch` … but retargeting #46 to `main` **still conflicted on `sdd-output/STATE.md`** (its branch carried pre-squash 13A history) — re-homed identically as **#47** (clean delta, STATE.md = worker's latest, CI green)."
- The **Stage 12 twin**: #43 (stacked on #42) auto-closed on the base merge and was re-homed as #44.

So the real-world conflict signature is: **two branches each advanced `STATE.md`, and after a squash-merge the stacked child's `STATE.md` diverged from the new `main`**, producing a conflict that was cheaper to **re-home as a fresh PR** than to resolve in place. The committed history is clean *because* the resolution was "throw away the conflicting PR and re-cut it," not "merge the markers." (Memory: `stacked-pr-delete-branch-gotcha`.)

G2. ⭐ How did you resolve/avoid those state conflicts? Locking? Section-ownership? One agent owns state? Issue-driven? Just careful timing? What actually worked? `[informs: state policy]`
**Answer:** Four mechanisms, in order of how much they actually carried the load:
1. **Single-writer by consolidation (what *actually* worked).** Once D8 collapsed to one machine, **one agent owned `STATE.md`** and concurrent state-writes stopped happening. The conflicts in G1 are all from the *two-machine* window; they vanished structurally when the second writer left. The most effective "policy" was "don't have two writers."
2. **Re-home over resolve.** When a conflict did occur, the working move was to **abandon the conflicting PR and re-cut a clean one** with `STATE.md` = the latest worker value (#43→#44, #46→#47). Cheaper than three-way-merging a state file.
3. **`--delete-branch` discipline.** After the #43 lesson, #45 was merged **without** `--delete-branch` to avoid auto-closing its stacked child — a manual guardrail against the squash-stack trap.
4. **GitHub as the *real* truth (see G4/G5).** Increasingly, "what's done" was read from merged PRs / closed issues / tags, and `STATE.md` was treated as a lagging summary — which *defused* the conflict because nobody depended on `STATE.md` being authoritative-and-current.

**What did NOT exist:** no locking, no section-ownership protocol, no issue-driven state mutex. The honest answer for the framework: **a hand-maintained committed state file is a write-contention hotspot; either make it single-writer or derive it from GitHub (G5).**

G3. ⭐ 📎 You added `STATUS.md` (D6) for runtime/ops state. Paste it (redact secrets). What fields did it hold (live URLs, image digests, secret *locations*, shutdown behavior, coordination notes)? Who/what updated it and how often? `[informs: runtime status artifact]`
**Answer:**
**Fields it holds:** a **TL;DR** of what's live; a **per-release log** (nested `<details>`: version, what shipped, the deployed `GATEWAY_DIGEST`, the `.env.prod.bak.pre-vX` rollback pointer, CI status); **live deployment facts** (VM1 public IP/FQDN, VM2 private IP, Postgres/pgBackRest, Blob account); the **GHCR image digest table**; **secret *locations*** (which file on which VM holds which secret — *names only, never values*); **nightly-shutdown behavior**; **SDD workflow position**; **outstanding/next steps**; **coordination notes**. **Updated by:** the maintainer/deploy agent (this machine), **on every deploy** and whenever runtime facts change — it's the human-readable changelog + runbook in one.

📎 **`STATUS.md` (header + representative slices; secret *values* never appeared in it to begin with — only locations):**
```markdown
# Switchboard — Project Status & Handoff
**As of:** 2026-06-06

## TL;DR
The app is deployed and live on a hardened two-VM Azure stack, now running v0.4.2 —
the in-app help agent (Stage 15, #51) is ENABLED. ... /health reports version: 0.4.2,
all 4 sub-agents ok; /help + /help/issues 401 for anon. CI green. main == deployed.

> ⚠️ FAQ volume not backed up. help_kb_prod ... not covered by pgBackRest — same gap
>   as the retained artifact bytes.
> 👀 Live eyeball still useful: drive the help tools end-to-end once ...

## ✅ Live version: v0.4.2 (deployed 2026-06-06) — help-agent button hotfix
GATEWAY_DIGEST re-pinned on VM1 to
  sha256:f12d37a7e30feff2ff3886c601a4fce14fc28b4a4663b102a167f64cef8928fa
(prior v0.4.1 env saved at .env.prod.bak.pre-v0.4.2).
[v0.4.2 hotfix narrative ...]
<details><summary>Previously shipped in v0.4.1 — help agent ENABLED</summary> ... </details>
<details><summary>Previously shipped in v0.4.0 — in-app help agent (#51, DARK)</summary> ... </details>
[... nested <details> back through v0.3.0 ...]

## Live deployment (NOT in git — operator/runtime state)
Both VMs are powered off nightly to save cost (up on weekends).
### VM2 — data host (private only)
- Private IP 10.0.2.4 (static). No public IP — reach only via VM1 (ProxyJump).
- Postgres 16 + pgBackRest. PITR live; Blob account swbsmahoney / container pgbackrest.
### Images — GHCR (ghcr.io/smahoney-specdev/switchboard-*)
| component | digest |
| gateway | sha256:27cc05a1... |  [full 6-row table]
### VM1 — app host
- Public IP 135.119.65.172, FQDN switchboard.centralus.cloudapp.azure.com.
- 2 gateway replicas + worker + 4 sub-agents behind Caddy (Let's Encrypt).

### ⚠️ Secrets are NOT in git — they live only on the VMs
- VM1 /opt/switchboard/.env.prod: POSTGRES_PASSWORD, JWT_SECRET, SESSION_SECRET,
  ANTHROPIC_API_KEY, the six *_DIGEST, GHCR_OWNER=smahoney-specdev.   [NAMES ONLY]
- VM2 .../.env.data: POSTGRES_PASSWORD (must match VM1's), PGBACKREST_* keys.
- coordinate before rotating (e.g. POSTGRES_PASSWORD lives in two places).

## Coordination notes
- Single-machine now. ... Multi-agent stays available on demand (fork/branch→PR→CI→merge).
- VMs are off most nights. If unreachable, start them in Azure first (VM2 jump via VM1).
- sdd-output/ IS tracked in git (un-ignored, D1). Keep this STATUS.md current as the
  shared runtime source of truth.
```
(Redaction note: `STATUS.md` already stored secret *locations*, never values — so nothing needed stripping. That discipline is itself a finding: the runtime-state artifact must be a *map to* secrets, never a copy of them.)

G4. Was the SDD role/phase state (`STATE.md`) genuinely useful across machines, or did it drift / get ignored in favor of GitHub (issues/PRs) as the real source of truth? `[informs: state policed-vs-derived]`
**Answer:**
**It drifted and was increasingly ignored in favor of GitHub + `STATUS.md`.** Hard evidence of drift: at interview time `STATE.md` reports `current_phase: 1 - Design`, `completed_roles: 4 of 9 (44%)`, `last_updated: 2026-06-04` — while the app is **deployed, live at v0.4.2, on its 15th stage with 50 merged PRs.** `STATE.md` says "Design, 44%"; reality is "shipped to prod 18 times." It froze around Stage 14 and the real world ran far ahead.

What people *actually* trusted: **merged PRs (what's built), closed issues (what's fixed), git tags (what's released), and `STATUS.md` (what's live).** `STATE.md`'s machine-fields (phase %, role checklist) were the *least* load-bearing artifact in the repo by the end. Its *static* children — `stage-instructions/`, `contracts/`, `feature-assessments/` — stayed valuable (they're specs, not state), but the *mutable* `STATE.md`/`project-state.md` rotted. **Clear signal for G5.**

G5. If you had to pick: should "what's done" be read from a committed **file**, or **derived** from GitHub (merged PRs / closed issues / CI status)? Why? `[informs: state architecture]`
**Answer:**
**Derive "what's done" from GitHub; keep committed files only for things GitHub can't represent.** The evidence is one-sided:
- The committed mutable-state file (`STATE.md`) **drifted to 44%/"Design" while prod shipped 18 releases** (G4) — a hand-maintained progress file is a lie waiting to happen.
- The GitHub-derived facts never lied: a merged PR *is* built, a closed issue *is* fixed, a tag *is* released, an 8/8 CI run *is* green. They're append-only, timestamped, and updated by the act itself — zero extra write step, zero contention (which is also the G2 fix: derived state can't have a merge conflict).

**But two things must stay as committed files** because GitHub can't derive them:
1. **Runtime/ops truth** (`STATUS.md`) — the deployed digest, VM addresses, secret locations, nightly-shutdown. GitHub knows nothing about your VMs.
2. **Specs/intent** — `stage-instructions/`, `contracts/`, `feature-assessments/`, the divergences log. These are *design inputs*, not *progress*, and they were the durable, useful part of `sdd-output/`.

**Framework recommendation:** make the SDD "state" a **projection** computed from GitHub (PRs/issues/tags/CI) at read time — never a file an agent has to remember to update — and reserve committed artifacts for *runtime facts* and *specs*. That kills both the drift (G4) and the state-merge-conflict open question (G1/G2) in one move.

---

## H. Multi-agent / multi-machine coordination (D2, D7, D8, D9)

H1. ⭐⭐ Describe a real handoff between two agents start to finish. (E.g., D9: handoff brief in `docs/handoff/` → feature-worker authored PR #51 → this machine reviewed/merged/deployed.) What were the exact coordination touchpoints? `[informs: handoff primitive]`
**Answer:** The D9 help-agent handoff, end to end, with the exact touchpoints (all git-mediated, no live channel):
1. **Spec authored** (this machine) → committed `docs/handoff/feature-help-agent.md` to `main` — a 246-line brief: what to build, **settled decisions ("do NOT re-litigate")**, the build plan, the security checklist, the deploy notes, and orienting pointers. **Touchpoint = a file on `main`.**
2. **Worker picks it up** on its own machine: `git pull`, reads the brief + (per its instructions) `STATUS.md` then `docs/ARCHITECTURE.md`. **Touchpoint = `git pull`.**
3. **Worker builds in isolation** on `sdd/stage-15-help-agent`: implemented the gateway chat mode + 4 read-only tools + routes + UI + **47 tests**, kept CI green. **Touchpoint = a pushed branch.**
4. **Worker opens PR #51** → `main`, body summarizing the security invariants. **Touchpoint = the PR + its CI run (8/8).**
5. **This machine reviews** every security invariant against source (registry split, log caller-scoping non-widenable, path confinement, draft-not-autonomous), **merges** (squash), **bumps version, tags `v0.4.0`, builds images, deploys dark, then v0.4.1 enable, v0.4.2 hotfix**, updates `STATUS.md`. **Touchpoint = merge + tag + deploy + STATUS.md.**
6. **Loop closes** when a *user* files **issue #52** *through the very feature that was handed off* — the help bot drafting its own first real GitHub issue.

The handoff primitive = **{spec file on main} → {git pull} → {isolated branch} → {PR + CI} → {review + merge + tag + deploy} → {STATUS.md}.** Nothing synchronous; the brief + the PR were the entire contract.

H2. ⭐ What was the **entire** coordination surface between agents? (Just git + PRs + issues + CI? Anything else — chat, shared docs, the operator relaying messages?) `[informs: coordination bus]`
**Answer:** The coordination surface was **git and only git-adjacent GitHub primitives**, plus one human:
- **Tracked files on `main`** — `sdd-output/` (specs/state, D1), `docs/handoff/` (briefs), `STATUS.md` (runtime truth, D6). This is the bulk of the bus.
- **GitHub Issues** — the async defect/work channel (D2), with `correlation_id` as the cross-service trace key.
- **Pull Requests + CI** — the integration + signal channel (D3); the PR body is how a worker explains its change to the reviewer.
- **Git tags** — the release signal.
- **The operator (human)** — the *only* out-of-band channel, and only for things no agent can do: powering the VMs on/off, provisioning Azure/GitHub, holding secrets, relaying "they're up now" (D5/J).

**No chat, no shared doc service, no message queue, no ticket system beyond Issues.** Everything an agent needed to act was reconstructable from `git pull` + the GitHub API. That's the key framework property: **the coordination bus is the repo itself**, which is why the "rejoin with zero setup" claim (H5) holds.

H3. ⭐ What **collisions/races** actually happened with 2+ agents (both editing `main`, both touching state, branch stomping)? How bad, how often? `[informs: conflict policy]`
**Answer:** Concrete, bounded, and all clustered at one fault line — **`sdd-output/STATE.md` under stacked PRs**:
- **#43 → #44** (Stage 12) and **#46 → #47** (Stage 13): a stacked child PR auto-closed when its base was squash-merged with `--delete-branch`, and the child's `STATE.md` then conflicted with the new `main`. **Frequency: twice.** **Severity: low-moderate** — no data loss, but each cost a full PR re-cut ("re-home identically as #N+1").
- **The `--delete-branch` auto-close** itself (squash a base → child loses its base → GitHub closes it) — same root, memory `stacked-pr-delete-branch-gotcha`.
- **`/sdd:merge` direct-to-main** (Stage 14, no PR) — not a *race* but a discipline gap that *could* have collided with an in-flight PR; it didn't, because by then it was single-machine.

**What did NOT happen:** no two agents fixed the same bug simultaneously (issues weren't formally "claimed," I2, but the two-machine split — tester files, builder fixes — kept lanes separate); **no conflict markers ever reached a commit** (the resolution was always "abandon + re-cut," G1). So the real conflict policy that emerged was **"single-writer + re-home over resolve,"** and the contention surface was specifically *the mutable committed state file* — exactly what G5 proposes to delete.

H4. The build-vs-test machine split (D7) and its later relaxation (D8): what did the strict "tester writes no code, output = issues only" wall buy you, and what did relaxing it cost/save? `[informs: role-to-agent assignment]`
**Answer:**
**What the wall bought (D7):** **independent verification.** A tester who can't touch code can't rationalize a bug away or "just quick-fix" it — they have to *reproduce it precisely and write it down*. The fruit is visible: PRs #7–#19 are a clean wave of tester-found, builder-fixed defects (login JSON leak #7, `/metrics` exposure #9, ingest-never-persists #13, dropped `text://` refs #14), each a well-formed issue → a focused fix PR. The wall also forced the **structured bug template** (I1) and the **`correlation_id` discipline** — because the only way to hand a bug across the wall was a report good enough to act on blind. That rigor is the wall's real product.

**What relaxing it (D8) cost/saved:** **Saved** — turnaround. Find→fix→deploy collapsed into one loop; no issue round-trip for a one-line fix. **Cost** — the loss of the independent eyeball is *exactly* the C5 failure mode: the dead help button, the cache-stale UI, the HTMX stub all slipped through *after* consolidation, because the same agent that built it also "tested" it and shared its blind spots. The wall's discipline (test from the user's side, not the author's) is what would have caught them.

**Framework lesson:** the wall is **a role boundary worth preserving even within one agent** — "now act purely as an adversarial end-user who cannot see or edit the code" as a distinct, enforced phase. Don't tie the *role separation* (valuable) to *machine separation* (incidental).

H5. ⭐ For the **rejoin path** (D8/D9: a new agent joins via fork/branch → PR → merge with no setup change) — did it truly require zero setup? What did the joining agent need to read first to be productive (the handoff brief? STATUS.md? the arch doc?)? `[informs: opt-in multi-agent recipe]`
**Answer:**
**Nearly zero — with two honest asterisks.** What *was* zero: no SDD re-init, no state migration, no process change — because the machinery (tracked `sdd-output/`, Issues, PR+CI) was already in the repo (D8's whole thesis, D9's proof). A joining agent does `git clone`/`pull`, branches, opens a PR, and CI runs. The reading path is explicitly designed and **ordered** in `docs/handoff/README.md` §1: **(1) `STATUS.md` (what's live) → (2) `docs/ARCHITECTURE.md` + `REQUEST_FLOW.md` (how it works) → (3) the handoff README (the working loop + file map) → (4) the specific `docs/handoff/<feature>.md` brief.** `feature-help-agent.md` repeats that orientation list at its foot. So "what to read first" is a *solved, written* problem — that's the real enabler.

**The two asterisks (not zero):**
1. **Secrets/credentials are out-of-band.** The repo is private; a joining agent needs clone access (a PAT/SSH key per `docs/NEW_SUBAGENT_KICKOFF.md`), and *deploying* needs the GHCR `read:packages` PAT + the VM secrets that live only on the boxes. **Building/PR-ing = zero setup; deploying ≠ zero setup.**
2. **The running environment isn't in the repo.** The VMs being off-most-nights, the digest currently live, the secret locations — a joiner learns these *only* from `STATUS.md`, which is exactly why D6 exists. Without that file, "rejoin" would not be productive.

So the accurate claim: **contributing code is genuinely zero-setup; operating the deployment requires the operator-held secrets + STATUS.md context.** The framework should make the **reading-order manifest** a first-class scaffold artifact — it's what turned "rejoin" from aspiration into the D9 reality.

H6. Where did `docs/handoff/` live and what was in a handoff brief? 📎 Paste one. Why `docs/handoff/` rather than `sdd-output/`? `[informs: handoff artifact]`
**Answer:**
**Location:** `docs/handoff/` on `main` — `README.md` (agent quickstart + repo map + working loop) plus one brief per feature: `feature-help-agent.md`, `feature-client-hub.md`, `feature-artifact-explorer.md`, `feature-ui-design-refresh.md`, `issue-20-client_tracking-csv-mapping.md`.

**Why `docs/handoff/` not `sdd-output/`:** a deliberate split of **human-readable intent** from **SDD machine state.** `sdd-output/` is the SDD tool's own tree (STATE.md, stage-instructions, contracts) — structured for the workflow engine. A **handoff brief is prose for a human/agent picking up a feature cold**: it re-litigates nothing, states settled decisions, points at files. Keeping briefs in `docs/` means they read as project documentation (and a joining agent reads `docs/` first, H5) rather than as SDD internals. The divergences doc notes briefs reach the other machine "via `docs/handoff/` on main since `sdd-output/` is [historically] the SDD tool's space."

📎 **`docs/handoff/feature-help-agent.md` (structure + the load-bearing sections):**
```markdown
# Handoff — Feature: In-App Help Agent ("Ask for help")
**For:** the feature agent picking this up via /sdd:feature.
**Components:** gateway only. The four domain sub-agents and the frozen
  /health·/invoke·/ingest contract are untouched.

## What we're building
A help icon in the header → a help chat: same chat surface/streaming, different
system prompt + a deliberately restricted, read-only toolset. [+ can/cannot list]

## Scope decisions already settled (do NOT re-litigate in clarify)
1. One feature, one /sdd:feature flow. Gateway-only.
2. Placement = a new gateway chat MODE, not a new sub-agent.
3. Source access = a baked-in read-only SNAPSHOT (git archive HEAD), not live GitHub.
4. GitHub issues = user-confirmed draft (human-in-the-loop).
5. Log/data scope = the caller's own activity only.
6. The FAQ is a markdown file the agent reads and appends to.

## Why this maps cleanly onto what exists
[run_chat_turn + system_prompt.py + tools.py: same loop, different prompt + tools]

## Build plan (single flow, logical order)
1. Session kind  2. Help system prompt  3. The four help tools (code_search/_read,
   log_query [ALWAYS WHERE user_id=caller], kb_read/kb_append, github_open_issue=draft)
4. GitHub issue — draft + confirm (POST /help/issues, auth+label+ratelimit+redact)
5. UI (? icon, help banner, draft card)

## Secrets & infra (call out in deploy notes)
- New secret: a dedicated fine-grained PAT scoped issues:write (HELP_GITHUB_TOKEN);
  do NOT reuse the exposed classic PAT; VM-only, never in git.
- Source snapshot at build: git archive HEAD (tracked files only → secrets excluded).
- FAQ volume: writable persistent gateway volume; NOT covered by pgBackRest.

## Security checklist (the reviewer will look for these)
[help gets ONLY the 4 tools; path-confine code_read; log_query non-widenable caller
 scope; kb_append size/secret guards; github_open_issue never POSTs; same auth as chat]

## Out of scope (don't build now)
[no code-edit/PR-open; no FAQ curation UI; no live GitHub browsing; no cross-user logs]

## Tests to expect (so CI's 8 checks stay green)
[registry-split, traversal reject, caller-scoping, draft-no-network, HTML-escape, migration]

## Pointers
Orient via docs/handoff/README.md → STATUS.md → docs/ARCHITECTURE.md / REQUEST_FLOW.md.
Chat loop & prompt: claude_loop.py, system_prompt.py, tools.py. ...
Deploy = bump version.py, tag, build, re-pin GATEWAY_DIGEST, scripts/deploy.sh.
```
The brief's most reusable feature is the **"settled decisions — do NOT re-litigate"** section: it's what let an independent worker build the *right* thing without a clarification round-trip. That's the single highest-leverage element of the handoff primitive.

---

## I. Issues as the work-item / defect channel (D2)

I1. ⭐ 📎 Paste your bug-report issue template(s) from `.github/ISSUE_TEMPLATE/`. What fields/labels made an issue actionable by a *different* agent than the one who filed it? `[informs: defect channel]`
**Answer:** Two files: `bug_report.yml` and `config.yml`. The actionability comes from **structured, required fields + the `correlation_id` trace key + a `filed_by` provenance field**, and auto-labels `bug`, `needs-triage`.

📎 **`.github/ISSUE_TEMPLATE/bug_report.yml`:**
```yaml
name: "Bug report"
description: "A defect found during testing or use. Filed by a testing agent/operator; picked up by a build agent."
title: "[bug] "
labels: ["bug", "needs-triage"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for filing. This repo is worked by multiple agent systems —
        a clear, structured report lets a build agent reproduce and fix without
        a back-and-forth. The correlation_id is the most valuable field: it
        traces one request across the gateway, sub-agents, and Postgres `logs`.
  - type: textarea
    id: summary
    attributes: { label: Summary, description: "One or two sentences — what's wrong." }
    validations: { required: true }
  - type: dropdown
    id: area
    attributes:
      label: Area / component
      options:
        - gateway (chat / loop / auth)
        - client_tracking (sub-agent)
        - product_knowledge (sub-agent)
        - service_knowledge (sub-agent / stub)
        - doc_builder (sub-agent / stub)
        - worker (async jobs)
        - caddy / TLS / networking
        - database / migrations
        - login / sessions
        - UI / rendering
        - other / unsure
    validations: { required: true }
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - blocker (cannot use the app)
        - high (core flow broken, no workaround)
        - medium (broken with a workaround)
        - low (cosmetic / minor)
    validations: { required: true }
  - type: textarea
    id: steps
    attributes: { label: Steps to reproduce, description: 'Numbered, from a known state (e.g. "logged in as X").' }
    validations: { required: true }
  - type: textarea
    id: expected
    attributes: { label: Expected result }
    validations: { required: true }
  - type: textarea
    id: actual
    attributes: { label: Actual result, description: "What happened instead. Include any error text verbatim." }
    validations: { required: true }
  - type: input
    id: correlation_id
    attributes:
      label: Correlation ID
      description: >-
        If visible (response header X-Correlation-ID, or surfaced in the UI).
        A build agent can then query the logs table for the full cross-service trace.
      placeholder: "00000000-0000-0000-0000-000000000000"
  - type: input
    id: environment
    attributes: { label: Environment, description: "URL + browser/client, and roughly when (UTC helps)." }
    validations: { required: true }
  - type: textarea
    id: evidence
    attributes: { label: "Logs / screenshots (optional)" }
  - type: input
    id: filed_by
    attributes:
      label: Filed by
      description: Which machine / agent system found this.
      placeholder: "testing machine (handoff)"
```
📎 **`config.yml`** routes readers to the cross-machine context before they file:
```yaml
blank_issues_enabled: true
contact_links:
  - name: Project status & cross-machine handoff
    url: https://github.com/smahoney-specdev/Switchboard/blob/main/STATUS.md
    about: Current deployment state, what's done vs pending, and coordination notes.
  - name: SDD flow divergences
    url: https://github.com/smahoney-specdev/Switchboard/blob/main/sdd-output/sdd-flow-divergences.md
    about: How this project bends the standard SDD pipeline — read before changing process.
```
**The cross-agent actionability levers:** `correlation_id` (turns a vague report into a precise `logs`-table query across services — the template literally calls it "the most valuable field"); required `area`/`severity` dropdowns (triage without a conversation); required `steps`/`expected`/`actual` (reproduce blind); and `filed_by` (provenance — which machine found it). Help-bot-filed issues additionally carry the forced `help-bot` label (#52).

I2. ⭐⭐ How did a build agent **claim** an issue so two agents didn't fix the same thing? (Assignment? a label like `in-progress`? opening a draft PR immediately?) Did duplicate-work races still happen? `[informs: issue claiming — open question]`
**Answer:**
**There was NO formal claim mechanism — and this is an admitted open question, not a solved one.** Hard evidence: across all 14 issues, **`assignees` is empty on every single one**, and the only labels in use are `bug`/`enhancement`/`needs-triage`/`ui`/`help-bot` — **no `in-progress`/`claimed` label exists.** `sdd-flow-divergences.md` "Open questions" lists it verbatim: *"How a build agent should **claim** an issue (assignment/labels) to avoid two agents fixing the same thing."*

What *actually* prevented duplicate work was **structural, not procedural**:
- The **two-machine lane split** (D7): the tester *filed*, the builder *fixed* — only one agent was ever in "fix" mode, so claiming was moot.
- After **D8** it's single-agent, so contention is impossible by construction.
- The closest thing to a claim was **the fix PR itself** — opening `fix/issue-N-…` with `Closes #N` is the de-facto "I'm on it," but it happens at *fix* time, not *intake* time, so a true race window exists in theory.

**Did races happen? No observed duplicate-fix race** — but only because there was never genuine concurrent fixing, not because a mechanism stopped it. **For the framework this is a real gap to design:** intake-time claiming (assignee + `in-progress` label, or auto-draft-PR on claim) is needed the moment two agents *fix* concurrently, which this build never sustained.

I3. What was an issue's **lifecycle** (open → labeled → claimed → PR → closed)? Was it automated or manual? `[informs: work-item lifecycle]`
**Answer:** Lifecycle in practice: **open (auto-labeled `bug`+`needs-triage` by the template) → [no claim step] → fix PR with `Closes #N` → squash-merge auto-closes the issue.** Partly automated, partly manual:
- **Automated:** label-on-create (template `labels:`); **issue auto-close on merge** via `Closes #N` in the PR (`README.md` §5).
- **Manual:** triage (reading `needs-triage`), prioritization, the (absent) claim, and **batching** — many issues were grouped into one PR (#35 closed #34/#27/#24; #36 closed #33/#29/#28). The `needs-triage` label was applied automatically but I saw **no evidence it was ever systematically *removed*** post-triage — it's a stuck label, suggesting the triage *transition* was informal. Closure timestamps confirm tight loops (e.g. #21 opened 13:49, closed 14:27 same day). So: **lightweight, GitHub-native, with auto-label + auto-close as the only real automation; everything between was agent judgment.**

I4. Did you link issues ↔ PRs ↔ stages? How did you know which issues belonged to which stage/release? `[informs: traceability]`
**Answer:** **Yes, via three conventions — all textual, none tooled:**
- **Issue ↔ PR:** `Closes #N` in PR bodies/titles (e.g. PR #23 "fix(#21)", PR #32 "closes #6", PR #39 "closes #20"). Strong, GitHub-native bidirectional link.
- **PR ↔ stage:** the PR title/branch carries the stage (`sdd/stage-15-help-agent`, "Stage 10 — Admin role"), and `sdd-output/stage-instructions/stage-N-instruct.md` + `feature-assessments/` name the PRs/issues a stage subsumes.
- **Stage/issue ↔ release:** **`STATUS.md` is the join table** — each release `<details>` block lists exactly which PRs/issues/stage it shipped (v0.3.3 = "#34/#27/#24 + #33/#29/#28", v0.4.0 = "#51 / Stage 15"). That's how you answer "which issues are in v0.3.3."

**The gap:** no GitHub **Milestones** and no **Projects** board were used (0 milestones observed) — so "which issues belong to release vX" is reconstructable only by *reading `STATUS.md` prose*, not by querying GitHub. Traceability was excellent **in committed text** and **absent in GitHub's native grouping primitives.** A framework could get this for free with Milestones-per-release.

I5. Besides bugs, did issues carry other work types (features, chores, tech-debt like the async-fixture debt in #6)? Did they need different templates/handling? `[informs: work-item types]`
**Answer:** **Yes — issues carried at least four work types, but there was only ONE template (bug).** Evidence by label/content:
- **Bugs** — `bug` label, the template (#7,#9,#13,#14,#21,#24,#34…).
- **Enhancements** — `enhancement` label (#27,#28,#29,#52) — filed as bugs-by-template or blank issues.
- **Tech-debt** — **#6** ("gateway-tests async test-harness repair") — no special label, carried as a plain issue; it's the most consequential non-bug (blocked "CI green," took from filing to PR #32 to close).
- **Help-bot-surfaced UX** — **#52** (`help-bot`+`ui`+`enhancement`), filed *by the app itself*.

**Did they need different handling?** In practice they got the *same* lightweight handling and it mostly worked — but two seams showed: (1) `enhancement`s and tech-debt were **squeezed through a bug-shaped template** (`steps/expected/actual` don't fit "add CSV export"), so those fields were often empty/awkward; (2) **tech-debt like #6 has no "definition of done" a bug template captures** — "make CI green" is a state, not a repro. `config.yml` *does* enable blank issues, which absorbed the misfits. **Framework rec:** distinct templates for `bug` / `feature` / `chore-techdebt`, since their actionability fields differ (repro vs acceptance-criteria vs exit-state).

---

## J. Operator / human-in-the-loop handoff (D5)

J1. ⭐ 📎 What could the agent **not** do that required a human operator? (D5: Azure/GitHub provisioning — subscriptions, VMs, NSGs, DNS, GHCR visibility, branch protection, secrets.) Paste or summarize `docs/AZURE_GITHUB_SETUP.md`. `[informs: Deployer operator-runbook]`
**Answer:** Everything that lives in the **cloud/control plane or holds a secret** — `docs/AZURE_GITHUB_SETUP.md` is the explicit "things you must do by hand" runbook, organized as a per-stage "your action" checklist. Summary of what only the human could do:

- **GitHub (unblocks Stage 1):** enable Actions; **branch protection** (the 8 contexts — blocked by the free plan, B5); secret scanning/push protection; set the `ANTHROPIC_API_KEY` repo secret; make GHCR packages private + grant VM1 pull access; push the **first release tag**; run the **rollback drill**.
- **Azure foundation:** create RG `switchboard-prod`, VNet `10.0.0.0/16` + app/data subnets, **two NSGs** (the allow/deny table — Internet→VM1:443 ✅, anything→VM2:5432 ❌ except VM1 subnet), **two VMs** (sized, Docker installed), **Storage account + Blob** `pgbackrest`, **DNS + TLS** (point FQDN at VM1, Caddy auto-provisions Let's Encrypt).
- **VM2 (Postgres+PITR):** write `.env.data` secrets, edit `pgbackrest.conf`/`pg_hba.conf`, `stanza-create` + first backup, install cron, negative-test that `:5432` is unreachable off-VM1.
- **VM1 (app):** write `.env.prod` (digests + **all secrets**: `JWT_SECRET`/EdDSA keys, `SESSION_SECRET`, `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`), `caddy/.env`, `docker login ghcr.io`, run `deploy.sh`, bootstrap first admin, install cron.
- **Monitoring/secrets (optional):** Alertmanager channel, EdDSA cutover, optional Key Vault.

📎 **The two artifacts that make this an operator runbook (verbatim shape):** a **NSG allow/deny table**, and a **per-stage "your Azure/GitHub actions" checklist** mapping each SDD stage to its human prerequisites (Stage 1 → "Enable Actions; branch protection; push protection; ANTHROPIC secret; GHCR; first tag; rollback drill"; Stage 2 → "VM2 + subnet + NSG; storage/Blob; stanza-create; first backup; …"; etc.). The doc's framing is the key idea: *"the hardening work shipped all the code/configs/migrations/CI/runbooks; the steps here live in **your** Azure subscription and GitHub org, which cannot be done from the repo."*

**The recurring operator action the runbook *didn't* anticipate:** **powering the VMs on** (they're off most nights) — that became the most frequent human touchpoint (J3), more than the one-time provisioning.

J2. How was a "blocked on you" handoff to the human communicated and tracked, and how did the agent **resume** once the human finished? `[informs: blocked-on-human work-item]`
**Answer:**
**Communicated:** in two registers — the **durable** one is `docs/AZURE_GITHUB_SETUP.md` (a written "you must do this by hand" checklist) and the **"Outstanding / next steps"** + "blocked" notes in `STATUS.md`; the **ephemeral** one was the **live chat turn** ("the VMs are off — please start them," answered by the user's "they're up now."). **Tracked:** loosely — partly as `STATUS.md` checklist items (e.g. "Branch protection — apply once on Pro," "Rotate the GitHub PAT," "Delete the throwaway admin"), partly as the runbook's per-stage table. **Not** tracked as GitHub Issues with a `blocked-on-human` label (a gap).

**Resume:** **conversational and immediate** — the agent waited (the build literally paused on "VMs powered off," resumed the deploy the moment the user said "they're up now"). There was no automated "human done → agent continues" trigger; resumption was the human handing control back in the next turn. **Framework rec:** model "blocked on human" as a **first-class work-item with an explicit unblock signal** (a labeled issue, or a checklist item the human checks), so resume isn't dependent on a synchronous chat presence — especially given the nightly-shutdown rhythm makes human-blocking *routine*, not exceptional.

J3. How often did human-blocking happen, and was it concentrated in deploy, or scattered throughout? `[informs: where to place operator gates]`
**Answer:**
**Two distinct distributions:**
- **One-time, concentrated at the *front* (provisioning).** The entire `AZURE_GITHUB_SETUP.md` surface — subscription, VNet/NSGs, VMs, Blob, DNS/TLS, secrets, GHCR visibility — is a **bring-up burst** that happened once (Stage 1–3 era, ~2026-05-29) and then essentially never recurred. Heavy but front-loaded.
- **Recurring, concentrated at *deploy/operate*.** The persistent human gate is **powering the VMs on** (off most nights) — this recurred *every deploy session* and is the most frequent block by far. Plus a few standing human-only chores that never auto-resolved (branch protection needs a *plan upgrade*; PAT rotation; deleting the throwaway `admin`; the GHCR-owner login).

**Not scattered through *build*** — coding/testing/PR/merge were fully agent-autonomous; almost zero human-blocking touched the inner loop. So the operator gates belong in exactly two places: **a one-time provisioning gate before Stage 1**, and a **recurring "environment available?" pre-check at the head of every deploy** (start-the-VMs). Placing operator interaction anywhere in the build loop would be misallocated — that's the empirical pattern.

---

## K. Testing approach

K1. ⭐ How was testing organized — unit / integration / end-to-end / pipeline tests? Who wrote them (builder vs a separate tester)? `[informs: Tester roles]`
**Answer:** **Three automated tiers + a human exploratory tier**, split across the two-machine roles:
- **Unit** — `gateway/tests`, sub-agent `tests` (`-m "not integration"`). Fast, no live deps. Written by the **builder** alongside the code.
- **Integration** — Postgres-backed (`@pytest.mark.integration`, `INTEGRATION_DB_URL`, a CI Postgres service + `alembic upgrade head`). Builder-written.
- **Contract** — the Stage-9 **frozen-v1 conformance** suite (`-k "contract or stub_endpoints"`), run per sub-agent; asserts `/health·/invoke·/ingest` shapes + JWT + envelope. Builder/architect-written; this is the test tier that *protected the architecture*.
- **End-user / exploratory (human)** — the **testing machine** (D7) drove the live app and filed Issues; produced `sdd-output/ux-feedback/session-1.md`, `tester-handoff.md`, the v0.2.1 re-verification pass (`STATUS.md`).

**No automated E2E/browser tier existed** — and that's the gap that maps 1:1 onto the C5 "rendered-UI-broke" failures. "End-to-end" was a *human* clicking, not Playwright/Selenium. Builder wrote tiers 1–3; a separate tester owned tier 4 until D8 merged the roles (and the eyeball weakened, H4).

K2. The CI test problems from D4 (colliding `conftest.py`, no `DB_URL`, missing migration step, async-fixture debt): root cause — test design, environment setup, or the build agent never running tests in a CI-like way? `[informs: test gate]`
**Answer:** **Overwhelmingly "the build agent never ran the tests in a CI-like way"** — the same root as C3. Decomposed:
- **No `DB_URL` / missing migration step** → **environment setup**, but *caused by* never having executed the suite against a clean ephemeral DB. Tests passed locally against a developer's already-migrated, env-populated Postgres; nobody had run them where `DB_URL` is unset and the schema is empty — i.e. CI.
- **Colliding `conftest.py`** → **test design** (two suites both ship `tests/conftest.py` → `ImportPathMismatchError` under one pytest process) — but again only *surfaced* by running them together in one CI invocation.
- **async-fixture debt (#6)** → **test design** (event-loop scoping, shared rate-limiter/registry state across tests) — and it had hidden a *real* prod bug (`auth_sessions.ip` INET rejecting `"unknown"`), proving the suite had never honestly run.
- **`env.py +asyncpg`** → a latent config bug, never exercised because migrations were never run fresh in CI.

**Unifying root cause:** **"tests exist and pass on my machine" ≠ "tests pass in a clean, reproducible, schema-from-zero environment."** Every individual failure is downstream of that. This is the single strongest argument for D4's gate ("done = green in CI") **and** for C3's walking skeleton (wire the CI-like environment *first*, so this class can't accumulate across 9 stages).

K3. Did you do **handoff / end-user (UX) testing** distinct from automated testing (D7's testing machine)? What did it produce and how did findings flow back (issues)? `[informs: Handoff Tester]`
**Answer:** **Yes — a distinct, productive human UX tier.** It produced:
- **GitHub Issues** as the primary artifact (the D2 channel) — the #7–#19 wave and the later #20/#21/#24/#27/#28/#29/#33/#34, each via the structured template with `correlation_id` + `filed_by`.
- **`sdd-output/ux-feedback/session-1.md`** — a Handoff Tester UX session (Stage 14).
- **`sdd-output/tester-handoff.md` / `testing-agent-onboarding.md`** — the onboarding + re-verification protocol, including the **8/8 re-verification pass of v0.2.1** documented in `STATUS.md` (each prior fix re-driven on the live app) plus an exploratory pass that found **new** issues #20/#21.

**Flow-back path:** live app → tester reproduces → files Issue (with the cross-service `correlation_id`) → builder queries `logs` by that id → fix PR `Closes #N` → deploy → tester **re-verifies on live**. That round-trip (esp. the *re-verify-after-deploy* step) is exactly what consolidation (D8) weakened, and its absence is visible in the C5 hotfixes. The Handoff Tester role produced the highest-signal defects in the whole project; the framework should keep it as a **named role with a re-verify-on-live obligation**, even if one agent plays it.

K4. What did "the pipeline is tested" concretely mean before you'd deploy? `[informs: pre-deploy gate]`
**Answer:** Concretely, the pre-deploy bar was: **(1) all 8 CI checks green on the merge commit** (lint, secret-scan, gateway-tests, 2× subagent-tests, 3× contract-tests); **(2) `release.yml` built all 6 images and Trivy passed** (no HIGH/CRITICAL); then **(3) `deploy.sh` ran migrate→up→`verify_deploy.sh`** and `/health` reported the expected version + `db: ok` + 4 sub-agents ok. That's "tested" for the *pipeline/infra*.

**What it did NOT mean:** "a human confirmed the feature visibly works in the browser." There was **no pre-deploy UX gate** — and that's precisely the resolution gap behind every C5 hotfix. So the honest answer: "the pipeline is tested" meant **the build, the contracts, and the health surface are green** — a strong bar for *backend correctness* and a *blind* one for *rendered behavior*. The missing pre-deploy gate the framework should add is a **smoke-the-actual-UI step** (drive the real button), not just `curl /health`.

---

## L. Workflow reality: sequencing, loops, mid-stream change

L1. ⭐ Did real work follow a clean linear order (vision → architect → plan → build → test → deploy), or did it interleave/loop/backtrack? Where did the linear model break? `[informs: graph vs reality]`
**Answer:** **It did not follow the linear order — and the breaks are systematic, not incidental.** The clean line broke in at least four ways:
1. **Started mid-graph.** This was an *existing project* (v0.1.0 already running) retrofitted — so "vision/architect/plan" ran as a **Retrofit Planner** *after* code existed (`project-state.md`, `STATE.md` path="existing"). Build preceded plan.
2. **Deploy interleaved with build, not after it.** There wasn't one "deploy phase" — there were **18 deploys** threaded through building. Build-a-bit → tag → deploy → find-a-bug → fix → deploy was the actual rhythm. CI/CD was the *spine the whole time*, not a terminal stage.
3. **Test ↔ fix ↔ deploy looped tightly** — the #7–#19 wave, the v0.2.1 re-verify, the C5 hotfixes are all loops *back* from "deployed" to "fix," not a forward march.
4. **The SDD role-state froze while reality ran ahead** (G4): `STATE.md` still says "Phase 1 — Design, 4/9 roles" at v0.4.2. The linear role model literally stopped tracking around Stage 14 because reality wasn't linear.

**Where the linear model is *least* wrong:** *within a single feature stage* (assess → build → PR → CI → merge → deploy is fairly linear). **Where it's *most* wrong:** *across* the project, where it's a **loop of feature-stages each carrying its own mini-lifecycle**, with CI/CD as a constant substrate. The framework should model the macro-structure as **"a stream of feature-stages over a always-on pipeline,"** not a one-pass pipeline.

L2. ⭐ How were **new feature requests mid-build** handled (the D9 help-agent feature arriving at "Stage 15")? Was there a distinct intake/assessment step before it became stages? `[informs: Feature Manager]`
**Answer:** **Yes — a distinct, formalized intake step: the Feature Manager (`/sdd:feature`), and it's one of the best-working parts of the whole flow.** A mid-build feature request became a stage only after producing a **`feature-assessments/feature-*-assessment.md`** — and there are **5** of them (admin-panel, artifact-explorer, client-hub, issue20-csv-mapping, ui-design-refresh), proving it was a *repeated* discipline, not a one-off.

A real assessment (admin-panel) contains: **the request summary; verification of the brief against the *live* codebase (claim/reality table); impact analysis** (per existing stage — "Stage 6 untouched," etc.; per contract — "frozen subagent_contract/v1 untouched"; scope/complexity; a risk table); a **decision (ACCEPT as Stage N)**; **explicit "conditions of acceptance"** carried into the stage (e.g. "kill-switch default off," "additive migration only," "existing suite stays green"); and **outputs** (the new `stage-instructions/stage-N-instruct.md` + a new `contracts/contract-*.md`). Then it hands to the Stage Manager (`/sdd:build`) → branch → PR → CI → merge.

So the pipeline: **request → Feature Manager assessment (impact + contract-safety + acceptance conditions + kill-switch) → new stage instruction + contract → build as a normal stage.** The help agent followed exactly this as "Stage 15." **This is the strongest "keep it" finding (N3):** the assessment step is what kept 6 mid-build features from destabilizing a live, contract-frozen system — every one shipped additively with a kill-switch because the intake *required* it.

L3. How were **merge conflicts** between stages/branches handled when they occurred? Manual? A dedicated step? `[informs: Merge Manager]`
**Answer:** **Manually, and via a specific tactic — "re-home, don't resolve" (the same as G1/H3).** When stacked PRs conflicted on `sdd-output/STATE.md`, the move was to **abandon the conflicting PR and re-cut a clean one** off current `main` with `STATE.md` = the worker's latest value: #43→#44 (Stage 12), #46→#47 (Stage 13). The guardrail learned along the way was **merge the base *without* `--delete-branch`** so squashing the base doesn't auto-close its stacked child.

There *is* a dedicated SDD role for this — **Merge Manager (`/sdd:merge`)** — but in practice it was used more for *integrating* (Stage 14 went to `main` *via* `/sdd:merge` with no PR) than for *conflict resolution*; the actual conflicts were handled by the re-home tactic, not a formal merge-resolution session. **Net:** conflicts were rare (twice), low-severity, manual, and concentrated entirely on the mutable committed state file — reinforcing G5 (derive state, don't commit-and-merge it). A Merge Manager role is justified, but the bigger win is **removing the contended artifact** so there's less to manage.

L4. What work didn't fit any "role" in the standard flow and you just... did? `[informs: missing roles]`
**Answer:** A lot of the *highest-frequency* work had no SDD role and was done ad hoc:
- **The maintainer/release-operator loop** — version-bump → tag → watch `release.yml` → copy digests → re-pin `.env.prod` → `deploy.sh` → verify → update `STATUS.md`. This was *the* recurring activity (18×) and maps to no clean single role (it straddles "Deployer" and "SRE," neither of which was formally run — `STATUS.md`: "a production deploy was performed manually … but the SDD 'Project Deployer' role hasn't been formally run").
- **Authoring `STATUS.md`** — the runtime-truth scribe (D6). No role owns it.
- **Authoring handoff briefs** (`docs/handoff/*`) — a "spec-for-another-agent" author role that doesn't exist in standard SDD.
- **The divergences log itself** (`sdd-flow-divergences.md`) — a "process-retrospective" role.
- **Operator-coordination** — relaying "start the VMs," tracking the PAT-rotation/admin-deletion chores.
- **Reviewing another agent's PR** for security invariants (the D9 review) — a "Reviewer/Integrator" role distinct from Tester.

**The single biggest missing role: a "Release/Deploy Operator"** that owns the tag→digest→deploy→verify→STATUS loop as a first-class, repeatable thing — because that *was* the job, 18 times over.

L5. Did you re-run earlier roles (re-architect, re-plan) as you learned? How was that handled against already-built stages? `[informs: iteration/loops]`
**Answer:** **Yes, but lightly and additively — never a disruptive re-architecture.** The mechanism was the **Feature Manager** (L2): each new stage (10–15) effectively re-ran "plan + a slice of architect" — it produced fresh `stage-instructions/` and, when it introduced a new seam, a **new contract** (`contract-admin-role.md`, `contract-design-system.md`, `contract-client-hub.md`, …). So re-planning happened *per feature*, bolted onto the existing plan rather than rewriting it.

**Crucially, the foundational architecture was *not* re-run** — the **frozen `subagent_contract/v1` was never reopened**; every later stage was forced to be an *additive v1 extension* ("no v2," repeated across Stages 11/12/13). That constraint is what let iteration happen safely against already-built, already-deployed stages: **new work had to fit the frozen contract, not change it.** The one genuine "re-architect" pressure — wanting richer sub-agent endpoints — was absorbed as additive read endpoints rather than a contract bump. **Lesson for the framework:** freeze the core contract early, then let iteration be *additive stages under it*; that converts "re-architecting" (dangerous against live stages) into "new contract-compatible stage" (safe).

---

## M. Reusable features & design guidance

M1. ⭐ The **help agent** (helper-bot) baked into the app — how was it actually built? Which parts were genuinely reusable across apps vs specific to this one? `[informs: feature catalog, helper-bot spec]`
**Answer:**
**How it was built** (PR #51, `gateway/app/help_tools.py` + `routes_help.py`): *not* a new service — a **new mode of the existing chat loop.** A `kind` column on `ChatSession` (migration `0010`, additive, server-default `'chat'`) switches `run_chat_turn` to a `HELP_SYSTEM_PROMPT` + a **separate, restricted tool registry**. The security boundary is *by construction* — help mode is simply never offered the sub-agent/privileged tools. Four read-only tools: `code_search`/`code_read` (over a **baked `git archive HEAD` snapshot** at `/srv/source-snapshot`, path/symlink-confined, byte-capped), `log_query` (**always** injected `WHERE user_id=<caller>`, model can't widen), `kb_read`/`kb_append` (a markdown FAQ on a persistent volume, size+secret-guarded, `flock` append), and `github_open_issue` (**draft-only, never POSTs** — the real POST is a separate auth'd/rate-limited/redacted/`help-bot`-labeled `POST /help/issues`). Shipped dark behind `HELP_AGENT_ENABLED`.

**Genuinely reusable across apps (the helper-bot *pattern*):**
- **"Help = a restricted mode of the main chat loop, isolated by a separate tool registry"** — the whole architectural shape.
- **Baked read-only source snapshot via `git archive HEAD`** — tracked-files-only ⇒ secrets auto-excluded; a clean, portable "let the bot read its own code" primitive.
- **Caller-scoped log reads that the model cannot widen** — a reusable safety pattern for *any* "let users ask about their own activity."
- **Draft-then-confirm external action** (the human-in-the-loop issue filing) — reusable for any agent that can take a consequential outside action.
- **A read+append markdown FAQ** as lightweight institutional memory.

**Specific to this app:** the exact `logs`-table schema, the 4-sub-agent tool list it excludes, the `smahoney-specdev/Switchboard` repo target, the FAQ content. **Framework rec:** put **"helper-bot"** in the drop-in feature catalog as *the pattern* (restricted-mode + snapshot + caller-scoped logs + draft-confirm action + FAQ), parameterized by the app's log schema and repo.

M2. Did the help agent's runtime dependency on `docs/architecture.md` cause **staleness** problems (it reasoning from an outdated doc)? How did you keep that doc current? `[informs: arch-doc freshness contract]`
**Answer:** **Partly a false premise — and that's itself the design choice worth capturing.** The help agent does **not** depend on `docs/ARCHITECTURE.md` as its source of truth; by deliberate decision (`feature-help-agent.md` scope decision #3) it reads a **baked snapshot of the actual source tree** (`git archive HEAD`), refreshed **every deploy**. So its ground truth is *the code as shipped*, which is **structurally fresh** — it can't drift from the deployed binary because it *is* the deployed binary's tree. That sidesteps doc-staleness entirely for code reasoning.

**Where staleness risk remains** (honestly): (1) `docs/ARCHITECTURE.md` *is* in the snapshot, so if the *human-written* arch doc is stale, the bot can still read a stale narrative alongside fresh code; (2) the **FAQ** (`kb_append`) can accumulate outdated resolutions. Neither has a freshness *contract* — there's no test asserting `ARCHITECTURE.md` matches reality. **No staleness incident was observed** (the feature is days old), so this is forward-looking. **Framework rec (the real M2 lesson):** prefer **"reason from the snapshot of actual source"** over **"reason from a prose doc"** as the helper-bot's grounding — it makes freshness a property of the build, not a discipline someone must maintain. Where a prose arch-doc *is* used, give it a freshness contract (a CI check or a "last-verified-against-commit" stamp).

M3. Were there OTHER reusable capabilities you built that belong in a "drop-in features" catalog (auth, billing, logging, etc.)? `[informs: feature catalog scope]`
**Answer:** Yes — several were built to a quality that's clearly app-agnostic:
- **Structured logging with cross-service `correlation_id`** — Postgres `logs` table (weekly-partitioned, indexed), JSONL durable mirror, **automatic secret redaction** (field-name + header matching), a documented event registry (`MAINTAINER_AGENT_NOTES.md`). Highly reusable; it's also what *powers* the help bot and the bug template.
- **Auth/session** — password login with inline errors, server-side session revocation, login rate-limiting + lockout + `Retry-After`, an `admin`<`admin`<`superadmin` role ladder via additive migration with `require_admin`/`require_superadmin` deps.
- **Per-user + global token accounting** (`token_accounting.py`, `MAX_*_PER_DAY_*`) — a reusable "LLM cost ceiling" primitive.
- **Async job queue + worker** (Stage 5, `contract-jobs-queue.md`: claim/retry/dead-letter).
- **The frozen-contract sub-agent pattern** (`/health·/invoke·/ingest` + JWT + `{result, metadata, is_error}` envelope, one `Dockerfile.subagent` × `ROLE`) — a reusable "pluggable specialist service" template.
- **The CI/CD spine itself** — `ci.yml` (8-check) + `release.yml` (build-once/digest/Trivy) + digest-pinned `deploy.sh` + `verify_deploy.sh` + rollback drill. **This is arguably the most valuable reusable asset** and the literal subject of this interview.
- **Upload handling** — type/size validation, cross-session isolation, scheduled purge.

Catalog-worthy, ranked by reuse value: **CI/CD spine, structured+redacted logging, helper-bot, auth/role ladder, token-budgeting, frozen-contract sub-agent template.**

M4. Did you follow internal design guides / house patterns? Were there cases where the right call was to **deviate** from a standard pattern, and how did you decide? `[informs: design-guides recommend-not-mandate, ADRs]`
**Answer:** **Yes — house patterns existed as the `contracts/` set (12 internal interface contracts) + `design-system.md`, and they were treated as *mandates within their scope* but the system as a whole *recommended* deviations when justified.** How deviations were decided — by **written, reasoned exception**, not ad hoc:
- **Deviating from "PR-gated integration":** Stage 14 went **straight to `main` via `/sdd:merge`, no PR** — decided explicitly and *recorded* in `STATUS.md` ("merged straight to main … CI on push-to-main passed. Reviewed & accepted in place"). The standard (D3) was knowingly waived because it was single-machine + paint-only, and the *reasoning was logged.*
- **Deviating from the standard SDD flow at all:** the entire `sdd-flow-divergences.md` (D1–D9) **is** the ADR log — every departure is "standard / what we did / why / proposed change," dated. This is the project's most mature practice: **deviations are first-class, reasoned, append-only records.**
- **Refusing to deviate where it mattered:** the **frozen `subagent_contract/v1`** was a hard mandate — every feature bent *itself* additively rather than touch it ("no v2," L5). Contrast: a UI token (`--font-sans` Verdana → system-ui) *was* deviated from with a signed-off reason ("Verdana not brand-verbatim").

**Decision rule in practice:** mandate the **contracts** (wire/JWT/schema — breaking them breaks other agents/services); **recommend** the conventions (PR-per-stage, design tokens — deviate with a logged reason). **Framework rec:** exactly this two-tier model — **contracts are mandates, guides are recommendations — and every deviation is an ADR** (the divergences log is the proof it works).

---

## N. Retrospective (the most important section)

N1. ⭐⭐ What were the **three biggest time sinks or pain points** in this whole build, and which were caused by the standard flow not accounting for CI/CD or multi-agent work? `[informs: framework priorities]`
**Answer:**
1. **"Done" without a green pipeline → the D4 cleanup (biggest).** 9 stages marked done before CI ever ran green; the first real run failed 4 ways and the async-fixture debt (#6) lingered ~5 days and hid a real prod bug. **Cause: the standard flow let "tests/CI *config* exist" count as "done" — it had no concept of CI/CD as a gate that must be *proven green*.** Directly a CI/CD-accounting gap.
2. **"Merged ≠ works in the browser" → the hotfix treadmill.** HTMX stub (v0.3.1), invisible cache-stale UI (v0.3.10), dead help button (v0.4.2), version misreporting (#32) — a steady drip of `+1` hotfixes for things CI couldn't see. **Cause: no staging + no UI-level verification gate + (after D8) loss of the independent tester eyeball.** Partly CI/CD (no UI smoke), partly multi-agent (the relaxed D7 wall).
3. **Deploy friction at the human/identity seams.** The GHCR-owner-vs-`gh`-auth split (needing a separate `read:packages` PAT), the manual run-summary→`.env.prod` digest copy, branch-protection being paywalled, and the nightly VM-power gate. **Cause: the standard flow assumes a frictionless, always-on, single-identity deploy target** — it didn't account for "private free-tier GitHub + cost-gated VMs + two GitHub identities."

The honest ranking: **#1 and #2 are squarely "the flow didn't treat CI/CD as the spine,"** and **#2's regression also reflects "multi-agent role-separation collapsed."** State-conflict pain (G1) was real but *minor* by comparison (twice, low-severity).

N2. ⭐⭐ If the framework could have **enforced one gate** or **provided one artifact/role** that didn't exist, what single thing would have helped most? `[informs: highest-leverage feature]`
**Answer:**
**One gate: a mandatory "deployed-and-observably-works" verification gate before a release is called done — a *post-deploy UI smoke that drives the real interface*, not `curl /health`.** Justification: it's the single gate that would have caught the **largest, most repeated class** of failures (N1 #2 — HTMX stub, cache-stale UI, dead help button, version misreport) — *every one of those passed CI and `/health` and still shipped broken.* CI already guarded backend/contract correctness well (it caught D4-class problems once it existed). The unguarded surface — "does the thing a user clicks actually do something" — is where the hotfix treadmill came from.

Mechanically: after `deploy.sh`, run a **headless browser smoke** of the top user flows (log in, send a chat, click the help `?`, click "File issue") asserting *behavior*, and gate "release verified" in `STATUS.md` on it. **Runner-up (artifact/role):** a **Release/Deploy Operator role** owning the tag→digest→deploy→**verify**→STATUS loop (L4) — because that gate needs an owner, and that loop *was* the most-repeated unowned work. If I get only one: the **UI smoke gate**, because it converts "marked done" into "observably works," which is the project's defining gap (C5).

N3. ⭐ What did the standard single-agent SDD flow get **right** that we must NOT lose in the new framework? `[informs: don't-break list]`
**Answer:** Keep these — they demonstrably carried the build:
1. **Contracts as frozen mandates.** `subagent_contract/v1` never broke across 15 stages; it's *why* iteration stayed safe (L5). The `contracts/` discipline (12 internal interface contracts) is the backbone — **do not lose contract-first design.**
2. **The Feature Manager intake (L2).** The assessment step (impact analysis + contract-safety + acceptance conditions + mandatory kill-switch) is what let 6 mid-build features land additively on a live system without destabilizing it. **Best-working role in the flow.**
3. **Stage decomposition with explicit instructions + acceptance conditions.** `stage-instructions/` + per-feature acceptance conditions gave every unit of work a crisp "done" definition and a spec a *different* agent could build from.
4. **Roles as separable concerns** — even collapsed onto one machine, "now act as Tester," "now as Security Auditor (the PR #51 review)," "now as Deployer" kept quality high. The *role boundary* is valuable independent of *who/what* plays it (H4).
5. **Specs-as-committed-artifacts** (`stage-instructions`, `contracts`, `feature-assessments`, handoff briefs) — these never rotted (unlike mutable *state*, G4) and were the durable value of `sdd-output/`.

**Don't-break list, one line:** *contracts-first, intake-assessed, stage-decomposed, role-separated, specs-committed.*

N4. What surprised you — something you assumed would be easy/hard that turned out the opposite? `[informs: hidden complexity]`
**Answer:**
- **Surprisingly HARD: getting CI to actually run green the first time.** "Tests exist, CI config exists" felt like done; the first real run exploded into 4+ failures plus a multi-day async-fixture saga (#6) that had been hiding a real prod INET bug. The gap between "wrote tests" and "tests pass in a clean CI env" was far wider than expected (C2/K2).
- **Surprisingly HARD: the boring identity/plan seams.** Branch protection being *impossible* on a private free repo, and GHCR pulls needing a *different* identity than `gh` — mundane platform facts that caused recurring, disproportionate friction (B1b/B5).
- **Surprisingly EASY: the multi-agent handoff.** The thing that *sounds* hardest — two independent agent systems building one production app — **just worked** on plain git + PRs + a markdown brief, with **zero** committed merge conflicts and only two minor stacked-PR re-homes (H3). No message bus, no lock service needed. The coordination bus being "the repo itself" was more robust than expected.
- **Surprisingly EASY: digest-pinned rollback.** Made trivially safe by one upfront discipline (additive-only migrations + `.env.prod.bak` per deploy), so "roll back prod" was never scary (F4).

The meta-surprise: **the human/CI/platform plumbing was the hard part; the agent collaboration was the easy part.** That should reorder framework priorities — invest in the pipeline/identity/verification spine, trust the git-mediated handoff.

N5. ⭐ If you started this exact project over with a perfect CI/CD-native, GitHub-native, multi-agent framework, **what would the first hour look like**, step by step? `[informs: end-to-end flow]`
**Answer:**
1. **(0–10 min) Lock an identity manifest** (B1c): one immutable record fixing `{repo (lowercase-canonical slug), image-prefix, registry-owner, dns, env names, secret names}` — and **decide the registry-owner ↔ git-auth identity now** so GHCR pulls aren't a surprise later.
2. **(10–20 min) Generate the scaffold from the manifest:** repo + `LICENSE`/`README`/`.gitignore`, **`.github/workflows/ci.yml` + `release.yml`**, **`.github/ISSUE_TEMPLATE/` (bug + feature + chore)**, **`docs/handoff/README.md` reading-order manifest**, an empty **`STATUS.md`**, tracked **`sdd-output/`**, `CODEOWNERS`, **pinned toolchain + lockfile**. Everything that was added *late* in reality (B4) ships at minute 15.
3. **(20–35 min) Walking skeleton (the non-negotiable, C3):** one trivial vertical slice (one route, one DB read, one real test) that goes **8/8 green in CI**, then `tag v0.0.1` → `release.yml` builds+scans+pushes a digest → `deploy.sh` to a **staging** env → **`verify_deploy.sh` + a headless UI smoke pass** (N2). *Now the entire spine is proven before any feature exists.*
4. **(35–40 min) Set the gates:** branch protection requiring the CI contexts **if the plan allows** (else record the honor-system fallback in `STATUS.md`); confirm rollback by re-pinning the v0.0.1-minus digest and re-deploying (the drill).
5. **(40–50 min) Operator runbook + blocked-on-human work-items:** generate `AZURE_GITHUB_SETUP.md` from the manifest; file the human-only prerequisites (provision VMs/secrets/DNS) as **labeled `blocked-on-human` issues** with explicit unblock signals (J2), since the env won't exist yet.
6. **(50–60 min) First real feature via the loop:** Feature Manager assessment (impact + contract-safety + kill-switch) → `contracts/` entry → `stage-instructions/` → branch → PR → 8/8 CI → review → merge → tag → deploy-to-staging → **UI smoke** → promote → `STATUS.md`.

The ordering principle: **prove the CI/CD+verify spine on an empty skeleton in the first 35 minutes** (kills N1 #1 and #2 at the root), *then* let features stream over it through the assessed-stage loop (keeps N3's wins).

N6. Anything we didn't ask that we should have? `[informs: blind spots]`
**Answer:** A few blind spots worth a question each:
- **Cost/intermittency as a first-class constraint.** The VMs-off-nightly rhythm shaped *everything* operational (J3, H5) yet isn't a "role" anywhere. A framework for real-world small deployments should model **"the environment is intermittently unavailable"** as a normal state, not an incident.
- **The runtime-truth artifact (`STATUS.md`) is underspecified by standard SDD.** It carried more real coordination load than `STATE.md`, but it's a hand-maintained prose file with no schema. Ask: *what's the contract/schema for the runtime-state artifact, and who owns updating it?* (D6/L4).
- **Secret lifecycle.** Secrets-only-on-VMs worked, but **rotation never happened** — the exposed classic GHCR PAT and the throwaway `admin/adminpw12345` are *still* live gates (`STATUS.md` outstanding; memory `no-live-data-yet`). Ask: *how does the flow track and enforce secret rotation / pre-go-live cleanup?*
- **Backup coverage gaps for non-DB state.** pgBackRest covers Postgres, but the **retained artifact bytes and the help FAQ volume are NOT backed up** — flagged repeatedly, never closed. Ask: *what's the backup contract for non-database persistent volumes?*
- **"Pre-go-live" as a distinct phase.** Several things are explicitly "fine until real data" (cross-user artifact visibility, throwaway admin, #20 CSV verify). The flow has no **go-live gate** that forces resolving the "fine for now" list. Ask: *what's the checklist that gates first-real-data?*
- **LLM-specific testing.** The app's core is a Claude tool-use loop, but tests skip live-API integration (`-m "not integration"`); behavioral regressions like #21 (attachment biases the model to auto-`*_ingest`) are only caught by humans. Ask: *how does the flow test non-deterministic model behavior?*

The biggest blind spot in one line: **the framework should treat "operate a real, cost-constrained, secret-bearing deployment over time" as seriously as it treats "build the code" — that operational half is where this project actually spent its surprises.**
