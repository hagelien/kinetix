import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  agents,
  agentTokens,
  userGroupMembers,
  userGroups,
  users,
} from "../../db/schema.js";

// Use a __Host- cookie so sibling subdomains cannot shadow or inject the
// session cookie with a broader Domain attribute.
const COOKIE_NAME = "__Host-kinetix-auth";
const PREVIOUS_COOKIE_NAME = "kinetix-auth";
const LEGACY_COOKIE_NAME = "fjelltox-auth";
/** Default token lifetime when the caller does not supply one (30 days). */
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Marker prefix for persistent agent API tokens (see `agent_tokens`).
 * Tokens that start with this are opaque, DB-backed credentials rather
 * than JWTs — `getUserFromRequest` routes them to a hash lookup.
 */
export const AGENT_TOKEN_PREFIX = "kxat_";

/** SHA-256 hex of an agent token; the only form persisted at rest. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a fresh agent token. The plaintext is returned to the caller for
 * one-time display; only `hash` is ever stored. `prefix` is a short,
 * non-secret fingerprint for the admin listing.
 */
export function generateAgentToken(): {
  token: string;
  hash: string;
  prefix: string;
} {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    hash: hashAgentToken(token),
    prefix: `${token.slice(0, 12)}…`,
  };
}

export interface AuthGroup {
  id: number;
  slug: string;
  name: string;
  grants?: string[];
}

export interface AuthContext {
  userId: number;
  role: string;
  groups?: AuthGroup[];
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signToken(
  userId: number,
  role: string,
  expiresInSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): Promise<string> {
  return new SignJWT({ sub: String(userId), role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(getSecret());
}

export async function verifyToken(
  token: string,
): Promise<{ userId: number; role: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const userId = Number(payload.sub);
    const role = payload.role as string;
    if (isNaN(userId) || !role) return null;
    return { userId, role };
  } catch {
    return null;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function resolveAuthToken(req: IncomingMessage): { token: string } | null {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return { token };
}

/**
 * Cheap check for whether the request carries *any* session cookie, without
 * verifying it. Used to decide whether a public-cacheable GET should still be
 * served from the shared CDN cache: a logged-in user (editor/admin) must see
 * fresh content immediately after a direct save, otherwise the edge serves the
 * stale pre-edit copy for the s-maxage/stale-while-revalidate window and the
 * change appears not to have taken. Anonymous requests (no cookie) keep the
 * CDN benefit. Intentionally does not run the JWT verify — presence is enough
 * to opt out of shared caching, and a forged cookie only costs that request a
 * cache miss.
 */
export function requestHasAuthCookie(req: IncomingMessage): boolean {
  const cookies = parseCookies(req);
  return Boolean(
    cookies[COOKIE_NAME] ||
      cookies[PREVIOUS_COOKIE_NAME] ||
      cookies[LEGACY_COOKIE_NAME],
  );
}

function buildCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Secure`;
}

/**
 * Resolve the authenticated user from the request cookie. In addition to
 * verifying the JWT signature, this also enforces a per-user re-auth window:
 * if `users.lastAuthAt` is older than `users.sessionMaxDays` days, the
 * session is considered expired and null is returned.
 */
export async function getUserFromRequest(
  req: IncomingMessage,
): Promise<AuthContext | null> {
  const authToken = resolveAuthToken(req);
  if (!authToken) return null;

  // Persistent agent tokens are opaque, DB-backed credentials — resolve
  // them by hash rather than verifying a JWT signature.
  if (authToken.token.startsWith(AGENT_TOKEN_PREFIX)) {
    return resolveAgentTokenContext(authToken.token);
  }

  const verified = await verifyToken(authToken.token);
  if (!verified) return null;

  const db = getDb();

  // All three queries key on verified.userId. Use db.batch() so all three
  // are sent to Neon in a single HTTP round trip instead of three parallel
  // round trips — equivalent result, one fewer network exchange.
  const [[row], groups, [agentRow]] = await db.batch([
    db
      .select({
        id: users.id,
        role: users.role,
        lastAuthAt: users.lastAuthAt,
        sessionMaxDays: users.sessionMaxDays,
      })
      .from(users)
      .where(eq(users.id, verified.userId))
      .limit(1),
    db
      .select({
        id: userGroups.id,
        slug: userGroups.slug,
        name: userGroups.name,
        grants: userGroups.grants,
      })
      .from(userGroupMembers)
      .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.groupId))
      .where(eq(userGroupMembers.userId, verified.userId)),
    db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, verified.userId))
      .limit(1),
  ] as const);

  if (!row) return null;

  // Agent-backed users must authenticate with a revocable `kxat_` token, not
  // a bare JWT. Reject the JWT path for any user that backs an `agents` row so
  // a leaked or forged session for a service account can't sidestep per-token
  // revocation — a JWT can only be killed by rotating the global JWT_SECRET.
  if (agentRow) return null;

  // Fail closed: if lastAuthAt is not recorded the session has no tracked
  // authentication timestamp and cannot be age-checked — reject it so the
  // user must re-authenticate and establish a fresh, trackable session.
  if (!row.lastAuthAt) return null;
  const maxMs = row.sessionMaxDays * 24 * 60 * 60 * 1000;
  const age = Date.now() - row.lastAuthAt.getTime();
  if (age > maxMs) return null;

  // Always trust the latest role and group membership from the DB and fail
  // closed if the lookup cannot complete, rather than authorizing from stale
  // JWT claims.
  return { userId: row.id, role: row.role, groups };
}

/**
 * Resolve a persistent agent token to its backing user. Like the JWT
 * path, the live `users.role` is read from the DB (never trusted from
 * the token), so suspending an agent immediately neuters its tokens
 * even before they are explicitly revoked. Rejects revoked or expired
 * tokens; `last_used_at` is touched best-effort and never blocks auth.
 */
async function resolveAgentTokenContext(
  token: string,
): Promise<AuthContext | null> {
  const db = getDb();
  const [row] = await db
    .select({
      tokenId: agentTokens.id,
      expiresAt: agentTokens.expiresAt,
      revokedAt: agentTokens.revokedAt,
      agentStatus: agents.status,
      userId: users.id,
      role: users.role,
    })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agentTokens.tokenHash, hashAgentToken(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.agentStatus !== "active") return null;

  // Update last_used_at and fetch group membership in parallel. The update
  // is advisory and must never block auth; swallow its errors independently.
  const [groups] = await Promise.all([
    db
      .select({
        id: userGroups.id,
        slug: userGroups.slug,
        name: userGroups.name,
        grants: userGroups.grants,
      })
      .from(userGroupMembers)
      .innerJoin(userGroups, eq(userGroups.id, userGroupMembers.groupId))
      .where(eq(userGroupMembers.userId, row.userId)),
    db
      .update(agentTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentTokens.id, row.tokenId))
      .catch(() => {}),
  ]);

  // Agent tokens must never become admin credentials. Admin-only actions stay
  // reserved for human sessions even if an agent backing user is misconfigured.
  const role = row.role === "admin" ? "editor" : row.role;
  return { userId: row.userId, role, groups };
}

export function setAuthCookie(
  res: ServerResponse,
  token: string,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): void {
  res.setHeader("Set-Cookie", [
    buildCookie(COOKIE_NAME, token, maxAgeSeconds),
    buildCookie(PREVIOUS_COOKIE_NAME, "", 0),
    buildCookie(LEGACY_COOKIE_NAME, "", 0),
  ]);
}

export function clearAuthCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", [
    buildCookie(COOKIE_NAME, "", 0),
    buildCookie(PREVIOUS_COOKIE_NAME, "", 0),
    buildCookie(LEGACY_COOKIE_NAME, "", 0),
  ]);
}
