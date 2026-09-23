// Stage 95 (ADR-0032) — the `revisit` role: a READ-ONLY re-entry audit of any
// project, Verity or not, whose only write is a dated report under
// `docs/revisit/` and whose proposals are handed to `/verity:plan`.
//
// What this file pins:
//   1. it RENDERS through the ADR-0002 pipeline for every host and carries the
//      shared delegation preamble like every workflow role;
//   2. its `.permissions.json` loads against the FROZEN policy loader
//      (contracts/role-capability-policy.md v1): write_repository only for the
//      report, no git/GitHub write, no network, no deploy, workspace-write;
//   3. its `.tools.json` scopes every write to `docs/revisit/` and allowlists
//      none of the mutating verbs that belong to other roles (stage/contract/adr
//      beyond `list`, identity lock, scaffold, map) nor any `gh` mutation;
//   4. the prompt names both modes, the report path, the three prompt rules,
//      and the ownership clause (plan/architect/ship/vision);
//   5. every adapter installs it and the Codex skill count is 16;
//   6. `agent-exec.resolveRole` resolves file + tools + permissions;
//   7. kill-switch is STRUCTURAL: the worker never dispatches it — autonomy.cjs
//      defaults (`auto_advance`, gates, `KNOWN_AGENT_ROLES`) do not name it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentExec = require('../verity/bin/lib/agent-exec.cjs');
const autonomy = require('../verity/bin/lib/autonomy.cjs');
const install = require('../verity/bin/lib/install.cjs');
const policy = require('../verity/bin/lib/agents/policy.cjs');

const PKG_ROOT = path.join(__dirname, '..');
const ROLES_DIR = path.join(PKG_ROOT, 'commands', 'verity');
const ROLE = 'revisit';
const ROLE_FILE = path.join(ROLES_DIR, `${ROLE}.md`);
const TOOLS_FILE = path.join(ROLES_DIR, `${ROLE}.tools.json`);
const POLICY_FILE = path.join(ROLES_DIR, `${ROLE}.permissions.json`);

function sandbox(tag) {
  return {
    target: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-`)),
    home: fs.mkdtempSync(path.join(os.tmpdir(), `verity-${tag}-home-`)),
  };
}

// --- 1. it renders, with the delegation preamble --------------------------------

test('revisit role: the packaged file, its tools allowlist, and its policy travel together', () => {
  assert(fs.existsSync(ROLE_FILE), `${ROLE}.md ships`);
  assert(fs.existsSync(TOOLS_FILE), 'tools allowlist ships beside it');
  assert(fs.existsSync(POLICY_FILE), 'policy ships beside it');
  const source = fs.readFileSync(ROLE_FILE, 'utf8');
  assert(/^name: verity:revisit$/m.test(source), 'frontmatter names the command');
  assert(
    !source.includes('<context-discipline>'),
    'the delegation preamble is NOT hand-written — the render pipeline adds it',
  );
});

test('revisit role: renders for every host and carries the delegation preamble', () => {
  for (const host of ['claude', 'opencode', 'codex']) {
    const rendered = install.renderRole(ROLE_FILE, {}, host);
    assert(rendered.trim().length > 0, `${host}: renders`);
    assert(rendered.includes('<context-discipline>'), `${host}: carries the delegation preamble`);
    assertEqual((rendered.match(/<context-discipline>/g) || []).length, 1, `${host}: exactly once`);
    assert(
      rendered.indexOf('<context-discipline>') < rendered.indexOf('<objective>'),
      `${host}: preamble first, the role's own instructions after`,
    );
    assert(rendered.includes('docs/revisit/'), `${host}: the report path survives the pass`);
  }
});

// --- 2. the policy: write only for the report -----------------------------------

test('revisit role: its policy loads against the FROZEN loader and is read-side plus one report', () => {
  const loaded = policy.loadPolicy(POLICY_FILE);
  assertEqual(loaded.schema_version, 1);
  assertEqual(loaded.capabilities.read_repository, true, 'reads everything');
  assertEqual(loaded.capabilities.write_repository, true, 'may write — the report only');
  assertEqual(loaded.capabilities.git_read, true, 'git log / status / remote');
  assertEqual(loaded.capabilities.github_read, true, 'gh issue / pr / release list');
  for (const cap of ['git_write', 'github_write', 'deploy', 'network', 'run_tests']) {
    assertEqual(loaded.capabilities[cap], false, `${cap} is NOT granted to revisit`);
  }
  assertEqual(loaded.codex.sandbox, 'workspace-write', 'it writes its report under Codex too');
  assertEqual(loaded.codex.approval, 'never');
  assertEqual(loaded.codex.ignore_user_config, true);
  assertEqual(loaded.codex.ignore_rules, false);
  const raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  for (const key of Object.keys(raw.capabilities)) {
    assert(policy.CAPABILITY_KEYS.includes(key), `${key} is in the frozen v1 vocabulary`);
  }
});

// --- 3. the Claude allowlist: no write outside docs/revisit/ ----------------------

test('revisit role: .tools.json scopes every write to docs/revisit/ and borrows no other role verb', () => {
  const tools = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  assert(Array.isArray(tools) && tools.length > 0, 'a non-empty allowlist');
  assert(!tools.includes('Write'), 'no bare Write');
  assert(!tools.includes('Edit'), 'no bare Edit');
  let scopedWrites = 0;
  for (const entry of tools) {
    if (/^(Write|Edit)\(/.test(entry)) {
      scopedWrites += 1;
      assert(
        /^(Write|Edit)\(docs\/revisit\//.test(entry),
        `${entry}: write scope is docs/revisit/ only`,
      );
    }
    assert(
      !/^Bash\((verity ((stage|contract|adr)\b(?! list)|identity lock|scaffold|map)|gh (issue|pr) (create|edit|comment))/.test(
        entry,
      ),
      `${entry}: belongs to another role`,
    );
  }
  assert(scopedWrites > 0, 'the report write IS allowlisted (scoped)');
  assert(tools.includes('Task'), 'sweeps are delegated — Task is allowlisted');
  assert(tools.includes('Bash(verity identity get:*)'), 'the mode probe is allowlisted');
});

// --- 4. prompt content --------------------------------------------------------------

test('revisit role: the prompt names both modes, the report path, the three rules, and ownership', () => {
  const source = fs.readFileSync(ROLE_FILE, 'utf8');
  assert(source.includes('Verity mode'), 'names Verity mode');
  assert(source.includes('Adoption mode'), 'names Adoption mode');
  assert(source.includes('verity identity get'), 'the probe that picks the mode');
  assert(source.includes('docs/revisit/'), 'the report path pattern');
  // The three prompt rules the review checks for.
  assert(
    /A prior model's decision is a claim, not a fact\. Verify against source\./.test(source),
    'rule: a decision is a claim',
  );
  assert(
    /If you cannot verify, say `unverified` and why\. Never fill a gap with a\s+plausible answer\./.test(
      source,
    ),
    'rule: unverified, never plausible',
  );
  assert(
    /Do not run `verity map`, `verity stage new`, `verity contract new`,\s+`verity adr new`, `verity identity lock`, or `verity scaffold`\./.test(
      source,
    ),
    'rule: other roles’ verbs are named, not run',
  );
  // The ownership clause names the owning role of each artifact it must not write.
  const ownership = source.match(
    /It never writes[\s\S]*?Proposals are\s+handed to `\/verity:plan`/,
  );
  assert(ownership, 'the ownership clause is present');
  for (const owner of ['plan', 'architect', 'ship', 'vision']) {
    assert(ownership[0].includes(`(${owner})`), `ownership clause names ${owner}`);
  }
  // Fail-closed state is surfaced as unverified, never as empty.
  assert(/unverified: <reason>/.test(source), 'a state refusal is reported as unverified');
  assert(source.includes('First green on legacy code'), 'adoption proposal 1 is the gate');
  for (const section of [
    '## Mode',
    '## Standing',
    '## Analysis',
    '## Claim / reality',
    '## Proposals',
    '## Later',
    '## Unverified',
    '## Handoff',
  ]) {
    assert(source.includes(section), `fixed report section ${section}`);
  }
});

// --- 5. every adapter installs it; the corpus is 16 -------------------------------

test('revisit role: every adapter installs it and the Codex skill count is 16', () => {
  const claude = sandbox('revisit-claude');
  install.installClaude({ target: claude.target, home: claude.home });
  const claudeDir = path.join(claude.target, 'commands', 'verity');
  assert(fs.existsSync(path.join(claudeDir, `${ROLE}.md`)), 'claude: command installed');
  assert(fs.existsSync(path.join(claudeDir, `${ROLE}.tools.json`)), 'claude: tools travel with it');
  const oc = sandbox('revisit-oc');
  install.installOpenCode({ target: oc.target, home: oc.home });
  assert(
    fs.existsSync(path.join(oc.target, 'command', `verity-${ROLE}.md`)),
    'opencode: flattened command installed',
  );
  const cx = sandbox('revisit-cx');
  install.installCodex({ target: cx.target, home: cx.home });
  const skillDir = path.join(cx.target, 'skills', `verity-${ROLE}`);
  assert(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'codex: SKILL.md installed');
  const skills = fs.readdirSync(path.join(cx.target, 'skills'));
  assertEqual(skills.length, 16, 'exactly the 16 workflow skills');
  const workflow = fs.readdirSync(ROLES_DIR).filter((n) => n.endsWith('.md'));
  assertEqual(workflow.length, 16, 'the workflow corpus is 16 roles');
  assert(workflow.includes(`${ROLE}.md`), 'and revisit is one of them');
});

// --- 6. it resolves ---------------------------------------------------------------

test('revisit role: agent-exec.resolveRole resolves file, tools, and permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-revisit-resolve-'));
  const resolved = agentExec.resolveRole(root, ROLE);
  assert(resolved !== null, 'the packaged role resolves');
  assertEqual(resolved.file, ROLE_FILE, 'file');
  assertEqual(resolved.toolsFile, TOOLS_FILE, 'tools');
  assertEqual(resolved.permissionsFile, POLICY_FILE, 'permissions');
  assert(fs.existsSync(resolved.toolsFile), 'tools file exists at the resolved path');
  assert(fs.existsSync(resolved.permissionsFile), 'policy exists at the resolved path');
});

// --- 7. kill-switch is structural: the worker never dispatches it --------------------

test('revisit role: autonomy.cjs defaults never name it (operator-invoked only)', () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, 'verity', 'bin', 'lib', 'autonomy.cjs'), 'utf8');
  const autoAdvance = src.match(/auto_advance:\s*\[([^\]]*)\]/);
  assert(autoAdvance, 'auto_advance default is declared');
  assert(!autoAdvance[1].includes(ROLE), 'auto_advance does not name revisit');
  const gates = src.match(/gates:\s*\[([^\]]*)\]/);
  assert(gates, 'gates default is declared');
  assert(!gates[1].includes(ROLE), 'no gate names revisit');
  const known = src.match(/KNOWN_AGENT_ROLES\s*=\s*\[([^\]]*)\]/);
  assert(known, 'KNOWN_AGENT_ROLES is declared');
  assert(!known[1].includes(ROLE), 'KNOWN_AGENT_ROLES does not name revisit');
  // And through the exported surface, when it is exposed.
  if (autonomy.DEFAULTS) {
    assert(!autonomy.DEFAULTS.auto_advance.includes(ROLE), 'exported auto_advance default');
    assert(!autonomy.DEFAULTS.gates.some((g) => g.includes(ROLE)), 'exported gates default');
  }
  if (autonomy.KNOWN_AGENT_ROLES) {
    assert(!autonomy.KNOWN_AGENT_ROLES.includes(ROLE), 'exported KNOWN_AGENT_ROLES');
  }
});
