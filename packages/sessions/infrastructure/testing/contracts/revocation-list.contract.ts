import { createId } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import type { RevocationList } from "../../../application/ports/revocation-list.js";
import type { SessionId } from "../../../domain/entities/session.js";

function createSessionId(): SessionId {
  return createId<"SessionId">();
}

const ONE_MINUTE_MS = 60 * 1000;

/**
 * Behavioral contract every {@link RevocationList} implementation must satisfy —
 * run against {@link import("../in-memory-revocation-list.js").InMemoryRevocationList}
 * and, when a Redis is available, against `RedisRevocationList`, through the same
 * test bodies. Contract testing (see `docs/guides/testing.md`): one suite,
 * every adapter, each proven to *behave* the same rather than merely to
 * implement the same interface.
 *
 * `createList` may be async so an adapter can spin up its backing store. The
 * time-dependent guarantees (TTL expiry, fail-closed) are deliberately left to
 * each adapter's own spec, because they cannot be exercised identically without
 * either sleeping or reaching into implementation details — this suite covers
 * the behavior that is genuinely common and instantaneous.
 */
export function revocationListContract(
  createList: () => RevocationList | Promise<RevocationList>,
): void {
  describe("RevocationList contract", () => {
    it("reports a never-revoked session as not revoked", async () => {
      const list = await createList();

      await expect(list.isRevoked(createSessionId())).resolves.toBe(false);
    });

    it("reports a revoked session as revoked", async () => {
      const list = await createList();
      const sessionId = createSessionId();

      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(sessionId)).resolves.toBe(true);
    });

    it("revokes only the named session, not others", async () => {
      const list = await createList();
      const revoked = createSessionId();
      const untouched = createSessionId();

      await list.revoke(revoked, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(revoked)).resolves.toBe(true);
      await expect(list.isRevoked(untouched)).resolves.toBe(false);
    });

    it("is idempotent — revoking twice leaves the session revoked", async () => {
      const list = await createList();
      const sessionId = createSessionId();

      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));
      await list.revoke(sessionId, new Date(Date.now() + ONE_MINUTE_MS));

      await expect(list.isRevoked(sessionId)).resolves.toBe(true);
    });
  });
}
