import { DurableObject } from "cloudflare:workers";

export type ShareRole = "view" | "comment" | "edit";

export type DocumentComment = {
  id: string;
  author_user_id: string;
  author: string;
  anchor_start: number;
  anchor_end: number;
  quote: string;
  body: string;
  document_etag: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolved_by: string | null;
};

export type AddDocumentCommentInput = {
  authorUserId: string;
  author: string;
  anchorStart: number;
  anchorEnd: number;
  quote: string;
  body: string;
  documentEtag: string;
};

export type ResolveDocumentCommentInput = {
  id: string;
  actorUserId: string;
  actor: string;
  canResolveAny: boolean;
};

const MAX_COMMENT_CHARS = 8_000;
const MAX_QUOTE_CHARS = 2_000;
const MAX_DOCUMENT_OFFSET = 10_000_000;
const MAX_COMMENTS_PER_DOCUMENT = 500;

// One instance per canonical R2 document. Different View / Comment / Edit
// links for the same file therefore converge on one comment thread without
// turning the global share registry into a collaboration bottleneck.
type DocumentCollabEnv = Record<string, never>;

export class DocumentCollab extends DurableObject<DocumentCollabEnv> {
  constructor(ctx: DurableObjectState, env: DocumentCollabEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          author_user_id TEXT NOT NULL,
          author TEXT NOT NULL,
          anchor_start INTEGER NOT NULL,
          anchor_end INTEGER NOT NULL,
          quote TEXT NOT NULL,
          body TEXT NOT NULL,
          document_etag TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          resolved_by_user_id TEXT,
          resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS comments_created_idx ON comments(created_at, id);
      `);
    });
  }

  async listComments(): Promise<DocumentComment[]> {
    return this.ctx.storage.sql
      .exec<DocumentComment>(
        `SELECT id, author_user_id, author, anchor_start, anchor_end, quote,
                body, document_etag, created_at, resolved_at,
                resolved_by_user_id, resolved_by
           FROM comments
          ORDER BY created_at, id`,
      )
      .toArray();
  }

  async addComment(input: AddDocumentCommentInput): Promise<{ ok: true; comment: DocumentComment } | { ok: false; error: string }> {
    const authorUserId = cleanIdentity(input.authorUserId);
    const author = cleanIdentity(input.author);
    const body = input.body.trim();
    const quote = input.quote.trim();
    const anchorStart = Number(input.anchorStart);
    const anchorEnd = Number(input.anchorEnd);

    if (!authorUserId || !author) return { ok: false, error: "identity_required" };
    if (!body || body.length > MAX_COMMENT_CHARS) return { ok: false, error: "invalid_comment" };
    if (!quote || quote.length > MAX_QUOTE_CHARS) return { ok: false, error: "invalid_quote" };
    if (!Number.isSafeInteger(anchorStart) || !Number.isSafeInteger(anchorEnd)
      || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > MAX_DOCUMENT_OFFSET) {
      return { ok: false, error: "invalid_anchor" };
    }
    const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM comments").one().count;
    if (count >= MAX_COMMENTS_PER_DOCUMENT) return { ok: false, error: "comment_limit" };

    const comment: DocumentComment = {
      id: crypto.randomUUID(),
      author_user_id: authorUserId,
      author,
      anchor_start: anchorStart,
      anchor_end: anchorEnd,
      quote,
      body,
      document_etag: String(input.documentEtag || "").slice(0, 128),
      created_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_by: null,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO comments (
         id, author_user_id, author, anchor_start, anchor_end, quote, body,
         document_etag, created_at, resolved_at, resolved_by_user_id, resolved_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      comment.id,
      comment.author_user_id,
      comment.author,
      comment.anchor_start,
      comment.anchor_end,
      comment.quote,
      comment.body,
      comment.document_etag,
      comment.created_at,
    );
    return { ok: true, comment };
  }

  async resolveComment(input: ResolveDocumentCommentInput): Promise<{ ok: true; comment: DocumentComment } | { ok: false; error: string }> {
    const id = String(input.id || "");
    const actorUserId = cleanIdentity(input.actorUserId);
    const actor = cleanIdentity(input.actor);
    const current = this.ctx.storage.sql
      .exec<DocumentComment>(
        `SELECT id, author_user_id, author, anchor_start, anchor_end, quote,
                body, document_etag, created_at, resolved_at,
                resolved_by_user_id, resolved_by
           FROM comments WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!current) return { ok: false, error: "not_found" };
    if (!input.canResolveAny && current.author_user_id !== actorUserId) {
      return { ok: false, error: "forbidden" };
    }
    if (!current.resolved_at) {
      const resolvedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "UPDATE comments SET resolved_at = ?, resolved_by_user_id = ?, resolved_by = ? WHERE id = ?",
        resolvedAt,
        actorUserId,
        actor,
        id,
      );
      current.resolved_at = resolvedAt;
      current.resolved_by_user_id = actorUserId;
      current.resolved_by = actor;
    }
    return { ok: true, comment: current };
  }
}

export function parseShareRole(value: unknown): ShareRole | null {
  return value === "view" || value === "comment" || value === "edit" ? value : null;
}

function cleanIdentity(value: string): string {
  return String(value || "").trim().replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 120);
}
