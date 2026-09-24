// Stage 104 — docs-literal pins. Two literals in the user docs drifted once
// (role counts, an undocumented CLI surface); these pins make the next drift
// fail the suite instead of silently aging the docs. Both read only public
// paths (docs/commands.md, README.md, QUICKSTART.md, commands/verity/, the
// shipped CLI), so they hold in the projected tree too.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'verity', 'bin', 'verity.cjs');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// The `## CLI verbs` section of docs/commands.md: from its heading to the next
// level-2 heading (or end of file).
function cliVerbsSection() {
  const doc = read('docs/commands.md');
  const start = doc.search(/^## CLI verbs[ \t]*$/m);
  assert(start !== -1, 'docs/commands.md has a `## CLI verbs` section');
  const rest = doc.slice(start + '## CLI verbs'.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

// Every literal "N" captured by `re` in `rel` (the caller checks each one);
// fails if the phrasing is absent, so a reworded count cannot escape the pin.
function literalCount(rel, re) {
  const text = read(rel);
  const hits = [...text.matchAll(re)].map((m) => Number(m[1]));
  assert(hits.length > 0, `${rel} states the role count (${re})`);
  return hits;
}

// `verity help`'s verb list, spawned once (sync) and shared by the tests below.
let helpVerbs = null;
function helpCommands() {
  if (helpVerbs === null) {
    const help = JSON.parse(execFileSync('node', [CLI, 'help'], { encoding: 'utf8' }));
    assert(Array.isArray(help.commands) && help.commands.length > 0, 'help lists its commands');
    helpVerbs = help.commands;
  }
  return helpVerbs;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The verbs with no INDEX LINE in `section`. Anchored to the index-line form —
// a line starting "- `verity <verb>`" — because verbs such as `gates`, `next`,
// `stage` and `usage` also appear as backticked tokens inside other verbs'
// lines (operator's `gates`, `verity state next`); a looser match would let a
// deleted line pass.
function missingIndexLines(section, verbs) {
  return verbs.filter((verb) => !new RegExp(`^- \`verity ${escapeRe(verb)}\``, 'm').test(section));
}

// The section with the index line for `verb` removed (in memory only).
function withoutIndexLine(section, verb) {
  const lineRe = new RegExp(`^- \`verity ${escapeRe(verb)}\`.*(?:\n|$)`, 'm');
  assert(lineRe.test(section), `the section has an index line for ${verb}`);
  return section.replace(lineRe, '');
}

test('docs literal: every `verity help` verb has a line in the ## CLI verbs index', () => {
  assertEqual(
    missingIndexLines(cliVerbsSection(), helpCommands()).join(', '),
    '',
    'verbs missing from the docs/commands.md `## CLI verbs` index',
  );
});

test('docs literal: the verb pin reports a deleted index line even when the verb appears elsewhere', () => {
  const section = cliVerbsSection();
  const verbs = helpCommands();
  // The two ambiguous kinds: `gates` is also an operator sub-verb token, and
  // `next` also appears inside `verity state next`.
  for (const verb of ['gates', 'next']) {
    assertEqual(
      missingIndexLines(withoutIndexLine(section, verb), verbs).join(', '),
      verb,
      `deleting the ${verb} index line is detected`,
    );
  }
  // And for every verb: deleting exactly its line reports exactly that verb.
  for (const verb of verbs) {
    assertEqual(
      missingIndexLines(withoutIndexLine(section, verb), verbs).join(', '),
      verb,
      `deleting the ${verb} index line is detected`,
    );
  }
});

test('docs literal: stated role counts equal the packaged commands/verity/*.md count', () => {
  const packaged = fs
    .readdirSync(path.join(ROOT, 'commands', 'verity'))
    .filter((f) => f.endsWith('.md')).length;
  assert(packaged > 0, 'commands/verity/ holds role commands');
  const stated = [
    ['docs/commands.md', /There are \*\*(\d+) role commands\*\*/g],
    ['README.md', /all (\d+) `\/verity:\*` roles/g],
    ['QUICKSTART.md', /all (\d+) `\/verity:\*` roles/g],
  ];
  for (const [rel, re] of stated) {
    for (const n of literalCount(rel, re)) {
      assertEqual(n, packaged, `${rel} role-count literal vs commands/verity/*.md`);
    }
  }
});
