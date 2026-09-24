// Pre-go-live / first-real-data gate (framework-spec.md §6). A BLOCKING checklist
// before the project accepts real data/users (Security Auditor + SRE jointly). Auto-
// checks what's derivable; lists the manual gates that need human confirmation.
//
// Stage 107: each manual gate has a stable id and a recorded disposition — `ok` or
// `n/a` with a reason — written by a named person into `.verity/runtime.json` under
// the optional `golive` key and rendered into STATUS.md. `ready` means the
// auto-checks pass AND every manual gate is answered.
const fs = require('node:fs');
const path = require('node:path');

const security = require('./security.cjs');
const status = require('./status.cjs');

// Object.hasOwn needs Node 16.9 and engines allows 16.7 (the tiers.cjs convention).
const hasOwn = Object.prototype.hasOwnProperty;

const SECRET_ITEM = 'Secret locations recorded in STATUS (runtime.json)';

// The five manual gates. Ids are stable (they key runtime.json records and the
// CLI verbs); item text is unchanged from the pre-107 string list.
const GATES = [
  { id: 'secrets-rotated', item: 'Secrets rotated (no dev/exposed credentials)' },
  { id: 'throwaway-accounts', item: 'Throwaway accounts removed' },
  { id: 'cross-user-isolation', item: 'Cross-user data isolation verified' },
  {
    id: 'backup-coverage',
    item: 'Backup coverage for ALL persistent state (no silent gaps)',
  },
  { id: 'security-signoff', item: 'Security deep-audit sign-off' },
];
const GATE_IDS = GATES.map((g) => g.id);

function gateFor(id) {
  const gate = GATES.find((g) => g.id === id);
  if (!gate) {
    throw new Error(
      `unknown golive gate: ${JSON.stringify(id === undefined ? '' : id)} — use one of: ${GATE_IDS.join(', ')}`,
    );
  }
  return gate;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// A stored record counts as an answer only when it is well formed: a known
// disposition, a named person, and (for n/a) a reason of the minimum length. A
// hand-edited record that is anonymous or reasonless is treated as unanswered.
function answered(record) {
  if (!record || typeof record !== 'object' || !nonEmpty(record.by)) {
    return null;
  }
  if (record.disposition === 'ok') {
    return record;
  }
  if (
    record.disposition === 'n/a' &&
    typeof record.reason === 'string' &&
    record.reason.trim().length >= status.MIN_REASON
  ) {
    return record;
  }
  return null;
}

function manualGates(golive) {
  const records = golive && typeof golive === 'object' ? golive : {};
  return GATES.map((g) => {
    const rec = answered(records[g.id]);
    return {
      id: g.id,
      item: g.item,
      disposition: rec ? rec.disposition : null,
      by: rec ? rec.by : null,
      at: rec && typeof rec.at === 'string' ? rec.at : null,
      reason: rec && rec.disposition === 'n/a' ? rec.reason : null,
    };
  });
}

// Auto-check 2: a non-empty array whose every entry is a location string or an
// `n/a: <reason>` with a non-empty reason. The item text says why it fails.
function secretCheck(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    return { item: SECRET_ITEM, ok: false };
  }
  if (locations.some((e) => typeof e !== 'string')) {
    return {
      item: `${SECRET_ITEM} — every entry must be a string (a location or "n/a: <reason>")`,
      ok: false,
    };
  }
  const blank = locations.find(
    (e) => status.isNotApplicable(e) && e.slice(status.NA_PREFIX.length).trim() === '',
  );
  if (blank !== undefined) {
    return {
      item: `${SECRET_ITEM} — an "n/a:" entry has no reason; record why with verity status secret --none "<reason>"`,
      ok: false,
    };
  }
  return { item: SECRET_ITEM, ok: true };
}

function check(cwd) {
  const runtime = status.read(cwd);
  const items = [
    {
      item: 'Security invariants defined (docs/security-invariants.md)',
      ok: Boolean(security.read(cwd)),
    },
    secretCheck(runtime.secret_locations),
    {
      item: 'Recovery plan present (recovery-plan.md)',
      ok: fs.existsSync(path.join(cwd, 'recovery-plan.md')),
    },
  ];
  const manual = manualGates(runtime.golive);
  const autoPass = items.every((i) => i.ok);
  const unanswered = manual.filter((m) => !m.disposition).map((m) => m.id);
  let raw = 'BLOCKED: resolve the failing auto-checks';
  if (autoPass && unanswered.length > 0) {
    raw = `auto-checks pass; ${unanswered.length} manual gate(s) unanswered: ${unanswered.join(', ')}`;
  } else if (autoPass) {
    raw = `auto-checks pass; all ${GATES.length} manual gates answered — ready for go-live`;
  }
  return {
    items,
    manual,
    autoPass,
    ready: autoPass && unanswered.length === 0,
    raw,
  };
}

// The STATUS.md `## Go-live gate` section (rendered by status.render when the
// runtime.json `golive` key exists). One line per manual gate.
function statusSection(golive) {
  const lines = ['## Go-live gate'];
  for (const m of manualGates(golive)) {
    const date = m.at ? m.at.slice(0, 10) : 'undated';
    if (m.disposition === 'ok') {
      lines.push(`- **${m.item}:** ok — ${m.by}, ${date}`);
    } else if (m.disposition === 'n/a') {
      lines.push(`- **${m.item}:** n/a — ${m.reason} (${m.by}, ${date})`);
    } else {
      lines.push(`- **${m.item}:** unanswered`);
    }
  }
  lines.push('');
  return lines;
}

function stamp(now) {
  if (now === undefined) {
    return new Date().toISOString();
  }
  return new Date(now).toISOString();
}

// `verity golive confirm <id> --by <who> [--na "<reason>"]`. Opts: { by, na, now }
// (`now` — a Date, ms number or ISO string — is injectable for tests).
function confirm(cwd, id, opts = {}) {
  const gate = gateFor(id);
  if (!nonEmpty(opts.by)) {
    throw new Error(
      'golive confirm requires --by <who> — a disposition names the person who answered it (no anonymous sign-off)',
    );
  }
  const record = { disposition: 'ok', by: opts.by.trim(), at: stamp(opts.now) };
  if (opts.na !== undefined) {
    const reason = typeof opts.na === 'string' ? opts.na.trim() : '';
    if (reason.length < status.MIN_REASON) {
      throw new Error(
        `golive confirm --na needs a reason of at least ${status.MIN_REASON} characters a reviewer can check against docs/security-invariants.md (got ${JSON.stringify(reason)})`,
      );
    }
    record.disposition = 'n/a';
    record.reason = reason;
  }
  const data = status.read(cwd);
  const existing = data.golive && typeof data.golive === 'object' ? data.golive : {};
  data.golive = { ...existing, [gate.id]: record };
  status.write(cwd, data);
  status.render(cwd, data);
  const after = check(cwd);
  return {
    id: gate.id,
    item: gate.item,
    ...record,
    ready: after.ready,
    raw: `${gate.id}: ${record.disposition} (${record.by}) — ${after.raw}`,
  };
}

// `verity golive reset <id>` — removes the record. When no gate is answered any
// more the `golive` key is dropped, so the file returns to its pre-golive shape.
function reset(cwd, id) {
  const gate = gateFor(id);
  const data = status.read(cwd);
  const existing = data.golive && typeof data.golive === 'object' ? data.golive : null;
  const removed = Boolean(existing && hasOwn.call(existing, gate.id));
  if (removed) {
    const rest = { ...existing };
    Reflect.deleteProperty(rest, gate.id);
    if (Object.keys(rest).length > 0) {
      data.golive = rest;
    } else {
      Reflect.deleteProperty(data, 'golive');
    }
    status.write(cwd, data);
    status.render(cwd, data);
  }
  const after = check(cwd);
  return {
    id: gate.id,
    removed,
    ready: after.ready,
    raw: `${gate.id}: ${removed ? 'reset' : 'not answered'} — ${after.raw}`,
  };
}

function dispatch(args, flags) {
  const cwd = flags.cwd || process.cwd();
  const verb = args[0];
  if (verb === undefined) {
    return check(cwd);
  }
  if (verb === 'confirm') {
    return confirm(cwd, args[1], { by: flags.by, na: flags.na });
  }
  if (verb === 'reset') {
    return reset(cwd, args[1]);
  }
  throw new Error(`unknown golive verb: ${verb} — use (none)|confirm|reset`);
}

module.exports = {
  GATES,
  GATE_IDS,
  check,
  confirm,
  reset,
  statusSection,
  dispatch,
};
