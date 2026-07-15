# RoomText benchmark results

Synthetic and persisted cases were measured 2026-07-14; real editing traces
were measured 2026-07-15. The machine was an Apple M1 Max running macOS arm64
and Node 24.3.0. Packages and commands are pinned in this directory. Values are
local-development numbers, not Cloudflare production-region claims.

## Correctness first

The workerd probe passed:

- 50 concurrent edits all submitted from revision 0 → unique revisions 1–50;
- 50 redeliveries of one request → one durable update and identical responses;
- exact cold replay before and after checkpointing;
- a 262,144-byte control-character paste, whose JSON escaping previously found
  a real SQLite row-overflow bug;
- automatic checkpoint at revision 256; and
- an explicit `RESET_REQUIRED` beyond the 256-update stale window; and
- at revision 640, atomic retention advanced the floor to 257 and kept 384
  canonical updates plus their matching retry pointers.

## In-process text work

One operation alternates a one-code-unit insertion/deletion. Stateful engines
are recreated for each sample and run for a fixed 20,000-edit session.

| Approx. document | Bashroom validated edit/s | Yjs local edit/s | JSON Joy local edit/s |
| ---: | ---: | ---: | ---: |
| 10 KB | 362,942 | 221,056 | 2,115,162 |
| 100 KB | 611,894 | 292,216 | 2,764,451 |
| 999 KB | 377,302 | 280,779 | 3,254,304 |

JSON Joy is the fastest local mutation engine in this workload. Bashroom is
still hundreds of thousands of transforms per second because a small edit
changes an immutable `Text` tree rather than copying the whole string.

## Real editing traces

Seven full samples per engine replayed JSON Joy's pinned sequential-editing
corpus from a fresh model. Final materialization is timed; loading fixtures,
SQLite, networking, and binary snapshot encoding are not. Every sample matched
the corpus's exact final string and UTF-8 bytes.

| Trace | Transactions | Final bytes | Bashroom median | Bashroom tx/s | JSON Joy median | JSON Joy tx/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `friendsforever_flat` | 1,523 | 21,362 | 18.6 ms | 81,816 | 5.5 ms | 278,277 |
| `sveltecomponent` | 18,335 | 18,451 | 80.1 ms | 228,934 | 47.5 ms | 386,006 |
| `rustcode` | 36,981 | 65,218 | 182.4 ms | 202,717 | 45.9 ms | 806,096 |
| `seph-blog1` | 137,154 | 56,769 | 481.4 ms | 284,934 | 52.8 ms | 2,598,448 |
| `automerge-paper` | 259,778 | 104,852 | 655.3 ms | 396,412 | 184.2 ms | 1,410,276 |
| `json-crdt-patch` | 18,639 | 49,352 | 77.4 ms | 240,735 | 20.4 ms | 915,535 |
| `json-crdt-blog-post` | 21,411 | 31,548 | 69.9 ms | 306,099 | 17.2 ms | 1,241,982 |

JSON Joy remains faster at direct in-memory mutation. RoomText nevertheless
replays realistic histories at 82k–396k transactions/s while performing its
public range and exact-byte validation. This table is an algorithm comparison,
not a claim about Durable Object request throughput; the persisted workerd
results below remain the server-shaped measurement.

Stale-work trend (different algorithms, so this is scaling evidence rather
than identical semantics):

| Lag | Bashroom rebase + apply/s | Yjs merge-updates/s |
| ---: | ---: | ---: |
| 8 | 639,806 | 151,170 |
| 32 | 312,560 | 35,077 |
| 128 | 101,068 | 4,118 |
| 512 | 24,170 | 258 |

Production RoomText resets rather than rebasing beyond 256 updates or a 1 MB
serialized tail. Lag 512 remains in the algorithm benchmark to make the curve
visible.

The physical collaboration log is also bounded: checkpoint pruning targets
384 retained updates or 8 MB. Because checkpoints are at most 128 edits apart,
the update table stays below 512 rows per file between pruning passes. This is
live-sync retention, not the future user-visible file-version product.

## Snapshots and payloads

| Approx. document | Plain UTF-8 | Yjs snapshot | JSON Joy snapshot | Bashroom snapshot/s | Yjs snapshot/s | JSON Joy snapshot/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 KB | 10,002 B | 10,019 B | 10,025 B | 17,795 | 29,440 | 59,931 |
| 100 KB | 100,002 B | 100,021 B | 100,031 B | 1,632 | 3,295 | 6,462 |
| 999 KB | 999,002 B | 999,021 B | 999,031 B | 176 | 348 | 658 |

Incremental one-character payloads were 16–18 bytes for Bashroom's internal
ChangeSet JSON, 25–26 bytes for Yjs, and 13–14 bytes for JSON Joy. Transport
envelopes add file/revision/idempotency metadata in every design.

## JSON Joy codec comparison

The identical Bashroom update envelope was 229 bytes as UTF-8 JSON, 194 bytes
as CBOR, and 188 bytes as MessagePack.

| Codec phase | Throughput |
| --- | ---: |
| Native `JSON.stringify` + UTF-8 | 716,456/s |
| JSON Joy CBOR encode | 1,271,630/s |
| JSON Joy MessagePack encode | 1,180,290/s |
| UTF-8 decode + `JSON.parse` | 898,014/s |
| JSON Joy CBOR decode | 1,368,414/s |
| JSON Joy MessagePack decode | 1,444,320/s |

Codec time is below 2 microseconds per update and therefore is not the system
bottleneck. Saving 35–41 bytes does not justify adding a binary protocol yet;
readable JSON is the simpler v1 wire format.

## Persisted local systems

Bashroom workerd, median of three 50-writer burst runs:

| Measurement | Result |
| --- | ---: |
| Sequential durable ack | about 2.8 ms p50, 4–6 ms p95 |
| 50 stale writers | 840 accepted durable edits/s (range 741–910) |
| Cold replay of 122-update tail | 2.8–3.1 ms |
| Cold open from current snapshot | 1.8–2.3 ms |

Liveblocks local dev server with Yjs and its minimum public 16 ms throttle:

| Measurement | Result |
| --- | ---: |
| Writer → observer visibility, 30 samples | 17.7 ms p50, 20.4 ms p95 |
| 50-edit batched burst visible to observer | 28.1 ms / 1,780 edits/s |
| Fresh peer reconnect and convergence | 11.4 ms |

The persisted rows are intentionally not directly ranked. Bashroom currently
measures post-SQLite writer acknowledgement but not WebSocket observer fanout;
Liveblocks measures remote observer visibility but exposes no equivalent
per-edit durable acknowledgement. The next fair product benchmark must add
Bashroom observer fanout, then compare observer latency to observer latency.

## Decision

Keep the DO-native central-authority design:

```text
durable truth = exact UTF-8 SQLite snapshot + ordered canonical update tail
hot cache     = bounded, disposable CodeMirror Text trees
API boundary  = string/Uint8Array only when opened, exported, or checkpointed
```

Do not rebuild Yjs or adopt a CRDT yet. Bashroom writers can reach one room
authority, so a compact ordered transformation log buys exact bytes,
idempotency, and simple filesystem revisions without CRDT identity/tombstone
semantics. Revisit that choice only if offline/partitioned editing becomes a
real product requirement.
