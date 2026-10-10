-- WebAuthn credential storage (Issue 099). Fields are exactly what
-- docs/security/mfa-design.md says is persisted: credentialId, publicKey,
-- signCounter, transports, attestationType — plus the relational keys the
-- mapper already reads/writes (user_id, mfa_method_id, created_at,
-- last_used_at).
CREATE TABLE "webauthn_credentials" (
    "id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "mfa_method_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "sign_counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attestation_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_mfa_method_id_key" ON "webauthn_credentials"("mfa_method_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_mfa_method_id_fkey" FOREIGN KEY ("mfa_method_id") REFERENCES "mfa_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
