// Usage ledger — `<git-dir>/verity/usage.csv` (`.verity/usage.csv` outside git;
// stage 108, see RUNTIME STATE below) + `verity usage` CLI (T11, SKETCH §3.4)
// and the daily-limit rollup the worker's §4.1 startup check consumes.
//
// CSV contract (§3.4, extended by stages 3 and 21): header row REQUIRED,
// append-only, one row PER ROLE INVOCATION (rows of one worker run share a
// run_id):
//
//   timestamp,run_id,repo,roles,tokens_in,tokens_out,est_usd,wall_secs,outcome,tool_calls,role,gate,provider,model
//
// Field encodings:
//   - timestamp  ISO-8601 UTC (new Date().toISOString())
//   - roles      role names joined with '+' (e.g. plan+build+review) so the
//                cell never needs CSV quoting; '' when no roles ran. On a
//                per-invocation row this is just that invocation's role (kept
//                for old readers — additive-only evolution, see below)
//   - est_usd    decimal (≤4 places); '' when the run had no cost estimate.
//                '' means UNKNOWN, not $0 (ADR-0008) — readers surface it as
//                null and rollups count it, never sum it as zero
//   - outcome    on a per-invocation row: THAT invocation's outcome
//                (success/gated/failed/infra_error); a run with zero role
//                invocations still writes one row carrying the run outcome
//   - tool_calls integer count of tool-use events in the invocation's
//                stream-json transcript (agent-exec counts them); 0 when unknown
//   - role       the single role this row is attributed to; '' on legacy rows
//                and on the zero-invocation fallback row
//   - gate       stage 21: the gate the RUN ended paused at (the run-level
//                outcome — every row of the run carries the same value); ''
//                when the run did not end gated and on pre-stage-21 rows. The
//                worker's startup breaker reads it to tell an unknown-cost run
//                that is PARKED at the unknown-cost gate (a human was asked)
//                from one that slipped through without a gate (nobody was).
//                Stage 25: a run whose role FAILED with unknown cost carries
//                the stamp too — the failure path parks at the same gate, so
//                a failed row can coexist with a gate cell; the stamp means
//                "a human was asked", not "the run ended gated"
//   - provider   stage 53: the agent provider that produced this row (e.g.
//                'claude', 'codex'); '' when the run recorded none (and on
//                pre-stage-53 rows). Telemetry/provenance only — never summed.
//   - model      stage 53: the model id that produced this row (e.g.
//                'gpt-5-codex'); '' when absent/null (a null model — the claude
//                default — writes '', NEVER a fabricated value) and on
//                pre-stage-53 rows. Telemetry/provenance only — never summed.
//   - all cells  RFC-4180 escaped anyway (quoted iff containing , " or newline)
//
// ADDITIVE-ONLY EVOLUTION: pre-stage-3 files (9 columns, one row per run),
// pre-stage-21 files (11 columns, no gate) and pre-stage-53 files (12 columns,
// no provider/model) are still valid — readers accept all four headers and all
// four row widths; missing trailing columns read as tool_calls=0, role='',
// gate='', provider='', model=''. Because a run may span several rows, rollups
// count `runs` as DISTINCT run_id values (identical to row-count on legacy
// files, where every row had its own run_id) so `checkDailyLimits` semantics
// are unchanged across formats.
//
// TIMEZONE: all day-windowing ("today", `--days N`) is UTC calendar days —
// the ledger stores UTC timestamps and the worker may run from any machine or
// CI runner, so local time would make the daily budget depend on where the
// worker happens to wake up. `--days N` = the last N UTC calendar days
// INCLUDING today (so `--days 1` = today UTC).
//
// MALFORMED INPUT: a missing usage.csv is an empty ledger; malformed rows
// (wrong column count, unparsable numbers/timestamp) are SKIPPED with a
// warning rather than failing the command — the ledger is append-only
// bookkeeping and one corrupt line must not brick `verity usage` or the
// worker's startup check (which would otherwise fail CLOSED and halt
// autonomy over a typo).
//
// UNKNOWN COST (ADR-0008, stage 18 / #51): an empty est_usd cell is UNKNOWN —
// a provider that reports no dollar figure (codex) writes it on every row. It
// is NOT zero, and nothing downstream may treat it as zero: rows carry
// est_usd: null, rollups sum only the KNOWN spend into `est_usd` and count the
// rest into `unknown_cost_runs` / `unknown_cost_rows`, and checkDailyLimits
// refuses to clear a budget it cannot see all of. A non-empty but unparsable
// cell is a MALFORMED row exactly as before — "unknown" never means "corrupt".
//
// RUNTIME STATE, NEVER COMMITTED, IN THE GIT DIRECTORY (stage 108, ADR-0036
// as amended): before 108 `record` committed the ledger
// (`chore(verity): usage <run-id>`) on whatever branch HEAD was on — the stage
// branch the run built on — and the next tick's fresh stage branch, forked
// from the squash-merged default branch, silently reverted the file (9 of 14
// rows lost on the fixture-A benchmark run). An ignored working-tree file is
// not enough: git overwrites it whenever the checkout target still tracks the
// path. So the ledger lives where no checkout, merge, reset, clean or stash
// can reach it:
//   - `ledgerPath(cwd)` (alias `usagePath`) → `<git-dir>/verity/usage.csv`
//     (`git rev-parse --git-dir`, absolute, per-worktree by construction);
//     `<cwd>/.verity/usage.csv` only when cwd is not inside a git repository.
//     EVERY reader and writer resolves the file through it. Stage 112: it
//     fails CLOSED — a git error other than "not a git repository" inside a
//     repository throws LedgerPathError instead of falling back;
//   - `record` appends only — no git at all; policy `commit_usage` is ignored
//     (autonomy.cjs warns when it is set true);
//   - `recoverLedger` (`verity usage recover`, and the worker's one-time seed
//     via `seedLedger`) unions the sidecar, the legacy working-tree file and
//     every historical `chore(verity): usage` commit into the SIDECAR — git
//     reads only, the working tree is never written; since stage 112 the
//     sidecar is replaced by temp-file + rename, re-read just before the
//     rename so a concurrent append survives;
//   - `untrackLedger` (`verity usage untrack`, operator-only — the worker never
//     calls it) stops tracking the stale in-tree file with one plumbing-built
//     bot commit, shipped as an ordinary reviewed change;
//   - the scaffold .gitignore still ignores `.verity/usage.csv` from birth, so
//     a stray in-tree ledger is never committed.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COLUMNS = [
  'timestamp',
  'run_id',
  'repo',
  'roles',
  'tokens_in',
  'tokens_out',
  'est_usd',
  'wall_secs',
  'outcome',
  'tool_calls',
  'role',
  'gate',
  'provider',
  'model',
];
const HEADER = COLUMNS.join(',');
// Pre-stage-53 files: 12 columns, no provider/model. Still readable forever.
const STAGE21_COLUMNS = COLUMNS.slice(0, 12);
const STAGE21_HEADER = STAGE21_COLUMNS.join(',');
// Pre-stage-21 files: 11 columns, no gate. Still readable forever.
const STAGE3_COLUMNS = COLUMNS.slice(0, 11);
const STAGE3_HEADER = STAGE3_COLUMNS.join(',');
// Pre-stage-3 files: 9 columns, no tool_calls/role. Still readable forever.
const LEGACY_COLUMNS = COLUMNS.slice(0, 9);
const LEGACY_HEADER = LEGACY_COLUMNS.join(',');

// The worker's unknown-cost gate name (worker/index.cjs UNKNOWN_COST_GATE reads
// this — single source, because checkDailyLimits below matches gate cells
// against it). ADR-0008.
const UNKNOWN_COST_GATE = 'unknown-cost';
// The in-tree ledger path: the live ledger outside a git repository, the
// legacy (pre-108) location inside one — `recover` still reads it there.
const CSV_REL_PATH = path.join('.verity', 'usage.csv');
// The same path as git spells it (pathspecs, `<rev>:<path>` blobs, .gitignore).
const LEDGER_GIT_PATH = '.verity/usage.csv';
// Stage 108 (ADR-0036): the ignore line + its comment, as the scaffold template,
// `untrack` and every ensureIgnoreLine() caller write them.
const LEDGER_IGNORE_COMMENT =
  '# Verity usage ledger: runtime state, never committed (stage 108, ADR-0036)';
const LEDGER_IGNORE_LINE = LEDGER_GIT_PATH;
// The one commit `verity usage untrack` makes. Distinct from the pre-108
// per-run subject (`chore(verity): usage <run-id>`) by its fixed text, which
// recoverLedger excludes by exact match.
const MIGRATION_MESSAGE = 'chore(verity): usage ledger is runtime state (stage 108, ADR-0036)';
// What every pre-108 ledger commit's subject starts with (recover's grep).
const USAGE_COMMIT_GREP = '^chore(verity): usage ';

// The sidecar's place inside the git directory (stage 108, ADR-0036 amended).
const SIDECAR_REL_PATH = path.join('verity', 'usage.csv');

// Stage 112 (#283 S1): the ledger's location could not be determined. Thrown by
// resolveGitDir (and so by ledgerPath and every reader/writer) when git fails
// for any reason OTHER than "not a git repository" inside what looks like a
// repository — a `safe.directory` "dubious ownership" refusal (cron or a
// console running as another user, containers), a malformed config, a timeout,
// no git binary. Falling back to the in-tree path there would read and write a
// file no other process uses: the daily breaker would under-read. Callers
// surface it (the worker refuses the run as infra; the CLI verbs exit non-zero).
class LedgerPathError extends Error {
  constructor(cwd, gitError) {
    super(
      `cannot locate the usage ledger: \`git rev-parse --git-dir\` in ${cwd} failed (${gitError}) — refusing to fall back to the in-tree ${LEDGER_GIT_PATH}, which other processes do not use (stage 112)`,
    );
    this.name = 'LedgerPathError';
    this.cwd = cwd;
    this.gitError = gitError;
  }
}

// Is there any sign of a git repository at or above `dir`? A `.git` entry
// (directory, or the file a worktree/submodule uses) walking up to the root, or
// an explicit GIT_DIR. Used only to tell "git failed because there is no
// repository here" from "git failed inside a repository".
function hasGitMarker(dir) {
  if (typeof process.env.GIT_DIR === 'string' && process.env.GIT_DIR !== '') {
    return true;
  }
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      return true;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return false;
    }
    cur = parent;
  }
}

// The git directory for `cwd` (absolute), or null when cwd is not inside a git
// repository. The answer is read from git's OUTPUT and must name an existing
// directory, so a stand-in `git` that exits 0 for anything (test stubs,
// wrappers) is never taken as a bogus location.
//
// Stage 112 (#283 S1): FAIL CLOSED. null (→ the in-tree fallback) only when
// git itself says "not a git repository", or when there is no repository to be
// found at all (no `.git` walking up, no GIT_DIR) — the two ways "not a
// repository" is actually true. Any other failure inside something that looks
// like a repository throws LedgerPathError naming git's error.
function resolveGitDir(cwd) {
  const res = git(cwd, ['rev-parse', '--git-dir']);
  const out = res.ok ? res.stdout.trim() : '';
  let abs = null;
  if (out !== '' && !out.includes('\n')) {
    const candidate = path.resolve(cwd, out);
    try {
      abs = fs.statSync(candidate).isDirectory() ? candidate : null;
    } catch {
      abs = null;
    }
  }
  if (abs !== null) {
    return abs;
  }
  if ((!res.ok && /not a git repository/i.test(res.stderr)) || !hasGitMarker(cwd)) {
    return null;
  }
  throw new LedgerPathError(
    cwd,
    res.ok
      ? `exit 0 but no usable git directory in its output (${JSON.stringify(out.slice(0, 200))})`
      : firstErrLine(res),
  );
}

// cwd (resolved) → sidecar path, for the process lifetime. Only a git answer
// is cached: a non-git cwd is re-probed, so a directory that becomes a
// repository later (`git init`) is never pinned to the working-tree fallback.
const ledgerPathCache = new Map();

// THE single resolver every ledger reader and writer uses (stage 108,
// ADR-0036 amended): `<git-dir>/verity/usage.csv` inside a git repository
// (never touched by checkout/merge/reset/clean/stash, and per-worktree — a
// `git worktree add` checkout gets its own); `<cwd>/.verity/usage.csv`, exactly
// as before, outside one. Pure path resolution — the directory is created on
// write (appendUsage / writeLedgerFile), never here.
function ledgerPath(cwd) {
  const key = path.resolve(cwd);
  const hit = ledgerPathCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const gitDir = resolveGitDir(key);
  if (gitDir === null) {
    return path.join(cwd, CSV_REL_PATH);
  }
  const file = path.join(gitDir, SIDECAR_REL_PATH);
  ledgerPathCache.set(key, file);
  return file;
}

// The historical name; every existing caller keeps working and resolves the
// same file.
const usagePath = ledgerPath;

// --- CSV encode/decode (RFC 4180 subset; zero-dep) ---------------------------

function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Split one CSV line into cells, honoring double-quoted cells with "" escapes.
// Returns null when the line is structurally broken (unterminated quote).
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"' && cur === '') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (quoted) {
    return null;
  }
  cells.push(cur);
  return cells;
}

// --- append (write side) ------------------------------------------------------

// Worker summary ({ runId, repo, outcome, roles, tokens:{in,out}, est_usd,
// wall_secs }) → ordered row object matching COLUMNS. This is the
// zero-invocation shape (run-level totals, role '', tool_calls from the
// summary when present).
function entryFromSummary(summary, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    run_id: summary.runId,
    repo: summary.repo,
    roles: (summary.roles || []).join('+'),
    tokens_in: summary.tokens?.in || 0,
    tokens_out: summary.tokens?.out || 0,
    est_usd: typeof summary.est_usd === 'number' ? Number(summary.est_usd.toFixed(4)) : '',
    wall_secs: summary.wall_secs || 0,
    outcome: summary.outcome,
    tool_calls: summary.tool_calls || 0,
    role: summary.role || '',
    gate: summary.gate || '',
    // Stage 53: provenance of the agent that produced the run. A null model
    // (the claude default) writes '' — never a fabricated value.
    provider: summary.provider ?? '',
    model: summary.model ?? '',
  };
}

// One role invocation ({ role, outcome, tokens:{in,out}, est_usd, wall_secs,
// tool_calls } — the agent-exec result plus the role name) → per-invocation
// row attributed to that role, sharing the run's run_id.
function entryFromInvocation(summary, inv, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    run_id: summary.runId,
    repo: summary.repo,
    roles: inv.role || '',
    tokens_in: inv.tokens?.in || 0,
    tokens_out: inv.tokens?.out || 0,
    est_usd: typeof inv.est_usd === 'number' ? Number(inv.est_usd.toFixed(4)) : '',
    wall_secs: inv.wall_secs || 0,
    outcome: inv.outcome,
    tool_calls: inv.tool_calls || 0,
    role: inv.role || '',
    // The RUN's terminal gate, not the invocation's — see the header note.
    gate: summary.gate || '',
    // Stage 53: the invocation's own provider/model (worker-wide today; stage
    // 54 makes it per-role), falling back to the run-level summary. Null/absent
    // ⇒ '' — never a fabricated value.
    provider: inv.provider ?? summary.provider ?? '',
    model: inv.model ?? summary.model ?? '',
  };
}

function formatRow(entry) {
  return COLUMNS.map((c) => escapeCell(entry[c])).join(',');
}

// Append one §3.4 row; create the file (with the required header) and the
// .verity dir if missing. Append-only: never rewrites existing content.
function appendUsage(cwd, entry) {
  const file = usagePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${HEADER}\n`);
  }
  const row = formatRow(entry);
  fs.appendFileSync(file, `${row}\n`);
  return { path: file, row };
}

// The bot identity every ENGINE-owned commit attributes itself to (the
// operator-run `verity usage untrack` commit uses it too). Such a
// commit is the WORKER's own action, so it carries a stable non-human identity
// rather than depending on ambient git config — which is UNSET on a fresh CI
// runner (the generated verity-worker.yml sets none), where the commit would
// otherwise die with "Author identity unknown" (#3). The email is a GitHub
// noreply address: safe and non-routable. A single `-c user.name`/`-c
// user.email` pair sets BOTH the author and the committer, and `-c` scopes it
// to this one command — it never mutates the user's git config.
const COMMIT_AUTHOR_NAME = 'verity-worker';
const COMMIT_AUTHOR_EMAIL = 'verity-worker@users.noreply.github.com';

// The scoped-identity argv prefix every ENGINE-owned commit uses — since stage
// 96 (ADR-0033) the intent-artifacts commit (agents/intent-artifacts.cjs), and
// since stage 108 (ADR-0036) the operator's `verity usage untrack` commit
// below. (The per-run ledger commit that introduced it in stage 38 is gone:
// the ledger is runtime state.) One definition, so the commits can never drift.
function botIdentityGitArgs() {
  return ['-c', `user.name=${COMMIT_AUTHOR_NAME}`, '-c', `user.email=${COMMIT_AUTHOR_EMAIL}`];
}

// One-call write side for the worker: append one row per role invocation
// (summary.invocations, sharing the summary's run_id) — or the single
// run-level fallback row when the run invoked no roles. Appends to
// ledgerPath(cwd) and does NOTHING with git (stage 108, ADR-0036): `opts.commit`
// / policy `commit_usage` are ignored. The append can throw (disk full etc. —
// caller's choice).
function record(cwd, summary, opts = {}) {
  const now = opts.now || new Date();
  const invocations = Array.isArray(summary.invocations) ? summary.invocations : [];
  const entries =
    invocations.length > 0
      ? invocations.map((inv) => entryFromInvocation(summary, inv, now))
      : [entryFromSummary(summary, now)];
  let appended;
  for (const entry of entries) {
    appended = appendUsage(cwd, entry);
  }
  return {
    path: appended.path,
    row: appended.row,
    rows: entries.length,
  };
}

// --- read / rollup (the CLI and the §4.1 daily-limit check) -------------------

function isHeaderLine(line) {
  return (
    line === HEADER || line === STAGE21_HEADER || line === STAGE3_HEADER || line === LEGACY_HEADER
  );
}

// One data line → the parsed row object, or null when it is malformed (wrong
// column count, unparsable numbers/timestamp). The single row validator:
// readUsage skips a null, recoverLedger refuses to import one.
function parseRowLine(line) {
  const cells = splitCsvLine(line);
  // Additive-only evolution: 9-column (pre-stage-3), 11-column (pre-stage-21)
  // and 12-column (pre-stage-53) rows are as valid as current ones — the
  // missing trailing cells read as tool_calls=0, role='', gate='',
  // provider='', model=''.
  if (
    cells === null ||
    (cells.length !== COLUMNS.length &&
      cells.length !== STAGE21_COLUMNS.length &&
      cells.length !== STAGE3_COLUMNS.length &&
      cells.length !== LEGACY_COLUMNS.length)
  ) {
    return null;
  }
  const row = {};
  for (let c = 0; c < COLUMNS.length; c += 1) {
    row[COLUMNS[c]] = cells[c] ?? '';
  }
  const ts = Date.parse(row.timestamp);
  const tokensIn = Number(row.tokens_in);
  const tokensOut = Number(row.tokens_out);
  // '' is UNKNOWN cost (null), never 0 — see the header note. Anything else
  // that fails to parse stays malformed and skips the row, as it always has.
  const estUsd = row.est_usd === '' ? null : Number(row.est_usd);
  const wallSecs = Number(row.wall_secs);
  const toolCalls = row.tool_calls === '' ? 0 : Number(row.tool_calls);
  if (
    Number.isNaN(ts) ||
    !Number.isFinite(tokensIn) ||
    !Number.isFinite(tokensOut) ||
    (estUsd !== null && !Number.isFinite(estUsd)) ||
    !Number.isFinite(wallSecs) ||
    !Number.isFinite(toolCalls)
  ) {
    return null;
  }
  return {
    timestamp: row.timestamp,
    ts,
    run_id: row.run_id,
    repo: row.repo,
    roles: row.roles === '' ? [] : row.roles.split('+'),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    est_usd: estUsd,
    wall_secs: wallSecs,
    outcome: row.outcome,
    tool_calls: toolCalls,
    role: row.role,
    gate: row.gate,
    provider: row.provider,
    model: row.model,
  };
}

// Parse usage.csv → { rows, skipped }. Missing file → empty ledger. Each
// malformed line is skipped and reported via opts.warn(message) (default:
// silent collection — the count is always in `skipped`).
function readUsage(cwd, opts = {}) {
  const warn = opts.warn || (() => {});
  const file = usagePath(cwd);
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, rows: [], skipped: 0 };
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = [];
  let skipped = 0;
  let sawHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    if (isHeaderLine(line)) {
      sawHeader = true; // header row (required on line 1; tolerated if repeated)
      continue;
    }
    if (i === 0) {
      warn(`usage.csv line 1: expected header '${HEADER}' — parsing rows anyway`);
    }
    const row = parseRowLine(line);
    if (row === null) {
      skipped += 1;
      warn(`usage.csv line ${i + 1}: malformed row skipped`);
      continue;
    }
    rows.push(row);
  }
  if (!sawHeader && rows.length === 0 && skipped === 0) {
    warn('usage.csv: empty file without header — treating as empty ledger');
  }
  return { path: file, exists: true, rows, skipped };
}

// --- runtime-state maintenance (stage 108, ADR-0036) ----------------------------

// Every non-empty, non-header line of a ledger text, verbatim (full-line
// identity is how rows are unioned — a row is immutable once appended).
function dataLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !isHeaderLine(l));
}

// A ledger file's data lines ([] when the file is absent).
function fileDataLines(file) {
  return fs.existsSync(file) ? dataLines(fs.readFileSync(file, 'utf8')) : [];
}

// The live ledger's data lines (ledgerPath(cwd)).
function ledgerDataLines(cwd) {
  return fileDataLines(ledgerPath(cwd));
}

// Sort key: the timestamp cell (ISO-8601, never quoted). A line whose
// timestamp does not parse sorts last — it is kept, never dropped.
function lineTs(line) {
  const ts = Date.parse(line.slice(0, line.indexOf(',')));
  return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
}

// Rewrite a ledger file as HEADER + `lines` sorted by timestamp (stable: ties
// keep their input order). HEADER reads every older row width
// (additive-only), so a legacy-headed file loses nothing by gaining the
// current header. Creates the parent directory (the sidecar's `verity/`).
function writeLedgerFile(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = lines
    .map((line, i) => ({ line, i, ts: lineTs(line) }))
    .sort((a, b) => (a.ts === b.ts ? a.i - b.i : a.ts < b.ts ? -1 : 1))
    .map((e) => e.line);
  fs.writeFileSync(file, `${[HEADER, ...sorted].join('\n')}\n`);
}

// Stage 112 (#283 N4): replace a LIVE ledger file without losing a concurrent
// append and without ever leaving it truncated. `recover` runs outside the
// worker lock, so a worker may append a row between recover's read and its
// write; and a recover killed mid-write used to leave a truncated ledger.
// Now: write `lines` to a temp file beside the ledger (same directory ⇒ same
// filesystem ⇒ an atomic rename), then RE-READ the live file immediately
// before the rename and fold in any row that appeared since `have` was read —
// then rename over the live file. An interrupted write leaves the live file
// exactly as it was (the temp file is removed on a thrown error). The
// remaining window is the re-read→rename instant, not the whole recover.
// `opts.beforeFinalRead` is a test seam (called after the temp write, before
// the re-read) — it is how the suite injects a concurrent append.
function replaceLedgerFile(file, lines, have, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.recover-${process.pid}.tmp`;
  try {
    writeLedgerFile(tmp, lines);
    if (typeof opts.beforeFinalRead === 'function') {
      opts.beforeFinalRead(tmp);
    }
    const late = fileDataLines(file).filter((l) => !have.has(l));
    if (late.length > 0) {
      writeLedgerFile(tmp, [...lines, ...late]);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Does a .gitignore text already ignore the ledger by an explicit line?
function hasIgnoreLine(text) {
  return String(text)
    .split(/\r?\n/)
    .some((l) => l.trim() === LEDGER_IGNORE_LINE || l.trim() === `/${LEDGER_IGNORE_LINE}`);
}

// `text` with the ADR-0036 ignore line (and its comment) appended unless it is
// already there — the one spelling the template, `untrack` and the benchmark
// provisioner all share.
function withIgnoreLine(text) {
  if (hasIgnoreLine(text)) {
    return text;
  }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${LEDGER_IGNORE_COMMENT}\n${LEDGER_IGNORE_LINE}\n`;
}

// Append the ignore line to an ignore FILE unless it is already there.
// Idempotent; creates the file when absent. Returns true when it wrote. Used
// by the benchmark provisioner and the no-commits-yet `untrack` path, so no
// repo ever carries the line twice.
function ensureIgnoreLine(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (hasIgnoreLine(text)) {
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, withIgnoreLine(text));
  return true;
}

// Security invariant 1.6: git never prompts (GIT_TERMINAL_PROMPT=0) and every
// call has a deadline. A timeout surfaces as { ok: false } like any failure.
// Args are always an array (no shell); `input` feeds stdin (hash-object).
const GIT_TIMEOUT_MS = 120_000;

function git(cwd, args, extraEnv, input) {
  const res = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0' },
    ...(input === undefined ? {} : { input }),
  });
  return {
    ok: res.status === 0 && !res.error,
    stdout: res.stdout || '',
    stderr: (res.stderr || (res.error ? res.error.message : '')).trim(),
  };
}

function firstErrLine(res) {
  return res.stderr.split('\n')[0] || 'unknown error';
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

// The repository facts every ledger verb needs. `null` when cwd is not inside
// a git work tree. Every query runs at the TOP level (pathspecs are relative
// to -C). `inHead` / `inIndex` are the two ways the ledger can be tracked:
// committed at HEAD, or staged for the next commit. Every answer is read from
// git's OUTPUT, not just its exit code, so a stand-in `git` that exits 0 for
// anything reads as "not a repository", never as "tracked".
function ledgerGitState(cwd) {
  // Stage 112: the repository question is resolveGitDir's — so a git failure
  // inside a repository throws LedgerPathError here too, instead of reading as
  // "not a repository — nothing to untrack".
  if (resolveGitDir(cwd) === null) {
    return null;
  }
  const top = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
  if (top === '' || !path.isAbsolute(top) || !fs.existsSync(top)) {
    return null;
  }
  const gitDir = resolveGitDir(top);
  if (gitDir === null) {
    return null;
  }
  const names = (args) => git(top, args).stdout.split('\n');
  const head = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
  const hasHead = SHA_RE.test(head);
  return {
    top,
    gitDir,
    head: hasHead ? head : null,
    hasHead,
    inHead:
      hasHead &&
      names(['ls-tree', '--name-only', 'HEAD', '--', LEDGER_GIT_PATH]).includes(LEDGER_GIT_PATH),
    inIndex: names(['ls-files', '--', LEDGER_GIT_PATH]).includes(LEDGER_GIT_PATH),
  };
}

// Is the in-tree ledger tracked (committed at HEAD or staged)? null = not a
// git repo. `verity doctor` and the worker's run start warn on true.
function isLedgerTracked(cwd) {
  const st = ledgerGitState(cwd);
  return st === null ? null : st.inHead || st.inIndex;
}

// F2 (PR #282 review): a commit built while one of these is in progress would
// silently resolve or abandon it (a MERGE_HEAD turns a plain commit into a
// two-parent "ours" merge). `untrack` refuses instead. All are per-worktree,
// so they are looked up in the worktree's own git dir.
const IN_PROGRESS_MARKERS = [
  ['MERGE_HEAD', 'a merge is in progress'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
  ['REVERT_HEAD', 'a revert is in progress'],
  ['rebase-merge', 'a rebase is in progress'],
  ['rebase-apply', 'a rebase (or git am) is in progress'],
  // Stage 112 (#283 N6): a multi-commit cherry-pick/revert keeps its queue in
  // sequencer/ (it can outlive CHERRY_PICK_HEAD between picks), and a bisect
  // leaves BISECT_LOG — a commit made mid-bisect lands on a detached probe.
  ['sequencer', 'a cherry-pick or revert sequence is in progress'],
  ['BISECT_LOG', 'a bisect is in progress'],
];

function operationInProgress(gitDir) {
  for (const [marker, what] of IN_PROGRESS_MARKERS) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      return { marker, what };
    }
  }
  return null;
}

// `<mode> <sha>` of `path` in a tree-ish (ls-tree) or the index (ls-files -s,
// which prints `<mode> <sha> <stage>`), or null when absent.
function treeEntry(top, treeish, file) {
  const line = git(top, ['ls-tree', treeish, '--', file]).stdout.split('\n')[0] || '';
  const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t/.exec(line);
  return m ? { mode: m[1], sha: m[2] } : null;
}

function indexEntry(top, file) {
  const line = git(top, ['ls-files', '-s', '--', file]).stdout.split('\n')[0] || '';
  const m = /^(\d{6}) ([0-9a-f]{40,64}) \d\t/.exec(line);
  return m ? { mode: m[1], sha: m[2] } : null;
}

// The bot identity as environment too: GIT_AUTHOR_*/GIT_COMMITTER_* in the
// operator's environment would otherwise outrank the `-c user.*` pair.
function botIdentityEnv() {
  return {
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
  };
}

// The untrack commit, built with plumbing (F3/F4): a temporary index seeded
// from HEAD gets exactly two edits — `.gitignore` := HEAD's `.gitignore` + the
// ignore line (a blob hashed from HEAD's text, never the working file, so no
// unrelated staged or unstaged edit is swept in), and the ledger removed —
// then write-tree / commit-tree -p HEAD (bot identity) / update-ref on the
// current branch with HEAD as the expected old value. No porcelain commit, so
// no hook runs (update-ref is pointed at an empty hooks path too). Returns
// { commit, ignoreAdded, newIgnore } or { error }; `commit` is null when the
// resulting tree equals HEAD's (staged-only ledger, ignore line present).
function buildUntrackCommit(st) {
  const { top, gitDir, head } = st;
  const headIgnore = treeEntry(top, head, '.gitignore');
  const headText = headIgnore === null ? '' : git(top, ['cat-file', 'blob', headIgnore.sha]).stdout;
  const newText = withIgnoreLine(headText);
  const ignoreAdded = newText !== headText;
  let newIgnore = headIgnore;
  if (ignoreAdded) {
    const h = git(top, ['hash-object', '-w', '--stdin'], {}, newText);
    const sha = h.stdout.trim();
    if (!h.ok || !SHA_RE.test(sha)) {
      return { error: `git hash-object failed: ${firstErrLine(h)}` };
    }
    newIgnore = { mode: headIgnore === null ? '100644' : headIgnore.mode, sha };
  }
  const tmpIndex = path.join(gitDir, 'verity-untrack.index');
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    fs.rmSync(tmpIndex, { force: true });
    const steps = [['read-tree', head]];
    if (ignoreAdded) {
      steps.push([
        'update-index',
        '--add',
        '--cacheinfo',
        `${newIgnore.mode},${newIgnore.sha},.gitignore`,
      ]);
    }
    steps.push(['update-index', '--force-remove', '--', LEDGER_GIT_PATH]);
    for (const args of steps) {
      const r = git(top, args, env);
      if (!r.ok) {
        return { error: `git ${args[0]} failed: ${firstErrLine(r)}` };
      }
    }
    const wt = git(top, ['write-tree'], env);
    const tree = wt.stdout.trim();
    if (!wt.ok || !SHA_RE.test(tree)) {
      return { error: `git write-tree failed: ${firstErrLine(wt)}` };
    }
    if (tree === git(top, ['rev-parse', `${head}^{tree}`]).stdout.trim()) {
      return {
        commit: null,
        ignoreAdded: false,
        headText,
        newText: headText,
        headIgnore,
        newIgnore,
      };
    }
    const ct = git(
      top,
      [...botIdentityGitArgs(), 'commit-tree', tree, '-p', head, '-m', MIGRATION_MESSAGE],
      botIdentityEnv(),
    );
    const commit = ct.stdout.trim();
    if (!ct.ok || !SHA_RE.test(commit)) {
      return { error: `git commit-tree failed: ${firstErrLine(ct)}` };
    }
    const sym = git(top, ['symbolic-ref', '-q', 'HEAD']).stdout.trim();
    const ref = sym.startsWith('refs/') ? sym : 'HEAD';
    const noHooks = path.join(gitDir, 'verity-no-hooks');
    const ur = git(top, [
      '-c',
      `core.hooksPath=${noHooks}`,
      'update-ref',
      '-m',
      MIGRATION_MESSAGE,
      ref,
      commit,
      head,
    ]);
    if (!ur.ok) {
      return { error: `git update-ref ${ref} failed: ${firstErrLine(ur)}` };
    }
    return { commit, ignoreAdded, headText, newText, headIgnore, newIgnore };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

// `verity usage untrack [--json]` — OPERATOR hygiene (the worker never calls
// it): stop tracking the stale in-tree `.verity/usage.csv` in one reviewed
// change. The live ledger is the sidecar (ledgerPath) and is never touched;
// the working-tree file is never touched either (index-only removal).
// Idempotent; never throws (a git failure comes back in `error`).
//
//   not a repository / not tracked  → nothing written, `changed: false`
//   merge/cherry-pick/revert/rebase in progress → `ok: false`, `refused`
//     names the marker (F2) — nothing written
//   tracked, no commit yet          → unstaged; ignore line in .gitignore
//   tracked at HEAD or staged       → buildUntrackCommit, then the REAL index
//     drops the ledger entry (the `git rm --cached` half), and `.gitignore` in
//     the index / working tree is refreshed from the new HEAD only where it had
//     no local modification — otherwise it is left alone and the reason says so
//
// `changed: true` whenever anything was written (F6).
function untrackLedger(cwd) {
  const result = {
    ok: true,
    changed: false,
    tracked: false,
    ignore_added: false,
    commit: null,
    gitignore_refreshed: false,
    refused: null,
    error: null,
    reason: '',
  };
  let st;
  try {
    st = ledgerGitState(cwd);
  } catch (err) {
    // Stage 112: a git failure (LedgerPathError included) is an error, never
    // "not a repository" — dispatchUntrack turns it into a non-zero exit.
    result.ok = false;
    result.error = err.message;
    result.reason = err.message;
    return result;
  }
  if (st === null) {
    result.reason = 'not a git repository — nothing to untrack';
    return result;
  }
  result.tracked = st.inHead || st.inIndex;
  if (!result.tracked) {
    result.reason = `${LEDGER_GIT_PATH} is not tracked — nothing to do`;
    return result;
  }
  const busy = operationInProgress(st.gitDir);
  if (busy !== null) {
    result.ok = false;
    result.refused = busy.marker;
    result.reason = `refusing to untrack ${LEDGER_GIT_PATH}: ${busy.what} (${busy.marker} exists in ${st.gitDir}) — finish or abort it, then run \`verity usage untrack\` again`;
    return result;
  }
  const top = st.top;
  if (!st.hasHead) {
    // Staged in a repository with no commit yet: unstage it; there is no
    // history to migrate and no commit to make.
    const rm = git(top, ['update-index', '--force-remove', '--', LEDGER_GIT_PATH]);
    if (!rm.ok) {
      result.ok = false;
      result.error = `git update-index failed: ${firstErrLine(rm)}`;
      return result;
    }
    try {
      result.ignore_added = ensureIgnoreLine(path.join(top, '.gitignore'));
    } catch (err) {
      result.ok = false;
      result.error = `could not write .gitignore: ${err.message}`;
      return result;
    }
    result.changed = true;
    result.reason = `${LEDGER_GIT_PATH} unstaged (no commits yet); ignore line ensured`;
    return result;
  }
  // The real index's .gitignore BEFORE the commit moves HEAD — the "no local
  // modification" test compares against the OLD head.
  const indexIgnoreBefore = indexEntry(top, '.gitignore');
  const built = buildUntrackCommit(st);
  if (built.error !== undefined) {
    result.ok = false;
    result.error = built.error;
    return result;
  }
  // The `--cached` half: the real index stops tracking the ledger (working
  // file kept). update-index --force-remove never refuses on a working file
  // that has grown since it was staged, unlike `git rm --cached`.
  const rm = git(top, ['update-index', '--force-remove', '--', LEDGER_GIT_PATH]);
  if (!rm.ok) {
    result.ok = false;
    result.error = `git update-index (real index) failed: ${firstErrLine(rm)}`;
    return result;
  }
  result.changed = true;
  result.commit = built.commit;
  result.ignore_added = built.ignoreAdded;
  const notes = [];
  if (built.ignoreAdded) {
    const same = (a, b) => (a === null ? b === null : b !== null && a.sha === b.sha);
    if (same(indexIgnoreBefore, built.headIgnore)) {
      git(top, [
        'update-index',
        '--add',
        '--cacheinfo',
        `${built.newIgnore.mode},${built.newIgnore.sha},.gitignore`,
      ]);
    } else {
      notes.push('.gitignore has staged changes, left in the index as they were');
    }
    const workFile = path.join(top, '.gitignore');
    const workText = fs.existsSync(workFile) ? fs.readFileSync(workFile, 'utf8') : null;
    const clean = built.headIgnore === null ? workText === null : workText === built.headText;
    if (clean) {
      fs.writeFileSync(workFile, built.newText);
      result.gitignore_refreshed = true;
    } else {
      notes.push(
        'the working .gitignore has local modifications and was left as it is — the committed one carries the ignore line',
      );
    }
  }
  const where =
    built.commit === null
      ? 'unstaged — it was never committed'
      : `untracked in ${built.commit.slice(0, 12)}`;
  result.reason = `${LEDGER_GIT_PATH} ${where} (the working-tree file is kept; the live ledger is ${ledgerPath(cwd)})${
    notes.length > 0 ? `; ${notes.join('; ')}` : ''
  }`;
  return result;
}

// `verity usage recover` — rebuild the live ledger (the SIDECAR) from every
// place a pre-108 repo left rows: the sidecar itself (if any), the working-tree
// `.verity/usage.csv` (tracked or not), and the ledger blob of every
// `chore(verity): usage <run-id>` commit reachable from ANY local ref
// (`git log --all`). Rows union by full-line identity and are written back
// sorted by timestamp with the header first — to the sidecar ONLY; the tree
// file is read, never written. Idempotent: a second run adds 0 and writes
// nothing. A commit whose blob is missing, has no recognizable header, or
// cannot be read is SKIPPED and counted (`commits_skipped`) — never a throw; a
// malformed row (tree file or blob) is dropped and counted (`rows_skipped`).
// The untrack commit (MIGRATION_MESSAGE) carries no ledger and is excluded.
// Git READS only. Benchmark records are never touched.
function recoverLedger(cwd, opts = {}) {
  const gitDir = resolveGitDir(cwd);
  if (gitDir === null) {
    throw new Error(`usage recover: ${cwd} is not inside a git repository`);
  }
  const topOut = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
  const top = topOut !== '' && path.isAbsolute(topOut) ? topOut : path.resolve(cwd);
  const log = git(top, ['log', '--all', '--format=%H%x09%s', `--grep=${USAGE_COMMIT_GREP}`]);
  if (!log.ok) {
    throw new Error(`usage recover: git log failed: ${firstErrLine(log)}`);
  }
  const shas = log.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\t'))
    .filter(([, subject]) => subject !== MIGRATION_MESSAGE)
    .map(([sha]) => sha);
  const file = ledgerPath(cwd);
  const before = fileDataLines(file);
  const have = new Set(before);
  const added = [];
  let commitsSkipped = 0;
  let rowsSkipped = 0;
  const take = (lines) => {
    for (const line of lines) {
      if (have.has(line)) {
        continue;
      }
      if (parseRowLine(line) === null) {
        rowsSkipped += 1;
        continue;
      }
      have.add(line);
      added.push(line);
    }
  };
  const treeLines = fileDataLines(path.join(top, CSV_REL_PATH));
  take(treeLines);
  for (const sha of shas) {
    const blob = git(top, ['show', `${sha}:${LEDGER_GIT_PATH}`]);
    const first = blob.ok ? blob.stdout.split(/\r?\n/).find((l) => l.trim() !== '') : undefined;
    if (!blob.ok || first === undefined || !isHeaderLine(first)) {
      commitsSkipped += 1;
      continue;
    }
    take(dataLines(blob.stdout));
  }
  if (added.length > 0) {
    replaceLedgerFile(file, [...before, ...added], have, opts);
  }
  return {
    path: file,
    commits_scanned: shas.length,
    commits_skipped: commitsSkipped,
    tree_rows: treeLines.length,
    rows_before: before.length,
    rows_added: added.length,
    rows_skipped: rowsSkipped,
    rows_after: before.length + added.length,
  };
}

// The worker's run-start step (stage 108, ADR-0036 amended) — git READS only,
// never a commit, a checkout or a write under the working tree:
//   - when the sidecar does not exist yet, seed it once by the recover union
//     (the legacy tree file + every historical usage commit); `seeded` counts
//     the rows it wrote (0 when there was nothing to seed — then no file is
//     created, and the next run looks again at the cost of one `git log`);
//   - `tracked` reports whether the tree still tracks `.verity/usage.csv`, so
//     the caller can warn, naming `verity usage untrack`.
// Outside a git repository the ledger IS the tree file: nothing to seed.
function seedLedger(cwd) {
  const file = ledgerPath(cwd);
  if (resolveGitDir(cwd) === null) {
    return { path: file, git: false, seeded: 0, tracked: false };
  }
  let seeded = 0;
  if (!fs.existsSync(file)) {
    seeded = recoverLedger(cwd).rows_added;
  }
  return { path: file, git: true, seeded, tracked: isLedgerTracked(cwd) === true };
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// `est_usd` is the VERIFIED spend — the sum of rows that reported a cost.
// Unknown-cost rows are never summed as $0 (ADR-0008); they are counted
// separately so no consumer can read "unknown" as "zero":
//   unknown_cost_runs  DISTINCT run_ids with at least one unknown-cost row
//   unknown_cost_rows  those rows themselves (one per role invocation)
// Both are 0 on any ledger whose provider reports real costs, which is what
// keeps the claude path's numbers exactly what they have always been.
// Stage 21 adds unknown_cost_gated_runs: how many of the unknown-cost runs
// ended PARKED at the unknown-cost gate (every unknown-cost row of the run
// carries gate 'unknown-cost' — fail closed: one unstamped row and the run
// does not count). Those runs already asked a human for the ADR-0008 decision;
// the worker's startup breaker uses the count to tell an approvable pause from
// spend that slipped through ungated.
function rollup(rows) {
  const totals = {
    runs: 0,
    tokens_in: 0,
    tokens_out: 0,
    est_usd: 0,
    unknown_cost_runs: 0,
    unknown_cost_rows: 0,
    unknown_cost_gated_runs: 0,
    tool_calls: 0,
    outcomes: {},
  };
  // A run may span several per-invocation rows (shared run_id) since stage 3,
  // so `runs` counts DISTINCT run_ids — identical to row-count on legacy files.
  const runIds = new Set();
  const unknownRunIds = new Set();
  const ungatedUnknownRunIds = new Set();
  for (const r of rows) {
    runIds.add(r.run_id);
    totals.tokens_in += r.tokens_in;
    totals.tokens_out += r.tokens_out;
    if (r.est_usd === null) {
      unknownRunIds.add(r.run_id);
      totals.unknown_cost_rows += 1;
      if (r.gate !== UNKNOWN_COST_GATE) {
        ungatedUnknownRunIds.add(r.run_id);
      }
    } else {
      totals.est_usd += r.est_usd;
    }
    totals.tool_calls += r.tool_calls;
    totals.outcomes[r.outcome] = (totals.outcomes[r.outcome] || 0) + 1;
  }
  totals.runs = runIds.size;
  totals.unknown_cost_runs = unknownRunIds.size;
  totals.unknown_cost_gated_runs = [...unknownRunIds].filter(
    (id) => !ungatedUnknownRunIds.has(id),
  ).length;
  totals.est_usd = Number(totals.est_usd.toFixed(4)); // keep float noise out of output
  return totals;
}

// Per-role attribution over the same rows: role → { rows, tokens_in,
// tokens_out, est_usd, unknown_cost_rows, tool_calls }, keys sorted for stable
// output. `est_usd` is verified spend here too, with the unknown-cost rows
// counted beside it — a group is rows, not runs, so rows is the honest unit
// here. Legacy rows have no role column; they group under their joined roles
// string (e.g. 'plan+build' — pre-stage-3 runs cannot be split honestly), or
// '(unattributed)' when even that is empty.
function rollupByRole(rows) {
  const groups = {};
  for (const r of rows) {
    const key = r.role || r.roles.join('+') || '(unattributed)';
    if (!groups[key]) {
      groups[key] = {
        rows: 0,
        tokens_in: 0,
        tokens_out: 0,
        est_usd: 0,
        unknown_cost_rows: 0,
        tool_calls: 0,
      };
    }
    const g = groups[key];
    g.rows += 1;
    g.tokens_in += r.tokens_in;
    g.tokens_out += r.tokens_out;
    if (r.est_usd === null) {
      g.unknown_cost_rows += 1;
    } else {
      g.est_usd += r.est_usd;
    }
    g.tool_calls += r.tool_calls;
  }
  const sorted = {};
  for (const key of Object.keys(groups).sort()) {
    groups[key].est_usd = Number(groups[key].est_usd.toFixed(4));
    sorted[key] = groups[key];
  }
  return sorted;
}

// Totals over the last `days` UTC calendar days including today (UTC).
function summarizeUsage(cwd, opts = {}) {
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, got ${JSON.stringify(opts.days)}`);
  }
  const now = opts.now || new Date();
  const since = startOfUtcDay(now) - (days - 1) * 86_400_000;
  const ledger = readUsage(cwd, opts);
  const windowed = ledger.rows.filter((r) => r.ts >= since);
  const totals = rollup(windowed);
  const summary = {
    days,
    since: new Date(since).toISOString(),
    timezone: 'UTC',
    ...totals,
    skipped_rows: ledger.skipped,
    path: ledger.path,
  };
  if (opts.byRole) {
    summary.by_role = rollupByRole(windowed);
  }
  return summary;
}

// "Today" (UTC) totals — what the worker's §4.1 daily-limit startup check sums.
function todayTotals(cwd, opts = {}) {
  return summarizeUsage(cwd, { ...opts, days: 1 });
}

// §4.1 startup check: daily limits not already exceeded. Returns
// { ok: true, totals } or { ok: false, slug, message, totals } for the worker
// to turn into `verity-worker: 30 <slug>: <message>`. T12's remaining startup
// checks can reuse this as-is.
//
// Stage 18 (ADR-0008): the USD breaker may only speak for spend it can SEE.
// When a ceiling is configured AND today's window contains unknown-cost runs,
// the total is knowingly incomplete, so "under the limit" is not a statement
// this function is entitled to make. `limits.unknown_cost_behavior` — the knob
// ADR-0008 already defines — decides what that costs:
//   gate (default) / fail   → not ok, slug `unknown-cost-budget`, message
//                             naming how many runs were unverifiable
//   allow_with_token_limit  → ok, because the operator explicitly accepted the
//                             token ceilings as the bound; `note` records that
//                             the USD breaker is inert BY CONSENT rather than
//                             letting the caller mistake est_usd for a
//                             verified total
// Genuine overspend is still genuine overspend: the known-spend trip is
// checked FIRST, so a real breach reports `daily-limit`, not doubt.
//
// Stage 21 (#58): under 'gate', a refusal whose every unverifiable run ended
// PARKED at the unknown-cost gate is additionally marked `approvable: true` —
// the gate already asked a human for exactly the decision ADR-0008 prices the
// knob at ("one human approval per run"), so the WORKER may honour a pending
// single-use `verity:approved` instead of wedging on its own question. This
// function still answers not-ok (it cannot see GitHub and never should); the
// caller resolves the approval. Default-closed: any unknown-cost run that did
// NOT pass through the gate (pre-stage-21 rows included — their gate cell is
// empty) leaves `approvable` false, and 'fail' has no approval mechanism at
// all, so nothing changes for stage 18's refusals.
function checkDailyLimits(cwd, limits, opts = {}) {
  const totals = todayTotals(cwd, opts);
  if (typeof limits.max_usd_per_day === 'number' && totals.est_usd >= limits.max_usd_per_day) {
    return {
      ok: false,
      slug: 'daily-limit',
      message: `daily budget reached: est $${totals.est_usd.toFixed(2)} spent today (UTC) >= max_usd_per_day ${limits.max_usd_per_day}`,
      totals,
    };
  }
  // Below the verified-spend trip: the ceiling was not met by what we can see.
  // Whether that means "under budget" depends on whether we saw everything.
  const unknownRuns = totals.unknown_cost_runs;
  const unverifiable = typeof limits.max_usd_per_day === 'number' && unknownRuns > 0;
  const behavior = limits.unknown_cost_behavior || 'gate';
  const runWord = unknownRuns === 1 ? 'run' : 'runs';
  const verified = `$${totals.est_usd.toFixed(2)}`;
  if (unverifiable && behavior !== 'allow_with_token_limit') {
    const approvable = behavior !== 'fail' && totals.unknown_cost_gated_runs === unknownRuns;
    return {
      ok: false,
      slug: 'unknown-cost-budget',
      approvable,
      message: `daily budget cannot be verified: ${unknownRuns} ${runWord} today (UTC) reported unknown cost (est_usd null), so ${verified} is a floor, not a total — max_usd_per_day ${limits.max_usd_per_day} is unenforceable under unknown_cost_behavior '${behavior}' (ADR-0008)${
        approvable
          ? ' — every unverifiable run ended parked at the unknown-cost gate; a single-use `verity:approved` on the gated item lets exactly one run proceed'
          : ''
      }`,
      totals,
    };
  }
  if (Number.isInteger(limits.max_runs_per_day) && totals.runs >= limits.max_runs_per_day) {
    return {
      ok: false,
      slug: 'daily-limit',
      message: `daily run cap reached: ${totals.runs} runs today (UTC) >= max_runs_per_day ${limits.max_runs_per_day}`,
      totals,
    };
  }
  if (unverifiable) {
    // Reached only under allow_with_token_limit: ok, but say WHY it is ok.
    return {
      ok: true,
      totals,
      note: `USD breaker inert by consent: ${unknownRuns} ${runWord} today (UTC) reported unknown cost, so ${verified} is verified spend only and max_usd_per_day ${limits.max_usd_per_day} was not checked — unknown_cost_behavior 'allow_with_token_limit' makes the token ceilings the bound (ADR-0008)`,
    };
  }
  return { ok: true, totals };
}

// --- CLI: `verity usage [--days 7] [--by-role] [--json]` (§3.4) ---------------
// (`--json` reports `path`, the resolved live ledger.) Stage 108 (ADR-0036)
// adds two maintenance verbs:
//   `verity usage untrack [--json]`  untrackLedger — stop tracking the stale
//                                    in-tree file (operator-only)
//   `verity usage recover [--json]`  recoverLedger — union orphaned rows into
//                                    the sidecar

// --json: exactly the result object (no `raw`), like `usage --json`. A git
// failure throws (exit 1); an F2 refusal is returned with `ok: false`, which
// the CLI maps onto exit 1 too.
function dispatchUntrack(cwd, json) {
  const res = untrackLedger(cwd);
  if (res.error !== null) {
    throw new Error(`usage untrack: ${res.error}`);
  }
  return json ? res : { ...res, raw: res.reason };
}

function dispatchRecover(cwd, json) {
  const res = recoverLedger(cwd);
  if (json) {
    return res;
  }
  return {
    ...res,
    raw: `path=${res.path} commits_scanned=${res.commits_scanned} tree_rows=${res.tree_rows} rows_before=${res.rows_before} rows_added=${res.rows_added} rows_after=${res.rows_after}`,
  };
}

function dispatch(args, flags) {
  const usageLine =
    'verity usage [--days 7] [--by-role] [--json] | verity usage untrack [--json] | verity usage recover [--json]';
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if ((verb === 'untrack' || verb === 'recover') && args.length === 1) {
    return verb === 'untrack' ? dispatchUntrack(cwd, flags.json) : dispatchRecover(cwd, flags.json);
  }
  if (args.length > 0) {
    throw new Error(
      `usage takes no positional arguments other than the untrack|recover verbs — ${usageLine}`,
    );
  }
  let days = 7;
  if (flags.days !== undefined) {
    days = Number(flags.days);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(`--days must be a positive integer, got '${flags.days}'`);
    }
  }
  if (flags['by-role'] !== undefined && flags['by-role'] !== true) {
    throw new Error(`--by-role takes no value — ${usageLine}`);
  }
  // Warnings go to stderr so `usage --json` stdout stays exactly one object.
  const summary = summarizeUsage(cwd, {
    days,
    byRole: flags['by-role'] === true,
    warn: (msg) => process.stderr.write(`verity usage: warn: ${msg}\n`),
  });
  if (flags.json) {
    return summary; // --json: exactly the totals object, no presentation extras
  }
  // est_usd is VERIFIED spend. When some of the window's runs reported no cost
  // (ADR-0008), the one-liner must not read as a confident total: the figure
  // gets a `+unknown` suffix and the count of unverifiable runs rides beside
  // it. With nothing unknown — every claude ledger — the line is unchanged.
  const unknown =
    summary.unknown_cost_runs > 0 ? `+unknown unknown_cost_runs=${summary.unknown_cost_runs}` : '';
  return {
    ...summary,
    raw: `runs=${summary.runs} tokens_in=${summary.tokens_in} tokens_out=${summary.tokens_out} est_usd=${summary.est_usd.toFixed(2)}${unknown} days=${summary.days}`,
  };
}

module.exports = {
  COLUMNS,
  COMMIT_AUTHOR_EMAIL,
  COMMIT_AUTHOR_NAME,
  CSV_REL_PATH,
  HEADER,
  LEDGER_GIT_PATH,
  LEDGER_IGNORE_COMMENT,
  LEDGER_IGNORE_LINE,
  LEGACY_COLUMNS,
  LEGACY_HEADER,
  LedgerPathError,
  MIGRATION_MESSAGE,
  STAGE3_COLUMNS,
  STAGE3_HEADER,
  STAGE21_COLUMNS,
  STAGE21_HEADER,
  UNKNOWN_COST_GATE,
  appendUsage,
  botIdentityGitArgs,
  checkDailyLimits,
  dispatch,
  ensureIgnoreLine,
  entryFromInvocation,
  entryFromSummary,
  formatRow,
  hasIgnoreLine,
  isLedgerTracked,
  ledgerDataLines,
  ledgerPath,
  parseRowLine,
  readUsage,
  record,
  recoverLedger,
  resolveGitDir,
  rollup,
  rollupByRole,
  seedLedger,
  splitCsvLine,
  startOfUtcDay,
  summarizeUsage,
  todayTotals,
  untrackLedger,
  usagePath,
};
