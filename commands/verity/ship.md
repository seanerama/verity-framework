---
name: verity:ship
description: Release/Deploy Operator — cut a release, deploy to staging, UI-smoke verify, promote to prod, update STATUS.md.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<objective>
Run the Release/Deploy Operator (Shipyard). Turn accrued merges into a verified
production release: cut a tag, build/scan/pin images, deploy to staging, prove it
works with a UI-smoke, then (on confirm) promote to prod and record runtime truth.
Continuous CD to STAGING on every merge; PROD is a deliberate cut release.
</objective>

<process>
1. **Decide the release.** Review what's merged since the last tag:
   ```bash
   verity release current      # current release truth
   verity release changelog    # preview the Conventional-Commits changelog
   ```

2. **Pre-flight.**
   - Environment available? If the target is asleep/off, bring it up first
     (intermittent environments are NORMAL). If it can't be reached, file a
     blocked-on-human work-item and stop.
   - `main` is green. Back up the current env/digests before changing anything.

3. **Cut the release** (version is DERIVED from the tag; changelog auto-generated):
   ```bash
   verity release cut --bump patch|minor|major
   ```
   The tag triggers the project's `release.yml` (build each image once → Trivy scan →
   emit digests). Pin those digests into the env (auto-pin; never hand-copy).

4. **Deploy to STAGING** using the project's generated `deploy.sh`
   (pull pinned digests → additive migrate → up → verify).

5. **UI-smoke "observably-works" GATE.** Drive the top user flows against staging,
   asserting *behavior* (not just `/health`):
   ```bash
   verity smoke run --base-url <staging-url>   # flows live in .verity/smoke.json
   ```
   **`verified:false` → STOP; do not promote.** If it reports `gate: skipped` (no
   headless browser available), that is NOT a pass — run `/verity:verify` (Handoff
   Tester) manually before promoting. (`verity smoke init` scaffolds the flows;
   needs Playwright in the project for the automated path.)

6. **Promote to PROD** — human confirm-gate by default (`verity config get prod_promote`;
   set `auto` to skip). Same byte-identical digests. Flip any kill-switch dark→enabled
   as a deliberate, separate step.
   On the promotion path, the prod tag `verity promotion finalize` pushes is what
   **triggers** the prod publish workflow — it then waits on the `npm-publish`
   environment approval, which is yours to give (finalize prints the URL and the
   shasum to verify against; it never observes the run).

7. **Record runtime truth** (this role owns STATUS.md):
   On the **promotion path**, `verity promotion finalize` now stamps `version`,
   `deployed_at` and `rollback_from` into `.verity/runtime.json`, re-renders
   `STATUS.md`, and commits both with the completed PROM record — so those three
   fields need NO manual step (the stamp fails soft: if it warns that the surface
   was not stamped, run `verity status set version <version>` by hand). What is
   still yours either way is the deployment topology — environments and secret
   locations:
   ```bash
   verity status set environments.prod.digest <sha256>
   verity status secret "<NAME> @ <on-disk location>"   # locations only, never values
   ```
   On the **direct `release cut` path** (no promotion), nothing is stamped for you
   — set the version fields yourself:
   ```bash
   verity status set version <version>
   verity status set rollback_from <previous-digest-or-backup>
   ```
   `STATUS.md` is regenerated from `.verity/runtime.json` — never hand-write it.

8. **On failure → rollback:** re-pin the previous digests + re-run `deploy.sh` (safe
   because migrations are additive-only); note it in STATUS.md.
</process>
