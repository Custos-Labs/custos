import { Result } from "@verixa/shared-kernel";

import type { LogoutEverywhere } from "../application/use-cases/logout-everywhere.js";

/**
 * Structurally satisfies `packages/credentials`' `SessionRevoker` port
 * (`revokeAllForUser(userId: string): Promise<void>`) without this package
 * depending on `@verixa/credentials` — TypeScript's structural typing means
 * this class simply *has the right shape*, the same way a real adapter
 * satisfies its port without the application layer importing the adapter's
 * module. See `docs/guides/domain-modeling.md`.
 *
 * Replaces `NoSessionsRevoker` in the composition root now that sessions
 * exist — see `apps/api/src/composition-root.ts` and the doc comment on
 * `NoSessionsRevoker` in `packages/credentials`, which specifically
 * anticipated this becoming a one-line swap.
 *
 * Failures are swallowed rather than surfaced: `SessionRevoker.revokeAllForUser`
 * returns `void`, not a `Result`, because its caller (`ConfirmPasswordReset`)
 * treats it as best-effort cleanup that must never block a password reset
 * from succeeding — a user whose reset otherwise worked should not see it
 * fail because clearing their old sessions hit a transient error. The
 * failure is not silent to *operators*: it's written to stderr, the same
 * place `RecordAuditEvent` writes for the same reason, so it's visible to
 * whoever is watching logs without being visible to the request that
 * triggered it.
 */
export class SessionsPackageRevoker {
  constructor(private readonly logoutEverywhere: LogoutEverywhere) {}

  async revokeAllForUser(userId: string): Promise<void> {
    const result = await this.logoutEverywhere.execute({ userId });
    if (Result.isErr(result)) {
      process.stderr.write(
        `sessions: revokeAllForUser(${userId}) failed: ${result.error.message}\n`,
      );
    }
  }
}
