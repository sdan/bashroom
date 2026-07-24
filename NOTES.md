# Engineering notes

Dated, append-only findings about how bashroom is built: measurements,
design decisions with their context, and experiments. ARCHITECTURAL.md is
the current-state truth; this file is the why-we-believe-it log. Add new
entries at the top with `## YYYY-MM-DD — topic`.

## 2026-07-24 — RoomText became production Markdown authority

Cut over with an explicit `off -> freeze -> on` deployment fence. Production
version `731f0c07-b582-4a61-a3d5-1f7a7ba62315` has `ROOM_TEXT_MODE=on`.

No-loss evidence:

- Pre-cutover cloud copy: `bashroom-rooms-pre-roomtext-20260724`, 724/724
  source objects SHA-256 matched by the temporarily deployed copy worker.
  Report SHA-256: `6f8e7b50a0b460b6f15cf8a3d7faf9bde742735424bc84af2a977661ef80e369`.
- Frozen local export: 699 files, 5,490,192 bytes. Manifest SHA-256:
  `15e02c2ee542e3d31d3593be43ce45ad2a98904fc5c0182032c94db611a0f697`;
  tarball SHA-256:
  `c5a9c2dae914bf7efdb3d00c4ef996d995abe61740781978746e60866cb86454`.
- The pre-freeze and frozen manifests were identical. A second full export
  after migration produced the same manifest, proving that conditional R2
  ownership metadata writes changed zero file bytes.
- 698 eligible Markdown files imported and independently verified; zero
  errors. `longloop/session-log.md` is 1,157,721 bytes, exceeds RoomText's
  1,000,000-byte cap, and remains byte-identical under explicit R2 authority.
  Twelve other skipped R2 objects were directory markers.
- Migration report SHA-256:
  `47ab9c939f9d7ef6ca9ba44f49894542670986f98647d8e2381fa3c34263fd8a`.
  Independent verify-only report SHA-256:
  `738f11c5170f35e8b3ff41addb1b68a8a3992d72bd5ac00d196ff58ce6371eae`.

Production canary (`milkdown-test/roomtext-production-canary-20260724.md`):
create-only returned `rt1:1:0`; literal edit returned `rt1:1:1`; replay of the
same request returned the same revision; a stale whole-file replacement was
rejected; the final edit returned `rt1:1:2`. MCP, web, direct R2, and the
read-only shell projection all matched SHA-256
`a631ab9732837a005549eeb20ee39900c2cf6b38f0e9195574d137befd37576c`.

Deliberate product constraints after cutover: `/rooms` is read-only; use
`bashroom_edit` or versioned `bashroom_write`. Room deletion is disabled until
Registry, R2, and RoomHub SQLite have one explicit delete protocol. The web UI
still submits whole-document CAS saves; RoomText is production authority, but
the headless delta client is not yet wired into the browser editor.

## 2026-07-20 — Dark mount lands: RoomText inside RoomHub, 16/16 in real workerd

User decision (2026-07-19) superseded the freeze: port + migrate + validate.
Landed, in order, all local (nothing pushed, nothing deployed, R2 remains
production authority):

- 7289a5b / bf70ab8 — graduated the lab's monotonic publication guard and
  group-commit into the store (cold three-way review: CLEAN; the batch's
  deferred head finalize shares its transactionSync, so the janitor can
  never publish an intermediate in-batch revision). Gate 87/87.
- aff54c2 — durable dirty-set (room_text_dirty upserted in the SAME
  transaction as every head mutation; clearDirty keeps marks newer than the
  published revision). Closes the lab's scalar-target bug that dropped 2/3
  dirty files. 94/94.
- 9b21c46 — the mount: RoomHubText host module inside the existing RoomHub
  DO (no new DO class, no migration — additive SQL in an existing
  new_sqlite_classes class). Dark constraints enforced by shape: pushes
  accepted only from readonly===false sockets; hydration/updates ride the
  hub's prefix-visibility fence; RoomText frames get a 1.2M inbound bound
  ahead of the generic 300k drop (JSON escaping of a legal 262KB insert
  exceeds 300k — a silent drop would wedge the outbox); JSON {type:"ping"}
  answered at app level, distinct from the raw-string auto-response
  keepalive; roomTextShadowKey bakes in the roomtext-shadow/ literal so a
  production users/ key is structurally unreachable from janitor writes (R2
  keys are flat — hostile ../ cannot escape; tested). RoomHub's first
  alarm: idle-stopping shadow janitor running the lab pipeline (compact ->
  create-only artifact via If-None-Match Headers form -> publication
  decision -> HEAD etag-CAS -> advance floor -> clearDirty at published
  revision). Operator routes /web/api/roomtext/{promote,parity,flush},
  write-scope membership required. 99/99.
- ae29d8e — validation harness (scripts/roomtext-dark-probe/): binds the
  REAL RoomHub with local R2 and ran the whole story: promote 4/4, parity
  100% byte match (emoji/ZWJ, CJK, CRLF, 484KB), flush -> shadow HEADs
  only, live WS edit with echo-as-ack + broadcast + idempotent replay +
  readonly refusal, and production keys etag-verified untouched twice.
  **16/16 PASS.**

- 2b8b95b — adversarial review of the mount found TWO high-confidence bugs,
  both fixed: (1) an infinite flush loop — flushOne exported at
  snapshot_revision but ordinary pushes only checkpoint every 128 updates,
  so clearDirty retired nothing and the 2s alarm re-fired forever
  republishing stale state (checkpointText, which had zero callers, was the
  missing step; now called first in flushOne). (2) push-path prefix escape —
  handlePushes gated on readonly but not pathVisible, so an edit-scoped
  share could commit outside its prefix (symmetric NOT_FOUND fence added).
  Plus janitor backoff + deferDirty FIFO fairness, a 64-push/frame cap, and
  the promote 422/409 split. Harness gained the loop-catching phase; now
  21/21. The 16/16 harness had MISSED the loop because it only checked flush
  success, never that the dirty row actually cleared — lesson recorded.

Remaining before "migrated OUR data": run promote/parity against real room
contents (pull via authenticated export into local dev, or deploy dark to
prod — the latter is the user's call). Production authority flip stays a
separate explicitly-approved step.

## 2026-07-19 — A/B retraction, Linear mapping, plan of record: freeze-and-instrument

Three things landed together and set the plan of record.

**RETRACTION: the 2026-07-16 cutover A/B is not valid evidence against the
shipped client.** An outside review caught it and every claim verified. The
harness (benchmarks/room-text/ab-cutover.mjs:82-87) modeled the human's
conflict behavior as load-theirs (buffer = reply.content — everything since
the last acked save counted lost) at AUTOSAVE_MS=700. But the shipped client
since a8d515e (2026-07-15 — one day BEFORE the A/B ran) preserves the draft
on 412 and shows a conflict bar with both choices (src/web-ui.ts:1300-1304)
at a 1500ms autosave (src/web-ui.ts:1279). "A lost 7-9 keystrokes, B lost 0"
compared RoomText against the previous client generation. The real cost of a
production conflict is a forced manual resolution where one side must be
hand-merged — nonzero, but NOT lost keystrokes, and unmeasured. The 8.4x
observer-latency result used constants that also no longer match; treat the
whole entry as historical. Method lesson (same family as the 230/230 and the
lab's frame-switch findings): evidence is valid only against the REAL shipped
baseline, re-verified at run time — not constants captured when the harness
was written.

**Linear sync-engine mapping (12-agent swarm, 3 articles, 57 concept
mappings, 55 CONFIRMED by cold verifiers).** Conclusion: bashroom is
Linear-before-its-sync-engine on the LIVE path (central authority, per-file
CAS-with-compare, explicit conflicts, shoulder-tap pokes via RoomHub, no
client replica) PLUS Linear's full sync engine already built but DORMANT
(RoomText: persisted transaction queue, per-file lastSyncId-style revision
cursor, delta-vs-snapshot bootstrap decision, rebase-instead-of-CRDT). The
one pillar deliberately inverted: no local-first client database anywhere —
every writer is online by definition (agents + web), so the DO input gate
can be the sequencer and text merge is deterministic rebase, which Linear's
offline clients structurally cannot have. Linear's own history (years on
LWW because measured conflicts were rare; merge machinery added only where
product demand proved it) is the precedent for the plan below.

**PLAN OF RECORD — freeze-and-instrument (supersedes "cutover steps 5-10
next"):**
1. FREEZE RoomText investment: no cutover steps 5-10, no graduations (#8,
   #13, #14 blocked) until conflict data exists. Do NOT delete the engine:
   its value is the living verification harness (discipline tests, blast
   suites, 6 audited experiments); "git preserves it" loses exactly that.
2. INSTRUMENT the live path: count web 412 conflicts, MCP/shared CAS
   failures, and shell-vs-web same-file collision windows, per room per day.
3. PRE-REGISTER the promote/freeze thresholds BEFORE reading the data (the
   lab's own lesson: pin the frame first), then let 2-4 weeks of metrics
   decide: real concurrent-edit conflicts → promote via the existing 10-step
   sequence; near-zero → engine stays frozen, revisit quarterly.
Corrections absorbed: the 2026-07-16 "outbox is in-memory" ledger line is
now stale — task #11 shipped config.persist; the outbox IS reload-durable in
this tree (verifier-confirmed). Open product calls (user's): draft relay
frames stream up to 256KB full-document buffers through RoomHub
(src/index.ts:184) powering live share-page viewing — keep, shrink to
diffs, or drop; and whether collaborative editing stays on the roadmap.

## 2026-07-17 — CS-structures lab: 6 pre-registered experiments, 6 independent audits, all verified

Swarm (13 agents): each lane isolated in its own worktree + port range with a
pre-registered decision rule; each audited by a verifier that re-ran the repro
COLD and attacked the methodology. Results files: benchmarks/room-text/experiments/.
Base: 49693f3 (current-head B store). All six verdicts = supports, all audits
verified; the honest caveats are recorded below because two headline framings
were softer than claimed.

SETTLED EMPIRICALLY:
- FTS5-trigram EXISTS in workerd DO SQLite (availability was undocumented).
  Rare-substring p95 ~50-160x faster than LIKE scan (robust p50 ratio; the
  84-122x headline is tail-of-16-samples fragile per audit). Index 1.78x
  corpus bytes. Hazards: MATCH <3 chars silently returns 0 rows (route short
  queries to LIKE); sqlite_version() and R*Tree blocked by authorizer —
  capability-detect by try/catch, never version-gate.
- Sequence-cursor oplog CRUSHES the flat root digest: maintenance 10.5us vs
  34,000us/edit at 10k files (the flat rehash in pushText is a measured
  SCALING CLIFF: ~5x the whole 7ms write budget at 10k files), catch-up k=10
  ~2,700-3,600x faster, tombstones work (deletions today are UNREPRESENTABLE:
  DiffDigestResult.removed hardcoded []). 32-way Merkle: rule technically
  triggered (C beat B on catchup k=100, ~80us vs ~123us) but loses 9x on
  maintenance + ~1s rebuild-on-wake at 10k — not justified; margin recorded.
- Group commit (N revisions, ONE head write at batch end, one SQLite txn
  inside the gate): amplification cut exactly 4x/16x/64x at batch 4/16/64,
  byte-identical final heads (sha-verified), batch=1 latency within +-10%.
  Semantic change: batch is all-or-nothing (documented). GRADUATE.
- R2 monotonic (epoch,revision) publication guard: pre-fix the paused-flush
  regression hit 458/1000 random schedules (and a regressed file that goes
  quiet serves stale from R2 indefinitely); post-fix 0/2000. CONFIRMED
  separately: scalar janitor:target still drops 2/3 dirty files even with
  the guard — durable dirty-set required. GRADUATE guard + build dirty-set.
- Deletion torture: 0 oracle violations across 2x2047 schedules (seeds 4811/
  9127) — B store convergence survives 50-90% deletes under 50 writers,
  crash-in-compaction, wipe cycles; mid-surrogate deletes rejected cleanly.
- Trigram postings (manual): DO-internal ~40-60x mean speedup BUT the
  audit's central finding stands: under the harness's own coded client-frame
  rule, 2 of 3 runs FAIL the 5x bar (transport floor dominates). With FTS5
  available, manual postings are moot anyway.

NEW BUGS FOUND BY THE LAB:
1. Digest scaling cliff (above) — makes cursor-oplog adoption urgent; task
   #8 re-scoped from "incremental root" to "replace root with oplog".
2. Anchor resurrection via replacement: an anchor fully covered by a pure
   deletion collapses fail-closed (start==end, 7/7 correct), but covered by
   a REPLACEMENT it re-attaches to the inserted text (assoc -1/+1 maps
   [6,11) through [5,12)->'##' to [5,7]). Needs covered-by-replacement
   collapse if "never resurrects" is the contract.
3. Tiny-head/huge-artifact: after 900KB->200B shrink, the version artifact
   for the 200B head is ~1MB (composed history dominates). Compaction after
   drastic shrink should re-baseline.

AUDIT META (worth keeping): two lanes' PASS framings were post-hoc-flavored
(fts5 roundtrip-vs-per-query view; postings client-vs-DO frame where the
coded rule said FAIL). Both experimenters disclosed the pilot data and both
verifiers judged the underlying conclusion sound — but pre-registration
must pin the measurement FRAME, not just the threshold. Carry into the
blog's methods section.

RESEARCH (prior-art agent): lead publishable angle = "You don't need a
Merkle tree if you own the sequencer" — the pincer: git (a Merkle DAG!)
refuses Merkle diffing for fetch because shared ancestry makes frontier
negotiation cheaper; Dynamo/Cassandra use Merkle precisely because replicas
are symmetric with no shared order. A DO room owns the sequencer, so oplog
wins — and our numbers are the evidence section. Supporting angles: the DO
input gate as a free group-commit scheduler (vs Postgres commit_delay
machinery); head-per-write as degenerate LSM (Figma's WAL+checkpoint as
prior practice); object stores don't order flushes (monotonic guard, not
retries); filter-then-verify substring search (Cox/Cursor: index needs
recall only). Full map in the workflow output.

## 2026-07-16 — B-only durable head; realistic stress and adversarial gaps

The materialization A/B and its runtime switch were deleted. RoomText now has
one current-state representation: an exact UTF-8 head BLOB updated atomically
with each accepted canonical revision. Checkpoints and the canonical log remain
only for sync, anchors, idempotency, and version export; cold reads never replay
them. Head and checkpoint stay in separate rows because each may approach the
1 MB RoomText limit while Durable Object SQLite caps a row/BLOB at 2 MB.

A read-only census of the mounted product corpus found 680 files: p50 4,051 B,
p95 13,178 B, p99 53,917 B; 658 files were at most 16 KiB and only 6 exceeded
64 KiB. Eighteen of nineteen rooms totaled at most 241,290 B; `longloop` was
the outlier at 4.3 MiB.

The full local-workerd profile ran the supported 679-file corpus in a measured
19-DO count/byte topology and in a concentrated single-DO stress topology,
each twice; fixture contents were deterministic, not copied private text.
It accepted 10,092 fresh revisions, 204 retries, 70 cache clears, and 3.56 GB
of logical current-head BLOB writes. All six full real editing-trace runs
matched the pinned corpus oracle and independent foreign-edit final strings.
Inside each 679-file DO, 256 edits to a 420 KB head plus a 50-writer stale burst
crossed the 32-entry cache via 16 sibling sweeps: sequential p50 was
6.90–7.24 ms, while the stale burst drained at 139–154 edits/s. An independent
oracle proved every one of the 50 burst markers appeared exactly once and the
prior 420 KB suffix was untouched. After process restart, 2,716 topology files
and 10 hot documents reopened exactly; the
pre-restart request deduped to its
original commit and the next request advanced normally.

Named SQLite aborts proved create/head/digest transactions roll back without
fragments. Four gaps were reproduced: create misclassifies a SQLite constraint
abort unrelated to uniqueness as `ALREADY_EXISTS`; same-length valid head
corruption opens until explicit digest verification; one scalar alarm target drops the first
of two dirty files; and a paused revision-1 janitor resumed after revision 2
and CASed R2 `HEAD` backward to 1 while SQLite stayed at 2.

This changes the work order:

1. Before cutover, replace `janitor:target` with a durable dirty-file queue and
   reject any R2 HEAD transition whose `(epoch, revision)` is not monotonic.
   Narrow SQL constraint classification and decide whether cold heads validate
   their maintained digest. Add a verified legacy-head backfill before reusing
   any existing candidate namespace.
2. Test an explicit dependent update chain: persist N canonical revisions and
   request pointers in one synchronous transaction, but encode/write the final
   head once. No timer. A 16-update backlog must produce one head publication,
   preserve retries/interleavings, and improve 100/900 KB aggregate execution
   by at least 25%.
3. Hold 32 KB adaptive chunks until large actively edited files are observed.
   They must write at most 10% of full-head bytes and keep cold open under 2x.
4. Treat a packed room image as an export/checkout probe, not authority: it
   fits nearly every current room but makes one tiny edit rewrite the room.
5. If customers do not need per-file restore/history, test deleting the R2
   artifact pipeline and retain only the bounded sync log plus operator PITR.

## 2026-07-16 — Cutover sign-off: Wave B = milestone, cutover NOT approved

Human review (surya). Wave B approved as a strong experimental milestone;
production cutover explicitly NOT approved. Four reported claims corrected
(record these so the inflated versions never propagate):
- "230/230 tests" was 57 distinct tests tripled by vitest walking into five
  .claude/worktrees copies. TRUE COUNT = 57/57. Fixed: `test` script now
  `vitest run --dir src` + vitest.config.ts scopes/excludes worktrees.
- Client outbox is IN-MEMORY (reconnect-resilient, NOT reload-durable).
  Calling it "durable" was wrong; localStorage persistence is spec, not built.
  [UPDATE 2026-07-17: built — task #11 added config.persist serialization on
  every outbox mutation + constructor rehydration with ORIGINAL request
  tokens. Reload-durable in this tree; the line above records the 07-16 state.]
- "8/9 complete" overstated Task 8: digest gives O(changed) RESPONSE but
  O(all files) COMPUTATION per accepted update, and removals are unsupported.
  Task 8 acceptance scope reopened.
- Deploy: version d15ea856 (2026-07-15) IS the active version per
  `wrangler deployments status`, but my session verification hit the domain
  without confirming version==HEAD, so a stale-worker test is not ruled out.
  Treat prod-parity as UNVERIFIED until version pinning is checked. (The 3
  R2 secrets still existing is intentional rollback path, not a miss.)

CUTOVER BLOCKERS (all confirmed real):
1. Retryable-discard edit loss — room-text-client.ts:437 drops the rejected
   head edit on RESET_REQUIRED instead of preserve-and-rehydrate. Data loss.
2. Outbox + IDs not durable — private array (client.ts:185); default
   request IDs restart at req-1 while dedup is room-wide on
   (client_id,request_id) (store.ts:1084). Reload/multi-file collisions.
3. Comment anchors use INCOMPATIBLE coordinates — browser records rendered-
   DOM offsets (web-collab.ts:249); RoomText remaps through raw-Markdown-
   source changes (room-text.ts:209). Headings/emphasis/links/code diverge.
   Bigger than Task #9's MCP-offset gap: needs a rendered<->source mapping
   decision. Comments cannot ride the new engine until resolved.
4. Split-brain — shell still writes the writable R2 mount (index.ts:4166);
   SQLite-authoritative + live shell writes = the split ARCHITECTURAL.md:308
   prohibits.

APPROVED ARCHITECTURE (supersedes the separate-RoomText-DO design):
- Expand the EXISTING RoomHub into the room authority; do NOT stand up a
  parallel room DO. Hub already has <user>:<room> identity, placement,
  SQLite, sockets — one DO per coordination atom.
- Fold DocumentCollab INTO that room authority: comment anchors + text
  revisions share one consistency boundary; separate DOs = needless saga.
- Authority moves ONCE (R2 -> hot on promote), never oscillates on
  disconnect. DO hibernation already makes compute cold while SQLite stays
  authoritative. (Corrects the "demote on idle" oscillation my hot/cold
  viz implied.)

REQUIRED SEQUENCE (plan of record):
1 fix retryable-discard edit loss. 2 persisted outbox import/export +
globally unique request IDs. 3 choose source-coordinate comments + build
rendered<->source mapping. 4 correct vitest discovery (DONE) + reopen
Task 8 scope. 5 mount RoomText inside RoomHub, dark. 6 authed socket/file
binding + client identity + frame/batch limits. 7 rename/delete/tombstones
+ atomic multi-file commitBatch. 8 replace direct shell authority with
checkout/commit. 9 one text-only canary room, no auto-demotion (safe only
if shell writes disabled/read-only for that room). 10 parity + rollback
verify before room-by-room expansion.

## 2026-07-16 — CS-fundamentals review; live lost-update hole found & fixed

Six-lens theory audit (distributed / algorithms / queueing / information /
formal / systems) over the committed system. Every lens accepted the core:
strict DO serialization + zero non-storage awaits as the atomicity basis,
pushText's single synchronous transaction making torn states
unrepresentable, the client FSM as correct stop-and-wait ARQ, retention
384 = 256+128 as near-sqrt-optimal, per-key R2 linearizability. Confirmed
kills stay dead: CBOR wire ($0 under CF metering), TLA+ (nothing to
model-check under DO serialization), trigram search index (R2 RTT
dominates at wiki n).

RANK 1 found a LIVE bug and it is FIXED + DEPLOYED (version d15ea856):
r2Put discarded the PUT's R2Object and every CAS-success path re-GET the
object to build its response. A concurrent writer landing in that put->get
window returned THEIR content+etag to the saver; the saver's next 700ms
autosave CAS'd against that foreign etag, succeeded, and silently
destroyed the other write — the exact lost-update the etag design exists
to surface, with NO 412 ever firing, on the path agents + the SPA hit.
Fix: r2Put returns R2Object|null; new r2FileFromPut builds the response
from the put's own etag + held content; re-read kept only on the 412
branch. Also removes one R2 round trip per save.

Remaining ranked proposals (queued, not yet built): #2 revocation
convergence (Registry tombstone + alarm retry — stale AccountDO mirror can
authorize writes to a deleted room forever, security-relevant); #3 honest
reads (single-GET mcpRead to kill torn HEAD+GET, pooled mcpSearch ~20s->~1s,
FUSE read-your-writes probe); #4 overload posture (jitter + admission
control before cutover — undamped metastable failure risk); #5 janitor
lineage (monotonic HEAD-flip guard); #6 O(doc) mailbox waste; #7
exactly-once seams (requestId fallback wrong-answer bug). Full report:
tasks/wy8zlxang.output.

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

**[RETRACTED as cutover evidence 2026-07-19 — see that entry. Path A modeled
the pre-a8d515e client (700ms autosave, conflict = load-theirs); the client
shipped 2026-07-15 preserves the draft on 412 at 1500ms. Kept for the record.]**

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
