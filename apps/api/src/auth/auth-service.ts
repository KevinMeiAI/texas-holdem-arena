import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { Pool } from "pg";

const SESSION_TTL_DAYS = 7;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export interface AdminSession {
  adminUserId: string;
  email: string;
  expiresAt: string;
}

export class AuthService {
  constructor(private readonly pool: Pool) {}

  async bootstrap(email: string, password: string | undefined): Promise<void> {
    const existing = await this.pool.query<{ count: string }>("select count(*)::text as count from admin_users");
    if (Number(existing.rows[0]?.count) > 0) return;
    if (!password || password.length < 10) {
      throw new Error("ARENA_ADMIN_PASSWORD must contain at least 10 characters for first startup");
    }
    await this.pool.query(
      "insert into admin_users (id, email, password_hash) values ($1, $2, $3)",
      [randomUUID(), email.toLowerCase(), await argon2.hash(password, { type: argon2.argon2id })],
    );
  }

  async login(email: string, password: string): Promise<{
    sessionToken: string;
    csrfToken: string;
    session: AdminSession;
  } | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string;
    }>("select id, email, password_hash from admin_users where email = $1", [email.toLowerCase()]);
    const admin = result.rows[0];
    if (!admin || !(await argon2.verify(admin.password_hash, password))) return null;
    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
    await this.pool.query(
      `insert into sessions (token_hash, admin_user_id, csrf_token_hash, expires_at)
       values ($1, $2, $3, $4)`,
      [sha256(sessionToken), admin.id, sha256(csrfToken), expiresAt],
    );
    return {
      sessionToken,
      csrfToken,
      session: { adminUserId: admin.id, email: admin.email, expiresAt: expiresAt.toISOString() },
    };
  }

  async session(sessionToken: string | undefined): Promise<AdminSession | null> {
    if (!sessionToken) return null;
    const result = await this.pool.query<{
      admin_user_id: string;
      email: string;
      expires_at: Date;
    }>(
      `update sessions s set last_used_at = now()
       from admin_users a
       where s.token_hash = $1 and s.expires_at > now() and a.id = s.admin_user_id
       returning s.admin_user_id, a.email, s.expires_at`,
      [sha256(sessionToken)],
    );
    const row = result.rows[0];
    return row ? {
      adminUserId: row.admin_user_id,
      email: row.email,
      expiresAt: row.expires_at.toISOString(),
    } : null;
  }

  async verifyCsrf(sessionToken: string | undefined, csrfToken: string | undefined): Promise<boolean> {
    if (!sessionToken || !csrfToken) return false;
    const result = await this.pool.query<{ csrf_token_hash: string }>(
      "select csrf_token_hash from sessions where token_hash = $1 and expires_at > now()",
      [sha256(sessionToken)],
    );
    const stored = result.rows[0]?.csrf_token_hash;
    return stored ? safeHashEqual(stored, sha256(csrfToken)) : false;
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.pool.query("delete from sessions where token_hash = $1", [sha256(sessionToken)]);
  }
}
