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
  type RoomTextAnchor,
  type WireTextChange,
} from "./room-text";

const ROOM_TEXT_PROTOCOL = 1 as const;
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
const persistedJsonEncoder = new TextEncoder();

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

type CachedText = {
  fileId: string;
  path: string;
  epoch: number;
  revision: number;
  byteLength: number;
  doc: Text;
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
    | RoomTextError["code"];
  message?: string;
  epoch?: number;
  revision?: number;
  content?: string;
};

/**
 * SQLite authority for collaborative text inside one room Durable Object.
 * The cache is intentionally disposable; every entry can be rebuilt from the
 * exact snapshot BLOB and contiguous canonical update tail.
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
      const updateToken = JSON.stringify([normalized.clientId, normalized.requestId]);
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
      const checkpointBytes = shouldCheckpoint ? encodeRoomText(applied.doc) : undefined;

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
   * HEAD, drop the local history it covers. The floor may not pass the
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
    `);
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

    const snapshot = decodeRoomText(row.snapshot_bytes);
    if (snapshot.length !== row.snapshot_utf16_length) {
      throw new RoomTextError("STORAGE_CORRUPT", "snapshot UTF-16 length is inconsistent");
    }
    let doc = snapshot;
    let revision = row.snapshot_revision;
    let byteLength = encodeRoomText(snapshot).byteLength;
    const updates = this.updateRows(row.file_id, row.epoch, row.snapshot_revision, row.head_revision);
    validateUpdateChain(updates, row.snapshot_revision, snapshot.length, row.head_revision);
    for (const update of updates) {
      const applied = applyRoomTextChange(doc, parseStoredChangeSet(update), byteLength);
      if (applied.doc.length !== update.after_utf16_length || applied.byteDelta !== update.byte_delta
        || applied.byteLength !== update.after_byte_length) {
        throw new RoomTextError("STORAGE_CORRUPT", `update ${update.revision} metadata is inconsistent`);
      }
      doc = applied.doc;
      byteLength = applied.byteLength;
      revision = update.revision;
    }
    const replayTailBytes = updates.reduce(
      (total, update) => total + persistedJsonEncoder.encode(update.changes_json).byteLength,
      0,
    );
    if (revision !== row.head_revision || byteLength !== row.byte_length) {
      throw new RoomTextError("STORAGE_CORRUPT", "reconstructed head does not match file metadata");
    }
    if (replayTailBytes !== row.recovery_tail_bytes) {
      throw new RoomTextError("STORAGE_CORRUPT", "recovery tail byte count is inconsistent");
    }
    const entry = {
      fileId: row.file_id,
      path: row.path,
      epoch: row.epoch,
      revision,
      byteLength,
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
