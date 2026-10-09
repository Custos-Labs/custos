import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { PrismaClient } from "@verixa/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MfaMethodId, UserId } from "../../domain/entities/mfa-method.js";
import { WebAuthnCredential } from "../../domain/entities/webauthn-credential.js";
import { webAuthnCredentialRepositoryContract } from "../testing/contracts/webauthn-credential-repository.contract.js";

import { PrismaWebAuthnCredentialRepository } from "./prisma-webauthn-credential-repository.js";

/**
 * Database-backed tests skip when no Postgres is reachable, so a fresh clone
 * without Docker still gets a green `pnpm test`; `TEST_DATABASE_URL` points at
 * one that is already running (CI service container or `docker compose up
 * postgres`). Mirrors the harness used by `prisma-mfa-method-repository.spec.ts`.
 */
async function databaseUrl(): Promise<string | undefined> {
  const configured = process.env["TEST_DATABASE_URL"];
  if (configured === undefined) return undefined;

  const url = new URL(configured);
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port || 5432) });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2_000, () => finish(false));
  });

  return reachable ? configured : undefined;
}

const database = await databaseUrl();

describe.skipIf(database === undefined)(
  "PrismaWebAuthnCredentialRepository (real Postgres)",
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: database as string } } });
      await prisma.$connect();
    }, 60_000);

    afterAll(async () => {
      await prisma.$disconnect();
    }, 60_000);

    async function setupContext(
      existingUserId?: UserId,
    ): Promise<{ userId: UserId; mfaMethodId: MfaMethodId }> {
      const now = new Date();
      let userId = existingUserId;

      if (!userId) {
        const uId = randomUUID();
        await prisma.user.create({
          data: {
            id: uId,
            email: `webauthn-${uId}@example.com`,
            displayName: "WebAuthn User",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        });
        userId = uId as UserId;
      }

      const mfaMethodId = randomUUID() as MfaMethodId;
      await prisma.mfaMethod.create({
        data: {
          id: mfaMethodId,
          userId,
          type: "webauthn",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });

      return { userId, mfaMethodId };
    }

    webAuthnCredentialRepositoryContract(
      () => new PrismaWebAuthnCredentialRepository(prisma),
      setupContext,
    );

    describe("relational invariants", () => {
      it("rejects saving a credential referencing a non-existent user", async () => {
        const repository = new PrismaWebAuthnCredentialRepository(prisma);
        const fakeUserId = randomUUID() as UserId;
        const fakeMfaMethodId = randomUUID() as MfaMethodId;

        const cred = WebAuthnCredential.create({
          userId: fakeUserId,
          mfaMethodId: fakeMfaMethodId,
          credentialId: `nonexistent-user-${randomUUID()}`,
          publicKey: "pub-key",
          attestationType: "none",
        });

        await expect(repository.save(cred)).rejects.toThrow();
      });

      it("cascades credential deletion when parent user is removed", async () => {
        const repository = new PrismaWebAuthnCredentialRepository(prisma);
        const { userId, mfaMethodId } = await setupContext();

        const cred = WebAuthnCredential.create({
          userId,
          mfaMethodId,
          credentialId: `cascade-test-${randomUUID()}`,
          publicKey: "pub-key",
          attestationType: "none",
        });

        await repository.save(cred);
        const saved = await repository.findByCredentialId(cred.credentialId);
        expect(saved).not.toBeNull();

        // Deleting user should cascade to webauthn_credentials
        await prisma.user.delete({ where: { id: userId } });

        const afterDelete = await repository.findByCredentialId(cred.credentialId);
        expect(afterDelete).toBeNull();
      });
    });
  },
);
