# Verity

**Prompt to production, proven.**

Verity is a CI/CD-native, GitHub-native, production-lifecycle AI software delivery framework — a clean-room successor to [spec-driven-devops](https://www.npmjs.com/package/spec-driven-devops) 1.4 for projects that go *beyond MVP* into real, operated production.

Most AI coding tools stop when the code is written. Verity keeps going until the software is tested, deployed, and **proven working in front of a user**. It runs a project as a sequence of specialized AI roles (architect, builder, reviewer, release operator, verifier…) that hand work off through clear contracts, with GitHub as the source of truth.

> **Status: design complete, pre-implementation.** This repo currently tracks the design. Implementation begins with Verity's own *walking skeleton* — see [`docs/walking-skeleton-plan.md`](docs/walking-skeleton-plan.md).

## Subsystems
- **Relay** — role orchestration + the stream loop + dependency engine
- **Shipyard** — CI/CD spine + Release/Deploy Operator + runtime truth (`STATUS.md`)
- **Ledger** — GitHub-derived state engine (no stale files)
- **Gate** — review + security + the quality gates
- **Verify** — live "observably-works" verification

## Docs
- [`docs/framework-spec.md`](docs/framework-spec.md) — the build-ready architecture spec
- [`docs/roles-spec.md`](docs/roles-spec.md) — working log + full rationale (all 14 roles)
- [`docs/interview-findings.md`](docs/interview-findings.md) — forensic interview of the real build that drove the design
- [`docs/brand.md`](docs/brand.md) — naming / positioning
- [`docs/features/helper-bot.md`](docs/features/helper-bot.md) — drop-in feature #1
- [`docs/walking-skeleton-plan.md`](docs/walking-skeleton-plan.md) — the first implementation slice

## Package
`verity-framework` (npm) · CLI binary: `verity` · Node ≥16 · host deps: `git`, `gh`

## License
MIT
