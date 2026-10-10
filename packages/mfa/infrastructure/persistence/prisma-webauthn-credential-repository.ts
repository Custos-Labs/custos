import type { PrismaClient } from "@verixa/database";

import type { WebAuthnCredentialRepository } from "../../application/ports/webauthn-credential-repository.js";
import type { MfaMethodId, UserId } from "../../domain/entities/mfa-method.js";
import type { WebAuthnCredential } from "../../domain/entities/webauthn-credential.js";

import { withMappedErrors } from "./error-mapper.js";
import { WebAuthnCredentialMapper } from "./webauthn-credential-mapper.js";

/**
 * Prisma-backed `WebAuthnCredentialRepository`.
 *
 * One row per authenticator credential; misses return `null` per the port
 * (the contract suite asserts exactly that).
 */
export class PrismaWebAuthnCredentialRepository implements WebAuthnCredentialRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(credential: WebAuthnCredential): Promise<void> {
    const data = WebAuthnCredentialMapper.toPersistence(credential);
    await withMappedErrors("WebAuthnCredential", () =>
      this.prisma.webAuthnCredential.upsert({
        where: { id: credential.id },
        create: data,
        update: {
          publicKey: data.publicKey,
          signCounter: data.signCounter,
          transports: data.transports,
          attestationType: data.attestationType,
          lastUsedAt: data.lastUsedAt,
        },
      }),
    );
  }

  async findByCredentialId(credentialId: string): Promise<WebAuthnCredential | null> {
    const row = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId },
    });
    return row ? WebAuthnCredentialMapper.toDomain(row) : null;
  }

  async findByUserId(userId: UserId): Promise<WebAuthnCredential[]> {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { userId },
    });
    return rows.map((row) => WebAuthnCredentialMapper.toDomain(row));
  }

  async findByMfaMethodId(mfaMethodId: MfaMethodId): Promise<WebAuthnCredential | null> {
    const row = await this.prisma.webAuthnCredential.findUnique({
      where: { mfaMethodId },
    });
    return row ? WebAuthnCredentialMapper.toDomain(row) : null;
  }
}
