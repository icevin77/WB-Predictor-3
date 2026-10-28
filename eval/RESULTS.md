# Measured results

Two runs. The second corrects a measured direction bias; everything else is
identical. 2026-10-11 and 2026-10-28, `claude-sonnet-5-5`, effort `high`,
240 holdout cases split by paper.

`eval/data/` is gitignored, so this file is the record.

## Headline

| | before | after |
|---|---|---|
| Accuracy | 70.2% | **75.6%** |
| Majority baseline | 45.0% | 45.0% |
| Lift | +25.2pt | **+30.6pt** |
| Calibration error, as stated | 20.1pt | 22.6pt |
| Calibration error, after fitting | 3.9pt | **1.4pt** |

Compared on the 238 cases both runs answered.

## What the prompt change did

The first run over-called "down" and under-called "up": of 75 markers that
rose it named 42, and called 25 of them "unchanged". The prompt now names that
bias, lists the marker classes that rise (cleavage products from near zero,
damage and stress markers, phospho-epitopes whose kinase is activated), and
says "none" is a prediction rather than a way to avoid choosing.

| | before | after | |
|---|---|---|---|
| truth is up | 56.0% | **66.7%** | +10.7pt |
| truth is down | 90.7% | **95.4%** | +4.6pt |
| truth is unchanged | 49.1% | 49.1% | — |
| exact DB row | 88.9% | 88.9% | — |
| analogous rows only | 77.1% | **82.9%** | +5.7pt |
| nothing in the DB | 66.0% | **71.7%** | +5.7pt |

Calling a rise "unchanged" dropped from 25 to 16. Pushing toward "up" did not
cost anything on "down", which was the risk — it improved there too.

The gain lands where there is no database support, which is where the bias was
doing the most damage. Pure mechanistic inference went 56.2% to 68.8%.

**"Unchanged" did not move and is now the weak class at 49.1%.** It is the
next thing to work on.

Scope: database plus model. The external sources (PubChem, PMC, UniProt,
LINCS, cBioPortal) are not called in the eval, so this is the floor the live
app builds on.

## Accuracy rises with database support

| Evidence available | Cases | Accuracy |
|---|---|---|
| Exact row (same drug, cell line, marker) | 9 | **88.9%** |
| Analogous only (same drug, other cell lines) | 70 | 82.9% |
| Nothing in the database | 159 | 71.7% |

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

**"Unchanged" is now the weak class**, at 49.1%. Of 55 true no-change cases,
20 were called "down". The increase bias is corrected; this one is not.

```
           predicted
truth       up   down   none    total
up          50      9     16       75
down         1    103      4      108
none         8     20     27       55
```

**Pure mechanistic inference is still the weak tier**, though it moved most:
56.2% to 68.8% over 109 cases, the bulk of the set.

| Tier the model claimed | Cases | Accuracy |
|---|---|---|
| Similar-condition literature | 29 | 86.2% |
| DB analogous cell line | 56 | 82.1% |
| DB direct data | 5 | 80.0% |
| Indirect literature inference | 36 | 75.0% |
| Mechanistic inference | 109 | 68.8% |

**Confidence is systematically too low**, and more so after the prompt change:
a stated 25-49% is right 74.7% of the time. `lib/calibration.js` corrects it,
refitted on the second run — cross-validated error 1.4pt, Brier 0.185.

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

About $16 for 20 + 250 + 240 + 240 predictions.

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
