# Quarantined packages

`packages/sessions` and `packages/verification` do not build.
Their `build`, `typecheck`, `test` and `lint` scripts are deliberately no-ops,
and eslint skips them, so the rest of the repository — and the open pull
request queue — can be verified and merged.

**No contributor's work has been deleted.** Every file is still in the
repository, exactly as merged.

## What happened

These packages were not broken by a bug. They were broken by merges.

A scan of the repository found **24 files** sharing one signature:

- unbalanced braces,
- the same class or interface declared two or three times,
- a second block of `import` statements starting partway down the file.

That is what a conflict resolved as "keep both sides" looks like. One file had
three complete copies of the same entity. Another had a concrete class and an
interface of the same name. `packages/sessions/index.ts` contained **four**
versions of the public API concatenated, with 14 duplicate export names.

Some files were also truncated to one-line stubs by a single commit
(`b56b63a`), and in one package template literals arrived with their backticks
replaced by backslashes, so `` `active` `` became `\ctive` and an
`otpauth://` URI no longer parsed.

## Why these are not simply fixed

The syntax damage is repairable, and was repaired — that is how the deeper
problem became visible. Underneath it, these packages contain **two or three
different designs for the same thing**, each with its own use cases and tests:

- `TotpAlgorithm` exists as a port that six use cases inject, and as a
  concrete class verified against the RFC 6238 test vectors.
- `packages/sessions` cannot be recovered file-by-file: each file's last clean
  revision is from a different point in history, so restoring them
  individually produces a package whose parts no longer agree. Doing so left
  102 type errors that are all version-skew, not logic.

Choosing one design means rewriting other contributors' use cases and tests.
That is a maintainer decision about direction, not a merge conflict, and it
should not be made silently while unblocking unrelated work.

## The actual root cause

`master` had **no branch protection**. Nothing required CI to pass before a
merge, so red pull requests landed and compounded on each other. Every one of
the 24 damaged files traces back to a merge that was never verified.

Fixing the packages without fixing that would just rebuild the same wreck.

## How to lift a quarantine

1. Pick one design per concept and delete the others.
2. Make the use cases and specs agree with the chosen entity.
3. Restore the real scripts in that package's `package.json`.
4. Remove it from the `ignores` list in `eslint.config.mjs`.
5. Confirm `pnpm build`, `pnpm test` and `pnpm lint` pass from a clean clone.

Several open pull requests rebuild parts of these packages properly. Merging
those — with CI green — is likely to be a faster route than reconciling the
current state by hand.

## Lifted: `packages/mfa`

`packages/mfa` was released from quarantine on 2026-10-04. Reconciling it was
the work the section above describes: one `MfaMethod` was kept — the
props-object aggregate, because it was the only one carrying the lockout and
replay state the TOTP use cases call for — and the others were deleted, with
the specs made to agree. What remained afterwards was ordinary cleanup:

- `vitest.config.ts` declared `name` **twice**, as `@verixa/identity` and then
  `@verixa/credentials`, so this package's 81 tests were reported under another
  package's name. The duplicated key is the same "keep both sides" damage.
- `as any` on both halves of the Prisma `upsert`. The mapper's row type already
  matched the schema exactly, so the casts were suppressing nothing — except
  any future drift between the two.
- `JSON.parse` assigned straight to `string[]` when reading stored backup-code
  hashes, so valid JSON of the wrong shape became a wrongly-typed array and
  failed later, inside the verification loop, looking like a hashing fault.
- Test doubles declared `async` with nothing to await, which is why the rule was
  turned off wholesale rather than satisfied.

One **security fix** came out of it. `infrastructure/crypto/encryption.ts` fell
back to `Buffer.alloc(32, 1)` whenever `MFA_ENCRYPTION_KEY` was unset — and the
variable was set nowhere in the repository: not in `.env.example`, not in the
config package, not in CI. Every TOTP secret would have been encrypted at rest
under a constant key visible in the source, with nothing logged or thrown to
reveal it. `encrypt` now refuses to run without a key and validates its length,
and `encryption.spec.ts` holds the regression test.

The package now builds, typechecks, lints with zero errors, and passes 90 tests
at 95% statement coverage.
## Lifted: `packages/mfa` (2026-10-04)

Released from quarantine. Kept as the worked example for the other two, because
the interesting part was not the syntax repair.

**One design was chosen.** `MfaMethod` survives as the props-object aggregate,
because it was the only version carrying the lockout and replay state the TOTP
use cases need. The others were deleted.

**The one real collision was `recordUse`.** TOTP called
`recordUse(matchedStep, now)`, protecting against replay by refusing a step not
strictly greater than the last consumed one -- clock-drift tolerance means a
single code is valid across several seconds. WebAuthn called `recordUse(now)`,
because its replay protection is the authenticator's monotonic `signCount`,
which lives on `WebAuthnCredential` and is where clone detection reads it.

Neither caller was wrong, so neither was forced into the other's shape:

- `recordUse(now)` records a success and clears the failure counter, with no
  replay semantics of its own.
- `recordTotpUse(matchedStep, now)` adds the step check, then delegates. The
  step is validated before anything mutates, so a rejected replay leaves the
  method untouched.

`createActive` was added for the same reason. TOTP enrolls as `pending` and is
confirmed by a first valid code, because the server cannot otherwise know the
user stored the secret. WebAuthn has no equivalent: the registration ceremony
verifies an attestation before anything persists.

**A security bug was found underneath.** `infrastructure/crypto/encryption.ts`
fell back to `Buffer.alloc(32, 1)` when `MFA_ENCRYPTION_KEY` was unset -- and
the variable was set nowhere in the repository. Every TOTP secret would have
been encrypted at rest under a constant visible in this source tree, with
nothing thrown or logged. `encrypt` now refuses to run without a key and
validates its length.

**`docs/security/mfa-design.md` held three concatenated documents.** They
covered different ground -- WebAuthn, TOTP, and step-up/backup-codes/policy --
rather than contradicting each other, so all three became sections of one
document. Not every concatenation is a conflict of substance; check before
choosing.

**`index.ts` held two versions**, one wildcard and one curated. The curated form
was kept: `export *` makes the public surface whatever the files happen to
contain, which is how internals become someone else's dependency by accident.

The package now builds, typechecks, lints with zero errors, and passes its
suite at 93% statement coverage against a 90/90/85/85 gate.

## What is still verified

Everything else: `shared-kernel`, `config`, `database`, `identity`,
`credentials`, `audit`, `authorization`, `mfa`, `stellar-anchor`, `apps/api` and
the integration suite all build, typecheck, lint and test.
