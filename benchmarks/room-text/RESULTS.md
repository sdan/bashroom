# RoomText benchmark results

Synthetic and persisted cases were measured 2026-07-14; real editing traces
were measured 2026-07-15. The machine was an Apple M1 Max running macOS arm64
and Node 24.3.0. Packages and commands are pinned in this directory. Values are
local-development numbers, not Cloudflare production-region claims.

## Correctness first

The workerd probe passed:

- 50 concurrent edits all submitted from revision 0 → unique revisions 1–50;
- 50 redeliveries of one request → one durable update and identical responses;
- exact cold-head opens before and after version checkpointing;
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

Current-head Bashroom workerd, full realistic profile on 2026-07-16:

| Head size | Durable update p50 | Durable update p95 | Cache-cold open p50 |
| ---: | ---: | ---: | ---: |
| 8 KB | 3.54–3.57 ms | 6.47–6.57 ms | 2.01–2.16 ms |
| 100 KB | 3.91–4.04 ms | 6.78–6.91 ms | 2.90–3.03 ms |
| 900 KB | 9.57–10.31 ms | 15.18–19.88 ms | 12.49–13.29 ms |

This was not a toy loop. Two repeats each created the 679 supported files from
the measured 19-room corpus in both a 19-DO file-count/byte topology (4,138,495
bytes) and a deliberately harsher single-DO topology (5,139,805 synthetic
bytes). Fixture contents were deterministic, not copied private text. The run
committed 10,092 fresh revisions and 204 exact idempotent
retries, including all 1,523 `friendsforever_flat` transactions at 8/100/900
KB with 246 foreign interleavings, 128 dependent offline edits, and 70 explicit
cache clears. Every full trace matched both the pinned corpus oracle and an
independently constructed foreign-edit final string. Because B rewrites the
exact current head, those revisions bound 3,558,161,826 logical head bytes to
SQLite. After a full Wrangler restart against the same persistence
directory, all 2,716 topology files and 10 edited files reopened exactly; an
old request returned its original revision/commit and the next request became
revision 2. Full raw samples were retained outside the repo by the driver.

Directional timing remained host-sensitive, so exact bytes, revisions,
logical write volume, retries, and restart recovery are the primary results.
The 19-DO fleet imported 679 files in 1.01–1.12 seconds wall time locally. The
single-DO topology is a saturation case, not a claim that the live corpus
belongs in one actor.

Unlike the isolated trace rows, a second phase edited a 420 KB head inside the
679-file DO while 32 sweeps opened 40 sibling files each, then delivered 50
writers from one stale base. Sequential p50 was 6.90–7.24 ms and p95 was
16.24–18.38 ms. The stale burst drained at 139–154 accepted edits/s with
182–329 ms p50 request latency. Exact head/digest/revisions still converged;
an independent oracle also proved that all 50 submitted markers appeared once
and the prior 420 KB suffix was untouched. This is still the relevant warning:
O(all-files) room-root work and actor queueing are visible under a crowded room
even though isolated one-file timings look comfortable.

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

## B-only adversarial durability

A separate named-fault workerd probe aborts real SQLite transactions at the
durable-head write and at the final digest-log write, then inspects file,
head, update, request, commit, digest, and room-root state. The passing cases
proved:

- create, head-write, and late-digest aborts left no durable fragments;
- retry after rollback committed exactly once;
- a missing live update made pull/rebase fail `STORAGE_CORRUPT` while the
  independently authoritative head remained readable;
- 64 files churned the 32-entry cache and every head/digest reopened exactly;
- a room-global request token reused on another file failed explicitly without
  mutating that file.

Four gaps were reproduced, not inferred:

1. A SQLite constraint abort unrelated to uniqueness during create is misreported as
   `ALREADY_EXISTS` because the constraint classifier is too broad.
2. Same-length valid UTF-8 corruption in the head BLOB passes revision/length
   validation; the maintained digest detects it only when explicitly checked.
3. One scalar `janitor:target` loses file A when file B is scheduled before the
   alarm fires.
4. A gateable R2 await let an older revision-1 flush pause, a revision-2 flush
   publish, and the older flush resume. R2 `HEAD` regressed from 2 to 1 while
   SQLite correctly remained at 2. A monotonic epoch/revision guard is required
   before CAS.

Therefore the current B head transaction is locally robust, but the R2 history
janitor is not cutover-safe. It needs a durable per-room dirty-file queue and a
monotonic `HEAD` rule before any production mount.

## Decision

Keep the DO-native central-authority design:

```text
current truth   = exact UTF-8 SQLite head BLOB
sync history    = bounded ordered canonical update log
version history = separate checkpoint + cold artifact pipeline
hot cache       = bounded, disposable CodeMirror Text trees
```

Do not rebuild Yjs or adopt a CRDT yet. Bashroom writers can reach one room
authority, so a compact ordered transformation log buys exact bytes,
idempotency, and simple filesystem revisions without CRDT identity/tombstone
semantics. Revisit that choice only if offline/partitioned editing becomes a
real product requirement.
