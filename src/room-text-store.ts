import { ChangeSet, type Text } from "@codemirror/state";
import {
  ROOM_TEXT_MAX_BYTES,
  RoomTextError,
  applyRoomTextChange,
  assertUnicodeScalarString,
  changeSetFromWire,
  changeSetToWire,
  decodeRoomText,
  encodeRoomText,
  mapRoomTextAnchors,
  rebaseRoomTextChange,
  roomTextContentDigest,
  roomTextDigestOfString,
  roomTextUpdateToken,
  type RoomTextAnchor,
  type WireTextChange,
} from "./room-text";

export const ROOM_TEXT_PROTOCOL = 1 as const;
const MAX_CACHE_FILES = 32;
const MAX_SYNC_UPDATES = 256;
const MAX_SYNC_TAIL_BYTES = 1_000_000;
const MAX_PERSISTED_JSON_BYTES = 1_700_000;
const CHECKPOINT_EVERY_UPDATES = 128;
const CHECKPOINT_TAIL_BYTES = 256_000;
// With checkpoints at most 128 updates apart, retaining 384 at each checkpoint
// keeps the live sync window below 512 rows between floor advances.
const RETAIN_HISTORY_UPDATES = 384;
const RETAIN_HISTORY_BYTES = 8_000_000;
// History compaction below the floor. SOFT: documents under this size keep
// per-revision granularity — a full snapshot per revision costs R2 less than
// composition loses in attribution. HARD: larger documents compose
// consecutive same-client runs once this many ops or delta bytes accumulate
// strictly below the floor.
const SOFT_SNAPSHOT_DOC_BYTES = 8_000;
const HARD_COMPACT_MIN_UPDATES = 256;
const HARD_COMPACT_MIN_DELTA_BYTES = 64_000;
// Root-hash log window for diffDigest catch-up. A client whose remembered
// root fell out of this window gets the full listing (baseKnown false),
// mirroring how RESET_REQUIRED closes the bounded sync window.
const MAX_DIGEST_LOG_ROOTS = 256;
const persistedJsonEncoder = new TextEncoder();

// ── Group-commit lab instrumentation ────────────────────────────────────
// Monotonic full-document BLOB write counters (same pattern as
// roomTextHashedLeaves in room-text.ts): every statement that writes a
// whole-document blob adds its byte length here, so harnesses measure the
// PHYSICAL head-write amplification instead of inferring it. Counters tick
// at statement execution, so a rolled-back transaction still counts (SQLite
// performed the write before undoing it) — only crash tests notice.
let headBlobWrites = 0;
let headBlobBytes = 0;
let snapshotBlobWrites = 0;
let snapshotBlobBytes = 0;

export function roomTextStoreWriteStats(): {
  headBlobWrites: number;
  headBlobBytes: number;
  snapshotBlobWrites: number;
  snapshotBlobBytes: number;
} {
  return { headBlobWrites, headBlobBytes, snapshotBlobWrites, snapshotBlobBytes };
}

type FileRow = {
  file_id: string;
  path: string;
  epoch: number;
  head_revision: number;
  history_floor: number;
  snapshot_revision: number;
  snapshot_bytes: ArrayBuffer;
  snapshot_utf16_length: number;
  byte_length: number;
  recovery_tail_bytes: number;
};

type UpdateRow = {
  revision: number;
  base_revision: number;
  update_token: string;
  client_id: string;
  request_id: string;
  changes_json: string;
  before_utf16_length: number;
  after_utf16_length: number;
  byte_delta: number;
  after_byte_length: number;
  room_commit: number;
};

type RequestRow = {
  normalized_input: string;
  file_id: string;
  epoch: number;
  submitted_base_revision: number;
  revision: number;
};

type DigestRow = {
  file_id: string;
  path: string;
  content_hash: string;
  byte_length: number;
  revision: number;
  first_seq: number;
  last_seq: number;
  updated_at: number;
};

type CachedText = {
  fileId: string;
  path: string;
  epoch: number;
  revision: number;
  byteLength: number;
  doc: Text;
};

type HeadRow = {
  file_id: string;
  epoch: number;
  revision: number;
  content_bytes: ArrayBuffer;
  content_utf16_length: number;
};

/**
 * Per-file overlay state for one open push batch (group-commit prototype).
 * The files row advances per push inside the batch transaction, but the
 * heads row does not — this overlay carries the in-batch document between
 * pushes and everything finalizeDeferredHead needs at the batch boundary.
 */
type DeferredHead = {
  fileId: string;
  path: string;
  epoch: number;
  // heads-row revision when the batch first touched this file; the
  // optimistic WHERE clause of the single deferred head UPDATE.
  startHeadRevision: number;
  revision: number;
  byteLength: number;
  doc: Text;
  // Virtual checkpoint cadence (thresholds identical to pushText; the
  // physical snapshot write lands once, at the batch-final revision).
  snapshotRevision: number;
  pendingTailBytes: number;
  checkpointPending: boolean;
  now: number;
};

export type CreateRoomTextInput = {
  fileId: string;
  path: string;
  bytes: ArrayBuffer | ArrayBufferView;
};

export type OpenRoomTextResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      path: string;
      epoch: number;
      revision: number;
      byteLength: number;
      content: string;
    }
  | RoomTextFailure;

export type PushRoomTextInput = {
  protocol: typeof ROOM_TEXT_PROTOCOL;
  fileId: string;
  epoch: number;
  baseRevision: number;
  clientId: string;
  requestId: string;
  changes: readonly WireTextChange[];
  // Head-revision observer positions (open comment anchors) the host wants
  // mapped through the accepted update. Deliberately excluded from the
  // idempotency envelope: anchors are host-side state, not part of the
  // logical update, and a retry carries whatever snapshot the host has now.
  anchors?: readonly RoomTextAnchor[];
};

export type CanonicalRoomTextUpdate = {
  revision: number;
  parentRevision: number;
  clientId: string;
  requestId: string;
  changes: WireTextChange[];
};

export type PushRoomTextSuccess = {
  ok: true;
  protocol: typeof ROOM_TEXT_PROTOCOL;
  fileId: string;
  epoch: number;
  submittedBaseRevision: number;
  revision: number;
  roomCommit: number;
  byteLength: number;
  update: CanonicalRoomTextUpdate;
  // Present only when this call committed a NEW revision and the host sent
  // anchors: positions mapped through the canonical (rebased) ChangeSet with
  // assoc -1 for start / +1 for end. Idempotent replays omit it — the first
  // accept already reported the mapping, and re-mapping an already rewritten
  // anchor through the same update would double-shift it. The mapping itself
  // is pure and synchronous (mapRoomTextAnchors); the host wires the result
  // into DocumentCollab.remapCommentAnchors — this store never imports it.
  anchors?: RoomTextAnchor[];
  // Group-commit prototype: true when THIS call committed the revision
  // (fresh accept). Absent on idempotent replays and on the classic
  // pushText path. Lets a batch caller emit broadcast-vs-replay frames
  // without re-reading the head before every push.
  fresh?: boolean;
};

export type PushRoomTextResult = PushRoomTextSuccess | RoomTextFailure;

export type PullRoomTextResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      epoch: number;
      revision: number;
      updates: CanonicalRoomTextUpdate[];
    }
  | RoomTextFailure;

// Reconnect handshake. The client states what it already has; the SERVER
// chooses the hydration shape — never the client, which cannot know whether
// its last revision still sits inside the retained sync window.
export type ConnectRoomTextInput = {
  connectRequestId: string;
  protocolVersion: number;
  fileId: string;
  epoch: number;
  lastRevision: number;
};

export type ConnectRoomTextResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      connectRequestId: string;
      fileId: string;
      hydration: "delta";
      epoch: number;
      headRevision: number;
      updates: CanonicalRoomTextUpdate[];
    }
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      connectRequestId: string;
      fileId: string;
      hydration: "snapshot";
      epoch: number;
      headRevision: number;
      byteLength: number;
      doc: string;
    }
  | RoomTextFailure;

export type CompactHistoryResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      epoch: number;
      historyFloor: number;
      mode: "soft" | "idle" | "compacted";
      composedRows: number;
      belowFloorUpdates: number;
    }
  | RoomTextFailure;

// Host-facing artifact parts. snake_case fields mirror the R2 object layout:
// the host PUTs them (create-only) under
// rooms/<room>/.history/<file>/<epoch>@<revision>.
export type RoomTextVersionArtifact =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      path: string;
      epoch: number;
      revision: number;
      snapshot_bytes: ArrayBuffer;
      composed_changes_json: string;
    }
  | RoomTextFailure;

export type RoomTextHeadManifest =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      epoch: number;
      revision: number;
      manifestJson: string;
    }
  | RoomTextFailure;

/** The (epoch, revision) identity of one R2 publication (HEAD manifest). */
export type RoomTextPublication = { epoch: number; revision: number };

export type RoomTextPublicationDecision =
  | "publish" // candidate is strictly newer — write, paired with an etag CAS
  | "already-visible" // identical (epoch, revision) is published — no write
  | "stale" // a strictly newer publication is visible — never write
  | "unreadable"; // current HEAD does not parse — fail closed, never write

export type AdvanceFloorResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      fileId: string;
      epoch: number;
      historyFloor: number;
      prunedUpdates: number;
    }
  | RoomTextFailure;

/**
 * One durable dirty-set entry: a head mutation the flush janitor has not yet
 * published. The SET (one row per file) replaces the lab's scalar
 * "latest-dirty" pointer, which dropped every sibling file marked in the
 * same window.
 */
export type RoomTextDirtyEntry = {
  fileId: string;
  epoch: number;
  revision: number;
  markedAt: number;
};

/** One file's digest index entry, as reported to hosts. */
export type RoomTextFileDigest = {
  fileId: string;
  path: string;
  contentHash: string;
  byteLength: number;
  revision: number;
  updatedAt: number;
};

export type FileDigestResult =
  | ({ ok: true; protocol: typeof ROOM_TEXT_PROTOCOL } & RoomTextFileDigest)
  | RoomTextFailure;

export type RoomDigestResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      rootHash: string;
      fileCount: number;
    }
  | RoomTextFailure;

export type DiffDigestResult =
  | {
      ok: true;
      protocol: typeof ROOM_TEXT_PROTOCOL;
      rootHash: string;
      // False when the client's root fell out of the bounded root log (or
      // never existed): the diff is then relative to an empty room, so
      // `added` is the full listing — the explicit full-resync signal.
      baseKnown: boolean;
      changed: RoomTextFileDigest[];
      added: RoomTextFileDigest[];
      // Paths deleted since the client's root. Always empty today: the store
      // has no delete path yet; tombstone rows attach here when it grows one.
      removed: string[];
    }
  | RoomTextFailure;

export type RoomTextFailure = {
  ok: false;
  error:
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "ALREADY_EXISTS"
    | "EPOCH_MISMATCH"
    | "FUTURE_REVISION"
    | "RESET_REQUIRED"
    | "IDEMPOTENCY_MISMATCH"
    | "PROTOCOL_MISMATCH"
    | RoomTextError["code"];
  message?: string;
  epoch?: number;
  revision?: number;
  content?: string;
};

/**
 * Retryable failures are stale SYNC STATE: the client's picture of the file
 * is out of date and a re-hydration fixes it. Everything else is bad-args or
 * a server invariant — resubmitting the same update can never succeed.
 */
export function isRetryableRoomTextFailure(code: RoomTextFailure["error"]): boolean {
  return code === "EPOCH_MISMATCH" || code === "RESET_REQUIRED" || code === "FUTURE_REVISION";
}

/**
 * Fail-closed parse of a HEAD manifest's publication identity. Anything that
 * is not a JSON object carrying a valid (epoch >= 1, revision >= 0) integer
 * pair is null — an unreadable marker must block publication, not permit it.
 */
export function parseRoomTextPublication(manifestJson: string): RoomTextPublication | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { epoch, revision } = parsed as { epoch?: unknown; revision?: unknown };
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
  return { epoch, revision };
}

/**
 * Monotonic publication guard for the R2 HEAD flip — the fix for the
 * adversarial-probe regression where an older flush, resumed after an
 * arbitrary pause, CASed HEAD backward over a newer publication.
 *
 * (epoch, revision) is minted by the store's synchronous single-threaded
 * SQLite commits, so comparing the pair lexicographically IS comparing store
 * commit order — regardless of which async flush reaches R2 first, fires
 * twice, or resumes after a crash. The host makes this check atomic with the
 * write by reading HEAD ONCE, deciding against exactly that body, and
 * pairing "publish" with an etag CAS on that same read (create-only when
 * HEAD was absent). A lost CAS means another flush moved HEAD between the
 * read and the write: re-observe and re-decide — never blind-retry the PUT.
 * "stale" and "already-visible" perform no write; skipping is what makes an
 * arbitrarily delayed, reordered, or re-fired flush harmless.
 */
export function decideRoomTextPublication(
  currentManifestJson: string | null,
  candidate: RoomTextPublication,
): RoomTextPublicationDecision {
  if (currentManifestJson === null) return "publish";
  const current = parseRoomTextPublication(currentManifestJson);
  if (!current) return "unreadable";
  if (candidate.epoch !== current.epoch) {
    return candidate.epoch > current.epoch ? "publish" : "stale";
  }
  if (candidate.revision === current.revision) return "already-visible";
  return candidate.revision > current.revision ? "publish" : "stale";
}

/**
 * SQLite authority for collaborative text inside one room Durable Object.
 * The cache is intentionally disposable; every entry can be rebuilt from its
 * exact durable head BLOB. Canonical updates remain protocol history for
 * rebasing, reconnects, idempotency, anchors, and version export — never the
 * ordinary read path.
 */
export class RoomTextStore {
  private readonly cache = new Map<string, CachedText>();

  constructor(private readonly storage: DurableObjectStorage) {
    this.initializeSchema();
  }

  createText(input: CreateRoomTextInput): OpenRoomTextResult {
    try {
      const fileId = validateKey(input.fileId, "fileId");
      const path = validatePath(input.path);
      const source = exactBytes(input.bytes);
      if (source.byteLength > ROOM_TEXT_MAX_BYTES) {
        return { ok: false, error: "DOCUMENT_TOO_LARGE", message: `document exceeds ${ROOM_TEXT_MAX_BYTES} bytes` };
      }
      const doc = decodeRoomText(source);
      const now = Date.now();
      const bytes = exactArrayBuffer(source);
      const contentHash = roomTextContentDigest(doc, source.byteLength);

      try {
        this.storage.transactionSync(() => {
          this.storage.sql.exec(
            `INSERT INTO room_text_files (
               file_id, path, epoch, head_revision, history_floor,
               snapshot_revision, snapshot_bytes, snapshot_utf16_length,
               byte_length, recovery_tail_bytes, created_at, updated_at
             ) VALUES (?, ?, 1, 0, 0, 0, ?, ?, ?, 0, ?, ?)`,
            fileId, path, bytes, doc.length, source.byteLength, now, now,
          );
          this.storage.sql.exec(
            `INSERT INTO room_text_heads (
               file_id, epoch, revision, content_bytes,
               content_utf16_length, updated_at
             ) VALUES (?, 1, 0, ?, ?, ?)`,
            fileId, bytes, doc.length, now,
          );
          headBlobWrites++;
          headBlobBytes += source.byteLength;
          snapshotBlobWrites++;
          snapshotBlobBytes += source.byteLength;
          this.writeDigest(fileId, path, contentHash, source.byteLength, 0, now);
          this.markDirty(fileId, 1, 0);
        });
      } catch (error) {
        if (isSqlConstraint(error)) return { ok: false, error: "ALREADY_EXISTS" };
        throw error;
      }

      const entry: CachedText = { fileId, path, epoch: 1, revision: 0, byteLength: source.byteLength, doc };
      this.remember(entry);
      return this.openResult(entry);
    } catch (error) {
      return failureFrom(error);
    }
  }

  openText(fileIdInput: string): OpenRoomTextResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      return this.openResult(this.loadCurrent(row));
    } catch (error) {
      return failureFrom(error);
    }
  }

  pushText(input: PushRoomTextInput): PushRoomTextResult {
    try {
      const normalized = normalizePush(input);
      const deduped = this.storage.sql.exec<RequestRow>(
        `SELECT normalized_input, file_id, epoch,
                submitted_base_revision, revision
           FROM room_text_requests WHERE client_id = ? AND request_id = ?`,
        normalized.clientId, normalized.requestId,
      ).toArray()[0];
      if (deduped) {
        return deduped.normalized_input === normalized.json
          ? this.responseForRequest(deduped, normalized.clientId, normalized.requestId)
          : { ok: false, error: "IDEMPOTENCY_MISMATCH" };
      }

      const row = this.fileRow(normalized.fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const current = this.loadCurrent(row);
      if (normalized.epoch !== row.epoch) {
        return this.resetFailure("EPOCH_MISMATCH", current);
      }
      if (normalized.baseRevision > row.head_revision) {
        return { ok: false, error: "FUTURE_REVISION", epoch: row.epoch, revision: row.head_revision };
      }
      const lag = row.head_revision - normalized.baseRevision;
      if (normalized.baseRevision < row.history_floor || lag > MAX_SYNC_UPDATES
        || this.tailBytesAfter(row, normalized.baseRevision) > MAX_SYNC_TAIL_BYTES) {
        return this.resetFailure("RESET_REQUIRED", current);
      }

      const baseLength = this.lengthAtRevision(row, normalized.baseRevision);
      const submitted = changeSetFromWire(normalized.changes, baseLength);
      if (submitted.empty) {
        return { ok: false, error: "INVALID_CHANGE", message: "an update must change the document" };
      }
      const overRows = this.updateRows(normalized.fileId, row.epoch, normalized.baseRevision, row.head_revision);
      validateUpdateChain(overRows, normalized.baseRevision, baseLength, row.head_revision);
      const updateToken = roomTextUpdateToken(normalized.clientId, normalized.requestId);
      const canonical = rebaseRoomTextChange(
        submitted,
        updateToken,
        overRows.map((update) => ({
          updateToken: update.update_token,
          changes: parseStoredChangeSet(update),
        })),
      );
      const applied = applyRoomTextChange(current.doc, canonical, current.byteLength);
      const revision = row.head_revision + 1;
      const now = Date.now();
      const canonicalJson = JSON.stringify(canonical.toJSON());
      const canonicalJsonBytes = persistedJsonEncoder.encode(canonicalJson).byteLength;
      if (canonicalJsonBytes > MAX_PERSISTED_JSON_BYTES) {
        return { ok: false, error: "REQUEST_TOO_LARGE", message: "canonical update is too large to persist safely" };
      }
      const nextTailBytes = row.recovery_tail_bytes + canonicalJsonBytes;
      const shouldCheckpoint = revision - row.snapshot_revision >= CHECKPOINT_EVERY_UPDATES
        || nextTailBytes >= CHECKPOINT_TAIL_BYTES;
      // The durable head is the only cold-read representation. Reuse its
      // exact bytes at checkpoint boundaries so one update never encodes the
      // same document twice.
      const headBytes = encodeRoomText(applied.doc);
      const checkpointBytes = shouldCheckpoint ? headBytes : undefined;
      // Size-gated and pure: small docs hash their content string, large docs
      // reuse cached subtree digests and rehash only the dirty spine.
      const contentHash = roomTextContentDigest(applied.doc, applied.byteLength);

      let response!: PushRoomTextSuccess;
      this.storage.transactionSync(() => {
        // Recheck inside the transaction. This is redundant under normal DO
        // delivery but protects the helper's invariant if callers evolve.
        const existing = this.storage.sql.exec<RequestRow>(
          `SELECT normalized_input, file_id, epoch,
                  submitted_base_revision, revision
             FROM room_text_requests WHERE client_id = ? AND request_id = ?`,
          normalized.clientId, normalized.requestId,
        ).toArray()[0];
        if (existing) {
          if (existing.normalized_input !== normalized.json) {
            throw new IdempotencyMismatchError();
          }
          response = this.responseForRequest(existing, normalized.clientId, normalized.requestId);
          return;
        }

        const commit = this.storage.sql.exec<{ sequence: number }>(
          `INSERT INTO room_text_commits (client_id, request_id, created_at)
           VALUES (?, ?, ?) RETURNING sequence`,
          normalized.clientId, normalized.requestId, now,
        ).one().sequence;
        response = {
          ok: true,
          protocol: ROOM_TEXT_PROTOCOL,
          fileId: normalized.fileId,
          epoch: row.epoch,
          submittedBaseRevision: normalized.baseRevision,
          revision,
          roomCommit: commit,
          byteLength: applied.byteLength,
          update: {
            revision,
            parentRevision: row.head_revision,
            clientId: normalized.clientId,
            requestId: normalized.requestId,
            changes: changeSetToWire(canonical),
          },
          // Fresh accept only: map host anchors through the exact ChangeSet
          // that just moved the text. Pure and synchronous by construction.
          ...(Array.isArray(input.anchors)
            ? { anchors: mapRoomTextAnchors(canonical, input.anchors) }
            : {}),
        };
        this.storage.sql.exec(
          `INSERT INTO room_text_updates (
             file_id, epoch, revision, base_revision, update_token,
             client_id, request_id, changes_json, before_utf16_length,
             after_utf16_length, byte_delta, after_byte_length,
             room_commit, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          normalized.fileId, row.epoch, revision, normalized.baseRevision,
          updateToken, normalized.clientId, normalized.requestId,
          canonicalJson, current.doc.length, applied.doc.length,
          applied.byteDelta, applied.byteLength, commit, now,
        );
        const updated = checkpointBytes
          ? this.storage.sql.exec(
              `UPDATE room_text_files
                  SET head_revision = ?, byte_length = ?, snapshot_revision = ?,
                      snapshot_bytes = ?, snapshot_utf16_length = ?,
                      recovery_tail_bytes = 0, updated_at = ?
                WHERE file_id = ? AND epoch = ? AND head_revision = ?`,
              revision, applied.byteLength, revision, exactArrayBuffer(checkpointBytes),
              applied.doc.length, now, normalized.fileId, row.epoch, row.head_revision,
            )
          : this.storage.sql.exec(
              `UPDATE room_text_files
                  SET head_revision = ?, byte_length = ?, recovery_tail_bytes = ?,
                      updated_at = ?
                WHERE file_id = ? AND epoch = ? AND head_revision = ?`,
              revision, applied.byteLength, nextTailBytes, now,
              normalized.fileId, row.epoch, row.head_revision,
            );
        if (updated.rowsWritten !== 1) {
          throw new RoomTextError("STORAGE_CORRUPT", "file head changed during synchronous commit");
        }
        if (checkpointBytes) {
          snapshotBlobWrites++;
          snapshotBlobBytes += checkpointBytes.byteLength;
        }
        const headUpdated = this.storage.sql.exec(
          `UPDATE room_text_heads
              SET revision = ?, content_bytes = ?, content_utf16_length = ?,
                  updated_at = ?
            WHERE file_id = ? AND epoch = ? AND revision = ?`,
          revision, exactArrayBuffer(headBytes), applied.doc.length,
          now, normalized.fileId, row.epoch, row.head_revision,
        );
        if (headUpdated.rowsWritten !== 1) {
          throw new RoomTextError("STORAGE_CORRUPT", "durable head changed during synchronous commit");
        }
        headBlobWrites++;
        headBlobBytes += headBytes.byteLength;
        if (checkpointBytes) {
          const retainedFloor = this.retentionFloor(
            normalized.fileId,
            row.epoch,
            row.history_floor,
          );
          if (retainedFloor > row.history_floor) {
            // The floor closes the sync window: a client based below it gets
            // RESET_REQUIRED. Rows below the floor stay as cold history for
            // the flush janitor — compactHistory bounds their accumulation
            // and advanceFloorAfterFlush prunes them once R2 holds the
            // version artifact. Request pointers survive with their rows, so
            // a below-floor retry still dedupes until the flush.
            this.storage.sql.exec(
              "UPDATE room_text_files SET history_floor = ? WHERE file_id = ? AND epoch = ?",
              retainedFloor, normalized.fileId, row.epoch,
            );
          }
        }
        this.storage.sql.exec(
          `INSERT INTO room_text_requests (
             client_id, request_id, normalized_input, file_id, epoch,
             submitted_base_revision, revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          normalized.clientId, normalized.requestId, normalized.json,
          normalized.fileId, row.epoch, normalized.baseRevision, revision, now,
        );
        // Fresh accept only (replays returned above): the digest index and
        // root log move in the same transaction as the update they describe.
        this.writeDigest(normalized.fileId, row.path, contentHash, applied.byteLength, revision, now);
        this.markDirty(normalized.fileId, row.epoch, revision);
      });

      // Storage is authoritative. Only publish the new immutable cache root
      // after the transaction has committed successfully.
      if (response.revision === revision) {
        this.remember({
          fileId: normalized.fileId,
          path: row.path,
          epoch: row.epoch,
          revision,
          byteLength: applied.byteLength,
          doc: applied.doc,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof IdempotencyMismatchError) {
        return { ok: false, error: "IDEMPOTENCY_MISMATCH" };
      }
      return failureFrom(error);
    }
  }

  /**
   * Group-commit prototype (dependent-update-chain lab): commit N pushes
   * with ONE materialized-head encode + ONE room_text_heads blob write per
   * touched file, at the batch boundary. Everything else — canonical update
   * rows, idempotency records, commit sequencing, revision numbering, the
   * digest index and root log — is written per push exactly as pushText
   * writes it, so pulls/reconnects/replays observe identical state.
   *
   * Atomicity: the WHOLE batch runs inside one transactionSync, so crash
   * atomicity widens from per-push to per-batch — a thrown invariant error
   * rolls back every push in the batch (all-or-nothing; this is the one
   * semantic change vs. sequential pushText). Ordinary per-push REJECTIONS
   * (stale epoch, floor, bad args, idempotency mismatch) return failure
   * results without writes and never abort their siblings' commits.
   *
   * Checkpoint cadence: threshold crossings are tracked virtually per push;
   * the physical snapshot blob is written once at the batch boundary at the
   * batch-final revision (never staler than baseline's mid-batch cadence).
   */
  pushTextBatch(inputs: readonly PushRoomTextInput[]): PushRoomTextResult[] {
    const results: PushRoomTextResult[] = new Array(inputs.length);
    const deferred = new Map<string, DeferredHead>();
    try {
      this.storage.transactionSync(() => {
        for (let index = 0; index < inputs.length; index++) {
          results[index] = this.pushOneDeferred(inputs[index], deferred);
        }
        // Batch boundary: the single per-file head materialization.
        for (const state of deferred.values()) this.finalizeDeferredHead(state);
      });
    } catch (error) {
      // The batch rolled back as a unit. Nothing was published to the cache
      // mid-batch, but drop touched entries defensively so the next read
      // rebuilds from the durable (pre-batch) truth.
      for (const fileId of deferred.keys()) this.cache.delete(fileId);
      throw error;
    }
    // Storage is authoritative: publish cache roots only after commit.
    for (const state of deferred.values()) {
      this.remember({
        fileId: state.fileId,
        path: state.path,
        epoch: state.epoch,
        revision: state.revision,
        byteLength: state.byteLength,
        doc: state.doc,
      });
    }
    return results;
  }

  /**
   * One push inside an open batch transaction. Phase 1 (validate + plan)
   * performs NO writes, so its failures convert to per-push results. Phase 2
   * (writes) mirrors pushText's transaction body minus the head-row write;
   * a throw there is an invariant failure that must abort the whole batch.
   */
  private pushOneDeferred(
    input: PushRoomTextInput,
    deferred: Map<string, DeferredHead>,
  ): PushRoomTextResult {
    type Staged = {
      normalized: ReturnType<typeof normalizePush>;
      row: FileRow;
      state: DeferredHead | undefined;
      current: CachedText;
      canonical: ChangeSet;
      applied: { doc: Text; byteLength: number; byteDelta: number };
      revision: number;
      now: number;
      canonicalJson: string;
      canonicalJsonBytes: number;
      shouldCheckpoint: boolean;
      snapshotRevision: number;
      pendingTail: number;
      contentHash: string;
      updateToken: string;
    };
    let staged: Staged;
    try {
      const normalized = normalizePush(input);
      // Dedup runs inside THE batch transaction; earlier accepts in this
      // very batch are visible here, so an in-batch retry replays cleanly.
      const existing = this.storage.sql.exec<RequestRow>(
        `SELECT normalized_input, file_id, epoch,
                submitted_base_revision, revision
           FROM room_text_requests WHERE client_id = ? AND request_id = ?`,
        normalized.clientId, normalized.requestId,
      ).toArray()[0];
      if (existing) {
        return existing.normalized_input === normalized.json
          ? this.responseForRequest(existing, normalized.clientId, normalized.requestId)
          : { ok: false, error: "IDEMPOTENCY_MISMATCH" };
      }
      const row = this.fileRow(normalized.fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      // The files row already carries every in-batch revision (same
      // transaction), but the heads row is stale until the batch boundary:
      // the overlay entry — not loadCurrent — is the in-batch document.
      const state = deferred.get(normalized.fileId);
      const current: CachedText = state
        ? {
            fileId: state.fileId,
            path: state.path,
            epoch: state.epoch,
            revision: state.revision,
            byteLength: state.byteLength,
            doc: state.doc,
          }
        : this.loadCurrent(row);
      if (normalized.epoch !== row.epoch) {
        return this.resetFailure("EPOCH_MISMATCH", current);
      }
      if (normalized.baseRevision > row.head_revision) {
        return { ok: false, error: "FUTURE_REVISION", epoch: row.epoch, revision: row.head_revision };
      }
      const lag = row.head_revision - normalized.baseRevision;
      if (normalized.baseRevision < row.history_floor || lag > MAX_SYNC_UPDATES
        || this.tailBytesAfter(row, normalized.baseRevision) > MAX_SYNC_TAIL_BYTES) {
        return this.resetFailure("RESET_REQUIRED", current);
      }
      // current.revision === row.head_revision in both overlay and cold
      // paths, so lengthAtRevision never takes its loadCurrent head branch
      // (which would read the stale heads row mid-batch).
      const baseLength = normalized.baseRevision === current.revision
        ? current.doc.length
        : this.lengthAtRevision(row, normalized.baseRevision);
      const submitted = changeSetFromWire(normalized.changes, baseLength);
      if (submitted.empty) {
        return { ok: false, error: "INVALID_CHANGE", message: "an update must change the document" };
      }
      const overRows = this.updateRows(normalized.fileId, row.epoch, normalized.baseRevision, row.head_revision);
      validateUpdateChain(overRows, normalized.baseRevision, baseLength, row.head_revision);
      const updateToken = roomTextUpdateToken(normalized.clientId, normalized.requestId);
      const canonical = rebaseRoomTextChange(
        submitted,
        updateToken,
        overRows.map((update) => ({
          updateToken: update.update_token,
          changes: parseStoredChangeSet(update),
        })),
      );
      const applied = applyRoomTextChange(current.doc, canonical, current.byteLength);
      const revision = row.head_revision + 1;
      const canonicalJson = JSON.stringify(canonical.toJSON());
      const canonicalJsonBytes = persistedJsonEncoder.encode(canonicalJson).byteLength;
      if (canonicalJsonBytes > MAX_PERSISTED_JSON_BYTES) {
        return { ok: false, error: "REQUEST_TOO_LARGE", message: "canonical update is too large to persist safely" };
      }
      // Virtual checkpoint cadence: identical thresholds to pushText, but
      // the physical snapshot write happens once at the batch boundary.
      const snapshotRevision = state ? state.snapshotRevision : row.snapshot_revision;
      const pendingTail = (state ? state.pendingTailBytes : row.recovery_tail_bytes) + canonicalJsonBytes;
      const shouldCheckpoint = revision - snapshotRevision >= CHECKPOINT_EVERY_UPDATES
        || pendingTail >= CHECKPOINT_TAIL_BYTES;
      const contentHash = roomTextContentDigest(applied.doc, applied.byteLength);
      staged = {
        normalized, row, state, current, canonical, applied, revision,
        now: Date.now(), canonicalJson, canonicalJsonBytes,
        shouldCheckpoint, snapshotRevision, pendingTail, contentHash, updateToken,
      };
    } catch (error) {
      // No writes have happened for this push; convert exactly as pushText
      // would. failureFrom rethrows unknown errors, aborting the batch.
      return failureFrom(error);
    }

    // ── Phase 2: writes (any throw below aborts the whole batch) ──
    const { normalized, row, applied, revision, now } = staged;
    const commit = this.storage.sql.exec<{ sequence: number }>(
      `INSERT INTO room_text_commits (client_id, request_id, created_at)
       VALUES (?, ?, ?) RETURNING sequence`,
      normalized.clientId, normalized.requestId, now,
    ).one().sequence;
    const response: PushRoomTextSuccess = {
      ok: true,
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: normalized.fileId,
      epoch: row.epoch,
      submittedBaseRevision: normalized.baseRevision,
      revision,
      roomCommit: commit,
      byteLength: applied.byteLength,
      update: {
        revision,
        parentRevision: row.head_revision,
        clientId: normalized.clientId,
        requestId: normalized.requestId,
        changes: changeSetToWire(staged.canonical),
      },
      ...(Array.isArray(input.anchors)
        ? { anchors: mapRoomTextAnchors(staged.canonical, input.anchors) }
        : {}),
      fresh: true,
    };
    this.storage.sql.exec(
      `INSERT INTO room_text_updates (
         file_id, epoch, revision, base_revision, update_token,
         client_id, request_id, changes_json, before_utf16_length,
         after_utf16_length, byte_delta, after_byte_length,
         room_commit, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      normalized.fileId, row.epoch, revision, normalized.baseRevision,
      staged.updateToken, normalized.clientId, normalized.requestId,
      staged.canonicalJson, staged.current.doc.length, applied.doc.length,
      applied.byteDelta, applied.byteLength, commit, now,
    );
    // Small-column head advance only; content blobs wait for the boundary.
    // recovery_tail_bytes mirrors the virtual cadence so the durable value
    // is correct if this batch never crosses a checkpoint threshold.
    const updated = this.storage.sql.exec(
      `UPDATE room_text_files
          SET head_revision = ?, byte_length = ?, recovery_tail_bytes = ?,
              updated_at = ?
        WHERE file_id = ? AND epoch = ? AND head_revision = ?`,
      revision, applied.byteLength, staged.shouldCheckpoint ? 0 : staged.pendingTail, now,
      normalized.fileId, row.epoch, row.head_revision,
    );
    if (updated.rowsWritten !== 1) {
      throw new RoomTextError("STORAGE_CORRUPT", "file head changed during batched commit");
    }
    this.storage.sql.exec(
      `INSERT INTO room_text_requests (
         client_id, request_id, normalized_input, file_id, epoch,
         submitted_base_revision, revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      normalized.clientId, normalized.requestId, normalized.json,
      normalized.fileId, row.epoch, normalized.baseRevision, revision, now,
    );
    this.writeDigest(normalized.fileId, row.path, staged.contentHash, applied.byteLength, revision, now);
    this.markDirty(normalized.fileId, row.epoch, revision);
    deferred.set(normalized.fileId, {
      fileId: normalized.fileId,
      path: row.path,
      epoch: row.epoch,
      startHeadRevision: staged.state ? staged.state.startHeadRevision : row.head_revision,
      revision,
      byteLength: applied.byteLength,
      doc: applied.doc,
      snapshotRevision: staged.shouldCheckpoint ? revision : staged.snapshotRevision,
      pendingTailBytes: staged.shouldCheckpoint ? 0 : staged.pendingTail,
      checkpointPending: (staged.state?.checkpointPending ?? false) || staged.shouldCheckpoint,
      now,
    });
    return response;
  }

  /**
   * The batch-boundary head materialization: ONE encode of the final doc,
   * ONE room_text_heads blob write per file, plus the deferred checkpoint
   * (snapshot at the batch-final revision) when a threshold was crossed.
   */
  private finalizeDeferredHead(state: DeferredHead): void {
    const headBytes = encodeRoomText(state.doc);
    if (headBytes.byteLength !== state.byteLength) {
      throw new RoomTextError("STORAGE_CORRUPT", "deferred head byte length diverged from tracked state");
    }
    const headBuffer = exactArrayBuffer(headBytes);
    const headUpdated = this.storage.sql.exec(
      `UPDATE room_text_heads
          SET revision = ?, content_bytes = ?, content_utf16_length = ?,
              updated_at = ?
        WHERE file_id = ? AND epoch = ? AND revision = ?`,
      state.revision, headBuffer, state.doc.length,
      state.now, state.fileId, state.epoch, state.startHeadRevision,
    );
    if (headUpdated.rowsWritten !== 1) {
      throw new RoomTextError("STORAGE_CORRUPT", "durable head changed during batched commit");
    }
    headBlobWrites++;
    headBlobBytes += headBytes.byteLength;
    if (!state.checkpointPending) return;
    const row = this.fileRow(state.fileId);
    if (!row || row.epoch !== state.epoch || row.head_revision !== state.revision) {
      throw new RoomTextError("STORAGE_CORRUPT", "file row diverged during batched checkpoint");
    }
    const checkpointed = this.storage.sql.exec(
      `UPDATE room_text_files
          SET snapshot_revision = ?, snapshot_bytes = ?,
              snapshot_utf16_length = ?, recovery_tail_bytes = 0,
              updated_at = ?
        WHERE file_id = ? AND epoch = ? AND head_revision = ?`,
      state.revision, headBuffer, state.doc.length, state.now,
      state.fileId, state.epoch, state.revision,
    );
    if (checkpointed.rowsWritten !== 1) {
      throw new RoomTextError("STORAGE_CORRUPT", "file head changed during batched checkpoint");
    }
    snapshotBlobWrites++;
    snapshotBlobBytes += headBytes.byteLength;
    const retainedFloor = this.retentionFloor(state.fileId, state.epoch, row.history_floor);
    if (retainedFloor > row.history_floor) {
      this.storage.sql.exec(
        "UPDATE room_text_files SET history_floor = ? WHERE file_id = ? AND epoch = ?",
        retainedFloor, state.fileId, state.epoch,
      );
    }
  }

  pullText(fileIdInput: string, epoch: number, afterRevision: number): PullRoomTextResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(afterRevision) || afterRevision < 0) {
        return { ok: false, error: "INVALID_REQUEST" };
      }
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const current = this.loadCurrent(row);
      if (epoch !== row.epoch) return this.resetFailure("EPOCH_MISMATCH", current);
      if (afterRevision > row.head_revision) {
        return { ok: false, error: "FUTURE_REVISION", epoch: row.epoch, revision: row.head_revision };
      }
      if (afterRevision < row.history_floor || row.head_revision - afterRevision > MAX_SYNC_UPDATES
        || this.tailBytesAfter(row, afterRevision) > MAX_SYNC_TAIL_BYTES) {
        return this.resetFailure("RESET_REQUIRED", current);
      }
      const updates = this.updateRows(fileId, row.epoch, afterRevision, row.head_revision);
      const baseLength = this.lengthAtRevision(row, afterRevision);
      validateUpdateChain(updates, afterRevision, baseLength, row.head_revision);
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        epoch: row.epoch,
        revision: row.head_revision,
        updates: updates.map(toCanonicalUpdate),
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Reconnect handshake: the SERVER chooses the hydration shape. Delta — a
   * range read over the existing canonical update rows — only when the
   * client's epoch matches and its last revision still sits inside the
   * bounded sync window at or above history_floor. Anything else (stale
   * epoch, below the floor, ahead of head, oversized tail) falls back to a
   * full snapshot; a reconnect must never fail for being too far behind.
   * An unknown protocol version is refused outright so the host can send an
   * explicit incompatibility frame instead of updates the client cannot
   * decode.
   */
  connectText(input: ConnectRoomTextInput): ConnectRoomTextResult {
    try {
      if (!input || !Number.isSafeInteger(input.protocolVersion) || !Number.isSafeInteger(input.epoch)
        || !Number.isSafeInteger(input.lastRevision) || input.lastRevision < 0) {
        return { ok: false, error: "INVALID_REQUEST" };
      }
      const connectRequestId = validateKey(input.connectRequestId, "connectRequestId");
      const fileId = validateKey(input.fileId, "fileId");
      if (input.protocolVersion !== ROOM_TEXT_PROTOCOL) {
        return {
          ok: false,
          error: "PROTOCOL_MISMATCH",
          message: `server speaks room-text protocol ${ROOM_TEXT_PROTOCOL}, client sent ${input.protocolVersion}`,
        };
      }
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      if (input.epoch === row.epoch && input.lastRevision >= row.history_floor
        && input.lastRevision <= row.head_revision
        && row.head_revision - input.lastRevision <= MAX_SYNC_UPDATES
        && this.tailBytesAfter(row, input.lastRevision) <= MAX_SYNC_TAIL_BYTES) {
        const updates = this.updateRows(fileId, row.epoch, input.lastRevision, row.head_revision);
        validateUpdateChain(updates, input.lastRevision, this.lengthAtRevision(row, input.lastRevision), row.head_revision);
        return {
          ok: true,
          protocol: ROOM_TEXT_PROTOCOL,
          connectRequestId,
          fileId,
          hydration: "delta",
          epoch: row.epoch,
          headRevision: row.head_revision,
          updates: updates.map(toCanonicalUpdate),
        };
      }
      const current = this.loadCurrent(row);
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        connectRequestId,
        fileId,
        hydration: "snapshot",
        epoch: row.epoch,
        headRevision: current.revision,
        byteLength: current.byteLength,
        doc: current.doc.toString(),
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /** Replace the recovery snapshot at the current generation; keep history. */
  checkpointText(fileIdInput: string): OpenRoomTextResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const current = this.loadCurrent(row);
      const bytes = encodeRoomText(current.doc);
      if (bytes.byteLength !== current.byteLength) {
        throw new RoomTextError("STORAGE_CORRUPT", "cache byte length does not match checkpoint bytes");
      }
      const snapshot = exactArrayBuffer(bytes);
      this.storage.transactionSync(() => {
        const updated = this.storage.sql.exec(
          `UPDATE room_text_files
              SET snapshot_revision = ?, snapshot_bytes = ?,
                  snapshot_utf16_length = ?, recovery_tail_bytes = 0,
                  updated_at = ?
            WHERE file_id = ? AND epoch = ? AND head_revision = ?`,
          current.revision, snapshot, current.doc.length, Date.now(),
          fileId, current.epoch, current.revision,
        );
        if (updated.rowsWritten !== 1) {
          throw new RoomTextError("STORAGE_CORRUPT", "file changed during synchronous checkpoint");
        }
        snapshotBlobWrites++;
        snapshotBlobBytes += snapshot.byteLength;
      });
      return this.openResult(current);
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Compose consecutive same-client canonical updates STRICTLY below the
   * history floor. Rows at or above the floor are never rewritten: rebase
   * confirms in-window updates by update_token (rebaseUpdates clientID), so
   * composing the live window would corrupt client reconciliation (the
   * NOTES.md invariant). Idempotent: a pass leaves only maximal runs, so a
   * re-fired janitor composes nothing and re-exports byte-identical history.
   */
  compactHistory(fileIdInput: string): CompactHistoryResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const below = this.storage.sql.exec<UpdateRow & { created_at: number }>(
        `SELECT revision, base_revision, update_token, client_id, request_id,
                changes_json, before_utf16_length, after_utf16_length,
                byte_delta, after_byte_length, room_commit, created_at
           FROM room_text_updates
          WHERE file_id = ? AND epoch = ? AND revision < ?
          ORDER BY revision`,
        fileId, row.epoch, row.history_floor,
      ).toArray();
      const done = (mode: "soft" | "idle" | "compacted", composedRows: number, belowFloorUpdates: number): CompactHistoryResult => ({
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        epoch: row.epoch,
        historyFloor: row.history_floor,
        mode,
        composedRows,
        belowFloorUpdates,
      });
      if (row.byte_length < SOFT_SNAPSHOT_DOC_BYTES) return done("soft", 0, below.length);
      const belowBytes = below.reduce(
        (total, update) => total + persistedJsonEncoder.encode(update.changes_json).byteLength,
        0,
      );
      if (below.length <= HARD_COMPACT_MIN_UPDATES && belowBytes <= HARD_COMPACT_MIN_DELTA_BYTES) {
        return done("idle", 0, below.length);
      }

      // Group chain-adjacent rows by client. List order is chain order:
      // pruning removes prefixes and composition preserves adjacency, so a
      // UTF-16 length discontinuity below the floor is storage corruption.
      const runs: Array<Array<UpdateRow & { created_at: number }>> = [];
      for (const update of below) {
        const run = runs[runs.length - 1];
        const last = run?.[run.length - 1];
        if (last && update.before_utf16_length !== last.after_utf16_length) {
          throw new RoomTextError("STORAGE_CORRUPT", `history chain breaks at revision ${update.revision}`);
        }
        if (last && last.client_id === update.client_id) run.push(update);
        else runs.push([update]);
      }

      let removed = 0;
      let composedRows = 0;
      this.storage.transactionSync(() => {
        for (const run of runs) {
          if (run.length < 2) continue;
          const first = run[0];
          const last = run[run.length - 1];
          let changes = parseStoredChangeSet(first);
          for (let index = 1; index < run.length; index++) {
            changes = changes.compose(parseStoredChangeSet(run[index]));
          }
          if (changes.length !== first.before_utf16_length || changes.newLength !== last.after_utf16_length) {
            throw new RoomTextError("STORAGE_CORRUPT", `composed run at revision ${last.revision} changed its endpoints`);
          }
          this.storage.sql.exec(
            `DELETE FROM room_text_updates
              WHERE file_id = ? AND epoch = ? AND revision >= ? AND revision <= ?`,
            fileId, row.epoch, first.revision, last.revision,
          );
          // base_revision below the floor is attribution metadata only; the
          // replay chain is defined by row order and length continuity.
          this.storage.sql.exec(
            `INSERT INTO room_text_updates (
               file_id, epoch, revision, base_revision, update_token,
               client_id, request_id, changes_json, before_utf16_length,
               after_utf16_length, byte_delta, after_byte_length,
               room_commit, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            fileId, row.epoch, last.revision, first.base_revision,
            last.update_token, last.client_id, last.request_id,
            JSON.stringify(changes.toJSON()), first.before_utf16_length,
            last.after_utf16_length,
            run.reduce((total, update) => total + update.byte_delta, 0),
            last.after_byte_length, last.room_commit, last.created_at,
          );
          removed += run.length;
          composedRows++;
        }
        // Dedup pointers into rewritten history go with their rows: a retry
        // below the floor now takes the RESET_REQUIRED path instead of
        // resolving against a revision that no longer exists verbatim.
        this.storage.sql.exec(
          `DELETE FROM room_text_requests
            WHERE file_id = ? AND epoch = ? AND revision < ?`,
          fileId, row.epoch, row.history_floor,
        );
        this.storage.sql.exec(
          `DELETE FROM room_text_commits
            WHERE sequence NOT IN (SELECT room_commit FROM room_text_updates)`,
        );
      });
      return done("compacted", composedRows, below.length - removed + composedRows);
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Everything the host needs to persist one version to R2 under
   * rooms/<room>/.history/<file>/<epoch>@<revision>. Deterministic — no
   * clocks, no randomness — so identical store state yields byte-identical
   * artifacts and a re-fired alarm can safely re-PUT (or create-only skip).
   * composed_changes_json carries every retained update at or below the
   * artifact revision; readers replay entries with revision greater than
   * their base snapshot's, so consecutive artifacts chain byte-exactly.
   */
  exportVersionArtifact(fileIdInput: string): RoomTextVersionArtifact {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const rows = this.updateRows(fileId, row.epoch, -1, row.snapshot_revision);
      const entries = rows.map((update) => ({
        revision: update.revision,
        clientId: update.client_id,
        requestId: update.request_id,
        afterByteLength: update.after_byte_length,
        changes: parseStoredChangeSet(update).toJSON() as unknown,
      }));
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        path: row.path,
        epoch: row.epoch,
        revision: row.snapshot_revision,
        snapshot_bytes: row.snapshot_bytes,
        composed_changes_json: JSON.stringify(entries),
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * The tiny JSON whose R2 etag-CAS flip is the atomic visibility switch for
   * the artifact above. Deterministic for the same revision, so a re-fired
   * alarm compares equal against the already-flipped HEAD and skips the CAS.
   */
  buildHeadManifest(fileIdInput: string): RoomTextHeadManifest {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const manifestJson = JSON.stringify({
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        path: row.path,
        epoch: row.epoch,
        revision: row.snapshot_revision,
        byteLength: row.snapshot_bytes.byteLength,
        artifact: `${row.epoch}@${row.snapshot_revision}`,
      });
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        epoch: row.epoch,
        revision: row.snapshot_revision,
        manifestJson,
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * After the host has durably PUT the artifact for `revision` and flipped
   * (or monotonically skipped) HEAD, drop the local history it covers. The floor may not pass the
   * recovery snapshot (cold replay needs the snapshot-to-head tail), and a
   * revision at or below the current floor is a completed flush — no-op, so
   * alarm re-fires are safe.
   */
  advanceFloorAfterFlush(fileIdInput: string, revision: number): AdvanceFloorResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      if (!Number.isSafeInteger(revision) || revision < 0) {
        return { ok: false, error: "INVALID_REQUEST" };
      }
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      if (revision > row.snapshot_revision) {
        return { ok: false, error: "INVALID_REQUEST", message: "floor cannot pass the recovery snapshot" };
      }
      const done = (historyFloor: number, prunedUpdates: number): AdvanceFloorResult => ({
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        fileId,
        epoch: row.epoch,
        historyFloor,
        prunedUpdates,
      });
      if (revision <= row.history_floor) return done(row.history_floor, 0);
      let pruned = 0;
      this.storage.transactionSync(() => {
        const updated = this.storage.sql.exec(
          "UPDATE room_text_files SET history_floor = ?, updated_at = ? WHERE file_id = ? AND epoch = ? AND history_floor = ?",
          revision, Date.now(), fileId, row.epoch, row.history_floor,
        );
        if (updated.rowsWritten !== 1) {
          throw new RoomTextError("STORAGE_CORRUPT", "history floor changed during synchronous flush advance");
        }
        pruned = this.pruneBelowFloor(fileId, row.epoch, revision);
      });
      return done(revision, pruned);
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * Oldest-marked dirty files, up to `limit`. The dirty set is the flush
   * janitor's durable work queue: rows are upserted inside the SAME
   * synchronous transaction as the head mutation they describe (createText /
   * pushText / pushTextBatch), so a crash can never lose a mark and no file
   * can shadow another's pending flush.
   */
  dirtyFiles(limit: number): RoomTextDirtyEntry[] {
    const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
    return this.storage.sql.exec<{ file_id: string; epoch: number; revision: number; marked_at: number }>(
      `SELECT file_id, epoch, revision, marked_at
         FROM room_text_dirty
        ORDER BY marked_at ASC
        LIMIT ?`,
      capped,
    ).toArray().map((row) => ({
      fileId: row.file_id,
      epoch: row.epoch,
      revision: row.revision,
      markedAt: row.marked_at,
    }));
  }

  /**
   * Retire a dirty mark ONLY up to the published revision: a mark minted by
   * a newer head mutation (row revision > publishedRevision) must survive a
   * flush of the older state, or an edit landing mid-flush would silently
   * never publish. Returns the number of rows cleared (0 or 1).
   */
  clearDirty(fileIdInput: string, publishedRevision: number): number {
    let fileId: string;
    try {
      fileId = validateKey(fileIdInput, "fileId");
    } catch {
      return 0;
    }
    if (!Number.isSafeInteger(publishedRevision) || publishedRevision < 0) return 0;
    return this.storage.sql.exec(
      "DELETE FROM room_text_dirty WHERE file_id = ? AND revision <= ?",
      fileId, publishedRevision,
    ).rowsWritten;
  }

  /** The maintained digest row for one file; never recomputed on read. */
  digestOf(fileIdInput: string): FileDigestResult {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.storage.sql.exec<DigestRow>(
        `SELECT file_id, path, content_hash, byte_length, revision,
                first_seq, last_seq, updated_at
           FROM room_text_digests WHERE file_id = ?`,
        fileId,
      ).toArray()[0];
      if (!row) return { ok: false, error: "NOT_FOUND" };
      return { ok: true, protocol: ROOM_TEXT_PROTOCOL, ...toFileDigest(row) };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /** Room root hash over every file digest, ordered by path. */
  roomDigest(): RoomDigestResult {
    try {
      const rows = this.digestRows();
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        rootHash: rootHashOf(rows),
        fileCount: rows.length,
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /**
   * The O(changed) agent-catchup read: given the room root a client last
   * synced, return exactly the files whose digests moved since. The root log
   * maps that root to its digest sequence; per-file first_seq/last_seq split
   * the answer into added and changed without touching unchanged rows'
   * content. An unknown or expired root diffs against the empty room.
   */
  diffDigest(clientRootHash: string): DiffDigestResult {
    try {
      if (typeof clientRootHash !== "string" || clientRootHash.length > 64) {
        return { ok: false, error: "INVALID_REQUEST", message: "client root hash is invalid" };
      }
      const rows = this.digestRows();
      const rootHash = rootHashOf(rows);
      const empty = { changed: [], added: [], removed: [] };
      if (clientRootHash === rootHash) {
        return { ok: true, protocol: ROOM_TEXT_PROTOCOL, rootHash, baseKnown: true, ...empty };
      }
      // A root can recur when content reverts exactly; the latest occurrence
      // yields the smallest correct diff.
      const logged = this.storage.sql.exec<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM room_text_digest_log WHERE root_hash = ?",
        clientRootHash,
      ).one().seq;
      const baseSeq = logged ?? -1;
      const changed: RoomTextFileDigest[] = [];
      const added: RoomTextFileDigest[] = [];
      for (const row of rows) {
        if (row.last_seq <= baseSeq) continue;
        (row.first_seq > baseSeq ? added : changed).push(toFileDigest(row));
      }
      return {
        ok: true,
        protocol: ROOM_TEXT_PROTOCOL,
        rootHash,
        baseKnown: logged !== null,
        changed,
        added,
        removed: [],
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  /** Probe/test hook: simulates hibernation without changing durable state. */
  clearCache(): void {
    this.cache.clear();
  }

  inspect(fileIdInput: string): Record<string, number> | RoomTextFailure {
    try {
      const fileId = validateKey(fileIdInput, "fileId");
      const row = this.fileRow(fileId);
      if (!row) return { ok: false, error: "NOT_FOUND" };
      const updateCount = this.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM room_text_updates WHERE file_id = ? AND epoch = ?",
        fileId, row.epoch,
      ).one().count;
      const belowFloorUpdates = this.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM room_text_updates WHERE file_id = ? AND epoch = ? AND revision < ?",
        fileId, row.epoch, row.history_floor,
      ).one().count;
      return {
        epoch: row.epoch,
        revision: row.head_revision,
        snapshotRevision: row.snapshot_revision,
        historyFloor: row.history_floor,
        byteLength: row.byte_length,
        recoveryTailBytes: row.recovery_tail_bytes,
        updateCount,
        belowFloorUpdates,
        cacheEntries: this.cache.size,
      };
    } catch (error) {
      return failureFrom(error);
    }
  }

  private initializeSchema(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_text_files (
        file_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        epoch INTEGER NOT NULL,
        head_revision INTEGER NOT NULL,
        history_floor INTEGER NOT NULL,
        snapshot_revision INTEGER NOT NULL,
        snapshot_bytes BLOB NOT NULL,
        snapshot_utf16_length INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        recovery_tail_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (head_revision >= snapshot_revision),
        CHECK (snapshot_revision >= history_floor),
        CHECK (byte_length >= 0)
      );
      CREATE TABLE IF NOT EXISTS room_text_updates (
        file_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        base_revision INTEGER NOT NULL,
        update_token TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        before_utf16_length INTEGER NOT NULL,
        after_utf16_length INTEGER NOT NULL,
        byte_delta INTEGER NOT NULL,
        after_byte_length INTEGER NOT NULL,
        room_commit INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, epoch, revision),
        UNIQUE (file_id, epoch, update_token)
      );
      CREATE INDEX IF NOT EXISTS room_text_updates_pull_idx
        ON room_text_updates(file_id, epoch, revision);
      CREATE TABLE IF NOT EXISTS room_text_requests (
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        normalized_input TEXT NOT NULL,
        file_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        submitted_base_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS room_text_commits (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_text_digests (
        file_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_text_digest_log (
        seq INTEGER PRIMARY KEY,
        root_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS room_text_digest_log_root_idx
        ON room_text_digest_log(root_hash);
      CREATE TABLE IF NOT EXISTS room_text_heads (
        file_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        content_bytes BLOB NOT NULL,
        content_utf16_length INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (epoch >= 1),
        CHECK (revision >= 0),
        CHECK (content_utf16_length >= 0)
      );
      CREATE TABLE IF NOT EXISTS room_text_dirty (
        file_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        marked_at INTEGER NOT NULL,
        CHECK (epoch >= 1),
        CHECK (revision >= 0)
      );
    `);
    // Seed the pre-mutation root so a client that synced the empty room
    // still gets an O(changed) diff once files appear.
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO room_text_digest_log (seq, root_hash, created_at) VALUES (0, ?, 0)",
      rootHashOf([]),
    );
  }

  private fileRow(fileId: string): FileRow | undefined {
    return this.storage.sql.exec<FileRow>(
      `SELECT file_id, path, epoch, head_revision, history_floor,
              snapshot_revision, snapshot_bytes, snapshot_utf16_length,
              byte_length, recovery_tail_bytes
         FROM room_text_files WHERE file_id = ?`,
      fileId,
    ).toArray()[0];
  }

  private updateRows(fileId: string, epoch: number, afterRevision: number, throughRevision: number): UpdateRow[] {
    return this.storage.sql.exec<UpdateRow>(
      `SELECT revision, base_revision, update_token, client_id, request_id,
              changes_json, before_utf16_length, after_utf16_length,
              byte_delta, after_byte_length, room_commit
         FROM room_text_updates
        WHERE file_id = ? AND epoch = ? AND revision > ? AND revision <= ?
        ORDER BY revision`,
      fileId, epoch, afterRevision, throughRevision,
    ).toArray();
  }

  private loadCurrent(row: FileRow): CachedText {
    const cached = this.cache.get(row.file_id);
    if (cached && cached.epoch === row.epoch && cached.revision === row.head_revision
      && cached.byteLength === row.byte_length) {
      this.remember(cached);
      return cached;
    }

    const head = this.storage.sql.exec<HeadRow>(
      `SELECT file_id, epoch, revision, content_bytes, content_utf16_length
         FROM room_text_heads WHERE file_id = ?`,
      row.file_id,
    ).toArray()[0];
    if (!head || head.epoch !== row.epoch || head.revision !== row.head_revision
      || head.content_bytes.byteLength !== row.byte_length) {
      throw new RoomTextError("STORAGE_CORRUPT", "durable head does not match authoritative file metadata");
    }
    const doc = decodeRoomText(head.content_bytes);
    if (doc.length !== head.content_utf16_length) {
      throw new RoomTextError("STORAGE_CORRUPT", "durable head UTF-16 length is inconsistent");
    }
    const entry: CachedText = {
      fileId: row.file_id,
      path: row.path,
      epoch: row.epoch,
      revision: row.head_revision,
      byteLength: row.byte_length,
      doc,
    };
    this.remember(entry);
    return entry;
  }

  private lengthAtRevision(row: FileRow, revision: number): number {
    if (revision === row.head_revision) return this.loadCurrent(row).doc.length;
    if (revision === row.snapshot_revision) return row.snapshot_utf16_length;
    if (revision === 0) {
      const first = this.storage.sql.exec<{ before_utf16_length: number }>(
        `SELECT before_utf16_length FROM room_text_updates
          WHERE file_id = ? AND epoch = ? AND revision = 1`,
        row.file_id, row.epoch,
      ).toArray()[0];
      if (first) return first.before_utf16_length;
    } else {
      const update = this.storage.sql.exec<{ after_utf16_length: number }>(
        `SELECT after_utf16_length FROM room_text_updates
          WHERE file_id = ? AND epoch = ? AND revision = ?`,
        row.file_id, row.epoch, revision,
      ).toArray()[0];
      if (update) return update.after_utf16_length;
    }
    throw new RoomTextError("STORAGE_CORRUPT", `length for revision ${revision} is unavailable`);
  }

  private tailBytesAfter(row: FileRow, revision: number): number {
    return this.storage.sql.exec<{ total: number | null }>(
      `SELECT SUM(length(CAST(changes_json AS BLOB))) AS total
         FROM room_text_updates
        WHERE file_id = ? AND epoch = ? AND revision > ? AND revision <= ?`,
      row.file_id, row.epoch, revision, row.head_revision,
    ).one().total ?? 0;
  }

  private responseForRequest(
    request: RequestRow,
    clientId: string,
    requestId: string,
  ): PushRoomTextSuccess {
    const update = this.storage.sql.exec<UpdateRow>(
      `SELECT revision, base_revision, update_token, client_id, request_id,
              changes_json, before_utf16_length, after_utf16_length,
              byte_delta, after_byte_length, room_commit
         FROM room_text_updates
        WHERE file_id = ? AND epoch = ? AND revision = ?`,
      request.file_id, request.epoch, request.revision,
    ).toArray()[0];
    if (!update || update.client_id !== clientId || update.request_id !== requestId
      || update.base_revision !== request.submitted_base_revision) {
      throw new RoomTextError("STORAGE_CORRUPT", "idempotency pointer does not match its canonical update");
    }
    return {
      ok: true,
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: request.file_id,
      epoch: request.epoch,
      submittedBaseRevision: request.submitted_base_revision,
      revision: request.revision,
      roomCommit: update.room_commit,
      byteLength: update.after_byte_length,
      update: toCanonicalUpdate(update),
    };
  }

  /**
   * One atomic retention boundary for everything keyed below the floor:
   * request pointers (a retry older than the floor receives RESET_REQUIRED
   * instead of being accidentally applied as a new mutation), canonical
   * updates, and the room commits their deletion orphans. The row AT the
   * floor survives because lengthAtRevision(floor) reads its
   * after_utf16_length. Callers must run this inside a transaction that has
   * already advanced history_floor to `floor`.
   */
  private pruneBelowFloor(fileId: string, epoch: number, floor: number): number {
    this.storage.sql.exec(
      `DELETE FROM room_text_requests
        WHERE file_id = ? AND epoch = ? AND revision < ?`,
      fileId, epoch, floor,
    );
    const pruned = this.storage.sql.exec(
      `DELETE FROM room_text_updates
        WHERE file_id = ? AND epoch = ? AND revision < ?`,
      fileId, epoch, floor,
    ).rowsWritten;
    this.storage.sql.exec(
      `DELETE FROM room_text_commits
        WHERE sequence NOT IN (SELECT room_commit FROM room_text_updates)`,
    );
    return pruned;
  }

  /**
   * Choose the oldest canonical update worth retaining. The floor row itself
   * remains because lengthAtRevision(floor) reads its after_utf16_length.
   */
  private retentionFloor(fileId: string, epoch: number, existingFloor: number): number {
    const rows = this.storage.sql.exec<{ revision: number; bytes: number }>(
      `SELECT revision, length(CAST(changes_json AS BLOB)) AS bytes
         FROM room_text_updates
        WHERE file_id = ? AND epoch = ? AND revision >= ?
        ORDER BY revision DESC
        LIMIT ?`,
      fileId, epoch, existingFloor, RETAIN_HISTORY_UPDATES + 1,
    ).toArray();
    let retained = 0;
    let retainedBytes = 0;
    let floor = existingFloor;
    let mustPrune = false;
    for (const row of rows) {
      if (retained >= RETAIN_HISTORY_UPDATES
        || (retained > 0 && retainedBytes + row.bytes > RETAIN_HISTORY_BYTES)) {
        mustPrune = true;
        break;
      }
      retained++;
      retainedBytes += row.bytes;
      floor = row.revision;
    }
    return mustPrune ? Math.max(existingFloor, floor) : existingFloor;
  }

  private digestRows(): DigestRow[] {
    return this.storage.sql.exec<DigestRow>(
      `SELECT file_id, path, content_hash, byte_length, revision,
              first_seq, last_seq, updated_at
         FROM room_text_digests
        ORDER BY path`,
    ).toArray();
  }

  /**
   * Digest index maintenance for one accepted mutation, called inside the
   * same synchronous transaction that commits it: upsert the file's digest
   * row, log the new room root at the next digest sequence, and prune the
   * log to its bounded window. first_seq survives updates so diffDigest can
   * split added from changed.
   */
  private writeDigest(
    fileId: string,
    path: string,
    contentHash: string,
    byteLength: number,
    revision: number,
    now: number,
  ): void {
    const seq = (this.storage.sql.exec<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM room_text_digest_log",
    ).one().seq ?? -1) + 1;
    this.storage.sql.exec(
      `INSERT INTO room_text_digests (
         file_id, path, content_hash, byte_length, revision,
         first_seq, last_seq, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         byte_length = excluded.byte_length,
         revision = excluded.revision,
         last_seq = excluded.last_seq,
         updated_at = excluded.updated_at`,
      fileId, path, contentHash, byteLength, revision, seq, seq, now,
    );
    this.storage.sql.exec(
      "INSERT INTO room_text_digest_log (seq, root_hash, created_at) VALUES (?, ?, ?)",
      seq, rootHashOf(this.digestRows()), now,
    );
    this.storage.sql.exec(
      `DELETE FROM room_text_digest_log
        WHERE seq NOT IN (SELECT seq FROM room_text_digest_log ORDER BY seq DESC LIMIT ?)`,
      MAX_DIGEST_LOG_ROOTS,
    );
  }

  /**
   * Upsert the durable dirty mark for one accepted head mutation. Runs inside
   * the caller's transactionSync (createText / pushText / pushOneDeferred),
   * always AFTER writeDigest so marked_at can reuse the digest-log sequence
   * this same transaction just minted — a monotonic, wall-clock-free ordering
   * (no Date.now on this path). A re-mark keeps its original marked_at so the
   * janitor drains FIFO-fairly, while epoch/revision advance to the newest
   * unpublished state.
   */
  private markDirty(fileId: string, epoch: number, revision: number): void {
    const markedAt = this.storage.sql.exec<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM room_text_digest_log",
    ).one().seq ?? 0;
    this.storage.sql.exec(
      `INSERT INTO room_text_dirty (file_id, epoch, revision, marked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         epoch = excluded.epoch,
         revision = excluded.revision`,
      fileId, epoch, revision, markedAt,
    );
  }

  private remember(entry: CachedText): void {
    this.cache.delete(entry.fileId);
    this.cache.set(entry.fileId, entry);
    while (this.cache.size > MAX_CACHE_FILES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private openResult(entry: CachedText): OpenRoomTextResult {
    return {
      ok: true,
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: entry.fileId,
      path: entry.path,
      epoch: entry.epoch,
      revision: entry.revision,
      byteLength: entry.byteLength,
      content: entry.doc.toString(),
    };
  }

  private resetFailure(error: "EPOCH_MISMATCH" | "RESET_REQUIRED", entry: CachedText): RoomTextFailure {
    return {
      ok: false,
      error,
      epoch: entry.epoch,
      revision: entry.revision,
      content: entry.doc.toString(),
    };
  }
}

function normalizePush(input: PushRoomTextInput): PushRoomTextInput & { json: string } {
  if (!input || input.protocol !== ROOM_TEXT_PROTOCOL || !Number.isSafeInteger(input.epoch)
    || input.epoch < 1 || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0
    || !Array.isArray(input.changes)) {
    throw new InvalidRequestError();
  }
  const fileId = validateKey(input.fileId, "fileId");
  const clientId = validateKey(input.clientId, "clientId");
  const requestId = validateKey(input.requestId, "requestId");
  const changes = input.changes.map((change) => ({
    from: change?.from,
    to: change?.to,
    insert: change?.insert,
  })) as WireTextChange[];
  const normalized = {
    protocol: ROOM_TEXT_PROTOCOL,
    fileId,
    epoch: input.epoch,
    baseRevision: input.baseRevision,
    clientId,
    requestId,
    changes,
  };
  const json = JSON.stringify(normalized);
  if (persistedJsonEncoder.encode(json).byteLength > MAX_PERSISTED_JSON_BYTES) {
    throw new RoomTextError("REQUEST_TOO_LARGE", "request is too large to persist safely");
  }
  return { ...normalized, json };
}

function validateUpdateChain(rows: readonly UpdateRow[], baseRevision: number, baseLength: number, headRevision: number): void {
  let revision = baseRevision;
  let length = baseLength;
  for (const row of rows) {
    const changes = parseStoredChangeSet(row);
    if (row.revision !== revision + 1 || row.before_utf16_length !== length
      || changes.length !== length || changes.newLength !== row.after_utf16_length) {
      throw new RoomTextError("STORAGE_CORRUPT", `invalid update chain at revision ${row.revision}`);
    }
    revision = row.revision;
    length = row.after_utf16_length;
  }
  if (revision !== headRevision) {
    throw new RoomTextError("STORAGE_CORRUPT", `update tail stops at ${revision}, expected ${headRevision}`);
  }
}

function parseStoredChangeSet(row: UpdateRow): ChangeSet {
  try {
    return ChangeSet.fromJSON(JSON.parse(row.changes_json));
  } catch {
    throw new RoomTextError("STORAGE_CORRUPT", `invalid ChangeSet at revision ${row.revision}`);
  }
}

function toFileDigest(row: DigestRow): RoomTextFileDigest {
  return {
    fileId: row.file_id,
    path: row.path,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/**
 * Room root: digest of the canonical per-file listing, ordered by path.
 * NUL separates fields because validatePath forbids it in paths and the
 * other fields are digit/hex strings, so the serialization is unambiguous.
 */
function rootHashOf(rows: readonly DigestRow[]): string {
  let serialized = "";
  for (const row of rows) {
    serialized += `${row.path}\0${row.content_hash}\0${row.byte_length}\0`;
  }
  return roomTextDigestOfString(serialized);
}

function toCanonicalUpdate(row: UpdateRow): CanonicalRoomTextUpdate {
  return {
    revision: row.revision,
    parentRevision: row.revision - 1,
    clientId: row.client_id,
    requestId: row.request_id,
    changes: changeSetToWire(parseStoredChangeSet(row)),
  };
}

function validateKey(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || value.includes("\0") || !/^[a-zA-Z0-9._:@/-]+$/.test(value)) {
    throw new InvalidRequestError(`${name} is invalid`);
  }
  return value;
}

function validatePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024
    || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new InvalidRequestError("path is invalid");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new InvalidRequestError("path is invalid");
  }
  assertUnicodeScalarString(value);
  return parts.join("/");
}

function exactBytes(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  return bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isSqlConstraint(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function failureFrom(error: unknown): RoomTextFailure {
  if (error instanceof RoomTextError) return { ok: false, error: error.code, message: error.message };
  if (error instanceof InvalidRequestError) return { ok: false, error: "INVALID_REQUEST", message: error.message };
  throw error;
}

class InvalidRequestError extends Error {}
class IdempotencyMismatchError extends Error {}
