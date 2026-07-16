# r2-flush-guard: monotonic (epoch, revision) publication, proven under adversarial flush interleavings

Lane: `r2-flush-guard` · Base: `49693f3` (`roomtext-current-blob-lab`, current-head "B" store) · Date: 2026-07-17

## Hypothesis (pre-registered)

1. A monotonic (epoch, revision) guard at the R2 publication site — reject/skip any
   flush whose (epoch, revision) is not strictly newer than the last published,
   re-checked ATOMICALLY at write time (decision made against the exact HEAD body
   just read, paired with an etag CAS on that same read) — eliminates the HEAD
   regression under arbitrary flush pausing/reordering/crashing.
2. The guard alone does NOT fix the scalar `janitor:target` dropping earlier dirty
   files; that needs a durable dirty-set.

**Decision rule:** `supports` iff pre-fix repro shows the regression, post-fix shows
ZERO regressions across both runs, AND the dirty-set claim is resolved either way
with a concrete schedule.

## Method

- **Instrumentation (commit `cd0763f`, probe-only):** the probe worker's janitor
  gates become a named map so MANY concurrent flushes can be suspended at the
  artifact-PUT yield point (`/janitor/fire?pause=<id>`) and released in arbitrary
  order; the mock R2 (etag-CAS semantics) records every successful `*/HEAD` write
  with its parsed (epoch, revision) at `/janitor/r2/headlog`, so even a transient
  regression that later self-heals is caught.
- **Harness (`scripts/room-text-probe/blast-flush-guard.mjs`):** three sections
  against the REAL `RoomTextStore` on workerd:
  1. *deterministic-regression* — the exact blast-adversarial schedule (older flush
     paused after artifact PUT; newer flush publishes revision 2; older resumes).
  2. *dirty-set* — 3 files made dirty, 3 `/janitor/schedule` calls (delay 300 ms
     each, each overwriting the scalar `janitor:target`), one alarm fire.
  3. *randomized* — 1,000 seeded schedules (mulberry32), each: 2–4 checkpointed
     revisions, per stage one of {paused 45%, paused-then-crash 15%, immediate 25%,
     immediate-crash 15%} flushes; paused flushes released in a random permutation;
     then a clean quiesce flush. Assert per-key HEAD (epoch, revision) monotonicity
     over the FULL write log, and terminal R2 (HEAD manifest + decoded artifact
     snapshot) == SQLite head content and revision.
- **Fix (commit `5da380e`, the clean cutover):** `decideRoomTextPublication` +
  `parseRoomTextPublication` in `src/room-text-store.ts` (pure, synchronous —
  discipline test green). The janitor decides at WRITE time against the exact HEAD
  body it just read: `publish` only when the candidate (epoch, revision) — minted by
  the store's synchronous SQLite commit order — is strictly newer, pairing the write
  with an etag CAS on that same read (create-only when absent); equal →
  `already-visible` (no write); older → `stale-skip` (no write, floor advance kept —
  a safe no-op subsumed by the newer flush); unreadable marker → fail closed
  (`HEAD_UNREADABLE`, no write).

## Numbers

Randomized section, 1,000 schedules per run (macOS/workerd via `wrangler dev`):

| run | seed | stages | paused / paused-crash / imm / imm-crash fires | HEAD writes | regressions | schedules w/ regression | stale-skips | CAS lost | terminal mismatches | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|
| pre-fix | 101 | 3,018 | 1,358 / 447 / 771 / 442 | 2,790 | **517** | **458 / 1000 (45.8%)** | 0 | 0 | 0 | 37.0 s |
| post-fix run 1 | 201 | 2,962 | 1,330 / 464 / 739 / 429 | 1,819 | **0** | **0 / 1000** | 552 | 0 | 0 | 65.9 s |
| post-fix run 2 | 202 | 3,015 | 1,425 / 418 / 722 / 450 | 1,871 | **0** | **0 / 1000** | 584 | 0 | 0 | 60.5 s |

Deterministic regression schedule (all three server runs):

| | HEAD before release | HEAD after release | SQLite head | older-fire outcome |
|---|---|---|---|---|
| pre-fix | 1@2 | **1@1 (regressed)** | rev 2 | `headFlip: "flipped"` (backward CAS) |
| post-fix ×2 | 1@2 | **1@2** | rev 2 | `headFlip: "stale-skip"` |

Concrete pre-fix randomized example (seed 101, schedule 1): plan
`[rev1 paused, rev2 immediate, rev3 paused-crash]`, release order `[g1-0 (rev1),
g1-2 (rev3, crash)]` → HEAD log `1@1, 1@2, 1@1` — regression at index 2.

Dirty-set claim (identical pre-fix and post-fix, i.e. **with the guard in place**):
files `dirty-a, dirty-b, dirty-c` each made dirty and scheduled (3 ×
`/janitor/schedule`, delay 300 ms); only `dirty-c` (the last-scheduled) ever
flushed — `dirty-a`, `dirty-b` have NO R2 HEAD after settling. A manual
`/janitor/fire?file=dirty-a` then flushes fine (`ok: true, revision: 1`): the data
is intact in SQLite; the scalar target is what loses the flushes. **The guard does
not and cannot fix this** — those files never reach the publication site at all.

Lab's own probe (`npm run test:room-text-adversarial`) post-fix: the ordering
schedule flips to `PASS older async janitor stale-skips instead of CASing R2 HEAD
backward`; `REPRODUCED GAP scalar janitor target drops an earlier dirty file`
remains (plus the two pre-existing unrelated gaps: create-abort masked as
ALREADY_EXISTS, same-length head corruption). Unit suite: 87/87 green including the
synchronous-discipline test and 5 new guard tests.

## Verdict: **supports**

- Pre-fix repro shows the regression: deterministic 1@2 → 1@1, plus 517 regressions
  in 458/1000 randomized schedules. ✓
- Post-fix: ZERO regressions and zero terminal mismatches across both 1,000-schedule
  runs (2,000 schedules, 3,690 HEAD writes, 1,136 stale-skips exercised). ✓
- Dirty-set claim resolved with a concrete schedule: still drops 2/3 files with the
  guard in place → claim (2) confirmed; a durable dirty-set remains a separate
  need-to-have. ✓

Severity note for the graduated guard: pre-fix, a regressed HEAD is only repaired by
the NEXT flush of the same file. If the file goes quiet after the regression, R2
serves the stale revision indefinitely while SQLite has acked a newer one — the
harness's quiesce fire is why `terminal mismatches` reads 0 even pre-fix; production
has no such guaranteed quiesce flush.

## Threats to validity

- **Mock R2, not real R2.** The mock's get/put are synchronous within one DO turn,
  so the decision+CAS pair cannot interleave in-process; against real R2 the GET→PUT
  gap is real and the `onlyIf` etag CAS is what closes it — real R2 conditional-put
  semantics were not exercised here.
- **Crash model.** Injected throws never tear down the isolate; "crash" means the
  flush died mid-way, not DO process death mid-R2-request.
- **Epoch bumps not driven end-to-end.** The probe has no reset path, so the
  epoch-dominates-revision rule is unit-tested only (randomized runs stay epoch 1).
  Related edge: `stale-skip` still calls `advanceFloorAfterFlush` with its own
  revision — safe intra-epoch (no-op or subsumed), but a higher-epoch current HEAD
  would make that call return INVALID_REQUEST; unexercised.
- **Schedule mix.** The 45.8% pre-fix hit rate is a property of the harness's mode
  weights and 2–4 stage depth; other mixes would shift the rate (but any nonzero
  rate proves the bug, and post-fix zero is mix-independent for the schedules run).
- **Determinism caveat:** schedules are seed-replayable, but gate-release timing
  rides on real HTTP round-trips; identical seeds re-produce the same plan, not
  necessarily identical interleaving timestamps.

## Repro

```
SCHEDULES=1000 SEED=201 node scripts/room-text-probe/blast-flush-guard.mjs
```

Exits 0 iff zero regressions AND zero terminal mismatches (deterministic +
randomized); prints the full JSON report. Pre-fix baseline replay: check out
`cd0763f` (instrumentation without the guard) and run with `ALLOW_REGRESSIONS=1
SEED=101`. Raw run outputs: `r2-flush-guard-prefix-run.json`,
`r2-flush-guard-postfix-run{1,2}.json` in this directory. Ports: lane range
8860–8869 (harness defaults 8860/8861).
