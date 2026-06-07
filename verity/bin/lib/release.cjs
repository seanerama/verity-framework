// Release/Deploy Operator — release half (framework-spec.md §6, Role 7 / Shipyard).
// version DERIVED from the latest tag (so the binary can't lie about its version) +
// changelog auto-generated from Conventional Commits. Tags/commits are injectable
// (opts.tags / opts.commits) so the logic is unit-testable without git.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ledger = require('./ledger.cjs');

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

function prependChangelog(cwd, section) {
  const p = path.join(cwd, 'CHANGELOG.md');
  const header = '# Changelog';
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(header, '').trim() : '';
  fs.writeFileSync(p, `${header}\n\n${section}\n\n${existing}`.trim() + '\n');
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function cut(cwd, opts = {}) {
  const tags = opts.tags || gitTags(cwd);
  const previous = ledger.latestTag(tags);
  const version = nextVersion(previous, opts.bump || 'patch');
  const tag = `v${version}`;
  const commits = opts.commits || commitsSince(cwd, previous);
  const changelog = changelogFrom(commits, version);
  if (!opts.dryRun) {
    prependChangelog(cwd, changelog);
    run('git', ['-C', cwd, 'tag', tag]);
    if (opts.push !== false) {
      run('git', ['-C', cwd, 'push', 'origin', tag]);
    }
  }
  return { version, tag, previous, changelog, commitCount: commits.length, applied: !opts.dryRun };
}

function current(cwd) {
  const latest = ledger.latestTag(gitTags(cwd));
  return { latest, version: latest ? latest.replace(/^v/, '') : null, raw: latest || '' };
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
  throw new Error(`unknown release verb: ${verb || '(none)'} — use cut|changelog|current`);
}

module.exports = { nextVersion, changelogFrom, cut, current, dispatch };
