import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates } from "@codemirror/collab";
import {
  changeSetFromWire,
  changeSetToWire,
  roomTextFromString,
  roomTextUpdateToken,
  type WireTextChange,
} from "./room-text";
import {
  ROOM_TEXT_PROTOCOL,
  type CanonicalRoomTextUpdate,
  type PushRoomTextInput,
  type RoomTextFailure,
} from "./room-text-store";

// Reconnect pacing. NORMAL is for ordinary drops (network blips, zombie
// declarations, hibernated DOs): fast enough that a co-editor barely notices.
// AGGRESSIVE is for server-declared failure close codes: the server told us
// retrying fast cannot help, so back off hard and cap at five minutes.
export const ROOM_TEXT_NORMAL_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 10_000] as const;
export const ROOM_TEXT_AGGRESSIVE_BACKOFF_MS = [2_000, 30_000, 60_000, 300_000] as const;

// Zombie detection: a socket that looks open but returns neither a pong nor
// ANY other frame within the grace window is declared dead and replaced.
export const ROOM_TEXT_PING_INTERVAL_MS = 30_000;
export const ROOM_TEXT_PONG_TIMEOUT_MS = 2_000;

// Outgoing drafts compose losslessly for this long before becoming one
// outbox update — keystroke-level pushes would burn a revision per character.
export const ROOM_TEXT_COMPOSE_BUFFER_MS = 100;

// Client-declared close codes (reconnect on the NORMAL ladder — the server
// is not known bad, our view of the socket or the stream is).
export const ROOM_TEXT_CLOSE_ZOMBIE = 4001;
export const ROOM_TEXT_CLOSE_DESYNC = 4002;
// Server-declared close codes start at 4400 and drive the AGGRESSIVE ladder.
export const ROOM_TEXT_CLOSE_INCOMPATIBLE = 4400;
export const ROOM_TEXT_CLOSE_REFUSED = 4401;

/** Server-error close codes drive the aggressive reconnect ladder. */
export function isServerErrorCloseCode(code: number): boolean {
  return code === 1011 || code >= 4400;
}

/** Client -> server frames over the sync socket. */
export type RoomTextClientFrame =
  | {
      type: "connect";
      connectRequestId: string;
      protocolVersion: number;
      fileId: string;
      epoch: number;
      lastRevision: number;
    }
  | { type: "push"; pushes: PushRoomTextInput[] }
  | { type: "ping"; at: number };

/**
 * One entry of a batched broadcast frame. updateToken tags it so a sender
 * recognizes its own committed update: the entry IS the ack (echo-as-ack).
 */
export type RoomTextBroadcastUpdate = CanonicalRoomTextUpdate & { updateToken: string };

/** Server -> client frames. */
export type RoomTextServerFrame =
  | {
      type: "hydration";
      connectRequestId: string;
      fileId: string;
      hydration: "delta";
      epoch: number;
      headRevision: number;
      updates: CanonicalRoomTextUpdate[];
    }
  | {
      type: "hydration";
      connectRequestId: string;
      fileId: string;
      hydration: "snapshot";
      epoch: number;
      headRevision: number;
      byteLength: number;
      doc: string;
    }
  | { type: "incompatible"; connectRequestId: string; serverProtocol: number; message?: string }
  | { type: "connect-error"; connectRequestId: string; code: RoomTextFailure["error"]; message?: string }
  | {
      type: "updates";
      fileId: string;
      epoch: number;
      headRevision: number;
      updates: RoomTextBroadcastUpdate[];
    }
  | { type: "ack"; updateToken: string; status: "commit"; revision: number; rebasedChanges?: WireTextChange[] }
  | { type: "discard"; updateToken: string; code: RoomTextFailure["error"]; retryable: boolean; message?: string }
  | { type: "pong"; at: number };

export type RoomTextClientState =
  | "idle" // constructed, never started
  | "connecting" // asked the host to open a socket
  | "hydrating" // socket open, connect frame sent, waiting for hydration
  | "connected" // hydrated; pushes and broadcasts flow
  | "backoff" // waiting out a reconnect delay
  | "stopped"; // host called stop(); start() begins a fresh session

/**
 * Everything the client machinery asks its host to do. The host owns the
 * actual transport and must forward events only for the socket opened by the
 * MOST RECENT openSocket() call — stale-socket events would double-drive the
 * state machine.
 */
export type RoomTextClientEffects = {
  /** Open a fresh transport, then call handleSocketOpen / handleSocketClose. */
  openSocket(): void;
  /** Transmit one frame on the current transport. */
  sendFrame(frame: RoomTextClientFrame): void;
  /** Tear down the current transport (zombie or desync declarations, stop). */
  closeSocket(code: number, reason: string): void;
  onStateChange?(state: RoomTextClientState): void;
  /** Tri-state ack, commit arm: rebasedChanges present when the server moved it. */
  onAck?(ack: { requestId: string; revision: number; rebasedChanges?: WireTextChange[] }): void;
  /** Tri-state ack, discard arm: retryable means "re-hydrate, then decide". */
  onDiscard?(discard: { requestId: string; code: RoomTextFailure["error"]; retryable: boolean }): void;
  /** A committed update from another client, in canonical order. */
  onRemoteUpdate?(update: CanonicalRoomTextUpdate): void;
  /** The server chose snapshot hydration; the confirmed document was replaced. */
  onSnapshot?(snapshot: { doc: string; epoch: number; revision: number }): void;
  /** Local edits whose lineage a snapshot reset or a discard invalidated. */
  onLocalChangesOrphaned?(changes: WireTextChange[]): void;
  onIncompatible?(serverProtocol: number, message?: string): void;
};

export type RoomTextClientConfig = {
  clientId: string;
  fileId: string;
  /** Injectable timer: run callback after delayMs, return a canceller. */
  schedule(callback: () => void, delayMs: number): () => void;
  now?(): number;
  /** Must be unique per logical update for this clientId (durable dedupe key). */
  nextRequestId?(): string;
  effects: RoomTextClientEffects;
};

type OutboxEntry = {
  requestId: string;
  token: string;
  /** Base revision of `changes` within the current speculative chain. */
  baseRevision: number;
  changes: ChangeSet;
  /**
   * Exact payload of the last transmission. Replayed verbatim after a
   * snapshot hydration so the server's idempotency row can answer with the
   * original commit; rebuilt after a delta hydration once `changes` rebases.
   */
  sent: { epoch: number; baseRevision: number; changes: WireTextChange[] } | null;
  /**
   * False after a snapshot reset: the entry no longer participates in the
   * local document composition and survives only for verbatim replay.
   */
  speculative: boolean;
};

/** rebaseUpdates clientID for the unsent draft; "|" cannot appear in real tokens. */
function draftToken(clientId: string): string {
  return `draft|${clientId}`;
}

/**
 * Headless sync machinery for one RoomText file: connection FSM with dual
 * backoff ladders, ping/zombie detection on injected timers, a durable
 * outbox keyed by (clientId, requestId), pending-changeset rebase over
 * hydration deltas, and a lossless compose buffer for outgoing drafts.
 *
 * The module performs no I/O and holds no real timers — hosts inject
 * schedule() and a transport via effects — so it stays inside the
 * room-text*.ts synchronous discipline and unit-tests without a browser.
 */
export class RoomTextClient {
  private clientState: RoomTextClientState = "idle";
  private epoch = 0;
  private confirmedRevision = 0;
  private confirmed: Text = Text.empty;
  private readonly outbox: OutboxEntry[] = [];
  private draft: ChangeSet | null = null;
  private connectRequestId = "";
  private connectSequence = 0;
  private requestSequence = 0;
  private attempt = 0;
  private cancelReconnect: (() => void) | null = null;
  private cancelPing: (() => void) | null = null;
  private cancelZombie: (() => void) | null = null;
  private cancelDraftFlush: (() => void) | null = null;

  constructor(private readonly config: RoomTextClientConfig) {}

  state(): RoomTextClientState {
    return this.clientState;
  }

  /** Server revision the confirmed document sits at. */
  revision(): number {
    return this.confirmedRevision;
  }

  outboxSize(): number {
    return this.outbox.length;
  }

  /** Confirmed document plus the speculative chain plus the draft. */
  localText(): string {
    return this.localDoc().toString();
  }

  start(): void {
    if (this.clientState !== "idle" && this.clientState !== "stopped") return;
    this.attempt = 0;
    this.enter("connecting");
    this.config.effects.openSocket();
  }

  stop(): void {
    const wasLive = this.clientState === "hydrating" || this.clientState === "connected";
    this.clearReconnect();
    this.cancelPingCycle();
    this.clearDraftFlush();
    this.enter("stopped");
    if (wasLive) this.config.effects.closeSocket(1000, "client stopped");
  }

  /** The host's transport opened; send the reconnect handshake. */
  handleSocketOpen(): void {
    if (this.clientState !== "connecting") return;
    this.connectRequestId = `${this.config.clientId}:connect-${++this.connectSequence}`;
    this.enter("hydrating");
    this.config.effects.sendFrame({
      type: "connect",
      connectRequestId: this.connectRequestId,
      protocolVersion: ROOM_TEXT_PROTOCOL,
      fileId: this.config.fileId,
      epoch: this.epoch,
      lastRevision: this.confirmedRevision,
    });
  }

  /** The host's transport closed (or failed to open). */
  handleSocketClose(code: number): void {
    if (this.clientState !== "connecting" && this.clientState !== "hydrating"
      && this.clientState !== "connected") return;
    this.disconnected(code);
  }

  /** One parsed server frame from the current transport. */
  handleFrame(frame: RoomTextServerFrame): void {
    if (this.clientState !== "hydrating" && this.clientState !== "connected") return;
    // Any inbound frame is proof of life: cancel a pending zombie verdict
    // and push the next ping out by a full interval.
    if (this.clientState === "connected") this.armPingCycle();
    switch (frame.type) {
      case "hydration":
        this.handleHydration(frame);
        return;
      case "incompatible":
        this.handleIncompatible(frame);
        return;
      case "connect-error":
        this.handleConnectError(frame);
        return;
      case "updates":
        if (this.clientState === "connected") this.handleUpdates(frame);
        return;
      case "ack":
        if (this.clientState === "connected") this.handleAck(frame);
        return;
      case "discard":
        if (this.clientState === "connected") this.handleDiscard(frame);
        return;
      case "pong":
        return; // the generic activity reset above already did the work
    }
  }

  /**
   * A local edit against the CURRENT local document (what the host renders).
   * Edits compose losslessly in the draft buffer; the injected timer flushes
   * the buffer into the outbox as one logical update.
   */
  edit(changes: readonly WireTextChange[]): void {
    const set = changeSetFromWire(changes, this.localDoc().length);
    this.draft = this.draft ? this.draft.compose(set) : set;
    if (!this.cancelDraftFlush) {
      this.cancelDraftFlush = this.config.schedule(() => {
        this.cancelDraftFlush = null;
        this.flushDraft();
      }, ROOM_TEXT_COMPOSE_BUFFER_MS);
    }
  }

  /** Move the composed draft into the outbox now (also the timer's target). */
  flushDraft(): void {
    this.clearDraftFlush();
    if (!this.draft || this.draft.empty) {
      this.draft = null;
      return;
    }
    const requestId = this.config.nextRequestId
      ? this.config.nextRequestId()
      : `req-${++this.requestSequence}`;
    const entry: OutboxEntry = {
      requestId,
      token: roomTextUpdateToken(this.config.clientId, requestId),
      baseRevision: this.confirmedRevision + this.speculativeCount(),
      changes: this.draft,
      sent: null,
      speculative: true,
    };
    this.draft = null;
    this.outbox.push(entry);
    if (this.clientState !== "connected") return;
    const wire = changeSetToWire(entry.changes);
    entry.sent = { epoch: this.epoch, baseRevision: entry.baseRevision, changes: wire };
    this.config.effects.sendFrame({
      type: "push",
      pushes: [this.pushInput(entry.requestId, this.epoch, entry.baseRevision, wire)],
    });
  }

  private handleHydration(frame: Extract<RoomTextServerFrame, { type: "hydration" }>): void {
    if (this.clientState !== "hydrating" || frame.connectRequestId !== this.connectRequestId) return;
    this.epoch = frame.epoch;
    if (frame.hydration === "snapshot") {
      this.resetToSnapshot(frame);
    } else {
      const committed = frame.updates.map((update) => ({
        update,
        token: roomTextUpdateToken(update.clientId, update.requestId),
      }));
      if (!this.integrateCommitted(committed) || this.confirmedRevision !== frame.headRevision) {
        this.forceResync("hydration delta does not extend the confirmed document");
        return;
      }
    }
    this.attempt = 0;
    this.enter("connected");
    this.armPingCycle();
    this.resendOutbox();
  }

  private resetToSnapshot(frame: Extract<RoomTextServerFrame, { hydration: "snapshot" }>): void {
    // The old lineage is gone: local work that never reached the server has
    // nothing to rebase onto. Surface it rather than mis-applying it. Sent
    // entries survive as replay-only rows — the server's idempotency window
    // may still answer them with the original commit.
    const orphaned: WireTextChange[] = [];
    const kept: OutboxEntry[] = [];
    for (const entry of this.outbox) {
      if (entry.sent) {
        entry.speculative = false;
        kept.push(entry);
      } else {
        orphaned.push(...changeSetToWire(entry.changes));
      }
    }
    this.outbox.length = 0;
    this.outbox.push(...kept);
    if (this.draft) {
      orphaned.push(...changeSetToWire(this.draft));
      this.draft = null;
      this.clearDraftFlush();
    }
    this.confirmed = roomTextFromString(frame.doc);
    this.confirmedRevision = frame.headRevision;
    this.config.effects.onSnapshot?.({ doc: frame.doc, epoch: frame.epoch, revision: frame.headRevision });
    if (orphaned.length) this.config.effects.onLocalChangesOrphaned?.(orphaned);
  }

  private handleIncompatible(frame: Extract<RoomTextServerFrame, { type: "incompatible" }>): void {
    if (frame.connectRequestId !== this.connectRequestId) return;
    this.config.effects.onIncompatible?.(frame.serverProtocol, frame.message);
    // A protocol mismatch is not fixed by a fast retry; close and let the
    // aggressive ladder pace re-checks (a deploy may bridge the gap later).
    this.config.effects.closeSocket(ROOM_TEXT_CLOSE_INCOMPATIBLE, "room-text protocol mismatch");
    this.disconnected(ROOM_TEXT_CLOSE_INCOMPATIBLE);
  }

  private handleConnectError(frame: Extract<RoomTextServerFrame, { type: "connect-error" }>): void {
    if (frame.connectRequestId !== this.connectRequestId) return;
    // The server refused the handshake (NOT_FOUND, INVALID_REQUEST, ...):
    // a server-declared refusal, so pace retries on the aggressive ladder.
    this.config.effects.closeSocket(ROOM_TEXT_CLOSE_REFUSED, `connect refused: ${frame.code}`);
    this.disconnected(ROOM_TEXT_CLOSE_REFUSED);
  }

  private handleUpdates(frame: Extract<RoomTextServerFrame, { type: "updates" }>): void {
    if (frame.fileId !== this.config.fileId) return;
    if (frame.epoch !== this.epoch) {
      this.forceResync("epoch changed under an open socket");
      return;
    }
    // Entries at or below our revision are duplicate delivery (already
    // integrated by hydration); a gap above forces a resync.
    const committed = frame.updates
      .filter((update) => update.revision > this.confirmedRevision)
      .map((update) => ({ update, token: update.updateToken }));
    if (!committed.length) return;
    if (!this.integrateCommitted(committed)) {
      this.forceResync("broadcast does not extend the confirmed document");
    }
  }

  private handleAck(frame: Extract<RoomTextServerFrame, { type: "ack" }>): void {
    const index = this.outbox.findIndex((entry) => entry.token === frame.updateToken);
    if (index < 0) return;
    const entry = this.outbox[index];
    if (entry.speculative) {
      // Fresh commits ack through the broadcast echo, never this frame; a
      // direct commit ack for a live speculative entry means our picture of
      // the stream is wrong.
      this.forceResync("commit ack for a speculative entry outside the broadcast stream");
      return;
    }
    // Replay of an already-stored commit: the snapshot that reset us already
    // contains its text, so the entry just leaves the outbox.
    this.outbox.splice(index, 1);
    this.config.effects.onAck?.({
      requestId: entry.requestId,
      revision: frame.revision,
      ...(frame.rebasedChanges ? { rebasedChanges: frame.rebasedChanges } : {}),
    });
  }

  private handleDiscard(frame: Extract<RoomTextServerFrame, { type: "discard" }>): void {
    const index = this.outbox.findIndex((entry) => entry.token === frame.updateToken);
    if (index < 0) return;
    const entry = this.outbox[index];
    if (!entry.speculative) {
      // Replay-only entry: the server's window closed before it could answer.
      this.outbox.splice(index, 1);
      this.config.effects.onDiscard?.({ requestId: entry.requestId, code: frame.code, retryable: frame.retryable });
      return;
    }
    // A discarded speculative entry invalidates the chain built on top of
    // it: later entries and the draft assumed its text existed. Speculative
    // entries are always contiguous at the tail, so one splice takes them.
    const removed = this.outbox.splice(index);
    const orphaned: WireTextChange[] = [];
    for (const later of removed.slice(1)) orphaned.push(...changeSetToWire(later.changes));
    if (this.draft) {
      orphaned.push(...changeSetToWire(this.draft));
      this.draft = null;
      this.clearDraftFlush();
    }
    this.config.effects.onDiscard?.({ requestId: entry.requestId, code: frame.code, retryable: frame.retryable });
    if (orphaned.length) this.config.effects.onLocalChangesOrphaned?.(orphaned);
  }

  /**
   * Fold committed canonical updates into the confirmed document and carry
   * the speculative chain (unconfirmed entries + draft) over them with the
   * SAME rebaseUpdates call the server uses — identical inputs, identical
   * outputs, so a sender's local form converges byte-exactly with the
   * canonical broadcast. Returns false when the stream does not chain.
   */
  private integrateCommitted(
    committed: readonly { update: CanonicalRoomTextUpdate; token: string }[],
  ): boolean {
    if (!committed.length) return true;
    let doc = this.confirmed;
    let revision = this.confirmedRevision;
    const over: { changes: ChangeSet; clientID: string }[] = [];
    for (const { update, token } of committed) {
      if (update.revision !== revision + 1) return false;
      let changes: ChangeSet;
      try {
        changes = changeSetFromWire(update.changes, doc.length);
      } catch {
        return false;
      }
      over.push({ changes, clientID: token });
      doc = changes.apply(doc);
      revision = update.revision;
    }

    const pending = this.outbox
      .filter((entry) => entry.speculative)
      .map((entry) => ({ changes: entry.changes, clientID: entry.token }));
    if (this.draft) pending.push({ changes: this.draft, clientID: draftToken(this.config.clientId) });
    const rebased = rebaseUpdates(pending, over);
    const byToken = new Map(rebased.map((update) => [update.clientID, update.changes]));

    // Settle bookkeeping: our own committed entries leave the outbox with an
    // ack (echo-as-ack — the broadcast entry IS the ack); everything else is
    // a remote update for the host. Own speculative commits must confirm in
    // send order; the DO serializes one socket's pushes, so a violation
    // means the stream is corrupt.
    for (const { update, token } of committed) {
      const index = this.outbox.findIndex((entry) => entry.token === token);
      if (index < 0) {
        this.config.effects.onRemoteUpdate?.(update);
        continue;
      }
      const entry = this.outbox[index];
      if (entry.speculative && this.outbox.findIndex((other) => other.speculative) !== index) return false;
      this.outbox.splice(index, 1);
      const submittedBase = entry.sent ? entry.sent.baseRevision : entry.baseRevision;
      this.config.effects.onAck?.({
        requestId: entry.requestId,
        revision: update.revision,
        ...(update.parentRevision > submittedBase ? { rebasedChanges: update.changes } : {}),
      });
    }

    this.confirmed = doc;
    this.confirmedRevision = revision;
    let chainBase = revision;
    for (const entry of this.outbox) {
      if (!entry.speculative) continue;
      const changes = byToken.get(entry.token);
      if (!changes) return false;
      entry.changes = changes;
      entry.baseRevision = chainBase;
      chainBase++;
    }
    if (this.draft) this.draft = byToken.get(draftToken(this.config.clientId)) ?? this.draft;
    return true;
  }

  /**
   * Resend the durable outbox after hydration, ORIGINAL tokens throughout.
   * Speculative entries go in their current (delta-rebased) form; replay-only
   * entries repeat their last transmission verbatim so the idempotency
   * envelope still matches if the server already committed them. One frame
   * carries the whole outbox: the server processes it in one turn and its
   * broadcast batches the accepted updates into one frame.
   */
  private resendOutbox(): void {
    if (!this.outbox.length) return;
    const pushes = this.outbox.map((entry) => {
      if (!entry.speculative && entry.sent) {
        return this.pushInput(entry.requestId, entry.sent.epoch, entry.sent.baseRevision, entry.sent.changes);
      }
      const wire = changeSetToWire(entry.changes);
      entry.sent = { epoch: this.epoch, baseRevision: entry.baseRevision, changes: wire };
      return this.pushInput(entry.requestId, this.epoch, entry.baseRevision, wire);
    });
    this.config.effects.sendFrame({ type: "push", pushes });
  }

  private pushInput(
    requestId: string,
    epoch: number,
    baseRevision: number,
    changes: WireTextChange[],
  ): PushRoomTextInput {
    return {
      protocol: ROOM_TEXT_PROTOCOL,
      fileId: this.config.fileId,
      epoch,
      baseRevision,
      clientId: this.config.clientId,
      requestId,
      changes,
    };
  }

  private disconnected(code: number): void {
    this.cancelPingCycle();
    const ladder: readonly number[] = isServerErrorCloseCode(code)
      ? ROOM_TEXT_AGGRESSIVE_BACKOFF_MS
      : ROOM_TEXT_NORMAL_BACKOFF_MS;
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)];
    this.attempt++;
    this.enter("backoff");
    this.cancelReconnect = this.config.schedule(() => {
      this.cancelReconnect = null;
      this.enter("connecting");
      this.config.effects.openSocket();
    }, delay);
  }

  private forceResync(reason: string): void {
    this.config.effects.closeSocket(ROOM_TEXT_CLOSE_DESYNC, reason);
    this.disconnected(ROOM_TEXT_CLOSE_DESYNC);
  }

  private armPingCycle(): void {
    this.cancelPingCycle();
    this.cancelPing = this.config.schedule(() => {
      this.cancelPing = null;
      this.config.effects.sendFrame({ type: "ping", at: this.now() });
      this.cancelZombie = this.config.schedule(() => {
        this.cancelZombie = null;
        // Zombie: the socket looks open but nothing came back. Declare it
        // dead and reconnect on the NORMAL ladder — the server is not known
        // bad, our socket is.
        this.config.effects.closeSocket(ROOM_TEXT_CLOSE_ZOMBIE, "no pong or activity within grace window");
        this.disconnected(ROOM_TEXT_CLOSE_ZOMBIE);
      }, ROOM_TEXT_PONG_TIMEOUT_MS);
    }, ROOM_TEXT_PING_INTERVAL_MS);
  }

  private cancelPingCycle(): void {
    if (this.cancelPing) {
      this.cancelPing();
      this.cancelPing = null;
    }
    if (this.cancelZombie) {
      this.cancelZombie();
      this.cancelZombie = null;
    }
  }

  private clearReconnect(): void {
    if (this.cancelReconnect) {
      this.cancelReconnect();
      this.cancelReconnect = null;
    }
  }

  private clearDraftFlush(): void {
    if (this.cancelDraftFlush) {
      this.cancelDraftFlush();
      this.cancelDraftFlush = null;
    }
  }

  private speculativeCount(): number {
    let count = 0;
    for (const entry of this.outbox) if (entry.speculative) count++;
    return count;
  }

  private localDoc(): Text {
    let doc = this.confirmed;
    for (const entry of this.outbox) {
      if (entry.speculative) doc = entry.changes.apply(doc);
    }
    if (this.draft) doc = this.draft.apply(doc);
    return doc;
  }

  private now(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private enter(state: RoomTextClientState): void {
    if (this.clientState === state) return;
    this.clientState = state;
    this.config.effects.onStateChange?.(state);
  }
}
