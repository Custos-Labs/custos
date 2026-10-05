import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { WebAuthnCredentialRepository } from "../../../application/ports/webauthn-credential-repository.js";
import { WebAuthnCredential } from "../../../domain/entities/webauthn-credential.js";

function makeCredential(
  userId = createId<"UserId">(),
  mfaMethodId = createId<"MfaMethodId">(),
  credentialId = "cred-abc",
): WebAuthnCredential {
  return WebAuthnCredential.create({
    userId,
    mfaMethodId,
    credentialId,
    publicKey: "pub-key-data",
    transports: ["internal"],
    attestationType: "none",
  });
}

/**
 * Behavioral contract every `WebAuthnCredentialRepository` implementation
 * must satisfy. Run against `InMemoryWebAuthnCredentialRepository` and
 * future database adapters.
 */
export function webAuthnCredentialRepositoryContract(
  createRepository: () => WebAuthnCredentialRepository,
): void {
  describe("WebAuthnCredentialRepository contract", () => {
    it("returns null for a credential that was never saved", async () => {
      const repo = createRepository();
      await expect(repo.findByCredentialId("nonexistent")).resolves.toBeNull();
      await expect(repo.findByMfaMethodId(createId<"MfaMethodId">())).resolves.toBeNull();
    });

    it("finds a saved credential by credentialId and by mfaMethodId", async () => {
      const repo = createRepository();
      const cred = makeCredential();

      await repo.save(cred);

      const foundByCredId = await repo.findByCredentialId(cred.credentialId);
      expect(foundByCredId?.credentialId).toBe(cred.credentialId);
      expect(foundByCredId?.publicKey).toBe(cred.publicKey);

      const foundByMethod = await repo.findByMfaMethodId(cred.mfaMethodId);
      expect(foundByMethod?.credentialId).toBe(cred.credentialId);
    });

    it("finds every credential belonging to a user", async () => {
      const repo = createRepository();
      const userId = createId<"UserId">();
      const cred1 = makeCredential(userId, createId<"MfaMethodId">(), "cred-1");
      const cred2 = makeCredential(userId, createId<"MfaMethodId">(), "cred-2");

      await repo.save(cred1);
      await repo.save(cred2);

      const list = await repo.findByUserId(userId);
      expect(list.length).toBe(2);
      expect(list.map((c) => c.credentialId).sort()).toEqual(["cred-1", "cred-2"]);
    });

    it("supports upsert / idempotent save", async () => {
      const repo = createRepository();
      const cred = makeCredential();

      await repo.save(cred);
      await repo.save(cred.updateSignCounter(5));

      const found = await repo.findByCredentialId(cred.credentialId);
      expect(found?.signCounter).toBe(5);
    });
  });
}
