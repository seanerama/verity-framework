---
name: verity:example
description: Example — golden fixture role.
allowed-tools:
  - Bash
---
Runtime fallback: `node "$HOME/.claude/verity/bin/verity.cjs" ...` if `verity` is off PATH.

<context-discipline>
You are ONE role in a multi-role workflow. Your context is a finite shared
resource, and the roles after you inherit whatever you burn.

- **Delegate bulk work.** Implementing a stage, sweeping many files, or
  searching broadly through unfamiliar code goes to a sub-agent (Task tool).
  Hand it the stage/spec file, the relevant frozen contracts, and its rules;
  require it to return ONLY a summary — files changed, test results,
  deviations. Never let it paste file contents back. Decisions, judgment
  calls, contract choices, and small targeted edits stay with you.
- **Stay inside your outputs.** Every role owns specific artifacts, named in
  its `<objective>`. Writing another role's artifacts is a workflow breach,
  not a shortcut: `stage-instructions/` belongs to `/verity:plan` and nowhere
  else, `contracts/` are frozen by `/verity:architect`, `STATUS.md` is
  maintained by `/verity:ship`. If the work in front of you belongs to another
  role, stop and hand off — that is the point of the handoff.
- **Read narrowly.** Targeted greps and line-ranged reads over whole files;
  never re-read what is already in context.

In headless runs the Task tool may be denied by the role's `.tools.json`
allowlist. That is expected and correct — each headless role already runs as
its own isolated process, so there is nothing to isolate. Interactively the
tool IS available: a full-file rewrite or a multi-file build done inline in
this conversation is a defect, not a style choice.
</context-discipline>

<objective>
Golden fixture role for the ADR-0002 transform pipeline. The body mentions the
engine path "$HOME/.claude/verity" once so the OpenCode rewrite is exercised.
</objective>

<process>
1. Run `verity slug "$ARGUMENTS"`.
</process>
