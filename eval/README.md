# Evaluation

Nothing about this tool's accuracy was measured before. These scripts make it
measurable, so a change can be shown to help rather than argued to.

## Why the in-app number does not count

The AI debate tab shows agreement with the database. That is not an accuracy
score: the database rows it compares against were in the prompt the model just
read. It measures whether the model followed instructions.

Everything here uses a **holdout** — rows removed from the database before the
model sees it. A prediction about one of them cannot be read off the prompt.

## Order of operations

```bash
node scripts/build-aliases.mjs      # 1. alias tables from the DB's own name pairs
node eval/retrieval-eval.mjs        # 2. score retrieval — free, no API key
node eval/build-holdout.mjs         # 3. split the holdout out of the database

ANTHROPIC_API_KEY=sk-ant-... node eval/run-eval.mjs --limit 20   # 4. smoke test
ANTHROPIC_API_KEY=sk-ant-... node eval/run-eval.mjs              #    full run
node eval/score.mjs                 # 5. accuracy, confusion, calibration
node eval/fit-calibration.mjs       # 6. fit honest confidence weights
```

Steps 1-3 and 5-6 cost nothing. Only step 4 calls the API.

## What each step gives you

**`retrieval-eval.mjs`** — does the matcher find the right rows? Scored against
ground truth already in the database: every row carries a canonical name and
the name the paper used, and those must resolve to the same key. Reported
before and after the alias table, on the same queries.

**`build-holdout.mjs`** — splits **by paper, not by row**. Two rows from one
paper usually share a figure and a cell line, so a row-level split would leave
near-duplicates of a test case on the training side and inflate the score.
Prints the majority-class baseline, which is the number to beat; predicting the
most common direction every time currently scores about 46%.

**`run-eval.mjs`** — runs the shipped system prompt over the holdout with the
holdout removed from the database. Resumable: completed cases are skipped, so
an interrupted run does not pay twice. Reports token use and cost.

*Scope:* the external sources (PubChem, PMC, UniProt, LINCS, cBioPortal) are
not called. The number is the database-plus-model core — the floor the live app
builds on, not the live app's own score.

**`score.mjs`** — accuracy against the baseline, a confusion matrix, accuracy
split by how much database support each case had, and a calibration table
answering whether a stated confidence of N% is right about N% of the time.

**`fit-calibration.mjs`** — the one piece of real machine learning here:
L2-regularised logistic regression over features known before grading (database
support, condition match, evidence tier, the model's own stated confidence).
It predicts whether the direction is right, which is what a confidence number
is supposed to mean. Five-fold cross-validated, and it refuses to claim an
improvement it did not measure. Writes `lib/calibration.js`, which the app
picks up automatically.

Until that file is generated it is a placeholder that returns the stated
confidence unchanged, so the app behaves exactly as before. **Do not commit
weights fitted on anything but a real run** — a fitted number that means
nothing is worse than an unfitted one.

## Reading the result

Three questions, in order:

1. **Does it beat the majority baseline?** If not, the pipeline is not adding
   anything over a constant guess and nothing else matters.
2. **Is it better when the database has an exact row?** If not, retrieval is
   not reaching the model, and that is a retrieval bug, not a prompt problem.
3. **Is the confidence honest?** A large calibration error means the number on
   screen cannot be read literally. That is what step 6 fixes.

## Generated files

`eval/data/` is gitignored — it is regenerable and `visible.json` is several
megabytes. Delete `eval/data/results.jsonl` to force a clean re-run.
