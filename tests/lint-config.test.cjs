// Stage 106 — pins the two config facts that keep `npm run lint` as strict on
// Biome 2.x as it was on 1.9.4. Both have a known way to regress silently:
//
//   - `biome migrate --write` rewrites the 1.x `"rules": { "recommended": true }`
//     to `"rules": { "preset": "none" }`, which turns off every lint rule while
//     CI stays green. The preset must stay "recommended".
//   - Under 2.x, recommended rules report as warnings and `biome ci` exits 0 on
//     warnings. Without `--error-on-warnings` the gate would pass every hit.
//
// Synchronous and static: reads the two JSON files, never runs Biome (the lint
// job itself proves the tree is clean).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

test('biome.json: linter keeps the recommended preset (never "none", never absent)', () => {
  const rules = readJson('biome.json').linter?.rules;
  assert(rules && typeof rules === 'object', 'biome.json has linter.rules');
  assertEqual(rules.preset, 'recommended', 'linter.rules.preset');
  assert(rules.recommended !== false, 'the legacy recommended flag is not switched off');
});

// Rules 1.9.4's recommended set enforced that the 2.x gate would not, re-enabled
// at "error" in their 2.x groups. Some left the 2.x preset. Others stayed in it
// at `info` severity, which even `--error-on-warnings` does not fail on.
// The fourteen the stage-106 spec names:
const PARITY_RULES = {
  complexity: ['noArguments', 'noCommaOperator', 'noForEach', 'useLiteralKeys'],
  style: [
    'noParameterAssign',
    'noUselessElse',
    'useTemplate',
    'useConst',
    'useNumberNamespace',
    'useExponentiationOperator',
    'useSingleVarDeclarator',
    'useDefaultParameterLast',
    'useNodejsImportProtocol',
  ],
  suspicious: ['noVar'],
};
// The further plain-JS rules found during the build (all zero-hit on the tree):
const PARITY_RULES_EXTRA = {
  complexity: [
    'noExcessiveNestedTestSuites',
    'noExtraBooleanCast',
    'noFlatMapIdentity',
    'noUselessCatch',
    'noUselessConstructor',
    'noUselessContinue',
    'noUselessEmptyExport',
    'noUselessLabel',
    'noUselessLoneBlockStatements',
    'noUselessRename',
    'noUselessSwitchCase',
    'noUselessTernary',
    'noUselessThisAlias',
    'useFlatMap',
    'useWhile',
  ],
  style: ['noUnusedTemplateLiteral'],
  suspicious: ['noDuplicateTestHooks', 'noExportsInTest', 'noFocusedTests'],
};
// The only rule opt-outs, each justified in CONTRIBUTING.md.
const OPT_OUTS = ['suspicious/noTemplateCurlyInString', 'performance/noDelete'];

function assertRulesAtError(rules, table) {
  for (const [group, names] of Object.entries(table)) {
    for (const name of names) {
      assertEqual(rules[group]?.[name], 'error', `linter.rules.${group}.${name}`);
    }
  }
}

test('biome.json: the fourteen 1.9.4 rules the 2.x preset stopped gating are at "error"', () => {
  assertRulesAtError(readJson('biome.json').linter.rules, PARITY_RULES);
});

test('biome.json: the further 1.9.4 parity rules are at "error"', () => {
  assertRulesAtError(readJson('biome.json').linter.rules, PARITY_RULES_EXTRA);
});

test('biome.json: the only rules turned off are the two documented opt-outs', () => {
  const rules = readJson('biome.json').linter.rules;
  const off = [];
  for (const [group, entries] of Object.entries(rules)) {
    if (entries && typeof entries === 'object') {
      for (const [name, level] of Object.entries(entries)) {
        const severity = level && typeof level === 'object' ? level.level : level;
        if (severity === 'off') {
          off.push(`${group}/${name}`);
        }
      }
    }
  }
  assertEqual(off.sort().join(','), [...OPT_OUTS].sort().join(','), 'rules set to "off"');
});

test('biome.json: files.includes negations use the folder form, not a /** suffix', () => {
  const includes = readJson('biome.json').files?.includes;
  assert(Array.isArray(includes) && includes.length > 0, 'biome.json has files.includes');
  for (const glob of includes) {
    assert(
      !(glob.startsWith('!') && glob.endsWith('/**')),
      `negation ${glob} should drop the trailing /** (2.x useBiomeIgnoreFolder)`,
    );
  }
});

test('package.json: the lint script fails on warnings', () => {
  const lint = readJson('package.json').scripts?.lint;
  assert(typeof lint === 'string', 'package.json has scripts.lint');
  assert(/^biome ci\b/.test(lint), `scripts.lint runs biome ci (got ${JSON.stringify(lint)})`);
  assert(lint.includes('--error-on-warnings'), 'scripts.lint passes --error-on-warnings');
});

test('package.json: @biomejs/biome is pinned to an exact 2.x version', () => {
  const pin = readJson('package.json').devDependencies?.['@biomejs/biome'];
  assert(
    /^2\.\d+\.\d+$/.test(pin || ''),
    `@biomejs/biome is an exact 2.x.y pin (got ${JSON.stringify(pin)})`,
  );
});
