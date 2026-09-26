import { Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { SessionId } from "../../domain/entities/session.js";
import { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import { JwtTokenSigner } from "../../infrastructure/jwt-token-signer.js";
import { SigningKeyProvider } from "../../infrastructure/signing-key-provider.js";
import { InMemorySessionRepository } from "../../infrastructure/testing/in-memory-session-repository.js";

import { IssueSession } from "./issue-session.js";

const userId = "00000000-0000-0000-0000-00000000a11c";

describe("IssueSession", () => {
  let repository: InMemorySessionRepository;
  let issueSession: IssueSession;
  const policy = SessionExpiryPolicy.default();
  const signer = new JwtTokenSigner(new SigningKeyProvider({ secret: "test-secret-value" }));

  beforeEach(() => {
    repository = new InMemorySessionRepository();
    issueSession = new IssueSession(repository, signer, policy);
  });

  it("opens a session and returns an access/refresh token pair", async () => {
    const result = await issueSession.execute({
      userId,
      ipAddress: "203.0.113.5",
      userAgent: "curl/8",
    });

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) return;

    expect(result.value.sessionId).toBeTruthy();
    expect(typeof result.value.accessToken).toBe("string");
    expect(typeof result.value.refreshToken).toBe("string");

    const stored = await repository.findById(result.value.sessionId as SessionId);
    expect(stored?.userId).toBe(userId);
    expect(stored?.ipAddress).toBe("203.0.113.5");
    expect(stored?.userAgent).toBe("curl/8");
  });

  it("persists a redeemable refresh token matching the returned raw value", async () => {
    const result = await issueSession.execute({ userId });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");

    const stored = await repository.findRefreshTokenByHash(
      RefreshToken.hashToken(result.value.refreshToken),
    );

    expect(stored).toBeDefined();
    expect(stored?.isRedeemable()).toBe(true);
    expect(stored?.matchesToken(result.value.refreshToken)).toBe(true);
  });

  it("issues an access token whose claims match the session", async () => {
    const result = await issueSession.execute({ userId });
    if (!Result.isOk(result)) throw new Error("fixture setup failed");

    const verified = await signer.verify(result.value.accessToken);
    expect(Result.isOk(verified)).toBe(true);
    if (Result.isOk(verified)) {
      expect(verified.value.sessionId).toBe(result.value.sessionId);
      expect(verified.value.userId).toBe(userId);
    }
  });

  it("rejects an empty userId", async () => {
    const result = await issueSession.execute({ userId: "" });

    expect(Result.isErr(result)).toBe(true);
    if (Result.isErr(result)) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("opens independent sessions on repeated calls", async () => {
    const first = await issueSession.execute({ userId });
    const second = await issueSession.execute({ userId });
    if (!Result.isOk(first) || !Result.isOk(second)) throw new Error("fixture setup failed");

    expect(first.value.sessionId).not.toBe(second.value.sessionId);
    expect(first.value.refreshToken).not.toBe(second.value.refreshToken);
  });
});
