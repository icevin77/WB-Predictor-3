// Shared helpers for the evaluation scripts.
// The database lives inside index.html, so it is parsed from there rather than
// duplicated — there is one copy of the data and it is the one the app ships.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, '..');
export const HTML = path.join(ROOT, 'index.html');

const START = 'var WB_DB_RAW = `';

export function parseLine(line) {
  const vals = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
    else cur += ch;
  }
  vals.push(cur);
  return vals;
}

export function loadDB(file = HTML) {
  const t = fs.readFileSync(file, 'utf8');
  const from = t.indexOf(START);
  if (from === -1) throw new Error('WB_DB_RAW not found');
  const s = from + START.length;
  const e = t.indexOf('\n`;', s);
  const lines = t.slice(s, e).split('\n');
  const headers = parseLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const v = parseLine(lines[i]);
    const r = {};
    headers.forEach((h, j) => { r[h] = (v[j] ?? '').trim(); });
    r._line = i;
    rows.push(r);
  }
  return rows;
}

export function filled(r, k) {
  const v = (r[k] || '').trim();
  return v !== '' && v !== 'nan';
}

// The normalisation the app used before the alias table existed. Kept so the
// retrieval evaluation can quote a before-and-after on the same queries.
export function baseNorm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/phospho/g, 'p')
    .replace(/[-_\s\/()\[\].,:;]/g, '')
    .trim();
}

export function legacyNorm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[-_\s\/()]/g, '')
    .replace(/phospho|p-/g, 'p');
}

export function legacyMatches(a, b) {
  const x = legacyNorm(a), y = legacyNorm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// A deterministic hash, so the holdout split is identical on every machine and
// does not drift between runs.
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function rowKey(r) {
  return [r.pmcid, r.cell, r.drug, r.marker, r.conc_uM, r.time_h].join('|');
}

// Rows usable as ground truth: an unambiguous direction and both experimental
// conditions recorded, so a prediction can be graded and the conditions can be
// handed to the model as the query.
export function isGradeable(r) {
  // A concentration of 0 is not a treatment. Those rows come from a range in
  // the source ("0-300 nM") whose first number was taken as the dose.
  if (parseFloat(r.conc_uM) === 0) return false;
  return ['up', 'down', 'none'].includes((r.direction || '').trim())
    && filled(r, 'conc_uM') && filled(r, 'time_h')
    && filled(r, 'cell') && filled(r, 'drug') && filled(r, 'marker');
}

export function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}
