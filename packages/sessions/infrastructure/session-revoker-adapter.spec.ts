import { asId } from "@verixa/shared-kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogoutEverywhere } from "../application/use-cases/logout-everywhere.js";
import { Session, type SessionUserId } from "../domain/entities/session.js";
import { SessionExpiryPolicy } from "../domain/value-objects/session-expiry-policy.js";

import { SessionsPackageRevoker } from "./session-revoker-adapter.js";
import { InMemoryRevocationList } from "./testing/in-memory-revocation-list.js";
import { InMemorySessionRepository } from "./testing/in-memory-session-repository.js";

const userId = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;
const policy = SessionExpiryPolicy.default();

describe("SessionsPackageRevoker", () => {
  let repository: InMemorySessionRepository;
  let revocationList: InMemoryRevocationList;
  let revoker: SessionsPackageRevoker;

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    revocationList = new InMemoryRevocationList();
    revoker = new SessionsPackageRevoker(new LogoutEverywhere(repository, revocationList));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("satisfies the shape credentials' SessionRevoker port expects", () => {
    const asSessionRevoker: { revokeAllForUser(userId: string): Promise<void> } = revoker;
    expect(typeof asSessionRevoker.revokeAllForUser).toBe("function");
  });

  it("revokes every session for the given user", async () => {
    const session = Session.open({ userId, policy });
    await repository.save(session);

    await revoker.revokeAllForUser(userId);

    expect((await repository.findById(session.id))?.isRevoked).toBe(true);
  });

  it("resolves without throwing for a user with no sessions", async () => {
    await expect(revoker.revokeAllForUser(userId)).resolves.toBeUndefined();
  });

  it("logs to stderr rather than throwing when the underlying use case fails", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await revoker.revokeAllForUser("");

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("revokeAllForUser"));
  });
});
