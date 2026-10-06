import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { InMemoryRevocationList } from "../../infrastructure/testing/in-memory-revocation-list.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { LogoutEverywhere } from "./logout-everywhere.js";

const alice = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;
const bob = asId<"UserId">("00000000-0000-0000-0000-00000000b0b0") as SessionUserId;
const policy = SessionExpiryPolicy.default();

describe("LogoutEverywhere", () => {
  let repository: InMemorySessionRepository;
  let revocationList: InMemoryRevocationList;
  let logoutEverywhere: LogoutEverywhere;

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    revocationList = new InMemoryRevocationList();
    logoutEverywhere = new LogoutEverywhere(repository, revocationList);
  });

  it("revokes every session belonging to the user", async () => {
    const first = Session.open({ userId: alice, policy });
    const second = Session.open({ userId: alice, policy });
    await repository.save(first);
    await repository.save(second);

    const result = await logoutEverywhere.execute({ userId: alice });

    expect(Result.isOk(result)).toBe(true);
    expect((await repository.findById(first.id))?.isRevoked).toBe(true);
    expect((await repository.findById(second.id))?.isRevoked).toBe(true);
  });

  it("adds every one of the user's sessions to the revocation list", async () => {
    const first = Session.open({ userId: alice, policy });
    const second = Session.open({ userId: alice, policy });
    await repository.save(first);
    await repository.save(second);

    await logoutEverywhere.execute({ userId: alice });

    await expect(revocationList.isRevoked(first.id)).resolves.toBe(true);
    await expect(revocationList.isRevoked(second.id)).resolves.toBe(true);
  });

  it("does not touch another user's sessions", async () => {
    const bobsSession = Session.open({ userId: bob, policy });
    await repository.save(bobsSession);

    await logoutEverywhere.execute({ userId: alice });

    expect((await repository.findById(bobsSession.id))?.isRevoked).toBe(false);
    await expect(revocationList.isRevoked(bobsSession.id)).resolves.toBe(false);
  });

  it("is a successful no-op for a user with no active sessions", async () => {
    const result = await logoutEverywhere.execute({ userId: alice });

    expect(Result.isOk(result)).toBe(true);
  });

  it("rejects an empty userId", async () => {
    const result = await logoutEverywhere.execute({ userId: "" });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("leaves a session created after the call unaffected", async () => {
    const existing = Session.open({ userId: alice, policy });
    await repository.save(existing);

    await logoutEverywhere.execute({ userId: alice });

    const newSession = Session.open({ userId: alice, policy });
    await repository.save(newSession);

    expect((await repository.findById(newSession.id))?.isRevoked).toBe(false);
  });
});
