// Does the database actually change the answer?
//
//   ANTHROPIC_API_KEY=sk-ant-... node eval/ablation.mjs
//
// The holdout score alone cannot answer this. Most holdout cases have no
// database support at all — each drug/cell/marker combination usually appears
// in exactly one paper, so removing that paper removes the only row — and the
// cases that do have support are not necessarily comparable to the ones that
// do not.
//
// So this re-runs only the cases that DO have support, with the database
// section stripped from the prompt, and compares against the main run's answer
// for the same case. Same case, same prompt, one difference. That is the
// measurement.
//
// Cost: one call per supported case. The other arm is reused from
// eval/data/results.jsonl, so nothing is paid twice.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadJSON, ROOT } from './lib.mjs';
await import('../lib/normalize.js');
await import('../lib/prompt.js');
const WBN = globalThis.WB_NORM;
const { buildSystemPrompt } = globalThis.WB_PROMPT;

const DATA = path.join(ROOT, 'eval', 'data');
const OUT = path.join(DATA, 'ablation.jsonl');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MODEL = flag('--model', 'claude-sonnet-5-5');
const CONCURRENCY = Number(flag('--concurrency', 8)) || 8;
const LIMIT = Number(flag('--limit', 0)) || 0;

function support(db, c) {
  let exact = 0, analogous = 0;
  for (const r of db) {
    if (!WBN.matches(r.drug, c.drug, 'drug')) continue;
    if (!WBN.matches(r.marker, c.marker, 'marker')) continue;
    if (WBN.matches(r.cell, c.cell, 'cell')) exact++; else analogous++;
  }
  return { exact, analogous };
}

function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON');
  const chars = []; let inStr = false, prev = '';
  for (const ch of m[0].replace(/```json|```/g, '')) {
    let c = ch;
    if (c === '"' && prev !== '\\') inStr = !inStr;
    if (inStr && (c === '\n' || c === '\r' || c === '\t')) c = ' ';
    chars.push(c); prev = c;
  }
  return JSON.parse(chars.join('').replace(/,(\s*[}\]])/g, '$1'));
}

// The same user prompt the runner builds, with no database section.
async function runWithoutDB(client, c) {
  const user =
    `Cell line: ${c.cell}\nDrug: ${c.drug}\nConcentration: ${c.conc_uM} uM\n` +
    `Treatment time: ${c.time_h} h\nConditions: standard\nMarkers: ${c.marker}\n` +
    `Mode: known drug` +
    `\n\n[Instructions]\n1. Predict this one marker only.\n` +
    `2. Apply cell line deficiencies without exception.\n` +
    `3. Write a signaling_chain.\n` +
    `4. Compare the published dose and timepoint against the input; the larger the gap, the lower the confidence.`;

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 3000,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: user }]
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const p = (parseJSON(text).predictions || [])[0] || {};
  return {
    id: c.id, truth: c.truth,
    predicted: String(p.direction || '').toLowerCase(),
    confidence: Number(p.confidence) || 0,
    usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens }
  };
}

function report(withDB, withoutDB, cases) {
  const w = new Map(withDB.map(r => [r.id, r]));
  const o = new Map(withoutDB.map(r => [r.id, r]));
  const pairs = cases.filter(c => w.has(c.id) && o.has(c.id) && w.get(c.id).predicted && o.get(c.id).predicted);

  if (!pairs.length) { console.log('no comparable pairs yet'); return; }

  let wc = 0, oc = 0, flipToRight = 0, flipToWrong = 0, same = 0;
  for (const c of pairs) {
    const a = w.get(c.id), b = o.get(c.id);
    const aOK = a.predicted === c.truth, bOK = b.predicted === c.truth;
    if (aOK) wc++;
    if (bOK) oc++;
    if (a.predicted === b.predicted) same++;
    else if (aOK && !bOK) flipToRight++;
    else if (!aOK && bOK) flipToWrong++;
  }
  const pc = n => (n / pairs.length * 100).toFixed(1) + '%';
  console.log(`\npaired cases with database support: ${pairs.length}\n`);
  console.log(`  with database      ${pc(wc)}   ${wc}/${pairs.length}`);
  console.log(`  without database   ${pc(oc)}   ${oc}/${pairs.length}`);
  const d = (wc - oc) / pairs.length * 100;
  console.log(`  difference         ${(d >= 0 ? '+' : '') + d.toFixed(1)}pt` +
    (Math.abs(d) < 2 ? '   <- the database is not changing the outcome here' : ''));
  console.log(`\n  identical answer either way   ${same}`);
  console.log(`  database fixed a wrong answer ${flipToRight}`);
  console.log(`  database broke a right answer ${flipToWrong}`);

  const cw = pairs.reduce((a, c) => a + w.get(c.id).confidence, 0) / pairs.length;
  const co = pairs.reduce((a, c) => a + o.get(c.id).confidence, 0) / pairs.length;
  console.log(`\n  mean stated confidence: ${cw.toFixed(1)} with, ${co.toFixed(1)} without`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set.'); process.exit(1); }

  const holdout = loadJSON(path.join(DATA, 'holdout.json'));
  const db = loadJSON(path.join(DATA, 'visible.json'));
  const resPath = path.join(DATA, 'results.jsonl');
  if (!fs.existsSync(resPath)) { console.error('run eval/run-eval.mjs first'); process.exit(1); }

  const withDB = [];
  for (const l of fs.readFileSync(resPath, 'utf8').split('\n')) {
    if (l.trim()) withDB.push(JSON.parse(l));
  }
  const haveMain = new Set(withDB.filter(r => r.predicted).map(r => r.id));

  // Only cases that have support and already have a with-database answer.
  const supported = holdout.filter(c => {
    if (!haveMain.has(c.id)) return false;
    const s = support(db, c);
    return s.exact > 0 || s.analogous > 0;
  });

  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).id);
  }
  let todo = supported.filter(c => !done.has(c.id));
  if (LIMIT) todo = todo.slice(0, LIMIT);

  console.log(`${supported.length} supported cases · ${done.size} already run · ${todo.length} to run`);

  if (todo.length) {
    const client = new Anthropic();
    const out = fs.createWriteStream(OUT, { flags: 'a' });
    let n = 0, tin = 0, tout = 0;
    const queue = todo.slice();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const r = await runWithoutDB(client, c);
          tin += r.usage.in; tout += r.usage.out;
          out.write(JSON.stringify(r) + '\n');
        } catch (e) {
          out.write(JSON.stringify({ id: c.id, truth: c.truth, predicted: '', error: e.message }) + '\n');
        }
        if (++n % 10 === 0 || n === todo.length) process.stdout.write(`\r  ${n}/${todo.length}`);
      }
    }));
    out.end();
    await new Promise(r => out.on('finish', r));
    const cost = tin / 1e6 * 2 + tout / 1e6 * 10;
    console.log(`\n  tokens in ${tin.toLocaleString()} out ${tout.toLocaleString()} · ~$${cost.toFixed(2)}`);
  }

  const withoutDB = [];
  for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l.trim()) withoutDB.push(JSON.parse(l));
  report(withDB.filter(r => r.predicted), withoutDB, supported);
}

main().catch(e => { console.error(e.message); process.exit(1); });
