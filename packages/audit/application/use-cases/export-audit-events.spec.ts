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

import { ExportAuditEvents } from "./export-audit-events.js";
import { RecordAuditEvent } from "./record-audit-event.js";

const exporter: AuditReader = {
  actorId: "auditor-1",
  organizationId: "org-a",
  permissions: new Set([AUDIT_PERMISSIONS.export]),
};

async function collect(stream: AsyncIterable<AuditLogEntry>): Promise<AuditLogEntry[]> {
  const collected: AuditLogEntry[] = [];
  for await (const entry of stream) collected.push(entry);
  return collected;
}

class UnavailableAuditLogRepository extends InMemoryAuditLogRepository {
  override append(): Promise<Result<void, ChainConflictError>> {
    return Promise.reject(new Error("connection refused"));
  }
}

describe("ExportAuditEvents", () => {
  let auditLog: InMemoryAuditLogRepository;
  let events: InMemoryAuditEventReader;
  let exportAuditEvents: ExportAuditEvents;

  beforeEach(() => {
    auditLog = new InMemoryAuditLogRepository();
    events = new InMemoryAuditEventReader();
    exportAuditEvents = new ExportAuditEvents(events, new RecordAuditEvent(auditLog));
  });

  it("streams the reader's own organization's entries", async () => {
    const first = AuditLogEntry.append({ action: "user.registered", actorId: "user-1" });
    const second = AuditLogEntry.append({ action: "user.login_failed", previous: first });
    events.seed("org-a", first, second);
    events.seed("org-b", AuditLogEntry.append({ action: "user.registered" }));

    const result = await exportAuditEvents.execute({ reader: exporter, organizationId: "org-a" });

    if (!Result.isOk(result)) throw new Error("expected the export to be authorized");
    await expect(collect(result.value)).resolves.toEqual([first, second]);
  });

  it("records a successful export as an audit event before any entry is released", async () => {
    events.seed("org-a", AuditLogEntry.append({ action: "user.registered" }));

    const result = await exportAuditEvents.execute({
      reader: exporter,
      organizationId: "org-a",
      subjectId: "user-7",
    });

    // Nothing has been consumed from the stream yet, and the record already
    // exists: an export abandoned after the first row still leaves a trace.
    expect(Result.isOk(result)).toBe(true);
    const [recorded] = auditLog.all();
    expect(recorded?.action).toBe("audit.exported");
    expect(recorded?.actorId).toBe("auditor-1");
    expect(recorded?.subjectId).toBe("org-a");
    expect(recorded?.metadata).toEqual({ organizationId: "org-a", "filter.subjectId": "user-7" });
  });

  it("rejects a cross-organization export and records the attempt", async () => {
    events.seed("org-b", AuditLogEntry.append({ action: "user.registered" }));

    const result = await exportAuditEvents.execute({ reader: exporter, organizationId: "org-b" });

    expect(Result.isErr(result) && result.error.code).toBe("AUDIT_ACCESS_DENIED");
    expect(auditLog.all().map((entry) => entry.action)).toEqual(["audit.access_denied"]);
    expect(auditLog.all()[0]?.metadata).toMatchObject({
      operation: "export",
      reason: "cross_organization",
    });
  });

  it("rejects a reader who may query but not export", async () => {
    const result = await exportAuditEvents.execute({
      reader: { ...exporter, permissions: new Set([AUDIT_PERMISSIONS.query]) },
      organizationId: "org-a",
    });

    expect(Result.isErr(result) && result.error.code).toBe("AUDIT_ACCESS_DENIED");
    expect(auditLog.all().map((entry) => entry.action)).toEqual(["audit.access_denied"]);
  });

  it("does not hand out a stream when the export cannot be recorded", async () => {
    const unrecorded = new ExportAuditEvents(
      events,
      new RecordAuditEvent(new UnavailableAuditLogRepository()),
    );

    const result = await unrecorded.execute({ reader: exporter, organizationId: "org-a" });

    expect(Result.isErr(result) && result.error).toBeInstanceOf(AuditReadNotRecordedError);
  });
});
