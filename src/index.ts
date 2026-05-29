import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, type TransportState } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Sandbox as SandboxBase } from "@cloudflare/sandbox";
import { z } from "zod";
// Bundle the canonical SKILL.md at build time via wrangler's text-import
// rule. Serving /skill.md from this same string guarantees no drift
// between the bundled skill and what the worker hands out.
import skillMarkdown from "../skills/bashroom/SKILL.md";
import { webIndexHtml } from "./web-ui";
import { webLandingHtml } from "./web-landing";
import { webDeviceHtml, webDeviceResultHtml } from "./web-device";

export { ContainerProxy } from "@cloudflare/sandbox";

type Env = {
  REGISTRY: DurableObjectNamespace<Registry>;
  SANDBOXES: DurableObjectNamespace<Sandbox>;
  ROOMS_R2: R2Bucket;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BASHROOM_PUBLIC_URL?: string;
  R2_BUCKET_NAME?: string;
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


type Scope = "read" | "write" | "checkpoint" | "admin";

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  changed: number;
  changed_paths: string[];
};

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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_COMMAND_CHARS = 32_000;
// Hard cap on bashroom_write content. R2 supports much larger objects,
// but the MCP tool round-trip is JSON-serialized through the wire, so
// huge payloads are awkward. 5 MB is well above any reasonable note.
const MAX_WRITE_BYTES = 5_000_000;
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
    // Dead grant tables from the pre-account era. Drop on cold start.
    // wiki_tokens: per-room access tokens (replaced by user_rooms membership).
    // wiki_session_tokens: per-MCP-session room grants (replaced by token → user → membership).
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS wiki_tokens");
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS wiki_session_tokens");
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_transport_states (
        session_hash TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJson(request) : {};

    if (request.method === "POST" && url.pathname === "/mcp-transport-get") {
      return json({ state: await this.mcpTransportState(bearerFromUnknown(body.mcpSessionId)) });
    }

    if (request.method === "POST" && url.pathname === "/mcp-transport-set") {
      await this.setMcpTransportState(bearerFromUnknown(body.mcpSessionId), body.state);
      return json({ ok: true });
    }

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
      return json(this.deleteWiki(wiki));
    }

    if (request.method === "POST" && url.pathname === "/account-rooms") {
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json({ ok: true, user_id: account.userId, handle: account.handle, rooms: this.accountRooms(account.userId || "") });
    }

    if (request.method === "POST" && url.pathname === "/account-room-create") {
      // Kept as alias for /create. CLI calls this from `bashroom room create`.
      const account = await this.verifyAccount(bearerFromUnknown(body.token), String(body.ip || "unknown"));
      if (!account.ok) return json(account, 401);
      return json(await this.createWiki(account.userId || "", account.handle || "user", String(body.room || body.wiki || ""), String(body.actor || "")));
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
    const now = new Date().toISOString();
    const token = randomAccountToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("utok");
    this.ctx.storage.sql.exec(
      "INSERT INTO user_tokens (token_hash, token_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      tokenId,
      userId,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE device_codes SET claimed_at = ?, user_id = ?, token = ? WHERE code_hash = ?",
      now,
      userId,
      token,
      codeHash,
    );
    return { ok: true, user_id: userId, github_login: githubLogin };
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

  private deleteWiki(wiki: string): Record<string, unknown> {
    const cleanWiki = sanitizeWiki(wiki);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("DELETE FROM wikis WHERE room = ?", cleanWiki);
    this.ctx.storage.sql.exec("DELETE FROM user_rooms WHERE room = ?", cleanWiki);
    this.ctx.storage.sql.exec("UPDATE wiki_pair_codes SET used_at = ? WHERE room = ? AND used_at IS NULL", now, cleanWiki);
    return { ok: true, wiki: cleanWiki };
  }

  private async mcpTransportState(mcpSessionId: string): Promise<unknown | undefined> {
    if (!mcpSessionId) return undefined;
    const row = this.ctx.storage.sql
      .exec<{ state_json: string }>("SELECT state_json FROM mcp_transport_states WHERE session_hash = ?", await sha256(mcpSessionId))
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

function createServer(env: Env, headerToken: string, mcpSessionId: string, ip: string): McpServer {
  const server = new McpServer({ name: "bashroom", version: "0.2.0" });

  server.tool(
    "bashroom",
    "Run bash against /rooms, a FUSE-mounted filesystem backed by Cloudflare R2. Real Linux shell with bash, git, ripgrep, jq, find, less, tree, fd, rsync. Use ls /rooms to see your rooms; everything else is normal bash.",
    {
      command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("Bash command to run, for example: ls /rooms; cat /rooms/my-room/index.md"),
      stdin: z.string().optional().describe("Optional standard input for the command. Piped to the command via base64 round-trip so any byte sequence (quotes, newlines, NUL) is safe."),
    },
    async ({ command, stdin }) => {
      const result = await runShell(env, headerToken, mcpSessionId, ip, command, stdin || "");
      return {
        content: [{ type: "text", text: formatShellResult(result) }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.tool(
    "bashroom_write",
    "Write a file to /rooms directly, bypassing bash quoting. Use this instead of `echo ... > file` or heredoc when content contains quotes, backticks, $variables, or arbitrary bytes. The path must be inside /rooms/<room>/.",
    {
      path: z.string().min(1).max(1024).describe("Absolute path under /rooms, e.g. /rooms/my-room/notes/today.md"),
      content: z.string().max(MAX_WRITE_BYTES).describe("File content. UTF-8 by default; pass base64-encoded bytes with encoding='base64' for binary."),
      encoding: z.enum(["utf-8", "base64"]).optional().describe("'utf-8' (default) treats content as text; 'base64' decodes content as binary before writing."),
    },
    async ({ path, content, encoding }) => {
      const result = await runWriteFile(env, headerToken, mcpSessionId, ip, path, content, encoding ?? "utf-8");
      return {
        content: [{ type: "text", text: formatWriteResult(result) }],
        isError: !result.ok,
      };
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

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const token = bearerToken(request);
      return createMcpHandler(createServer(env, token, mcpSessionId(request), clientIp(request)), {
        sessionIdGenerator: () => crypto.randomUUID(),
        storage: mcpTransportStorage(env, request),
      })(request, env, ctx);
    }

    if (url.pathname === "/bash" && request.method === "POST") {
      const input = await readJson(request);
      const result = await runShell(env, bearerToken(request), mcpSessionId(request), clientIp(request), String(input.command || ""), String(input.stdin || ""));
      return json(result, result.exitCode === 0 ? 200 : 400);
    }

    if (url.pathname === "/account/rooms" && request.method === "POST") {
      return json(await registry(env, "/account-rooms", { token: bearerToken(request), ip: clientIp(request) }));
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
    // touch R2. We look up the user_id via /account-rooms because
    // r2DeletePrefix is keyed by user.
    if (url.pathname === "/account/room-delete" && request.method === "POST") {
      const input = await readJson(request);
      const wiki = String(input.wiki || input.room || "");
      const token = bearerToken(request);
      const ip = clientIp(request);
      const account = await registry(env, "/account-rooms", { token, ip });
      if (account.ok === false) return json(account, 401);
      const userId = String(account.user_id || "");
      if (!userId) return json({ ok: false, error: "no_account" }, 400);
      const result = await registry(env, "/delete", { token, wiki, ip });
      if (result.ok && typeof result.wiki === "string") {
        await r2DeletePrefix(env, userId, result.wiki);
      }
      return json(result, result.ok === false ? 400 : 200);
    }

    // List the calling user's room mounts — wraps Registry /mounts.
    if (url.pathname === "/account/room-mounts" && request.method === "POST") {
      const result = await registry(env, "/mounts", {
        token: bearerToken(request),
        ip: clientIp(request),
      });
      return json(result, result.ok === false ? 400 : 200);
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
      const account = await registry(env, "/account-rooms", { token: bearerToken(request), ip: clientIp(request) });
      if (account.ok === false) return json({ ok: false, error: account.error || "unauthorized" }, 401);
      const userId = String(account.user_id || "");
      if (!userId) return json({ ok: false, error: "no_account" }, 400);
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox(env.SANDBOXES, userId, { normalizeId: true });
      await sandbox.destroy().catch(() => undefined);
      return json({ ok: true, user_id: userId, message: "sandbox destroyed; next request boots fresh" });
    }

    if (url.pathname === "/web" || url.pathname === "/web/") return html(webIndexHtml());

    if (url.pathname === "/web/api/rooms" && request.method === "GET") {
      // Pass ?active=ROOM to also fetch that room's snapshot in the same
      // response — saves a round-trip on initial page load.
      const account = await registry(env, "/account-rooms", { token: bearerToken(request), ip: clientIp(request) });
      const userId = String(account.user_id || "");
      const requested = parseOptionalWiki(url.searchParams.get("active"));
      const memberRooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      const activeRoom = requested && memberRooms.some((row) => row.room === requested) ? requested : "";
      const snapshot = activeRoom && userId ? await r2Snapshot(env, userId, activeRoom) : null;
      return json({ ...account, active: activeRoom || null, snapshot });
    }

    if (url.pathname === "/web/api/snapshot" && request.method === "GET") {
      const token = bearerToken(request);
      const room = parseOptionalWiki(url.searchParams.get("room"));
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      const account = await registry(env, "/account-rooms", { token, ip: clientIp(request) });
      const userId = String(account.user_id || "");
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!userId || !rooms.some((row) => row.room === room)) return json({ ok: false, error: "forbidden" }, 403);
      return json({ ok: true, files: await r2Snapshot(env, userId, room) });
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
    // typography. Twitter / Slack / iMessage render SVG correctly for
    // link previews; no PNG export needed.
    if (url.pathname === "/og.svg") {
      return new Response(ogSvg(), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // ─── SPA deep-link fallback ───────────────────────────────────────────
    // Canonical web-reader URLs are /<room>/<path>, e.g.
    // /bashroom/notes/handoff-template.md. The Worker has no per-file route —
    // it serves the same single-page app for any non-reserved GET, and the
    // client reads location.pathname to open the right room/file (see
    // web-ui.ts stateFromUrl). This is the standard "server fallback for SPA
    // deep links" pattern. It MUST come after every real route above so a room
    // can never shadow /mcp, /help, /auth, etc.
    //
    // Guards: GET only (a POST to an unknown path is a real 404, not the app),
    // and an explicit denylist of reserved first segments — needed because
    // some reserved routes are method-gated (e.g. POST /create), so a GET to
    // them would otherwise fall through here and wrongly serve HTML.
    if (request.method === "GET" && !isAsset(url.pathname)) {
      const firstSeg = url.pathname.replace(/^\/+/, "").split("/")[0].toLowerCase();
      if (firstSeg && !RESERVED_FIRST_SEGMENTS.has(firstSeg)) {
        // The SPA itself enforces membership/auth via /web/api/*; an
        // unauthorized deep link just renders the login/empty state.
        return html(webIndexHtml());
      }
    }

    return json({ ok: false, error: "not_found" }, 404);
}

// First-path-segments the deep-link fallback must NOT treat as room names.
// Mirrors every top-level route in fetch() plus a few reserved-for-future
// surfaces. A room literally named one of these can't be deep-linked (the
// sidebar still opens it via the API), which is an acceptable trade for never
// shadowing a real endpoint.
const RESERVED_FIRST_SEGMENTS = new Set<string>([
  "web", "mcp", "bash", "help", "device", "auth", "account", "sandbox",
  "create", "join", "pair", "mounts", "actors", "delete",
  "skill.md", "llms.txt", "og.svg", "favicon.ico", "robots.txt",
  "mcp-transport-get", "mcp-transport-set",
  "account-rooms", "account-room-create",
  "internal-account-rooms", "internal-room-create", "internal-room-join",
  "internal-room-pair", "internal-room-mounts", "internal-room-who",
  "internal-room-history",
  "device-start", "device-poll", "device-bind-state", "device-lookup-state",
  "device-claim-by-state", "audit-append", "audit-list",
]);

// Static-asset-ish paths the SPA fallback should skip (let them 404 cleanly
// rather than returning HTML with a 200, which breaks <img>/fetch consumers).
function isAsset(pathname: string): boolean {
  return /\.(png|jpe?g|gif|svg|ico|webp|css|js|map|json|txt|woff2?|ttf|xml)$/i.test(pathname);
}

function ogSvg(): string {
  // 1200x630 OG image. Tagline top-right, brand bottom-left, room tree
  // centered. The tree IS the product mental model — top-level room with
  // files attributed to agents. Composition mirrors the landing footer
  // (brand bottom-left) so social previews and the site share signature.
  const fontStack = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const monoStack = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#F7F7F5"/>

  <!-- Brand block, top-left. Same mark/wordmark proportions as the
       site nav (gap ≈ 45% of mark height): mark height 42px, gap 19px,
       last square ends at x=122, wordmark starts at x=141. -->
  <g transform="translate(80, 80)">
    <g fill="#37352F">
      <rect x="0"   y="0" width="42" height="42" rx="10" opacity="0.12"/>
      <rect x="16"  y="0" width="42" height="42" rx="10" opacity="0.22"/>
      <rect x="32"  y="0" width="42" height="42" rx="10" opacity="0.36"/>
      <rect x="48"  y="0" width="42" height="42" rx="10" opacity="0.55"/>
      <rect x="64"  y="0" width="42" height="42" rx="10" opacity="0.78"/>
      <rect x="80"  y="0" width="42" height="42" rx="10" opacity="1"/>
    </g>
    <text x="141" y="32" font-family="${fontStack}" font-size="36" font-weight="500" fill="#37352F" letter-spacing="-0.5">bashroom</text>
  </g>

  <!-- Room tree, centered. Mirrors the landing diagram. -->
  <g transform="translate(380, 200)">
    <rect x="0" y="0" width="440" height="260" fill="none" stroke="#4F3BD0" stroke-width="2"/>
    <line x1="0" y1="48" x2="440" y2="48" stroke="#EBEAE6" stroke-width="1"/>
    <text x="22" y="32" font-family="${monoStack}" font-size="20" fill="#4F3BD0">sdan/quickquack</text>
    <g font-family="${monoStack}" font-size="18" fill="#37352F">
      <text x="22" y="86" fill="#A3A29C">▾</text>
      <rect x="44" y="74" width="20" height="16" fill="#D8A23A" rx="2"/>
      <path d="M 46 78 L 50 78 L 52 80 L 62 80 L 62 88 L 46 88 Z" fill="#D8A23A"/>
      <text x="72" y="88" fill="#37352F">notes/</text>
      <rect x="74" y="106" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="100" y="120" fill="#37352F">2026-05-20.md</text>
      <text x="418" y="120" text-anchor="end" fill="#A3A29C" font-size="14">claude</text>
      <rect x="74" y="136" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="100" y="150" fill="#37352F">2026-05-21.md</text>
      <text x="418" y="150" text-anchor="end" fill="#A3A29C" font-size="14">codex</text>
      <rect x="44" y="166" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="180" fill="#37352F">index.md</text>
      <text x="418" y="180" text-anchor="end" fill="#A3A29C" font-size="14">you</text>
      <rect x="44" y="196" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="210" fill="#37352F">log.md</text>
      <text x="418" y="210" text-anchor="end" fill="#A3A29C" font-size="14">claude</text>
      <rect x="44" y="226" width="18" height="18" fill="none" stroke="#1CA1C7" stroke-width="1.5"/>
      <text x="72" y="240" fill="#37352F">README.md</text>
      <text x="418" y="240" text-anchor="end" fill="#A3A29C" font-size="14">you</text>
    </g>
  </g>

  <!-- Tagline, bottom-right — diagonal pair to the top-left brand. -->
  <text x="1120" y="555" text-anchor="end" font-family="${fontStack}" font-size="26" font-weight="400" fill="#6F6E69">a shared filesystem for coding agents</text>
</svg>`;
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

  // 5-minute cache; pingpong's data is rolling-window monthly, no need for tight freshness.
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ cities }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    }),
  );
  return cities;
}

function publicBaseUrl(env: Env, request: Request): string {
  if (env.BASHROOM_PUBLIC_URL) return env.BASHROOM_PUBLIC_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// v2 entrypoint. Resolves user_id via Registry, then delegates to
// runShellV2 (sandbox + R2). The MCP and /bash routes both call this.
async function runShell(env: Env, headerToken: string, _mcpSessionId: string, ip: string, command: string, stdin: string): Promise<ShellResult> {
  const account = await registry(env, "/account-rooms", { token: headerToken, ip });
  if (account.ok === false) {
    return { stdout: "", stderr: `bashroom: ${account.error || "unauthorized"}\n`, exitCode: 1, changed: 0, changed_paths: [] };
  }
  const userId = String(account.user_id || "");
  if (!userId) {
    return { stdout: "", stderr: "bashroom: no account\n", exitCode: 1, changed: 0, changed_paths: [] };
  }
  return runShellV2(env, userId, headerToken, ip, command, stdin);
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
async function runWriteFile(env: Env, headerToken: string, _mcpSessionId: string, ip: string, path: string, content: string, encoding: "utf-8" | "base64"): Promise<WriteResult> {
  const account = await registry(env, "/account-rooms", { token: headerToken, ip });
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
      // Best-effort byte count for the audit / response. For base64 it's
      // the decoded length; for utf-8 it's the UTF-8 byte length.
      const bytes = encoding === "base64"
        ? Math.floor((content.length * 3) / 4)
        : new TextEncoder().encode(content).length;
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

async function r2List(env: Env, userId: string, room?: string): Promise<R2Object[]> {
  const prefix = room ? r2KeyForRoom(userId, room) : `users/${userId}/`;
  const out: R2Object[] = [];
  let cursor: string | undefined;
  // R2 caps a single list at 1000; loop until we have everything for the user.
  // For v2.0 single-user usage this is always one page in practice.
  do {
    const page = await env.ROOMS_R2.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function r2Get(env: Env, userId: string, room: string, path: string): Promise<string | null> {
  const obj = await env.ROOMS_R2.get(r2KeyForFile(userId, room, path));
  return obj ? await obj.text() : null;
}

async function r2Put(env: Env, userId: string, room: string, path: string, content: string): Promise<void> {
  await env.ROOMS_R2.put(r2KeyForFile(userId, room, path), content);
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
    // deleteSession() removes the session handle. Both calls are
    // best-effort — never block the response on cleanup.
    if (session) {
      await session.killAllProcesses().catch(() => undefined);
    }
    await sandbox.deleteSession(sessionId).catch(() => undefined);
  }

  // Audit. Best-effort; never block the response on logging.
  await registry(env, "/audit-append", {
    user_id: userId, room: "", actor: "sandbox", kind: "exec", path: null, command: compact(command), exit_code: exitCode,
  }).catch(() => undefined);

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

// Snapshot a room's full file tree out of R2 as { path, content }[] —
// the same shape /web previously got from Room.snapshot(). Reads happen
// in parallel; this is fine for v2.0 single-user rooms (avg <20 files).
async function r2Snapshot(env: Env, userId: string, room: string): Promise<Array<{ path: string; content: string }>> {
  const objects = await r2List(env, userId, room);
  const prefix = r2KeyForRoom(userId, room);
  return Promise.all(
    objects.map(async (o) => {
      const obj = await env.ROOMS_R2.get(o.key);
      return { path: o.key.slice(prefix.length), content: obj ? await obj.text() : "" };
    }),
  );
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

function randomAccountToken(): string {
  return `br_user_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
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

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(hash));
}

function formatShellResult(result: ShellResult): string {
  const output = `${result.stdout}${result.stderr ? `${result.stderr}` : ""}`;
  const paths = result.changed_paths.length ? ` ${result.changed_paths.join(" ")}` : "";
  return `${output}${output && !output.endsWith("\n") ? "\n" : ""}[bashroom] exit=${result.exitCode} changed=${result.changed}${paths}\n`;
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

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function httpHelpText(): string {
  return `# Bashroom

Per-user Linux shell for coding agents. \`/rooms\` is FUSE-mounted from
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

## Tool

\`bashroom({ command, stdin? })\` — runs bash inside your sandbox.

## Source

https://github.com/sdan/bashroom
`;
}

// llms.txt — table-of-contents Markdown an LLM fetches first. Spec:
// https://llmstxt.org/  (H1 + blockquote summary + H2 sections of links).
function llmsTxt(env: Env, request: Request): string {
  const base = publicBaseUrl(env, request);
  return `# Bashroom

> Per-user Linux shell for coding agents. One MCP tool —
> \`bashroom({ command, stdin? })\` — runs real \`bash\` inside a
> Cloudflare Sandbox with \`/rooms\` FUSE-mounted from Cloudflare R2.
> Room admin is available through the visible \`bashroom\` helper inside
> the sandbox; destructive room deletion stays laptop-only.

## Use

- [README](${base}/help): one-page overview, install, and MCP wiring
- [Skill](${base}/skill.md): the SKILL.md a Claude Code / Codex agent should load
- [Source](https://github.com/sdan/bashroom): full code on GitHub
- [Architecture](https://github.com/sdan/bashroom/blob/master/ARCHITECTURAL.md): how v3 is built

## MCP

- [MCP endpoint](${base}/mcp): streamable HTTP transport
- Tool: \`bashroom({ command, stdin? })\` — bash in your sandbox

## Optional

- [Web reader](${base}/web): browser view of your rooms (logged in)
- [Roadmap](https://github.com/sdan/bashroom/blob/master/docs/product-roadmap.md): planned work
`;
}
