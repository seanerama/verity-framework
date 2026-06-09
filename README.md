# Verity

**Prompt to production, proven.**

Most AI coding tools stop when the code is written — leaving you to find out later whether it runs, deploys, or actually works. **Verity keeps going.** It carries a project from an idea all the way to software that is tested, deployed, and **proven working in front of a real user** — and then keeps it running.

It does that by running your project as a sequence of specialized AI roles — a vision assistant, an architect, a builder, a reviewer, a release operator, a verifier, and more — that hand work to each other through clear contracts, with **GitHub as the single source of truth**. It's CI/CD-native and GitHub-native by design, built for projects going *beyond a prototype* into real, operated production. (Verity is a clean-room successor to [spec-driven-devops](https://www.npmjs.com/package/spec-driven-devops) 1.4.)

> 📦 On npm as [`verity-framework`](https://www.npmjs.com/package/verity-framework) · works with **Claude Code** and **OpenCode**.

## What makes it different

- **"Done" means proven, not written.** Every change is reviewed, deployed, and driven like a real user before it counts as finished.
- **The AI decides; a deterministic tool records.** The `verity` CLI is the "notebook" that never forgets — it holds the rules and the official state, so a forgetful model (or a brand-new chat) can always pick up exactly where things left off.
- **State is read from GitHub, never a file that drifts.** A merged PR *is* "built"; a tag *is* "released." Nothing to hand-maintain, nothing to lie about.
- **Specialist roles with real handoffs** beat one mega-prompt trying to do everything.

## How it works

A Verity project moves through three arcs:

1. **Bootstrap** *(once)* — name the project, create the repo, design the architecture, choose where it deploys, and prove the whole build→ship pipeline on a tiny end-to-end "walking skeleton."
2. **Stream** *(the loop)* — every feature flows through the same short cycle: **plan → build → review → merge**, riding that proven pipeline.
3. **Operate** *(continuous)* — cut releases, deploy, **verify on the live app**, and keep it healthy.

Five subsystems carry that out:

| Subsystem | Job |
|---|---|
| **Relay** | Orchestrates the roles, the stream loop, and the dependency engine |
| **Shipyard** | The CI/CD spine — releases, deploys, the deployment-methods catalog, and runtime truth (`STATUS.md`) |
| **Ledger** | Derives state from GitHub, so nothing goes stale |
| **Gate** | Review, security, and the quality gates |
| **Verify** | Live "observably-works" verification |

## Install

**Prerequisites:** a GitHub account · Node ≥16 · `git` and the GitHub CLI (`gh`) installed **and signed in** (run `gh auth login` once — installing `gh` is not the same as being authenticated).

```bash
# preflight — all three should answer without error:
node -v && git --version && gh auth status

# install, then connect it to your assistant:
npm i -g verity-framework
verity install --claude        # or: --opencode
```

Then, in your AI assistant, start a project with `/verity:vision`. The [interactive guides](#guides) walk through it step by step.

## Deployment methods

Verity makes **where your app deploys a deliberate choice**, not an accident. Left alone, an AI agent picks a host by whatever happens to be wired into its environment — suggesting Render.com, say, just because a Render tool is installed. The deployment-methods catalog fixes that: the **Architect** reads your saved targets and works with you to choose one (recording it as an ADR), and if none are configured yet it asks how you want to deploy and offers suggestions.

It's **two files, two scopes** — and crucially, no secrets ever touch git:

| | Global catalog | Per-app access |
|---|---|---|
| **Path** | `~/.verity/deployment-methods.md` | `.verity/deploy-access.md` |
| **Scope** | You, across *every* project | One app |
| **Holds** | The deploy targets you *can* use | How to reach *this* app's host |
| **Created** | At `verity install` — seeded once, never overwritten | Written by the Architect, per app |
| **In git?** | No (lives in your home dir) | **No — gitignored.** A committed, secret-free pointer tells teammates who lack it to ask the project admin |

> 🔒 Both files reference credential **locations** — a key file like `~/.ssh/prod.pem`, an SSO profile, a secret-store entry — never an actual key, password, or token. The per-app file is shared out-of-band, so nothing sensitive lands in git history. (Same rule as `STATUS.md`.)

The global catalog ships with two worked examples (AWS EC2 over SSH, and a local-network server). Edit it to describe your real targets:

```bash
verity deployment list           # your targets (this is what the Architect reads)
verity deployment show aws-ec2   # one target's details
verity deployment edit           # open the catalog in $EDITOR
verity deployment path           # where the catalog lives
```

When the Architect picks a target it sets up the per-app access file — `verity deployment init-access` gitignores the real file and commits the "ask the admin" pointer — then writes `.verity/deploy-access.md` with how to reach this app's host. From there, `/verity:ship` deploys to that target. (`verity deployment access` tells a teammate whether they have the file, and who to ask if not.)

## Guides

Interactive, beginner-friendly, and fully self-contained — clone or download the repo and open them in any browser (no server or internet needed):

- [**Overview**](docs/verity-overview.html) — what Verity is and the mental model, no jargon assumed
- [**Usage**](docs/verity-usage.html) — install + command-by-command recipes + pro tips (Claude Code / OpenCode toggle)
- [**Flows**](docs/verity-flows.html) — start-from-scratch vs. add-to-an-existing-project, side by side ([editable `.drawio`](docs/verity-flows.drawio))
- [**Command reference**](docs/commands.md) — all 13 `/verity:*` roles and what each one does
- [**Explainer kit**](docs/explainer-kit.md) — a briefing for an AI to describe Verity to humans (podcast / deck / talk)

## Reference

- **Package:** `verity-framework` · CLI binary `verity` · Node ≥16 · host deps `git`, `gh`
- **Design docs:** [framework spec](docs/framework-spec.md) · [roles spec](docs/roles-spec.md) · [the interview that drove the design](docs/interview-findings.md) · [brand / positioning](docs/brand.md) · [walking-skeleton plan](docs/walking-skeleton-plan.md)
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, the test/lint checks, project layout, and conventions
- **License:** MIT
