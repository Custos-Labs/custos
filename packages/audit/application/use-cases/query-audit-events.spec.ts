import { Result } from "@verixa/shared-kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import { AUDIT_PERMISSIONS, type AuditReader } from "../../domain/policies/audit-access-policy.js";
import {
  InMemoryAuditEventReader,
  InMemoryAuditLogRepository,
} from "../../infrastructure/testing/in-memory-audit-repositories.js";
import { AuditReadNotRecordedError } from "../audit-read-access.js";
import { ChainConflictError } from "../ports/audit-log-repository.js";

import { MAX_AUDIT_QUERY_PAGE_SIZE, QueryAuditEvents } from "./query-audit-events.js";
import { RecordAuditEvent } from "./record-audit-event.js";

const auditor: AuditReader = {
  actorId: "auditor-1",
  organizationId: "org-a",
  permissions: new Set([AUDIT_PERMISSIONS.query]),
};

function entries(count: number, actorId = "user-1"): AuditLogEntry[] {
  const chain: AuditLogEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    chain.push(
      AuditLogEntry.append({ action: "user.login_succeeded", actorId, previous: chain.at(-1) }),
    );
  }
  return chain;
}

/** An audit store that is down: every append fails. */
class UnavailableAuditLogRepository extends InMemoryAuditLogRepository {
  override append(): Promise<Result<void, ChainConflictError>> {
    return Promise.reject(new Error("connection refused"));
  }
}

describe("QueryAuditEvents", () => {
  let auditLog: InMemoryAuditLogRepository;
  let events: InMemoryAuditEventReader;
  let queryAuditEvents: QueryAuditEvents;

  beforeEach(() => {
    auditLog = new InMemoryAuditLogRepository();
    events = new InMemoryAuditEventReader();
    queryAuditEvents = new QueryAuditEvents(events, new RecordAuditEvent(auditLog));
  });

  it("returns the reader's own organization's entries", async () => {
    const own = entries(2);
    events.seed("org-a", ...own);
    events.seed("org-b", ...entries(3));

    const result = await queryAuditEvents.execute({ reader: auditor, organizationId: "org-a" });

    expect(Result.isOk(result) && result.value.entries).toEqual(own);
    // The whole organization fits in one page, so there is nothing to continue from.
    expect(Result.isOk(result) && result.value.hasMore).toBe(false);
    expect(Result.isOk(result) && result.value.nextCursor).toBeUndefined();
  });

  it("records the query itself as an audit event, naming who asked and for what", async () => {
    await queryAuditEvents.execute({
      reader: auditor,
      organizationId: "org-a",
      actorId: "user-1",
      from: new Date("2026-01-01T00:00:00.000Z"),
    });

    const [recorded] = auditLog.all();
    expect(recorded?.action).toBe("audit.queried");
    expect(recorded?.actorId).toBe("auditor-1");
    expect(recorded?.subjectId).toBe("org-a");
    expect(recorded?.metadata).toEqual({
      organizationId: "org-a",
      "filter.actorId": "user-1",
      "filter.from": "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects a cross-organization query without reading anything", async () => {
    events.seed("org-b", ...entries(3));

    const result = await queryAuditEvents.execute({ reader: auditor, organizationId: "org-b" });

    expect(Result.isErr(result) && result.error.code).toBe("AUDIT_ACCESS_DENIED");
    expect(events.reads).toEqual([]);
  });

  it("records the refused cross-organization attempt", async () => {
    await queryAuditEvents.execute({ reader: auditor, organizationId: "org-b" });

    const [recorded] = auditLog.all();
    expect(recorded?.action).toBe("audit.access_denied");
    expect(recorded?.actorId).toBe("auditor-1");
    expect(recorded?.subjectId).toBe("org-b");
    expect(recorded?.metadata).toMatchObject({
      operation: "query",
      reason: "cross_organization",
      actorOrganizationId: "org-a",
    });
  });

  it("rejects a reader without audit:query", async () => {
    const result = await queryAuditEvents.execute({
      reader: { ...auditor, permissions: new Set() },
      organizationId: "org-a",
    });

    expect(Result.isErr(result) && result.error.code).toBe("AUDIT_ACCESS_DENIED");
    expect(events.reads).toEqual([]);
  });

  it("refuses to read when the query cannot be recorded", async () => {
    events.seed("org-a", ...entries(1));
    const unrecorded = new QueryAuditEvents(
      events,
      new RecordAuditEvent(new UnavailableAuditLogRepository()),
    );

    const result = await unrecorded.execute({ reader: auditor, organizationId: "org-a" });

    expect(Result.isErr(result) && result.error).toBeInstanceOf(AuditReadNotRecordedError);
    expect(events.reads).toEqual([]);
  });

  it("caps the page size so a query cannot stand in for an export", async () => {
    events.seed("org-a", ...entries(MAX_AUDIT_QUERY_PAGE_SIZE + 20));

    const result = await queryAuditEvents.execute({
      reader: auditor,
      organizationId: "org-a",
      limit: 1_000_000,
    });

    expect(Result.isOk(result) && result.value.entries.length).toBe(MAX_AUDIT_QUERY_PAGE_SIZE);
  });

  it("scopes the read to the authorized organization", async () => {
    await queryAuditEvents.execute({ reader: auditor, organizationId: "org-a" });

    expect(events.reads).toHaveLength(1);
    expect(events.reads[0]?.organizationId).toBe("org-a");
  });
});
