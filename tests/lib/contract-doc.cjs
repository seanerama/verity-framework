// Stage 100 (ADR-0035) — test helper, not engine: derive the DOCUMENTED key set
// of a frozen contract from the contract TEXT itself, so the pins in
// tests/contract-pins.test.cjs compare the emitted surface against what the
// contract actually says — never against a hand-copied list (the drift a copy
// would miss is exactly the drift being pinned).
//
// Lives in tests/lib/ and is NOT named *.test.cjs: the runner's discovery is a
// non-recursive `tests/*.test.cjs` glob, so this module is only ever required.
//
// documentedKeys(contractFile) → {
//   jsonTopLevelKeys: Set   top-level keys of every fenced ```json block
//   jsonKeyPaths:     Set   every key of those blocks as a dotted path (a.b.c)
//   yamlTopLevelKeys: Set   unindented `key:` lines of every fenced ```yaml block
//   yamlKeyPaths:     Set   every `key:` of those blocks as a dotted path
//   backtickedNames:  Set   every `inline code` span outside the fences, plus
//                           the leading name of a typed span (`name: type` → name)
// }
// Fail loud: a ```json block that does not JSON.parse, or a ```yaml block with a
// line that is neither blank nor `key:`-shaped, throws naming the file — a
// contract edit that breaks its own example is a defect, not something to skip.
const fs = require('node:fs');

const FENCE = /^```([A-Za-z]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const YAML_KEY = /^( *)([A-Za-z_][\w-]*):(?:\s|$)/;
const TYPED_SPAN = /^([A-Za-z_][\w.-]*)\s*:\s/;

function fencedBlocks(text) {
  const blocks = [];
  for (const m of text.matchAll(FENCE)) {
    blocks.push({
      lang: m[1].toLowerCase(),
      body: m[2],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return blocks;
}

function addJsonPaths(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    addJsonPaths(v, p, out);
  }
}

// Top-level + dotted key paths of one YAML example block. Comments (`#` to end
// of line) are stripped first; indentation defines nesting. Only the mapping
// subset the contracts use is accepted — anything else throws.
function yamlKeys(body, file, index) {
  const top = new Set();
  const paths = new Set();
  const stack = []; // [{ indent, key }]
  for (const raw of body.split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (line.trim() === '') {
      continue;
    }
    const m = YAML_KEY.exec(line);
    if (m === null) {
      throw new Error(
        `${file}: yaml block #${index} has a line that is not a \`key:\` mapping: ${JSON.stringify(raw)}`,
      );
    }
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const p = [...stack.map((s) => s.key), m[2]].join('.');
    paths.add(p);
    if (indent === 0) {
      top.add(m[2]);
    }
    stack.push({ indent, key: m[2] });
  }
  return { top, paths };
}

function parseContract(text, file = '<contract>') {
  const doc = {
    jsonTopLevelKeys: new Set(),
    jsonKeyPaths: new Set(),
    yamlTopLevelKeys: new Set(),
    yamlKeyPaths: new Set(),
    backtickedNames: new Set(),
  };
  const blocks = fencedBlocks(text);
  blocks.forEach((b, i) => {
    if (b.lang === 'json') {
      let obj;
      try {
        obj = JSON.parse(b.body);
      } catch (err) {
        throw new Error(`${file}: json block #${i} does not parse: ${err.message}`);
      }
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) {
          doc.jsonTopLevelKeys.add(k);
        }
      }
      addJsonPaths(obj, '', doc.jsonKeyPaths);
    } else if (b.lang === 'yaml' || b.lang === 'yml') {
      const { top, paths } = yamlKeys(b.body, file, i);
      for (const k of top) {
        doc.yamlTopLevelKeys.add(k);
      }
      for (const p of paths) {
        doc.yamlKeyPaths.add(p);
      }
    }
  });
  // Inline code spans in the prose only — fenced example bodies are parsed
  // above, never scanned as backtick text.
  let prose = '';
  let at = 0;
  for (const b of blocks) {
    prose += `${text.slice(at, b.start)}\n`;
    at = b.end;
  }
  prose += text.slice(at);
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    doc.backtickedNames.add(span);
    const typed = TYPED_SPAN.exec(span);
    if (typed !== null) {
      doc.backtickedNames.add(typed[1]);
    }
  }
  return doc;
}

function documentedKeys(contractFile) {
  return parseContract(fs.readFileSync(contractFile, 'utf8'), contractFile);
}

// The direct children of `prefix` in a dotted key-path set: children(paths,
// 'verify') → { gates, pack_shasum, … }.
function children(paths, prefix) {
  const out = new Set();
  const lead = `${prefix}.`;
  for (const p of paths) {
    if (p.startsWith(lead)) {
      const rest = p.slice(lead.length);
      if (!rest.includes('.')) {
        out.add(rest);
      }
    }
  }
  return out;
}

module.exports = { children, documentedKeys, parseContract };
