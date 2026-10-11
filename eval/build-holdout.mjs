// Splits the database into a holdout set and the rest.
//
//   node eval/build-holdout.mjs [--frac 0.2]
//
// The holdout rows are the answer key. They are removed from the database the
// model is shown, so a prediction about one of them cannot be read off the
// prompt — which is the flaw in the in-app calibration number.
//
// The split is by PMCID, not by row. Two rows from the same paper usually share
// a figure and a cell line, so splitting by row would leave near-duplicates of
// a test case in the training half and inflate the score.

import path from 'node:path';
import { loadDB, isGradeable, hash, rowKey, saveJSON, ROOT } from './lib.mjs';

const argv = process.argv.slice(2);
const frac = Number((argv[argv.indexOf('--frac') + 1]) || 0.2) || 0.2;
const OUT = path.join(ROOT, 'eval', 'data');

const rows = loadDB();
const gradeable = rows.filter(isGradeable);

// Papers are assigned whole, by a stable hash of the PMCID.
const papers = [...new Set(gradeable.map(r => r.pmcid))];
const heldPapers = new Set(papers.filter(p => hash('wb:' + p) < frac));

const holdout = gradeable.filter(r => heldPapers.has(r.pmcid));
const heldKeys = new Set(holdout.map(rowKey));

// Everything not in the holdout stays visible to the model, including
// non-gradeable rows from papers that were not held out.
const visible = rows.filter(r => !heldKeys.has(rowKey(r)));

// Guard: no holdout row may survive in the visible set under any spelling.
const leaked = visible.filter(r => heldKeys.has(rowKey(r)));
if (leaked.length) throw new Error(`${leaked.length} holdout rows leaked into the visible set`);

const dist = holdout.reduce((a, r) => (a[r.direction] = (a[r.direction] || 0) + 1, a), {});
const majority = Math.max(...Object.values(dist));

saveJSON(path.join(OUT, 'holdout.json'), holdout.map(r => ({
  id: rowKey(r),
  pmcid: r.pmcid,
  cell: r.cell, cell_raw: r.cell_raw,
  drug: r.drug, drug_raw: r.drug_raw,
  marker: r.marker, marker_raw: r.marker_raw,
  conc_uM: r.conc_uM, time_h: r.time_h,
  quality: r.quality,
  truth: r.direction
})));
saveJSON(path.join(OUT, 'visible.json'), visible);

console.log(`papers           ${papers.length}  (${heldPapers.size} held out)`);
console.log(`gradeable rows   ${gradeable.length}`);
console.log(`holdout          ${holdout.length}`);
console.log(`visible to model ${visible.length} of ${rows.length}`);
console.log(`\ndirection in holdout: ${JSON.stringify(dist)}`);
console.log(`majority-class baseline: ${(majority / holdout.length * 100).toFixed(1)}%  <- beat this`);
console.log(`\nwrote eval/data/holdout.json and eval/data/visible.json`);
