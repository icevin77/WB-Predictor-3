// Measures the retrieval layer only — no model, no API key, no cost.
//
//   node eval/retrieval-eval.mjs
//
// Two things are scored, both against ground truth the database already holds:
//
//   1. Alias resolution. Every row records a canonical name and the name the
//      paper used. Those must resolve to the same key; a pair that does not is
//      a lookup the app would miss.
//   2. Row recall. For each gradeable row, query with the name as written in
//      the paper and check that the matcher finds that row among the rest.
//
// Both are reported for the old normalisation and the new one, so the change
// is a measured difference rather than an assertion.

import { loadDB, filled, isGradeable, legacyMatches, legacyNorm } from './lib.mjs';
await import('../lib/normalize.js');
const N = globalThis.WB_NORM;

const KINDS = [['cell', 'cell_raw'], ['marker', 'marker_raw'], ['drug', 'drug_raw']];

function aliasScore(rows) {
  const out = {};
  for (const [canon, raw] of KINDS) {
    const pairs = new Set();
    for (const r of rows) {
      if (filled(r, canon) && filled(r, raw)) pairs.add(r[canon] + '\u0000' + r[raw]);
    }
    let legacy = 0, now = 0;
    for (const p of pairs) {
      const [c, w] = p.split('\u0000');
      if (legacyNorm(c) === legacyNorm(w)) legacy++;
      if (N.norm(c, canon) === N.norm(w, canon)) now++;
    }
    out[canon] = { total: pairs.size, legacy, now };
  }
  return out;
}

function recallScore(rows, cases) {
  // For each case, search the whole database with the paper's own wording and
  // see whether the row it came from is returned.
  const byDrugLegacy = new Map();
  const byDrugNew = new Map();
  for (const r of rows) {
    const kl = legacyNorm(r.drug), kn = N.norm(r.drug, 'drug');
    if (!byDrugLegacy.has(kl)) byDrugLegacy.set(kl, []);
    if (!byDrugNew.has(kn)) byDrugNew.set(kn, []);
    byDrugLegacy.get(kl).push(r);
    byDrugNew.get(kn).push(r);
  }

  let legacyHit = 0, newHit = 0;
  for (const c of cases) {
    const lc = (byDrugLegacy.get(legacyNorm(c.drug_raw || c.drug)) || [])
      .filter(r => legacyMatches(r.cell, c.cell_raw || c.cell) && legacyMatches(r.marker, c.marker_raw || c.marker));
    if (lc.some(r => r._line === c._line)) legacyHit++;

    const nc = (byDrugNew.get(N.norm(c.drug_raw || c.drug, 'drug')) || [])
      .filter(r => N.matches(r.cell, c.cell_raw || c.cell, 'cell') && N.matches(r.marker, c.marker_raw || c.marker, 'marker'));
    if (nc.some(r => r._line === c._line)) newHit++;
  }
  return { total: cases.length, legacy: legacyHit, now: newHit };
}

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }
function delta(a, b, t) {
  const d = (b - a) / t * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pt';
}

const rows = loadDB();
const cases = rows.filter(isGradeable);

console.log(`database: ${rows.length} rows · gradeable: ${cases.length}\n`);

console.log('alias resolution — canonical name vs the name the paper used');
console.log('  field    pairs    before     after     change');
const a = aliasScore(rows);
for (const [k, v] of Object.entries(a)) {
  console.log(`  ${k.padEnd(8)} ${String(v.total).padStart(5)}   ${pct(v.legacy, v.total).padStart(7)}   ${pct(v.now, v.total).padStart(7)}   ${delta(v.legacy, v.now, v.total).padStart(7)}`);
}

const r = recallScore(rows, cases);
console.log('\nrow recall — querying with the paper\'s wording, is the row found');
console.log(`  cases ${r.total}   before ${pct(r.legacy, r.total)}   after ${pct(r.now, r.total)}   ${delta(r.legacy, r.now, r.total)}`);

// Anything still unresolved is the work queue for the alias table.
const misses = [];
for (const [canon, raw] of KINDS) {
  for (const row of rows) {
    if (!filled(row, canon) || !filled(row, raw)) continue;
    if (N.norm(row[canon], canon) !== N.norm(row[raw], canon)) {
      misses.push(`${canon}: ${row[canon]}  ≠  ${row[raw]}`);
    }
  }
}
const uniq = [...new Set(misses)];
console.log(`\nstill unresolved: ${uniq.length}`);
uniq.slice(0, 12).forEach(m => console.log('  ' + m));
