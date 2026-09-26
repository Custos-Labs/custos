import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { ListActiveSessions } from "./list-active-sessions.js";

const alice = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;
const bob = asId<"UserId">("00000000-0000-0000-0000-00000000b0b0") as SessionUserId;

describe("ListActiveSessions", () => {
  let repository: InMemorySessionRepository;
  let listActiveSessions: ListActiveSessions;
  const policy = SessionExpiryPolicy.default();

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    listActiveSessions = new ListActiveSessions(repository, policy);
  });

  it("returns the caller's own active sessions", async () => {
    const session = Session.open({
      userId: alice,
      policy,
      metadata: { ipAddress: "203.0.113.5", userAgent: "curl/8" },
    });
    await repository.save(session);

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        id: session.id,
        ipAddress: "203.0.113.5",
        userAgent: "curl/8",
      });
    }
  });

  it("returns an empty list when the user has no sessions", async () => {
    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  it("excludes another user's sessions", async () => {
    await repository.save(Session.open({ userId: bob, policy }));

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  it("excludes revoked sessions", async () => {
    const session = Session.open({ userId: alice, policy });
    await repository.save(session.revoke());

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  it("excludes sessions that have passed their absolute expiry", async () => {
    const longAgo = new Date(Date.now() - policy.absoluteLifetimeMs - 1);
    const session = Session.open({ userId: alice, policy, now: longAgo });
    await repository.save(session);

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  it("rejects listing another user's sessions without admin scope", async () => {
    await repository.save(Session.open({ userId: bob, policy }));

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: bob,
    });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("AUTHORIZATION_FAILED");
    }
  });

  it("allows listing another user's sessions with admin scope", async () => {
    const session = Session.open({ userId: bob, policy });
    await repository.save(session);

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: bob,
      asAdmin: true,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(session.id);
    }
  });

  it("rejects an empty requestingUserId or targetUserId", async () => {
    const result = await listActiveSessions.execute({ requestingUserId: "", targetUserId: alice });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("never includes token material in the returned shape", async () => {
    const session = Session.open({ userId: alice, policy });
    await repository.save(session);

    const result = await listActiveSessions.execute({
      requestingUserId: alice,
      targetUserId: alice,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      const keys = Object.keys(result.value[0] ?? {});
      expect(keys).toEqual([
        "id",
        "createdAt",
        "lastSeenAt",
        "expiresAt",
        "ipAddress",
        "userAgent",
      ]);
    }
  });
});
