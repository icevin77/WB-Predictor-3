# WB Predictor

Western blot prediction from a cell line, a compound and a marker panel. Combines an
embedded database of western blot results extracted from the literature with live lookups
against PubChem, Cellosaurus, UniProt, LINCS, cBioPortal, PubMed and PMC, then asks a model
for a per-marker prediction with a confidence score.

Static front end plus one serverless function. The API key stays on the server.

## Layout

```
index.html               UI, prediction logic and the embedded WB database (~7.8k rows)
api/chat.js              Vercel function; the only place the API key is read
scripts/translate-db.mjs One-off translation of the remaining Korean in the database
vercel.json              Function timeout
```

## Deploy

```bash
npm install
vercel                        # preview
vercel --prod                 # production
```

Set the key as an environment variable in the Vercel project (Settings → Environment
Variables), not in a file:

```
ANTHROPIC_API_KEY = sk-ant-...
```

Then redeploy. The browser never sees the key; `index.html` posts to `/api/chat` and the
function adds the credential.

To run locally with the function available, use `vercel dev` — opening `index.html` directly
leaves `/api/chat` unrouted.

## Model

`index.html` sets the model in one place:

```js
var MODEL = 'claude-sonnet-5-5';
```

`api/chat.js` validates it against an allowlist and ignores anything else, so a leaked
endpoint cannot be pointed at a more expensive model. To change models, update both the
`MODEL` constant and `ALLOWED_MODELS`.

The previous version used `claude-sonnet-4-5`, which is deprecated and reaches end-of-life on
30 November 2026. It is still in the allowlist if you need to compare against it before then.

## Function timeout

`vercel.json` requests `maxDuration: 300`. A full run generates up to 12k output tokens and
can take a few minutes. Vercel's Hobby plan caps functions at 60 seconds, which is usually
not enough — either use a paid plan or lower `max_tokens` in `index.html`.

## Translating the database

Most of the embedded database is in English, but about 2,200 distinct strings in the
`evidence` and `condition` columns are still Korean. They are visible in the WB DB hit list
in the AI debate tab.

```bash
ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-db.mjs --dry-run   # count, no API calls
ANTHROPIC_API_KEY=sk-ant-... node scripts/translate-db.mjs             # translate in place
git diff --stat index.html
```

The script translates distinct strings in batches of 40, caches progress in
`scripts/.translate-cache.json` so an interrupted run resumes without re-paying, and rewrites
only the cells it changed. Rows it does not touch stay byte-for-byte identical, so the diff
shows exactly what moved. A failed batch is skipped rather than aborting the run; rerun to
retry it. Gene, protein, drug and cell line names, along with all doses and timepoints, are
preserved verbatim.

Review the diff before committing — these are extracted experimental findings, and the
wording carries scientific meaning.

## Caveat

Predictions are derived from published data and signaling logic, not from experiment. Novel
compounds are inferred from structural analogs plus target mechanism and carry greater
uncertainty. Confirm everything at the bench.
