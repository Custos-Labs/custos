-- Session lifecycle and rotating refresh tokens (Phase 05, Issue 096).
--
-- Two tables, matching the `Session`/`RefreshToken` split in
-- packages/sessions/domain/entities: a session carries no token material of
-- its own, so it can be read (Issue 095's "manage your devices" view)
-- without any risk of exposing something replayable. See
-- docs/security/token-storage.md.

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    "ip_address" TEXT,
    "user_agent" TEXT,

    -- NULL means still active.
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,

    -- Hex-encoded SHA-256 of the raw refresh token. The raw value is never
    -- stored, so a leaked table yields nothing usable.
    "token_hash" TEXT NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    -- When this token was consumed by a rotation. NULL means still current.
    -- Kept (not deleted) once set: an already-used token being presented
    -- again is the reuse-detection signal `RefreshAccessToken` depends on.
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- Lookup is always by token hash (`findRefreshTokenByHash`); unique so a
-- digest collision or replayed insert is a constraint violation rather than
-- two rows that would both redeem, matching every other bearer-token table.
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" ("token_hash");

-- "This user's active sessions" (ListActiveSessions, LogoutEverywhere).
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
-- The expiry sweep, same shape as the token tables in earlier migrations.
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");

CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens" ("session_id");
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");

-- CASCADE on both: a session cannot outlive its user, and a refresh token
-- cannot outlive the session it rotates within.
ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
