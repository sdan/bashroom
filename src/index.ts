import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, type TransportState } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Bash, InMemoryFs, defineCommand, type ExecResult, type InitialFiles } from "just-bash/browser";
import { z } from "zod";

type Env = {
  ROOMS: DurableObjectNamespace<Room>;
  REGISTRY: DurableObjectNamespace<Registry>;
  BASHROOM_ENABLE_FULL_NETWORK?: string;
  INTRACODE_ENABLE_FULL_NETWORK?: string;
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS wiki_tokens (
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
      CREATE TABLE IF NOT EXISTS wiki_session_tokens (
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
      CREATE TABLE IF NOT EXISTS credit_buckets (
        key TEXT PRIMARY KEY,
        credits REAL NOT NULL,
        updated_at INTEGER NOT NULL
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

    if (request.method === "POST" && url.pathname === "/create") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`create:ip:${ip}`, CREATE_IP_CAPACITY, CREATE_IP_REFILL) || this.checkBucket("create:global", CREATE_GLOBAL_CAPACITY, CREATE_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.createWiki(String(body.wiki || ""), String(body.actor || defaultActor("actor")), bearerFromUnknown(body.mcpSessionId)));
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const ip = String(body.ip || "unknown");
      const limited = this.checkBucket(`join:ip:${ip}`, JOIN_IP_CAPACITY, JOIN_IP_REFILL) || this.checkBucket("join:global", JOIN_GLOBAL_CAPACITY, JOIN_GLOBAL_REFILL);
      if (limited) return json(limited, 429);
      return json(await this.join(String(body.invite || body.code || ""), String(body.actor || defaultActor("actor")), bearerFromUnknown(body.mcpSessionId)));
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(await this.createPairCode(wiki, parseScopes(body.scopes, ["read", "write", "checkpoint"])));
    }

    if (request.method === "POST" && url.pathname === "/mounts") {
      return json({ ok: true, mounts: await this.mounts(bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), String(body.ip || "unknown")) });
    }

    if (request.method === "POST" && url.pathname === "/actors") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "read", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json({ ok: true, actors: this.actors(wiki) });
    }

    if (request.method === "POST" && url.pathname === "/delete") {
      const wiki = String(body.wiki || body.room || "");
      const auth = await this.authorize(wiki, bearerFromUnknown(body.token), bearerFromUnknown(body.mcpSessionId), "admin", String(body.ip || "unknown"));
      if (!auth.ok) return json(auth, 401);
      return json(this.deleteWiki(wiki));
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  private async createWiki(wiki: string, actor: string, mcpSessionId = ""): Promise<Record<string, unknown>> {
    const cleanWiki = wiki.trim() ? sanitizeWiki(wiki) : this.generateWikiSlug();
    const cleanActor = sanitizeActor(actor);
    const existing = this.ctx.storage.sql.exec("SELECT room FROM wikis WHERE room = ?", cleanWiki).toArray()[0];
    if (existing) return { ok: false, error: "room_exists" };

    const now = new Date().toISOString();
    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");
    const scopes: Scope[] = ["read", "write", "checkpoint", "admin"];

    this.ctx.storage.sql.exec("INSERT INTO wikis (room, created_at) VALUES (?, ?)", cleanWiki, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO wiki_tokens (token_hash, token_id, room, actor, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      cleanWiki,
      cleanActor,
      scopes.join(","),
      now,
    );
    await this.rememberSessionToken(mcpSessionId, cleanWiki, tokenHash, now);

    return { ok: true, wiki: cleanWiki, token, actor: cleanActor, scopes };
  }

  private async join(invite: string, actor: string, mcpSessionId = ""): Promise<Record<string, unknown>> {
    const cleanCode = normalizePairCode(invite);
    const cleanActor = sanitizeActor(actor);
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
    const token = randomToken();
    const tokenHash = await sha256(token);
    const tokenId = randomId("tok");

    this.ctx.storage.sql.exec("UPDATE wiki_pair_codes SET used_at = ? WHERE code_hash = ?", now, codeHash);
    this.ctx.storage.sql.exec(
      `INSERT INTO wiki_tokens (token_hash, token_id, room, actor, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      tokenId,
      row.room,
      cleanActor,
      row.scopes,
      now,
    );
    await this.rememberSessionToken(mcpSessionId, row.room, tokenHash, now);

    return { ok: true, wiki: row.room, token, actor: cleanActor, scopes: row.scopes.split(",") };
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

  private async mounts(token: string, mcpSessionId: string, ip: string): Promise<Mount[]> {
    const byWiki = new Map<string, Mount>();

    if (token) {
      const tokenHash = await sha256(token);
      const row = this.ctx.storage.sql
        .exec<{ room: string }>("SELECT room FROM wiki_tokens WHERE token_hash = ? AND revoked_at IS NULL", tokenHash)
        .toArray()[0];
      if (row) {
        const auth = this.verifyTokenHash(row.room, tokenHash, "read", ip);
        if (auth.ok && auth.wiki && auth.actor && auth.scopes) byWiki.set(auth.wiki, { wiki: auth.wiki, actor: auth.actor, scopes: auth.scopes });
      }
    }

    if (mcpSessionId) {
      const rows = this.ctx.storage.sql
        .exec<{ room: string; token_hash: string }>(
          `SELECT st.room, st.token_hash
           FROM wiki_session_tokens st
           JOIN wiki_tokens t ON t.token_hash = st.token_hash
           WHERE st.session_hash = ? AND t.revoked_at IS NULL
           ORDER BY st.room ASC`,
          await sha256(mcpSessionId),
        )
        .toArray();

      for (const row of rows) {
        const auth = this.verifyTokenHash(row.room, row.token_hash, "read", ip);
        if (auth.ok && auth.wiki && auth.actor && auth.scopes) byWiki.set(auth.wiki, { wiki: auth.wiki, actor: auth.actor, scopes: auth.scopes });
      }
    }

    return [...byWiki.values()].sort((left, right) => mountPath(left.wiki).localeCompare(mountPath(right.wiki)));
  }

  private async authorize(wiki: string, token: string, mcpSessionId: string, scope: Scope, ip: string): Promise<AuthResult> {
    if (token) return this.verify(sanitizeWiki(wiki), token, scope, ip);
    if (mcpSessionId) return this.verifySession(sanitizeWiki(wiki), mcpSessionId, scope, ip);
    return { ok: false, error: "missing_token" };
  }

  private async verify(wiki: string, token: string, scope: Scope, ip: string): Promise<AuthResult> {
    if (!token) return { ok: false, error: "missing_token" };
    return this.verifyTokenHash(wiki, await sha256(token), scope, ip);
  }

  private async verifySession(wiki: string, mcpSessionId: string, scope: Scope, ip: string): Promise<AuthResult> {
    const row = this.ctx.storage.sql
      .exec<{ token_hash: string }>(
        `SELECT token_hash
         FROM wiki_session_tokens
         WHERE session_hash = ? AND room = ?`,
        await sha256(mcpSessionId),
        wiki,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: "missing_session_token" };
    return this.verifyTokenHash(wiki, row.token_hash, scope, ip);
  }

  private verifyTokenHash(wiki: string, tokenHash: string, scope: Scope, ip: string): AuthResult {
    const ipLimited = this.checkBucket(`verify:ip:${ip}`, VERIFY_IP_CAPACITY, VERIFY_IP_REFILL);
    if (ipLimited) return ipLimited;

    const globalLimited = this.checkBucket("ops:global", GLOBAL_OPS_CAPACITY, GLOBAL_OPS_REFILL);
    if (globalLimited) return globalLimited;

    const tokenLimited = this.checkBucket(`ops:token:${tokenHash}`, OPS_TOKEN_CAPACITY, OPS_TOKEN_REFILL);
    if (tokenLimited) return tokenLimited;

    if (scope === "write" || scope === "checkpoint") {
      const writeLimited = this.checkBucket(`write:token:${tokenHash}`, WRITE_TOKEN_CAPACITY, WRITE_TOKEN_REFILL);
      if (writeLimited) return writeLimited;
    }

    const row = this.ctx.storage.sql
      .exec<{ token_id: string; room: string; actor: string; scopes: string; last_seen_at: string | null; revoked_at: string | null }>(
        `SELECT token_id, room, actor, scopes, last_seen_at, revoked_at
         FROM wiki_tokens
         WHERE token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];

    if (!row || row.revoked_at) return { ok: false, error: "invalid_token" };
    if (row.room !== wiki) return { ok: false, error: "wrong_room" };

    const scopes = row.scopes.split(",") as Scope[];
    if (!hasScope(scopes, scope)) return { ok: false, error: "insufficient_scope" };

    const now = Date.now();
    if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec("UPDATE wiki_tokens SET last_seen_at = ? WHERE token_hash = ?", new Date(now).toISOString(), tokenHash);
    }

    return { ok: true, wiki: row.room, actor: row.actor, scopes, tokenId: row.token_id };
  }

  private async rememberSessionToken(mcpSessionId: string, wiki: string, tokenHash: string, createdAt: string): Promise<void> {
    if (!mcpSessionId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO wiki_session_tokens (session_hash, room, token_hash, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_hash, room) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_at = excluded.created_at`,
      await sha256(mcpSessionId),
      wiki,
      tokenHash,
      createdAt,
    );
  }

  private actors(wiki: string): string[] {
    const cleanWiki = sanitizeWiki(wiki);
    return this.ctx.storage.sql
      .exec<{ actor: string }>(
        `SELECT actor
         FROM wiki_tokens
         WHERE room = ? AND revoked_at IS NULL
         GROUP BY actor
         ORDER BY MIN(created_at) ASC`,
        cleanWiki,
      )
      .toArray()
      .map((row) => row.actor);
  }

  private deleteWiki(wiki: string): Record<string, unknown> {
    const cleanWiki = sanitizeWiki(wiki);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("DELETE FROM wikis WHERE room = ?", cleanWiki);
    this.ctx.storage.sql.exec("UPDATE wiki_tokens SET revoked_at = ? WHERE room = ? AND revoked_at IS NULL", now, cleanWiki);
    this.ctx.storage.sql.exec("UPDATE wiki_pair_codes SET used_at = ? WHERE room = ? AND used_at IS NULL", now, cleanWiki);
    this.ctx.storage.sql.exec("DELETE FROM wiki_session_tokens WHERE room = ?", cleanWiki);
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

    if (url.pathname === "/" || url.pathname === "/help") return text(httpHelpText());

    return json({ ok: false, error: "not_found" }, 404);
  },
};

async function runShell(env: Env, headerToken: string, mcpSessionId: string, ip: string, command: string, stdin: string): Promise<ShellResult> {
  const initialMounts = await registry(env, "/mounts", { token: headerToken, mcpSessionId, ip });
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
      const result = await registry(env, "/create", { wiki: parsed.positionals[0] || "", actor: parsed.actor || defaultActor("mcp"), mcpSessionId, ip });
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
      const result = await registry(env, "/join", { invite, actor: parsed.actor || defaultActor("mcp"), mcpSessionId, ip });
      if (result.ok === false) return cmdErr(String(result.error || "join_failed"));
      const mount = resultMount(result);
      await addMount(mount);
      return cmdOk(`joined ${mount.wiki}\nmounted ${mountPath(mount.wiki)}\n`);
    }

    if (subcommand === "pair") {
      const wiki = resolveWikiArg(rest[0], mounts);
      if (!wiki.ok) return cmdErr(wiki.error);
      const result = await registry(env, "/pair", { wiki: wiki.value, token: headerToken, mcpSessionId, ip });
      if (result.ok === false) return cmdErr(String(result.error || "pair_failed"));
      return cmdOk(`${result.invite}\ncode ${result.code}\nexpires ${result.expires_at}\n`);
    }

    if (subcommand === "who") {
      const wiki = resolveWikiArg(rest[0], mounts);
      if (!wiki.ok) return cmdErr(wiki.error);
      const result = await registry(env, "/actors", { wiki: wiki.value, token: headerToken, mcpSessionId, ip });
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

function randomId(prefix: string): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

function randomPairCode(): string {
  return `${randomSuffix(4).toUpperCase()}-${randomSuffix(4).toUpperCase()}`;
}

function inviteUri(wiki: string, code: string): string {
  return `bashroom://join/${encodeURIComponent(wiki)}?code=${encodeURIComponent(code)}`;
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
claude mcp add --scope user --transport http bashroom https://intracode.sdan.io/mcp
codex mcp add bashroom --url https://intracode.sdan.io/mcp
\`\`\`

The MCP exposes one tool: \`bashroom\`.
`;
}
