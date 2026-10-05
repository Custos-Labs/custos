import { Result } from "@verixa/shared-kernel";

import type { AuditLogEntry } from "../../domain/entities/audit-log-entry.js";
import type { AuditReader } from "../../domain/policies/audit-access-policy.js";
import { type AuditReadError, authorizeAndRecordAuditRead } from "../audit-read-access.js";
import type { AuditEventReader } from "../ports/audit-event-reader.js";

import type { RecordAuditEvent } from "./record-audit-event.js";

/** The largest page a single query may return. */
export const MAX_AUDIT_QUERY_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export interface QueryAuditEventsCommand {
  /** The authenticated caller, built by the interface layer — see {@link AuditReader}. */
  readonly reader: AuditReader;
  /** Whose audit log to read. Must be the reader's own organization. */
  readonly organizationId: string;
  readonly actorId?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Keyset cursor: the last `sequence` of the previous page. */
  readonly afterSequence?: number | undefined;
  /** Clamped to `1..`{@link MAX_AUDIT_QUERY_PAGE_SIZE}. */
  readonly limit?: number | undefined;
}

/**
 * One page of the log, plus where the next page starts.
 *
 * A keyset cursor rather than an offset: `OFFSET 1000` makes the database read
 * and discard a thousand rows before returning any, and the cost grows with
 * depth, whereas "everything after sequence N" is a range scan on an indexed
 * column and costs the same however far into the log it reaches. The trade is
 * that a caller can only continue forward, not jump to an arbitrary page —
 * acceptable for an audit log, where the access pattern is "show me what
 * happened" rather than "show me page 40".
 */
export interface QueryAuditEventsResult {
  readonly entries: readonly AuditLogEntry[];
  /** The `sequence` to pass as the next `afterSequence`, or undefined at the end. */
  readonly nextCursor: number | undefined;
  readonly hasMore: boolean;
}

/**
 * Reads one page of an organization's audit log, on behalf of someone allowed
 * to read it, and leaves a record that they did.
 *
 * ## Who audits the auditors
 *
 * An audit log is the most concentrated record of who did what in the system,
 * which makes it one of the most sensitive things in it. If reading it were
 * unprivileged, or privileged but unobserved, the log would become the easiest
 * way to learn what an organization's users do — and nobody would know it had
 * been used that way. So every read requires `audit:query` within the
 * requested organization, and every read is itself appended to the audit log
 * before any entry is returned. Compliance regimes (SOC 2's CC7 monitoring
 * criteria, among others) expect exactly this.
 *
 * ## Why the page size is capped
 *
 * `audit:query` is granted more widely than `audit:export`. Without a cap, a
 * query with `limit: 10_000_000` is an export by another name, reached with
 * the weaker permission. The cap keeps the two permissions meaning different
 * things.
 */
export class QueryAuditEvents {
  constructor(
    private readonly events: AuditEventReader,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    command: QueryAuditEventsCommand,
  ): Promise<Result<QueryAuditEventsResult, AuditReadError>> {
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
      "query",
      criteria,
    );
    if (Result.isErr(access)) return access;

    const limit = Math.min(
      Math.max(Math.trunc(command.limit ?? DEFAULT_PAGE_SIZE), 1),
      MAX_AUDIT_QUERY_PAGE_SIZE,
    );

    // One row beyond the page, so "is there another page?" is answered without
    // a second query and without reading rows that will not be returned.
    const page = await this.events.query(criteria, {
      afterSequence: command.afterSequence,
      limit: limit + 1,
    });

    const hasMore = page.length > limit;
    const entries = hasMore ? page.slice(0, limit) : page;

    return Result.ok({
      entries,
      hasMore,
      nextCursor: hasMore ? entries[entries.length - 1]?.sequence : undefined,
    });
  }
}
