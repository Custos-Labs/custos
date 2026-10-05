import type { AuditLogEntry } from "../domain/entities/audit-log-entry.js";
import {
  escapeJsonLineTerminators,
  neutralizeFormulaPrefix,
} from "../domain/value-objects/audit-metadata.js";

/**
 * Renders an audit export.
 *
 * Separated from `ExportAuditEvents` because that use case deliberately does
 * not serialize: it authorizes the disclosure, records that it happened, and
 * yields entries, leaving the encoding to whatever writes the response. A merge
 * had concatenated the two into one file, each with its own `ExportAuditEvents`
 * class. Keeping them apart is what both were documented to want, and it lets
 * the encoder be tested without a reader, a repository or a permission.
 */

/**
 * What an export is written as.
 *
 * `jsonl` is the faithful one: one JSON document per line, values exactly as
 * they were recorded. It is what a program should read, what a re-verification
 * should be run against, and what an archive should contain. It is safe by
 * construction because JSON escapes the control characters that would otherwise
 * end a line early.
 *
 * `csv` is the hostile one. It has no escaping rules for anything but quotes,
 * no types, and it is opened in software that executes cell contents. So the
 * CSV writer here is defensive at three separate boundaries — control
 * characters are escaped so one entry is one line, cells containing the
 * delimiters are quoted, and cells that would be read as a formula are
 * neutralized. Every one of the three is needed; each alone is not.
 */
export type AuditExportFormat = "csv" | "jsonl";

/** The columns of a CSV export, in order. */
export const AUDIT_EXPORT_HEADER =
  "sequence,action,actor_id,subject_id,occurred_at,previous_hash,hash,metadata";

/**
 * How many entries one export may produce.
 *
 * An export of an unbounded log is a memory-exhaustion request with an
 * authorization header on it, so the cap is explicit and `truncated` says when
 * it applied. Silently returning a partial file would be worse than the outage:
 * an auditor counting rows would have no way to know the count was a limit
 * rather than a fact.
 */
export const DEFAULT_EXPORT_MAX_RECORDS = 10_000;

export interface ExportAuditEventsResult {
  readonly format: AuditExportFormat;
  readonly body: string;
  readonly recordCount: number;
  readonly truncated: boolean;
}

/**
 * The logging capability an export needs, declared as the minimum shape.
 *
 * pino's `Logger` satisfies this structurally. The use case takes a port
 * rather than importing pino so the domain and application layers stay free of
 * the logging implementation, and so a test can capture what would have been
 * written.
 */
export interface AuditExportLogger {
  info(fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

/**
 * Encodes entries into one export body, stopping at `maxRecords`.
 *
 * Takes an `AsyncIterable` so it composes with what `ExportAuditEvents` yields
 * and never holds more than it must: it stops reading as soon as the cap is
 * reached, rather than draining the log and discarding the surplus.
 */
export async function encodeAuditExport(
  entries: AsyncIterable<AuditLogEntry>,
  options: {
    readonly format: AuditExportFormat;
    readonly maxRecords?: number | undefined;
    readonly logger?: AuditExportLogger | undefined;
    /** Recorded with the export, as one escaped JSON field. */
    readonly logContext?: Readonly<Record<string, unknown>> | undefined;
  },
): Promise<ExportAuditEventsResult> {
  const maxRecords = options.maxRecords ?? DEFAULT_EXPORT_MAX_RECORDS;
  const rows: string[] = [];
  let truncated = false;

  for await (const entry of entries) {
    if (rows.length >= maxRecords) {
      truncated = true;
      break;
    }
    rows.push(options.format === "csv" ? csvRow(entry) : jsonlRow(entry));
  }

  const body =
    options.format === "csv"
      ? `${AUDIT_EXPORT_HEADER}\r\n${rows.map((row) => `${row}\r\n`).join("")}`
      : rows.map((row) => `${row}\n`).join("");

  logExport(options.logger, options.format, rows.length, truncated, options.logContext ?? {});

  return { format: options.format, body, recordCount: rows.length, truncated };
}

/**
 * Records that an export happened.
 *
 * The context values are attacker-adjacent -- they come from whoever asked for
 * the export -- and a log line is exactly the sink where a newline is worth
 * something to an attacker. So the record carries them as one JSON document in
 * a *field*, with the line terminators JSON leaves raw escaped, and never in
 * the message.
 *
 * The rejected alternative was interpolating the count and context into the
 * message. It reads more naturally, and it is the bug: pino escapes its fields,
 * but a message is a message, so a newline inside a value would land in the
 * output verbatim and start a line the application never logged.
 */
function logExport(
  logger: AuditExportLogger | undefined,
  format: AuditExportFormat,
  recordCount: number,
  truncated: boolean,
  logContext: Readonly<Record<string, unknown>>,
): void {
  logger?.info({
    type: "audit.log.exported",
    format,
    recordCount,
    truncated,
    context: escapeJsonLineTerminators(JSON.stringify(logContext) ?? "{}"),
  });
}

/** A CSV row: every field escaped by the entry, quoted and neutralized here. */
function csvRow(entry: AuditLogEntry): string {
  const fields = entry.toLogFields();

  return [
    fields.sequence,
    fields.action,
    fields.actorId,
    fields.subjectId,
    fields.occurredAt,
    fields.previousHash,
    fields.hash,
    fields.metadata,
  ]
    .map((field) => csvCell(field ?? ""))
    .join(",");
}

/**
 * Encodes one cell.
 *
 * Quoting is per RFC 4180: wrap in double quotes when the value contains a
 * quote, a comma, or a line break, and double the quotes inside. The line
 * breaks cannot be there by the time this runs — `toLogFields` escaped them —
 * and checking anyway keeps the function honest if a caller ever hands it a
 * raw value.
 *
 * Formula neutralization runs on the already-escaped text, which is the order
 * that leaves nothing to miss: a payload hiding its formula character behind a
 * tab has that tab turned into the two characters `\t`, so the cell starts with
 * text a spreadsheet will not evaluate, and one that arrives with `=` first is
 * caught by the prefix check.
 */
function csvCell(value: string): string {
  const neutralized = neutralizeFormulaPrefix(value);

  return /[",\r\n]/u.test(neutralized) ? `"${neutralized.replace(/"/gu, '""')}"` : neutralized;
}

/**
 * Encodes one entry as a JSON document.
 *
 * Values go out verbatim: JSON's own escapes cover the characters that would
 * break the line structure, and an audit export that silently rewrites what was
 * recorded is worth less than one that cannot be opened.
 */
function jsonlRow(entry: AuditLogEntry): string {
  return JSON.stringify({
    sequence: entry.sequence,
    action: entry.action,
    actorId: entry.actorId ?? null,
    subjectId: entry.subjectId ?? null,
    occurredAt: entry.occurredAt.toISOString(),
    previousHash: entry.previousHash,
    hash: entry.hash,
    metadata: { ...entry.metadata },
  });
}
