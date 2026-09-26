import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { InMemoryRevocationList } from "../../infrastructure/testing/in-memory-revocation-list.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { Logout } from "./logout.js";

const userId = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;
const policy = SessionExpiryPolicy.default();

describe("Logout", () => {
  let repository: InMemorySessionRepository;
  let revocationList: InMemoryRevocationList;
  let logout: Logout;

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    revocationList = new InMemoryRevocationList();
    logout = new Logout(repository, revocationList);
  });

  it("revokes the session", async () => {
    const session = Session.open({ userId, policy });
    await repository.save(session);

    const result = await logout.execute({ sessionId: session.id });

    expect(Result.isOk(result)).toBe(true);
    const stored = await repository.findById(session.id);
    expect(stored?.isRevoked).toBe(true);
  });

  it("adds the session to the revocation list", async () => {
    const session = Session.open({ userId, policy });
    await repository.save(session);

    await logout.execute({ sessionId: session.id });

    await expect(revocationList.isRevoked(session.id)).resolves.toBe(true);
  });

  it("is idempotent when the session does not exist", async () => {
    const result = await logout.execute({ sessionId: "00000000-0000-0000-0000-000000000099" });

    expect(Result.isOk(result)).toBe(true);
  });

  it("rejects an empty sessionId", async () => {
    const result = await logout.execute({ sessionId: "" });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("honors an explicit revocation window", async () => {
    const session = Session.open({ userId, policy });
    await repository.save(session);
    const revokeUntil = new Date("2099-01-01T00:00:00.000Z");

    await logout.execute({ sessionId: session.id, revokeUntil });

    await expect(revocationList.isRevoked(session.id)).resolves.toBe(true);
  });
});
