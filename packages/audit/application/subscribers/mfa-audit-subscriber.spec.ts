import { describe, expect, it } from "vitest";

import { InMemoryAuditLogRepository } from "../../infrastructure/testing/in-memory-audit-repositories.js";
import { RecordAuditEvent } from "../use-cases/record-audit-event.js";

import {
  WebAuthnCloneSuspectedAuditSubscriber,
  type WebAuthnCloneSuspectedEvent,
} from "./mfa-audit-subscriber.js";

function harness(): {
  repository: InMemoryAuditLogRepository;
  subscriber: WebAuthnCloneSuspectedAuditSubscriber;
} {
  const repository = new InMemoryAuditLogRepository();
  const recordEvent = new RecordAuditEvent(repository);
  return {
    repository,
    subscriber: new WebAuthnCloneSuspectedAuditSubscriber(recordEvent),
  };
}

const occurredAt = new Date("2026-01-01T09:00:00.000Z");

function cloneSuspected(
  userId = "user-1",
  credentialId = "credential-1",
  previousCounter = 42,
  presentedCounter = 42,
): WebAuthnCloneSuspectedEvent {
  return {
    eventName: "mfa.webauthn.clone_suspected",
    aggregateId: credentialId,
    occurredAt,
    credentialId,
    userId,
    previousCounter,
    presentedCounter,
  };
}

describe("WebAuthnCloneSuspectedAuditSubscriber", () => {
  it("records a suspected WebAuthn clone with both counters in metadata", async () => {
    const { repository, subscriber } = harness();

    await subscriber.handle(cloneSuspected("user-123", "cred-456", 10, 8));

    const entry = await repository.findLatest();
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("mfa.webauthn.clone_suspected");
    expect(entry?.actorId).toBe("user-123");
    expect(entry?.subjectId).toBe("user-123");
    expect(entry?.metadata).toEqual({
      credentialId: "cred-456",
      previousCounter: "10",
      presentedCounter: "8",
    });
  });

  it("appends to the tamper-evident hash chain", async () => {
    const { repository, subscriber } = harness();

    await subscriber.handle(cloneSuspected("user-1", "cred-1", 5, 5));
    await subscriber.handle(cloneSuspected("user-2", "cred-2", 10, 9));

    const entries = repository.all();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.previousHash).toBe(entries[0]?.hash);
    expect(entries[1]?.sequence).toBe(2);
    expect(entries.every((entry) => entry.hasValidHash)).toBe(true);
  });
});
