# Threat Model: Session & Token Flows

STRIDE-based threat model for `packages/sessions`: issuing a session,
refreshing an access token, logging out (one session or all of them), and
revocation. Companion to `docs/security/authentication-flows.md`, which
covers the credential-guessing threats around proving who you are;
this document covers what happens to the artifact you're handed once you've
proven it, and the different attacker capability that artifact exposes you
to — network interception and replay, rather than password guessing.

Implementation referenced throughout:
`packages/sessions/domain/entities/session.ts`,
`packages/sessions/domain/entities/refresh-token.ts`,
`packages/sessions/infrastructure/jwt-token-signer.ts`,
`packages/sessions/infrastructure/redis-revocation-list.ts`,
`packages/sessions/application/use-cases/*`.

## The two artifacts, and why there are two

A session issues two different bearer credentials with deliberately
different shapes:

|               | Access token                               | Refresh token                          |
| ------------- | ------------------------------------------ | -------------------------------------- |
| Format        | HS256 JWT (`JwtTokenSigner`)               | 256 random bits (`RefreshToken.issue`) |
| Verified how  | Signature + expiry, no database read       | Hash lookup against `token_hash`       |
| Lifetime      | 15 minutes (`SessionExpiryPolicy.default`) | 30 days, single-use per rotation       |
| Revocable how | `RevocationList` deny-list (see below)     | Deleting/marking the row               |

The access token is stateless by design — verifying it costs a signature
check, not a round trip, which is the entire point of using a JWT on a
per-request hot path. The refresh token is the opposite on purpose: it is
presented rarely (once per rotation, roughly every 15 minutes of continuous
use), so a database lookup on that path is cheap, and being able to look it
up is what makes reuse detection (below) possible at all. Neither format
choice is accidental; each is the wrong choice for the other artifact's
threat profile.

## STRIDE

### Spoofing — presenting someone else's session as your own

**Threat.** An attacker who does not hold a valid token forges one, or
tricks the signer into producing one for a session they don't own.

**Mitigation.** Access tokens are HMAC-SHA256 signed
(`JwtTokenSigner.computeSignature`) with a secret
(`SESSION_ACCESS_TOKEN_SECRET`) that has no default anywhere in code — every
environment, including local development, must generate its own (see
`.env.example`). Forging a signature requires the secret; `SigningKeyProvider`
throws at construction if handed an empty one, which is what makes "boot with
no secret configured" a startup failure rather than a silently
signature-less deployment (`apps/api/src/composition-root.spec.ts` asserts
this explicitly). Refresh tokens carry no signature to forge in the first
place — they are looked up by the hash of 256 CSPRNG-sourced bits, so
"spoofing" one means guessing 256 bits, not attacking a scheme.

**Deliberately narrow claim.** `JwtTokenSigner` implements exactly one
algorithm (HS256) and never inspects an `alg` header on the incoming token to
decide how to verify it — there is no dispatch table for an attacker to steer
towards `alg: none` or an asymmetric-key confusion attack, both classic JWT
library vulnerabilities. This is a consequence of hand-rolling the signer
rather than depending on a general-purpose JWT library (see the class's own
doc comment): the entire attack class those libraries spend configuration
flags defending against does not exist here because there is nothing to
misconfigure.

### Tampering — modifying a token's claims without invalidating it

**Threat.** An attacker holding a token modifies `userId` or `sessionId`
inside it, hoping the modified token is still accepted.

**Mitigation.** `verify()` recomputes the HMAC over the received
header+body and compares it, timing-safe, against the signature segment
before ever parsing the payload (`jwt-token-signer.ts`). Any change to
either segment invalidates the signature. There is no claim in the token an
attacker could usefully change without the signature check catching it —
deliberately minimal claims (`sessionId`, `userId`, `iat`, `exp`) mean there
is also no `role`/permission claim whose tampering would need a _separate_
authorization re-check; every authorization decision re-derives current
state from `sessionId`/`userId` rather than trusting anything cached in the
token.

### Repudiation — denying an action was taken from a given session

**Threat.** A session performs an action and its owner later denies it, or
an attacker's use of a stolen session is indistinguishable from the
legitimate owner's.

**Accepted scope, partially out of this package.** `Session` records
`createdAt`, `lastSeenAt`, `ipAddress`, and `userAgent` — enough to show a
user (via `ListActiveSessions`, Issue 095) that a session exists from an
unfamiliar location, and enough for `RefreshTokenReuseDetected` (below) to
carry forensic value. Full non-repudiation of individual _actions_ taken
during a session is Phase 10's audit-logging concern, not this package's:
`packages/sessions` establishes and revokes the session, it does not log
what was done with it. This document's boundary — sessions and tokens, not
the actions they authorize — is deliberate; see Phase 10 for the rest.

### Information Disclosure — leaking a token, or leaking enough to forge one

**Threat A: the database is read by more than intended.** A leaked backup, a
support engineer with production access, a misconfigured read replica.

**Mitigation.** Refresh tokens are stored as a SHA-256 hash
(`RefreshToken.hashToken`), never the raw value — `IssuedRefreshToken`
returns the raw token alongside the entity exactly once, at issuance, and
there is no field on `RefreshToken` capable of holding it afterward (see
`docs/security/token-storage.md`, the general rule this follows). A reader
of the database gets `token_hash` and nothing that can be presented back as
a valid refresh token. `Session` itself holds _no_ token material at all —
by design (see the entity's own doc comment) — specifically so that
`ListActiveSessions` (Issue 095) can return a session summary to a user
without any redaction logic standing between a database row and an HTTP
response; there is nothing sensitive in the row to accidentally leak.

**Threat B: the signing secret leaks.** Anyone holding
`SESSION_ACCESS_TOKEN_SECRET` can forge arbitrary access tokens for
arbitrary users — this is the single highest-value secret in the whole
package, since unlike a leaked refresh token (scoped to one session) it
compromises every session, past and future, until rotated.

**Accepted risk, mitigation planned.** There is exactly one active key
today (`SigningKeyProvider`), read from an environment variable with no
built-in rotation mechanism — rotating it invalidates every outstanding
access token immediately (all fail signature verification against the new
key), which is a denial-of-service against every logged-in user, not a
graceful transition. `SigningKeyProvider`'s `currentSecret()`/`isKnownSecret()`
split exists specifically as the seam Phase 11 lands key rotation on
(accept the old key for verification while only signing with the new one,
until every token issued under the old key would have expired anyway); see
the class's own doc comment. Until then, a leaked secret requires an
out-of-band rotation with a brief availability cost, which is judged
acceptable given `SESSION_ACCESS_TOKEN_SECRET` is never logged, never
included in any error message, and is not a `DATABASE_URL`-style value that
routinely ends up in a connection-string log line.

**Threat C: a token leaks in transit or via a compromised client.**
Out of scope for this document specifically because it's a transport/client
concern rather than something `packages/sessions` can mitigate from the
server side: TLS termination and `Secure`/`HttpOnly` cookie flags (if tokens
are ever delivered as cookies rather than a bearer header) belong to Phase
12's route wiring, not to the token issuance logic here. What this package
_does_ provide for when a token leaks anyway is the next section.

### Denial of Service — exhausting revocation or refresh capacity

**Threat.** Revoking a user's sessions, or an attacker's repeated refresh
attempts, becomes a resource-exhaustion vector.

**Mitigations in place.** `RevocationList` entries carry a TTL capped at the
access token's own remaining lifetime (`RedisRevocationList`, `PEXPIRE`) — an
entry never outlives the token it was blocking, so the deny-list cannot grow
unbounded even under a flood of logout calls; it self-cleans at the same rate
entries are added, bounded by however many sessions are concurrently valid.
`LogoutEverywhere` revokes every active session for a user in one call rather
than requiring one call per session, which keeps "log me out everywhere"
cheap for the legitimate case it exists for.

**Accepted gap.** Nothing in this package rate-limits how often a given
client can call `RefreshAccessToken` or `IssueSession`. A flood of refresh
attempts against a stolen (or brute-forced) refresh token is expensive per
attempt only in the sense of a database round trip, not deliberately
throttled. This is explicitly Phase 15's responsibility — see
`planning/issues/phase-15-rate-limiting.md` — and is a genuine gap in the
system as it stands today, not a mitigation this document is pretending
exists.

### Elevation of Privilege — using a session for more than it was issued for

**Threat.** A session issued for one user is used to act as a different
user, or a session's access token is used past the point the session itself
was revoked.

**Mitigation: rotation with reuse detection.** Every refresh consumes the
presented refresh token (`markUsed`) and issues a new one
(`RefreshAccessToken`). A refresh token that is presented a _second_ time —
`presented.isUsed` already `true` — is not treated as a stale retry. A
legitimate client discards a token the instant rotation replaces it, so a
reused token is the strongest available signal that a copy exists somewhere
the legitimate client doesn't control. The response is disproportionate to
the single token: the _entire session_ is revoked
(`Session.revokeDueToRefreshTokenReuse`), not just the reused token, on the
reasoning that if one link in the rotation chain leaked, every other
credential derived from the same session should be considered suspect too.
This also raises a `RefreshTokenReuseDetected` domain event, giving Phase 10
something to alert on rather than only a silent revocation.

**Mitigation: the revocation deny-list closes the stateless-JWT gap.**
Access tokens being stateless (no database read to validate) is what makes
them fast, but it also means a still-unexpired access token issued _before_
a revocation has no way to know it's been revoked from its own contents
alone — the JWT itself doesn't change when the session it belongs to is
revoked. `RevocationList` exists to close exactly that gap: any consumer
verifying an access token is expected to check `isRevoked(sessionId)`
alongside signature verification, so a revoked session's still-valid-looking
token stops working immediately rather than merely at its next natural
expiry.

**Accepted gap, and the most important one in this document.** As of this
package's current state, nothing in the codebase actually _calls_
`RevocationList.isRevoked()` on an incoming request — the port and its two
adapters (`RedisRevocationList`, `InMemoryRevocationList`) exist, and every
use case that _revokes_ a session correctly writes to it (`Logout`,
`LogoutEverywhere`, the reuse-detection path above), but there is no request
middleware or use case yet that _reads_ it before honoring an access token,
because that request-handling code doesn't exist until Phase 12 wires HTTP
routes. This means that, today, a logged-out or reuse-revoked session's
still-unexpired access token would in fact continue to verify successfully
if presented directly against `JwtTokenSigner.verify()` in isolation — the
deny-list is a promise this package makes available, not yet a check anyone
is required to make. This is an accepted, time-bound gap: Phase 12's route
wiring is the issue responsible for making `isRevoked` a mandatory check on
every authenticated request, and this document exists partly to make sure
that requirement isn't lost between now and then.

**Mitigation: absolute lifetime independent of activity.** A session's
`expiresAt` (30 days from `Session.open`) cannot be extended by refreshing —
only `lastSeenAt` moves on `touch()`. A session that is refreshed
continuously for months still expires at its original 30-day mark, which
bounds how long a single compromise (of a refresh token that was never
detected as reused) can persist, independent of how actively an attacker
uses it to avoid the idle timeout.

**Mitigation: idle timeout independent of absolute lifetime.** Separately, a
session unused for 7 days (`idleTimeoutMs`) is treated as expired regardless
of how much of its 30-day absolute lifetime remains
(`Session.isActive`/`SessionExpiryPolicy.isIdleExpired`). These two limits
are deliberately independent checks rather than one combined rule: absolute
lifetime bounds a session that's kept alive by continuous legitimate use,
idle timeout bounds one that's simply been abandoned (a forgotten logged-in
device) — the same session could be killed by either one first, and neither
being satisfied is required for the other to apply.

## Summary: threat to mitigating issue

| Threat                                         | Mitigation                                | Status                                                                              |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Token forgery                                  | HMAC signing, no `alg` dispatch           | Issue 096/097 (implemented)                                                         |
| Refresh-token guessing                         | 256-bit CSPRNG token, hashed at rest      | Issue 096/097 (implemented)                                                         |
| Claim tampering                                | Signature covers full header+body         | Issue 096/097 (implemented)                                                         |
| Database read leaking tokens                   | Hash-only storage, token-free `Session`   | Issue 096/097 (implemented)                                                         |
| Signing-secret leak                            | No default, fail-fast at boot             | Issue 096/097 (implemented); rotation is Phase 11                                   |
| Refresh-token replay after rotation            | Reuse detection, whole-session revocation | Issue 096/097 (implemented)                                                         |
| Revoked session's access token still verifying | `RevocationList` deny-list                | Port + adapters exist; the request-time check is Phase 12 (accepted gap until then) |
| Unbounded session lifetime                     | Absolute lifetime + idle timeout          | Issue 096/097 (implemented)                                                         |
| Refresh/login endpoint flooding                | Rate limiting                             | Phase 15 (not yet implemented — accepted gap)                                       |
| Action-level non-repudiation                   | Audit logging                             | Phase 10 (out of this package's scope)                                              |

## Related

- `docs/security/authentication-flows.md` — the credential-guessing threats
  this document's mitigations sit downstream of.
- `docs/security/token-storage.md` — the general bearer-token storage rule
  both refresh tokens and every other token type in Verixa follow.
- `planning/issues/phase-05-sessions-tokens.md` — the roadmap issue this
  package implements.
- `planning/issues/phase-11-security-hardening.md`,
  `planning/issues/phase-12-rest-api.md`,
  `planning/issues/phase-15-rate-limiting.md` — where each accepted gap above
  is scheduled to close.
