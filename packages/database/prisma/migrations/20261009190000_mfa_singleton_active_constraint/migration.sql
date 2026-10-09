-- At most one ACTIVE method per (user, type) for the singleton method types.
--
-- TOTP and backup codes are singletons: the enrollment flow assumes one
-- active TOTP secret per user (two would make VerifyTotpChallenge's outcome
-- depend on which row a findById happened to return), and backup-code
-- regeneration deletes existing backup_codes methods before persisting the
-- replacement. WebAuthn is deliberately excluded: users may enroll multiple
-- passkeys (only the credential id itself is unique).
--
-- Partial, not a full @@unique: pending rows must coexist with an active row
-- during the enroll-then-confirm lifecycle (re-enrollment creates a second
-- pending TOTP method next to the still-active old one; confirming it swaps
-- them), and disabled rows must coexist so re-enrollment after a disable
-- keeps working.
--
-- Prisma cannot express partial indexes in the schema, so this lives in SQL
-- and is documented on the MfaMethod model in schema.prisma.
--
-- NOTE on the type predicate: the MfaMethodType value `backup_codes` is
-- stored as 'backup-codes' in the database (see @map in schema.prisma).
CREATE UNIQUE INDEX "mfa_methods_one_active_singleton_per_user"
  ON "mfa_methods" ("user_id", "type")
  WHERE "status" = 'active' AND "type" IN ('totp', 'backup-codes');
