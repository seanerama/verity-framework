// Spec-soundness gate (stage 115, ADR-0038 D4, request #304).
//
// Before decomposing an init-registered request the plan role judges whether
// the spec is buildable. An unsound spec is reported through the existing
// in-band marker with the gate name `spec-unsound` and the gaps as `reason`
// (one per line); the worker maps it to a `verity:needs-human` park on the
// request — never `verity:awaiting-approval` (approval would re-run the same
// plan on the same spec), never a strike — and `operator gates` renders it per
// the operator-gate contract's 2026-09-29 additive note.
//
// This module owns the ONE text shape both sides agree on, so the writer (the
// worker's gate comment) and the reader (`operator gates`' `gaps[]`) can never
// drift:
//
//   ⏸️ **verity-worker** `<run-id>` — paused at human gate `spec-unsound`
//   pending: request #<n> — …
//
//   ## Spec gaps
//   - <gap, verbatim from the role's reason, redacted>
//   - …
//
//   amend `docs/spec.md`, then `verity operator act clear-needs-human <n>` — the next tick re-plans
//
// The first line is the worker's gate-comment shape (GATE_COMMENT_PREFIX +
// "paused at human gate `<gate>`"), so every existing reader of that line —
// stage 111's latestGatePause/parseGatePause — reads the gate name and finds
// NO parked-result pointer (there is no `parked:` line): nothing can resume or
// merge from this comment, and stage 111's park-record machinery never writes
// or matches a park.json for it.
//
// Every gap line passes ledger.redact before it is written: the reason is the
// role's own text about the operator's spec, and a secret pasted into a spec
// must never be echoed onto GitHub.
//
// Pure: no I/O. Node built-ins only.
const ledger = require('./ledger.cjs');

const SPEC_UNSOUND_GATE = 'spec-unsound';
const SPEC_GAPS_HEADING = '## Spec gaps';
// The worker's gate-comment prefix (worker/index.cjs GATE_COMMENT_PREFIX) —
// repeated literally here (the worker requires this module, not vice versa);
// a test pins the two equal.
const GATE_COMMENT_PREFIX = '⏸️ **verity-worker**';
const FIRST_LINE_RE = new RegExp(
  `^${GATE_COMMENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \`([A-Za-z0-9][A-Za-z0-9._-]*)\` — paused at human gate \`${SPEC_UNSOUND_GATE}\`$`,
);
// The §7 run-summary `result:` text of a spec-unsound park. The no-progress
// breaker (worker countRepeatedRole) reads a summary carrying it as a streak
// BREAKER: a request re-planned after the operator cleared the park is new
// input, never a repeat of the same dispatch.
const SUMMARY_RESULT_PREFIX = `gated at ${SPEC_UNSOUND_GATE} — `;
const SUMMARY_RESULT_RE = new RegExp(`^result: ${SUMMARY_RESULT_PREFIX}`, 'm');
// The local substrate has no comment surface (contract local-work-item v1):
// the park is recorded in the record's own label commit, whose subject carries
// this note — `verity: label work-item #<n> +verity:needs-human (spec-unsound)`.
const LOCAL_LABEL_NOTE = SPEC_UNSOUND_GATE;

// The role's `reason` → the named gaps: one per non-empty line, a leading
// list bullet dropped (the comment re-bullets them), each line redacted.
function gapsFromReason(reason) {
  return String(reason ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ''))
    .filter((l) => l !== '')
    .map((l) => ledger.redact(l));
}

// The resume instruction — the approvalHint style (stage 111): what a human
// does, and what happens next. Approval does not apply here; the spec must
// change.
function resumeHint(number) {
  return `amend \`docs/spec.md\`, then \`verity operator act clear-needs-human ${number}\` — the next tick re-plans`;
}

function formatGateComment({ runId, number, gaps, mentions = [] }) {
  const lines = [
    `${GATE_COMMENT_PREFIX} \`${runId}\` — paused at human gate \`${SPEC_UNSOUND_GATE}\``,
    `pending: request #${number} — the plan role judged the spec not buildable as written; nothing was planned and nothing was guessed (labeled \`verity:needs-human\`, ADR-0038 D4)`,
    '',
    SPEC_GAPS_HEADING,
  ];
  if (gaps.length > 0) {
    lines.push(...gaps.map((g) => `- ${g}`));
  } else {
    lines.push('_the role named no gap — read its spec assessment under `feature-assessments/`_');
  }
  lines.push('', resumeHint(number));
  if (mentions.length > 0) {
    lines.push(`cc ${mentions.map((m) => `@${m}`).join(' ')}`);
  }
  return lines.join('\n');
}

// A comment body → { runId, gaps } when it is a spec-unsound gate comment
// (by its first line), else null. `gaps` are the `- ` lines of the
// `## Spec gaps` section up to the first blank line or heading; a comment
// whose section cannot be read yields [] (the contract note: `[]` when the
// comment could not be read). Says nothing about WHO wrote it — the caller
// authenticates.
function parseGateComment(body) {
  if (typeof body !== 'string') {
    return null;
  }
  const lines = body.split(/\r?\n/);
  const m = FIRST_LINE_RE.exec(lines[0]);
  if (m === null) {
    return null;
  }
  const gaps = [];
  const at = lines.indexOf(SPEC_GAPS_HEADING);
  if (at !== -1) {
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '' || line.startsWith('#')) {
        break;
      }
      if (line.startsWith('- ')) {
        const gap = line.slice(2).trim();
        if (gap !== '') {
          gaps.push(gap);
        }
      }
    }
  }
  return { runId: m[1], gaps };
}

module.exports = {
  GATE_COMMENT_PREFIX,
  LOCAL_LABEL_NOTE,
  SPEC_GAPS_HEADING,
  SPEC_UNSOUND_GATE,
  SUMMARY_RESULT_PREFIX,
  SUMMARY_RESULT_RE,
  formatGateComment,
  gapsFromReason,
  parseGateComment,
  resumeHint,
};
