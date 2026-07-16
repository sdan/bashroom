# Deletion torture: adversarial deletion-heavy schedules vs. the B (current-head) store

Lane: `deletion-torture` · 2026-07-17 · commit base `49693f3` (branch `roomtext-current-blob-lab`) · ports 8840-8841

## Pre-registered hypothesis

Byte-exact convergence and exactly-once semantics survive deletion-dominated
workloads. Suspected weak spots: compaction after drastic shrink, anchors
spanning deleted regions, and multi-byte UTF-8 at deletion boundaries.

**Decision rule (stated before running):** `supports` iff zero oracle
violations across ≥2 full randomized runs (≥1k schedules each, seeds
recorded); ANY violation = `refutes` with a minimal reproducing seed+schedule.

## Verdict: **SUPPORTS** — 0 oracle violations in 2 × 2,047 schedules (seeds 4811, 9127)

Both runs completed every phase with zero violations of the oracles: final
head bytes equal an independently replayed CodeMirror mirror, every accepted
marker appears exactly once, `/digest/verify` (from-scratch rehash vs. the
maintained digest row) matches after every round, idempotent replays return
the original commit verbatim, injected crashes roll back without durable
fragments, and a full workerd process restart reproduces every head
byte-exactly with a stable room root hash.

Two behavior findings were reproduced (deliberately loud, not violations),
plus one measured quirk — see "Findings" below.

## Method

`scripts/room-text-probe/blast-deletion.mjs` drives the real `RoomTextStore`
inside workerd (wrangler dev, fixed lane ports 8840/8841) through seven
phases against one room DO:

- **A — deletion storm (randomized):** 22 rounds × 50 stale concurrent
  writers on a ~420KB head. Per round, 50-90% of writers submit single-block
  deletions (200-8,000 UTF-16 units, 5% chance of a 20-60%-of-body block)
  against the same stale base revision; the rest insert unique multi-byte
  markers at position 0. Deletion boundaries are NOT snapped to scalar
  boundaries, so some legitimately split surrogate pairs (island lines of
  emoji/CJK are seeded into the filler). Oracle per round: accepted revisions
  form a contiguous exactly-once range; canonical updates replay onto an
  independent mirror; server byteLength equals mirror UTF-8 length; accepted
  markers appear exactly once; digest verify; cold reload (cache evict) every
  4 rounds; 5 idempotent replays per round must be byte-identical to the
  original accept.
- **B — delete-all-then-retype:** 6 cycles of wipe-everything → verify empty
  head + empty-doc digest → a stale marker insert rebased over the wipe
  (exactly-once) → a stale deletion fully swallowed by the wipe → retype
  ~200-400KB in chunks → cold reload equality.
- **C — anchors vs. deleted regions:** 7 comment anchors (inside / exact /
  spanning / abutting-left / abutting-right / straddling both ways) mapped
  through a real `/push` deletion carrying `anchors`, persisted through the
  real `DocumentCollab.remapCommentAnchors`, checked against hand-computed
  expectations; plus a resolved comment (must be skipped), an out-of-range
  anchor (must clamp), and a replacement-covering-anchor case.
- **D — multi-byte boundaries:** deletions starting/ending mid-👍, inserts at
  mid-surrogate positions, a hand-crafted lone-`\ud800` insert (raw JSON
  escape so the transport can't sanitize it) — all must reject cleanly
  (unchanged doc, digest intact, requestId still usable); scalar-legal
  grapheme splits (delete only U+0301; delete half a ZWJ family) must be
  byte-exact.
- **E — injected crashes:** SQLite triggers abort the REAL transactions:
  `abort-head-update` and `abort-digest-log-insert` mid-90%-deletion, and a
  new probe trigger `abort-updates-delete` mid-HARD-compaction (after 780
  seeded deletion pushes drove `history_floor` to 385 with 384 below-floor
  rows). `/fault/state` before/after must be deepEqual; retries must succeed;
  re-fired compaction must re-export byte-identically.
- **F — 900KB → 200B shrink:** grow to ~914KB via 4 inserts, shrink to 200B
  in 2 deletions, checkpoint, measure compaction mode + version artifact,
  crash the janitor between artifact PUT and HEAD flip, re-fire, verify
  below-floor RESET carries the exact tiny head, regrow to ~914KB.
- **R — restart:** stop workerd, restart on the same persistence, verify all
  7 files byte-exact + digest-verified, room root hash unchanged, and an
  idempotent replay recorded before the restart returns the original commit.

Every randomized operation is drawn from a recorded-seed mulberry32 stream.

## Numbers

| Metric | Run 1 (seed 4811) | Run 2 (seed 9127) |
|---|---|---|
| Oracle violations | **0** | **0** |
| Randomized schedules | 2,047 | 2,047 |
| Wall time (excl. server boots) | 15.3s | 16.1s |
| Storm: accepted deletions / markers | 739 / 360 | 755 / 342 |
| Storm: clean mid-surrogate rejections | 1 | 3 |
| Storm: no-op commits (swallowed deletions) | 279 (37.8% of deletions) | 194 (25.7%) |
| Storm: refill inserts | 19 | 17 |
| Storm throughput (50 stale writers) | 255 edits/s mean (149-448/round) | 221 edits/s mean (133-391/round) |
| Storm push latency p50 / p95 (50-way concurrency) | 125 / 291 ms | 144 / 332 ms |
| Storm head size range | 11.0KB - 335KB | 23.0KB - 181KB |
| Delete-all cycles (empty-head digest verified) | 6 | 6 |
| Anchor cases exact (pure deletion) | 7/7 | 7/7 |
| UTF-8 boundary cases (4 clean rejections + 4 exact accepts) | 8/8 | 8/8 |
| Mid-deletion crash rollbacks exact | 2/2 | 2/2 |
| Mid-compaction crash: below-floor rows at crash / rollback | 384 / exact | 384 / exact |
| Compaction retry: composed rows / re-export identical | 48 / yes | 48 / yes |
| Shrink: head after / artifact composed_changes_json | 200B / 944,349B | 200B / 944,349B |
| Janitor crash: artifact kept, HEAD unflipped, re-fire recovers | yes | yes |
| Restart: files byte-exact / room root stable / replay identical | 7/7 / yes / yes | 7/7 / yes / yes |

Deletion-heavy throughput (221-255 edits/s) beats the insert-heavy baseline
(139-154 edits/s on a stable 420KB head) because deletions shrink the head
the store re-encodes per commit.

## Findings (not violations — reported loudly)

1. **Replacement-covered anchors resurrect onto new text.** A comment anchor
   fully inside a pure deletion collapses fail-closed to `start == end`
   (correct, all 7 cases exact). But an anchor fully inside a *replacement*
   (`{from, to, insert: "##"}`) maps to `[from, from+insert.length]` — it
   silently re-attaches to text it never referred to. `mapRoomTextAnchors`'s
   assoc −1/+1 spans the insertion. If "never resurrects" is the contract,
   the host needs a covered-by-replacement check (e.g. collapse when the
   original span was entirely deleted, even if the same change inserts).
   Reproduced identically in both runs (`[6,11)` through `[5,12)→"##"` maps
   to `[5,7]`).
2. **Tiny head, ~1MB artifact.** After 900KB→200B, the version artifact for
   the 200-byte snapshot carries a 944KB `composed_changes_json` (the whole
   grow-era insert history): soft compaction skips docs under 8,000 bytes
   entirely, so nothing bounds a shrunken doc's history payload until the
   floor advances. Every janitor fire until then serializes ~1MB to export a
   200B document. Deterministic (byte-identical across both runs).
3. **Swallowed deletions commit as no-op revisions.** A stale deletion whose
   range was already deleted concurrently rebases to an empty ChangeSet and
   still commits a canonical revision (`submitted.empty` is checked
   pre-rebase only). Under 50-writer deletion storms this inflated history by
   26-38% of accepted deletions — pure revision/log bloat (correct semantics,
   wasted rows, broadcast frames, and sync-window budget).

Also measured: random deletion boundaries that split surrogate pairs were
rejected cleanly every time (`INVALID_CHANGE`, no state change, requestId
reusable) — 1 and 3 occurrences at these seeds; the deterministic phase D
covers the same class exhaustively.

## Threats to validity

- Local workerd via wrangler dev; production Cloudflare latencies differ
  (throughput numbers are directional, oracle results are not).
- The mirror replays *server-canonical* updates, so it verifies convergence
  and exactly-once against the store's own rebase output; the hand-built
  expectations in phases B/C/D and the marker/guard-region invariants are the
  independent checks.
- MockR2 (probe worker) stands in for R2 in the janitor phase; etag-CAS
  semantics are emulated, not real R2.
- "Crashes" are SQLite trigger aborts / injected throws inside a live
  isolate, plus one real process restart; they do not simulate power loss
  below SQLite's durability layer.
- 50 concurrent writers share one Node client; per-push p50/p95 includes
  client-side queueing (round-level edits/s is the honest throughput figure).

## Repro

```
ROOM_TEXT_DELETION_SEED=4811 node scripts/room-text-probe/blast-deletion.mjs
```

(Run 2: `ROOM_TEXT_DELETION_SEED=9127`. Exits non-zero on any oracle
violation; full JSON report on stdout, progress on stderr. Raw reports:
`deletion-torture-run1-seed4811.raw.json`, `deletion-torture-run2-seed9127.raw.json`.)
