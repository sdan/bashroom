# Engineering notes

Dated, append-only findings about how bashroom is built: measurements,
design decisions with their context, and experiments. ARCHITECTURAL.md is
the current-state truth; this file is the why-we-believe-it log. Add new
entries at the top with `## YYYY-MM-DD — topic`.

## 2026-07-16 — The tie test: json-joy behind the identical surface (prediction hit)

Prediction pre-registered before the first run: json-joy mounted behind the
IDENTICAL WebSocket surface, same DO, same durability parity (every patch
persisted via sql.exec behind the output gate), same 25ms one-way simulated
network, same scenario, would land within ±10ms of RoomText's 54ms p50.

Result: 54ms p50 — a dead tie to the millisecond (p95 56ms vs 67ms, run
variance). Zero keystrokes lost by both engines; both merged the concurrent
agent write byte-perfectly. Driver: benchmarks/room-text/ab-tie.mjs; engine:
the jj-* frames in scripts/room-text-probe/worker.ts (benchmark-only,
json-joy + tslib are root devDependencies for the probe bundle).

What this settles: at system scale the text engine is invisible — network
and durability own the latency budget entirely (engine transform time is
2–12µs inside a 54ms round trip). Engine choice is therefore decided by the
OTHER dimensions: bounded state vs history-growing metadata, stale-work
rebase scaling, exact-bytes-as-canonical-state, and dumb-client writers.
"Faster than json-joy" is not a claim we make; "the engine difference
cannot be observed behind a real network, and ours stays small and speaks
filesystem" now has a predicted-then-measured null result behind it.

## 2026-07-16 — Cutover A/B: the deciding experiment (rule PASSED)

The scenario that breaks production (agent whole-file write while a human
types, 60 keystrokes, agent at #30) run on both paths with identical 25ms
one-way simulated network. Path A = current prod semantics simulated from
shipped constants (autosave 700ms, refetch debounce 350ms, conflict =
load-theirs); Path B = real RoomText over the workerd WS probe. Driver:
benchmarks/room-text/ab-cutover.mjs; raw events in ab-cutover-results.json;
animated replay artifact published from the same data.

Pre-registered rule (cut over only if B loses zero keystrokes where A
loses any, at p50 observer latency <= A): PASSED. A lost 7-9 keystrokes
per run (timing race, final doc visibly mangled mid-sentence); B lost 0,
byte-exact, both contributions merged. Writer->observer p50: 454ms (A,
7 batch jumps) vs 54ms (B, 61 live events) — 8.4x. Cutover is justified
architecturally; the remaining gate is operational (production DO mount,
promote/demote boundary, staging soak) plus task #9 (MCP comment anchors).

## 2026-07-15 — Chunk-aligned hashing: adopt with a size gate (Experiment 2)

Hypothesis: caching per-node content hashes keyed by rope-node identity
(WeakMap = the pointer-equality trick) makes per-revision document hashing
O(dirty spine). Mergeable hash: polynomial with length-aware combine
(h1·B^len2 + h2 mod p) so subtree hashes merge in O(1) and the root equals
a straight hash of the content — structure-independent, which the gate
verified on all seven traces (byte-exact finals, roots equal from-scratch).
Rig: benchmarks/room-text/hash-benchmark.ts.

Pre-registered rule (adopt if ≤15% of full-rehash at median): PASSED at
7.5% median — 2.0–9.4% on six traces (rustcode: 143.0s full vs 2.9s incr;
automerge-paper: 17.3min vs 98s). EXCEPTION: the 21KB trace ran at 125% —
below ~32KB, walking the tree costs more than hashing the document.

Design for the digest index, settled by data: size-gated. Small docs
(< ~32KB) hash whole content — they materialize snapshot bytes per
revision anyway under the snapshot-cadence policy, so hash those bytes
inline. Larger docs use dirty-spine incremental with the WeakMap cache.
Constraint discovered at design time: crypto.subtle.digest is async — a
non-storage await the discipline test forbids — so the production hash
must be synchronous (two-modulus polynomial or sync WASM xxhash/blake3).
Leaves-hashed ≈ revisions confirms ~1 dirty chunk per edit.

## 2026-07-15 — RoomText history janitor: compose below the floor, CAS-flip the HEAD

Mechanics for user-visible version history, built and probed ahead of the
sync-v1 mount (store methods + `scripts/room-text-probe/` alarm, port 8796).
The history floor still advances at each checkpoint and still means "based
below this → RESET_REQUIRED", but checkpoint-time pruning is gone: rows
below the floor are now retained as cold history until a flush janitor
ships them to R2, then `advanceFloorAfterFlush` prunes updates, retry
pointers, and orphaned room commits at one atomic boundary.

Invariant, restated because it shapes everything: compose updates ONLY
strictly below history_floor. Rebase confirms in-window updates by
update_token (the rebaseUpdates clientID), so composing a live-window row
would corrupt client reconciliation. The probe proves live rows survive
compaction byte-identically. Two named thresholds bound cold accumulation:
SOFT — docs under 8 KB keep per-revision granularity (a snapshot per
revision costs R2 less than composition loses in attribution); HARD —
larger docs compose consecutive same-client runs once >256 ops or >64 KB
of delta sit below the floor (48 runs of 8 collapsed to 48 rows in probe).

Crash-safety is ordering plus idempotence, no coordination: compact →
export artifact (deterministic bytes, no clocks) → create-only PUT under
`rooms/<room>/.history/<file>/<epoch>@<revision>` → etag-CAS flip of the
tiny HEAD manifest (the atomic visibility switch) → advance the floor.
Measured on workerd: an alarm re-fire is a full no-op (identical artifact
bytes, HEAD etag untouched); an injected crash between PUT and flip leaves
an orphaned artifact and an unmoved HEAD, and the next fire completes;
cold replay after the floor advance is byte-exact, and consecutive
artifacts chain byte-exactly (1@768 snapshot + 1@772 deltas = 1@772
snapshot). This is the Liveblocks hot(DO)/cold(R2) split from the
2026-07-14 entry, with deltas kept for attribution.

## 2026-07-15 — utf8Length: 1.8–2.7× on every editing trace (allocation, not algorithm)

Hypothesis (vmg-style): the RoomText hot path paid TextEncoder.encode() —
a Uint8Array allocation — per changed span just to read .byteLength, plus a
separate scalar-validation scan over each insert. Fix: utf8Length() in
src/room-text.ts — one charCode-arithmetic pass, zero allocation, validates
scalar well-formedness in the same loop; roomTextByteLength now iterates
rope chunks instead of materializing + encoding the whole document.

Decision rule stated before running: keep if ≥10% median gain on ≥4/7
traces, no trace regressing >2%. Result: 1.83×–2.67× on 7/7 (same-session
A/B, e.g. automerge-paper 196,955 → 498,539 txns/s; seph-blog1 172,776 →
419,087), byte-exact finals unchanged, 23/23 tests green.

Moral: the gap to JSON Joy was never rope-vs-CRDT — roughly half of it was
accounting allocations. RESULTS.md tables predate this change; regenerate
before quoting. Queued follow-up experiments, same protocol (hypothesis +
decision rule before running): chunk-aligned dirty-spine hashing (feeds
task #8), snapshot-cadence sweep by doc size, group-commit burst on real
workerd, tiny-doc rope-vs-string crossover (expected null result).

## 2026-07-15 — Memory-first audit: the three levers, and what already holds

Question examined: can we keep documents in memory and mutate at memory
speed ("beat json-joy with RAM")? Platform facts: DO memory dies at
hibernation (10s idle), eviction (70–140s idle, non-hibernatable), and
code deploys (1–2×/day, non-deterministic) — memory is never a durability
tier, and acking from RAM loses acked writes daily. But DO SQLite already
IS the memory-first design: sql.exec is synchronous and in-process,
write coalescing batches a turn's writes into one implicit transaction,
and output gates hold the ack (not the mutation) until replication
confirms. Mutation at memory speed, honest acks.

Audit of the three levers against the code:
1. No-await hot path — ALREADY HOLDS: room-text.ts + room-text-store.ts
   contain zero async/await. Locked as a CI property in
   src/room-text-discipline.test.ts (also bans timers/fetch).
2. Group commit — storage side is platform-provided (coalescing + async
   flush). The remaining win is BROADCAST batching: one WS frame carrying
   N accepted updates per flush, specced into the sync-v1 task alongside
   Liveblocks-style keyframe/delta drafts (targetActor-field pattern).
3. Ephemeral/canonical split — ALREADY HOLDS: drafts bypass storage in
   RoomHub; canonical revisions sit behind the gate in RoomText.

Implication for benchmarks: the 840 edits/s workerd number is pessimistic
(local dev, serial acks); production throughput scales with coalescing and
concurrent gate-waits. The fair test vs json-joy must measure burst
throughput on real DOs, plus cold-start-to-first-edit after hibernation.

## 2026-07-14 — Liveblocks runs on Durable Objects; convergence findings

Dug into Liveblocks internals (Cloudflare case study, their docs, protocol
source). Headline: a Liveblocks room IS one Durable Object — hibernating
WebSockets, placement near first joiner, R2 for version history, KV cache,
Queues. They migrated from EC2+MongoDB to this; ~0.5B messages/day with
~10 engineers. Bashroom's room-actor architecture is the same shape as the
category leader's, independently derived.

Their choices, and ours against them:
- Storage sync is server-authoritative op-based with LWW arbitration
  ("CRDT-like", NOT a CRDT) — same bet as RoomText rebase and Figma.
- Reconnect: full storage refetch (chunked) + client replays unacked ops
  by opId with echo-acks. A revision log lets us do BETTER: incremental
  since-seq catchup. Their model = acceptable fallback.
- Version history: FULL SNAPSHOTS TO R2 (not deltas, not DO storage),
  time-window retention, restore applied as a new op — validates the
  hot(DO)/cold(R2) split and snapshot-cadence policy for history.
- Presence: ephemeral, strictly separate from storage (= RoomHub). They
  added server-side TTL presence "for AI agents in rooms" — the incumbent
  is moving toward bashroom's agent territory.
- Comments: system of record OFF the room actor; room socket is only the
  delivery bus. Cross-room features (inbox/search) always need a separate
  index — never stuff them into the room actor.
- Published per-room socket caps: 10–100 by plan — the honest single-actor
  ceiling. Their metered pricing ($1/M storage updates, $0.15/GB stored,
  collab minutes) maps ~1:1 onto DO billing primitives.

## 2026-07-14 — Actor-model review against OTP/Akka/Orleans + DO-native frameworks

Graded all six DO classes against the primitives mature actor systems
consider essential (survey: OTP, Akka, Orleans, Restate, Temporal;
DO-native: cloudflare/actors, partyserver, RivetKit, actor-kit, Agents SDK).

Holds system-wide: durable state, virtual-actor addressing (idFromName),
passivation with verified byte-exact rehydration, reentrancy (ZERO
non-storage awaits in any DO class — swept), at-least-once + idempotency
dedup (RoomText request records ≈ Akka ConsumerController), event sourcing
with snapshots (RoomText ≈ Akka EventSourcedBehavior). Rows 5–7 are
hand-built because NO DO-native framework ships them — building was
correct; do not adopt a framework to get sugar we can write in 50 lines.

Gaps, ranked:
1. Alarms used by 1 of 6 classes. Missing janitors: .lock TTL expiry
   (crashed agent's lock lives forever), RoomText idle flush/demote,
   tombstone sweeps. cloudflare/actors + Agents SDK ship multi-alarm/cron
   multiplexing over the one-alarm limit — steal the pattern (~50 lines).
2. No saga/compensation on cross-actor flows: room destroy spans
   Registry + AccountDO + R2 + RoomHub + DocumentCollab best-effort;
   orphaned hub rings / comment threads persist in billed DO storage.
   Fix shape: Registry tombstone + alarm-driven idempotent sweeps.
3. No backpressure (universal — no framework on DOs provides it either);
   draft-frame throttle (150ms/socket) is the only edge control. Watch
   the ~1k req/s per-DO soft limit under agent swarms; metric before fix.
4. Registry singleton stands as documented bottleneck; DO facets
   (2026 beta, parent-supervised child objects) is the future shard path.

## 2026-07-14 — RoomText DO authority, exact bytes, and benchmarks

Built an isolated vertical slice under `src/room-text.ts`,
`src/room-text-store.ts`, and `scripts/room-text-probe/`. It is deliberately
not wired into production R2/web writes yet: dual-writing two authorities
would be less correct than either one.

The durable representation is an exact UTF-8 snapshot BLOB plus contiguous
canonical ChangeSets in DO SQLite. Active documents use a bounded cache of
immutable CodeMirror `Text` trees. Strings are materialized only at
open/export/checkpoint boundaries; hibernation may discard every cache entry.

Measured on workerd:

- 50 simultaneous stale edits produced revisions 1–50 with no loss;
- 50 retries of one logical request produced one durable revision;
- cache eviction and checkpoint recovery were byte-exact;
- a 262,144-byte escaped paste exposed and then verified the fix for a SQLite
  row-overflow bug in the first idempotency schema; and
- checkpoints and stale work are bounded at 128 updates / 256 KB recovery tail
  and 256 updates / 1 MB synchronization tail respectively; and
- checkpoint pruning keeps the collaboration log below 512 rows or around
  8 MB per file, deleting canonical updates, retry pointers, and orphaned room
  commits at one atomic history floor.

On an M1 Max, the pure implementation handled roughly 363k–612k validated hot
edits/second for 10 KB–999 KB documents. Local workerd sustained a median 840
durably accepted edits/second in three 50-writer bursts. Full tables, pinned
versions, commands, and the important Bashroom-vs-Liveblocks semantic caveat
live in `benchmarks/room-text/RESULTS.md`.

Decision: keep JSON on the wire and keep the DO-native central authority.
JSON Joy's CBOR/MessagePack codecs save only 35–41 bytes on our 229-byte
envelope, and codec time is negligible next to persistence/network latency.
Do not rebuild Yjs unless offline or partitioned writers become a measured
requirement.

## 2026-07-08 — Durable Object serialization, measured

We claim DOs order concurrent writers for us. Checked empirically instead
of trusting docs — probe rig preserved at `scripts/do-probe/` (run
`npx wrangler dev -c scripts/do-probe/wrangler.jsonc --port 8791`, then
`node scripts/do-probe/blast.mjs`). 50 genuinely concurrent requests per
experiment, on workerd (the production runtime):

| Handler | Design | Result |
|---|---|---|
| `/order` — fully synchronous | in-memory `++seq` per request | seqs 1..50, unique, gap-free |
| `/gated` — RMW through DO storage (awaits storage) | `get` → `put` counter | exactly 50 |
| `/hazard` — RMW across a NON-storage await | read, `scheduler.wait`, write | **12 of 50** — 76% lost |

Conclusions, in force for all DO code here (RoomHub, DocumentCollab, and
any future patch-sequencer):

1. Request delivery to a DO is strictly one-at-a-time — arrival order IS
   the order. No locks/timestamps needed for per-object sequencing.
2. Input/output gates extend that atomicity across *storage* awaits —
   storage read-modify-write is safe as written.
3. Any OTHER await (timer, fetch to R2/another service) is a yield point:
   the next request runs in the gap. Never carry in-memory state across a
   non-storage await. Load → apply → store, synchronously with respect to
   everything that isn't `ctx.storage`.
4. Harness lesson: our first `/gated` run measured 73/50 — the blast
   client retried requests whose responses died, double-firing increments.
   At-least-once clients need idempotency keys before a DO can be trusted
   as a counter/sequencer of THEIR requests. (Applies to any future
   patch-mode write: patches must carry an idempotency id so redelivery
   dedupes.)

Context: this de-risks the "patches through the actor" design (task #5) —
a per-room DO can sequence `{base_etag, diff, patch_id}` writes from
concurrent agents+humans with no consensus machinery, provided rules 3–4
are followed.

## 2026-07-08 — Write-integrity ladder and prior art (pointer)

Same-day survey results that shaped the concurrency design, preserved in
session artifacts: gcsfuse is the only FUSE mount doing conditional
write-back (ESTALE to the loser); s3fs/rclone/mountpoint punt; JuiceFS/
SeaweedFS use metadata sequencers; wal3/SlateDB/delta-rs prove CAS +
put-if-absent suffice for multi-writer logs (delta-rs documents R2 as
supported). bashroom's ladder: etag CAS + create_only (shipped) →
versions/ journal via R2 event notifications (planned) → DO patch
sequencer (task #5) → CRDT (only if live co-typing becomes the product).
Shell writes through FUSE remain unconditional — see ARCHITECTURAL.md
Known limits.
