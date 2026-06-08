# Verity

**Prompt to production, proven.**

Verity is a CI/CD-native, GitHub-native, production-lifecycle AI software delivery framework — a clean-room successor to [spec-driven-devops](https://www.npmjs.com/package/spec-driven-devops) 1.4 for projects that go *beyond MVP* into real, operated production.

Most AI coding tools stop when the code is written. Verity keeps going until the software is tested, deployed, and **proven working in front of a user**. It runs a project as a sequence of specialized AI roles (architect, builder, reviewer, release operator, verifier…) that hand work off through clear contracts, with GitHub as the source of truth.

> **Status:** published — [`verity-framework@0.1.0`](https://www.npmjs.com/package/verity-framework) on npm. 13 role commands, the full Relay/Ledger/Gate/Shipyard/Verify engine, and adapters for Claude Code + OpenCode.

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

## Guides (interactive, beginner-friendly)

Self-contained HTML — clone/download the repo and open them in any browser (no server or internet needed):

- [`docs/verity-overview.html`](docs/verity-overview.html) — **Overview**: what Verity is, the mental model, how it works (no jargon assumed)
- [`docs/verity-usage.html`](docs/verity-usage.html) — **Usage**: install + command-by-command recipes + pro tips (Claude Code / OpenCode toggle)
- [`docs/verity-flows.html`](docs/verity-flows.html) — **Flows**: start-from-scratch vs add-to-an-existing-project, side by side
- [`docs/verity-flows.drawio`](docs/verity-flows.drawio) — the flow diagram as an editable draw.io / diagrams.net file

## Subsystems
- **Relay** — role orchestration + the stream loop + dependency engine
- **Shipyard** — CI/CD spine + Release/Deploy Operator + runtime truth (`STATUS.md`)
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

## License
MIT
