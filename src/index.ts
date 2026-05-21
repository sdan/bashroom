import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, type TransportState } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Bash, InMemoryFs, defineCommand, type ExecResult, type InitialFiles } from "just-bash/browser";
import { z } from "zod";
import { webIndexHtml } from "./web-ui";
import { webLandingHtml } from "./web-landing";
import { webDeviceHtml, webDeviceResultHtml } from "./web-device";

type Env = {
  ROOMS: DurableObjectNamespace<Room>;
  REGISTRY: DurableObjectNamespace<Registry>;
  BASHROOM_ENABLE_FULL_NETWORK?: string;
  INTRACODE_ENABLE_FULL_NETWORK?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BASHROOM_PUBLIC_URL?: string;
};

type Scope = "read" | "write" | "checkpoint" | "admin";

type WikiFile = {
  path: string;
  content: string;
  updated_at: string;
  updated_by: string;
  version: number;
};

type AuditRow = {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  path: string;
  body: string;
};

type Mount = {
  wiki: string;
  actor: string;
  scopes: Scope[];
};

type FileChange = {
  path: string;
  content?: string;
  deleted?: boolean;
};

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
const MAX_FILE_CHARS = 512_000;
const MAX_COMMAND_CHARS = 32_000;
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

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        version INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJson(request) : {};

    if (url.pathname === "/snapshot") return json({ ok: true, files: this.snapshot() });

    if (request.method === "POST" && url.pathname === "/seed") {
      const actor = sanitizeActor(String(body.actor || "system"));
      const wiki = sanitizeWiki(String(body.wiki || "wiki"));
      return json(this.seed(wiki, actor));
    }

    if (request.method === "POST" && url.pathname === "/apply") {
      const actor = sanitizeActor(String(body.actor || "actor"));
      const command = String(body.command || "");
      return json(this.apply(actor, parseChanges(body.changes), command));
    }

    if (request.method === "POST" && url.pathname === "/audit") {
      return json({ ok: true, events: this.audit(parseLimit(body.limit)) });
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      this.ctx.storage.sql.exec("DELETE FROM files");
      this.ctx.storage.sql.exec("DELETE FROM audit");
      return json({ ok: true });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  private snapshot(): WikiFile[] {
    return this.ctx.storage.sql
      .exec<WikiFile>(
        `SELECT path, content, updated_at, updated_by, version
         FROM files
         ORDER BY path ASC`,
      )
      .toArray();
  }

  private seed(wiki: string, actor: string): Record<string, unknown> {
    const now = new Date().toISOString();
    const files: Record<string, string> = {
      "README.md": `# ${wiki}\n\nThis is a Bashroom room. Agents maintain these files through durable bash.\n`,
      "AGENTS.md": `# Bashroom Room\n\nUse Markdown files as shared state. Keep index.md current. Append important chronological updates to log.md.\n`,
      "index.md": `# Index\n\n- README.md — room overview\n- log.md — chronological updates\n`,
      "log.md": `# Log\n\n## [${now.slice(0, 10)}] create | ${wiki}\n\nCreated by ${actor}.\n`,
    };

    for (const [path, content] of Object.entries(files)) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO files (path, content, updated_at, updated_by, version)
         VALUES (?, ?, ?, ?, 1)`,
        path,
        content,
        now,
        actor,
      );
    }
    this.appendAudit(actor, "seed", "", `Seeded ${wiki}.`);
    return { ok: true, wiki };
  }

  private apply(actor: string, changes: FileChange[], command: string): Record<string, unknown> {
    const now = new Date().toISOString();
    const applied: string[] = [];

    for (const change of changes) {
      const path = sanitizeFilePath(change.path);
      if (change.deleted) {
        this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
        this.appendAudit(actor, "delete", path, compact(command || path));
        applied.push(path);
        continue;
      }

      const content = cleanFileContent(change.content || "");
      this.ctx.storage.sql.exec(
        `INSERT INTO files (path, content, updated_at, updated_by, version)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           version = files.version + 1`,
        path,
        content,
        now,
        actor,
      );
      this.appendAudit(actor, "write", path, compact(command || content));
      applied.push(path);
    }

    return { ok: true, changed: applied.length, paths: applied };
  }

  private audit(limit: number): AuditRow[] {
    return this.ctx.storage.sql
      .exec<AuditRow>(
        `SELECT id, ts, actor, kind, path, body
         FROM audit
         ORDER BY id DESC
         LIMIT ?`,
        limit,
      )
      .toArray()
      .reverse();
  }

  private appendAudit(actor: string, kind: string, path: string, body: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (ts, actor, kind, path, body) VALUES (?, ?, ?, ?, ?)",
      new Date().toISOString(),
      actor,
      kind,
      path,
      body,
    );
  }
}

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

    return json({ ok: false, error: "not_found" }, 404);
  }

  // Create a room owned by the calling user. Inserts into wikis (the room
  // exists) and user_rooms (the user owns it). Returns the mount info — no
  // tokens are minted; access is via the user's account token.
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
    return { ok: true, wiki: cleanWiki, actor: cleanActor, scopes, role: "owner" };
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
  private mounts(userId: string): Mount[] {
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
    "Run bash against durable Bashroom files. Use `room help` inside bash for create, join, pair, mounts, who, and history.",
    {
      command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("Bash command to run, for example: room mounts; cat /rooms/my-room/index.md"),
      stdin: z.string().optional().describe("Optional standard input for the command."),
    },
    async ({ command, stdin }) => {
      const result = await runShell(env, headerToken, mcpSessionId, ip, command, stdin || "");
      return {
        content: [{ type: "text", text: formatShellResult(result) }],
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
      if (result.ok && typeof result.wiki === "string" && typeof result.actor === "string") {
        await seedWiki(env, result.wiki, result.actor);
      }
      return json(result, result.ok === false ? 400 : 200);
    }

    if (url.pathname === "/web" || url.pathname === "/web/") return html(webIndexHtml());

    if (url.pathname === "/web/api/rooms" && request.method === "GET") {
      // Pass ?active=ROOM to also fetch that room's snapshot in the same
      // response — saves a round-trip on initial page load.
      const account = await registry(env, "/account-rooms", { token: bearerToken(request), ip: clientIp(request) });
      const requested = sanitizeWiki(url.searchParams.get("active") || "");
      const memberRooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      const activeRoom = requested && memberRooms.some((row) => row.room === requested) ? requested : "";
      const snapshot = activeRoom ? await wikiSnapshot(env, activeRoom) : null;
      return json({ ...account, active: activeRoom || null, snapshot });
    }

    if (url.pathname === "/web/api/snapshot" && request.method === "GET") {
      const token = bearerToken(request);
      const room = sanitizeWiki(url.searchParams.get("room") || "");
      if (!room) return json({ ok: false, error: "room_required" }, 400);
      const account = await registry(env, "/account-rooms", { token, ip: clientIp(request) });
      const rooms = Array.isArray(account.rooms) ? account.rooms as Array<{ room: string }> : [];
      if (!rooms.some((row) => row.room === room)) return json({ ok: false, error: "forbidden" }, 403);
      return json({ ok: true, files: await wikiSnapshot(env, room) });
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

    if (url.pathname === "/") return html(webLandingHtml());
    if (url.pathname === "/help") return text(httpHelpText());

    return json({ ok: false, error: "not_found" }, 404);
  },
};

function publicBaseUrl(env: Env, request: Request): string {
  if (env.BASHROOM_PUBLIC_URL) return env.BASHROOM_PUBLIC_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function runShell(env: Env, headerToken: string, mcpSessionId: string, ip: string, command: string, stdin: string): Promise<ShellResult> {
  const initialMounts = await registry(env, "/mounts", { token: headerToken, ip });
  const mounts = normalizeMounts(initialMounts.mounts);
  const before = new Map<string, Map<string, string>>();
  const fs = new InMemoryFs(initialShellFiles(mounts));

  await fs.mkdir("/rooms", { recursive: true });
  await fs.mkdir("/tmp", { recursive: true });
  for (const mount of mounts) await loadMount(env, fs, mount, mounts, before);

  const addMount = async (mount: Mount): Promise<void> => {
    const existing = mounts.find((entry) => entry.wiki === mount.wiki);
    if (existing) {
      existing.actor = mount.actor;
      existing.scopes = mount.scopes;
    } else {
      mounts.push(mount);
      mounts.sort((left, right) => mountPath(left.wiki).localeCompare(mountPath(right.wiki)));
    }
    await loadMount(env, fs, mount, mounts, before);
  };

  const bash = new Bash({
    fs,
    cwd: "/",
    customCommands: [defineCommand("room", (args) => roomCommand(env, fs, mounts, before, addMount, headerToken, mcpSessionId, ip, args))],
    executionLimits: {
      maxCommandCount: 2_000,
      maxLoopIterations: 5_000,
      maxCallDepth: 50,
      maxStringLength: 2_000_000,
      maxArrayElements: 20_000,
      maxGlobOperations: 50_000,
      maxAwkIterations: 10_000,
      maxSedIterations: 10_000,
      maxJqIterations: 10_000,
      maxSubstitutionDepth: 30,
      maxHeredocSize: 1_000_000,
    },
    defenseInDepth: true,
    network: env.BASHROOM_ENABLE_FULL_NETWORK === "1" || env.INTRACODE_ENABLE_FULL_NETWORK === "1"
      ? { dangerouslyAllowFullInternetAccess: true, maxRedirects: 5, timeoutMs: 10_000, maxResponseSize: 1_000_000 }
      : undefined,
  });

  const exec = await bash.exec(command.slice(0, MAX_COMMAND_CHARS), { cwd: "/", stdin });
  const persisted = await persistMounts(env, fs, mounts, before, command);
  return {
    stdout: exec.stdout,
    stderr: [exec.stderr, persisted.stderr].filter(Boolean).join(""),
    exitCode: exec.exitCode === 0 ? persisted.exitCode : exec.exitCode,
    changed: persisted.changed,
    changed_paths: persisted.changed_paths,
  };
}

async function roomCommand(
  env: Env,
  fs: InMemoryFs,
  mounts: Mount[],
  before: Map<string, Map<string, string>>,
  addMount: (mount: Mount) => Promise<void>,
  headerToken: string,
  mcpSessionId: string,
  ip: string,
  args: string[],
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  try {
    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") return cmdOk(roomHelp());

    if (subcommand === "mounts") {
      if (!mounts.length) return cmdOk("No mounted rooms.\n\nRun: room create\nOr:  room join <invite>\n");
      return cmdOk(mounts.map((mount) => `${mountPath(mount.wiki)}\t${mount.actor}\t${mount.scopes.join(",")}`).join("\n") + "\n");
    }

    if (subcommand === "create") {
      const parsed = parseCommandFlags(rest);
      const result = await registry(env, "/create", { wiki: parsed.positionals[0] || "", actor: parsed.actor || "", token: headerToken, ip });
      if (result.ok === false) return cmdErr(String(result.error || "create_failed"));
      const mount = resultMount(result);
      await seedWiki(env, mount.wiki, mount.actor);
      await addMount(mount);
      return cmdOk(`created ${mount.wiki}\nmounted ${mountPath(mount.wiki)}\n`);
    }

    if (subcommand === "join") {
      const parsed = parseCommandFlags(rest);
      const invite = parsed.positionals[0];
      if (!invite) return cmdErr("usage: room join <invite> [--actor <actor>]\n");
      const result = await registry(env, "/join", { invite, actor: parsed.actor || "", token: headerToken, ip });
      if (result.ok === false) return cmdErr(String(result.error || "join_failed"));
      const mount = resultMount(result);
      await addMount(mount);
      return cmdOk(`joined ${mount.wiki}\nmounted ${mountPath(mount.wiki)}\n`);
    }

    if (subcommand === "pair") {
      const wiki = resolveWikiArg(rest[0], mounts);
      if (!wiki.ok) return cmdErr(wiki.error);
      const result = await registry(env, "/pair", { wiki: wiki.value, token: headerToken, ip });
      if (result.ok === false) return cmdErr(String(result.error || "pair_failed"));
      return cmdOk(`${result.invite}\ncode ${result.code}\nexpires ${result.expires_at}\n`);
    }

    if (subcommand === "who") {
      const wiki = resolveWikiArg(rest[0], mounts);
      if (!wiki.ok) return cmdErr(wiki.error);
      const result = await registry(env, "/actors", { wiki: wiki.value, token: headerToken, ip });
      if (result.ok === false) return cmdErr(String(result.error || "who_failed"));
      return cmdOk(`${(Array.isArray(result.actors) ? result.actors : []).join("\n")}\n`);
    }

    if (subcommand === "history") {
      const wiki = resolveWikiArg(rest[0], mounts);
      if (!wiki.ok) return cmdErr(wiki.error);
      const events = await wikiAudit(env, wiki.value, parseLimit(rest[1]));
      const output = events.map((event) => {
        const path = String(event.path || "");
        return `#${event.id} ${event.ts} ${event.actor} ${event.kind}${path ? ` ${path}` : ""}: ${event.body}`;
      }).join("\n");
      return cmdOk(output ? `${output}\n` : "No history.\n");
    }

    return cmdErr(`unknown room subcommand: ${subcommand}\n\n${roomHelp()}`);
  } catch (error) {
    return cmdErr(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await fs.mkdir("/rooms", { recursive: true }).catch(() => undefined);
  }
}

async function loadMount(env: Env, fs: InMemoryFs, mount: Mount, mounts: Mount[], before: Map<string, Map<string, string>>): Promise<void> {
  await fs.mkdir(mountPath(mount.wiki), { recursive: true });
  const snapshot = await wikiSnapshot(env, mount.wiki);
  for (const file of snapshot) {
    const fullPath = `${mountPath(mount.wiki)}/${file.path}`;
    await fs.writeFile(fullPath, file.content);
  }
  before.set(mount.wiki, await mountedFiles(fs, mount.wiki, mounts));
}

async function persistMounts(env: Env, fs: InMemoryFs, mounts: Mount[], before: Map<string, Map<string, string>>, command: string): Promise<Omit<ShellResult, "stdout">> {
  const changedPaths: string[] = [];
  let stderr = "";
  let exitCode = 0;

  for (const mount of mounts) {
    const previous = before.get(mount.wiki) || new Map<string, string>();
    const current = await mountedFiles(fs, mount.wiki, mounts);
    const changes = diffFiles(previous, current);
    if (!changes.length) continue;

    if (!hasScope(mount.scopes, "write")) {
      stderr += `bashroom: ${mount.wiki}: write permission denied\n`;
      exitCode = 1;
      continue;
    }

    const result = await applyWikiChanges(env, mount.wiki, mount.actor, changes, command);
    if (result.ok === false) {
      stderr += `bashroom: ${mount.wiki}: ${result.error || "persist failed"}\n`;
      exitCode = 1;
      continue;
    }
    changedPaths.push(...changes.map((change) => `${mountPath(mount.wiki)}/${change.path}`));
  }

  return { stderr, exitCode, changed: changedPaths.length, changed_paths: changedPaths };
}

async function mountedFiles(fs: InMemoryFs, wiki: string, mounts: Mount[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const prefix = `${mountPath(wiki)}/`;
  for (const fullPath of fs.getAllPaths()) {
    if (!fullPath.startsWith(prefix)) continue;
    if (ownerForPath(fullPath, mounts) !== wiki) continue;
    const stat = await fs.stat(fullPath).catch(() => undefined);
    if (!stat?.isFile) continue;
    const relativePath = sanitizeFilePath(fullPath.slice(prefix.length));
    files.set(relativePath, await fs.readFile(fullPath));
  }
  return files;
}

function diffFiles(previous: Map<string, string>, current: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of current) {
    if (previous.get(path) !== content) changes.push({ path, content });
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) changes.push({ path, deleted: true });
  }
  return changes;
}

function ownerForPath(path: string, mounts: Mount[]): string | undefined {
  let owner: string | undefined;
  let bestLength = -1;
  for (const mount of mounts) {
    const prefix = `${mountPath(mount.wiki)}/`;
    if (path.startsWith(prefix) && prefix.length > bestLength) {
      owner = mount.wiki;
      bestLength = prefix.length;
    }
  }
  return owner;
}

function initialShellFiles(mounts: Mount[]): InitialFiles {
  const mountList = mounts.length
    ? mounts.map((mount) => `- ${mountPath(mount.wiki)} (${mount.actor})`).join("\n")
    : "No mounted rooms yet.";
  return {
    "/README.md": `# Bashroom Shell\n\nDurable bash rooms for coding agents.\n\n${mountList}\n\nRun room help.\n`,
  };
}

function normalizeMounts(value: unknown): Mount[] {
  if (!Array.isArray(value)) return [];
  const mounts: Mount[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const wiki = typeof record.wiki === "string" ? sanitizeWiki(record.wiki) : "";
    const actor = typeof record.actor === "string" ? sanitizeActor(record.actor) : "actor";
    const scopes = parseScopes(record.scopes, ["read"]);
    if (wiki) mounts.push({ wiki, actor, scopes });
  }
  return mounts;
}

function resultMount(result: Record<string, unknown>): Mount {
  return {
    wiki: sanitizeWiki(String(result.wiki || "")),
    actor: sanitizeActor(String(result.actor || "actor")),
    scopes: parseScopes(result.scopes, ["read"]),
  };
}

function resolveWikiArg(value: string | undefined, mounts: Mount[]): { ok: true; value: string } | { ok: false; error: string } {
  if (value) return { ok: true, value: wikiFromPathOrName(value) };
  if (mounts.length === 1) return { ok: true, value: mounts[0].wiki };
  return { ok: false, error: "usage: pass a room name or mount path\n" };
}

function wikiFromPathOrName(value: string): string {
  const clean = value.startsWith("/rooms/") ? value.slice("/rooms/".length) : value;
  return sanitizeWiki(clean);
}

function parseCommandFlags(args: string[]): { actor?: string; positionals: string[] } {
  const positionals = [...args];
  let actor: string | undefined;
  for (let index = 0; index < positionals.length; index += 1) {
    if (positionals[index] === "--actor") {
      actor = sanitizeActor(positionals[index + 1] || "");
      positionals.splice(index, 2);
      index -= 1;
    }
  }
  return { actor, positionals };
}

async function wikiSnapshot(env: Env, wiki: string): Promise<WikiFile[]> {
  const result = await roomControl(env, wiki, "/snapshot");
  return Array.isArray(result.files) ? result.files.filter(isWikiFile) : [];
}

async function seedWiki(env: Env, wiki: string, actor: string): Promise<void> {
  await roomControl(env, wiki, "/seed", { wiki, actor });
}

async function applyWikiChanges(env: Env, wiki: string, actor: string, changes: FileChange[], command: string): Promise<Record<string, unknown>> {
  return roomControl(env, wiki, "/apply", { actor, changes, command });
}

async function wikiAudit(env: Env, wiki: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const result = await roomControl(env, wiki, "/audit", { limit });
  return Array.isArray(result.events) ? result.events as Array<Record<string, unknown>> : [];
}

async function roomControl(env: Env, wiki: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = env.ROOMS.idFromName(sanitizeWiki(wiki));
  const stub = env.ROOMS.get(id);
  const response = await stub.fetch(`https://wiki.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return response.json();
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

function parseChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      path: String(record.path || ""),
      content: typeof record.content === "string" ? record.content : undefined,
      deleted: record.deleted === true,
    };
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isWikiFile(value: unknown): value is WikiFile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.content === "string";
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

function cleanFileContent(value: string): string {
  return value.slice(0, MAX_FILE_CHARS);
}

function sanitizeWiki(wiki: string): string {
  const value = wiki.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(value)) throw new Error("invalid room");
  if (value.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("invalid room");
  return value;
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

function cmdOk(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function cmdErr(stderr: string): ExecResult {
  return { stdout: "", stderr, exitCode: 1 };
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

function roomHelp(): string {
  return `Bashroom commands

room create [room] [--actor <actor>]
room join <invite> [--actor <actor>]
room pair [room]
room mounts
room who [room]
room history [room] [limit]

Room files are mounted at /rooms/<room>. Use normal bash to read and write Markdown files.
`;
}

function httpHelpText(): string {
  return `# Bashroom

Durable bash rooms for coding agents.

MCP endpoint:

\`\`\`bash
claude mcp add --scope user --transport http bashroom https://bashroom.sdan.io/mcp
codex mcp add bashroom --url https://bashroom.sdan.io/mcp
\`\`\`

The MCP exposes one tool: \`bashroom\`.
`;
}
