// Scores eval/data/results.jsonl against the holdout answer key.
//
//   node eval/score.mjs
//
// Reports accuracy against the baselines that matter, a confusion matrix, a
// breakdown by evidence tier and database support, and a calibration table —
// whether a stated confidence of N% is right about N% of the time.

import fs from 'node:fs';
import path from 'node:path';
import { loadJSON, ROOT } from './lib.mjs';

const DATA = path.join(ROOT, 'eval', 'data');
const DIRS = ['up', 'down', 'none'];

function load() {
  const p = path.join(DATA, 'results.jsonl');
  if (!fs.existsSync(p)) {
    console.error('no results yet — run eval/run-eval.mjs first');
    process.exit(1);
  }
  const byId = new Map();
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    if (l.trim()) { const r = JSON.parse(l); byId.set(r.id, r); } // last write wins
  }
  return [...byId.values()];
}

const pc = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '—');

function section(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

const rows = load();
const ok = rows.filter(r => !r.error && r.predicted);
const errored = rows.length - ok.length;

const holdout = loadJSON(path.join(DATA, 'holdout.json'));
const truthDist = holdout.reduce((a, c) => (a[c.truth] = (a[c.truth] || 0) + 1, a), {});
const majority = Object.entries(truthDist).sort((a, b) => b[1] - a[1])[0];

const correct = ok.filter(r => r.predicted === r.truth).length;

section('headline');
console.log(`scored            ${ok.length}${errored ? `  (${errored} failed to parse or call)` : ''}`);
console.log(`accuracy          ${pc(correct, ok.length)}   ${correct}/${ok.length}`);
console.log(`majority baseline ${pc(majority[1], holdout.length)}   always "${majority[0]}"`);
const lift = correct / ok.length - majority[1] / holdout.length;
console.log(`lift over baseline ${(lift * 100 >= 0 ? '+' : '') + (lift * 100).toFixed(1)}pt` +
  (lift <= 0 ? '   <- not beating a constant guess' : ''));

section('confusion — rows are truth, columns are prediction');
console.log('        ' + DIRS.map(d => d.padStart(7)).join('') + '    total');
for (const t of DIRS) {
  const r = ok.filter(x => x.truth === t);
  console.log('  ' + t.padEnd(6) + DIRS.map(p => String(r.filter(x => x.predicted === p).length).padStart(7)).join('') +
    String(r.length).padStart(9));
}
const other = ok.filter(x => !DIRS.includes(x.predicted));
if (other.length) console.log(`  (${other.length} predictions outside up/down/none, e.g. "${other[0].predicted}")`);

section('by database support');
for (const [label, f] of [
  ['exact row available', r => r.dbExact > 0],
  ['analogous only', r => !r.dbExact && r.dbAnalogous > 0],
  ['nothing in database', r => !r.dbExact && !r.dbAnalogous]
]) {
  const g = ok.filter(f);
  if (g.length) console.log(`  ${label.padEnd(22)} ${String(g.length).padStart(4)}   ${pc(g.filter(r => r.predicted === r.truth).length, g.length)}`);
}

section('by evidence tier the model claimed');
const tiers = [...new Set(ok.map(r => r.evidenceLevel))].sort();
for (const t of tiers) {
  const g = ok.filter(r => r.evidenceLevel === t);
  console.log(`  ${(t || '(none)').padEnd(30)} ${String(g.length).padStart(4)}   ${pc(g.filter(r => r.predicted === r.truth).length, g.length)}`);
}

section('calibration — is a stated confidence honest');
console.log('  stated        n   actual   gap');
for (const [lo, hi] of [[0, 25], [25, 50], [50, 70], [70, 85], [85, 101]]) {
  const g = ok.filter(r => r.confidence >= lo && r.confidence < hi);
  if (!g.length) continue;
  const acc = g.filter(r => r.predicted === r.truth).length / g.length;
  const mid = g.reduce((a, r) => a + r.confidence, 0) / g.length / 100;
  const gap = (acc - mid) * 100;
  console.log(`  ${String(lo).padStart(3)}-${String(hi - 1).padEnd(4)} ${String(g.length).padStart(5)}   ${(acc * 100).toFixed(1).padStart(6)}%   ${(gap >= 0 ? '+' : '') + gap.toFixed(1)}pt` +
    (Math.abs(gap) > 15 ? '  <- miscalibrated' : ''));
}

// Expected calibration error: the headline number for "can I trust the %".
let ece = 0;
for (const [lo, hi] of [[0, 25], [25, 50], [50, 70], [70, 85], [85, 101]]) {
  const g = ok.filter(r => r.confidence >= lo && r.confidence < hi);
  if (!g.length) continue;
  const acc = g.filter(r => r.predicted === r.truth).length / g.length;
  const mid = g.reduce((a, r) => a + r.confidence, 0) / g.length / 100;
  ece += (g.length / ok.length) * Math.abs(acc - mid);
}
console.log(`\n  expected calibration error  ${(ece * 100).toFixed(1)}pt   (lower is better; 0 means the % can be read literally)`);
