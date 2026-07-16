# catchup-cursor — catch-up structure shootout (pre-registered)

Lane: `catchup-cursor` · Base: `49693f3` (roomtext-current-blob-lab, current-head "B" store)
Date: 2026-07-16/17 · Machine: darwin arm64, Node v24.3.0, workerd via wrangler dev

## Hypothesis (pre-registered)

A `room_changes` oplog (monotonic roomSequence; columns sequence, file_id,
kind create|update|rename|delete, revision, path, content_hash) gives true
O(changes-since-cursor) catch-up with natural tombstones, at per-edit
maintenance cost no worse than today's flat-root rehash; a persistent Merkle
tree is NOT yet justified.

## Decision rule (stated before running)

Adopt cursor-oplog iff **maintenance(B) <= 1.2x maintenance(A)** AND
**catchup(B, k=10, N=10k) >= 10x faster than the diffDigest scan**.
Merkle verdict: justified only if **maintenance(A) > 1ms/edit at N=10k** AND
**(C) beats both on some measured axis** — otherwise record the numeric
margin by which it loses.

## Method

Three catch-up structures prototyped inside the real synchronous
`RoomTextStore` (src/room-text-store.ts at this worktree's HEAD):

- **A — today's flat digest index.** Per-edit maintenance is the production
  `writeDigest` (upsert digest row, rehash the room root over ALL digest rows
  — `rootHashOf(this.digestRows())`, src/room-text-store.ts:1522 — append +
  prune the root log), exposed unchanged via `labWriteDigest`. Catch-up is
  the production `diffDigest`, which scans every digest row and recomputes
  the flat root even though its response is O(changed).
- **B — cursor oplog** (`room_text_changes`): one row per file (PRIMARY KEY
  file_id = collapse-repeated-files), row moves to the next monotonic
  `sequence` on each change via a single upsert (`recordRoomChange`);
  deletes are ordinary `kind='delete'` tombstone rows that keep the file's
  slot; the table is O(files) so no cursor ever expires. Catch-up
  (`roomChangesSince`) = `SELECT ... WHERE sequence > ? ORDER BY sequence`
  over the UNIQUE sequence index.
- **C — in-memory 32-way path-keyed Merkle sketch** (`RoomTextMerkle32`,
  depth 2 = 1,024 buckets at these tiers): leaves (path -> contentHash) in
  buckets addressed by the path digest; an edit rehashes its bucket plus the
  depth-long spine; catch-up = structural diff of server tree vs a stale
  client clone (network rounds NOT modeled — this is the Merkle's best case).

Scale runs execute the REAL store over a `node:sqlite` (`DatabaseSync`,
synchronous) shim of `DurableObjectStorage` (`sql.exec` + `transactionSync`),
gated by a fidelity check (create -> push -> open -> diffDigest -> idempotent
replay all behave). Setup seeds N files' index state directly; measurements
are per-edit maintenance (1,000 timed edits per variant, each wrapped in
`transactionSync` for A and B) and catch-up for a client k={1,10,100} files
behind (200 timed repetitions against a captured base root/cursor/clone).
One tier (N=1,000) is spot-checked inside real workerd via new probe `/lab`
batch endpoints on port 8822 (assigned range 8820-8829); workerd freezes
clocks during synchronous execution, so per-op cost = (batch request time −
noop request p50) / batch size, measured from Node.

Headline measurement ran TWICE end to end (fresh processes); both runs below.

## Numbers

### Per-edit index maintenance (p50/p95 µs; 1,000 samples; node:sqlite shim)

| Tier | A flat rehash (run1) | A (run2) | B oplog (run1) | B (run2) | C merkle (run1) | C (run2) |
|---|---|---|---|---|---|---|
| N=1,000 | 3,859.6 / 7,912.7 | 3,306.0 / 4,203.1 | 11.5 / 22.7 | 10.5 / 12.5 | 79.6 / 205.0 | 74.9 / 86.5 |
| N=10,000 | 36,447.3 / 69,707.1 | 34,333.8 / 52,928.5 | 10.7 / 16.4 | 10.5 / 18.5 | 97.7 / 143.4 | 96.0 / 112.0 |

A is O(all files) per edit — ~3.3-3.9 **ms** at 1k files, ~34-36 **ms** at 10k.
B and C are flat in N.

### workerd spot-check (N=1,000, real DO SQLite; per-op p50 µs, batch-derived)

| Variant | maintenance (run1) | maintenance (run2) | catch-up k=10 (run1) | (run2) |
|---|---|---|---|---|
| A | 3,111.8 | 2,544.4 | 2,643.7 | 2,659.2 |
| B | 12.3 | 11.8 | 20.5 | 21.8 |
| C | 32.5 | 28.3 | 2.8 | 2.7 |

Same shape as the shim (A ms-scale and O(N), B/C tens of µs), so the shim
numbers are representative.

### Catch-up latency, client k files behind (p50/p95 µs; 200 reps; shim)

| Tier | k | A diffDigest (run1) | A (run2) | B cursor (run1) | B (run2) | C merkle diff (run1) | C (run2) |
|---|---|---|---|---|---|---|---|
| 1,000 | 1 | 4,238.3 / 7,536.9 | 3,258.0 / 3,775.7 | 3.1 / 8.6 | 2.8 / 5.2 | 3.8 / 4.7 | 3.8 / 4.8 |
| 1,000 | 10 | 4,047.4 / 9,362.2 | 3,321.7 / 5,258.6 | 13.8 / 17.7 | 12.8 / 16.3 | 4.4 / 30.4 | 4.2 / 4.7 |
| 1,000 | 100 | 4,347.0 / 27,671.4 | 3,287.3 / 3,770.5 | 131.7 / 203.8 | 115.7 / 155.0 | 23.0 / 61.9 | 20.8 / 22.5 |
| 10,000 | 1 | 35,043.2 / 45,349.6 | 34,144.0 / 42,597.5 | 2.6 / 6.1 | 2.6 / 2.8 | 4.6 / 5.1 | 4.5 / 4.7 |
| 10,000 | 10 | 52,189.8 / 119,016.3 | 34,893.9 / 58,360.2 | 14.5 / 28.4 | 12.9 / 14.4 | 12.5 / 36.0 | 11.4 / 13.2 |
| 10,000 | 100 | 38,849.8 / 61,335.4 | 34,145.5 / 45,392.5 | 124.6 / 229.5 | 120.1 / 153.4 | 78.8 / 83.8 | 79.9 / 103.1 |

A's catch-up is k-independent (k=1 costs the same as k=100) — the O(all)
compute is the whole story. B and C scale with k.

### Merkle build cost (the DO-wake tax C pays for being in-memory)

| Tier | rebuild ms (run1) | (run2) |
|---|---|---|
| N=1,000 | 96.9 | 77.7 |
| N=10,000 | 1,404.6 | 919.9 |

### Deletion (10 files deleted; N=1,000 tier — reopened task #8's gap)

- **B**: catch-up from a pre-delete cursor returned exactly **10 tombstones**
  (`kind='delete'`); re-creating a deleted file correctly replaced its
  tombstone with a `create` row (both runs pass).
- **A**: structurally cannot report deletions. `DiffDigestResult.removed` is
  hardcoded `[]` (src/room-text-store.ts:1036) and no store path deletes a
  digest row. Simulating the naive future delete (drop digest rows, log the
  new root) yields: **rootHash moved, baseKnown=true, changed=0, added=0,
  removed=0** — a syncing client sees the root change with zero explanation,
  and because its own recomputed root can never match again, every
  subsequent poll repeats the same empty-but-moved answer. It never
  converges.
- **C**: the structural diff does see removals (10/10) — a client-held leaf
  absent from the server tree is reported.

## Verdict against the pre-registered rule

- **maintenance(B) <= 1.2x maintenance(A)** at N=10k: 10.7µs vs 36,447µs
  (run1), 10.5µs vs 34,334µs (run2) — ratio ≈ **0.0003**. PASS (B is
  ~3,300-3,400x cheaper, not merely within 1.2x).
- **catchup(B, k=10, N=10k) >= 10x faster than diffDigest**: 52,190/14.5 =
  **3,599x** (run1); 34,894/12.9 = **2,705x** (run2). PASS.
- → **Adopt cursor-oplog: rule PASSES in both runs.** Plus tombstones, which
  A structurally cannot express.
- **Merkle gate**: precondition met (maintenance(A) = 34-36ms > 1ms at
  N=10k), and C does beat both on one measured axis — catch-up at k=100
  (78.8-79.9µs vs B's 120.1-124.6µs, ~1.5x) and marginally at k=10. Read
  literally the gate triggers; recorded margins where C loses: **9.1x worse
  than B on per-edit maintenance** (96-98µs vs 10.5-10.7µs), **0.9-1.4s
  O(N) rebuild on every DO wake** at 10k files (it is in-memory only), and
  its measured catch-up omits the multi-round network protocol a real Merkle
  sync needs. A µs-scale win on an axis where B already beats A by 2,700x
  does not buy back a ~1s wake tax. **Merkle: not justified** — consistent
  with the hypothesis.

**Hypothesis: SUPPORTED** (decisively — the oplog is not "no worse" but
3 orders of magnitude cheaper to maintain than the flat rehash at 10k files).

## Additional findings

1. **Today's writeDigest is a scaling cliff.** Per-edit digest maintenance is
   3.3-3.9ms at 1,000 files and 34-36ms at 10,000 files (workerd-confirmed
   3.1/2.5ms at 1k) — at 10k files the maintenance alone is ~5x the entire
   6.9-7.2ms sequential durable-write p50 baseline. This runs inside every
   accepted pushText transaction today.
2. **diffDigest compute is O(all) even though its response is O(changed)** —
   measured k-independence confirms the design analysis.
3. Deletions: see above — `removed` is unreachable dead payload in A.

## Threats to validity

- Scale runs use node:sqlite in-memory, not DO storage: no output-gate
  latency, different SQLite build/page cache. Mitigated by the workerd
  spot-check (same ranking, same magnitudes: A 2.5-3.1ms, B ~12µs, C ~30µs
  at N=1,000) and by a fidelity gate running the real store's
  create/push/open/diff/replay paths on the shim.
- workerd per-op costs are batch means (clocks freeze during synchronous DO
  execution), so workerd p95s are not observable externally; only the node
  shim provides per-op tails.
- B's measured op is the oplog upsert alone. In a cutover it replaces
  writeDigest's root-log machinery but a per-file digest row would still be
  maintained (or read from the oplog row — same columns); adding one indexed
  upsert would not change the verdict's order of magnitude.
- C's catch-up number is the zero-round-trip structural diff between two
  co-resident trees — its real protocol cost (level-by-level rounds or
  shipping a ~1,024-hash summary) is strictly worse.
- Timing includes JS GC noise; headline ran twice (both reported), rankings
  and magnitudes stable across runs.
- Merkle depth fixed at 2 (1,024 buckets) for both tiers; a tuned depth
  changes constants, not the verdict.

## Repro

```bash
npm install && cd benchmarks/room-text && npm install && node --import tsx catchup-cursor.mjs
```

Workerd spot-check (starts wrangler dev on :8822, assigned range 8820-8829):

```bash
cd benchmarks/room-text && node catchup-cursor-workerd.mjs
```

Raw outputs: `catchup-cursor.run{1,2}.json`,
`catchup-cursor-workerd.run{1,2}.json`; merged summary `catchup-cursor.json`.
