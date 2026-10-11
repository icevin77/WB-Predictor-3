// Runs the predictor against the holdout set and records what it answered.
//
//   ANTHROPIC_API_KEY=sk-ant-... node eval/run-eval.mjs --limit 20   # smoke test
//   ANTHROPIC_API_KEY=sk-ant-... node eval/run-eval.mjs              # full run
//
// Scope: this measures the database-plus-model core — the same system prompt
// the app sends, over the same database with the holdout removed. The external
// sources (PubChem, PMC, UniProt, LINCS, cBioPortal) are not called, so the
// number is the floor the live app builds on, not the live app's own score.
//
// Results append to eval/data/results.jsonl and completed ids are skipped, so
// an interrupted run resumes without paying twice.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadJSON, saveJSON, ROOT, filled } from './lib.mjs';
await import('../lib/normalize.js');
await import('../lib/prompt.js');
const WBN = globalThis.WB_NORM;
const { EV, buildSystemPrompt } = globalThis.WB_PROMPT;

const DATA = path.join(ROOT, 'eval', 'data');
const RESULTS = path.join(DATA, 'results.jsonl');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = Number(flag('--limit', 0)) || 0;
const MODEL = flag('--model', 'claude-sonnet-5-5');
const CONCURRENCY = Number(flag('--concurrency', 4)) || 4;

// Pricing per million tokens, for the run's cost line. Update if it changes.
const PRICE = {
  'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-5-5': [0.1, 0.5]
};

function conditionScore(row, conc, time) {
  const num = s => { const m = String(s ?? '').match(/([\d.]+)/); return m ? parseFloat(m[1]) : null; };
  let c = 0.5;
  const ic = num(conc), dc = num(row.conc_uM);
  if (ic > 0 && dc > 0) c = Math.max(0, 1 - Math.abs(Math.log10(ic) - Math.log10(dc)) / 2);
  let t = 0.5;
  const it = num(time), dt = num(row.time_h);
  if (it !== null && dt !== null) t = Math.max(0, 1 - Math.abs(it - dt) / 48);
  return (c + t) / 2;
}

// Mirrors the database section of the app's corpus builder.
function dbCorpus(exact, analogous, conc, time) {
  let out = '';
  const line = (r, withCond) => {
    let s = `[PMC${r.pmcid} | ${r.cell} | ${r.drug}`;
    if (filled(r, 'conc_uM')) s += ` ${r.conc_uM}uM`;
    if (filled(r, 'time_h')) s += ` ${r.time_h}h`;
    if (withCond && filled(r, 'condition')) s += ` | ${r.condition}`;
    s += `] ${r.marker}: ${r.direction}`;
    if (filled(r, 'intensity')) s += ` (${r.intensity})`;
    if (withCond && r.quality) s += ` [Q:${r.quality}]`;
    return s + '\n';
  };
  if (exact.length) {
    out += '\n\n[WB Database - direct experiments in this cell line with this drug]\n';
    out += 'These are western blot results extracted from published papers. Treat them as the highest-priority evidence.\n';
    exact.forEach(r => { out += line(r, true); });
  }
  if (analogous.length) {
    out += '\n\n[WB Database - same drug, other cell lines]\n';
    out += 'Same drug in different cell lines. Use as a pattern reference only.\n';
    analogous.slice()
      .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
      .slice(0, 30).forEach(r => { out += line(r, false); });
  }
  return out;
}

function lookup(db, c) {
  const exact = [], analogous = [];
  for (const r of db) {
    if (!WBN.matches(r.drug, c.drug, 'drug')) continue;
    if (!WBN.matches(r.marker, c.marker, 'marker')) continue;
    (WBN.matches(r.cell, c.cell, 'cell') ? exact : analogous).push(r);
  }
  return { exact, analogous };
}

function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON');
  let s = m[0].replace(/```json|```/g, '');
  const chars = []; let inStr = false, prev = '';
  for (const ch of s) {
    let c = ch;
    if (c === '"' && prev !== '\\') inStr = !inStr;
    if (inStr && (c === '\n' || c === '\r' || c === '\t')) c = ' ';
    chars.push(c); prev = c;
  }
  return JSON.parse(chars.join('').replace(/,(\s*[}\]])/g, '$1'));
}

async function runCase(client, db, c) {
  const { exact, analogous } = lookup(db, c);
  const corpus = dbCorpus(exact, analogous, c.conc_uM, c.time_h);

  const user =
    `Cell line: ${c.cell}\nDrug: ${c.drug}\nConcentration: ${c.conc_uM} uM\n` +
    `Treatment time: ${c.time_h} h\nConditions: ${c.condition || 'standard'}\nMarkers: ${c.marker}\n` +
    `Mode: known drug` + corpus +
    `\n\n[Instructions]\n1. Predict this one marker only.\n` +
    (c.condition ? `   The comparison is "${c.condition}" — predict the change under that comparison, not versus untreated cells.\n` : '') +
    `2. Apply cell line deficiencies without exception.\n` +
    `3. Write a signaling_chain.\n` +
    `4. Compare the published dose and timepoint against the input; the larger the gap, the lower the confidence.`;

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 3000,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: user }]
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = parseJSON(text);
  const p = (parsed.predictions || [])[0] || {};

  return {
    id: c.id, truth: c.truth,
    predicted: String(p.direction || '').toLowerCase(),
    confidence: Number(p.confidence) || 0,
    evidenceLevel: p.evidenceLevel || '',
    intensity: p.intensity || '',
    dbExact: exact.length, dbAnalogous: analogous.length,
    condScore: exact.length ? Math.max(...exact.map(r => conditionScore(r, c.conc_uM, c.time_h))) : null,
    qualityMean: exact.length ? exact.reduce((a, r) => a + (parseInt(r.quality) || 50), 0) / exact.length : null,
    usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens }
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }
  const holdout = loadJSON(path.join(DATA, 'holdout.json'));
  const db = loadJSON(path.join(DATA, 'visible.json'));

  const done = new Set();
  if (fs.existsSync(RESULTS)) {
    for (const l of fs.readFileSync(RESULTS, 'utf8').split('\n')) {
      if (l.trim()) done.add(JSON.parse(l).id);
    }
  }
  let todo = holdout.filter(c => !done.has(c.id));
  if (LIMIT) todo = todo.slice(0, LIMIT);

  console.log(`model ${MODEL} · ${db.length} visible rows · ${done.size} already done · ${todo.length} to run`);
  if (!todo.length) { console.log('nothing to do'); return; }

  const client = new Anthropic();
  const out = fs.createWriteStream(RESULTS, { flags: 'a' });
  let n = 0, failed = 0, tin = 0, tout = 0;

  const queue = todo.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const r = await runCase(client, db, c);
        tin += r.usage.in; tout += r.usage.out;
        out.write(JSON.stringify(r) + '\n');
      } catch (e) {
        failed++;
        out.write(JSON.stringify({ id: c.id, truth: c.truth, predicted: '', error: e.message }) + '\n');
      }
      if (++n % 10 === 0 || n === todo.length) {
        process.stdout.write(`\r  ${n}/${todo.length}  failed ${failed}`);
      }
    }
  }));
  out.end();

  const [pin, pout] = PRICE[MODEL] || [0, 0];
  const cost = tin / 1e6 * pin + tout / 1e6 * pout;
  console.log(`\ntokens  in ${tin.toLocaleString()}  out ${tout.toLocaleString()}`);
  console.log(`cost    ~$${cost.toFixed(2)} at list price`);
  console.log(`\nwrote ${path.relative(ROOT, RESULTS)} — now run: node eval/score.mjs`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
