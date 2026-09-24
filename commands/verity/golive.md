---
name: verity:golive
description: Pre-go-live / first-real-data gate — force-close the "fine for now" list before real data.
allowed-tools:
  - Bash
  - Read
---
<objective>
Run the BLOCKING pre-go-live gate before the project accepts real data or users
(Security Auditor + SRE jointly). The real build accumulated a "fine until real data"
list that never got closed — this gate forces it.
</objective>

<process>
1. Run the checklist:
   ```bash
   verity golive
   ```
   It auto-checks what's derivable (security invariants defined, secret locations
   recorded in STATUS, recovery plan present) and lists the manual gates.

2. Answer EVERY manual gate on the record before go-live. Each gate has a stable id:
   - `secrets-rotated`: secrets rotated (no dev/exposed credentials).
   - `throwaway-accounts`: throwaway accounts removed.
   - `cross-user-isolation`: cross-user data isolation verified.
   - `backup-coverage`: backup coverage for ALL persistent state.
   - `security-signoff`: security deep-audit sign-off (/verity:security).

   Record each answer with your name. A gate that holds is `ok`; a gate that does not
   apply to this project is `n/a` with a reason:
   ```bash
   verity golive confirm <id> --by <who>
   verity golive confirm <id> --by <who> --na "<reason>"
   verity golive reset <id>        # withdraw an answer
   ```
   An `n/a` needs a reason a reviewer can check against `docs/security-invariants.md`
   (its "Standard items that do not apply" section). A reason under 10 characters,
   or an answer without `--by`, is refused. Answers are written to
   `.verity/runtime.json` and rendered into the `## Go-live gate` section of
   `STATUS.md`.

3. `verity golive` reports `ready: true` only when the auto-checks pass AND every
   manual gate has a recorded answer. Any unanswered gate or failing auto-check STOPS
   go-live.
</process>
