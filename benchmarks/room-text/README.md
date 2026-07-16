# RoomText benchmarks

Reproducible comparisons for Bashroom's Durable Object-native text authority.
Benchmark dependencies are isolated here because the JSON Joy CRDT and local
Liveblocks server are AGPL; neither is part of the production Worker bundle.

The suite deliberately has separate scoreboards:

1. `benchmark.ts` — synthetic in-process mutation, stale reconciliation,
   snapshots, and codecs on identical fixtures.
2. `trace-benchmark.ts` — real sequential editing histories replayed through
   fresh Bashroom and JSON Joy models with exact-byte verification.
3. `workerd-benchmark.mjs` — Bashroom HTTP → Durable Object → SQLite durable
   acknowledgement and cold recovery.
4. `realistic-workerd.mjs` — self-contained B-only workerd stress: a measured
   19-DO fleet plus a deliberately concentrated 679-file worst-case DO, pinned
   editing-trace transactions on 8/100/900 KB documents, foreign interleavings,
   protocol-faithful offline backlog drain, retries, cache clears, and process-
   restart recovery.
5. `liveblocks-local.mjs` — Liveblocks/Yjs writer → local sync server → observer
   visibility and reconnect. This is not a durable-ack measurement.

## Install and run

```bash
cd benchmarks/room-text
npm install
npm run bench
npm run bench:liveblocks
npm run bench:workerd-realistic:smoke
```

The realistic workerd driver starts Wrangler itself with a fresh persistence
directory, stops and restarts the process against that same SQLite state, and
writes every raw request sample to a JSON file (printed as `rawResultPath`).
The default `medium` profile reproduces all 679 supported files from the
measured 680-file, 19-room corpus—the >1 MB file is explicitly skipped—in both
fleet-shaped and single-DO stress topologies, then replays 256 real trace
transactions at each document size. Contents are deterministic fixtures, not
private room text. Use the smoke command above for a fast correctness run, or
the full pinned trace for an intensive run:

```bash
ROOM_TEXT_REALISTIC_PROFILE=full npm run bench:workerd-realistic
ROOM_TEXT_REALISTIC_TRACE_LIMIT=1523 \
ROOM_TEXT_REALISTIC_REPEATS=3 \
ROOM_TEXT_REALISTIC_RESULT_PATH=/tmp/room-text-realistic.json \
  npm run bench:workerd-realistic
```

Individual controls are `ROOM_TEXT_REALISTIC_SIZES`, `..._ROOM_SCALE`,
`..._BACKLOG_DEPTH`, `..._CACHE_EVERY`, `..._RETRY_EVERY`,
`..._FOREIGN_EVERY`, `..._PRESSURE_UPDATES`, `..._PRESSURE_SWEEP_EVERY`,
`..._PRESSURE_BURST`, and `..._ROOM_CONCURRENCY`. These are local workerd
measurements, not production-region SLOs. The existing probe exposes only
per-file commits, so neither topology phase pretends to exercise an
atomic multi-file shell commit.

The workerd benchmark needs the isolated probe running in another terminal:

```bash
# repository root, terminal 1
npx wrangler dev -c scripts/room-text-probe/wrangler.jsonc \
  --port 8792 --persist-to /tmp/bashroom-room-text-probe

# terminal 2
node scripts/room-text-probe/blast.mjs
cd benchmarks/room-text
npm run bench:workerd -- http://localhost:8792
```

For the correctness probe alone, the repository also has a one-command runner
that chooses a free port and fresh temporary SQLite directory:

```bash
npm run test:room-text-workerd
npm run test:room-text-adversarial
```

The adversarial command uses fixed, probe-only SQLite triggers and R2 gates.
It prints `PASS` for preserved invariants and `REPRODUCED GAP` for a known bug;
reproduced gaps are successful experiments, not claims that the system passed.
Unexpected behavior still exits nonzero.

The blast script is the correctness gate. It covers 50-way stale concurrency,
50 identical retries, cache eviction, exact checkpoint recovery, the maximum
escaped request row, automatic checkpoints, and the stale-client reset bound.
It also drives 640 revisions to verify that canonical updates, idempotency
pointers, and orphaned room commits prune at the same history floor.

## Pinned systems

| System | Version | License in this benchmark | Role |
| --- | ---: | --- | --- |
| CodeMirror state/collab | 6.7.1 / 6.1.1 | MIT | Bashroom `Text`, `ChangeSet`, central rebase |
| Yjs | 13.6.31 | MIT | CRDT algorithm baseline |
| JSON Joy | 18.28.0 | AGPL-3.0-only | JSON CRDT baseline |
| JSON Joy json-pack | 18.28.0 | Apache-2.0 | JSON/CBOR/MessagePack codecs |
| Liveblocks client/Yjs | 3.22.0 | Apache-2.0 | Client/provider path |
| Liveblocks dev server | 1.6.2 | AGPL-3.0-or-later | Local persisted sync server |
| Editing traces | `71c6d73` | Dataset-specific; `friendsforever` is CC BY 4.0 | Real sequential edit histories |

Do not collapse these measurements into one ranking. JSON Joy's published
[codec benchmark](https://jsonjoy.com/blog/json-codec-benchmarks/) measures
serialization, not transformation or persistence. Liveblocks' text path uses
Yjs, so its meaningful extra measurement is the server/network path.

## Real editing traces

The in-process suite replays the same seven sequential histories used by JSON
Joy, pinned to the exact upstream corpus revision. It loads and decompresses
fixtures before timing, starts every sample with a fresh model, preserves each
trace transaction's sequential patch semantics, and rejects a run unless its
final string and UTF-8 bytes exactly match the corpus oracle.

The default is seven full replays per engine and trace. Override that only for
quick checks or upstream-style repetition:

```bash
ROOM_TEXT_TRACE_SAMPLES=1 npm run bench:traces  # correctness smoke
ROOM_TEXT_TRACE_SAMPLES=50 npm run bench:traces # upstream repetition count
```

Trace throughput remains an in-memory algorithm measurement. It does not
include SQLite persistence, Durable Object scheduling, or observer fanout.
