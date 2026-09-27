import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { asId } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { InMemoryRevocationList } from "../../infrastructure/testing/in-memory-revocation-list.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { Logout } from "./logout.js";

const userId = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;
const policy = SessionExpiryPolicy.default();

describe("Logout", () => {
  let repository: InMemorySessionRepository;
const userId: SessionUserId = asId("11111111-1111-1111-1111-111111111111");

describe("Logout", () => {
  let sessionRepository: InMemorySessionRepository;
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
    sessionRepository = new InMemorySessionRepository();
    revocationList = new InMemoryRevocationList();
    logout = new Logout(sessionRepository, revocationList);
  });

  it("revokes the session so it can no longer be used to refresh", async () => {
    const now = new Date();
    const { session } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    const result = await logout.execute({ sessionId: session.id });

    expect(result.kind).toBe("ok");
    const stored = await sessionRepository.findById(session.id);
    expect(stored!.isRevoked).toBe(true);
  });

  it("denylists the session's current access token so it fails isRevoked checks", async () => {
    const now = new Date();
    const { session } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    await logout.execute({ sessionId: session.id });

    expect(await revocationList.isRevoked("token-1")).toBe(true);
  });

  it("succeeds idempotently when the session does not exist", async () => {
    const result = await logout.execute({ sessionId: "does-not-exist" });

    expect(result.kind).toBe("ok");
  });

  it("succeeds idempotently when the session is already revoked", async () => {
    const now = new Date();
    const { session } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session.revoke(now));

    const result = await logout.execute({ sessionId: session.id });

    expect(result.kind).toBe("ok");
  });
});
