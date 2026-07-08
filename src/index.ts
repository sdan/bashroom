import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Sandbox as SandboxBase } from "@cloudflare/sandbox";
import { z } from "zod";
// Bundle the canonical SKILL.md at build time via wrangler's text-import
// rule. Serving /skill.md from this same string guarantees no drift
// between the bundled skill and what the worker hands out.
import skillMarkdown from "../skills/bashroom/SKILL.md";
// Rasterized OG card (1200×630). Bundled as an ArrayBuffer via wrangler's
// Data-import rule. Twitter/iMessage/Slack reject SVG for og:image, so the
// social card points at this PNG; /og.svg stays for in-app/landing use.
// Re-render after editing ogSvg(): `npm run og` (rsvg-convert → assets/og.png).
import ogPng from "../assets/og.png";
import { ogSvg } from "./og";
import { webIndexHtml } from "./web-ui";
import { webLandingHtml } from "./web-landing";
import { webDeviceHtml, webDeviceResultHtml } from "./web-device";

export { ContainerProxy } from "@cloudflare/sandbox";

type Env = {
  REGISTRY: DurableObjectNamespace<Registry>;
  ACCOUNTS: DurableObjectNamespace<AccountDO>;
  SANDBOXES: DurableObjectNamespace<Sandbox>;
  ROOM_HUBS: DurableObjectNamespace<RoomHub>;
  ROOMS_R2: R2Bucket;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BASHROOM_PUBLIC_URL?: string;
  R2_BUCKET_NAME?: string;
  SANDBOX_TRANSPORT?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

// Sandbox subclass — wrangler.jsonc declares class_name: "Sandbox" and
// the container image. We only need to extend SandboxBase and set the
// idle sleep timer; everything else is provided by @cloudflare/sandbox.
export class Sandbox extends SandboxBase<Env> {
  defaultPort = 3000;
  sleepAfter: string = "15m";
}

// Match the SDK's own pattern (see @cloudflare/sandbox's R2EgressProxyTarget):
// assign outboundHandlers after the class declaration so the runtime lookup
// finds it on the constructor, not buried in a transpiled static initializer.
(Sandbox as unknown as { outboundHandlers: Record<string, unknown> }).outboundHandlers = {
  bashroomControl: handleSandboxBashroomControl,
};

// ─── RoomHub — per-room presence + live-activity fanout ───────────────────
// One DO per (userId, room). Web readers hold hibernating WebSockets; every
// Worker-side write pokes the hub, which records the event in a small SQLite
// ring and broadcasts it to connected readers. A fresh page gets the recent
// ring in its hello frame, so "codex · wrote 2m ago" paints without waiting
// for a live event. Hibernation-friendly by construction: no timers, no
// outbound connections, and client keepalive pings are answered by
// setWebSocketAutoResponse without waking the object. Pokes are fire-and-
// forget from the caller — presence must never make a write slower or
// break it.
type HubEvent = { actor: string; path: string; etag?: string; source?: "web" | "mcp" | "shell" };

export class RoomHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          actor TEXT NOT NULL,
          path TEXT NOT NULL,
          etag TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT ''
        );
      `);
    });
    // Answered by the runtime while hibernated — the client's 45s "ping"
    // keeps intermediaries from reaping the socket without ever waking us.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // RPC from the Worker's write paths. Records + broadcasts one write event.
  async hubPoke(event: HubEvent): Promise<void> {
    const ts = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO activity (ts, actor, path, etag, source) VALUES (?, ?, ?, ?, ?)",
      ts, event.actor, event.path, event.etag || "", event.source || "",
    );
    // Ring semantics: keep the newest 100 rows, prune inline (no alarm).
    this.ctx.storage.sql.exec(
      "DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 100)",
    );
    this.broadcast({ type: "write", ts, actor: event.actor, path: event.path, etag: event.etag || "", source: event.source || "" });
  }

  // WebSocket upgrade, forwarded from the Worker AFTER token + membership
  // auth — the hub trusts its caller. (The forwarded headers still include
  // the tok.* subprotocol slot; never log request headers here.)
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const viewer = url.searchParams.get("viewer") || "reader";
    // Share-link sockets are capability-scoped: they only receive events for
    // paths under the shared prefix, and anything they SEND is dropped.
    const prefix = url.searchParams.get("prefix") || "";
    const readonly = url.searchParams.get("readonly") === "1";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ viewer, since: Date.now(), prefix, readonly });
    const recent = this.ctx.storage.sql
      .exec<{ ts: number; actor: string; path: string; etag: string; source: string }>(
        "SELECT ts, actor, path, etag, source FROM activity ORDER BY id DESC LIMIT 20",
      )
      .toArray()
      .filter((row) => this.pathVisible(row.path, prefix));
    server.send(JSON.stringify({ type: "hello", recent, viewers: this.ctx.getWebSockets().length }));
    this.broadcastViewers();
    // The browser requires the response to select one of the offered
    // subprotocols; echo the app protocol (never the tok.* credential slot).
    const offered = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",").map((p) => p.trim()).find((p) => p && !p.startsWith("tok."));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: offered ? { "Sec-WebSocket-Protocol": offered } : undefined,
    });
  }

  // Live-edit relay: clients stream ephemeral "draft" frames (current
  // buffer + caret) while typing; the hub fans them out to the room's OTHER
  // sockets so collaborators watch the document change under the writer's
  // hands. Never persisted — the activity ring records only durable writes.
  // Rate-limited per socket via the hibernation attachment; malformed or
  // oversized frames are dropped. (Keepalive pings are answered by the
  // auto-response pair without reaching this handler.)
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string" || message.length > 300_000) return;
    let frame: { type?: string; path?: unknown; caret?: unknown; content?: unknown };
    try { frame = JSON.parse(message); } catch (_) { return; }
    if (!frame || frame.type !== "draft" || typeof frame.path !== "string") return;
    const attachment = (ws.deserializeAttachment() || {}) as { viewer?: string; since?: number; lastDraft?: number; prefix?: string; readonly?: boolean };
    if (attachment.readonly) return; // share viewers watch; they don't write
    const now = Date.now();
    if (attachment.lastDraft && now - attachment.lastDraft < 150) return;
    ws.serializeAttachment({ ...attachment, lastDraft: now });
    const out = JSON.stringify({
      type: "draft",
      actor: String(attachment.viewer || "someone"),
      path: frame.path.slice(0, 512),
      caret: typeof frame.caret === "number" ? frame.caret : 0,
      content: typeof frame.content === "string" ? frame.content.slice(0, 262_144) : "",
      ts: now,
    });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      try { socket.send(out); } catch (_) { /* mid-close */ }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch (_) { /* already closing */ }
    // getWebSockets() still contains the terminating socket while this
    // handler runs — exclude it or every disconnect over-counts forever
    // (the broadcast after close is the LAST frame survivors receive).
    this.broadcastViewers(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastViewers(ws);
  }

  // A path is visible to a socket when the socket is unscoped (room member)
  // or the path sits under its share prefix. Room-level touches (path "")
  // only reach unscoped sockets — a prefix capability shouldn't observe
  // activity elsewhere in the room.
  private pathVisible(path: string, prefix: string): boolean {
    if (!prefix) return true;
    if (!path) return false;
    return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
  }

  private broadcast(message: Record<string, unknown>, exclude?: WebSocket): void {
    const frame = JSON.stringify(message);
    const path = typeof message.path === "string" ? message.path : undefined;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      if (path !== undefined) {
        const attachment = (ws.deserializeAttachment() || {}) as { prefix?: string };
        if (!this.pathVisible(path, attachment.prefix || "")) continue;
      }
      try { ws.send(frame); } catch (_) { /* socket mid-close; skip */ }
    }
  }

  private broadcastViewers(exclude?: WebSocket): void {
    const viewers = this.ctx.getWebSockets().filter((ws) => ws !== exclude).length;
    this.broadcast({ type: "viewers", viewers }, exclude);
  }
}

export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_profile (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_tokens (
        token_hash TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_rooms (
        room TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        scopes TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_buckets (
        key TEXT PRIMARY KEY,
        credits REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT NOT NULL,
        route TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        input_bytes INTEGER NOT NULL,
        write_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, route)
      );
    `);
  }

  async syncAccount(input: {
    userId: string;
    handle: string;
    tokenHash?: string;
    tokenId?: string;
    createdAt?: string;
    rooms?: AccountRoom[];
  }): Promise<{ ok: true }> {
    const now = input.createdAt || new Date().toISOString();
    this.upsertProfile(input.userId, input.handle, now);

    if (input.tokenHash) {
      this.ctx.storage.sql.exec(
        `INSERT INTO account_tokens (token_hash, token_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           token_id = excluded.token_id`,
        input.tokenHash,
        input.tokenId || "synced",
        now,
      );
    }

    if (input.rooms) {
      this.ctx.storage.sql.exec("DELETE FROM account_rooms");
      for (const room of input.rooms) this.upsertRoomRow(room);
    }

    return { ok: true };
  }

  async upsertRoom(input: {
    userId: string;
    handle: string;
    room: string;
    actor: string;
    scopes: Scope[];
    role: string;
    createdAt?: string;
  }): Promise<{ ok: true }> {
    const now = input.createdAt || new Date().toISOString();
    this.upsertProfile(input.userId, input.handle, now);
    this.upsertRoomRow({
      room: input.room,
      actor: input.actor,
      scopes: input.scopes,
      role: input.role,
      created_at: now,
    });
    return { ok: true };
  }

  async deleteRoom(room: string): Promise<{ ok: true }> {
    this.ctx.storage.sql.exec("DELETE FROM account_rooms WHERE room = ?", sanitizeWiki(room));
    return { ok: true };
  }

  async authorizeAndCharge(input: {
    tokenHash: string;
    ip: string;
    route: string;
    cost?: number;
    inputBytes?: number;
    writeBytes?: number;
    includeRooms?: boolean;
  }): Promise<AccountWire> {
    const tokenHash = input.tokenHash || "";
    if (!tokenHash) return { ok: false, error: "missing_token" };

    // Pre-auth abuse brake only. Signed-in product limits happen after the
    // token proves account ownership; this keeps random token guesses from
    // creating one rate_buckets row per bogus token hash.
    const ipLimited = this.checkBucket(`verify:ip:${input.ip || "unknown"}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
    if (ipLimited) return ipLimited;

    const token = this.ctx.storage.sql
      .exec<{ last_seen_at: string | null; revoked_at: string | null }>(
        "SELECT last_seen_at, revoked_at FROM account_tokens WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!token || token.revoked_at) return { ok: false, error: "invalid_token" };

    const profile = this.profile();
    if (!profile) return { ok: false, error: "no_account" };

    const tokenLimited = this.checkBucket(`ops:token:${tokenHash}`, OPS_TOKEN_CAPACITY, OPS_TOKEN_REFILL, input.cost || 1);
    if (tokenLimited) return tokenLimited;

    const userLimited = this.checkBucket("ops:user", OPS_TOKEN_CAPACITY, OPS_TOKEN_REFILL, input.cost || 1);
    if (userLimited) return userLimited;

    this.trackDailyUsage(input.route || "unknown", input.inputBytes || 0, input.writeBytes || 0);

    const now = Date.now();
    if (!token.last_seen_at || now - Date.parse(token.last_seen_at) > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec("UPDATE account_tokens SET last_seen_at = ? WHERE token_hash = ?", new Date(now).toISOString(), tokenHash);
    }

    return {
      ok: true,
      user_id: profile.user_id,
      handle: profile.handle,
      rooms: input.includeRooms ? this.rooms() : undefined,
    };
  }

  private profile(): { user_id: string; handle: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ user_id: string; handle: string }>("SELECT user_id, handle FROM account_profile LIMIT 1")
      .toArray()[0];
    return row || null;
  }

  private upsertProfile(userId: string, handle: string, now: string): void {
    if (!userId) throw new Error("missing user");
    const cleanHandle = sanitizeHandle(handle || "user");
    this.ctx.storage.sql.exec(
      `INSERT INTO account_profile (user_id, handle, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         handle = excluded.handle,
         updated_at = excluded.updated_at`,
      userId,
      cleanHandle,
      now,
      now,
    );
  }

  private upsertRoomRow(room: AccountRoom): void {
    const cleanRoom = sanitizeWiki(room.room);
    const cleanActor = sanitizeActor(room.actor);
    const scopes = room.scopes.length ? room.scopes : ["read"];
    this.ctx.storage.sql.exec(
      `INSERT INTO account_rooms (room, actor, scopes, role, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room) DO UPDATE SET
         actor = excluded.actor,
         scopes = excluded.scopes,
         role = excluded.role`,
      cleanRoom,
      cleanActor,
      scopes.join(","),
      room.role || "member",
      room.created_at || new Date().toISOString(),
    );
  }

  private rooms(): AccountRoom[] {
    return this.ctx.storage.sql
      .exec<{ room: string; actor: string; scopes: string; role: string; created_at: string }>(
        "SELECT room, actor, scopes, role, created_at FROM account_rooms ORDER BY created_at DESC",
      )
      .toArray()
      .map((row) => ({
        room: row.room,
        actor: row.actor,
        scopes: row.scopes.split(",") as Scope[],
        role: row.role,
        created_at: row.created_at,
      }));
  }

  private trackDailyUsage(route: string, inputBytes: number, writeBytes: number): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(
      `INSERT INTO daily_usage (day, route, request_count, input_bytes, write_bytes, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(day, route) DO UPDATE SET
         request_count = daily_usage.request_count + 1,
         input_bytes = daily_usage.input_bytes + excluded.input_bytes,
         write_bytes = daily_usage.write_bytes + excluded.write_bytes,
         updated_at = excluded.updated_at`,
      day,
      route || "unknown",
      Math.max(0, Math.floor(inputBytes)),
      Math.max(0, Math.floor(writeBytes)),
      now.toISOString(),
    );
  }

  private checkBucket(key: string, maxCredits: number, creditsPerMs: number, cost = 1): AccountWire | null {
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ credits: number; updated_at: number }>("SELECT credits, updated_at FROM rate_buckets WHERE key = ?", key)
      .toArray()[0];

    if (!existing) {
      this.ctx.storage.sql.exec("INSERT INTO rate_buckets (key, credits, updated_at) VALUES (?, ?, ?)", key, maxCredits - cost, now);
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
}


type Scope = "read" | "write" | "checkpoint" | "admin";

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  changed: number;
  changed_paths: string[];
};

type R2FileMetadata = {
  path: string;
  size_bytes: number;
  updated_at: string;
  etag: string;
  http_etag: string;
  version: string;
  content_type: string;
  custom_metadata: Record<string, string>;
};

type R2File = R2FileMetadata & {
  content: string;
  is_binary: boolean;
};

type ParsedRoomsPath = {
  root: boolean;
  room: string;
  path: string;
};

type StorageAccountAuth =
  | { ok: true; userId: string; handle: string; rooms: AccountRoom[] }
  | { ok: false; error: string; retry_after_seconds?: number };

type StorageRoomAuth =
  | { ok: true; userId: string; handle: string; room: string; actor: string; scopes: Scope[]; path: string }
  | { ok: false; error: string; retry_after_seconds?: number };

type AuthResult = {
  ok: boolean;
  wiki?: string;
  actor?: string;
  scopes?: Scope[];
  tokenId?: string;
  error?: string;
  retry_after_seconds?: number;
};

type AccountAuth = {
  ok: boolean;
  userId?: string;
  handle?: string;
  error?: string;
  retry_after_seconds?: number;
};

type AccountRoom = {
  room: string;
  actor: string;
  scopes: Scope[];
  role: string;
  created_at: string;
};

type AccountWire = {
  ok: boolean;
  user_id?: string;
  handle?: string;
  rooms?: AccountRoom[];
  error?: string;
  retry_after_seconds?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_COMMAND_CHARS = 32_000;
// Hard cap on bashroom_write content. R2 supports much larger objects,
// but the MCP tool round-trip is JSON-serialized through the wire, so
// huge payloads are awkward. 5 MB is well above any reasonable note.
const MAX_WRITE_BYTES = 5_000_000;
const DEFAULT_MCP_READ_BYTES = 64_000;
const MAX_MCP_READ_BYTES = 512_000;
const DEFAULT_MCP_TREE_ENTRIES = 200;
const MAX_MCP_TREE_ENTRIES = 1_000;
const DEFAULT_MCP_SEARCH_MATCHES = 50;
const MAX_MCP_SEARCH_MATCHES = 200;
const DEFAULT_MCP_SEARCH_FILES = 200;
const MAX_MCP_SEARCH_FILES = 1_000;
const DEFAULT_MCP_SEARCH_FILE_BYTES = 256_000;
const MAX_MCP_SEARCH_FILE_BYTES = 1_000_000;
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
const OPS_TOKEN_CAPACITY = 1_200;
const OPS_TOKEN_REFILL = 20 / 1000;
const WRITE_TOKEN_CAPACITY = 300;
const WRITE_TOKEN_REFILL = 10 / MINUTE_MS;
const GLOBAL_OPS_CAPACITY = 50_000;
const GLOBAL_OPS_REFILL = 50_000 / DAY_MS;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * MINUTE_MS;
// Registry cleanup-alarm cadence + per-table TTLs for the sweep.
const CLEANUP_INTERVAL_MS = HOUR_MS;
const BUCKET_TTL_MS = DAY_MS;
const SLUG_VERBS = [
  "accomplishing", "actioning", "actualizing", "architecting", "baking", "beaming", "beboppin", "befuddling",
  "billowing", "blanching", "bloviating", "boogieing", "boondoggling", "booping", "bootstrapping", "brewing",
  "bunning", "burrowing", "calculating", "canoodling", "caramelizing", "cascading", "catapulting", "cerebrating",
  "channeling", "choreographing", "churning", "coalescing", "cogitating", "combobulating", "composing", "computing",
  "concocting", "considering", "contemplating", "cooking", "crafting", "creating", "crunching", "crystallizing",
  "cultivating", "deciphering", "deliberating", "determining", "discombobulating", "doing", "doodling", "drizzling",
  "ebbing", "effecting", "elucidating", "embellishing", "enchanting", "envisioning", "evaporating", "fermenting",
  "finagling", "flowing", "flummoxing", "fluttering", "forging", "forming", "frolicking", "frosting",
  "gallivanting", "galloping", "garnishing", "generating", "gesticulating", "germinating", "grooving", "gusting",
  "harmonizing", "hashing", "hatching", "herding", "honking", "hullaballooing", "hyperspacing", "ideating",
  "imagining", "improvising", "incubating", "inferring", "infusing", "ionizing", "jitterbugging", "julienning",
  "kneading", "leavening", "levitating", "lollygagging", "manifesting", "marinating", "meandering", "metamorphosing",
  "misting", "moonwalking", "moseying", "mulling", "mustering", "musing", "nebulizing", "nesting",
  "noodling", "nucleating", "orbiting", "orchestrating", "osmosing", "perambulating", "percolating", "perusing",
  "pollinating", "pondering", "pontificating", "pouncing", "precipitating", "prestidigitating", "processing", "proofing",
  "propagating", "puttering", "puzzling", "quantumizing", "razzmatazzing", "recombobulating", "reticulating", "roosting",
  "ruminating", "scampering", "schlepping", "scurrying", "seasoning", "shenaniganing", "shimmying", "simmering",
  "skedaddling", "sketching", "slithering", "smooshing", "spelunking", "spinning", "sprouting", "stewing",
  "sublimating", "swirling", "swooping", "symbioting", "synthesizing", "tempering", "thinking", "thundering",
  "tinkering", "tomfoolering", "transfiguring", "transmuting", "twisting", "undulating", "unfurling", "vibing",
  "waddling", "wandering", "warping", "whirlpooling", "whirring", "whisking", "wibbling", "working",
  "wrangling", "zesting", "zigzagging",
];

// (Room DO removed in v4 — files now live in R2, audit in Registry.)

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS wikis (
        room TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
    // Pair codes survive — short-lived invites that bestow membership on
    // redemption by an authenticated user.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS wiki_pair_codes (
        code_hash TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `);
    // The MCP transport is stateless (no Mcp-Session-Id) as of 2026-07 —
    // per-session transport state is gone, and the spec is converging on
    // sessionless servers (the 2026-07-28 revision removes sessions
    // entirely). Drop the old table so existing Registry DOs self-clean.
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS mcp_transport_states;");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credit_buckets (
        key TEXT PRIMARY KEY,
        credits REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Idempotent column adds for existing deployments. NULLable so legacy
    // rows (created before OAuth) coexist with stitched-to-GitHub rows.
    const userCols = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('users')")
      .toArray()
      .map((r) => r.name);
    if (!userCols.includes("github_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE users ADD COLUMN github_id INTEGER");
      this.ctx.storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_idx ON users(github_id) WHERE github_id IS NOT NULL");
    }
    if (!userCols.includes("github_login")) {
      this.ctx.storage.sql.exec("ALTER TABLE users ADD COLUMN github_login TEXT");
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        token_hash TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_rooms (
        user_id TEXT NOT NULL,
        room TEXT NOT NULL,
        actor TEXT NOT NULL,
        scopes TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, room)
      );
    `);
    // Public shares: an unguessable slug is the whole capability. It maps to
    // one (user, room, prefix) subtree; anyone holding the URL can read that
    // subtree anonymously. prefix '' shares the whole room.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        slug TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        room TEXT NOT NULL,
        prefix TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS shares_user_idx ON shares(user_id, created_at DESC)");
    // Device codes for OAuth device flow. Lifecycle: minted by /auth/device/start,
    // displayed at /device, claimed by /auth/github/callback, polled by CLI.
    // Single row per code; deleted by background sweep or on first claim.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS device_codes (
        code_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        oauth_state TEXT,
        user_id TEXT,
        token TEXT
      );
    `);
    // ─── MCP OAuth (RFC 7591 + OAuth 2.1 + PKCE) ──────────────────────────
    // Dynamically-registered MCP clients (e.g. claude.ai's connector). The
    // connector has no pre-shared client_id, so it self-registers here; we
    // store its allowed redirect_uris to validate the authorize/token dance.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        redirect_uris TEXT NOT NULL,   -- JSON array of allowed redirect URIs
        client_name TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // Short-lived authorization codes. Bound to a client, a redirect_uri, the
    // PKCE code_challenge, and (once GitHub auth completes) the resolved
    // user_id + minted br_user_ token. github_state stitches the in-flight
    // GitHub round-trip back to the pending code (mirrors device_codes).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,  -- PKCE S256 challenge
        github_state TEXT,             -- ties the GitHub callback back to this code
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_id TEXT,                  -- set after GitHub auth resolves
        token TEXT,                    -- the br_user_ token to hand to the client
        claimed_at TEXT                -- set when /token burns the code
      );
    `);
    // v2 audit log — replaces the per-room Room.audit table. Cross-room
    // queries (e.g. "show me everything I did today") become a single
    // SELECT instead of a fan-out over per-room DOs.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        user_id TEXT NOT NULL,
        room TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        command TEXT,
        exit_code INTEGER
      );
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS audit_room_idx ON audit(room, id DESC)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS audit_user_idx ON audit(user_id, id DESC)`);
  }

  // Arm the hourly cleanup alarm if one isn't already pending. Called after
  // inserting any row with a TTL (device/oauth codes, pair codes) so abandoned
  // rows — which hold short-lived plaintext tokens — don't accrete forever.
  private async armCleanup(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }

  // Sweep expired/stale rows. Re-arms only while sweepable rows remain, so an
  // idle Registry stops waking itself.
  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM device_codes WHERE expires_at < ?", now);
    sql.exec("DELETE FROM oauth_codes WHERE expires_at < ?", now);
    sql.exec("DELETE FROM wiki_pair_codes WHERE expires_at < ?", now);
    // Rate-limit buckets refill over time; a row untouched for a day is at
    // full credits and carries no state worth keeping.
    sql.exec("DELETE FROM credit_buckets WHERE updated_at < ?", Date.now() - BUCKET_TTL_MS);
    const remaining = sql
      .exec<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM device_codes) + (SELECT COUNT(*) FROM oauth_codes) + (SELECT COUNT(*) FROM wiki_pair_codes) AS n",
      )
      .toArray()[0]?.n ?? 0;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJson(request) : {};

    // Every room operation below requires an account token. No anonymous paths.
    if (request.method === "POST" && url.pathname === "/create") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`create:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL) || this.checkBucket("create:global", CREATE_GLOBAL_CAPACITY, CREATE_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      const account = await this.verifyAccount(bearerFromUnknown(body.token), ip);
      if (!account.ok) return json(account, 401);
      return json(await this.createWiki(account.userId || "", account.handle || "user", String(body.wiki || ""), String(body.actor || "")));
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`join:ip:${ip}`, JOIN_IP_CAPACITY, JOIN_IP_REFILL) || this.checkBucket("join:global", JOIN_GLOBAL_CAPACITY, JOIN_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      const account = await this.verifyAccount(bearerFromUnknown(body.token), ip);
      if (!account.ok) return json(account, 401);
      return json(await this.join(account.userId || "", account.handle || "user", String(body.invite || body.code || ""), String(body.actor || "")));
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(await this.createPairCode(wiki, parseScopes(body.scopes, ["read", "write", "checkpoint"])));
    }

    if (request.method === "POST" && url.pathname === "/mounts") {
      const ip = String(body.ip || "unknown");
      const account = await this.verifyAccount(bearerFromUnknown(body.token), ip);
      if (!account.ok) return json({ ok: true, mounts: [] }); // no account = no mounts (don't error)
      return json({ ok: true, mounts: this.mounts(account.userId || "") });
    }

    if (request.method === "POST" && url.pathname === "/actors") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), "read", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json({ ok: true, actors: this.actors(wiki) });
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(await this.deleteWiki(wiki));
    }

    if (request.method === "POST" && url.pathname === "/account-rooms") {
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json({ ok: true, user_id: account.userId, handle: account.handle, rooms: this.accountRooms(account.userId || "") });
    }

    if (request.method === "POST" && url.pathname === "/account-room-create") {
      // Registry-side create path used by the public /account/room-create wrapper.
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json(await this.createWiki(account.userId || "", account.handle || "user", String(body.room || body.wiki || ""), String(body.actor || "")));
    }

    // ─── Public shares ───────────────────────────────────────────────────
    // Create/list/delete require the account token; sharing is an access-
    // control action, so creating one requires admin on the room. Resolve is
    // anonymous (the slug IS the credential) and rate-limited per IP.
    if (request.method === "POST" && url.pathname === "/share-create") {
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      const room = String(body.room || body.wiki || "");
      const auth = this.authorizeUser(room, account.userId || "", "admin");
      if (!auth.ok) return json(auth, 403);
      return json(this.createShare(account.userId || "", room, String(body.prefix || "")));
    }

    if (request.method === "POST" && url.pathname === "/share-list") {
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json({ ok: true, shares: this.listShares(account.userId || "") });
    }

    if (request.method === "POST" && url.pathname === "/share-delete") {
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json(this.deleteShare(account.userId || "", String(body.slug || "")));
    }

    if (request.method === "POST" && url.pathname === "/share-resolve") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`share:ip:${ip}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
      if (limited) return json(limited, 429);
      return json(this.resolveShare(String(body.slug || "")));
    }

    // Internal sandbox-control paths. These are not exposed by handleRequest();
    // only Worker code calls them after the Sandbox outbound handler supplies
    // a trusted user_id through per-sandbox outbound params.
    if (request.method === "POST" && url.pathname === "/internal-account-rooms") {
      const userId = String(body.user_id || "");
      const user = this.userById(userId);
      if (!user) return json({ ok: false, error: "unknown_user" }, 401);
      return json({ ok: true, user_id: userId, handle: user.handle, rooms: this.accountRooms(userId) });
    }

    if (request.method === "POST" && url.pathname === "/internal-room-create") {
      const userId = String(body.user_id || "");
      const user = this.userById(userId);
      if (!user) return json({ ok: false, error: "unknown_user" }, 401);
      return json(await this.createWiki(userId, user.handle, String(body.room || body.wiki || ""), String(body.actor || "")));
    }

    if (request.method === "POST" && url.pathname === "/internal-room-join") {
      const userId = String(body.user_id || "");
      const user = this.userById(userId);
      if (!user) return json({ ok: false, error: "unknown_user" }, 401);
      return json(await this.join(userId, user.handle, String(body.invite || body.code || ""), String(body.actor || "")));
    }

    if (request.method === "POST" && url.pathname === "/internal-room-pair") {
      const userId = String(body.user_id || "");
      const wiki = String(body.wiki || body.room || "");
      const auth = this.authorizeUser(wiki, userId, "admin");
      if (!auth.ok) return json(auth, 401);
      return json(await this.createPairCode(wiki, parseScopes(body.scopes, ["read", "write", "checkpoint"])));
    }

    if (request.method === "POST" && url.pathname === "/internal-room-mounts") {
      const userId = String(body.user_id || "");
      if (!this.userById(userId)) return json({ ok: false, error: "unknown_user" }, 401);
      return json({ ok: true, mounts: this.mounts(userId) });
    }

    if (request.method === "POST" && url.pathname === "/internal-room-who") {
      const userId = String(body.user_id || "");
      const wiki = String(body.wiki || body.room || "");
      const auth = this.authorizeUser(wiki, userId, "read");
      if (!auth.ok) return json(auth, 401);
      return json({ ok: true, actors: this.actors(wiki) });
    }

    if (request.method === "POST" && url.pathname === "/internal-room-history") {
      const userId = String(body.user_id || "");
      const room = typeof body.room === "string" && body.room ? sanitizeWiki(body.room) : null;
      if (!this.userById(userId)) return json({ ok: false, error: "unknown_user" }, 401);
      if (room) {
        const auth = this.authorizeUser(room, userId, "read");
        if (!auth.ok) return json(auth, 401);
      }
      return json({
        ok: true,
        events: this.auditList({ userId, room, limit: parseLimit(body.limit) }),
      });
    }

    if (request.method === "POST" && url.pathname === "/device-start") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`device:start:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.startDeviceFlow());
    }

    if (request.method === "POST" && url.pathname === "/device-poll") {
      return json(await this.pollDeviceCode(String(body.code || "")));
    }

    if (request.method === "POST" && url.pathname === "/device-bind-state") {
      // Internal: called by /auth/github to attach OAuth state to a device code.
      return json(await this.bindDeviceState(String(body.code || ""), String(body.state || "")));
    }

    if (request.method === "POST" && url.pathname === "/device-lookup-state") {
      // Internal: called by /auth/github/callback to find device code from OAuth state.
      return json(await this.lookupDeviceByState(String(body.state || "")));
    }

    if (request.method === "POST" && url.pathname === "/device-claim-by-state") {
      // Internal: called by /auth/github/callback after GitHub user is verified.
      return json(await this.claimDeviceByState(
        String(body.state || ""),
        Number(body.github_id || 0),
        String(body.github_login || ""),
      ));
    }

    // ─── MCP OAuth internal routes ────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/oauth-register") {
      // Unauthenticated by RFC 7591 — gate by IP so it can't be used to grow
      // the oauth_clients table unbounded on the singleton.
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`oauth-register:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL)
        || this.checkBucket("oauth-register:global", CREATE_GLOBAL_CAPACITY, CREATE_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(this.oauthRegisterClient(
        Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]).map(String) : [],
        String(body.client_name || ""),
      ));
    }
    if (request.method === "POST" && url.pathname === "/oauth-create-code") {
      return json(await this.oauthCreateCode({
        clientId: String(body.client_id || ""),
        redirectUri: String(body.redirect_uri || ""),
        codeChallenge: String(body.code_challenge || ""),
        githubState: String(body.github_state || ""),
      }));
    }
    if (request.method === "POST" && url.pathname === "/oauth-resolve-state") {
      return json(await this.oauthResolveByGithubState(
        String(body.state || ""),
        Number(body.github_id || 0),
        String(body.github_login || ""),
      ));
    }
    if (request.method === "POST" && url.pathname === "/oauth-exchange") {
      return json(await this.oauthExchangeCode({
        code: String(body.code || ""),
        clientId: String(body.client_id || ""),
        redirectUri: String(body.redirect_uri || ""),
        codeVerifier: String(body.code_verifier || ""),
      }));
    }

    if (request.method === "POST" && url.pathname === "/audit-append") {
      // Worker writes one row per shell exec / room control action. The
      // Worker has already auth'd the user; we trust user_id from the body.
      return json(this.auditAppend({
        userId: String(body.user_id || ""),
        room: String(body.room || ""),
        actor: String(body.actor || ""),
        kind: String(body.kind || ""),
        path: typeof body.path === "string" ? body.path : null,
        command: typeof body.command === "string" ? body.command : null,
        exitCode: typeof body.exit_code === "number" ? body.exit_code : null,
      }));
    }

    if (request.method === "POST" && url.pathname === "/audit-list") {
      // `room history` and "show me everything I did" both land here.
      // Filter by room OR user_id (room takes precedence if both are set).
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json({
        ok: true,
        events: this.auditList({
          userId: account.userId || "",
          room: typeof body.room === "string" && body.room ? sanitizeWiki(body.room) : null,
          limit: parseLimit(body.limit),
        }),
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  // Create a room owned by the calling user. Inserts into wikis (the room
  // exists) and user_rooms (the user owns it). Returns the mount info — no
  // tokens are minted; access is via the user's account token.
  private userById(userId: string): { handle: string } | null {
    if (!userId) return null;
    const row = this.ctx.storage.sql
      .exec<{ handle: string }>("SELECT handle FROM users WHERE user_id = ?", userId)
      .toArray()[0];
    return row || null;
  }

  private async createWiki(userId: string, handle: string, wiki: string, actor: string): Promise<Record<string, unknown>> {
    const cleanWiki = wiki.trim() ? sanitizeWiki(wiki) : this.generateWikiSlug();
    const cleanActor = sanitizeActor(actor || handle);
    const existing = this.ctx.storage.sql.exec("SELECT room FROM wikis WHERE room = ?", cleanWiki).toArray()[0];
    if (existing) return { ok: false, error: "room_exists" };

    const now = new Date().toISOString();
    const scopes: Scope[] = ["read", "write", "checkpoint", "admin"];
    this.ctx.storage.sql.exec("INSERT INTO wikis (room, created_at) VALUES (?, ?)", cleanWiki, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO user_rooms (user_id, room, actor, scopes, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      cleanWiki,
      cleanActor,
      scopes.join(","),
      "owner",
      now,
    );
    await this.env.ACCOUNTS.getByName(accountObjectName(userId)).upsertRoom({
      userId,
      handle,
      room: cleanWiki,
      actor: cleanActor,
      scopes,
      role: "owner",
      createdAt: now,
    }).catch(() => undefined);
    return { ok: true, wiki: cleanWiki, actor: cleanActor, scopes, role: "owner", user_id: userId };
  }

  private authorizeUser(wiki: string, userId: string, scope: Scope): AuthResult {
    const cleanWiki = sanitizeWiki(wiki);
    if (!this.userById(userId)) return { ok: false, error: "unknown_user" };
    const row = this.ctx.storage.sql
      .exec<{ actor: string; scopes: string }>(
        "SELECT actor, scopes FROM user_rooms WHERE user_id = ? AND room = ?",
        userId,
        cleanWiki,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "wrong_room" };

    const scopes = row.scopes.split(",") as Scope[];
    if (!hasScope(scopes, scope)) return { ok: false, error: "insufficient_scope" };
    return { ok: true, wiki: cleanWiki, actor: row.actor, scopes, tokenId: userId };
  }

  // ─── Public shares ─────────────────────────────────────────────────────
  private createShare(userId: string, room: string, prefix: string): Record<string, unknown> {
    const cleanRoom = sanitizeWiki(room);
    const cleanPrefix = prefix ? sanitizeFilePath(prefix) : "";
    // Re-sharing the same target returns the same URL instead of minting a
    // second slug — one revocation kills the only public path to it.
    const existing = this.ctx.storage.sql
      .exec<{ slug: string }>("SELECT slug FROM shares WHERE user_id = ? AND room = ? AND prefix = ?", userId, cleanRoom, cleanPrefix)
      .toArray()[0];
    if (existing) return { ok: true, slug: existing.slug, room: cleanRoom, prefix: cleanPrefix };
    const slug = randomSuffix(16);
    this.ctx.storage.sql.exec(
      "INSERT INTO shares (slug, user_id, room, prefix, created_at) VALUES (?, ?, ?, ?, ?)",
      slug,
      userId,
      cleanRoom,
      cleanPrefix,
      new Date().toISOString(),
    );
    return { ok: true, slug, room: cleanRoom, prefix: cleanPrefix };
  }

  private listShares(userId: string): Array<Record<string, unknown>> {
    return this.ctx.storage.sql
      .exec<{ slug: string; room: string; prefix: string; created_at: string }>(
        "SELECT slug, room, prefix, created_at FROM shares WHERE user_id = ? ORDER BY created_at DESC",
        userId,
      )
      .toArray();
  }

  private deleteShare(userId: string, slug: string): Record<string, unknown> {
    // Scoped to the caller's own rows — a user can only revoke their shares.
    this.ctx.storage.sql.exec("DELETE FROM shares WHERE user_id = ? AND slug = ?", userId, slug);
    return { ok: true };
  }

  private resolveShare(slug: string): Record<string, unknown> {
    if (!slug) return { ok: false, error: "not_found" };
    const row = this.ctx.storage.sql
      .exec<{ slug: string; user_id: string; room: string; prefix: string }>(
        "SELECT slug, user_id, room, prefix FROM shares WHERE slug = ?",
        slug,
      )
      .toArray()[0];
    return row ? { ok: true, ...row } : { ok: false, error: "not_found" };
  }

  // Redeem a pair code as the calling user. Inserts into user_rooms with the
  // scopes baked into the code. Marks the code used.
  private async join(userId: string, handle: string, invite: string, actor: string): Promise<Record<string, unknown>> {
    const cleanCode = normalizePairCode(invite);
    const cleanActor = sanitizeActor(actor || handle);
    const codeHash = await sha256(cleanCode);
    const row = this.ctx.storage.sql
      .exec<{ room: string; scopes: string; expires_at: string; used_at: string | null }>(
        "SELECT room, scopes, expires_at, used_at FROM wiki_pair_codes WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];

    if (!row || row.used_at) return { ok: false, error: "invalid_code" };
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false, error: "expired_code" };

    const now = new Date().toISOString();
    const scopes = row.scopes.split(",") as Scope[];
    this.ctx.storage.sql.exec("UPDATE wiki_pair_codes SET used_at = ? WHERE code_hash = ?", now, codeHash);
    // Upsert — re-joining a room you're already in just refreshes the actor.
    this.ctx.storage.sql.exec(
      `INSERT INTO user_rooms (user_id, room, actor, scopes, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, room) DO UPDATE SET actor = excluded.actor, scopes = excluded.scopes`,
      userId,
      row.room,
      cleanActor,
      row.scopes,
      "member",
      now,
    );
    await this.env.ACCOUNTS.getByName(accountObjectName(userId)).upsertRoom({
      userId,
      handle,
      room: row.room,
      actor: cleanActor,
      scopes,
      role: "member",
      createdAt: now,
    }).catch(() => undefined);
    return { ok: true, wiki: row.room, actor: cleanActor, scopes, role: "member" };
  }

  private async createPairCode(wiki: string, scopes: Scope[]): Promise<Record<string, unknown>> {
    const cleanWiki = sanitizeWiki(wiki);
    const code = randomPairCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO wiki_pair_codes (code_hash, room, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      await sha256(code),
      cleanWiki,
      scopes.join(","),
      now.toISOString(),
      expiresAt,
    );
    await this.armCleanup();

    return { ok: true, wiki: cleanWiki, code, invite: inviteUri(cleanWiki, code), expires_at: expiresAt, scopes };
  }

  // mounts(userId) = the rooms this user is a member of. Single lookup.
  // Wire shape matches v1's Mount[] so /mounts callers don't change.
  private mounts(userId: string): Array<{ wiki: string; actor: string; scopes: Scope[] }> {
    if (!userId) return [];
    return this.accountRooms(userId)
      .map((row) => ({ wiki: row.room, actor: row.actor, scopes: row.scopes }))
      .sort((left, right) => mountPath(left.wiki).localeCompare(mountPath(right.wiki)));
  }

  // Single authorization path: bearer token → user → membership → scope.
  // No fallbacks, no aggregation. If the user isn't a member, they don't
  // have access — full stop.
  private async authorize(wiki: string, token: string, scope: Scope, ip: string): Promise<AuthResult> {
    const cleanWiki = sanitizeWiki(wiki);
    const account = await this.verifyAccount(token, ip);
    if (!account.ok || !account.userId) return { ok: false, error: account.error || "invalid_token" };

    // Per-token write/op rate limits — bucket key is the user id since
    // the token already maps 1:1 to a user. Keeps the limiter behavior
    // we had on the old verifyTokenHash path.
    const opsLimited = this.checkBucket(`ops:user:${account.userId}`, OPS_TOKEN_CAPACITY, OPS_TOKEN_REFILL);
    if (opsLimited) return opsLimited;
    if (scope === "write" || scope === "checkpoint") {
      const writeLimited = this.checkBucket(`write:user:${account.userId}`, WRITE_TOKEN_CAPACITY, WRITE_TOKEN_REFILL);
      if (writeLimited) return writeLimited;
    }

    const row = this.ctx.storage.sql
      .exec<{ actor: string; scopes: string }>(
        "SELECT actor, scopes FROM user_rooms WHERE user_id = ? AND room = ?",
        account.userId,
        cleanWiki,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "wrong_room" };

    const scopes = row.scopes.split(",") as Scope[];
    if (!hasScope(scopes, scope)) return { ok: false, error: "insufficient_scope" };
    return { ok: true, wiki: cleanWiki, actor: row.actor, scopes, tokenId: account.userId };
  }

  // ─── Device flow ────────────────────────────────────────────────────────
  // Lifecycle:
  //   1. CLI calls /device-start → row inserted with code_hash, expires_at
  //   2. Browser visits /device, posts to /auth/github with the code
  //   3. /auth/github mints an oauth_state, calls /device-bind-state to attach
  //      state→code, then 302s to GitHub
  //   4. /auth/github/callback receives the GitHub code, exchanges for user,
  //      looks up the device code via /device-lookup-state, calls
  //      /device-claim to mint a bashroom token + stitch user_id
  //   5. CLI's /device-poll sees claimed_at set, returns the token, deletes the row

  private async startDeviceFlow(): Promise<Record<string, unknown>> {
    const now = new Date();
    const code = randomPairCode();
    const codeHash = await sha256(code);
    const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO device_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)`,
      codeHash,
      now.toISOString(),
      expiresAt,
    );
    await this.armCleanup();
    return {
      ok: true,
      code,
      verification_url: `/device?code=${encodeURIComponent(code)}`,
      expires_at: expiresAt,
      interval: 3,
    };
  }

  private async pollDeviceCode(code: string): Promise<Record<string, unknown>> {
    if (!code) return { ok: false, error: "missing_code" };
    const codeHash = await sha256(normalizeDeviceCode(code));
    const row = this.ctx.storage.sql
      .exec<{ expires_at: string; claimed_at: string | null; user_id: string | null; token: string | null }>(
        "SELECT expires_at, claimed_at, user_id, token FROM device_codes WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_code" };
    if (new Date(row.expires_at) < new Date()) {
      this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE code_hash = ?", codeHash);
      return { ok: false, error: "expired" };
    }
    if (!row.claimed_at || !row.token || !row.user_id) {
      return { ok: true, status: "pending" };
    }
    // Hand the token to the CLI exactly once, then burn the row.
    const token = row.token;
    const userId = row.user_id;
    this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE code_hash = ?", codeHash);
    const user = this.ctx.storage.sql
      .exec<{ handle: string }>("SELECT handle FROM users WHERE user_id = ?", userId)
      .toArray()[0];
    return { ok: true, status: "approved", token, user_id: userId, handle: user?.handle || "" };
  }

  private async bindDeviceState(code: string, state: string): Promise<Record<string, unknown>> {
    if (!code || !state) return { ok: false, error: "missing_fields" };
    const codeHash = await sha256(normalizeDeviceCode(code));
    const row = this.ctx.storage.sql
      .exec<{ expires_at: string }>("SELECT expires_at FROM device_codes WHERE code_hash = ?", codeHash)
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_code" };
    if (new Date(row.expires_at) < new Date()) return { ok: false, error: "expired" };
    this.ctx.storage.sql.exec("UPDATE device_codes SET oauth_state = ? WHERE code_hash = ?", state, codeHash);
    return { ok: true };
  }

  private async lookupDeviceByState(state: string): Promise<Record<string, unknown>> {
    if (!state) return { ok: false, error: "missing_state" };
    const row = this.ctx.storage.sql
      .exec<{ code_hash: string; expires_at: string }>(
        "SELECT code_hash, expires_at FROM device_codes WHERE oauth_state = ?",
        state,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_state" };
    if (new Date(row.expires_at) < new Date()) return { ok: false, error: "expired" };
    return { ok: true, code_hash: row.code_hash };
  }

  private async claimDeviceByState(state: string, githubId: number, githubLogin: string): Promise<Record<string, unknown>> {
    if (!state || !githubId || !githubLogin) return { ok: false, error: "missing_fields" };
    const row = this.ctx.storage.sql
      .exec<{ code_hash: string; expires_at: string; claimed_at: string | null }>(
        "SELECT code_hash, expires_at, claimed_at FROM device_codes WHERE oauth_state = ?",
        state,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_state" };
    if (new Date(row.expires_at) < new Date()) return { ok: false, error: "expired" };
    if (row.claimed_at) return { ok: false, error: "already_claimed" };
    const codeHash = row.code_hash;

    // Stitch GitHub identity to existing or new account.
    const userId = await this.upsertGithubUser(githubId, githubLogin);

    // Mint a fresh token for this device.
    const { token } = await this.mintUserToken(userId, githubLogin);
    this.ctx.storage.sql.exec(
      "UPDATE device_codes SET claimed_at = ?, user_id = ?, token = ? WHERE code_hash = ?",
      new Date().toISOString(),
      userId,
      token,
      codeHash,
    );
    return { ok: true, user_id: userId, github_login: githubLogin };
  }

  // Mint + persist a fresh br_user_ token for a resolved account, and sync it
  // into the AccountDO so per-request auth resolves. Shared by the device-code
  // flow and the MCP OAuth flow — both end in "I have a userId, give me a
  // working token." Returns the plaintext token (caller hands it onward once).
  private async mintUserToken(userId: string, handle: string): Promise<{ token: string }> {
    const now = new Date().toISOString();
    const token = randomAccountToken(userId);
    const tokenHash = await sha256(token);
    const tokenId = randomId("utok");
    this.ctx.storage.sql.exec(
      "INSERT INTO user_tokens (token_hash, token_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      tokenId,
      userId,
      now,
    );
    await this.env.ACCOUNTS.getByName(accountObjectName(userId)).syncAccount({
      userId,
      handle,
      tokenHash,
      tokenId,
      createdAt: now,
      rooms: this.accountRooms(userId),
    }).catch(() => undefined);
    return { token };
  }

  // ─── MCP OAuth DO methods ───────────────────────────────────────────────

  // RFC 7591 dynamic client registration. Store the client's redirect_uris so
  // /authorize and /token can validate them. Returns a fresh client_id.
  private oauthRegisterClient(redirectUris: string[], clientName: string): Record<string, unknown> {
    if (!redirectUris.length) return { ok: false, error: "missing_redirect_uris" };
    const clientId = randomId("oauthcli");
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)",
      clientId,
      JSON.stringify(redirectUris),
      clientName || "",
      new Date().toISOString(),
    );
    return { ok: true, client_id: clientId, redirect_uris: redirectUris };
  }

  // Validate that a client exists and the given redirect_uri is registered to
  // it (exact match — OAuth 2.1 forbids partial/wildcard matching).
  private oauthValidateClient(clientId: string, redirectUri: string): Record<string, unknown> {
    const row = this.ctx.storage.sql
      .exec<{ redirect_uris: string }>("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?", clientId)
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_client" };
    let uris: string[] = [];
    try { uris = JSON.parse(row.redirect_uris); } catch { /* corrupt row */ }
    if (!uris.includes(redirectUri)) return { ok: false, error: "redirect_uri_mismatch" };
    return { ok: true };
  }

  // Create a pending authorization code bound to the client + redirect_uri +
  // PKCE challenge + the GitHub state we'll use to round-trip identity. The
  // plaintext `code` is what we ultimately return to the client via redirect.
  private async oauthCreateCode(input: {
    clientId: string; redirectUri: string; codeChallenge: string; githubState: string;
  }): Promise<Record<string, unknown>> {
    const valid = this.oauthValidateClient(input.clientId, input.redirectUri);
    if (!valid.ok) return valid;
    if (!input.codeChallenge) return { ok: false, error: "missing_code_challenge" };
    const code = `oac_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const codeHash = await sha256(code);
    const now = new Date();
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, github_state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      codeHash,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.githubState,
      now.toISOString(),
      new Date(now.getTime() + 10 * 60_000).toISOString(), // 10 min to complete GitHub + redirect
    );
    await this.armCleanup();
    return { ok: true, code };
  }

  // After GitHub auth resolves, attach the identity (mint a token) to the
  // pending code keyed by the github_state we set in oauthCreateCode.
  private async oauthResolveByGithubState(state: string, githubId: number, githubLogin: string): Promise<Record<string, unknown>> {
    if (!state || !githubId || !githubLogin) return { ok: false, error: "missing_fields" };
    const row = this.ctx.storage.sql
      .exec<{ code_hash: string; expires_at: string; user_id: string | null }>(
        "SELECT code_hash, expires_at, user_id FROM oauth_codes WHERE github_state = ?",
        state,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "unknown_state" };
    if (new Date(row.expires_at) < new Date()) return { ok: false, error: "expired" };
    if (row.user_id) return { ok: false, error: "already_resolved" };

    const userId = await this.upsertGithubUser(githubId, githubLogin);
    const { token } = await this.mintUserToken(userId, githubLogin);
    this.ctx.storage.sql.exec(
      "UPDATE oauth_codes SET user_id = ?, token = ? WHERE code_hash = ?",
      userId,
      token,
      row.code_hash,
    );
    // The callback carries redirect_uri + plaintext code through GitHub state,
    // so it doesn't need them back from here — just confirm identity resolved.
    return { ok: true, user_id: userId, github_login: githubLogin };
  }

  // /token: exchange the authorization code (+ PKCE verifier) for the access
  // token. Verifies the S256 challenge, the client_id, and burns the code.
  private async oauthExchangeCode(input: {
    code: string; clientId: string; redirectUri: string; codeVerifier: string;
  }): Promise<Record<string, unknown>> {
    if (!input.code || !input.codeVerifier) return { ok: false, error: "invalid_request" };
    const codeHash = await sha256(input.code);
    const row = this.ctx.storage.sql
      .exec<{ client_id: string; redirect_uri: string; code_challenge: string; expires_at: string; user_id: string | null; token: string | null; claimed_at: string | null }>(
        "SELECT client_id, redirect_uri, code_challenge, expires_at, user_id, token, claimed_at FROM oauth_codes WHERE code_hash = ?",
        codeHash,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "invalid_grant" };
    if (row.claimed_at) { // replayed code → revoke defensively
      this.ctx.storage.sql.exec("DELETE FROM oauth_codes WHERE code_hash = ?", codeHash);
      return { ok: false, error: "invalid_grant" };
    }
    if (new Date(row.expires_at) < new Date()) return { ok: false, error: "invalid_grant" };
    if (row.client_id !== input.clientId) return { ok: false, error: "invalid_client" };
    if (input.redirectUri && row.redirect_uri !== input.redirectUri) return { ok: false, error: "invalid_grant" };
    if (!row.user_id || !row.token) return { ok: false, error: "authorization_pending" };

    // PKCE S256: base64url(sha256(code_verifier)) must equal stored challenge.
    const computed = await sha256(input.codeVerifier);
    if (computed !== row.code_challenge) return { ok: false, error: "invalid_grant" };

    // Burn the one-time code; the token lives on in user_tokens.
    const token = row.token;
    this.ctx.storage.sql.exec("DELETE FROM oauth_codes WHERE code_hash = ?", codeHash);
    return { ok: true, token };
  }

  // Find-or-create a bashroom account for this GitHub user. Stitches to an
  // existing pre-OAuth row if handle matches and github_id is unset (one-time
  // migration for legacy accounts).
  private async upsertGithubUser(githubId: number, githubLogin: string): Promise<string> {
    const cleanLogin = sanitizeHandle(githubLogin);
    // 1. Already linked? Reuse.
    const linked = this.ctx.storage.sql
      .exec<{ user_id: string }>("SELECT user_id FROM users WHERE github_id = ?", githubId)
      .toArray()[0];
    if (linked) {
      // Refresh handle in case the GitHub login changed.
      this.ctx.storage.sql.exec("UPDATE users SET handle = ?, github_login = ? WHERE user_id = ?", cleanLogin, cleanLogin, linked.user_id);
      return linked.user_id;
    }
    // 2. Legacy row claimable? Stitch.
    const legacy = this.ctx.storage.sql
      .exec<{ user_id: string }>(
        "SELECT user_id FROM users WHERE handle = ? AND github_id IS NULL LIMIT 1",
        cleanLogin,
      )
      .toArray()[0];
    if (legacy) {
      this.ctx.storage.sql.exec(
        "UPDATE users SET github_id = ?, github_login = ? WHERE user_id = ?",
        githubId,
        cleanLogin,
        legacy.user_id,
      );
      return legacy.user_id;
    }
    // 3. Fresh user.
    const userId = randomId("usr");
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO users (user_id, handle, created_at, github_id, github_login) VALUES (?, ?, ?, ?, ?)",
      userId,
      cleanLogin,
      now,
      githubId,
      cleanLogin,
    );
    return userId;
  }

  private async verifyAccount(token: string, ip: string): Promise<AccountAuth> {
    if (!token) return { ok: false, error: "missing_token" };
    return this.verifyAccountTokenHash(await sha256(token), ip);
  }

  private verifyAccountTokenHash(tokenHash: string, ip: string): AccountAuth {
    const ipLimited = this.checkBucket(`verify:ip:${ip}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
    if (ipLimited) return ipLimited;

    const globalLimited = this.checkBucket("ops:global", GLOBAL_OPS_CAPACITY, GLOBAL_OPS_REFILL);
    if (globalLimited) return globalLimited;

    const tokenLimited = this.checkBucket(`ops:user_token:${tokenHash}`, OPS_TOKEN_CAPACITY, OPS_TOKEN_REFILL);
    if (tokenLimited) return tokenLimited;

    const row = this.ctx.storage.sql
      .exec<{ user_id: string; handle: string; last_seen_at: string | null; revoked_at: string | null }>(
        `SELECT t.user_id, u.handle, t.last_seen_at, t.revoked_at
         FROM user_tokens t
         JOIN users u ON u.user_id = t.user_id
         WHERE t.token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];

    if (!row || row.revoked_at) return { ok: false, error: "invalid_token" };

    const now = Date.now();
    if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec("UPDATE user_tokens SET last_seen_at = ? WHERE token_hash = ?", new Date(now).toISOString(), tokenHash);
    }

    return { ok: true, userId: row.user_id, handle: row.handle };
  }

  private accountRooms(userId: string): Array<{ room: string; actor: string; scopes: Scope[]; role: string; created_at: string }> {
    return this.ctx.storage.sql
      .exec<{ room: string; actor: string; scopes: string; role: string; created_at: string }>(
        `SELECT room, actor, scopes, role, created_at
         FROM user_rooms
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        userId,
      )
      .toArray()
      .map((row) => ({
        room: row.room,
        actor: row.actor,
        scopes: row.scopes.split(",") as Scope[],
        role: row.role,
        created_at: row.created_at,
      }));
  }

  private auditAppend(row: { userId: string; room: string; actor: string; kind: string; path: string | null; command: string | null; exitCode: number | null }): Record<string, unknown> {
    // user_id and kind required. room is empty string for shell execs that
    // don't target a specific room — sanitizeWiki would reject "" so we
    // store it raw and let queries filter on `room != ''` if they want
    // per-room view.
    if (!row.userId || !row.kind) return { ok: false, error: "missing_field" };
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (ts, user_id, room, actor, kind, path, command, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      new Date().toISOString(),
      row.userId,
      row.room ? sanitizeWiki(row.room) : "",
      sanitizeActor(row.actor),
      row.kind,
      row.path ? compact(row.path) : null,
      row.command ? compact(row.command) : null,
      row.exitCode,
    );
    return { ok: true };
  }

  private auditList(opts: { userId: string; room: string | null; limit: number }): Array<Record<string, unknown>> {
    // Room filter takes precedence — `room history <room>` semantics.
    // Without a room filter, return the user's cross-room history.
    const rows = opts.room
      ? this.ctx.storage.sql.exec<{ id: number; ts: string; user_id: string; room: string; actor: string; kind: string; path: string | null; command: string | null; exit_code: number | null }>(
          `SELECT id, ts, user_id, room, actor, kind, path, command, exit_code
           FROM audit WHERE room = ? ORDER BY id DESC LIMIT ?`,
          opts.room, opts.limit,
        ).toArray()
      : this.ctx.storage.sql.exec<{ id: number; ts: string; user_id: string; room: string; actor: string; kind: string; path: string | null; command: string | null; exit_code: number | null }>(
          `SELECT id, ts, user_id, room, actor, kind, path, command, exit_code
           FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
          opts.userId, opts.limit,
        ).toArray();
    // Reverse so caller sees chronological order, matching the old Room.audit shape.
    return rows.reverse();
  }

  private actors(wiki: string): string[] {
    const cleanWiki = sanitizeWiki(wiki);
    const rows = this.ctx.storage.sql
      .exec<{ actor: string }>(
        `SELECT actor
         FROM user_rooms
         WHERE room = ?
         GROUP BY actor
         ORDER BY MIN(created_at) ASC`,
        cleanWiki,
      )
      .toArray();
    return rows.map((row) => row.actor);
  }

  private async deleteWiki(wiki: string): Promise<Record<string, unknown>> {
    const cleanWiki = sanitizeWiki(wiki);
    const now = new Date().toISOString();
    const members = this.ctx.storage.sql
      .exec<{ user_id: string }>("SELECT user_id FROM user_rooms WHERE room = ?", cleanWiki)
      .toArray();
    this.ctx.storage.sql.exec("DELETE FROM wikis WHERE room = ?", cleanWiki);
    this.ctx.storage.sql.exec("DELETE FROM user_rooms WHERE room = ?", cleanWiki);
    this.ctx.storage.sql.exec("UPDATE wiki_pair_codes SET used_at = ? WHERE room = ? AND used_at IS NULL", now, cleanWiki);
    for (const member of members) {
      await this.env.ACCOUNTS.getByName(accountObjectName(member.user_id)).deleteRoom(cleanWiki).catch(() => undefined);
    }
    return { ok: true, wiki: cleanWiki };
  }

  private checkBucket(key: string, maxCredits: number, creditsPerMs: number, cost = 1): AuthResult | null {
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<{ credits: number; updated_at: number }>("SELECT credits, updated_at FROM credit_buckets WHERE key = ?", key)
      .toArray()[0];

    if (!existing) {
      this.ctx.storage.sql.exec("INSERT INTO credit_buckets (key, credits, updated_at) VALUES (?, ?, ?)", key, maxCredits - cost, now);
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

    this.ctx.storage.sql.exec("UPDATE credit_buckets SET credits = ?, updated_at = ? WHERE key = ?", credits - cost, now, key);
    return null;
  }

  private generateWikiSlug(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = `${choice(SLUG_VERBS)}-${choice(SLUG_VERBS)}-${choice(SLUG_VERBS)}`;
      const existing = this.ctx.storage.sql.exec("SELECT room FROM wikis WHERE room = ?", slug).toArray()[0];
      if (!existing) return slug;
    }
    return `room-${randomSuffix(12)}`;
  }
}

function createServer(env: Env, headerToken: string, ip: string): McpServer {
  const server = new McpServer({ name: "bashroom", version: "0.2.0" });

  server.tool(
    "bashroom",
    "Run bash against /rooms, a durable filesystem for agents FUSE-mounted from Cloudflare R2. Real Linux shell with bash, git, ripgrep, jq, find, less, tree, fd, rsync — there is no hidden command parser, so anything that works in bash works here.\n\nWhat persists: only files under /rooms/. The shell itself resets between calls — /tmp, env vars, cwd, and background processes are gone next call, and outbound network is blocked. Room admin (create, join, pair, mounts, who, history) is the visible `bashroom` executable inside the shell.\n\nExamples:\n- ls /rooms                                  — see which rooms you can reach\n- cat /rooms/my-app/index.md                 — read a room's index\n- bashroom create my-app                     — make a new room\n- rg -n 'TODO' /rooms/my-app                 — regex search with ripgrep\n- mkdir -p /rooms/my-app/notes               — create dirs before bashroom_write\n\nWhen NOT to use this: if you only need to list, read, search, or stat room files, prefer bashroom_tree / bashroom_read / bashroom_search / bashroom_stat — they read R2 directly without booting the sandbox, return bounded output, and are faster and cheaper.",
    {
      command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("Bash command to run, for example: ls /rooms; cat /rooms/my-room/index.md"),
      stdin: z.string().optional().describe("Optional standard input for the command. Piped to the command via base64 round-trip so any byte sequence (quotes, newlines, NUL) is safe."),
    },
    async ({ command, stdin }) => {
      const result = await runShell(env, headerToken, ip, command, stdin || "");
      return {
        content: [{ type: "text", text: formatShellResult(result) }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.tool(
    "bashroom_write",
    "Write one file under /rooms directly, bypassing bash quoting entirely. The content lands byte-for-byte — no shell interpolation, no heredoc edge cases. Use this instead of `echo ... > file` or a heredoc whenever content contains quotes, backticks, $variables, markdown code fences, or arbitrary bytes; in practice that means: always prefer this for writing file content.\n\nExample: bashroom_write({ path: '/rooms/my-app/notes/2026-06-09.md', content: '# Handoff\\n\\n## state\\n...' }). For binary, base64-encode the bytes and pass encoding='base64'.\n\nLimits to know up front: max 5MB per write; the path must be inside /rooms/<room>/ (anything else is rejected — writes outside /rooms don't persist anyway); the parent directory must already exist — create it first with the bashroom tool (`mkdir -p /rooms/my-app/notes`). Writes replace the whole file; to append or patch, read first, then write the merged result.",
    {
      path: z.string().min(1).max(1024).describe("Absolute path under /rooms, e.g. /rooms/my-room/notes/today.md"),
      content: z.string().max(MAX_WRITE_BYTES).describe("File content. UTF-8 by default; pass base64-encoded bytes with encoding='base64' for binary."),
      encoding: z.enum(["utf-8", "base64"]).optional().describe("'utf-8' (default) treats content as text; 'base64' decodes content as binary before writing."),
    },
    async ({ path, content, encoding }) => {
      const result = await runWriteFile(env, headerToken, ip, path, content, encoding ?? "utf-8");
      return {
        content: [{ type: "text", text: formatWriteResult(result) }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    "bashroom_tree",
    "List rooms or files directly from R2 without starting bash — the fastest way to orient yourself. Returns metadata (path, size, updated_at, etag, content type), never file bodies.\n\nTwo modes:\n- bashroom_tree({ path: '/rooms' })                — list every room you can reach, with your role and scopes\n- bashroom_tree({ path: '/rooms/my-app/notes' })   — list files under a prefix, recursively\n\nA good first call in any session is path='/rooms': it tells you what exists before you read anything. Output is bounded by max_entries (up to 1000) and sets truncated=true when there's more — narrow the prefix rather than raising the cap. For glob patterns or sorting tricks, fall back to the bashroom tool with `fd` or `find`.",
    {
      path: z.string().default("/rooms").describe("Absolute path: /rooms to list rooms, or /rooms/<room>/<optional-prefix> to list files."),
      max_entries: z.number().int().min(1).max(MAX_MCP_TREE_ENTRIES).optional().describe(`Maximum files to return, up to ${MAX_MCP_TREE_ENTRIES}.`),
    },
    async ({ path, max_entries }) => {
      const result = await mcpTree(env, headerToken, ip, path || "/rooms", max_entries);
      return mcpJsonResult(result, result.ok === false);
    },
  );

  server.tool(
    "bashroom_read",
    "Read a bounded byte range of one file directly from R2 without starting bash. Use this instead of `cat`: the max_bytes cap (up to 512KB) means a file can never be bigger than you guessed and flood your context window.\n\nExamples:\n- bashroom_read({ path: '/rooms/my-app/index.md' })                          — read from the top\n- bashroom_read({ path: '/rooms/my-app/log/big.md', offset: 64000 })        — page through a large file\n\nThe result includes the file's true size_bytes and truncated=true when there is more past your range — page with offset rather than re-reading from 0. Binary files are flagged is_binary instead of dumped raw. If you don't know the file's size yet, bashroom_stat is a cheaper first call than a read.",
    {
      path: z.string().min(1).describe("Absolute file path under /rooms/<room>/, e.g. /rooms/bashroom/ARCHITECTURAL.md."),
      offset: z.number().int().min(0).optional().describe("Byte offset to start reading from. Defaults to 0."),
      max_bytes: z.number().int().min(1).max(MAX_MCP_READ_BYTES).optional().describe(`Maximum bytes to return, up to ${MAX_MCP_READ_BYTES}.`),
    },
    async ({ path, offset, max_bytes }) => {
      const result = await mcpRead(env, headerToken, ip, path, offset, max_bytes);
      return mcpJsonResult(result, result.ok === false);
    },
  );

  server.tool(
    "bashroom_search",
    "Search room files for a literal string directly from R2, without starting bash. Case-insensitive by default; returns file + line + matched text for each hit, so it's the quick 'where did we write about X' tool.\n\nExample: bashroom_search({ path: '/rooms/my-app', query: 'handoff' }) — find every mention under a room or narrower prefix.\n\nThis is literal substring match only — no regex, no globs. For regex, multiline patterns, or anything `rg` can do, use the bashroom tool (`rg -n 'pattern' /rooms/my-app`). Output is bounded by max_matches / max_files / max_bytes_per_file and reports scanned_files, skipped_files, and truncated, so you can tell the difference between 'no matches' and 'didn't look everywhere' — narrow the path prefix when truncated.",
    {
      path: z.string().min(1).describe("Absolute room or prefix path under /rooms/<room>/, e.g. /rooms/bashroom/notes."),
      query: z.string().min(1).max(256).describe("Literal text to search for."),
      case_sensitive: z.boolean().optional().describe("Defaults to false."),
      max_matches: z.number().int().min(1).max(MAX_MCP_SEARCH_MATCHES).optional().describe(`Maximum matches to return, up to ${MAX_MCP_SEARCH_MATCHES}.`),
      max_files: z.number().int().min(1).max(MAX_MCP_SEARCH_FILES).optional().describe(`Maximum files to scan, up to ${MAX_MCP_SEARCH_FILES}.`),
      max_bytes_per_file: z.number().int().min(1).max(MAX_MCP_SEARCH_FILE_BYTES).optional().describe(`Maximum bytes to scan per file, up to ${MAX_MCP_SEARCH_FILE_BYTES}.`),
    },
    async ({ path, query, case_sensitive, max_matches, max_files, max_bytes_per_file }) => {
      const result = await mcpSearch(env, headerToken, ip, {
        path,
        query,
        caseSensitive: Boolean(case_sensitive),
        maxMatches: max_matches,
        maxFiles: max_files,
        maxBytesPerFile: max_bytes_per_file,
      });
      return mcpJsonResult(result, result.ok === false);
    },
  );

  server.tool(
    "bashroom_stat",
    "Return R2 metadata for one file without reading its body: size, modified time, etag, version, content type, and custom metadata. The cheapest call in the harness — no sandbox, no file body.\n\nUse it to answer 'has this changed since I last looked?' (compare etag or updated_at) before re-reading, or 'how big is this?' before choosing bashroom_read offsets. Example: bashroom_stat({ path: '/rooms/my-app/index.md' }).",
    {
      path: z.string().min(1).describe("Absolute file path under /rooms/<room>/, e.g. /rooms/bashroom/index.md."),
    },
    async ({ path }) => {
      const result = await mcpStat(env, headerToken, ip, path);
      return mcpJsonResult(result, result.ok === false);
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      // sanitize* helpers throw plain Errors for malformed user input.
      // Map those to 400 so a stale browser state can't cause a 1101.
      if (VALIDATION_ERRORS.has(message)) return json({ ok: false, error: message }, 400);
      console.error("worker exception:", error);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
};

const VALIDATION_ERRORS = new Set(["invalid room", "invalid file path"]);

// Post-response work (audit logging, session teardown, mirror heals, cache
// fills) should not add latency to the response. We hold the active request's
// ExecutionContext so deep call sites can hand such work to the runtime via
// waitUntil without threading ctx through every signature. Set once at the
// top of each handleRequest; one request per fetch invocation, so there's no
// cross-request bleed. defer() falls back to running inline if no ctx is set
// (e.g. a unit-test path) — correctness never depends on the holder.
let activeCtx: ExecutionContext | null = null;
function defer(work: Promise<unknown>): void {
  const p = Promise.resolve(work).catch(() => undefined);
  if (activeCtx) activeCtx.waitUntil(p);
  // else: fire-and-forget; the promise still runs, just untracked.
}

// Fire-and-forget presence poke. Hub name is the storage identity
// (userId:room — the same pair that keys R2 prefixes). Deferred + swallowed:
// presence must never add latency to or fail a write.
function pokeRoomHub(env: Env, userId: string, room: string, actor: string, path: string, source: "web" | "mcp" | "shell", etag?: string): void {
  try {
    const stub = env.ROOM_HUBS.get(env.ROOM_HUBS.idFromName(`${userId}:${room}`));
    defer(stub.hubPoke({ actor, path, etag, source }));
  } catch (_) { /* presence is best-effort by contract */ }
}

// Rooms a shell command plausibly touched — /rooms/<room> mentions in the
// command text. Heuristic by design (a cd + relative path escapes it);
// per-file precision arrives with R2 event notifications later.
function roomsMentioned(command: string): string[] {
  const rooms = new Set<string>();
  for (const match of command.matchAll(/\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]*)/g)) rooms.add(match[1]);
  return [...rooms];
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  activeCtx = ctx;
  const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const token = bearerToken(request);
      // MCP OAuth discovery trigger: an unauthenticated request gets a 401
      // with a WWW-Authenticate header pointing at our protected-resource
      // metadata (RFC 9728). Clients like claude.ai read this to start the
      // OAuth dance. A request carrying a token (static br_user_ or one minted
      // via our OAuth flow) skips this and goes straight to the handler — so
      // the CLI / Claude Code / curl all keep working unchanged.
      if (!token) {
        const base = publicBaseUrl(env, request);
        return json({ ok: false, error: "unauthorized" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
      }
      // Stateless transport: no sessionIdGenerator means no Mcp-Session-Id is
      // ever minted, so there is no per-session state to persist and no
      // Registry round-trip per call. Sessions bought us nothing (every tool
      // authorizes per-request off the bearer token), and the spec is
      // converging on sessionless servers anyway. enableJsonResponse skips
      // SSE framing too — no tool here streams or emits notifications, so a
      // plain application/json body is the whole conversation.
      return createMcpHandler(createServer(env, token, clientIp(request)), {
        enableJsonResponse: true,
      })(request, env, ctx);
    }

    if (url.pathname === "/bash" && request.method === "POST") {
      const input = await readJson(request);
      const result = await runShell(env, bearerToken(request), clientIp(request), String(input.command || ""), String(input.stdin || ""));
      return json(result, result.exitCode === 0 ? 200 : 400);
    }

    if (url.pathname === "/account/rooms" && request.method === "POST") {
      const account = await authorizeAccount(env, bearerToken(request), clientIp(request), { route: "account.rooms", includeRooms: true });
      return json(account, account.ok === false ? 401 : 200);
    }

    if (url.pathname === "/account/room-create" && request.method === "POST") {
      const input = await readJson(request);
      const result = await registry(env, "/account-room-create", {
        token: bearerToken(request),
        room: input.room || input.wiki || "",
        actor: input.actor || defaultActor("cli"),
        ip: clientIp(request),
      });
      if (result.ok && typeof result.wiki === "string" && typeof result.actor === "string" && typeof result.user_id === "string") {
        await seedR2Room(env, result.user_id, result.wiki, result.actor);
      }
      return json(result, result.ok === false ? 400 : 200);
    }

    // Redeem an invite as the calling user — wraps Registry /join.
    if (url.pathname === "/account/room-join" && request.method === "POST") {
      const input = await readJson(request);
      const result = await registry(env, "/join", {
        token: bearerToken(request),
        invite: String(input.invite || ""),
        actor: String(input.actor || defaultActor("cli")),
        ip: clientIp(request),
      });
      return json(result, result.ok === false ? 400 : 200);
    }

    // Mint a pair-code invite for a room — wraps Registry /pair.
    if (url.pathname === "/account/room-pair" && request.method === "POST") {
      const input = await readJson(request);
      const result = await registry(env, "/pair", {
        token: bearerToken(request),
        wiki: String(input.wiki || input.room || ""),
        ip: clientIp(request),
      });
      return json(result, result.ok === false ? 400 : 200);
    }

    // Destroy a room: drop Registry membership/rows, then purge R2 prefix.
    // Order matters — Registry /delete authorizes; only on success do we
    // touch R2. AccountDO gives us the user id without hitting Registry for
    // the preflight when the token is routeable.
    if (url.pathname === "/account/room-delete" && request.method === "POST") {
      const input = await readJson(request);
      const wiki = String(input.wiki || input.room || "");
      const token = bearerToken(request);
      const ip = clientIp(request);
      const account = await authorizeAccount(env, token, ip, { route: "account.room-delete", includeRooms: true });
      if (account.ok === false) return json(account, 401);
      const userId = String(account.user_id || "");
      if (!userId) return json({ ok: false, error: "no_account" }, 400);
      const result = await registry(env, "/delete", { token, wiki, ip });
      if (result.ok && typeof result.wiki === "string") {
        await r2DeletePrefix(env, userId, result.wiki);
      }
      return json(result, result.ok === false ? 400 : 200);
    }

    // List the calling user's room mounts from the per-user account mirror.
    if (url.pathname === "/account/room-mounts" && request.method === "POST") {
      const account = await authorizeAccount(env, bearerToken(request), clientIp(request), { route: "account.room-mounts", includeRooms: true });
      if (account.ok === false) return json(account, 401);
      const mounts = (account.rooms || [])
        .map((row) => ({ wiki: row.room, actor: row.actor, scopes: row.scopes }))
        .sort((left, right) => mountPath(left.wiki).localeCompare(mountPath(right.wiki)));
      return json({ ok: true, mounts });
    }

    // List the actors present in a room — wraps Registry /actors.
    if (url.pathname === "/account/room-who" && request.method === "POST") {
      const input = await readJson(request);
      const result = await registry(env, "/actors", {
        token: bearerToken(request),
        wiki: String(input.wiki || input.room || ""),
        ip: clientIp(request),
      });
      return json(result, result.ok === false ? 400 : 200);
    }

    // Per-room audit history — wraps Registry /audit-list.
    if (url.pathname === "/account/room-history" && request.method === "POST") {
      const input = await readJson(request);
      const result = await registry(env, "/audit-list", {
        token: bearerToken(request),
        room: String(input.room || input.wiki || ""),
        limit: input.limit,
        ip: clientIp(request),
      });
      return json(result, result.ok === false ? 400 : 200);
    }

    // Force the calling user's sandbox to shut down so the next request
    // boots fresh on the latest image. Useful after a Dockerfile change.
    // Auth: account token (same as /bash).
    if (url.pathname === "/sandbox/restart" && request.method === "POST") {
      const account = await authorizeAccount(env, bearerToken(request), clientIp(request), { route: "sandbox.restart" });
      if (account.ok === false) return json({ ok: false, error: account.error || "unauthorized" }, 401);
      const userId = String(account.user_id || "");
      if (!userId) return json({ ok: false, error: "no_account" }, 400);
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(env.SANDBOXES, userId, { normalizeId: true });
      await sandbox.destroy().catch(() => undefined);
      return json({ ok: true, user_id: userId, message: "sandbox destroyed; next request boots fresh" });
    }

    if (url.pathname === "/web" || url.pathname === "/web/") return html(webIndexHtml());

    // Presence WebSocket for the web reader. Auth happens HERE (token rides
    // the Sec-WebSocket-Protocol header as "tok.<token>" because browser
    // WebSockets can't set Authorization); the hub only ever sees the
    // already-authorized upgrade. One hub per (userId, room).
    if (url.pathname === "/web/api/presence") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ ok: false, error: "expected_websocket" }, 426);
      }
      // Share-link viewers connect by capability slug — no account, read-only,
      // scoped to the shared prefix. share-resolve is IP-rate-limited.
      const slug = url.searchParams.get("slug") || "";
      if (slug) {
        const share = await registry(env, "/share-resolve", { slug, ip: clientIp(request) });
        if (share.ok === false) return json({ ok: false, error: share.error || "not_found" }, 403);
        const shareUser = String(share.user_id || "");
        const shareRoom = String(share.room || "");
        if (!shareUser || !shareRoom) return json({ ok: false, error: "not_found" }, 403);
        const stub = env.ROOM_HUBS.get(env.ROOM_HUBS.idFromName(`${shareUser}:${shareRoom}`));
        const hubUrl = new URL("https://hub.local/connect");
        hubUrl.searchParams.set("viewer", "reader");
        hubUrl.searchParams.set("prefix", String(share.prefix || ""));
        hubUrl.searchParams.set("readonly", "1");
        return stub.fetch(new Request(hubUrl, request));
      }
      const room = parseOptionalWiki(url.searchParams.get("room"));
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      const protoHeader = request.headers.get("Sec-WebSocket-Protocol") || "";
      const token = protoHeader.split(",").map((p) => p.trim()).find((p) => p.startsWith("tok."))?.slice(4) || "";
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.presence", includeRooms: true });
      if (account.ok === false) return json({ ok: false, error: account.error || "unauthorized" }, 401);
      const userId = String(account.user_id || "");
      const membership = (account.rooms || []).find((row) => row.room === room);
      if (!userId || !membership) return json({ ok: false, error: "forbidden" }, 403);
      const stub = env.ROOM_HUBS.get(env.ROOM_HUBS.idFromName(`${userId}:${room}`));
      const hubUrl = new URL("https://hub.local/connect");
      hubUrl.searchParams.set("viewer", String(account.handle || "you"));
      return stub.fetch(new Request(hubUrl, request));
    }

    if (url.pathname === "/web/api/rooms" && request.method === "GET") {
      // Pass ?active=ROOM to also fetch that room's metadata tree in the same
      // response — saves a round-trip on initial page load without reading
      // every file body.
      const account = await authorizeAccount(env, bearerToken(request), clientIp(request), { route: "web.rooms", includeRooms: true });
      const userId = String(account.user_id || "");
      const requested = parseOptionalWiki(url.searchParams.get("active"));
      const memberRooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      const activeRoom = requested && memberRooms.some((row) => row.room === requested) ? requested : "";
      const tree = activeRoom && userId ? await r2Tree(env, userId, activeRoom) : null;
      return json({ ...account, active: activeRoom || null, tree });
    }

    if (url.pathname === "/web/api/tree" && request.method === "GET") {
      const token = bearerToken(request);
      const room = parseOptionalWiki(url.searchParams.get("room"));
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.tree", includeRooms: true });
      const userId = String(account.user_id || "");
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!userId || !rooms.some((row) => row.room === room)) return json({ ok: false, error: "forbidden" }, 403);
      return json({ ok: true, files: await r2Tree(env, userId, room) });
    }

    // Cross-room content search for the web reader. One account authorization,
    // then a bounded literal scan (the same primitives as the MCP
    // bashroom_search tool) fanned out across every room the user belongs to.
    // Budgets keep it interactive: 40 matches total, 200 files/room, 256KB/file.
    if (url.pathname === "/web/api/search" && request.method === "GET") {
      const token = bearerToken(request);
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json({ ok: false, error: "query_too_short" }, 400);
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.search", includeRooms: true });
      const userId = String(account.user_id || "");
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
      const budget = { matches: 40 };
      const perRoom = await Promise.all(rooms.map((row) => webSearchRoom(env, userId, row.room, q, budget)));
      const results = perRoom.flat();
      return json({ ok: true, query: q, results, truncated: budget.matches <= 0 });
    }

    if (url.pathname === "/web/api/file" && request.method === "GET") {
      const token = bearerToken(request);
      const room = parseOptionalWiki(url.searchParams.get("room"));
      const path = url.searchParams.get("path") || "";
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      if (!path) return json({ ok: false, error: "path_required" }, 400);
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.file", includeRooms: true });
      const userId = String(account.user_id || "");
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!userId || !rooms.some((row) => row.room === room)) return json({ ok: false, error: "forbidden" }, 403);
      const file = await r2File(env, userId, room, path);
      if (!file) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, file });
    }

    // Raw byte download of one file — used by `bashroom export` so binary
    // files survive intact (the JSON /file endpoint blanks binary bodies).
    // Same membership gate as the JSON read; streams R2 straight through.
    if (url.pathname === "/web/api/raw" && request.method === "GET") {
      const token = bearerToken(request);
      const room = parseOptionalWiki(url.searchParams.get("room"));
      const path = url.searchParams.get("path") || "";
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      if (!path) return json({ ok: false, error: "path_required" }, 400);
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.raw", includeRooms: true });
      const userId = String(account.user_id || "");
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!userId || !rooms.some((row) => row.room === room)) return json({ ok: false, error: "forbidden" }, 403);
      const object = await env.ROOMS_R2.get(r2KeyForFile(userId, room, path));
      if (!object) return json({ ok: false, error: "not_found" }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // Save a file body from the web editor. Same membership gate as the GET
    // plus a "write" scope check, so read-only members can view but not save.
    // Writes go straight to R2 (no sandbox boot) — the FUSE mount reads the
    // same objects, so the next shell call sees the edit.
    if (url.pathname === "/web/api/file" && request.method === "PUT") {
      const token = bearerToken(request);
      const input = await readJson(request);
      const room = parseOptionalWiki(String(input.room || ""));
      const path = String(input.path || "");
      const content = typeof input.content === "string" ? input.content : null;
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      if (!path) return json({ ok: false, error: "path_required" }, 400);
      if (content === null) return json({ ok: false, error: "content_required" }, 400);
      const writeBytes = utf8ByteLength(content);
      if (writeBytes > MAX_WRITE_BYTES) return json({ ok: false, error: "too_large" }, 413);
      const account = await authorizeAccount(env, token, clientIp(request), { route: "web.file.write", writeBytes, includeRooms: true });
      if (account.ok === false) return json({ ok: false, error: account.error || "unauthorized" }, 401);
      const userId = String(account.user_id || "");
      const membership = (account.rooms || []).find((row) => row.room === room);
      if (!userId || !membership) return json({ ok: false, error: "forbidden" }, 403);
      if (!membership.scopes.includes("write")) return json({ ok: false, error: "read_only" }, 403);
      // Optimistic concurrency: when the client sends the etag it read, the
      // write only lands if the file is still at that version. A 412 hands
      // back the current file so the editor (or an agent) can re-merge —
      // lost updates become explicit conflicts instead of silent clobbers.
      const baseEtag = typeof input.base_etag === "string" ? input.base_etag : "";
      const wrote = await r2Put(env, userId, room, path, content, baseEtag || undefined);
      if (!wrote) {
        const current = await r2File(env, userId, room, path);
        return json({ ok: false, error: "conflict", file: current }, 412);
      }
      const file = await r2File(env, userId, room, path);
      // Presence: a web edit is the human writing — attribute to the handle.
      // The etag lets other tabs skip refetching a version they already hold.
      pokeRoomHub(env, userId, room, String(account.handle || "you"), path, "web", file?.etag);
      return json({ ok: true, file });
    }

    // ─── Public shares ────────────────────────────────────────────────────
    // POST mints (or returns the existing) share link for a page or
    // directory prefix; GET lists the caller's shares; DELETE revokes one.
    if (url.pathname === "/web/api/share" && request.method === "POST") {
      const input = await readJson(request);
      const room = parseOptionalWiki(String(input.room || ""));
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      const result = await registry(env, "/share-create", {
        token: bearerToken(request),
        ip: clientIp(request),
        room,
        prefix: String(input.path || ""),
      });
      if (result.ok === false) return json(result, 403);
      const base = publicBaseUrl(env, request);
      return json({ ...result, url: `${base}/s/${String(result.slug || "")}` });
    }

    if (url.pathname === "/web/api/shares" && request.method === "GET") {
      const result = await registry(env, "/share-list", { token: bearerToken(request), ip: clientIp(request) });
      return json(result, result.ok === false ? 401 : 200);
    }

    if (url.pathname === "/web/api/share" && request.method === "DELETE") {
      const slug = url.searchParams.get("slug") || "";
      if (!slug) return json({ ok: false, error: "slug_required" }, 400);
      const result = await registry(env, "/share-delete", { token: bearerToken(request), ip: clientIp(request), slug });
      return json(result, result.ok === false ? 401 : 200);
    }

    // Anonymous read side of a share. /s/<slug> serves the shared page or a
    // directory index; /s/<slug>/<path> walks into a shared directory.
    if (url.pathname.startsWith("/s/") && request.method === "GET") {
      return servePublicShare(env, request, url);
    }

    // ─── Device-flow OAuth ────────────────────────────────────────────────
    if (url.pathname === "/auth/device/start" && request.method === "POST") {
      const start = await registry(env, "/device-start", { ip: clientIp(request) });
      if (start.ok) {
        const base = publicBaseUrl(env, request);
        (start as any).verification_url = `${base}/device?code=${encodeURIComponent(String(start.code))}`;
      }
      return json(start);
    }

    if (url.pathname === "/auth/device/poll" && request.method === "POST") {
      const input = await readJson(request);
      return json(await registry(env, "/device-poll", { code: String(input.code || "") }));
    }

    if (url.pathname === "/device") {
      const code = url.searchParams.get("code") || "";
      return html(webDeviceHtml(code));
    }

    // ─── MCP OAuth 2.1 (RFC 9728 / RFC 8414 / RFC 7591 + PKCE) ────────────
    // Lets clients that only support OAuth (e.g. the claude.ai connector,
    // which has no field for a static token) authenticate by URL alone. The
    // flow bridges to bashroom's existing GitHub identity and mints the same
    // br_user_ token the CLI uses. Static-token auth on /mcp still works.

    // (1) Protected Resource Metadata — tells the client which auth server to
    // use. We are our own auth server.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      const base = publicBaseUrl(env, request);
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
      });
    }

    // (2) Authorization Server Metadata — advertises the OAuth endpoints and
    // capabilities. PKCE S256 required; dynamic registration supported.
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const base = publicBaseUrl(env, request);
      return json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], // public client + PKCE
      });
    }

    // (3) Dynamic Client Registration (RFC 7591). The connector self-registers
    // its redirect_uris and gets a client_id back.
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const input = await readJson(request);
      const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
      const reg = await registry(env, "/oauth-register", {
        redirect_uris: redirectUris,
        client_name: String(input.client_name || ""),
        ip: clientIp(request),
      });
      if (reg.error === "rate_limited") return json({ error: "temporarily_unavailable", error_description: "rate limited" }, 429);
      if (reg.ok === false) return json({ error: "invalid_client_metadata", error_description: reg.error }, 400);
      // RFC 7591 response shape.
      return json({
        client_id: reg.client_id,
        redirect_uris: reg.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }, 201);
    }

    // (4) Authorization endpoint. Validates the client + PKCE, stashes a
    // pending code, then bounces the user through GitHub to establish identity.
    if (url.pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const responseType = url.searchParams.get("response_type") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
      const clientState = url.searchParams.get("state") || ""; // client's own CSRF state, echoed back
      if (responseType !== "code") return text("unsupported_response_type", 400);
      if (codeChallengeMethod !== "S256" || !codeChallenge) return text("PKCE S256 required", 400);
      if (!env.GITHUB_CLIENT_ID) return text("GitHub OAuth not configured.", 500);

      // github_state ties the upcoming GitHub callback to this pending code.
      // We also smuggle the client's redirect_uri + state through it so the
      // callback can complete the redirect — packed as a single opaque token.
      const githubState = base64url(crypto.getRandomValues(new Uint8Array(18)));
      const created = await registry(env, "/oauth-create-code", {
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        github_state: githubState,
      });
      if (created.ok === false) {
        // Per OAuth 2.1, redirect errors back to the client when redirect_uri
        // is valid; here the client/redirect is what failed, so show plainly.
        return text(`authorize error: ${created.error}`, 400);
      }
      const authCode = String(created.code || "");
      // Pack everything the callback needs into GitHub's state param, so we
      // never have to store the plaintext auth code or client redirect/state
      // server-side: "<githubState>.<b64(redirectUri)>.<b64(authCode)>.<b64(clientState)>".
      const packedState = [
        githubState,
        base64url(new TextEncoder().encode(redirectUri)),
        base64url(new TextEncoder().encode(authCode)),
        base64url(new TextEncoder().encode(clientState)),
      ].join(".");
      const base = publicBaseUrl(env, request);
      const ghUrl = new URL("https://github.com/login/oauth/authorize");
      ghUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      // Reuse the ONE callback registered in the GitHub OAuth App. The shared
      // callback disambiguates device-flow vs OAuth-flow by the state shape:
      // OAuth states are packed with dots ("<gh>.<b64>.<b64>.<b64>"); device
      // states are plain (no dots). GitHub only allows registered callback
      // URLs, so a second path would 404 with "redirect_uri not associated".
      ghUrl.searchParams.set("redirect_uri", `${base}/auth/github/callback`);
      ghUrl.searchParams.set("scope", "read:user");
      ghUrl.searchParams.set("state", packedState);
      ghUrl.searchParams.set("allow_signup", "true");
      return new Response(null, { status: 302, headers: { location: ghUrl.toString() } });
    }

    // (4b) The GitHub callback is shared with the device flow at
    // /auth/github/callback (GitHub only allows registered callback URLs).
    // It detects this OAuth flow by the dotted state shape and completes there.

    // (5) Token endpoint. Exchanges the authorization code + PKCE verifier for
    // the br_user_ access token.
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const get = (k: string) => (form ? String(form.get(k) || "") : "");
      if (get("grant_type") !== "authorization_code") {
        return json({ error: "unsupported_grant_type" }, 400);
      }
      const exchanged = await registry(env, "/oauth-exchange", {
        code: get("code"),
        client_id: get("client_id"),
        redirect_uri: get("redirect_uri"),
        code_verifier: get("code_verifier"),
      });
      if (exchanged.ok === false) {
        const err = String(exchanged.error || "invalid_grant");
        const status = err === "authorization_pending" ? 400 : 400;
        return json({ error: err }, status);
      }
      return json({
        access_token: exchanged.token,
        token_type: "Bearer",
        scope: "rooms",
      });
    }

    if (url.pathname === "/auth/github") {
      const code = url.searchParams.get("code") || "";
      if (!code) return text("Missing device code.", 400);
      if (!env.GITHUB_CLIENT_ID) return text("GitHub OAuth not configured.", 500);
      // Mint state, attach to device code so the callback can find its way back.
      const state = base64url(crypto.getRandomValues(new Uint8Array(18)));
      const bind = await registry(env, "/device-bind-state", { code, state });
      if (!bind.ok) return text(`Bind failed: ${bind.error}`, 400);
      const base = publicBaseUrl(env, request);
      const ghUrl = new URL("https://github.com/login/oauth/authorize");
      ghUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      ghUrl.searchParams.set("redirect_uri", `${base}/auth/github/callback`);
      ghUrl.searchParams.set("scope", "read:user");
      ghUrl.searchParams.set("state", state);
      ghUrl.searchParams.set("allow_signup", "true");
      return new Response(null, { status: 302, headers: { location: ghUrl.toString() } });
    }

    if (url.pathname === "/auth/github/callback") {
      const ghCode = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      if (!ghCode || !state) return html(webDeviceResultHtml({ ok: false, message: "Missing OAuth code or state." }), 400);
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return html(webDeviceResultHtml({ ok: false, message: "GitHub OAuth not configured." }), 500);

      // Shared callback for BOTH flows — GitHub only allows registered callback
      // URLs, so the MCP OAuth flow reuses this one. Disambiguate by state
      // shape: MCP-OAuth states are packed with dots ("<gh>.<b64>.<b64>.<b64>");
      // device-flow states are plain base64url (no dots). Branch to OAuth here,
      // then fall through to the device-flow logic below.
      if (state.includes(".")) {
        const parts = state.split(".");
        if (parts.length !== 4) return text("Malformed state.", 400);
        const githubState = parts[0];
        const dec = (s: string) => { try { return new TextDecoder().decode(base64urlDecode(s)); } catch { return ""; } };
        const redirectUri = dec(parts[1]);
        const authCode = dec(parts[2]);
        const clientState = dec(parts[3]);
        if (!redirectUri || !authCode) return text("Malformed state payload.", 400);

        const cbBase = publicBaseUrl(env, request);
        const ghTok = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "user-agent": "bashroom" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: ghCode,
            redirect_uri: `${cbBase}/auth/github/callback`,
          }),
        });
        const ghTokJson = await ghTok.json().catch(() => ({})) as { access_token?: string; error?: string };
        if (!ghTokJson.access_token) return text(`GitHub: ${ghTokJson.error || "no access token"}`, 400);

        const ghUserRes = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${ghTokJson.access_token}`, accept: "application/vnd.github+json", "user-agent": "bashroom" },
        });
        const ghUser = await ghUserRes.json().catch(() => ({})) as { id?: number; login?: string };
        if (!ghUser.id || !ghUser.login) return text("Couldn't read GitHub profile.", 400);

        const resolved = await registry(env, "/oauth-resolve-state", {
          state: githubState,
          github_id: ghUser.id,
          github_login: ghUser.login,
        });
        if (resolved.ok === false) return text(`Authorization failed: ${resolved.error}`, 400);

        // Redirect back to the MCP client with the auth code (carried through
        // GitHub's state, so the token was never stored plaintext server-side).
        const back = new URL(redirectUri);
        back.searchParams.set("code", authCode);
        if (clientState) back.searchParams.set("state", clientState);
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }

      // Find the device code waiting on this state.
      const lookup = await registry(env, "/device-lookup-state", { state });
      if (!lookup.ok) return html(webDeviceResultHtml({ ok: false, message: `State not recognized: ${lookup.error}` }), 400);

      // Exchange GitHub OAuth code for an access token.
      const base = publicBaseUrl(env, request);
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": "bashroom" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: ghCode,
          redirect_uri: `${base}/auth/github/callback`,
        }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({})) as { access_token?: string; error?: string };
      if (!tokenJson.access_token) return html(webDeviceResultHtml({ ok: false, message: `GitHub: ${tokenJson.error || "no access token"}` }), 400);

      // Fetch the GitHub user.
      const userRes = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/vnd.github+json", "user-agent": "bashroom" },
      });
      const userJson = await userRes.json().catch(() => ({})) as { id?: number; login?: string };
      if (!userJson.id || !userJson.login) return html(webDeviceResultHtml({ ok: false, message: "Couldn't read GitHub profile." }), 400);

      // Reconstruct the original device code by looking it up via the code_hash we just got back.
      // The CLI knows its code; we don't need to re-display it. We just need to tell the registry
      // to claim by state (which it can derive from code_hash). Easier: claim by re-deriving
      // through state lookup. But our /device-claim takes the plain code, which we don't have here —
      // only its hash. Refactor: claim-by-state instead.
      const claim = await registry(env, "/device-claim-by-state", {
        state,
        github_id: userJson.id,
        github_login: userJson.login,
      });
      if (!claim.ok) return html(webDeviceResultHtml({ ok: false, message: `Claim failed: ${claim.error}` }), 400);

      return html(webDeviceResultHtml({ ok: true, message: `Signed in as @${userJson.login}. You can close this tab.` }));
    }

    if (url.pathname === "/") {
      const cities = await pingpongCities("bashroom.sdan.io").catch(() => [] as string[]);
      const colo = ((request as unknown as { cf?: { colo?: string } }).cf?.colo ?? "").toLowerCase();
      return html(webLandingHtml(cities, colo));
    }
    if (url.pathname === "/help") return text(httpHelpText());

    // Agent-readable surfaces. /llms.txt follows llmstxt.org and is the
    // table-of-contents an LLM fetches first. /skill.md returns the
    // bundled SKILL.md verbatim — agents can pick up the contract
    // without installing the skill locally.
    if (url.pathname === "/llms.txt") return text(llmsTxt(env, request));
    if (url.pathname === "/skill.md") return text(skillMarkdown);

    // OG / social-preview image. 1200×630 SVG matching the landing's
    // visual identity — cream surface, accent-purple mark, Inter
    // typography. Kept for in-app / landing use; social scrapers get the PNG
    // below (Twitter / iMessage / Slack reject SVG for og:image).
    if (url.pathname === "/og.svg") {
      return new Response(ogSvg(), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // Rasterized OG card for social previews. og:image / twitter:image point
    // here because Twitter/X, iMessage, Slack, and LinkedIn do not render SVG
    // and silently drop it (→ blank/placeholder card). Pre-rendered from
    // ogSvg() into assets/og.png; re-render via `npm run og` after edits.
    if (url.pathname === "/og.png") {
      return new Response(ogPng, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // ─── SPA deep-link fallback (must be the last check) ──────────────────
    // Canonical web-reader URLs are /<room>/<path>, e.g.
    // /bashroom/notes/handoff-template.md. The Worker has no per-file route —
    // it serves the same single-page app for any unmatched GET, and the client
    // reads location.pathname to open the right room/file (see web-ui.ts
    // stateFromUrl). This is the standard "server fallback for SPA deep links"
    // pattern.
    //
    // API paths should never fall through to HTML. This matters when we remove
    // compatibility endpoints: deleted JSON routes must become real 404s.
    if (url.pathname.startsWith("/web/api/")) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    // For non-API deep links, serve the single-page app. Missing asset-shaped
    // requests stay clean 404s instead of returning HTML with a 200, which
    // would break <img>/fetch consumers.
    if (request.method === "GET" && !isAsset(url.pathname)) {
      return html(webIndexHtml());
    }

    return json({ ok: false, error: "not_found" }, 404);
}

// Static-asset-ish paths the SPA fallback should skip (let them 404 cleanly
// rather than returning HTML with a 200, which breaks <img>/fetch consumers).
function isAsset(pathname: string): boolean {
  return /\.(png|jpe?g|gif|svg|ico|webp|css|js|map|json|txt|woff2?|ttf|xml)$/i.test(pathname);
}

// Pulls the top viewing-city list from pingpong.sdan.io for the landing
// footer. Cached in the Cloudflare Cache API for 5 minutes so repeated
// landing renders don't hammer pingpong. Returns city names only (the
// API returns "City, CC" — we strip the country code for the footer's
// human read). Empty array on any failure; the caller falls back
// gracefully to just the "from @sdan" signature.
async function pingpongCities(site: string): Promise<string[]> {
  const cacheKey = new Request(`https://internal/pingpong-cities/${encodeURIComponent(site)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json<{ cities: string[] }>().catch(() => null);
    if (data?.cities) return data.cities;
  }

  const url = `https://pingpong.sdan.io/stats?site=${encodeURIComponent(site)}&groupBy=city&limit=12`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return [];
  const json = await res.json<{ rows?: Array<{ key: string }> }>().catch(() => null);
  const rows = json?.rows || [];
  const cities = rows
    .map((row) => (row.key || "").split(",")[0].trim()) // "New York City, US" -> "New York City"
    .filter(Boolean);

  // 5-minute cache; pingpong's data is rolling-window monthly, no need for
  // tight freshness. Deferred — filling the cache shouldn't delay the render.
  defer(cache.put(
    cacheKey,
    new Response(JSON.stringify({ cities }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    }),
  ));
  return cities;
}

function publicBaseUrl(env: Env, request: Request): string {
  if (env.BASHROOM_PUBLIC_URL) return env.BASHROOM_PUBLIC_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// v2 entrypoint. Resolves user_id through the per-user AccountDO when the
// token is routeable, then delegates to runShellV2 (sandbox + R2). Legacy
// tokens fall back to Registry during migration.
async function runShell(env: Env, headerToken: string, ip: string, command: string, stdin: string): Promise<ShellResult> {
  const inputBytes = utf8ByteLength(command) + utf8ByteLength(stdin);
  const account = await authorizeAccount(env, headerToken, ip, { route: "mcp.exec", inputBytes, includeRooms: true });
  if (account.ok === false) {
    return { stdout: "", stderr: `bashroom: ${account.error || "unauthorized"}\n`, exitCode: 1, changed: 0, changed_paths: [] };
  }
  const userId = String(account.user_id || "");
  if (!userId) {
    return { stdout: "", stderr: "bashroom: no account\n", exitCode: 1, changed: 0, changed_paths: [] };
  }
  const result = await runShellV2(env, userId, headerToken, ip, command, stdin);
  // Presence: room-level touch for every room the command names. path=""
  // means "activity in this room" (readers refresh the tree, not a file);
  // heuristic until R2 event notifications provide per-file precision.
  // Failed commands don't poke — a command that errored is weak evidence
  // anything changed, and phantom activity is worse than missed activity.
  if (result.exitCode === 0) {
    for (const room of roomsMentioned(command)) {
      const membership = (account.rooms || []).find((row) => row.room === room);
      if (membership) pokeRoomHub(env, userId, room, String(membership.actor || "agent"), "", "shell");
    }
  }
  return result;
}

// Result of bashroom_write — separate shape from ShellResult since this
// path doesn't go through bash. `bytes` is the length actually written
// (after base64 decode if applicable).
interface WriteResult {
  ok: boolean;
  path: string;
  bytes: number;
  error?: string;
}

// bashroom_write — directly call sandbox.writeFile(), bypassing bash
// quoting. Resolves user_id same way runShell does; writes into the
// per-user FUSE mount at /rooms/.
async function runWriteFile(env: Env, headerToken: string, ip: string, path: string, content: string, encoding: "utf-8" | "base64"): Promise<WriteResult> {
  const bytes = encoding === "base64"
    ? Math.floor((content.length * 3) / 4)
    : utf8ByteLength(content);
  const account = await authorizeAccount(env, headerToken, ip, { route: "mcp.write", inputBytes: utf8ByteLength(path), writeBytes: bytes, includeRooms: true });
  if (account.ok === false) {
    return { ok: false, path, bytes: 0, error: String(account.error || "unauthorized") };
  }
  const userId = String(account.user_id || "");
  if (!userId) {
    return { ok: false, path, bytes: 0, error: "no account" };
  }
  // Path must live under /rooms. Anything else is rejected — the sandbox
  // mounts /rooms from R2; writes elsewhere don't persist anyway.
  if (!path.startsWith("/rooms/")) {
    return { ok: false, path, bytes: 0, error: "path must be under /rooms/" };
  }
  try {
    const sandbox = await ensureSandboxReady(env, userId);
    const sessionId = `write-${crypto.randomUUID()}`;
    let session: Awaited<ReturnType<Sandbox["createSession"]>> | undefined;
    try {
      session = await sandbox.createSession({
        id: sessionId,
        cwd: "/",
        env: { HOME: "/tmp/bashroom-home" },
      });
      // SDK accepts encoding: 'utf-8' (default) or 'base64'. We pass through.
      await session.writeFile(path, content, { encoding });
      // Presence: attribute to the room's registered actor (the agent
      // identity chosen at create/join — per-connection agent identity
      // isn't knowable on the stateless MCP transport).
      const segments = path.split("/"); // "/rooms/<room>/rest..."
      const room = segments[2] || "";
      const rel = segments.slice(3).join("/");
      const membership = (account.rooms || []).find((row) => row.room === room);
      if (room && membership) pokeRoomHub(env, userId, room, String(membership.actor || "agent"), rel, "mcp");
      // Best-effort byte count for the audit / response. For base64 it's
      // the decoded length; for utf-8 it's the UTF-8 byte length.
      return { ok: true, path, bytes };
    } finally {
      await sandbox.deleteSession(sessionId).catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, path, bytes: 0, error: message };
  }
}

function formatWriteResult(result: WriteResult): string {
  if (!result.ok) {
    return `[bashroom_write] error=${result.error || "unknown"} path=${result.path}`;
  }
  return `[bashroom_write] wrote ${result.bytes} bytes to ${result.path}`;
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

function accountObjectName(userId: string): string {
  return `acct:${userId}`;
}

function routeUserIdFromToken(token: string): string {
  const parts = token.split(".");
  return parts[0] === "br" && parts[1]?.startsWith("usr_") ? parts[1] : "";
}

async function authorizeAccount(
  env: Env,
  token: string,
  ip: string,
  opts: { route: string; cost?: number; inputBytes?: number; writeBytes?: number; includeRooms?: boolean },
): Promise<AccountWire> {
  if (!token) return { ok: false, error: "missing_token" };
  const routeUserId = routeUserIdFromToken(token);
  const tokenHash = await sha256(token);

  // Routeable tokens (br.usr_… shape) carry their user id inline, so the
  // per-user AccountDO can authorize, meter, AND return the room mirror in
  // one round trip — no Registry hit on the hot path. The mirror is kept
  // current by syncAccount / upsertRoom / removeRoom on every room mutation.
  // Tokens without an inline id fall through to the Registry path below.
  if (routeUserId) {
    const account = env.ACCOUNTS.getByName(accountObjectName(routeUserId));
    const decision = await account.authorizeAndCharge({
      tokenHash,
      ip,
      route: opts.route,
      cost: opts.cost,
      inputBytes: opts.inputBytes,
      writeBytes: opts.writeBytes,
      includeRooms: opts.includeRooms,
    });
    // Hydrate-on-miss: if a caller wants rooms but the mirror is empty (a
    // never-synced account from before mirroring, or membership granted
    // out-of-band), fall back to the Registry once and heal the mirror. The
    // common case — a warm mirror — never reaches this and pays no Registry RTT.
    if (decision.ok && opts.includeRooms && decision.user_id && (decision.rooms?.length ?? 0) === 0) {
      const canonical = accountWireFromRegistry(await registry(env, "/internal-account-rooms", { user_id: decision.user_id }));
      if (canonical.ok && (canonical.rooms?.length ?? 0) > 0) {
        defer(account.syncAccount({
          userId: decision.user_id,
          handle: canonical.handle || decision.handle || "user",
          rooms: canonical.rooms || [],
        }));
        return canonical;
      }
    }
    return decision;
  }

  // Tokens that don't carry an inline route id (the live br_user_… format)
  // are authorized by the Registry, which owns the token→user mapping and
  // the room membership. This is the primary path for current tokens, not a
  // legacy fallback.
  return accountWireFromRegistry(await registry(env, "/account-rooms", { token, ip }));
}

function accountWireFromRegistry(result: Record<string, unknown>): AccountWire {
  if (result.ok === false) {
    return {
      ok: false,
      error: String(result.error || "unauthorized"),
      retry_after_seconds: typeof result.retry_after_seconds === "number" ? result.retry_after_seconds : undefined,
    };
  }
  return {
    ok: true,
    user_id: typeof result.user_id === "string" ? result.user_id : "",
    handle: typeof result.handle === "string" ? result.handle : "",
    rooms: accountRoomsFromUnknown(result.rooms),
  };
}

function accountRoomsFromUnknown(value: unknown): AccountRoom[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const room = row && typeof row === "object" && "room" in row ? String((row as { room?: unknown }).room || "") : "";
      if (!room) return null;
      const actor = row && typeof row === "object" && "actor" in row ? String((row as { actor?: unknown }).actor || "user") : "user";
      const scopesValue = row && typeof row === "object" && "scopes" in row ? (row as { scopes?: unknown }).scopes : [];
      const scopes = Array.isArray(scopesValue)
        ? parseScopes(scopesValue, ["read"])
        : String(scopesValue || "").split(",").filter((scope): scope is Scope => ["read", "write", "checkpoint", "admin"].includes(scope));
      const role = row && typeof row === "object" && "role" in row ? String((row as { role?: unknown }).role || "member") : "member";
      const createdAt = row && typeof row === "object" && "created_at" in row ? String((row as { created_at?: unknown }).created_at || new Date().toISOString()) : new Date().toISOString();
      return { room, actor, scopes: scopes.length ? scopes : ["read"], role, created_at: createdAt };
    })
    .filter((row): row is AccountRoom => Boolean(row));
}

function mcpJsonResult(value: unknown, isError = false): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function mcpTree(env: Env, token: string, ip: string, path: string, maxEntries?: number): Promise<Record<string, unknown>> {
  try {
    const inputBytes = utf8ByteLength(path || "/rooms");
    const parsed = parseMcpRoomsPath(path || "/rooms", true);
    const account = await authorizeMcpStorageAccount(env, token, ip, "mcp.tree", inputBytes);
    if (!account.ok) return account;

    if (parsed.root) {
      return {
        ok: true,
        path: "/rooms",
        rooms: account.rooms.map((room) => ({
          room: room.room,
          path: mountPath(room.room),
          actor: room.actor,
          scopes: room.scopes,
          role: room.role,
        })),
      };
    }

    const roomAuth = authorizeMcpStorageRoom(account, parsed.room, parsed.path);
    if (!roomAuth.ok) return roomAuth;

    const limit = clampInt(maxEntries, DEFAULT_MCP_TREE_ENTRIES, MAX_MCP_TREE_ENTRIES);
    const listed = await r2ListPrefix(env, roomAuth.userId, roomAuth.room, roomAuth.path, true, limit + 1);
    const prefix = r2KeyForRoom(roomAuth.userId, roomAuth.room);
    const objects = listed.objects.slice(0, limit);
    return {
      ok: true,
      path: formatRoomsPath(roomAuth.room, roomAuth.path),
      room: roomAuth.room,
      files: objects.map((object) => r2MetadataForObject(object, prefix)),
      truncated: listed.truncated || listed.objects.length > limit,
      max_entries: limit,
    };
  } catch (error) {
    return mcpError(error);
  }
}

async function mcpRead(env: Env, token: string, ip: string, path: string, offset?: number, maxBytes?: number): Promise<Record<string, unknown>> {
  try {
    const parsed = parseMcpRoomsPath(path, false);
    if (parsed.root || !parsed.path) return { ok: false, error: "file_path_required" };
    const roomAuth = await authorizeMcpStoragePath(env, token, ip, "mcp.read", parsed, utf8ByteLength(path));
    if (!roomAuth.ok) return roomAuth;

    const key = r2KeyForFile(roomAuth.userId, roomAuth.room, roomAuth.path);
    const object = await env.ROOMS_R2.head(key);
    if (!object) return { ok: false, error: "not_found", path: formatRoomsPath(roomAuth.room, roomAuth.path) };

    const prefix = r2KeyForRoom(roomAuth.userId, roomAuth.room);
    const metadata = r2MetadataForObject(object, prefix);
    const isBinary = !isTextFile(metadata.path, metadata.content_type);
    if (isBinary) return { ok: false, error: "binary_file", file: { ...metadata, is_binary: true } };

    const start = clampInt(offset, 0, Math.max(0, metadata.size_bytes));
    const limit = clampInt(maxBytes, DEFAULT_MCP_READ_BYTES, MAX_MCP_READ_BYTES);
    if (start >= metadata.size_bytes) {
      return {
        ok: true,
        file: { ...metadata, is_binary: false },
        offset: start,
        max_bytes: limit,
        bytes_returned: 0,
        truncated: false,
        content: "",
      };
    }

    const length = Math.min(limit, metadata.size_bytes - start);
    const body = await env.ROOMS_R2.get(key, { range: { offset: start, length } });
    if (!body || !("text" in body)) return { ok: false, error: "not_found", path: formatRoomsPath(roomAuth.room, roomAuth.path) };
    const content = await body.text();
    return {
      ok: true,
      file: { ...metadata, is_binary: false },
      offset: start,
      max_bytes: limit,
      bytes_returned: utf8ByteLength(content),
      truncated: start + length < metadata.size_bytes,
      content,
    };
  } catch (error) {
    return mcpError(error);
  }
}

// Bounded per-room scan behind /web/api/search. Shares the R2 primitives
// with mcpSearch but skips per-room re-authorization (the caller already
// verified membership with one authorizeAccount call) and spends from a
// shared match budget so the all-rooms fan-out stays interactive.
async function webSearchRoom(
  env: Env,
  userId: string,
  room: string,
  query: string,
  budget: { matches: number },
): Promise<Array<{ room: string; path: string; line: number; preview: string }>> {
  if (budget.matches <= 0) return [];
  try {
    const listed = await r2ListPrefix(env, userId, room, "", true, 200);
    const prefix = r2KeyForRoom(userId, room);
    const needle = query.toLowerCase();
    const out: Array<{ room: string; path: string; line: number; preview: string }> = [];
    // Fetch files through a small worker pool instead of one-at-a-time — the
    // sequential loop made a 100-file room pay ~100 R2 round-trips in series
    // and the slowest room gated the whole response. The 1000-subrequest cap
    // was removed platform-wide in 2026-02, so concurrency is free.
    const objects = listed.objects;
    let cursor = 0;
    const scanOne = async (): Promise<void> => {
      while (budget.matches > 0) {
        const index = cursor;
        cursor += 1;
        if (index >= objects.length) return;
        const object = objects[index];
        const metadata = r2MetadataForObject(object, prefix);
        if (!metadata.size_bytes) continue;
        if (!isTextFile(metadata.path, metadata.content_type)) continue;
        if (metadata.size_bytes > 256_000) continue;
        const body = await env.ROOMS_R2.get(object.key, { range: { offset: 0, length: Math.min(metadata.size_bytes, 256_000) } });
        if (!body || !("text" in body)) continue;
        const lines = (await body.text()).split(/\r?\n/);
        for (let li = 0; li < lines.length; li += 1) {
          if (!lines[li].toLowerCase().includes(needle)) continue;
          if (budget.matches <= 0) break;
          out.push({ room, path: metadata.path, line: li + 1, preview: previewLine(lines[li]) });
          budget.matches -= 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(20, objects.length || 1) }, scanOne));
    // Pool completion order is nondeterministic — stable-sort for the UI.
    out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return out;
  } catch {
    return []; // one broken room must not kill the whole cross-room search
  }
}

async function mcpSearch(
  env: Env,
  token: string,
  ip: string,
  input: {
    path: string;
    query: string;
    caseSensitive: boolean;
    maxMatches?: number;
    maxFiles?: number;
    maxBytesPerFile?: number;
  },
): Promise<Record<string, unknown>> {
  try {
    const parsed = parseMcpRoomsPath(input.path, false);
    if (parsed.root) return { ok: false, error: "room_path_required" };
    const inputBytes = utf8ByteLength(input.path) + utf8ByteLength(input.query);
    const roomAuth = await authorizeMcpStoragePath(env, token, ip, "mcp.search", parsed, inputBytes);
    if (!roomAuth.ok) return roomAuth;

    const maxMatches = clampInt(input.maxMatches, DEFAULT_MCP_SEARCH_MATCHES, MAX_MCP_SEARCH_MATCHES);
    const maxFiles = clampInt(input.maxFiles, DEFAULT_MCP_SEARCH_FILES, MAX_MCP_SEARCH_FILES);
    const maxBytesPerFile = clampInt(input.maxBytesPerFile, DEFAULT_MCP_SEARCH_FILE_BYTES, MAX_MCP_SEARCH_FILE_BYTES);
    const listed = await r2ListPrefix(env, roomAuth.userId, roomAuth.room, roomAuth.path, true, maxFiles + 1);
    const objects = listed.objects.slice(0, maxFiles);
    const prefix = r2KeyForRoom(roomAuth.userId, roomAuth.room);
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const skipped: Array<{ path: string; reason: string; size_bytes: number }> = [];
    let scannedFiles = 0;

    for (const object of objects) {
      if (matches.length >= maxMatches) break;
      const metadata = r2MetadataForObject(object, prefix);
      if (!isTextFile(metadata.path, metadata.content_type)) {
        skipped.push({ path: metadata.path, reason: "binary_file", size_bytes: metadata.size_bytes });
        continue;
      }
      if (metadata.size_bytes > maxBytesPerFile) {
        skipped.push({ path: metadata.path, reason: "file_too_large", size_bytes: metadata.size_bytes });
        continue;
      }
      const body = await env.ROOMS_R2.get(object.key, { range: { offset: 0, length: Math.min(metadata.size_bytes, maxBytesPerFile) } });
      if (!body || !("text" in body)) continue;
      scannedFiles += 1;
      const content = await body.text();
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = input.caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (!haystack.includes(needle)) continue;
        matches.push({ path: metadata.path, line: index + 1, preview: previewLine(lines[index]) });
        if (matches.length >= maxMatches) break;
      }
    }

    return {
      ok: true,
      path: formatRoomsPath(roomAuth.room, roomAuth.path),
      room: roomAuth.room,
      query: input.query,
      case_sensitive: input.caseSensitive,
      matches,
      scanned_files: scannedFiles,
      skipped_files: skipped,
      truncated: matches.length >= maxMatches || listed.truncated || listed.objects.length > maxFiles,
      max_matches: maxMatches,
      max_files: maxFiles,
      max_bytes_per_file: maxBytesPerFile,
    };
  } catch (error) {
    return mcpError(error);
  }
}

async function mcpStat(env: Env, token: string, ip: string, path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parseMcpRoomsPath(path, false);
    if (parsed.root || !parsed.path) return { ok: false, error: "file_path_required" };
    const roomAuth = await authorizeMcpStoragePath(env, token, ip, "mcp.stat", parsed, utf8ByteLength(path));
    if (!roomAuth.ok) return roomAuth;

    const object = await env.ROOMS_R2.head(r2KeyForFile(roomAuth.userId, roomAuth.room, roomAuth.path));
    if (!object) return { ok: false, error: "not_found", path: formatRoomsPath(roomAuth.room, roomAuth.path) };
    const metadata = r2MetadataForObject(object, r2KeyForRoom(roomAuth.userId, roomAuth.room));
    return {
      ok: true,
      path: formatRoomsPath(roomAuth.room, roomAuth.path),
      file: {
        ...metadata,
        is_binary: !isTextFile(metadata.path, metadata.content_type),
      },
    };
  } catch (error) {
    return mcpError(error);
  }
}

async function authorizeMcpStorageAccount(env: Env, token: string, ip: string, route: string, inputBytes: number): Promise<StorageAccountAuth> {
  const account = await authorizeAccount(env, token, ip, { route, includeRooms: true, inputBytes });
  if (account.ok === false) {
    return { ok: false, error: account.error || "unauthorized", retry_after_seconds: account.retry_after_seconds };
  }
  const userId = String(account.user_id || "");
  if (!userId) return { ok: false, error: "no_account" };
  return {
    ok: true,
    userId,
    handle: account.handle || "user",
    rooms: Array.isArray(account.rooms) ? account.rooms : [],
  };
}

async function authorizeMcpStoragePath(
  env: Env,
  token: string,
  ip: string,
  route: string,
  parsed: ParsedRoomsPath,
  inputBytes: number,
): Promise<StorageRoomAuth> {
  const account = await authorizeMcpStorageAccount(env, token, ip, route, inputBytes);
  if (!account.ok) return account;
  return authorizeMcpStorageRoom(account, parsed.room, parsed.path);
}

function authorizeMcpStorageRoom(account: Extract<StorageAccountAuth, { ok: true }>, room: string, path: string): StorageRoomAuth {
  const match = account.rooms.find((candidate) => candidate.room === room);
  if (!match) return { ok: false, error: "forbidden" };
  if (!hasScope(match.scopes, "read")) return { ok: false, error: "insufficient_scope" };
  return {
    ok: true,
    userId: account.userId,
    handle: account.handle,
    room: match.room,
    actor: match.actor,
    scopes: match.scopes,
    path,
  };
}

function parseMcpRoomsPath(raw: string, allowRoomsRoot: boolean): ParsedRoomsPath {
  const value = (raw || "").trim().replace(/\/+$/g, "") || "/rooms";
  if (value === "/rooms") {
    if (!allowRoomsRoot) throw new Error("room_path_required");
    return { root: true, room: "", path: "" };
  }
  if (!value.startsWith("/rooms/")) throw new Error("path must start with /rooms/");
  const rest = value.slice("/rooms/".length);
  const slash = rest.indexOf("/");
  const room = sanitizeWiki(slash === -1 ? rest : rest.slice(0, slash));
  const path = slash === -1 ? "" : sanitizeFilePath(rest.slice(slash + 1));
  return { root: false, room, path };
}

function formatRoomsPath(room: string, path: string): string {
  return path ? `/rooms/${room}/${path}` : `/rooms/${room}`;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function previewLine(value: string): string {
  const normalized = value.replace(/\t/g, " ").trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 300)}...`;
}

function mcpError(error: unknown): Record<string, unknown> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

type SandboxOutboundContext = {
  containerId?: string;
  params?: unknown;
};

async function handleSandboxBashroomControl(request: Request, env: Env, context: SandboxOutboundContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== "bashroom.internal") return json({ ok: false, error: "blocked_host" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const userId = sandboxOutboundUserId(context);
  if (!userId) return json({ ok: false, error: "missing_sandbox_identity" }, 401);

  const input = await readJson(request);
  const result = await handleSandboxAccountRequest(env, userId, url.pathname, input);
  return json(result, result.ok === false ? 400 : 200);
}

function sandboxOutboundUserId(context: SandboxOutboundContext): string {
  const params = context.params && typeof context.params === "object"
    ? context.params as { userId?: unknown }
    : {};
  return typeof params.userId === "string" ? params.userId : "";
}

async function handleSandboxAccountRequest(env: Env, userId: string, path: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (path === "/account/rooms") {
    return registry(env, "/internal-account-rooms", { user_id: userId });
  }

  if (path === "/account/room-create") {
    return createRoomForUser(env, userId, {
      room: input.room || input.wiki || "",
      actor: input.actor || defaultActor("agent"),
    });
  }

  if (path === "/account/room-join") {
    return registry(env, "/internal-room-join", {
      user_id: userId,
      invite: String(input.invite || ""),
      actor: String(input.actor || defaultActor("agent")),
    });
  }

  if (path === "/account/room-pair") {
    return registry(env, "/internal-room-pair", {
      user_id: userId,
      wiki: String(input.wiki || input.room || ""),
      scopes: input.scopes,
    });
  }

  if (path === "/account/room-mounts") {
    return registry(env, "/internal-room-mounts", { user_id: userId });
  }

  if (path === "/account/room-who") {
    return registry(env, "/internal-room-who", {
      user_id: userId,
      wiki: String(input.wiki || input.room || ""),
    });
  }

  if (path === "/account/room-history") {
    return registry(env, "/internal-room-history", {
      user_id: userId,
      room: String(input.room || input.wiki || ""),
      limit: input.limit,
    });
  }

  return { ok: false, error: "not_found" };
}

async function createRoomForUser(env: Env, userId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await registry(env, "/internal-room-create", {
    user_id: userId,
    room: input.room || input.wiki || "",
    actor: input.actor || defaultActor("agent"),
  });
  if (result.ok && typeof result.wiki === "string" && typeof result.actor === "string" && typeof result.user_id === "string") {
    await seedR2Room(env, result.user_id, result.wiki, result.actor);
  }
  return result;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseScopes(value: unknown, fallback: Scope[]): Scope[] {
  if (!Array.isArray(value)) return fallback;
  const scopes = value.filter((scope): scope is Scope => ["read", "write", "checkpoint", "admin"].includes(String(scope)));
  return scopes.length ? scopes : fallback;
}

function hasScope(scopes: Scope[], required: Scope): boolean {
  return scopes.includes("admin") || scopes.includes(required);
}

function parseLimit(value: unknown): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function sanitizeWiki(wiki: string): string {
  const value = wiki.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(value)) throw new Error("invalid room");
  if (value.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("invalid room");
  return value;
}

// Empty/missing input is legitimate (e.g. an optional ?room= query param).
// Malformed non-empty input is a client error and throws — caught at the
// fetch boundary and returned as 400.
function parseOptionalWiki(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  return sanitizeWiki(value);
}

function sanitizeFilePath(path: string): string {
  const value = path.trim().replace(/^\/+/, "");
  if (!value || value.length > 512 || value.includes("\0")) throw new Error("invalid file path");
  if (value.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("invalid file path");
  return value;
}

function sanitizeActor(actor: string): string {
  return actor.trim().replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 80) || "actor";
}

function sanitizeHandle(handle: string): string {
  return handle.trim().replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 80) || "user";
}

function mountPath(wiki: string): string {
  return `/rooms/${sanitizeWiki(wiki)}`;
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 599)}…`;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

// ─── R2 helpers ─────────────────────────────────────────────────────────
// All keys are users/<user_id>/<room>/<path>. These helpers own the
// prefix layout so callers never construct the key string themselves.
function r2KeyForRoom(userId: string, room: string): string {
  return `users/${userId}/${sanitizeWiki(room)}/`;
}

function r2KeyForFile(userId: string, room: string, path: string): string {
  return `users/${userId}/${sanitizeWiki(room)}/${sanitizeFilePath(path)}`;
}

function r2KeyPrefixForPath(userId: string, room: string, pathPrefix: string): string {
  return pathPrefix
    ? `${r2KeyForRoom(userId, room)}${sanitizeFilePath(pathPrefix)}`
    : r2KeyForRoom(userId, room);
}

async function r2List(env: Env, userId: string, room?: string, includeMetadata = false): Promise<R2Object[]> {
  const prefix = room ? r2KeyForRoom(userId, room) : `users/${userId}/`;
  const out: R2Object[] = [];
  let cursor: string | undefined;
  // R2 caps a single list at 1000; loop until we have everything for the user.
  // For v2.0 single-user usage this is always one page in practice.
  do {
    const options: R2ListOptions & { include?: Array<"httpMetadata" | "customMetadata"> } = {
      prefix,
      cursor,
      limit: 1000,
    };
    if (includeMetadata) options.include = ["httpMetadata", "customMetadata"];
    const page = await env.ROOMS_R2.list(options);
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function r2ListPrefix(
  env: Env,
  userId: string,
  room: string,
  pathPrefix: string,
  includeMetadata: boolean,
  maxObjects: number,
): Promise<{ objects: R2Object[]; truncated: boolean }> {
  const prefix = r2KeyPrefixForPath(userId, room, pathPrefix);
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const remaining = Math.max(1, maxObjects - out.length);
    const options: R2ListOptions & { include?: Array<"httpMetadata" | "customMetadata"> } = {
      prefix,
      cursor,
      limit: Math.min(1000, remaining),
    };
    if (includeMetadata) options.include = ["httpMetadata", "customMetadata"];
    const page = await env.ROOMS_R2.list(options);
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < maxObjects);
  return { objects: out, truncated: Boolean(cursor) };
}

// Returns false when baseEtag is supplied and the object changed since that
// read — R2's conditional put (onlyIf.etagMatches) makes this a true
// compare-and-swap at the source of truth, so it guards against ALL other
// write paths (web editor, bashroom_write, FUSE writes from shells).
async function r2Put(env: Env, userId: string, room: string, path: string, content: string, baseEtag?: string): Promise<boolean> {
  const result = await env.ROOMS_R2.put(r2KeyForFile(userId, room, path), content, {
    httpMetadata: { contentType: contentTypeForPath(path) },
    ...(baseEtag ? { onlyIf: { etagMatches: baseEtag } } : {}),
  });
  return result !== null;
}

// ─── Public share serving ───────────────────────────────────────────────
// GET /s/<slug>[/<path...>] — anonymous, read-only. The slug is the whole
// capability: the Registry resolves it to (user, room, prefix) and every
// response is bounded to that subtree. Markdown renders as a minimal HTML
// page; other files serve raw with their stored content type; a directory
// renders an index of links. Unknown slug and empty directory both 404
// identically so the route doesn't leak which slugs exist.
async function servePublicShare(env: Env, request: Request, url: URL): Promise<Response> {
  // Edge cache: a hot share link should not wake the Registry singleton on
  // every hit. Responses carry max-age=60, but Worker responses aren't
  // edge-cached unless we use the Cache API explicitly. Revocation therefore
  // propagates within ~60s — acceptable for a read capability.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const segments = url.pathname.split("/").filter(Boolean); // ["s", slug, ...path]
  const slug = decodeURIComponent(segments[1] || "");
  if (!slug) return publicShareNotFound();
  const share = await registry(env, "/share-resolve", { slug, ip: clientIp(request) });
  if (share.ok === false) {
    if (share.error === "rate_limited") return json(share, 429);
    return publicShareNotFound();
  }
  const userId = String(share.user_id || "");
  const room = String(share.room || "");
  const prefix = String(share.prefix || "");
  const rest = segments.slice(2).map(decodeURIComponent).join("/");
  // The visitor's path is relative to the shared prefix — they never see or
  // choose the room/user part of the key.
  const target = [prefix, rest].filter(Boolean).join("/");

  // Store a successful render in the edge cache, then return it. 404s are
  // never cached so revoked/renamed links recover immediately.
  const store = (response: Response): Response => {
    defer(cache.put(cacheKey, response.clone()));
    return response;
  };

  if (target) {
    const object = await env.ROOMS_R2.get(r2KeyForFile(userId, room, target));
    if (object) {
      const contentType = object.httpMetadata?.contentType || contentTypeForPath(target);
      if (contentType.startsWith("text/markdown")) {
        const nonce = crypto.randomUUID();
        return store(new Response(publicMarkdownHtml(room, target, await object.text(), nonce, slug), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60",
            "x-content-type-options": "nosniff",
            // Only our nonce'd inline script + the pinned CDN may execute.
            // Anything injected via shared content has no nonce → blocked.
            "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
          },
        }));
      }
      // Raw serving executes on this origin, where the reader keeps its
      // bearer token in localStorage — so active content types (html/svg/xml)
      // are downgraded to text/plain. A share is a read capability, not a
      // hosting service.
      const rawType = /html|svg|xml/i.test(contentType) ? "text/plain; charset=utf-8" : contentType;
      return store(new Response(object.body, {
        headers: { "content-type": rawType, "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" },
      }));
    }
  }

  // No exact file — treat the target as a directory and render an index.
  const dirPrefix = target ? `${target}/` : "";
  const { objects } = await r2ListPrefix(env, userId, room, dirPrefix, false, MAX_MCP_TREE_ENTRIES);
  const roomPrefix = r2KeyForRoom(userId, room);
  const entries = objects
    .map((o) => o.key.slice(roomPrefix.length))
    .filter((p) => p && !p.endsWith("/")) // skip s3fs directory-marker objects
    .map((p) => p.slice(dirPrefix.length))
    .sort();
  if (!entries.length) return publicShareNotFound();
  // Hrefs stay relative to the slug root: /s/<slug>/<path-beyond-prefix>.
  const hrefBase = `/s/${encodeURIComponent(slug)}` + (rest ? `/${rest.split("/").map(encodeURIComponent).join("/")}` : "");
  return store(new Response(publicIndexHtml(room, target, hrefBase, entries), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  }));
}

function publicShareNotFound(): Response {
  return html(publicShellHtml("not found", `<div class="empty">Nothing here. The link may have been revoked.</div>`), 404);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The live-follow client for share pages: connects to the room hub by
// capability slug (read-only, prefix-scoped server-side), morphs the article
// while someone is typing this file, and cache-busts to the fresh page when
// a durable write lands. Escape discipline: this string is embedded in a
// template literal — no raw backticks, and \n only as \\n inside JS literals.
function publicLiveScript(slug: string, livePath: string): string {
  return `(function(){
  var slug = ${JSON.stringify(slug)};
  var path = ${JSON.stringify(livePath)};
  var flag = null, idleTimer = 0;
  function ensureFlag(actor){
    if (!flag) {
      flag = document.createElement("div");
      flag.className = "live-flag";
      document.body.appendChild(flag);
    }
    flag.textContent = actor + " \\u00b7 editing\\u2026";
    flag.style.display = "block";
  }
  function hideFlag(){ if (flag) flag.style.display = "none"; }
  function render(md){
    try { document.getElementById("doc").innerHTML = DOMPurify.sanitize(marked.parse(md)); } catch (_) {}
  }
  function connect(){
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    var ws = new WebSocket(scheme + location.host + "/web/api/presence?slug=" + encodeURIComponent(slug));
    var ping = setInterval(function(){ try { ws.send("ping"); } catch (_) {} }, 45000);
    ws.onmessage = function(e){
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.path !== path) return;
      if (m.type === "draft") {
        ensureFlag(m.actor);
        render(m.content);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(hideFlag, 3500);
      } else if (m.type === "write") {
        // Durable save: bust the 60s edge cache with the new etag.
        ensureFlag(m.actor);
        setTimeout(function(){ location.href = location.pathname + "?v=" + encodeURIComponent(m.etag || Date.now()); }, 900);
      }
    };
    ws.onclose = function(){ clearInterval(ping); setTimeout(connect, 5000 + Math.random() * 5000); };
  }
  connect();
})();`;
}

function publicMarkdownHtml(room: string, path: string, markdown: string, nonce: string, slug?: string): string {
  // Content is inlined as JSON and rendered client-side with the same marked
  // build the logged-in reader uses, so shared pages look identical to the
  // reader. <-escape keeps a literal </script> in the file body from
  // breaking out of the inline script context. marked passes raw HTML
  // through, so the output goes through DOMPurify before touching the DOM —
  // shared markdown is untrusted input on this origin.
  const payload = JSON.stringify(markdown).replace(/</g, "\\u003c");
  const body = `
  <div class="file-meta"><span>${escapeHtml(room)}/${escapeHtml(path)}</span></div>
  <article id="doc"></article>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@13.0.2/marked.min.js"></script>
  <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"></script>
  <script nonce="${nonce}">document.getElementById("doc").innerHTML = DOMPurify.sanitize(marked.parse(${payload}));</script>
  ${slug ? `<script nonce="${nonce}">${publicLiveScript(slug, path)}</script>` : ""}`;
  return publicShellHtml(`${room}/${path}`, body);
}

function publicIndexHtml(room: string, target: string, hrefBase: string, entries: string[]): string {
  const rows = entries
    .map((entry) => `<li><a href="${hrefBase}/${entry.split("/").map(encodeURIComponent).join("/")}">${escapeHtml(entry)}</a></li>`)
    .join("\n");
  const body = `
  <div class="file-meta"><span>${escapeHtml(room)}${target ? "/" + escapeHtml(target) : ""}/</span></div>
  <ul class="index">${rows}</ul>`;
  return publicShellHtml(`${room}${target ? "/" + target : ""}/`, body);
}

// Shared chrome for the anonymous pages — the reader's palette and type
// scale, no sidebar, no scripts beyond marked. Quiet "shared via bashroom"
// footer instead of navigation.
function publicShellHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — bashroom</title>
<meta name="robots" content="noindex" />
<style>
  :root { --bg:#ffffff; --side:#f7f7f5; --hover:#efeeec; --ink:#37352f; --ink-dim:#6f6e69; --ink-faint:#a3a29c; --rule:#ebeae6; --link:#4f3bd0; --mono:ui-monospace,"SF Mono","Menlo","Consolas",monospace; --sans:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Helvetica,Arial,sans-serif; }
  @media (prefers-color-scheme: dark) { :root { --bg:#191919; --side:#202020; --hover:#2a2a2a; --ink:#e8e6e1; --ink-dim:#9b9a94; --ink-faint:#5c5b56; --rule:#2a2a2a; --link:#c8a8ff; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:16px; line-height:1.6; -webkit-font-smoothing:antialiased; }
  main { max-width:820px; margin:0 auto; padding:56px 24px 120px; }
  .file-meta { font-family:var(--mono); font-size:11px; color:var(--ink-faint); margin-bottom:24px; }
  .empty { color:var(--ink-dim); }
  .live-flag { display:none; position:fixed; top:14px; right:16px; z-index:5; font-family:var(--mono); font-size:10.5px; padding:3px 9px; border:1px solid var(--link); color:var(--link); border-radius:999px; background:var(--bg); }
  ul.index { list-style:none; margin:0; padding:0; }
  ul.index li { padding:6px 0; border-bottom:1px solid var(--rule); font-family:var(--mono); font-size:13px; }
  ul.index a { color:var(--ink); text-decoration:none; }
  ul.index a:hover { color:var(--link); }
  article h1, article h2, article h3, article h4 { font-weight:600; line-height:1.3; margin-top:1.6em; margin-bottom:0.4em; letter-spacing:-0.01em; }
  article h1 { font-size:2.25em; margin-top:0; }
  article h2 { font-size:1.5em; }
  article h3 { font-size:1.15em; }
  article a { color:var(--link); text-decoration:underline; text-decoration-thickness:1px; text-underline-offset:3px; }
  article code { font-family:var(--mono); font-size:0.85em; background:var(--hover); padding:2px 6px; border-radius:3px; }
  article pre { font-family:var(--mono); font-size:13px; line-height:1.55; background:var(--side); border:1px solid var(--rule); padding:14px 16px; overflow-x:auto; border-radius:6px; }
  article pre code { background:transparent; padding:0; }
  article blockquote { border-left:3px solid var(--ink); margin:1em 0; padding:0 0 0 14px; color:var(--ink-dim); }
  article img { max-width:100%; }
  article table { border-collapse:collapse; font-size:14px; }
  article th, article td { border:1px solid var(--rule); padding:6px 10px; text-align:left; }
  .foot { margin-top:48px; padding-top:14px; border-top:1px solid var(--rule); font-family:var(--sans); font-size:11px; color:var(--ink-faint); }
  .foot a { color:var(--ink-dim); text-decoration:none; }
  .foot a:hover { color:var(--link); }
</style>
</head>
<body>
<main>
${body}
<div class="foot">shared via <a href="https://bashroom.sdan.io">bashroom</a> — a filesystem for agents</div>
</main>
</body>
</html>`;
}

// ─── v2 shell exec ──────────────────────────────────────────────────
// Entrypoint replacing v1's runShell(). Every command goes to a fresh
// session inside the per-user warm sandbox — control-plane verbs live
// on dedicated /account/room-* HTTP endpoints, not in bash.
async function runShellV2(env: Env, userId: string, headerToken: string, ip: string, command: string, stdin: string): Promise<ShellResult> {
  // Real bash via the sandbox. One sandbox per user, fresh session per call.
  const sandbox = await ensureSandboxReady(env, userId);
  const sessionId = `cmd-${crypto.randomUUID()}`;
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let session: Awaited<ReturnType<Sandbox["createSession"]>> | undefined;
  // Stdin via the SDK's ExecOptions does NOT work — `@cloudflare/sandbox`
  // has no `stdin` field on its ExecOptions interface, so any value spread
  // there is silently dropped. Wrap the stdin into the command line by
  // base64-encoding it and piping `base64 -d` into the user's command.
  // Safe against any byte sequence (including quotes, newlines, NUL) and
  // adds ~33% encoding overhead for the stdin payload.
  //
  // `btoa` requires its input to be a binary string (each char ≤ 0xFF),
  // so we go UTF-8 → bytes → binary-string first. This handles emoji,
  // non-ASCII, etc. without errors.
  function toBase64Utf8(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  const effectiveCommand = stdin
    ? `printf %s ${JSON.stringify(toBase64Utf8(stdin))} | base64 -d | (${command})`
    : command;
  try {
    session = await sandbox.createSession({
      id: sessionId,
      cwd: "/",
      env: { HOME: "/tmp/bashroom-home" },
    });
    const result = await session.exec(effectiveCommand.slice(0, MAX_COMMAND_CHARS), {
      timeout: 30_000,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    exitCode = result.exitCode ?? 0;
  } catch (error) {
    stderr = `bashroom: ${error instanceof Error ? error.message : String(error)}\n`;
    exitCode = 1;
  } finally {
    // Two-step cleanup: killAllProcesses() reaps the in-container process
    // (a timed-out exec leaves it running per Cloudflare's docs), then
    // deleteSession() removes the session handle. Both are best-effort and
    // deferred — the response never waits on cleanup.
    const reap = session ? session.killAllProcesses().catch(() => undefined) : Promise.resolve();
    defer(reap.then(() => sandbox.deleteSession(sessionId).catch(() => undefined)));
  }

  // Audit. Best-effort; deferred so logging never adds to response latency.
  defer(registry(env, "/audit-append", {
    user_id: userId, room: "", actor: "sandbox", kind: "exec", path: null, command: compact(command), exit_code: exitCode,
  }));

  return { stdout, stderr, exitCode, changed: 0, changed_paths: [] };
}

// ─── Sandbox readiness ──────────────────────────────────────────────
// One Sandbox DO per user_id. We keep it warm (sleepAfter is set on the
// class) and mount /rooms lazily — on the first request after a cold
// start, the FUSE mount is established. Subsequent requests skip the
// mount call (mountBucket is idempotent-ish; we probe first to avoid
// the extra round trip).
async function ensureSandboxReady(env: Env, userId: string): Promise<Sandbox> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  // Sandbox IDs are used in preview URLs; normalizeId lowercases them
  // and matches the SDK's documented future-default.
  const sandbox = getSandbox(env.SANDBOXES, userId, { normalizeId: true });
  await sandbox.setOutboundByHost("bashroom.internal", "bashroomControl", { userId });
  if (!(await isRoomsMounted(sandbox))) {
    if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new Error("R2 credentials not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
    }
    // RemoteMountBucketOptions: production s3fs-FUSE mode. First arg is
    // the bucket name. R2 credentials are scoped to bashroom-rooms only.
    //
    // NOTE: credentialProxy: true is the goal (keeps R2 keys out of the
    // untrusted container) but in the 0.12.1 deploy it left /rooms mounted
    // yet every read/write through the mount hung to timeout — the re-signing
    // proxy wasn't completing S3 requests. Reverted to direct credentials
    // until that's diagnosed; see the backlog. Direct creds work; the
    // credential-scope hardening is re-queued, not abandoned.
    await sandbox.mountBucket(env.R2_BUCKET_NAME || "bashroom-rooms", "/rooms", {
      endpoint: env.R2_ENDPOINT,
      provider: "r2",
      prefix: `/users/${userId}/`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return sandbox;
}

async function isRoomsMounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const result = await sandbox.exec("mountpoint -q /rooms && echo MOUNTED || echo NOT_MOUNTED");
    return result.stdout.trim() === "MOUNTED";
  } catch {
    return false;
  }
}

// Default seed shapes how agents use the room. Per Anthropic + Lance
// Martin context-engineering guidance: keep AGENTS.md terse and
// rule-based (long convention files get ignored), and ship a directory
// pattern that demonstrates folders so agents inherit it. Mirrors the
// v1 Room.seed() output byte-for-byte so existing rooms and new ones
// look identical.
async function seedR2Room(env: Env, userId: string, room: string, actor: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const cleanActor = sanitizeActor(actor || "actor");
  const files: Record<string, string> = {
    "README.md":
      `# ${room}\n\nA Bashroom room. Multiple agents read and write the files here through ` +
      `durable bash. Edit this README to describe what this specific room is for.\n`,
    "AGENTS.md":
      `# Bashroom room conventions\n\n` +
      `Shared Markdown filesystem. Multiple agents read and write here.\n` +
      `Reorganize freely — rename, split, merge, or delete files when the\n` +
      `structure no longer fits. Every change is in \`room history\`, so\n` +
      `nothing is ever truly lost.\n\n` +
      `## Default shape\n\n` +
      `- Dated entries → \`log/YYYY-MM-DD.md\` (one file per day, append \`## HH:MM topic\` sections)\n` +
      `- Standalone topics → \`notes/<topic>.md\` (one file per subject)\n` +
      `- Top-level \`index.md\` is the table of contents — keep it current when files change\n\n` +
      `## Rules\n\n` +
      `- IMPORTANT: append to log files (\`>>\`), don't overwrite (\`>\`) — preserves chronology\n` +
      `- IMPORTANT: update \`index.md\` whenever the file tree changes\n` +
      `- Markdown only. No binaries.\n` +
      `- If a file gets long, split it into a folder.\n`,
    "index.md":
      `# Index\n\n` +
      `- [README.md](README.md) — what this room is for\n` +
      `- [AGENTS.md](AGENTS.md) — conventions for agents working here\n` +
      `- [log/](log/) — dated entries, newest day at top of folder\n` +
      `- [notes/](notes/) — topical notes\n`,
    [`log/${today}.md`]:
      `# ${today}\n\n` +
      `## room created\n\n` +
      `Created by ${cleanActor}. Append further entries under \`## HH:MM topic\` headings.\n`,
    "notes/README.md":
      `# notes/\n\n` +
      `One Markdown file per topic. Filename = topic, kebab-case (e.g. \`auth-flow.md\`).\n` +
      `Delete this README when the folder has real content.\n`,
  };
  // Parallel PUTs — each room has ~5 files and R2 PUTs are independent.
  await Promise.all(Object.entries(files).map(([path, content]) => r2Put(env, userId, room, path, content)));
  await registry(env, "/audit-append", {
    user_id: userId, room, actor: cleanActor, kind: "seed", path: null, command: null, exit_code: 0,
  });
}

async function r2Tree(env: Env, userId: string, room: string): Promise<R2FileMetadata[]> {
  const objects = await r2List(env, userId, room, true);
  const prefix = r2KeyForRoom(userId, room);
  return objects.map((object) => r2MetadataForObject(object, prefix));
}

async function r2File(env: Env, userId: string, room: string, path: string): Promise<R2File | null> {
  const obj = await env.ROOMS_R2.get(r2KeyForFile(userId, room, path));
  if (!obj) return null;
  const prefix = r2KeyForRoom(userId, room);
  const metadata = r2MetadataForObject(obj, prefix);
  const isBinary = !isTextFile(metadata.path, metadata.content_type);
  return {
    ...metadata,
    content: isBinary ? "" : await obj.text(),
    is_binary: isBinary,
  };
}

function r2MetadataForObject(object: R2Object, prefix: string): R2FileMetadata {
  const path = object.key.slice(prefix.length);
  return {
    path,
    size_bytes: object.size,
    updated_at: object.uploaded.toISOString(),
    etag: object.etag,
    http_etag: object.httpEtag,
    version: object.version,
    content_type: object.httpMetadata?.contentType || contentTypeForPath(path),
    custom_metadata: object.customMetadata || {},
  };
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function isTextFile(path: string, contentType: string): boolean {
  const lowerType = contentType.toLowerCase();
  if (lowerType.startsWith("text/")) return true;
  if (lowerType.includes("json") || lowerType.includes("xml") || lowerType.includes("javascript")) return true;
  return /\.(md|markdown|txt|log|json|csv|ts|tsx|js|jsx|mjs|cjs|css|html|htm|xml|svg|yaml|yml|toml)$/i.test(path);
}

async function r2DeletePrefix(env: Env, userId: string, room: string): Promise<number> {
  // R2 delete() takes up to 1000 keys per call. Page through list() and
  // batch-delete until the prefix is empty.
  const prefix = r2KeyForRoom(userId, room);
  let deleted = 0;
  while (true) {
    const page = await env.ROOMS_R2.list({ prefix, limit: 1000 });
    if (!page.objects.length) break;
    await env.ROOMS_R2.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
    if (!page.truncated) break;
  }
  return deleted;
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function defaultActor(prefix: string): string {
  return `${prefix}-${randomSuffix(4)}`;
}

function randomAccountToken(userId: string): string {
  // Routeable but still secret: user_id chooses AccountDO; the random
  // suffix is hashed and verified inside that DO.
  return `br.${userId}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

function randomPairCode(): string {
  return `${randomSuffix(4).toUpperCase()}-${randomSuffix(4).toUpperCase()}`;
}

function inviteUri(wiki: string, code: string): string {
  return `bashroom://join/${encodeURIComponent(wiki)}?code=${encodeURIComponent(code)}`;
}

function normalizeDeviceCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

function normalizePairCode(invite: string): string {
  const value = invite.trim();
  if (!value.includes("://")) return value.toUpperCase();

  try {
    const url = new URL(value);
    const code = url.searchParams.get("code") || url.hash.slice(1);
    if (code) return code.trim().toUpperCase();
  } catch {
    return value.toUpperCase();
  }

  return value.toUpperCase();
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

function base64urlDecode(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(hash));
}

function formatShellResult(result: ShellResult): string {
  const output = `${result.stdout}${result.stderr ? `${result.stderr}` : ""}`;
  const paths = result.changed_paths.length ? ` ${result.changed_paths.join(" ")}` : "";
  return `${output}${output && !output.endsWith("\n") ? "\n" : ""}[bashroom] exit=${result.exitCode} changed=${result.changed}${paths}\n`;
}

function json(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function httpHelpText(): string {
  return `# Bashroom

A filesystem for agents. \`/rooms\` is FUSE-mounted from
Cloudflare R2 and persists across calls.

## Agent-readable

- \`/llms.txt\` — table of contents for LLMs (llmstxt.org format)
- \`/skill.md\` — the bundled Claude skill, served verbatim

## Wire it up

Local stdio MCP (token stays on your machine):

\`\`\`bash
npm install -g bashroom
bashroom login
claude mcp add --scope user bashroom -- bashroom mcp
codex mcp add bashroom -- bashroom mcp
\`\`\`

Or remote MCP for hosted use (no local CLI):

\`\`\`bash
claude mcp add --scope user --transport http bashroom https://bashroom.sdan.io/mcp
\`\`\`

## Tools

- \`bashroom({ command, stdin? })\` — runs bash inside your sandbox.
- \`bashroom_write({ path, content, encoding? })\` — writes a file directly.
- \`bashroom_tree/read/search/stat(...)\` — reads bounded R2 context without
  starting bash.

## Source

https://github.com/sdan/bashroom
`;
}

// llms.txt — table-of-contents Markdown an LLM fetches first. Spec:
// https://llmstxt.org/  (H1 + blockquote summary + H2 sections of links).
function llmsTxt(env: Env, request: Request): string {
  const base = publicBaseUrl(env, request);
  return `# Bashroom

> A filesystem for agents. MCP exposes real \`bash\` plus
> bounded R2 file tools for tree, read, search, stat, and direct writes.
> \`/rooms\` is FUSE-mounted from Cloudflare R2 inside the sandbox.
> Room admin is available through the visible \`bashroom\` helper; destructive
> room deletion stays laptop-only.

## Use

- [README](${base}/help): one-page overview, install, and MCP wiring
- [Skill](${base}/skill.md): the SKILL.md a Claude Code / Codex agent should load
- [Source](https://github.com/sdan/bashroom): full code on GitHub
- [Architecture](https://github.com/sdan/bashroom/blob/master/ARCHITECTURAL.md): how v3 is built

## MCP

- [MCP endpoint](${base}/mcp): streamable HTTP transport
- Tools: \`bashroom\`, \`bashroom_write\`, \`bashroom_tree\`,
  \`bashroom_read\`, \`bashroom_search\`, \`bashroom_stat\`

## Optional

- [Web reader](${base}/web): browser view of your rooms (logged in)
- [Roadmap](https://github.com/sdan/bashroom/blob/master/docs/product-roadmap.md): planned work
`;
}
