# Embedded Help Agent — Alpha Testing Pattern

A help system that doubles as a passive research instrument. Built into the app, it answers user questions with real context, files structured bug reports, and learns what confuses people over time.

## Core Components

1. **Log access** — Agent reads app logs in real time to answer "what just happened" questions with actual evidence.
2. **Architecture guide** — A detailed doc the agent uses to reason about *why* things happen, not just *what*.
3. **Issue drafting** — Users describe problems conversationally; the agent structures and files GitHub issues.
4. **FAQ pipeline** — Questions are batch-processed into a living FAQ the agent also references.

## Build Steps (new app)

1. **Structured logs** — Log to a file or stream the agent can read. Include timestamps, user actions, errors, state changes. JSON recommended. (`logs/app.log`)
2. **Architecture guide** — Markdown doc covering app structure, component responsibilities, known edge cases, expected behaviors. Keep it updated. (`docs/architecture.md`)
3. **Help UI** — A `?` button that opens the agent in a *separate window* (not inline) so it doesn't disrupt app flow. Each session isolated.
4. **Wire agent to logs + guide** — On each query, inject the recent log tail plus the architecture doc into the agent's context. Let it reason across both before answering.
5. **GitHub issue drafting** — Give the agent a tool/API hook to create draft issues. It formats title, description, repro steps, and labels from the conversation.
6. **FAQ batch job** — Persist all questions. Run a scheduled job (daily or per-session) that clusters and summarizes them into a FAQ doc, then inject that back into the agent's context. (`cron/queue`, `docs/faq.md`)

## Retrofit Steps (existing app)

1. **Find existing log output** — Most apps already log somewhere; point the agent at it. Add a lightweight formatter if logs are unstructured.
2. **Document what you know** — Write the architecture guide from memory (how it works, common issues, known bugs). Hardest step, highest value.
3. **Drop in a floating help widget** — A self-contained floating button + chat panel can be added at the app-shell level with no structural changes.
4. **Add backend pieces** — Agent wiring, GitHub hook, and FAQ pipeline are backend additions that don't require touching existing app code.

## Design Notes

- **Confidence signaling** — Distinguish log-confirmed facts ("I can see this in your logs") from architecture-based inference ("based on how this is designed, I'd expect..."). Builds trust.
- **Loop closure** — Feed resolved/closed issue status back into the agent's context so it stops recommending stale workarounds.
- **FAQ freshness** — Apply recency weighting or a TTL so old confusion patterns don't dominate during active alpha.
- **Philosophy** — Treat the help system as a data-collection instrument, not just support. You're instrumenting user confusion the way you'd instrument performance.
