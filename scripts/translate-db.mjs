// Translates the Korean text left in the embedded WB database inside
// index.html into English, in batches, and writes the result back.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-db.mjs [--dry-run]
//
// Only the `evidence`, `condition`, `conc_raw` and `time_raw` columns contain
// Korean; every other column is identifiers and numbers and is left untouched.
// Progress is cached in scripts/.translate-cache.json, so an interrupted run
// resumes without paying for the batches it already finished.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const HTML = path.join(import.meta.dirname, '..', 'index.html');
const CACHE = path.join(import.meta.dirname, '.translate-cache.json');
const MODEL = 'claude-sonnet-5-5';
const BATCH_SIZE = 40;
const DRY_RUN = process.argv.includes('--dry-run');

const HANGUL = /[가-힣ㄱ-ㆎ]/;

const SYSTEM = `You translate short Korean annotations from a western blot literature database into English.

These are terse experimental findings extracted from published papers. Accuracy matters more than fluency.

Rules:
- Keep every gene, protein, drug, cell line and antibody name exactly as written, including capitalisation and Greek letters.
- Keep numbers, units, concentrations and timepoints exactly as written.
- Translate only the Korean. Text already in English stays byte-identical.
- Use the register of a methods section: "P-gp expression decreased after treatment", not "The P-gp expression was found to have decreased".
- Never add information that is not in the source. Never add a trailing period if the source has none.
- Do not output commas or double quotes, as the result is written into a CSV field. Use a semicolon or "and" where the Korean used a comma.

You receive a JSON array of strings and return a JSON array of the same length, in the same order, and nothing else.`;

// Pull the embedded CSV out of the `var WB_DB_RAW = \`...\`;` template literal.
function readDB(html) {
  const start = html.indexOf('var WB_DB_RAW = `');
  if (start === -1) throw new Error('WB_DB_RAW not found in index.html');
  const from = start + 'var WB_DB_RAW = `'.length;
  const end = html.indexOf('\n`;', from);
  if (end === -1) throw new Error('end of WB_DB_RAW not found');
  return { from, end, csv: html.slice(from, end) };
}

function parseLine(line) {
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

// Translations go into a CSV field, so drop commas and quotes rather than
// depend on escaping surviving the viewer's parser.
function sanitise(s) {
  return s.replace(/[",]/g, ' ').replace(/\s+/g, ' ').trim();
}

// parseLine strips the quotes around a field, so a value that still contains a
// comma has to be re-quoted on the way out or it would split into two columns.
function csvField(s) {
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function translateBatch(client, strings) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(strings) }]
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('no JSON array in response');
  const out = JSON.parse(match[0]);
  if (out.length !== strings.length) {
    throw new Error(`expected ${strings.length} translations, got ${out.length}`);
  }
  return out.map(String);
}

async function main() {
  const html = fs.readFileSync(HTML, 'utf8');
  const { from, end, csv } = readDB(html);

  const lines = csv.split('\n');
  const headers = parseLine(lines[0]).map(h => h.trim());
  const cols = ['evidence', 'condition', 'conc_raw', 'time_raw']
    .map(c => headers.indexOf(c))
    .filter(i => i >= 0);

  // Collect the distinct Korean strings, so a phrase repeated across rows is
  // translated once.
  const unique = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseLine(lines[i]);
    for (const c of cols) {
      const v = (vals[c] || '').trim();
      if (v && HANGUL.test(v) && !seen.has(v)) { seen.add(v); unique.push(v); }
    }
  }

  console.log(`${lines.length - 1} rows, ${unique.length} distinct Korean strings`);
  if (!unique.length) { console.log('Nothing to translate.'); return; }

  const batches = Math.ceil(unique.length / BATCH_SIZE);
  if (DRY_RUN) {
    console.log(`Would send ${batches} batches of up to ${BATCH_SIZE}.`);
    console.log('Sample:', unique.slice(0, 5));
    return;
  }

  const map = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const todo = unique.filter(s => !(s in map));
  console.log(`${Object.keys(map).length} cached, ${todo.length} to translate`);

  const client = new Anthropic();
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    const n = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(todo.length / BATCH_SIZE);
    try {
      const out = await translateBatch(client, chunk);
      chunk.forEach((src, j) => { map[src] = sanitise(out[j]); });
      fs.writeFileSync(CACHE, JSON.stringify(map, null, 2));
      console.log(`batch ${n}/${total} ok`);
    } catch (e) {
      // Leave the batch untranslated rather than abort; rerun to retry it.
      console.error(`batch ${n}/${total} failed: ${e.message}`);
    }
  }

  const missing = unique.filter(s => !(s in map));
  if (missing.length) {
    console.warn(`${missing.length} strings still untranslated - rerun to retry them.`);
  }

  // Rewrite the affected cells, leaving untouched rows byte-for-byte as they
  // were so the diff shows only what was actually translated.
  let replaced = 0;
  const outLines = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) { outLines.push(lines[i]); continue; }
    const vals = parseLine(lines[i]);
    let changed = false;
    for (const c of cols) {
      const v = (vals[c] || '').trim();
      if (v && map[v] && map[v] !== v) { vals[c] = map[v]; changed = true; replaced++; }
    }
    outLines.push(changed ? vals.map(csvField).join(',') : lines[i]);
  }

  fs.writeFileSync(HTML, html.slice(0, from) + outLines.join('\n') + html.slice(end), 'utf8');
  console.log(`Replaced ${replaced} cells. index.html updated.`);
  console.log('Review with: git diff --stat index.html');
}

main().catch(e => { console.error(e.message); process.exit(1); });
