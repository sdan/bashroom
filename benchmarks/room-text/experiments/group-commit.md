# Group commit: one materialized-head write per batch

Lane: `group-commit` · Base: `49693f3` (roomtext-current-blob-lab, current-head "B" store) · Date: 2026-07-17

## Hypothesis (pre-registered)

Committing N canonical revisions while encoding+writing the materialized head
ONCE per batch cuts head-write amplification ~Nx for bursty multi-writer load,
with single-push latency unchanged (within +/-10%).

**Decision rule:** `supports` iff amplification reduction >= 3x at batch >= 4
AND batch=1 latency within +/-10% of baseline AND all convergence oracles pass.

## Verdict: SUPPORTS — rule passed in all 4 headline passes

- Amplification reduction at batch 4/16/64: exactly **4.0x / 16.0x / 64.0x**
  (counter-verified, all passes).
- batch=1 p50 latency ratio vs baseline: **0.914, 1.033, 1.045, 1.033** — all
  inside 0.9–1.1.
- All convergence oracles passed: byte-exact cross-arm heads, digest
  self-verification, stale-writer batch-vs-sequential equality, per-push
  failure isolation, all-or-nothing crash rollback, plus the full existing
  blast/blast-ws/adversarial suites.

## What was built

`RoomTextStore.pushTextBatch(inputs)` (src/room-text-store.ts): loops the
pushText logic inside ONE `transactionSync`, writing per push everything
pushText writes — canonical update row, idempotency record, room-commit
sequence, digest row + root log, small-column files-row head advance — but
deferring the full-document `encodeRoomText` + `room_text_heads` blob UPDATE
to a single per-file write at the batch boundary (`finalizeDeferredHead`).
Checkpoint thresholds are tracked virtually per push; the physical snapshot
blob also lands once, at the batch-final revision. A `DeferredHead` overlay
carries the in-batch document between pushes (the heads row is stale
mid-batch; the files row is not). Stays strictly synchronous — the
discipline test passes unchanged.

Seams wired in the probe worker (scripts/room-text-probe/worker.ts):
`POST /push-batch` (HTTP), and the WebSocket per-message push loop now
commits its whole outbox through `pushTextBatch` (`handlePushBatch`),
emitting the exact same discard/broadcast/replay-ack frames via a new
`fresh` flag on batch results. `GET /write-stats` exposes monotonic
full-document blob-write counters (`roomTextStoreWriteStats`) — the
measurement's ground truth.

## Method

Harness: `benchmarks/room-text/group-commit.mjs` (workerd via wrangler dev,
port 8853). Five arms per pass, identical deterministic schedules of 256
dependent single-character replacements on a 420,652-byte head (constant
size, so blob accounting divides exactly): `baseline` (sequential POST
/push), `batch-1/4/16/64` (schedule chunked through POST /push-batch).
Amplification measured as head-blob bytes written per revision from the
store's counters, before/after each arm. Headline run TWICE as cold
invocations (A, B), each with 2 full passes (4 passes total). Zero network
retries in both invocations.

Atomicity note (confirmed): batch atomicity comes from the store's explicit
`transactionSync` around the whole batch — the injected SQLite trigger abort
on the deferred head UPDATE (which fires at the batch boundary) rolled back
all 8 in-flight revisions with zero fragments, and the identical batch
replayed cleanly after disarm. workerd's same-turn write coalescing sits
underneath, but rollback-on-throw is the explicit transaction's guarantee.

## Numbers

Head-blob writes per arm (256 revisions, 420,652 B head; identical in all 4 passes):

| arm      | head writes | head bytes  | bytes/revision | reduction |
|----------|------------:|------------:|---------------:|----------:|
| baseline | 256         | 107,686,912 | 420,652        | 1.0x      |
| batch-1  | 256         | 107,686,912 | 420,652        | 1.0x      |
| batch-4  | 64          | 26,921,728  | 105,163        | **4.0x**  |
| batch-16 | 16          | 6,730,432   | 26,291         | **16.0x** |
| batch-64 | 4           | 1,682,608   | 6,573          | **64.0x** |

Snapshot (checkpoint) blob writes: 2 per arm in every arm — equal cost, not
a confound.

Latency (request p50 ms; batch arms = whole-batch commit):

| pass | baseline /push | batch-1 | ratio | batch-4 | batch-16 | batch-64 | batch-64 ms/rev |
|------|---------------:|--------:|------:|--------:|---------:|---------:|----------------:|
| A0   | 5.637 | 5.154 | 0.914 | 6.211 | 10.034 | 31.178 | 0.631 |
| A1   | 4.859 | 5.018 | 1.033 | 5.834 | 10.476 | 32.865 | 0.543 |
| B0   | 5.411 | 5.653 | 1.045 | 6.127 | 10.666 | 28.342 | 0.491 |
| B1   | 5.041 | 5.208 | 1.033 | 7.915 | 10.469 | 29.664 | 0.489 |

Throughput (durable revisions/s, wall): baseline 164–196; batch-4 447–616;
batch-16 1,243–1,481; batch-64 1,584–2,046. A batch-64 commit costs ~28–33ms
total — ~5–6x one single push for 64 revisions.

Extrapolation to the lab's 3.56GB logical-head-write figure: at a realized
mean batch size of 16 that trace's head-blob traffic drops ~16x (~222MB).
The realized reduction equals the mean batch size actually formed per
event-loop turn/message, not the maximum.

## Semantic change (documented, intended)

Crash atomicity widens from per-push to per-batch: an invariant failure
mid-batch rolls back EVERY push in the batch (all-or-nothing; proven by
crash injection). Ordinary per-push rejections (bad args, stale epoch,
floor, FUTURE_REVISION, idempotency mismatch) still fail independently
without aborting siblings (proven: `["ok","ok","FUTURE_REVISION","ok","ok"]`
committed 4 of 5). Checkpoint cadence shifts slightly: the snapshot lands at
the batch-final revision instead of the mid-batch crossing revision — never
staler than baseline.

## Threats to validity

- Local workerd on a contended laptop (sibling lanes running); directional,
  not production SLOs. p50 over 256+ samples was stable; the +/-10% margin
  is ~0.5ms here.
- Blob-byte counters tick at statement execution, so a rolled-back
  transaction still counts; measurement arms had no rollbacks (verified via
  updateCount == revisions and zero retries).
- Counters are module-global per isolate; valid because one wrangler dev
  isolate served each invocation and arms ran sequentially.
- The harness retries network-level flakes (a kept-alive connection wedged
  twice in early long runs — UND_ERR_HEADERS_TIMEOUT, also on a plain /open
  in a baseline-only room, i.e. not caused by the batch path). Retries are
  idempotent by protocol design; both headline invocations recorded 0.
- batch-1 goes through the batch code path (one dedup SELECT inside the
  transaction vs pushText's two) — a fair single-push proxy, and the
  baseline arm still uses the untouched pushText.
- Latency gains at batch>=4 conflate one HTTP round trip per batch with the
  deferred head write; the amplification metric does not (counter-based).
- The adversarial suite's 4 "REPRODUCED GAP" entries are its pre-existing,
  deliberate reproductions of known janitor/HEAD-CAS gaps — unchanged by
  this prototype.

## Repro

```
node benchmarks/room-text/group-commit.mjs
```

(ports 8853/8854; full suite `npm test && npm run test:room-text-workerd`
uses 8850–8852; adversarial uses 8855+.)
