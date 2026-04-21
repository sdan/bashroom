import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, type TransportState } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  ROOMS: DurableObjectNamespace<Room>;
  REGISTRY: DurableObjectNamespace<Registry>;
};

type Scope = "read" | "write" | "checkpoint" | "admin";
type RoomOp = "read" | "write" | "checkpoint" | "history" | "who" | "help";

type RoomRequest = {
  op?: RoomOp;
  body?: string;
  actor?: string;
  knownActors?: string[];
  after?: number;
  limit?: number;
  format?: "compact" | "markdown";
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  cursor?: number;
};

type RoomEvent = {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  body_markdown: string;
};

type ActorActivity = {
  actor: string;
  last_event_id: number;
  last_seen_at: string;
};

type AuthResult = {
  ok: boolean;
  room?: string;
  actor?: string;
  scopes?: Scope[];
  tokenId?: string;
  error?: string;
  retry_after_seconds?: number;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_BODY_CHARS = 16_000;
const MAX_BODY_CHARS_IN_READ = 600;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CREATE_IP_CAPACITY = 100;
const CREATE_IP_REFILL = 100 / DAY_MS;
const CREATE_GLOBAL_CAPACITY = 10_000;
const CREATE_GLOBAL_REFILL = 10_000 / DAY_MS;
const JOIN_IP_CAPACITY = 100;
const JOIN_IP_REFILL = 10 / MINUTE_MS;
const JOIN_GLOBAL_CAPACITY = 50_000;
const JOIN_GLOBAL_REFILL = 50_000 / DAY_MS;
const VERIFY_IP_CAPACITY = 2_400;
const VERIFY_IP_REFILL = 40 / 1000;
const ROOM_OPS_TOKEN_CAPACITY = 1_200;
const ROOM_OPS_TOKEN_REFILL = 20 / 1000;
const WRITE_TOKEN_CAPACITY = 300;
const WRITE_TOKEN_REFILL = 10 / MINUTE_MS;
const GLOBAL_OPS_CAPACITY = 50_000;
const GLOBAL_OPS_REFILL = 50_000 / DAY_MS;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * MINUTE_MS;
const SLUG_VERBS = ["debugging", "tracing", "reviewing", "testing", "patching", "writing", "reading", "fixing", "pairing", "shipping", "checking", "building", "syncing", "verifying"];
const SLUG_NOUNS = ["worker", "room", "auth", "token", "checkpoint", "event", "schema", "request", "diff", "build", "agent", "actor", "context", "router", "stack", "log"];

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        body_markdown TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/command") {
      const input = await request.json<RoomRequest>();
      const actor = sanitizeActor(input.actor || request.headers.get("x-intracode-actor") || "anonymous");
      const result = this.runOp({ ...input, actor });
      return json(result, result.exitCode === 0 ? 200 : 400);
    }

    if (request.method === "POST" && url.pathname === "/export") {
      return text(this.exportMarkdown());
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      this.ctx.storage.sql.exec("DELETE FROM events");
      this.ctx.storage.sql.exec("DELETE FROM meta");
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  }

  private runOp(input: RoomRequest & { actor: string }): CommandResult {
    const op = input.op || "read";

    switch (op) {
      case "read":
        return this.renderRoom({
          limit: parseLimit(input.limit),
          after: input.after,
          format: input.format || "compact",
        });

      case "history":
        return this.renderHistory({
          limit: parseLimit(input.limit),
          after: input.after,
          format: input.format || "compact",
        });

      case "write": {
        const body = cleanBody(input.body);
        if (!body) return err("write requires body");
        const event = this.appendEvent(input.actor, "note", body);
        return ok(`Wrote event #${event.id}\n`, event.id);
      }

      case "checkpoint": {
        const body = cleanBody(input.body);
        if (!body) return err("checkpoint requires body");
        const event = this.setCheckpoint(input.actor, body);
        return ok(`Updated checkpoint #${event.id}\n`, event.id);
      }

      case "who":
        return this.renderWho(input.actor, input.knownActors || []);

      case "help":
        return ok(helpText());

      default:
        return err(`Unknown op: ${op}\n\n${helpText()}`);
    }
  }

  private appendEvent(actor: string, kind: string, bodyMarkdown: string): RoomEvent {
    const ts = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO events (ts, actor, kind, body_markdown) VALUES (?, ?, ?, ?)",
      ts,
      actor,
      kind,
      bodyMarkdown,
    );
    return this.ctx.storage.sql
      .exec<RoomEvent>("SELECT id, ts, actor, kind, body_markdown FROM events WHERE rowid = last_insert_rowid()")
      .one();
  }

  private setCheckpoint(actor: string, bodyMarkdown: string): RoomEvent {
    const ts = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value, updated_at, updated_by)
       VALUES ('checkpoint', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      bodyMarkdown,
      ts,
      actor,
    );
    return this.appendEvent(actor, "checkpoint", bodyMarkdown);
  }

  private getCheckpoint(): { value: string; updated_at: string; updated_by: string } | null {
    return this.ctx.storage.sql
      .exec<{ value: string; updated_at: string; updated_by: string }>(
        "SELECT value, updated_at, updated_by FROM meta WHERE key = 'checkpoint'",
      )
      .toArray()[0] ?? null;
  }

  private getEvents(input: { limit: number; after?: number }): RoomEvent[] {
    if (input.after !== undefined) {
      return this.ctx.storage.sql
        .exec<RoomEvent>(
          `SELECT id, ts, actor, kind, body_markdown
           FROM events
           WHERE id > ?
           ORDER BY id ASC
           LIMIT ?`,
          input.after,
          input.limit,
        )
        .toArray();
    }

    return this.ctx.storage.sql
      .exec<RoomEvent>(
        `SELECT id, ts, actor, kind, body_markdown
         FROM events
         ORDER BY id DESC
         LIMIT ?`,
        input.limit,
      )
      .toArray()
      .reverse();
  }

  private renderRoom(input: { limit: number; after?: number; format: "compact" | "markdown" }): CommandResult {
    const checkpoint = this.getCheckpoint();
    const events = this.getEvents(input);
    const checkpointText = checkpoint
      ? `${checkpoint.value}\n\n_Updated by ${checkpoint.updated_by} at ${checkpoint.updated_at}_`
      : "No checkpoint yet.";
    const cursor = events.at(-1)?.id ?? input.after ?? 0;

    return ok(
      `# Intracode Room\n\n## Checkpoint\n${checkpointText}\n\n## Recent Events\n${this.renderEvents(events, input.format) || "No events yet."}\n\nnext_cursor: ${cursor}\n`,
      cursor,
    );
  }

  private renderHistory(input: { limit: number; after?: number; format: "compact" | "markdown" }): CommandResult {
    const events = this.getEvents(input);
    const cursor = events.at(-1)?.id ?? input.after ?? 0;
    return ok(`${this.renderEvents(events, input.format) || "No events yet."}\n\nnext_cursor: ${cursor}\n`, cursor);
  }

  private renderWho(currentActor: string, actors: string[]): CommandResult {
    const recent = this.ctx.storage.sql
      .exec<ActorActivity>(
        `SELECT actor, MAX(id) AS last_event_id, MAX(ts) AS last_seen_at
         FROM events
         GROUP BY actor
         ORDER BY last_event_id DESC
         LIMIT 50`,
      )
      .toArray();
    const knownActors = uniqueActors([...actors, currentActor, ...recent.map((entry) => entry.actor)]);
    const actorLines = knownActors.map((actor) => `- ${actor}${actor === currentActor ? " (current)" : ""}`).join("\n");
    const activityLines = recent
      .map((entry) => `- ${entry.actor} — event #${entry.last_event_id} at ${formatTimestamp(entry.last_seen_at)}`)
      .join("\n");

    return ok(`# Actors\n\n${actorLines || "No actors yet."}\n\n## Recent Activity\n${activityLines || "No events yet."}\n`);
  }

  private renderEvents(events: RoomEvent[], format: "compact" | "markdown"): string {
    return events
      .map((event) => {
        const timestamp = formatTimestamp(event.ts);
        const body = format === "compact" ? compact(event.body_markdown) : event.body_markdown;
        return `- #${event.id} ${timestamp} **${event.actor}** _${event.kind}_: ${body}`;
      })
      .join("\n");
  }

  private exportMarkdown(): string {
    const checkpoint = this.getCheckpoint();
    const events = this.ctx.storage.sql
      .exec<RoomEvent>("SELECT id, ts, actor, kind, body_markdown FROM events ORDER BY id ASC")
      .toArray();
    const checkpointText = checkpoint ? checkpoint.value : "No checkpoint.";
    return `# Intracode Room Export\n\n## Checkpoint\n${checkpointText}\n\n## Events\n${this.renderEvents(events, "markdown") || "No events."}\n`;
  }
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        room TEXT NOT NULL,
        actor TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pair_codes (
        code_hash TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_tokens (
        session_hash TEXT NOT NULL,
        room TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_hash, room)
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_transport_states (
        session_hash TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_buckets (
        key TEXT PRIMARY KEY,
        credits REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json<Record<string, unknown>>() : {};

    if (request.method === "POST" && url.pathname === "/mcp-transport-get") {
      return json({ state: await this.mcpTransportState(bearerFromUnknown(body.mcpSessionId)) });
    }

    if (request.method === "POST" && url.pathname === "/mcp-transport-set") {
      await this.setMcpTransportState(bearerFromUnknown(body.mcpSessionId), body.state);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/create") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`create:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL) || this.checkBucket("create:global", CREATE_GLOBAL_CAPACITY, CREATE_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.createRoom(String(body.room || ""), String(body.actor || defaultActor("actor")), bearerFromUnknown(body.mcpSessionId)));
    }

    if (request.method === "POST" && url.pathname === "/verify") {
      return json(await this.authorize(String(body.room || ""), bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), String(body.scope || "read") as Scope, String(body.ip || "unknown")));
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const auth = await this.authorize(String(body.room || ""), bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(await this.createPairCode(String(body.room), parseScopes(body.scopes, ["read", "write", "checkpoint"])));
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`join:ip:${ip}`, JOIN_IP_CAPACITY, JOIN_IP_REFILL) || this.checkBucket("join:global", JOIN_GLOBAL_CAPACITY, JOIN_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.join(String(body.code || ""), String(body.actor || defaultActor("actor")), bearerFromUnknown(body.mcpSessionId)));
    }

    if (request.method === "POST" && url.pathname === "/actors") {
      const auth = await this.authorize(String(body.room || ""), bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "read", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json({ ok: true, actors: this.actors(String(body.room)) });
    }

    if (request.method === "POST" && url.pathname === "/revoke") {
      const auth = await this.authorize(String(body.room || ""), bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(this.revoke(String(body.room), String(body.actor || "")));
    }

    if (request.method === "POST" && url.pathname === "/rotate") {
      const auth = await this.verify(String(body.room || ""), bearerFromUnknown(body.token), "read", String(body.ip || "unknown"));
      if (!auth.ok || !auth.actor) return json(auth, 401);
      return json(await this.rotate(String(body.room), bearerFromUnknown(body.token), auth.actor));
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      const auth = await this.verify(String(body.room || ""), bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(this.deleteRoom(String(body.room)));
    }

    return json({ error: "not_found" }, 404);
  }

  private async createRoom(room: string, actor: string, mcpSessionId = ""): Promise<Record<string, unknown>> {
    const cleanRoom = room.trim() ? sanitizeRoom(room) : this.generateRoomSlug();
    const cleanActor = sanitizeActor(actor);
    const existing = this.ctx.storage.sql.exec("SELECT room FROM rooms WHERE room = ?", cleanRoom).toArray()[0];
    if (existing) return { ok: false, error: "room_exists" };

    const now = new Date().toISOString();
    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");
    const scopes: Scope[] = ["read", "write", "checkpoint", "admin"];

    this.ctx.storage.sql.exec("INSERT INTO rooms (room, created_at) VALUES (?, ?)", cleanRoom, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (token_hash, token_id, room, actor, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      cleanRoom,
      cleanActor,
      scopes.join(","),
      now,
    );
    await this.rememberSessionToken(mcpSessionId, cleanRoom, tokenHash, now);

    return { ok: true, room: cleanRoom, token, actor: cleanActor, scopes };
  }

  private async authorize(room: string, token: string, mcpSessionId: string, scope: Scope, ip: string): Promise<AuthResult> {
    if (token) return this.verify(room, token, scope, ip);
    if (mcpSessionId) return this.verifySession(room, mcpSessionId, scope, ip);
    return { ok: false, error: "missing_token" };
  }

  private async verify(room: string, token: string, scope: Scope, ip: string): Promise<AuthResult> {
    const cleanRoom = sanitizeRoom(room);
    if (!token) return { ok: false, error: "missing_token" };
    return this.verifyTokenHash(cleanRoom, await sha256(token), scope, ip);
  }

  private async verifySession(room: string, mcpSessionId: string, scope: Scope, ip: string): Promise<AuthResult> {
    const cleanRoom = sanitizeRoom(room);
    const row = this.ctx.storage.sql
      .exec<{ token_hash: string }>(
        `SELECT token_hash
         FROM session_tokens
         WHERE session_hash = ? AND room = ?`,
        await sha256(mcpSessionId),
        cleanRoom,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "missing_session_token" };
    return this.verifyTokenHash(cleanRoom, row.token_hash, scope, ip);
  }

  private verifyTokenHash(cleanRoom: string, tokenHash: string, scope: Scope, ip: string): AuthResult {
    const ipLimited = this.checkBucket(`verify:ip:${ip}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
    if (ipLimited) return ipLimited;

    const globalLimited = this.checkBucket("ops:global", GLOBAL_OPS_CAPACITY, GLOBAL_OPS_REFILL);
    if (globalLimited) return globalLimited;

    const tokenLimited = this.checkBucket(`ops:token:${tokenHash}`, ROOM_OPS_TOKEN_CAPACITY, ROOM_OPS_TOKEN_REFILL);
    if (tokenLimited) return tokenLimited;

    if (scope === "write" || scope === "checkpoint") {
      const writeLimited = this.checkBucket(`write:token:${tokenHash}`, WRITE_TOKEN_CAPACITY, WRITE_TOKEN_REFILL);
      if (writeLimited) return writeLimited;
    }

    const row = this.ctx.storage.sql
      .exec<{ token_id: string; room: string; actor: string; scopes: string; last_seen_at: string | null; revoked_at: string | null }>(
        `SELECT token_id, room, actor, scopes, last_seen_at, revoked_at
         FROM tokens
         WHERE token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];

    if (!row || row.revoked_at) return { ok: false, error: "invalid_token" };
    if (row.room !== cleanRoom) return { ok: false, error: "wrong_room" };

    const scopes = row.scopes.split(",") as Scope[];
    if (!hasScope(scopes, scope)) return { ok: false, error: "insufficient_scope" };

    const now = Date.now();
    if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec("UPDATE tokens SET last_seen_at = ? WHERE token_hash = ?", new Date(now).toISOString(), tokenHash);
    }

    return { ok: true, room: row.room, actor: row.actor, scopes, tokenId: row.token_id };
  }

  private async rememberSessionToken(mcpSessionId: string, room: string, tokenHash: string, createdAt: string): Promise<void> {
    if (!mcpSessionId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO session_tokens (session_hash, room, token_hash, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_hash, room) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_at = excluded.created_at`,
      await sha256(mcpSessionId),
      room,
      tokenHash,
      createdAt,
    );
  }

  private async mcpTransportState(mcpSessionId: string): Promise<unknown | undefined> {
    if (!mcpSessionId) return undefined;
    const row = this.ctx.storage.sql
      .exec<{ state_json: string }>(
        "SELECT state_json FROM mcp_transport_states WHERE session_hash = ?",
        await sha256(mcpSessionId),
      )
      .toArray()[0];
    return row ? JSON.parse(row.state_json) : undefined;
  }

  private async setMcpTransportState(mcpSessionId: string, state: unknown): Promise<void> {
    if (!mcpSessionId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_transport_states (session_hash, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_hash) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      await sha256(mcpSessionId),
      JSON.stringify(state),
      new Date().toISOString(),
    );
  }

  private checkBucket(key: string, maxCredits: number, creditsPerMs: number, cost = 1): AuthResult | null {
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ credits: number; updated_at: number }>("SELECT credits, updated_at FROM rate_buckets WHERE key = ?", key)
      .toArray()[0];

    if (!existing) {
      this.ctx.storage.sql.exec(
        "INSERT INTO rate_buckets (key, credits, updated_at) VALUES (?, ?, ?)",
        key,
        maxCredits - cost,
        now,
      );
      return null;
    }

    const elapsed = Math.max(0, now - existing.updated_at);
    const credits = Math.min(maxCredits, existing.credits + elapsed * creditsPerMs);

    if (credits < cost) {
      return {
        ok: false,
        error: "rate_limited",
        retry_after_seconds: Math.max(1, Math.ceil((cost - credits) / creditsPerMs / 1000)),
      };
    }

    this.ctx.storage.sql.exec("UPDATE rate_buckets SET credits = ?, updated_at = ? WHERE key = ?", credits - cost, now, key);
    return null;
  }

  private async createPairCode(room: string, scopes: Scope[]): Promise<Record<string, unknown>> {
    const cleanRoom = sanitizeRoom(room);
    const code = randomPairCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO pair_codes (code_hash, room, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      await sha256(code),
      cleanRoom,
      scopes.join(","),
      now.toISOString(),
      expiresAt,
    );

    return { ok: true, room: cleanRoom, code, expires_at: expiresAt, scopes };
  }

  private async join(code: string, actor: string, mcpSessionId = ""): Promise<Record<string, unknown>> {
    const cleanCode = code.trim();
    const cleanActor = sanitizeActor(actor);
    const codeHash = await sha256(cleanCode);
    const row = this.ctx.storage.sql
      .exec<{ room: string; scopes: string; expires_at: string; used_at: string | null }>(
        "SELECT room, scopes, expires_at, used_at FROM pair_codes WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];

    if (!row || row.used_at) return { ok: false, error: "invalid_code" };
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: "expired_code" };

    const now = new Date().toISOString();
    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");

    this.ctx.storage.sql.exec("UPDATE pair_codes SET used_at = ? WHERE code_hash = ?", now, codeHash);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (token_hash, token_id, room, actor, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      row.room,
      cleanActor,
      row.scopes,
      now,
    );
    await this.rememberSessionToken(mcpSessionId, row.room, tokenHash, now);

    return { ok: true, room: row.room, token, actor: cleanActor, scopes: row.scopes.split(",") };
  }

  private actors(room: string): string[] {
    const cleanRoom = sanitizeRoom(room);
    return this.ctx.storage.sql
      .exec<{ actor: string }>(
        `SELECT actor
         FROM tokens
         WHERE room = ? AND revoked_at IS NULL
         GROUP BY actor
         ORDER BY MIN(created_at) ASC`,
        cleanRoom,
      )
      .toArray()
      .map((row) => row.actor);
  }

  private revoke(room: string, actor: string): Record<string, unknown> {
    const cleanRoom = sanitizeRoom(room);
    const cleanActor = sanitizeActor(actor);
    this.ctx.storage.sql.exec(
      "UPDATE tokens SET revoked_at = ? WHERE room = ? AND actor = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      cleanRoom,
      cleanActor,
    );
    return { ok: true, room: cleanRoom, revoked: cleanActor };
  }

  private async rotate(room: string, oldToken: string, actor: string): Promise<Record<string, unknown>> {
    const cleanRoom = sanitizeRoom(room);
    const oldHash = await sha256(oldToken);
    const row = this.ctx.storage.sql
      .exec<{ actor: string; scopes: string }>("SELECT actor, scopes FROM tokens WHERE token_hash = ? AND room = ? AND revoked_at IS NULL", oldHash, cleanRoom)
      .toArray()[0];
    if (!row) return { ok: false, error: "invalid_token" };

    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?", now, oldHash);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (token_hash, token_id, room, actor, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      cleanRoom,
      actor || row.actor,
      row.scopes,
      now,
    );

    return { ok: true, room: cleanRoom, token, actor: actor || row.actor, scopes: row.scopes.split(",") };
  }

  private deleteRoom(room: string): Record<string, unknown> {
    const cleanRoom = sanitizeRoom(room);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE room = ?", cleanRoom);
    this.ctx.storage.sql.exec("UPDATE tokens SET revoked_at = ? WHERE room = ? AND revoked_at IS NULL", now, cleanRoom);
    this.ctx.storage.sql.exec("UPDATE pair_codes SET used_at = ? WHERE room = ? AND used_at IS NULL", now, cleanRoom);
    this.ctx.storage.sql.exec("DELETE FROM session_tokens WHERE room = ?", cleanRoom);
    return { ok: true, room: cleanRoom };
  }

  private generateRoomSlug(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = `${choice(SLUG_VERBS)}-${choice(SLUG_NOUNS)}-${randomSuffix(4)}`;
      const existing = this.ctx.storage.sql.exec("SELECT room FROM rooms WHERE room = ?", slug).toArray()[0];
      if (!existing) return slug;
    }
    return `room-${randomSuffix(12)}`;
  }
}

function createServer(env: Env, headerToken: string, mcpSessionId: string, ip: string): McpServer {
  const server = new McpServer({ name: "intracode", version: "0.1.0" });

  server.tool(
    "intracode_create_room",
    "Create a shared context room and actor token. In normal MCP sessions, the token is vaulted server-side and not returned.",
    {
      name: z.string().optional().describe("Optional room slug. Omit to generate a friendly slug like debugging-worker-k7p9."),
      actor: z.string().optional().describe("Actor name for attribution, for example claude-code. Omit to auto-generate one."),
    },
    async ({ name, actor }) => {
      const result = await registry(env, "/create", { room: name || "", actor: actor || defaultActor("mcp"), mcpSessionId, ip });
      if (result.ok === false) return toolJson(result, true);
      return toolJson(mcpCredentialResponse({
        room: result.room,
        actor: result.actor,
        scopes: result.scopes,
      }, result.token, mcpSessionId));
    },
  );

  server.tool(
    "intracode_join_room",
    "Redeem a one-time pair code and mint an actor token. In normal MCP sessions, the token is vaulted server-side and not returned.",
    {
      code: z.string().min(1).describe("One-time pair code, for example M2Q4-K7P9."),
      actor: z.string().optional().describe("Actor name for attribution, for example claude-code. Omit to auto-generate one."),
    },
    async ({ code, actor }) => {
      const result = await registry(env, "/join", { code, actor: actor || defaultActor("mcp"), mcpSessionId, ip });
      if (result.ok === false) return toolJson(result, true);
      return toolJson(mcpCredentialResponse({
        room: result.room,
        actor: result.actor,
        scopes: result.scopes,
      }, result.token, mcpSessionId));
    },
  );

  server.tool(
    "intracode_pair_room",
    "Create a one-time pair code for another actor. Requires an admin room_secret or Authorization bearer header. Prefer pair codes over sharing room_secret.",
    {
      room: z.string().min(1).describe("Room name, for example debugging-worker-k7p9."),
      room_secret: z.string().optional().describe("Admin room secret returned by intracode_create_room. Not needed if the MCP connection has an Authorization bearer header with admin scope."),
    },
    async ({ room, room_secret }) => {
      const token = room_secret || headerToken;
      if (!token && !mcpSessionId) return toolJson({ error: "missing_room_auth" }, true);
      const result = await registry(env, "/pair", { room, token, mcpSessionId, ip });
      if (result.ok === false) return toolJson(result, true);
      return toolJson({
        room: result.room,
        code: result.code,
        expires_at: result.expires_at,
        scopes: result.scopes,
        next: "Share only this one-time code with the other agent. Do not share room_secret.",
      });
    },
  );

  server.tool(
    "intracode_room",
    "Read and write a durable Markdown context room. Uses the MCP session vault, Authorization header, or room_secret fallback.",
    {
      room: z.string().min(1).describe("Room name, for example 'sdan/intracode/auth'."),
      room_secret: z.string().optional().describe("Fallback room secret. Usually not needed because create/join vault the token in this MCP session."),
      op: z.enum(["read", "write", "checkpoint", "history", "who", "help"]).default("read").describe("Room operation."),
      body: z.string().optional().describe("Markdown body for write/checkpoint."),
      after: z.number().int().nonnegative().optional().describe("Only return events after this event id."),
      limit: z.number().int().positive().max(MAX_LIMIT).optional().describe("Maximum events to return. Defaults to 10."),
      format: z.enum(["compact", "markdown"]).optional().describe("compact truncates long event bodies. Defaults to compact."),
    },
    async ({ room, room_secret, op, body, after, limit, format }) => {
      const token = room_secret || headerToken;
      if (!token && !mcpSessionId) return toolJson({ error: "missing_room_auth" }, true);
      const result = await authedRoomOp(env, token, mcpSessionId, room, { op, body, after, limit, format }, ip);
      return {
        content: [{ type: "text", text: result.exitCode === 0 ? result.stdout : result.stderr }],
        isError: result.exitCode !== 0,
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const token = bearerToken(request);
      return createMcpHandler(createServer(env, token, mcpSessionId(request), clientIp(request)), {
        sessionIdGenerator: () => crypto.randomUUID(),
        storage: mcpTransportStorage(env, request),
      })(request, env, ctx);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const input = await request.json<{ room?: string; actor?: string }>();
      return json(await registry(env, "/create", { ...input, ip: clientIp(request) }));
    }

    if (url.pathname === "/api/join" && request.method === "POST") {
      const input = await request.json<{ code?: string; actor?: string }>();
      return json(await registry(env, "/join", { ...input, ip: clientIp(request) }));
    }

    if (url.pathname.startsWith("/api/rooms/")) {
      return handleRoomAdmin(request, env, url, clientIp(request));
    }

    if (url.pathname.startsWith("/rooms/")) {
      return handleRoomHttp(request, env, url, clientIp(request));
    }

    if (url.pathname === "/" || url.pathname === "/help") {
      return text(httpHelpText());
    }

    return json({ error: "not_found" }, 404);
  },
};

async function handleRoomAdmin(request: Request, env: Env, url: URL, ip: string): Promise<Response> {
  const parts = url.pathname.slice("/api/rooms/".length).split("/");
  const action = parts.pop();
  const room = decodeURIComponent(parts.join("/"));
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_token" }, 401);

  if (request.method === "POST" && action === "pair") {
    const input: { scopes?: string[] } = await request.json<{ scopes?: string[] }>().catch(() => ({}));
    return json(await registry(env, "/pair", { room, token, scopes: input.scopes, ip }));
  }

  if (request.method === "GET" && action === "actors") {
    return json(await registry(env, "/actors", { room, token, ip }));
  }

  if (request.method === "POST" && action === "revoke") {
    const input = await request.json<{ actor?: string }>();
    return json(await registry(env, "/revoke", { room, token, actor: input.actor, ip }));
  }

  if (request.method === "POST" && action === "rotate") {
    const result = await registry(env, "/rotate", { room, token, ip });
    return json(result, result.ok === false ? 401 : 200);
  }

  if (request.method === "POST" && action === "delete") {
    const result = await registry(env, "/delete", { room, token, ip });
    if (result.ok === false) return json(result, 401);
    await roomControl(env, room, "/delete");
    return json(result);
  }

  if (request.method === "GET" && action === "export") {
    const auth = await verify(env, room, token, "", "read", ip);
    if (!auth.ok) return json(auth, 401);
    return text(await roomControlText(env, room, "/export"));
  }

  return json({ error: "not_found" }, 404);
}

async function handleRoomHttp(request: Request, env: Env, url: URL, ip: string): Promise<Response> {
  const room = decodeURIComponent(url.pathname.slice("/rooms/".length));
  const token = bearerToken(request);
  if (!token) return json({ error: "missing_token" }, 401);

  if (request.method === "GET") {
    const op = (url.searchParams.get("op") || "read") as RoomOp;
    const after = parseCursor(url.searchParams.get("after"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await authedRoomOp(env, token, "", room, { op, after, limit }, ip);
    return result.exitCode === 0 ? text(result.stdout) : json({ error: result.stderr }, 403);
  }

  if (request.method === "POST") {
    const input = await request.json<RoomRequest>();
    const result = await authedRoomOp(env, token, "", room, input, ip);
    return json(result, result.exitCode === 0 ? 200 : 403);
  }

  return json({ error: "method_not_allowed" }, 405);
}

async function authedRoomOp(env: Env, token: string, mcpSessionId: string, room: string, input: RoomRequest, ip: string): Promise<CommandResult> {
  const op = input.op || "read";
  const auth = await verify(env, room, token, mcpSessionId, scopeForOp(op), ip);
  if (!auth.ok || !auth.actor) return err(auth.error || "unauthorized");
  const actors = op === "who" ? await roomActors(env, room, token, mcpSessionId, ip) : undefined;
  return runRoomOp(env, room, { ...input, actor: auth.actor, knownActors: actors });
}

async function runRoomOp(env: Env, room: string, input: RoomRequest & { actor: string }): Promise<CommandResult> {
  const id = env.ROOMS.idFromName(sanitizeRoom(room));
  const stub = env.ROOMS.get(id);
  const response = await stub.fetch("https://room.local/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.json();
}

async function roomControl(env: Env, room: string, path: string): Promise<Record<string, unknown>> {
  const id = env.ROOMS.idFromName(sanitizeRoom(room));
  const stub = env.ROOMS.get(id);
  const response = await stub.fetch(`https://room.local${path}`, { method: "POST" });
  return response.json();
}

async function roomControlText(env: Env, room: string, path: string): Promise<string> {
  const id = env.ROOMS.idFromName(sanitizeRoom(room));
  const stub = env.ROOMS.get(id);
  const response = await stub.fetch(`https://room.local${path}`, { method: "POST" });
  return response.text();
}

async function verify(env: Env, room: string, token: string, mcpSessionId: string, scope: Scope, ip: string): Promise<AuthResult> {
  return registry(env, "/verify", { room, token, mcpSessionId, scope, ip }) as Promise<AuthResult>;
}

async function registry(env: Env, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const response = await stub.fetch(`https://registry.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function mcpTransportStorage(env: Env, request: Request) {
  const requestSessionId = mcpSessionId(request);
  return {
    get: async (): Promise<TransportState | undefined> => {
      if (!requestSessionId) return undefined;
      const result = await registry(env, "/mcp-transport-get", { mcpSessionId: requestSessionId });
      return result.state as TransportState | undefined;
    },
    set: async (state: TransportState) => {
      const stateSessionId = state.sessionId || "";
      const sessionId = stateSessionId || requestSessionId;
      if (!sessionId) return;
      await registry(env, "/mcp-transport-set", { mcpSessionId: sessionId, state });
    },
  };
}

async function roomActors(env: Env, room: string, token: string, mcpSessionId: string, ip: string): Promise<string[] | undefined> {
  const result = await registry(env, "/actors", { room, token, mcpSessionId, ip });
  return Array.isArray(result.actors) ? result.actors.filter((actor): actor is string => typeof actor === "string") : undefined;
}

function scopeForOp(op: RoomOp): Scope {
  if (op === "write") return "write";
  if (op === "checkpoint") return "checkpoint";
  return "read";
}

function hasScope(scopes: Scope[], required: Scope): boolean {
  return scopes.includes("admin") || scopes.includes(required);
}

function parseScopes(value: unknown, fallback: Scope[]): Scope[] {
  if (!Array.isArray(value)) return fallback;
  const scopes = value.filter((scope): scope is Scope => ["read", "write", "checkpoint", "admin"].includes(String(scope)));
  return scopes.length ? scopes : fallback;
}

function parseLimit(value: string | number | null | undefined): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseCursor(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function cleanBody(body: string | undefined): string | undefined {
  const value = body?.trim();
  if (!value) return undefined;
  return value.slice(0, MAX_BODY_CHARS);
}

function sanitizeRoom(room: string): string {
  const value = room.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(value)) throw new Error("invalid room");
  return value;
}

function sanitizeActor(actor: string): string {
  return actor.trim().replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 80) || "actor";
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_BODY_CHARS_IN_READ) return normalized;
  return `${normalized.slice(0, MAX_BODY_CHARS_IN_READ - 1)}…`;
}

function formatTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function uniqueActors(actors: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const actor of actors) {
    const cleanActor = sanitizeActor(actor);
    if (seen.has(cleanActor)) continue;
    seen.add(cleanActor);
    result.push(cleanActor);
  }
  return result;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function mcpSessionId(request: Request): string {
  return request.headers.get("mcp-session-id") || "";
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function bearerFromUnknown(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function defaultActor(prefix: string): string {
  return `${prefix}-${randomSuffix(4)}`;
}

function randomToken(): string {
  return `ic_tok_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

function randomPairCode(): string {
  return `${randomSuffix(4).toUpperCase()}-${randomSuffix(4).toUpperCase()}`;
}

function randomSuffix(length: number): string {
  const alphabet = "23456789abcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let value = "";
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
}

function choice(values: string[]): string {
  const [byte] = crypto.getRandomValues(new Uint8Array(1));
  return values[byte % values.length];
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(hash));
}

function ok(stdout: string, cursor?: number): CommandResult {
  return { stdout, stderr: "", exitCode: 0, cursor };
}

function err(stderr: string): CommandResult {
  return { stdout: "", stderr, exitCode: 1 };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function toolJson(value: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

function mcpCredentialResponse(base: Record<string, unknown>, roomSecret: unknown, mcpSessionId: string): Record<string, unknown> {
  if (mcpSessionId) {
    return {
      ...base,
      credential: "stored_in_mcp_session",
      next: "Use intracode_room with this room. Do not pass room_secret in normal MCP session calls.",
    };
  }

  return {
    ...base,
    room_secret: roomSecret,
    credential: "returned_as_room_secret",
    next: "Pass room_secret to intracode_room or configure it as an Authorization bearer header.",
  };
}

function helpText(): string {
  return `intracode room ops\n\nread                  Show checkpoint and recent events\nhistory               Show recent events, optionally after a cursor\nwrite                 Append a short Markdown note\ncheckpoint            Replace the shared checkpoint\nwho                   Show known actors and recent activity\nhelp                  Show this help\n`;
}

function httpHelpText(): string {
  return `# intracode\n\nMCP rooms for coding agents.\n\nEndpoint: https://intracode.sdan.io/mcp\n\nRooms require bearer tokens. The public service does not expose global room or actor discovery.\n`;
}
