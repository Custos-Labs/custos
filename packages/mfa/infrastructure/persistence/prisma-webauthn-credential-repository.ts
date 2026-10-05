/**
 * NOT BUILT. Excluded from this package's `tsconfig.json` and
 * `eslint.config.mjs`.
 *
 * There is no `webauthn_credentials` table. `packages/database/prisma/schema.prisma`
 * has no `WebAuthnCredential` model and no migration ever created one --
 * `mfa_method_type`'s enum has a `webauthn` value, and nothing else. This file
 * was written against a table that was never migrated, which is also why it
 * is not part of this package's public surface (`index.ts` exports the port
 * and an in-memory fake, never this class).
 *
 * It is left in place, excluded rather than deleted, because the adapter
 * logic itself is a reasonable starting point once the migration exists --
 * see `docs/QUARANTINE.md` for the project's convention on this: don't
 * silently discard a contributor's work, state why it can't build yet.
 *
 * To bring this back: add the `WebAuthnCredential` model and a migration for
 * it, fix the two method signatures flagged below to match
 * `application/ports/webauthn-credential-repository.js` (no `findById`/
 * `delete` on that port; it has `findByCredentialId`/`findByUserId`/
 * `findByMfaMethodId`), and remove the three paths this comment sits above
 * from `tsconfig.json`'s `exclude`.
 */
import type { PrismaClient } from "@prisma/client";
import type { WebAuthnCredentialRepository } from "../../application/ports/webauthn-credential-repository.js";
import type { UserId } from "../../domain/entities/mfa-method.js";
import type { WebAuthnCredential, WebAuthnCredentialId } from "../../domain/entities/webauthn-credential.js";
import { mapPrismaError } from "./error-mapper.js";
import { WebAuthnCredentialMapper } from "./webauthn-credential-mapper.js";

export class PrismaWebAuthnCredentialRepository implements WebAuthnCredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: WebAuthnCredentialId): Promise<WebAuthnCredential | undefined> {
    try {
      const row = await this.prisma.webAuthnCredential.findUnique({
        where: { id },
      });
      return row ? WebAuthnCredentialMapper.toDomain(row) : undefined;
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async findByCredentialId(credentialId: string): Promise<WebAuthnCredential | undefined> {
    try {
      const row = await this.prisma.webAuthnCredential.findUnique({
        where: { credentialId },
      });
      return row ? WebAuthnCredentialMapper.toDomain(row) : undefined;
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async findByUserId(userId: UserId): Promise<readonly WebAuthnCredential[]> {
    try {
      const rows = await this.prisma.webAuthnCredential.findMany({
        where: { userId },
      });
      return rows.map((row) => WebAuthnCredentialMapper.toDomain(row));
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async save(credential: WebAuthnCredential): Promise<void> {
    try {
      const data = WebAuthnCredentialMapper.toPersistence(credential);
      await this.prisma.webAuthnCredential.upsert({
        where: { id: credential.id },
        create: data,
        update: {
          publicKey: data.publicKey,
          signCounter: data.signCounter,
          transports: data.transports,
          attestationType: data.attestationType,
          lastUsedAt: data.lastUsedAt,
        },
      });
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async delete(id: WebAuthnCredentialId): Promise<void> {
    try {
      await this.prisma.webAuthnCredential.delete({
        where: { id },
      });
    } catch (error) {
      // If not found or already deleted, treat as idempotent success or map if needed
      try {
        throw mapPrismaError(error);
      } catch (err: any) {
        if (err.code === "NOT_FOUND") {
          return;
        }
        throw err;
      }
    }
  }
}
