import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";
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
const SLUG_NOUNS = ["worker", "room", "auth", "token", "checkpoint", "event", "schema", "request", "diff", "build", "agent", "device", "context", "router", "stack", "log"];

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
      const actor = sanitizeLabel(input.actor || request.headers.get("x-intracode-actor") || "anonymous");
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
        return ok("Updated checkpoint\n", event.id);
      }

      case "who":
        return ok(`${input.actor}\n`);

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

  private renderEvents(events: RoomEvent[], format: "compact" | "markdown"): string {
    return events
      .map((event) => {
        const timestamp = event.ts.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
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
        label TEXT NOT NULL,
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

    if (request.method === "POST" && url.pathname === "/create") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`create:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL) || this.checkBucket("create:global", CREATE_GLOBAL_CAPACITY, CREATE_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.createRoom(String(body.room || ""), String(body.label || "device")));
    }

    if (request.method === "POST" && url.pathname === "/verify") {
      return json(await this.verify(String(body.room || ""), bearerFromUnknown(body.token), String(body.scope || "read") as Scope, String(body.ip || "unknown")));
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const auth = await this.verify(String(body.room || ""), bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(await this.createPairCode(String(body.room), parseScopes(body.scopes, ["read", "write", "checkpoint"])));
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`join:ip:${ip}`, JOIN_IP_CAPACITY, JOIN_IP_REFILL) || this.checkBucket("join:global", JOIN_GLOBAL_CAPACITY, JOIN_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.join(String(body.code || ""), String(body.label || "device")));
    }

    if (request.method === "POST" && url.pathname === "/devices") {
      const auth = await this.verify(String(body.room || ""), bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json({ devices: this.devices(String(body.room)) });
    }

    if (request.method === "POST" && url.pathname === "/revoke") {
      const auth = await this.verify(String(body.room || ""), bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(this.revoke(String(body.room), String(body.label || "")));
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

  private async createRoom(room: string, label: string): Promise<Record<string, unknown>> {
    const cleanRoom = room.trim() ? sanitizeRoom(room) : this.generateRoomSlug();
    const cleanLabel = sanitizeLabel(label);
    const existing = this.ctx.storage.sql.exec("SELECT room FROM rooms WHERE room = ?", cleanRoom).toArray()[0];
    if (existing) return { ok: false, error: "room_exists" };

    const now = new Date().toISOString();
    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");
    const scopes: Scope[] = ["read", "write", "checkpoint", "admin"];

    this.ctx.storage.sql.exec("INSERT INTO rooms (room, created_at) VALUES (?, ?)", cleanRoom, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (token_hash, token_id, room, label, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      cleanRoom,
      cleanLabel,
      scopes.join(","),
      now,
    );

    return { ok: true, room: cleanRoom, token, label: cleanLabel, scopes };
  }

  private async verify(room: string, token: string, scope: Scope, ip: string): Promise<AuthResult> {
    const cleanRoom = sanitizeRoom(room);
    if (!token) return { ok: false, error: "missing_token" };

    const ipLimited = this.checkBucket(`verify:ip:${ip}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
    if (ipLimited) return ipLimited;

    const globalLimited = this.checkBucket("ops:global", GLOBAL_OPS_CAPACITY, GLOBAL_OPS_REFILL);
    if (globalLimited) return globalLimited;

    const tokenHash = await sha256(token);
    const tokenLimited = this.checkBucket(`ops:token:${tokenHash}`, ROOM_OPS_TOKEN_CAPACITY, ROOM_OPS_TOKEN_REFILL);
    if (tokenLimited) return tokenLimited;

    if (scope === "write" || scope === "checkpoint") {
      const writeLimited = this.checkBucket(`write:token:${tokenHash}`, WRITE_TOKEN_CAPACITY, WRITE_TOKEN_REFILL);
      if (writeLimited) return writeLimited;
    }

    const row = this.ctx.storage.sql
      .exec<{ token_id: string; room: string; label: string; scopes: string; last_seen_at: string | null; revoked_at: string | null }>(
        `SELECT token_id, room, label, scopes, last_seen_at, revoked_at
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

    return { ok: true, room: row.room, actor: row.label, scopes, tokenId: row.token_id };
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

  private async join(code: string, label: string): Promise<Record<string, unknown>> {
    const cleanCode = code.trim();
    const cleanLabel = sanitizeLabel(label);
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
      `INSERT INTO tokens (token_hash, token_id, room, label, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      row.room,
      cleanLabel,
      row.scopes,
      now,
    );

    return { ok: true, room: row.room, token, label: cleanLabel, scopes: row.scopes.split(",") };
  }

  private devices(room: string): Array<Record<string, unknown>> {
    const cleanRoom = sanitizeRoom(room);
    return this.ctx.storage.sql
      .exec<{ token_id: string; label: string; scopes: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }>(
        `SELECT token_id, label, scopes, created_at, last_seen_at, revoked_at
         FROM tokens
         WHERE room = ?
         ORDER BY created_at ASC`,
        cleanRoom,
      )
      .toArray()
      .map((row) => ({ ...row, scopes: row.scopes.split(","), active: !row.revoked_at }));
  }

  private revoke(room: string, label: string): Record<string, unknown> {
    const cleanRoom = sanitizeRoom(room);
    const cleanLabel = sanitizeLabel(label);
    this.ctx.storage.sql.exec(
      "UPDATE tokens SET revoked_at = ? WHERE room = ? AND label = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      cleanRoom,
      cleanLabel,
    );
    return { ok: true, room: cleanRoom, revoked: cleanLabel };
  }

  private async rotate(room: string, oldToken: string, actor: string): Promise<Record<string, unknown>> {
    const cleanRoom = sanitizeRoom(room);
    const oldHash = await sha256(oldToken);
    const row = this.ctx.storage.sql
      .exec<{ label: string; scopes: string }>("SELECT label, scopes FROM tokens WHERE token_hash = ? AND room = ? AND revoked_at IS NULL", oldHash, cleanRoom)
      .toArray()[0];
    if (!row) return { ok: false, error: "invalid_token" };

    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?", now, oldHash);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (token_hash, token_id, room, label, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      cleanRoom,
      actor || row.label,
      row.scopes,
      now,
    );

    return { ok: true, room: cleanRoom, token, label: actor || row.label, scopes: row.scopes.split(",") };
  }

  private deleteRoom(room: string): Record<string, unknown> {
    const cleanRoom = sanitizeRoom(room);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE room = ?", cleanRoom);
    this.ctx.storage.sql.exec("UPDATE tokens SET revoked_at = ? WHERE room = ? AND revoked_at IS NULL", now, cleanRoom);
    this.ctx.storage.sql.exec("UPDATE pair_codes SET used_at = ? WHERE room = ? AND used_at IS NULL", now, cleanRoom);
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

function createServer(env: Env, headerToken: string, ip: string): McpServer {
  const server = new McpServer({ name: "intracode", version: "0.1.0" });

  server.tool(
    "intracode_create_room",
    "Create a shared context room. Returns a room and room_secret. Keep room_secret private; pass it to intracode_room for future room operations.",
    {
      name: z.string().optional().describe("Optional room slug. Omit to generate a friendly slug like debugging-worker-k7p9."),
      label: z.string().optional().describe("Device/agent label, for example claude-code."),
    },
    async ({ name, label }) => {
      const result = await registry(env, "/create", { room: name || "", label: label || "mcp-agent", ip });
      if (result.ok === false) return toolJson(result, true);
      return toolJson({
        room: result.room,
        room_secret: result.token,
        label: result.label,
        scopes: result.scopes,
        next: "Use intracode_room with this room and room_secret. Do not write room_secret into the room.",
      });
    },
  );

  server.tool(
    "intracode_join_room",
    "Redeem a one-time pairing code. Returns a room and room_secret. Keep room_secret private; pass it to intracode_room for future room operations.",
    {
      code: z.string().min(1).describe("One-time pairing code, for example M2Q4-K7P9."),
      label: z.string().optional().describe("Device/agent label, for example claude-code."),
    },
    async ({ code, label }) => {
      const result = await registry(env, "/join", { code, label: label || "mcp-agent", ip });
      if (result.ok === false) return toolJson(result, true);
      return toolJson({
        room: result.room,
        room_secret: result.token,
        label: result.label,
        scopes: result.scopes,
        next: "Use intracode_room with this room and room_secret. Do not write room_secret into the room.",
      });
    },
  );

  server.tool(
    "intracode_room",
    "Read and write a durable Markdown context room shared by coding agents. Requires either a room_secret argument or an Authorization bearer header. Use op=read before work, op=write for discoveries, and op=checkpoint for compact summaries.",
    {
      room: z.string().min(1).describe("Room name, for example 'sdan/intracode/auth'."),
      room_secret: z.string().optional().describe("Room secret returned by intracode_create_room or intracode_join_room. Not needed if the MCP connection has an Authorization bearer header."),
      op: z.enum(["read", "write", "checkpoint", "history", "who", "help"]).default("read").describe("Operation to run."),
      body: z.string().optional().describe("Markdown body for write/checkpoint."),
      after: z.number().int().nonnegative().optional().describe("Only return events after this event id."),
      limit: z.number().int().positive().max(MAX_LIMIT).optional().describe("Maximum events to return. Defaults to 10."),
      format: z.enum(["compact", "markdown"]).optional().describe("compact truncates long event bodies. Defaults to compact."),
    },
    async ({ room, room_secret, op, body, after, limit, format }) => {
      const token = room_secret || headerToken;
      if (!token) return toolJson({ error: "missing_room_secret" }, true);
      const result = await authedRoomOp(env, token, room, { op, body, after, limit, format }, ip);
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
      return createMcpHandler(createServer(env, token, clientIp(request)))(request, env, ctx);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const input = await request.json<{ room?: string; label?: string }>();
      return json(await registry(env, "/create", { ...input, ip: clientIp(request) }));
    }

    if (url.pathname === "/api/join" && request.method === "POST") {
      const input = await request.json<{ code?: string; label?: string }>();
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

  if (request.method === "GET" && action === "devices") {
    return json(await registry(env, "/devices", { room, token, ip }));
  }

  if (request.method === "POST" && action === "revoke") {
    const input = await request.json<{ label?: string }>();
    return json(await registry(env, "/revoke", { room, token, label: input.label, ip }));
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
    const auth = await verify(env, room, token, "read", ip);
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
    const result = await authedRoomOp(env, token, room, { op, after, limit }, ip);
    return result.exitCode === 0 ? text(result.stdout) : json({ error: result.stderr }, 403);
  }

  if (request.method === "POST") {
    const input = await request.json<RoomRequest>();
    const result = await authedRoomOp(env, token, room, input, ip);
    return json(result, result.exitCode === 0 ? 200 : 403);
  }

  return json({ error: "method_not_allowed" }, 405);
}

async function authedRoomOp(env: Env, token: string, room: string, input: RoomRequest, ip: string): Promise<CommandResult> {
  const op = input.op || "read";
  const auth = await verify(env, room, token, scopeForOp(op), ip);
  if (!auth.ok || !auth.actor) return err(auth.error || "unauthorized");
  return runRoomOp(env, room, { ...input, actor: auth.actor });
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

async function verify(env: Env, room: string, token: string, scope: Scope, ip: string): Promise<AuthResult> {
  return registry(env, "/verify", { room, token, scope, ip }) as Promise<AuthResult>;
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

function sanitizeLabel(label: string): string {
  return label.trim().replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 80) || "device";
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_BODY_CHARS_IN_READ) return normalized;
  return `${normalized.slice(0, MAX_BODY_CHARS_IN_READ - 1)}…`;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
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

function helpText(): string {
  return `intracode room ops\n\nread                  Show checkpoint and recent events\nhistory               Show recent events\nwrite                 Append a Markdown note; requires body\ncheckpoint            Replace checkpoint; requires body\nwho                   Show current actor\nhelp                  Show this help\n`;
}

function httpHelpText(): string {
  return `# intracode\n\nShared Markdown context rooms for coding agents.\n\nCreate a room, pair another device with a one-time code, then read/write room context by sending a bearer token.\n`;
}
