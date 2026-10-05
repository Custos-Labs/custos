import { Result } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditReader } from "../../domain/policies/audit-access-policy.js";
import { type AuditReadError, authorizeAndRecordAuditRead } from "../audit-read-access.js";
import type { AuditEventReader } from "../ports/audit-event-reader.js";

import type { RecordAuditEvent } from "./record-audit-event.js";

export interface ExportAuditEventsCommand {
  /** The authenticated caller, built by the interface layer — see {@link AuditReader}. */
  readonly reader: AuditReader;
  /** Whose audit log to export. Must be the reader's own organization. */
  readonly organizationId: string;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/**
 * Streams every matching entry of an organization's audit log, for a
 * compliance export, and records that the export happened.
 *
 * Requires `audit:export`, a separate permission from `audit:query` — see
 * `AUDIT_PERMISSIONS` for why bulk disclosure is its own grant.
 *
 * ## Recorded when it starts, not when it finishes
 *
 * The `audit.exported` entry is written before the stream is handed back, so
 * it exists even if the export is abandoned halfway. Recording on completion
 * reads more naturally ("a successful export is logged") but gets the
 * security property backwards: rows leave the system from the first chunk,
 * and a client that disconnects one row before the end would have taken
 * almost everything while leaving no trace. What is audited is the disclosure,
 * and the disclosure starts immediately.
 *
 * Serialization to CSV or JSON is not this use case's concern — it yields
 * entries, and the interface layer (Issue 189) encodes them as it streams.
 */
export class ExportAuditEvents {
  constructor(
    private readonly events: AuditEventReader,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    command: ExportAuditEventsCommand,
  ): Promise<Result<AsyncIterable<AuditLogEntry>, AuditReadError>> {
    const criteria = {
      organizationId: command.organizationId,
      actorId: command.actorId,
      subjectId: command.subjectId,
      from: command.from,
      to: command.to,
    };

    const access = await authorizeAndRecordAuditRead(
      this.recordAuditEvent,
      command.reader,
      "export",
      criteria,
    );
    if (Result.isErr(access)) return access;

    return Result.ok(this.events.stream(criteria));
  }
}
