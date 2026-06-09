# Verity

**Prompt to production, proven.**

Verity is a CI/CD-native, GitHub-native, production-lifecycle AI software delivery framework — a clean-room successor to [spec-driven-devops](https://www.npmjs.com/package/spec-driven-devops) 1.4 for projects that go *beyond MVP* into real, operated production.

Most AI coding tools stop when the code is written. Verity keeps going until the software is tested, deployed, and **proven working in front of a user**. It runs a project as a sequence of specialized AI roles (architect, builder, reviewer, release operator, verifier…) that hand work off through clear contracts, with GitHub as the source of truth.

> **Status:** published — [`verity-framework@0.2.0`](https://www.npmjs.com/package/verity-framework) on npm. 13 role commands, the full Relay/Ledger/Gate/Shipyard/Verify engine, adapters for Claude Code + OpenCode, and the deployment-methods catalog (see below).

## Install

```bash
npm i -g verity-framework
verity install --claude       # or: --opencode
```

**Prerequisites:** a GitHub account · Node ≥16 · `git` and the GitHub CLI (`gh`) installed **and signed in** (`gh auth login` — installing `gh` is not the same as being authenticated). Preflight:

```bash
node -v && git --version && gh auth status
```

Then, in your AI assistant, start a project with `/verity:vision`.

## Deployment methods

**What it is.** A catalog of the places *you* can deploy to (an AWS box, a server on your LAN, a managed host…), plus a per-app record of where each project actually runs. Verity reads it when the **Architect** designs an app, so deployment becomes a *deliberate choice you make* — not an accident.

**Why it exists.** Without it, an AI agent picks a host by whatever happens to be lying around — e.g. suggesting Render.com simply because a Render tool is installed in its environment. That's not a decision; it's a coincidence. The catalog makes the Architect ask *"here's what you can deploy to — which one for this app?"*, and record the answer as an [ADR](docs/commands.md). It also keeps host and credential details **out of git** while still letting a team share them safely.

**Two files, two scopes:**

| | Global catalog | Per-app access |
|---|---|---|
| **Path** | `~/.verity/deployment-methods.md` | `.verity/deploy-access.md` |
| **Scope** | You, across *every* project | One app |
| **Holds** | The deploy targets you *can* use | How to reach *this* app's host |
| **Created** | At `verity install` (seeded once, never overwritten) | Written by the Architect, per app |
| **In git?** | No — lives in your home dir | **No — gitignored.** A committed, secret-free pointer (`.verity/deploy-access.README.md`) tells teammates who lack it to ask the project admin |

> 🔒 **Both files reference credential *locations*, never secrets.** Point at a key file (`~/.ssh/prod.pem`), an SSO profile, or a secret-store entry — never paste an actual key, password, or token. The real per-app file is shared out-of-band (not through the repo), so nothing sensitive ever lands in git history. (Same rule as `STATUS.md`.)

**How to use it.** The global catalog is seeded at install with two worked examples (AWS EC2 over SSH, and a local-network server) — edit it to describe *your* real targets:

```bash
verity deployment list          # what targets you have (the Architect reads this)
verity deployment show aws-ec2  # one method's details
verity deployment path          # where the catalog file lives
verity deployment edit          # open it in $EDITOR to add/adjust targets
```

When the Architect designs an app it runs `verity deployment list`, helps you **pick a target** (recording it as an ADR), and — if nothing real is configured yet — **asks how you want to deploy and offers suggestions**. It then sets up the per-app access file:

```bash
verity deployment init-access   # gitignore the real file + commit the "ask the admin" pointer
verity deployment access        # is the access file present on this machine? if not, who to ask
```

…and writes `.verity/deploy-access.md` with how to reach this app's host. The **Release/Deploy Operator** (`/verity:ship`) consumes that target when it builds the deploy step.

## Guides (interactive, beginner-friendly)

Self-contained HTML — clone/download the repo and open them in any browser (no server or internet needed):

- [`docs/verity-overview.html`](docs/verity-overview.html) — **Overview**: what Verity is, the mental model, how it works (no jargon assumed)
- [`docs/verity-usage.html`](docs/verity-usage.html) — **Usage**: install + command-by-command recipes + pro tips (Claude Code / OpenCode toggle)
- [`docs/verity-flows.html`](docs/verity-flows.html) — **Flows**: start-from-scratch vs add-to-an-existing-project, side by side
- [`docs/verity-flows.drawio`](docs/verity-flows.drawio) — the flow diagram as an editable draw.io / diagrams.net file
- [`docs/commands.md`](docs/commands.md) — **Command reference**: all 13 `/verity:*` role commands and what each one does
- [`docs/explainer-kit.md`](docs/explainer-kit.md) — **Explainer kit**: a briefing for an AI to describe Verity to humans (podcast/deck/talk) — story, diagrams, soundbites, fact sheet

## Subsystems
- **Relay** — role orchestration + the stream loop + dependency engine
- **Shipyard** — CI/CD spine + Release/Deploy Operator + deployment-methods catalog + runtime truth (`STATUS.md`)
- **Ledger** — GitHub-derived state engine (no stale files)
- **Gate** — review + security + the quality gates
- **Verify** — live "observably-works" verification

## Design docs
- [`docs/framework-spec.md`](docs/framework-spec.md) — the build-ready architecture spec
- [`docs/roles-spec.md`](docs/roles-spec.md) — working log + full rationale (all roles)
- [`docs/interview-findings.md`](docs/interview-findings.md) — forensic interview of the real build that drove the design
- [`docs/brand.md`](docs/brand.md) — naming / positioning
- [`docs/walking-skeleton-plan.md`](docs/walking-skeleton-plan.md) — the first implementation slice

## Package
`verity-framework` (npm) · CLI binary: `verity` · Node ≥16 · host deps: `git`, `gh`

## Contributing
See [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, the test/lint checks, project layout, and conventions.

## License
MIT
