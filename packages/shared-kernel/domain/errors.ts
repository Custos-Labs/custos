/**
 * Base class for expected, domain-meaningful failures. Every subclass
 * carries a stable machine-readable `code` (safe to branch on in client code
 * or translate for i18n, unlike `message`) and an `httpStatusHint` the
 * interface layer can use without re-deriving it from the error type.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatusHint: number;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }

  /**
   * `Error` instances don't serialize usefully with `JSON.stringify` by
   * default (`message` is a non-enumerable own property in V8) — `toJSON`
   * gives every domain error a predictable wire shape.
   */
  toJSON(): { code: string; message: string; httpStatusHint: number } {
    return { code: this.code, message: this.message, httpStatusHint: this.httpStatusHint };
  }
}

/** A request failed input validation. */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatusHint = 400;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;

  constructor(message: string, fieldErrors: Readonly<Record<string, readonly string[]>> = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }

  override toJSON(): ReturnType<DomainError["toJSON"]> & {
    fieldErrors: Readonly<Record<string, readonly string[]>>;
  } {
    return { ...super.toJSON(), fieldErrors: this.fieldErrors };
  }
}

/** The requested resource does not exist (or the caller may not know it does). */
export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
  readonly httpStatusHint = 404;
}

/** The request conflicts with the current state of the resource (e.g. a duplicate). */
export class ConflictError extends DomainError {
  readonly code = "CONFLICT";
  readonly httpStatusHint = 409;
}

/**
 * The caller is authenticated but is not allowed to perform the requested
 * action on the requested resource.
 *
 * Distinct from {@link AuthenticationError} (401, "I don't know who you
 * are") and from {@link NotFoundError} (which some flows use instead of this
 * one, deliberately, to avoid confirming a resource exists to a caller who
 * shouldn't see it — see the id-vs-existence note on each port that makes
 * that choice). Use `AuthorizationError` when the resource's existence is
 * not itself sensitive and the caller already knows what they asked for,
 * e.g. "these are not your sessions" — the caller supplied their own user
 * id and just isn't allowed to read someone else's list.
 */
export class AuthorizationError extends DomainError {
  readonly code = "AUTHORIZATION_FAILED";
  readonly httpStatusHint = 403;
}

/**
 * Authentication failed, and the response deliberately does not say why.
 *
 * The one domain error whose *message* is part of its security contract. A
 * caller that can tell "no such user" from "wrong password" can enumerate
 * accounts: post an email, read the error, learn whether it is registered.
 * That turns a password-guessing problem into a much cheaper two-step one,
 * and leaks membership of whatever the service is — which for a verification
 * or compliance product is often the more sensitive fact.
 *
 * So there is no `UserNotFoundError` for a login path to reach for, and no
 * field errors. One error, one message, every failing reason.
 *
 * 401 rather than 403: the credentials presented were not accepted. 403 would
 * say they were understood and refused, which is a different conversation.
 *
 * See `docs/security/authentication-flows.md`.
 */
export class AuthenticationError extends DomainError {
  readonly code = "AUTHENTICATION_FAILED";
  readonly httpStatusHint = 401;

  constructor(message = "Invalid email or password.", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Authentication was refused because the credential is temporarily locked
 * after repeated failures.
 *
 * Distinct from {@link AuthenticationError} so the application layer, audit
 * log and metrics can tell a lockout from an ordinary bad password — those
 * are very different operational signals, and collapsing them would make a
 * credential-stuffing campaign look like ordinary user error.
 *
 * **The HTTP layer deliberately renders it identically to
 * {@link AuthenticationError}**: same 401, same body, same message. That is
 * not an oversight in the mapping. Lockout state exists only for accounts
 * that exist, so any observable difference — a 423, a `Retry-After`, a
 * different code — turns "fail five times and watch what changes" into an
 * account enumeration oracle, undoing what `AuthenticationError` is for.
 *
 * The distinction is therefore internal by design: visible in logs, invisible
 * on the wire. See `docs/security/authentication-flows.md`.
 */
export class AccountLockedError extends DomainError {
  readonly code = "AUTHENTICATION_FAILED";
  readonly httpStatusHint = 401;

  constructor(message = "Invalid email or password.", options?: ErrorOptions) {
    super(message, options);
  }
}
