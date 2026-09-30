-- Persistent, revocable API tokens for agents.
--
-- Replaces the prior "mint a JWT out of band via scripts/kinetix-agent-jwt.ts"
-- posture with admin-issued tokens that can be revoked individually without
-- rotating the global JWT_SECRET. Only the SHA-256 hash of the secret is
-- stored; the plaintext `kxat_<base64url>` is shown to the issuing admin
-- exactly once. getUserFromRequest (api/_lib/auth.ts) resolves a presented
-- token by hashing it and matching `token_hash`, rejecting rows that are
-- revoked (`revoked_at` set) or past `expires_at`.

CREATE TABLE "agent_tokens" (
  "id" SERIAL PRIMARY KEY,
  "agent_id" INTEGER NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "token_hash" VARCHAR(64) NOT NULL UNIQUE,
  "prefix" VARCHAR(20) NOT NULL,
  "label" VARCHAR(100),
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMP NOT NULL,
  "last_used_at" TIMESTAMP,
  "revoked_at" TIMESTAMP,
  "revoked_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint

CREATE INDEX "agent_tokens_agent_id_idx" ON "agent_tokens" USING btree ("agent_id");
