# Measured results

First measurement of this tool's accuracy. 2026-10-11, `claude-sonnet-5-5`,
effort `high`, 240 holdout cases split by paper.

`eval/data/` is gitignored, so this file is the record.

## Headline

| | |
|---|---|
| Accuracy | **69.6%** (167/240) |
| Majority baseline | 45.0% (always "down") |
| Lift | **+24.6pt** |
| Calibration error, as stated | 20.1pt |
| Calibration error, after fitting | **3.9pt** (cross-validated) |

Scope: database plus model. The external sources (PubChem, PMC, UniProt,
LINCS, cBioPortal) are not called in the eval, so this is the floor the live
app builds on.

## Accuracy rises with database support

| Evidence available | Cases | Accuracy |
|---|---|---|
| Exact row (same drug, cell line, marker) | 9 | **88.9%** |
| Analogous only (same drug, other cell lines) | 70 | 77.1% |
| Nothing in the database | 161 | 65.2% |

The ordering is the design working. Getting here required a fix — see below.

## What the first run exposed

The first run scored 64.3% with the ordering inverted: exact matches scored
41.7%, *worse* than having nothing. Reading those twelve cases found two data
problems, both now fixed in the eval.

**The label and the question were about different experiments.** One case asks
what cisplatin does to cleaved caspase-3 in A549. The label says *down*.
Cisplatin induces apoptosis, so *up* is the obvious answer and the one the
model gave. The row's evidence reads "Pellino-1 overexpression reduces
cisplatin-induced caspase-3 cleavage" — the comparison is overexpression
versus control, not drug versus untreated.

**43% of gradeable rows (557/1286) carry a comparison context like this** in
the `condition` column: a pretreatment, an inhibitor, an overexpression. The
query now states it. Exact-match accuracy went 41.7% → 88.9%.

**56 rows record 0 µM.** Their `conc_raw` is a range such as "0-300 nM" whose
first number was taken as the dose — a parsing bug in whatever built the
database. Zero is not a treatment; those rows no longer count as gradeable.

## Where it is weak

**Increases are under-called.** Of 77 true increases the model called 42
correctly and 27 "unchanged". It is reluctant to commit to a rise.

```
           predicted
truth       up   down   none    total
up          42      8     27       77
down         1     98      9      108
none         9     19     27       55
```

**Pure mechanistic inference is the weak tier** — 56.2% over 105 cases, which
is the bulk of the set. Every tier backed by retrieved evidence beats it:

| Tier the model claimed | Cases | Accuracy |
|---|---|---|
| Similar-condition literature | 21 | 85.7% |
| DB analogous cell line | 53 | 81.1% |
| DB direct data | 5 | 80.0% |
| Indirect literature inference | 53 | 75.5% |
| Mechanistic inference | 105 | 56.2% |

**Confidence was systematically too low.** Stated 25-49% was right 63% of the
time. `lib/calibration.js` now corrects this, fitted on these results.

## The database has almost no redundancy

7,172 distinct drug/cell/marker combinations across 7,824 rows, so a
combination usually appears in one paper only. Holding that paper out removes
the only evidence: 65% of holdout cases have nothing in the database, 30% only
analogous rows, 5% an exact row.

This limits what the holdout can say about retrieval, and is why
`eval/ablation.mjs` exists — it re-runs the supported cases with the database
stripped and pairs them against the main run.

**The ablation has not been run.** The API credit ran out first. It is the
next thing to do, and it costs about $2.

## Cost

About $11 for 20 + 250 + 240 predictions.

## Reproducing

```bash
node eval/build-holdout.mjs
ANTHROPIC_API_KEY=... node eval/run-eval.mjs
node eval/score.mjs
node eval/fit-calibration.mjs
ANTHROPIC_API_KEY=... node eval/ablation.mjs   # not yet run
```

## Caveats

- One measurement, one model, one prompt. No repeat runs, so nothing here has
  an error bar.
- 240 cases means a tier with 5 or 9 cases carries no weight; read those rows
  as directional only.
- The ground truth is the database, whose own extraction accuracy has never
  been checked against the source papers. Two systematic errors turned up
  from reading twelve cases, which suggests more.
- The calibration weights are fitted on these 240 cases. They should be refit
  whenever the prompt, the model or the database changes.
