import { asId, Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { SessionId, SessionUserId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { JwtTokenSigner } from "../../infrastructure/jwt-token-signer.js";
import { SigningKeyProvider } from "../../infrastructure/signing-key-provider.js";
import { InMemoryRevocationList } from "../../infrastructure/testing/in-memory-revocation-list.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { IssueSession } from "./issue-session.js";
import { RefreshAccessToken } from "./refresh-access-token.js";

const userId = asId<"UserId">("00000000-0000-0000-0000-00000000a11c") as SessionUserId;

describe("RefreshAccessToken", () => {
  let repository: InMemorySessionRepository;
  let revocationList: InMemoryRevocationList;
  let issueSession: IssueSession;
  let refreshAccessToken: RefreshAccessToken;
  const policy = SessionExpiryPolicy.default();
  const signer = new JwtTokenSigner(new SigningKeyProvider({ secret: "test-secret-value" }));

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    revocationList = new InMemoryRevocationList();
    issueSession = new IssueSession(repository, signer, policy);
    refreshAccessToken = new RefreshAccessToken(repository, signer, revocationList, policy);
  });

  async function issue(): Promise<{ sessionId: string; refreshToken: string }> {
    const result = await issueSession.execute({ userId });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");
    return { sessionId: result.value.sessionId, refreshToken: result.value.refreshToken };
  }

  it("rotates the refresh token and issues a new access token", async () => {
    const { sessionId, refreshToken } = await issue();

    const result = await refreshAccessToken.execute({ refreshToken });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;
    expect(result.value.refreshToken).not.toBe(refreshToken);

    const verified = await signer.verify(result.value.accessToken);
    expect(Result.isOk(verified) && verified.value.sessionId).toBe(sessionId);
  });

  it("touches the session's lastSeenAt on a successful refresh", async () => {
    const { sessionId, refreshToken } = await issue();
    const before = await repository.findById(sessionId as SessionId);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await refreshAccessToken.execute({ refreshToken });

    const after = await repository.findById(sessionId as SessionId);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before!.lastSeenAt.getTime());
  });

  it("rejects an unknown refresh token", async () => {
    const result = await refreshAccessToken.execute({ refreshToken: "not-a-real-token" });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("AUTHENTICATION_FAILED");
    }
  });

  it("rejects a refresh token whose session was revoked (logged out)", async () => {
    const { sessionId, refreshToken } = await issue();
    const session = await repository.findById(sessionId as SessionId);
    await repository.save(session!.revoke());

    const result = await refreshAccessToken.execute({ refreshToken });

    expect(Result.isErr(result)).toBe(true);
  });

  describe("reuse detection", () => {
    it("rejects a second redemption of the same (now-rotated-out) refresh token", async () => {
      const { refreshToken } = await issue();

      const first = await refreshAccessToken.execute({ refreshToken });
      expect(Result.isOk(first)).toBe(true);

      const second = await refreshAccessToken.execute({ refreshToken });
      expect(Result.isErr(second)).toBe(true);
    });

    it("revokes the entire session once reuse is detected", async () => {
      const { sessionId, refreshToken } = await issue();
      await refreshAccessToken.execute({ refreshToken });
      await refreshAccessToken.execute({ refreshToken }); // reuse

      const session = await repository.findById(sessionId as SessionId);
      expect(session?.isRevoked).toBe(true);
    });

    it("adds the session to the revocation list once reuse is detected", async () => {
      const { sessionId, refreshToken } = await issue();
      await refreshAccessToken.execute({ refreshToken });
      await refreshAccessToken.execute({ refreshToken }); // reuse

      await expect(revocationList.isRevoked(sessionId as SessionId)).resolves.toBe(true);
    });

    it("also rejects the token that was legitimately rotated in after reuse revoked the session", async () => {
      const { refreshToken } = await issue();
      const rotated = await refreshAccessToken.execute({ refreshToken });
      if (!Result.isOk(rotated)) throw new Error("fixture setup failed");

      await refreshAccessToken.execute({ refreshToken }); // reuse of the original

      const result = await refreshAccessToken.execute({ refreshToken: rotated.value.refreshToken });
      expect(Result.isErr(result)).toBe(true);
    });
  });

  it("rejects a refresh token past its expiry", async () => {
    const shortPolicy = (() => {
      const created = SessionExpiryPolicy.create({
        accessTokenTtlMs: 1,
        refreshTokenTtlMs: 1,
        absoluteLifetimeMs: 60_000,
        idleTimeoutMs: 60_000,
      });
      if (Result.isErr(created)) throw new Error("fixture setup failed");
      return created.value;
    })();
    const shortIssue = new IssueSession(repository, signer, shortPolicy);
    const shortRefresh = new RefreshAccessToken(repository, signer, revocationList, shortPolicy);

    const issued = await shortIssue.execute({ userId });
    if (!Result.isOk(issued)) throw new Error("fixture setup failed");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await shortRefresh.execute({ refreshToken: issued.value.refreshToken });

    expect(Result.isErr(result)).toBe(true);
import { asId } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { Session, type SessionUserId } from "../../domain/entities/session.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";
import { InMemoryTokenSigner } from "../../infrastructure/testing/in-memory-token-signer.js";

import { RefreshAccessToken } from "./refresh-access-token.js";

const userId: SessionUserId = asId("11111111-1111-1111-1111-111111111111");

describe("RefreshAccessToken", () => {
  let sessionRepository: InMemorySessionRepository;
  let tokenSigner: InMemoryTokenSigner;
  let refreshAccessToken: RefreshAccessToken;

  beforeEach(() => {
    sessionRepository = new InMemorySessionRepository();
    tokenSigner = new InMemoryTokenSigner();
    refreshAccessToken = new RefreshAccessToken(sessionRepository, tokenSigner);
  });

  it("issues a new access token for a valid session and refresh token", async () => {
    const now = new Date();
    const { session, rawRefreshToken } = Session.issue({
      userId,
      metadata: { ipAddress: "203.0.113.10" },
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      metadata: { ipAddress: "203.0.113.10" },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.accessToken).toBeTruthy();
    expect(result.value.session.currentAccessToken!.tokenId).not.toBe("token-1");
  });

  it("records a new metadata observation when the presented IP/user-agent changed", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { session, rawRefreshToken } = Session.issue({
      userId,
      metadata: { ipAddress: "203.0.113.10" },
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      metadata: { ipAddress: "198.51.100.20" },
      now: new Date(now.getTime() + 60_000),
    });

    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.session.metadataHistory).toHaveLength(2);
    expect(result.value.session.currentMetadata).toEqual({ ipAddress: "198.51.100.20" });
  });

  it("does not add a metadata observation when nothing changed", async () => {
    const now = new Date();
    const metadata = { ipAddress: "203.0.113.10" };
    const { session, rawRefreshToken } = Session.issue({
      userId,
      metadata,
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      metadata,
    });

    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value.session.metadataHistory).toHaveLength(1);
  });

  it("rejects an unknown session id", async () => {
    const result = await refreshAccessToken.execute({
      sessionId: "does-not-exist",
      refreshToken: "whatever",
      metadata: {},
    });

    expect(result.kind).toBe("err");
  });

  it("rejects a refresh token that does not match the session", async () => {
    const now = new Date();
    const { session } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session);

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: "wrong-token",
      metadata: {},
    });

    expect(result.kind).toBe("err");
  });

  it("rejects a revoked session", async () => {
    const now = new Date();
    const { session, rawRefreshToken } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      now,
    });
    await sessionRepository.save(session.revoke(now));

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      metadata: {},
    });

    expect(result.kind).toBe("err");
  });

  it("rejects an expired session", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { session, rawRefreshToken } = Session.issue({
      userId,
      metadata: {},
      accessToken: { tokenId: "token-1", expiresAt: new Date(now.getTime() + 60_000) },
      ttlMs: 1000,
      now,
    });
    await sessionRepository.save(session);

    const result = await refreshAccessToken.execute({
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      metadata: {},
      now: new Date(now.getTime() + 2000),
    });

    expect(result.kind).toBe("err");
  });
});
