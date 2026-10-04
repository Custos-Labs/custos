// The chain's own primitives, for suites that must build an entry by hand.
//
// A second entry point rather than part of `index.ts`, because the main surface
// deliberately withholds these: a consumer that can mint an `AuditLogEntry`
// could append one without going through `RecordAuditEvent`, which is the one
// place that reads the chain tail before linking to it. See `index.ts`'s header
// and the assertions in `index.spec.ts`.
//
// Importing this from anything that ships is a bug. It exists so the
// integration suite can forge a forked entry and prove the repository refuses
// it, and so the load benchmark can write through the append path directly —
// neither of which is expressible through the curated surface, and neither of
// which should force the curated surface open.
export { AuditLogEntry, GENESIS_HASH } from "./domain/entities/audit-log-entry.js";
export { AuditLogEntryMapper } from "./infrastructure/persistence/prisma-audit-repositories.js";
