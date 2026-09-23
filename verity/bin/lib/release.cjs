// Release/Deploy Operator — release half (framework-spec.md §6, Role 7 / Shipyard).
// version DERIVED from the latest tag (so the binary can't lie about its version) +
// changelog auto-generated from Conventional Commits. Tags/commits are injectable
// (opts.tags / opts.commits) so the logic is unit-testable without git.
// Stage 97 (ADR-0034): once the dev/prod split is active the latest tag is NOT
// the dev side's release truth (authoritative tags are prod-only, ADR-0019) —
// the newest `released` promotion record is, and the commit range starts at
// that record's development.commit. Non-split repositories are byte-identical.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ledger = require('./ledger.cjs');
const promotionConfig = require('./promotion-config.cjs');
const { sanitize } = require('./changelog-sanitize.cjs');

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function gitTags(cwd) {
  return git(cwd, ['tag']).split('\n').filter(Boolean);
}

// A git predicate that does NOT swallow: true iff the command exits 0. Used
// for the checks whose failure must refuse (stage 97 review R2) — `git()`
// above returns '' on failure, which is exactly the fail-open to avoid.
function gitOk(cwd, args) {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function commitsSince(cwd, tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  return git(cwd, ['log', range, '--pretty=%s']).split('\n').filter(Boolean);
}

function parseVersion(tag) {
  return tag
    .replace(/^v/, '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
}

function nextVersion(currentTag, bump) {
  const [maj, min, pat] = currentTag ? parseVersion(currentTag) : [0, 0, 0];
  if (bump === 'major') {
    return `${(maj || 0) + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${maj || 0}.${(min || 0) + 1}.0`;
  }
  return `${maj || 0}.${min || 0}.${(pat || 0) + 1}`;
}

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;

function changelogFrom(commits, version) {
  const groups = { feat: [], fix: [], chore: [], other: [] };
  for (const c of commits) {
    const m = c.match(CONVENTIONAL);
    if (m && groups[m[1]]) {
      groups[m[1]].push(m[4]);
    } else {
      groups.other.push(c);
    }
  }
  const lines = [`## ${version}`, ''];
  const section = (title, arr) => {
    if (arr.length > 0) {
      lines.push(`### ${title}`);
      for (const s of arr) {
        lines.push(`- ${s}`);
      }
      lines.push('');
    }
  };
  section('Features', groups.feat);
  section('Fixes', groups.fix);
  section('Chores', groups.chore);
  section('Other', groups.other);
  return lines.join('\n').trim();
}

// Prepend a changelog section, returning a rollback that restores the file to its
// exact prior state (content, or non-existence) — so a later failure can undo it.
function prependChangelog(cwd, section) {
  const p = path.join(cwd, 'CHANGELOG.md');
  const existedBefore = fs.existsSync(p);
  const before = existedBefore ? fs.readFileSync(p, 'utf8') : null;
  const header = '# Changelog';
  const existing = before ? before.replace(header, '').trim() : '';
  const body = `${header}\n\n${section}\n\n${existing}`.trim();
  fs.writeFileSync(p, `${body}\n`);
  return () => {
    if (existedBefore) {
      fs.writeFileSync(p, before);
    } else {
      fs.rmSync(p, { force: true });
    }
  };
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

// A derivation refusal (stage 97, ADR-0034): the tag guard's exit code (20)
// and wire shape (`{ error }` on stderr) with a machine-readable slug leading
// the message. Thrown from derive() itself so `prepare`, `cut --dry-run`, and
// `cut` all refuse — none of the three may compute a number the ledger
// contradicts.
class ReleaseRefusal extends Error {
  constructor(slug, detail) {
    super(`${slug}: ${detail}`);
    this.slug = slug;
    this.exitCode = 20;
  }
}

// The one derivation both `cut` and `prepare` share (extracted in stage 42 so
// the two verbs can never disagree): version from the previous release,
// changelog from the Conventional Commits since it. Pure computation, no side
// effects. Where "previous" comes from is the split question (ADR-0034):
//   - split_active false (or no promotion.json): the latest local tag, and
//     the commits since it — exactly the pre-stage-97 path;
//   - split_active true: the highest `released` promotion record (never a dev
//     tag — the hand-made v1.2.0 mirror is inert residue) and the commits since
//     its development.commit; no released record ⇒ refuse (fail closed, never
//     a silent fall-back to tags, which was the defect).
// Both modes then refuse a computed version that has already been released
// (a `released` record naming it / an existing local v<version> tag).
// The split-active release truth, validated (stage 97; review R2). Returns
// null when the split is off. When on: the highest released record, or a
// refusal — no released record (`no-released-promotion`); a
// development.commit this clone does not have (`dev-commit-unreachable`:
// `git log <sha>..HEAD` through the swallowing helper would silently yield
// ZERO commits and an empty changelog); or one that is not an ancestor of
// HEAD (`dev-commit-not-ancestor`: a rebased dev history would re-list
// shipped work). Shared by derive() and current() so no verb can answer
// from a truth another verb would refuse.
function splitTruth(cwd) {
  if (!promotionConfig.read(cwd).split_active) {
    return null;
  }
  // Lazy: promotion.cjs is the heavy prod-side module; the non-split path
  // never loads it.
  const promotion = require('./promotion.cjs');
  const last = promotion.latestReleased(cwd);
  if (last === null) {
    throw new ReleaseRefusal(
      'no-released-promotion',
      `${promotionConfig.PROMOTION_CONFIG_PATH} has split_active: true but no promotion record under .verity/promotions/ has status: released — with the split active the dev side derives its version and commit range from the last released promotion (ADR-0034), never from a dev tag. Run the promotion flow (\`verity promotion propose\` → prod merge → \`verity promotion finalize\`) so a released record exists; do not add a mirror tag.`,
    );
  }
  if (!gitOk(cwd, ['cat-file', '-e', `${last.devCommit}^{commit}`])) {
    throw new ReleaseRefusal(
      'dev-commit-unreachable',
      `${last.promotionId} (released ${last.version}) records development.commit ${last.devCommit}, which this clone does not have — refusing to derive a commit range from a commit it cannot see (fetch the full dev history, or inspect the record)`,
    );
  }
  if (!gitOk(cwd, ['merge-base', '--is-ancestor', last.devCommit, 'HEAD'])) {
    throw new ReleaseRefusal(
      'dev-commit-not-ancestor',
      `${last.promotionId} (released ${last.version}) records development.commit ${last.devCommit}, which is not an ancestor of HEAD — the range since the last release is undefined on this history (rebased or wrong branch); refusing rather than re-listing shipped work`,
    );
  }
  return { promotion, last };
}

function derive(cwd, opts = {}) {
  const truth = splitTruth(cwd);
  const split = truth !== null;
  let previous;
  let commits;
  let alreadyReleased;
  if (split) {
    const { promotion, last } = truth;
    previous = `v${last.version}`;
    commits = opts.commits || commitsSince(cwd, last.devCommit);
    const released = promotion.releasedRecords(cwd);
    alreadyReleased = (v) => released.find((r) => r.version === v) || null;
  } else {
    const tags = opts.tags || gitTags(cwd);
    previous = ledger.latestTag(tags);
    commits = opts.commits || commitsSince(cwd, previous);
    // The local tags are the non-split release truth, so the guard reads the
    // repository's own tags even when the derivation ran on injected ones.
    const local = new Set(opts.tags ? [...tags, ...gitTags(cwd)] : tags);
    alreadyReleased = (v) => (local.has(`v${v}`) ? { tag: `v${v}` } : null);
  }
  const version = nextVersion(previous, opts.bump || 'patch');
  const tag = `v${version}`;
  const hit = alreadyReleased(version);
  if (hit !== null) {
    throw new ReleaseRefusal(
      'version-already-released',
      split
        ? `computed ${tag} is already released (${hit.promotionId}, prod tag ${hit.tag}) — refusing to derive a version that has shipped; the released ledger and the derivation disagree, inspect .verity/promotions/`
        : `computed ${tag} already exists as a local tag — refusing to derive a version that has shipped`,
    );
  }
  const changelog = changelogFrom(commits, version);
  return { version, tag, previous, changelog, commitCount: commits.length };
}

// A release has three side effects (tag, changelog edit, push) that must be
// all-or-nothing: a half-done release leaves either a dirty CHANGELOG.md with no
// tag, or a local tag that never pushed. We order them cheap-and-reversible-first
// (tag → changelog → push) and roll back the earlier steps if a later one throws.
// The git runner is injectable (opts.run) so partial failure is unit-testable.
function cut(cwd, opts = {}) {
  const { version, tag, previous, changelog, commitCount } = derive(cwd, opts);
  const result = { version, tag, previous, changelog, commitCount };
  if (opts.dryRun) {
    return { ...result, applied: false };
  }

  // The authoritative-tag guard (stage 42, ADR-0022 §3): once the dev/prod
  // split is active, vX.Y.Z tags are born in prod via the promotion flow —
  // habit-driven `release cut` in dev must refuse BEFORE any side effect.
  // Reading the config throws on a malformed file (exit 20, never silently
  // off); an absent file leaves cut byte-identical to today. --dry-run
  // returned above: the computation is harmless and stays available (stage
  // 97: derive() itself has already refused when the split is active with no
  // released record — that refusal is NOT skipped by --dry-run).
  if (promotionConfig.read(cwd).split_active) {
    const err = new Error(
      `release cut refused: ${promotionConfig.PROMOTION_CONFIG_PATH} has split_active: true — authoritative ${tag} tags are minted in the production repo by the promotion flow, not in dev. Use \`verity release prepare\` to compute the version and sanitized changelog section here (\`release cut --dry-run\` also still computes without tagging).`,
    );
    err.exitCode = 20;
    throw err;
  }

  const exec = opts.run || run;
  exec('git', ['-C', cwd, 'tag', tag]); // step 1 — if this throws, nothing changed yet

  let restoreChangelog;
  try {
    restoreChangelog = prependChangelog(cwd, changelog); // step 2
  } catch (err) {
    exec('git', ['-C', cwd, 'tag', '-d', tag]); // roll back step 1
    throw err;
  }

  if (opts.push !== false) {
    try {
      exec('git', ['-C', cwd, 'push', 'origin', tag]); // step 3
    } catch (err) {
      restoreChangelog(); // roll back step 2
      exec('git', ['-C', cwd, 'tag', '-d', tag]); // roll back step 1
      throw new Error(
        `release push failed — rolled back tag ${tag} and CHANGELOG.md, working tree is clean. Original error: ${err.message}`,
      );
    }
  }
  return { ...result, applied: true };
}

// `release prepare` (stage 42, ADR-0022 §2) — the dev-side release computation
// after the split: the SAME derivation as `cut` (shared `derive`, so the two
// can never disagree) with the changelog section already sanitized (`#NN` →
// `dev#NN`). It NEVER tags, commits, or pushes in any mode. Default is
// report-only (nothing touched); `--apply` prepends the sanitized section to
// CHANGELOG.md as a working-tree edit only.
function prepare(cwd, opts = {}) {
  const d = derive(cwd, opts);
  const changelog = sanitize(d.changelog);
  const result = {
    version: d.version,
    tag_candidate: d.tag,
    previous: d.previous,
    changelog,
    commitCount: d.commitCount,
    applied: false,
  };
  if (!opts.apply) {
    return result;
  }
  prependChangelog(cwd, changelog);
  return { ...result, applied: true };
}

// `release current` — the current release truth (stage 97 review R1: the
// ship role runs this first, so it must agree with prepare.previous and
// state.release). Split active ⇒ the released record (same validated truth
// as derive(), same refusals); otherwise today's tag result, byte-identical
// apart from the additive `source`.
function current(cwd) {
  const truth = splitTruth(cwd);
  if (truth !== null) {
    const { last } = truth;
    const tag = `v${last.version}`;
    return {
      latest: tag,
      version: last.version,
      raw: tag,
      tag,
      source: 'promotion-record',
      promotion_id: last.promotionId,
    };
  }
  const latest = ledger.latestTag(gitTags(cwd));
  return {
    latest,
    version: latest ? latest.replace(/^v/, '') : null,
    raw: latest || '',
    source: 'tag',
  };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === 'current') {
    return current(cwd);
  }
  if (verb === 'changelog') {
    return cut(cwd, { bump: flags.bump, dryRun: true });
  }
  if (verb === 'cut') {
    return cut(cwd, {
      bump: flags.bump,
      dryRun: Boolean(flags['dry-run']),
      push: !flags['no-push'],
    });
  }
  if (verb === 'prepare') {
    return prepare(cwd, { bump: flags.bump, apply: Boolean(flags.apply) });
  }
  throw new Error(`unknown release verb: ${verb || '(none)'} — use cut|prepare|changelog|current`);
}

module.exports = {
  ReleaseRefusal,
  nextVersion,
  changelogFrom,
  derive,
  cut,
  prepare,
  current,
  dispatch,
};
