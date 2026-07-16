# Experiment: per-room trigram postings vs full-scan search (lane: trigram-postings)

Pre-registered experiment on branch base `49693f3` (roomtext-current-blob-lab, current-head "B" store).
Runs executed 2026-07-17 on local workerd (`wrangler dev`, port 8830), Apple Silicon macOS.

## Hypothesis (pre-registered)

Trigram postings (trigram -> file ids; intersect candidates, then verify the exact query
against current heads) cut literal-substring search p95 by >= 5x on a realistic corpus,
at < 2ms p50 per-write maintenance.

**Decision rule:** postings "supports" iff
(a) p95 speedup >= 5x on the rare term, AND
(b) per-write maintenance < 2ms p50, AND
(c) index overhead < 3x corpus size. Each leg reported separately.

## Method

- Prototype: `scripts/room-text-probe/trigram-index.ts` — one manual SQLite table
  `trigram_postings (trigram, file_id, count) PRIMARY KEY (trigram, file_id) WITHOUT ROWID`
  in the SAME DO SQLite database as the real `RoomTextStore` (no FTS5). Lowercase-normalized
  sliding-window trigrams over UTF-16 units. Strictly synchronous, same discipline as the store.
- Maintenance is **region-incremental** (the stronger variant the brief asked to attempt):
  an edit `[from, to) -> insert` touches only the trigrams inside a ±2-char window around the
  changed span; per-(trigram, file) occurrence counts make removals sound (posting row deleted
  exactly when its count reaches zero). Full-file reindex exists only as the initial build path.
- Search: intersect candidates over the query's distinct trigrams
  (`GROUP BY file_id HAVING COUNT(*) = n`), then verify the exact case-sensitive literal by
  decoding only candidate heads from `room_text_heads`. Baseline: decode + `includes()` over
  EVERY head row in the same DO (apples-to-apples).
- Corpus: deterministic (seed 1337) 200 markdown files, 10,328,646 bytes total (~50KB avg),
  ~180-word vocabulary; planted terms: rare `xylophone-ish` (3 files), common `the room`
  (176 files), no-hit `zvqxjw-absent`, regex-shaped literal prefix `roomText` (20 files,
  from `/roomText\w+\(/`).
- Load: real `createText` + 300 real sequential `pushText` edits (70% inserts of 2-5 words,
  30% deletes/replaces of 5-20 chars) through the probe worker on workerd.
- Harness: `benchmarks/room-text/trigram-postings.mjs` (port 8830). 50 timed iterations per
  (query, mode) after 3 warmups; run TWICE cold (run1, run2 JSON alongside this file).

### Measurement frames (and why there are three)

Local workerd **quantizes `performance.now()` to 1ms** (verified by `/trigram/clock`:
a 28ms busy-loop registers, but sub-ms ops read 0 or 1). Sub-ms per-op p95 cannot be read
directly inside the DO, so each leg reports:

1. **in-DO per-request integer-ms readings** (quantization-conservative bounds: a reading of
   `k` means true value < `k+1`),
2. **in-DO batched mean** (n ops timed as one block inside one request; total/n restores
   sub-ms resolution, no HTTP noise),
3. **client per-request round-trip** (includes ~2.6ms p50 / ~4ms p95 localhost HTTP overhead,
   measured via `/trigram/noop`).

The pre-registered method prescribes the DO-internal frame ("full scan over the same heads in
the same DO"), so legs are judged on frames 1+2; frame 3 is disclosed in full because the raw
client ratio for the rare term straddled the threshold across runs (3.6x / 6.5x) — that
variance is transport jitter on a 0.2ms operation, not search compute.

## Numbers

### Leg (a): search — rare term `xylophone-ish` (3 matches / 200 files)

| measure | run 1 | run 2 |
|---|---|---|
| scan in-DO p95 (per-request) | 21ms | 23ms |
| postings in-DO p95 (per-request) | 1ms (=> true < 2ms) | 1ms (=> true < 2ms) |
| **p95 speedup, quantization-conservative bound** | **>= 10.5x** | **>= 11.5x** |
| scan in-DO batched mean (n=20) | 10.65ms | 11.50ms |
| postings in-DO batched mean (n=200) | 0.215ms | 0.185ms |
| **mean speedup (batched)** | **49.5x** | **62.2x** |
| client p95 raw (incl. HTTP) | 29.9ms vs 8.3ms = 3.6x | 32.8ms vs 5.1ms = 6.5x |
| bytes examined | 10.33MB scan vs 0.14MB verify | same |

**Leg (a): PASS both runs** in the DO-internal frame (bound >= 10.5x; means ~50-60x).
Raw client-frame ratio fails in run 1 (3.6x) and passes in run 2 (6.5x) — see frames note.

### All queries (in-DO batched means, ms/op)

| query | matches | candidates | scan run1/run2 | postings run1/run2 | speedup run1/run2 |
|---|---|---|---|---|---|
| rare `xylophone-ish` | 3 | 3 | 10.65 / 11.50 | 0.215 / 0.185 | 49.5x / 62.2x |
| no-hit `zvqxjw-absent` | 0 | 0 | 10.70 / 5.15 | 0.250 / 0.055 | 42.8x / 93.6x |
| prefix `roomText` | 20 | 20 | 12.40 / 22.05 | 1.070 / 1.290 | 11.6x / 17.1x |
| common `the room` | 176 | 200 | 6.80 / 12.25 | 11.285 / 10.615 | 0.6x / 1.2x |

Common terms get **no win** (candidates = all 200 files, so verification decodes the whole
corpus anyway — expected and inherent to postings; selective queries are the payoff).

### Leg (b): per-write maintenance (region-incremental, 300 real edits)

| measure | run 1 | run 2 |
|---|---|---|
| in-DO batched mean (300 apply+inverse ops, net-zero verified) | 0.633ms | 0.207ms |
| client p50 minus noop p50 | 1.60ms | 1.05ms |
| client p50 raw (incl. HTTP) | 4.20ms | 3.16ms |
| in-DO per-request p95 (quantized) | 2ms | 1ms |
| trigrams touched per edit p50/p95 | 24 / 38 | 24 / 38 |

**Leg (b): PASS both runs** — both pre-committed measures (< 2ms) agree in both runs.

### Leg (c): index size overhead — THE FAT-INDEX NUMBER, READ THIS ONE

| measure | value (identical both runs — deterministic corpus) |
|---|---|
| corpus | 200 files, 10,328,646 bytes |
| posting rows | 286,129 (avg 1,431 distinct trigrams/file) |
| index bytes (databaseSize delta across build) | 4,653,056 |
| **overhead ratio** | **0.45x** |
| bytes per posting row (incl. btree overhead) | 16.26 |
| full-build cost | 14.4s / 8.6s total; per-file in-DO p50 26ms |

**Leg (c): PASS on this corpus — but it is the fragile leg.** The synthetic ~180-word
vocabulary saturates trigram diversity at ~28 distinct trigrams/KB on 50KB files. Real
markdown measured from this repo runs 111/KB for one 73KB concatenation (=> ~1.76x est.)
and 200-310/KB for real 7-26KB files (=> **~3.3-5.0x est. for rooms of small files**, above
the 3x threshold). Overhead is a function of the room's file-size mix: large files amortize
trigram diversity, small ones do not.

## Verdict: SUPPORTS (all three legs pass, both runs)

- (a) rare-term p95 speedup >= 5x: **PASS** (>= 10.5x bound; ~50-60x batched mean) — judged
  in the DO-internal frame; raw client-HTTP frame straddled 5x across runs (3.6x / 6.5x).
- (b) maintenance p50 < 2ms: **PASS** (0.21-0.63ms in-DO mean; 1.05-1.60ms adjusted client p50).
- (c) index overhead < 3x: **PASS on the pre-registered corpus** (0.45x) — with the explicit
  caveat that realistic small-file markdown plausibly lands at 1.8-5x depending on size mix.

## Threats to validity

1. **Baseline understates the real win** (noted in the brief): production full-scan search is
   R2-GET-bound (today's search scans R2 objects, 8-20 per room in parallel); this experiment's
   DO-internal scan over hot SQLite heads is the FASTEST possible baseline. Real-world speedup
   would be larger than every number above.
2. **Corpus vocabulary is synthetic and small** — leg (c)'s 0.45x is corpus-flattering (see
   leg (c) notes; real-markdown estimates 1.8-5x). Leg (a) is corpus-robust (candidate
   selectivity, not trigram diversity, drives it); leg (b) touches only edit-window trigrams
   and is corpus-insensitive.
3. **Timer quantization**: workerd rounds `performance.now()` to 1ms; sub-ms p95s are reported
   as bounds plus batched means rather than exact per-op distributions.
4. **Maintenance excludes window slicing** (~26-char string slices the host would compute from
   its cached doc — negligible) and was measured on sequential, non-rebased pushes; a rebased
   push would need the CANONICAL (rebased) changes' windows, which the store already returns
   (`update.changes`), but that path was not exercised.
5. **Short file ids** (`f001`-style, 4 chars) keep posting rows small; production file ids are
   longer (each extra id byte adds ~0.28MB per 286k rows here). An integer-fileid mapping
   table would remove this sensitivity.
6. **No file-delete path** was tested (the store has none yet); whole-file removal would want
   a `file_id` index or a lazy sweep, not counted in the size overhead above.
7. Single machine, local workerd; absolute times will differ in production DOs, ratios should
   be more stable.

## Repro

```
node benchmarks/room-text/trigram-postings.mjs --out /tmp/trigram-postings-repro.json
```

(from repo root; needs `npm install` done; owns port 8830; ~2-4 minutes; asserts result-set
parity postings==scan on every query, incremental-vs-recount equality on 10 files, and prints
the per-leg decision to stderr.)

Smoke variant for wiring checks only: `TRIGRAM_SMOKE=1 node benchmarks/room-text/trigram-postings.mjs`.

## Files

- `scripts/room-text-probe/trigram-index.ts` — the prototype (index + search + verify).
- `scripts/room-text-probe/worker.ts` — `/trigram/*` probe endpoints (build, apply,
  apply-pairs, search, search-batch, verify, stats, clock, noop).
- `benchmarks/room-text/trigram-postings.mjs` — harness.
- `trigram-postings-run1.json`, `trigram-postings-run2.json` — full raw results.
- `trigram-postings.json` — machine-readable summary of both runs + decision.
