# fts5-probe: what does DO SQLite actually give us in workerd?

Lane: `fts5-probe` · base commit `49693f3` · 2026-07-17 · ports 8810-8819 (server on 8812)
Runtime: workerd via `wrangler dev` 4.102.0 (local), `compatibility_date: 2026-06-24`, macOS host.

## Pre-registered hypothesis

FTS5 (and its trigram tokenizer) is available in workerd DO SQLite and accelerates
literal substring search vs a `LIKE '%q%'` full scan.

**Decision rule (stated before running):** report availability as hard fact; if
FTS5-trigram works and gives >=5x p95 speedup on the rare-term substring query at
this corpus size, mark `supports` for the search design using it; if FTS5 is
absent, that is a clean `refutes` of the FTS5 path.

## Method

A tiny self-contained probe DO (`scripts/room-text-probe/fts5-worker.ts`, config
`fts5-wrangler.jsonc`) with `/caps`, `/reset`, `/load`, `/stats`, `/bench`
endpoints. The harness (`scripts/room-text-probe/fts5-run.mjs`) boots it on
workerd, records capability facts with exact error strings, then loads a
deterministic corpus (mulberry32 seed `0xC0FFEE`): **200 markdown-ish lowercase
docs, 1-100KB each, 11,076,628 bytes total (10.56 MiB)**, into a plain
`docs(id, content)` table and a mirrored `fts5(content, tokenize='trigram')`
table with matching rowids.

Planted terms: rare `zyxqvorn` (exactly docs 7/77/154), common `the` (all 200),
no-hit `qqvxzzqy`, and 2-char `zy` (a substring only of the rare marker) to
document the trigram 3-char minimum.

Timing is harness-side because workerd freezes clocks during synchronous
execution. Two views per engine x query cell:

- **roundtrip**: 50 single-query HTTP requests -> p50/p95 of raw round trips
  (floor: noop round trip ~1.7-2.6ms p50 — this view measures transport as much
  as the query);
- **per-query**: 16 requests of 25 back-to-back queries each; each request yields
  one sample `(elapsed - noop_batched_p50)/25`; p50/p95 over those 16 samples.
  This is the honest basis for the p95 rule when the query costs ~0.1ms.

Engines: `like` (`LIKE '%q%'` on the plain table), `fts-match`
(`MATCH '"q"'` on the trigram table), `fts-like` (`LIKE '%q%'` on the fts5
table, probing SQLite's trigram LIKE optimization). Headline suite ran twice per
server run ("pass-1"/"pass-2"), and the whole harness ran on three fresh servers.

## Availability: hard facts (exact errors)

| capability | verdict | detail |
|---|---|---|
| `sqlite_version()` | **BLOCKED** | `Error: not authorized to use function: sqlite_version at offset 7: SQLITE_ERROR` — capability probing must be try/catch, you cannot version-gate |
| FTS5, plain (`unicode61`) | **AVAILABLE** | `CREATE VIRTUAL TABLE ... USING fts5(content)` succeeds |
| FTS5, `tokenize='trigram'` | **AVAILABLE** | create, insert, `MATCH`, and the LIKE-optimization all work |
| json1 | **AVAILABLE** | `json_extract('{"a":{"b":2}}','$.a.b')` -> `2` |
| math functions | **AVAILABLE** | `sqrt(2.0)`, `pow(2,10)`, `ln(e)`, `sin(0)` all correct |
| R*Tree | **BLOCKED** | `Error: not authorized: SQLITE_AUTH` on `CREATE VIRTUAL TABLE ... USING rtree(...)` |
| fts5 shadow tables | **readable** | `SELECT SUM(LENGTH(block)) FROM docs_fts_data` works — index size is observable |

## Numbers

Storage cost of the trigram index (from `/stats` after full load):
content 11,076,628 B -> `docs_fts_data` blocks **19,723,984 B (1.78x content)**;
total `databaseSize` 42,651,648 B (both tables + fts + free pages). Bulk load of
the 10.56 MiB corpus into both tables: 0.87-1.8s across runs.

Rare-term headline (`zyxqvorn`, 3/200 docs), both official runs, per pass:

| run/pass | LIKE per-query p50/p95 (ms) | fts-match per-query p50/p95 (ms) | **per-query p95 speedup** | roundtrip p95 speedup |
|---|---|---|---|---|
| run1 pass-1 | 8.60 / 17.57 | 0.082 / 0.144 | **122.0x** | 5.65x |
| run1 pass-2 | 8.17 / 11.79 | 0.062 / 0.101 | **116.7x** | 4.06x |
| run2 pass-1 | 8.26 / 11.45 | 0.059 / 0.136 | **84.2x** | 3.82x |
| run2 pass-2 | 8.46 / 18.96 | 0.094 / 0.184 | **103.1x** | 3.10x |
| run3 pass-1 (stall) | 9.91 / 25.34 | 0.399 / 14.06 | 1.8x | 1.09x |
| run3 pass-2 | 8.16 / 9.22 | 0.068 / 0.127 | **72.6x** | 4.40x |

Match counts agreed (LIKE = fts-match = 3) in every pass. Run3 pass-1 hit an
environment stall right after corpus load — every engine's tail inflated in that
pass (LIKE p95 jumped to 25.3ms, noop roundtrip p95 to 5.9ms), so it measures the
host hiccup, not the index; reported anyway because the rule was pre-registered.

Full grid (run2 pass-1, representative):

| query | matches | LIKE per-query p50 | fts-match per-query p50 | fts-like per-query p50 |
|---|---|---|---|---|
| rare `zyxqvorn` | 3 | 8.26ms | **0.059ms** | 0.145ms |
| common `the` | 200 | 2.34ms (early-exit per row) | **0.022ms** | 3.29ms |
| no-hit `qqvxzzqy` | 0 | 9.11ms (full scan, no early exit) | **~0.00ms** | 0.009ms |
| 2-char `zy` | LIKE: 3 | 8.37ms | **0 matches** (silent!) | 3 matches, 9.28ms (fallback scan) |

Notes the grid surfaces:

- **Trigram 3-char minimum is a silent-wrong-answer hazard**: `MATCH '"zy"'`
  returns **0 rows with no error** even though 3 docs contain `zy`. A search
  design must route queries shorter than 3 chars to LIKE (or to `LIKE` on the
  fts5 table, which stays correct by falling back to a full scan at ~LIKE speed).
- The trigram **LIKE optimization works** (`LIKE` on the fts5 table: 0.15-0.35ms
  on the rare term — index-assisted), which implies SQLite >= 3.34 even though
  `sqlite_version()` is blocked. On the all-match common term it is *slower*
  than plain LIKE (candidate retrieval + verification over all 200 rows).
- `LIKE '%q%'` over 10.56 MiB costs ~8-10ms per query when it must scan
  everything (rare/no-hit) — that is the floor the flat scan pays on every miss.

## Verdict: **supports**

**Decision rule outcome: PASS.** FTS5-trigram is available in workerd DO SQLite,
and the rare-term per-query p95 speedup was 84.2x-122.0x in both official
headline runs (>=5x required); 5 of 6 total passes landed 72.6-122.0x, and the
single sub-5x pass (1.8x) is a documented post-load host stall that inflated
both engines. Even the transport-dominated raw roundtrip p95 view reached
3.1-5.65x on non-stall passes against a ~1.8ms noop floor.

## Threats to validity

1. **Local workerd is a proxy for production DO SQLite.** The authorizer
   allowlist is shared code, but Cloudflare could gate FTS5 differently in
   production; a production smoke (one `CREATE VIRTUAL TABLE` in a deployed DO)
   should confirm before building on this.
2. **Timing is HTTP-amortized.** Per-query numbers subtract a noop floor and
   divide by 25; sub-0.1ms figures are estimates with ~±0.05ms resolution.
   Percentiles rest on 16 samples per cell — coarse tails.
3. **Synthetic lowercase ASCII corpus.** Real rooms carry mixed case and
   unicode; trigram `case_sensitive=0` folding is ASCII-oriented and could
   diverge from LIKE on non-ASCII case.
4. **Write amplification unmeasured.** Only bulk load was timed (0.87-1.8s per
   10.56 MiB). Incremental per-edit fts5 upkeep — the cost that would land on the
   RoomText write path (6.9-7.2ms p50 budget) — is the natural next lane.
5. **Index cost is corpus-dependent.** 1.78x content here; trigram-diverse prose
   may differ.
6. One shared-machine stall contaminated run3 pass-1; other lanes were running
   concurrently on adjacent ports.

## Repro

```
cd /Users/sdan/Developer/bashroom/.claude/worktrees/wf_603da1b4-8e1-2 && node scripts/room-text-probe/fts5-run.mjs
```

(Needs port 8812 free; prints capability facts, the full grid twice, and the
decision inputs. `--out results.json` optionally writes machine-readable output.)
