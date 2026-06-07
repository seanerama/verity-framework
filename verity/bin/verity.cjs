#!/usr/bin/env node
// Verity CLI dispatcher — the deterministic "notebook" layer (framework-spec.md §9).
// READ-ONLY w.r.t. integration state; performs framework-conventional acts and
// authors the few writable artifacts. JSON by default; --raw for plain values;
// --cwd to target another project directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core.cjs');
const config = require('./lib/config.cjs');
const identity = require('./lib/identity.cjs');
const scaffold = require('./lib/scaffold.cjs');
const install = require('./lib/install.cjs');
const adr = require('./lib/adr.cjs');
const contract = require('./lib/contract.cjs');
const catalog = require('./lib/catalog.cjs');
const stage = require('./lib/stage.cjs');
const ledger = require('./lib/ledger.cjs');
const review = require('./lib/review.cjs');
const release = require('./lib/release.cjs');
const status = require('./lib/status.cjs');
const security = require('./lib/security.cjs');
const handoff = require('./lib/handoff.cjs');
const map = require('./lib/map.cjs');
const recovery = require('./lib/recovery.cjs');
const golive = require('./lib/golive.cjs');
const smoke = require('./lib/smoke.cjs');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--raw') {
      flags.raw = true;
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--cwd') {
      i += 1;
      flags.cwd = argv[i];
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        flags[key] = next;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function emit(result, flags) {
  if (flags.raw) {
    const raw = result && typeof result === 'object' && 'raw' in result ? result.raw : result;
    let text = '';
    if (raw === null || raw === undefined) {
      text = '';
    } else if (typeof raw === 'object') {
      // A structured result with no scalar `raw` — emit compact JSON, never "[object Object]".
      text = JSON.stringify(raw);
    } else {
      text = String(raw);
    }
    process.stdout.write(`${text}\n`);
    return;
  }
  const json = JSON.stringify(result, null, 2);
  // Large payloads spill to a tempfile (the 1.4 convention) so we never blow a
  // consumer's buffer; the caller reads the @file: path.
  if (json.length > 50000) {
    const tmp = path.join(os.tmpdir(), `verity-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, json);
    process.stdout.write(`@file:${tmp}\n`);
    return;
  }
  process.stdout.write(`${json}\n`);
}

const COMMANDS = {
  slug(rest) {
    const slug = core.generateSlug(rest.join(' '));
    return { slug, validation: core.validateSlug(slug), raw: slug };
  },
  timestamp() {
    const ts = new Date().toISOString();
    return { timestamp: ts, raw: ts };
  },
  'verify-path'(rest, flags) {
    const base = flags.cwd || process.cwd();
    const target = path.resolve(base, rest[0] || '');
    const exists = fs.existsSync(target);
    return { path: target, exists, raw: String(exists) };
  },
  config(rest, flags) {
    return config.dispatch(rest, flags);
  },
  identity(rest, flags) {
    return identity.dispatch(rest, flags);
  },
  scaffold(rest, flags) {
    return scaffold.dispatch(rest, flags);
  },
  install(rest, flags) {
    return install.dispatch(rest, flags);
  },
  adr(rest, flags) {
    return adr.dispatch(rest, flags);
  },
  contract(rest, flags) {
    return contract.dispatch(rest, flags);
  },
  guides(rest) {
    return catalog.guidesDispatch(rest);
  },
  feature(rest) {
    return catalog.featureDispatch(rest);
  },
  stage(rest, flags) {
    return stage.dispatch(rest, flags);
  },
  state(rest, flags) {
    return ledger.dispatch(rest, flags);
  },
  review(rest, flags) {
    return review.dispatch(rest, flags);
  },
  release(rest, flags) {
    return release.dispatch(rest, flags);
  },
  status(rest, flags) {
    return status.dispatch(rest, flags);
  },
  security(rest, flags) {
    return security.dispatch(rest, flags);
  },
  handoff(rest, flags) {
    return handoff.dispatch(rest, flags);
  },
  map(rest, flags) {
    return map.dispatch(rest, flags);
  },
  recovery(rest, flags) {
    return recovery.dispatch(rest, flags);
  },
  golive(rest, flags) {
    return golive.dispatch(rest, flags);
  },
  smoke(rest, flags) {
    return smoke.dispatch(rest, flags);
  },
};

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const noun = positional[0];

  if (!noun || noun === 'help') {
    emit(
      {
        commands: Object.keys(COMMANDS),
        usage: 'verity <command> [args] [--raw] [--cwd <dir>]',
      },
      flags,
    );
    return;
  }

  const handler = COMMANDS[noun];
  if (!handler) {
    process.stderr.write(
      `${JSON.stringify({ error: `unknown command: ${noun}`, commands: Object.keys(COMMANDS) })}\n`,
    );
    process.exit(1);
  }

  try {
    emit(handler(positional.slice(1), flags), flags);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
  }
}

main();
