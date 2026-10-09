# Custos

![Stellar](https://img.shields.io/badge/Stellar-Soroban-7D00FF?logo=stellar&logoColor=white)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Custos is open-source infrastructure for **authentication, authorization,
identity, verification, audit logging, security, and governance** — built to be
production-ready and, at the same time, a complete educational resource for
learning backend engineering, software architecture, and security best practices.

Every subsystem (credentials, sessions, RBAC, audit logging, etc.) is designed as
an independently testable, independently reusable module under `packages/`,
composed together by the HTTP API in `apps/api`.

> **Status:** early, but running. Registration, login, account lockout, email
> verification and password reset work end to end against Postgres, and the
> audit log is anchored to Stellar. 70 of 500 planned issues are complete — see
> [Roadmap](#roadmap). Sessions (Phase 05) are the next milestone and the
> current limitation: login authenticates a user but does not yet issue a token.

## Table of Contents

- [Why Custos](#why-custos)
- [Verifiable audit logging on Stellar](#verifiable-audit-logging-on-stellar)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Security](#security)
- [Contributing](#contributing)

## Why Custos

Most auth/identity building blocks are either a SaaS you pay for and can't audit,
or a snippet you copy-paste and never fully understand. Custos aims to be neither:
a codebase you can read end to end, run yourself, and learn real architecture and
security practice from — while still being solid enough to build on.

## Verifiable audit logging on Stellar

Custos's audit log is **hash-chained** — every entry commits to its
predecessor, so altering or removing one breaks every hash after it.

That alone is weaker than it sounds, and Custos says so rather than claiming
otherwise. An attacker with write access to the database can rewrite the chain
from any point and re-derive every subsequent hash; the result is internally
consistent and indistinguishable from the truth. Hash chaining makes a log
tamper-**evident to someone already holding an earlier hash**. It does not make
it tamper-**proof**.

Stellar is what closes that gap. The chain's head hash is committed to a
Stellar transaction's `MEMO_HASH` — 32 bytes, exactly the size of a SHA-256
digest, so the hash goes in whole. Rewriting history now also requires altering
a public ledger the operator does not control.

The property that matters is **independent verifiability**: an auditor, a
regulator, or a suspicious user can check the log against the ledger with no
access to, and no trust in, the operator's systems.

### Try it — no database, no configuration

```bash
pnpm install
pnpm --filter @custos/audit demo
```

(The demo builds the packages it needs first, so this is genuinely the whole
setup — no database, no keys, no `.env`.)

It funds a throwaway testnet account from friendbot, records audit events,
chains them, anchors the head, then verifies the commitment by reading it back
off the ledger the way a third party would — and confirms a tampered hash is
rejected.

A real run:

```
4. Anchoring the chain head to Stellar
   transaction: 21267a74f69d019fa40c1f93a6953896113ae2ee0e62af35326852a86a07d775
   covers:      3 entries, through sequence 3

5. Verifying the commitment from the public ledger
   ledger commits to the head hash: true

6. Confirming a tampered hash is rejected
   altered hash verifies: false  (must be false)
```

That transaction is on the public testnet ledger:
**[stellar.expert](https://stellar.expert/explorer/testnet/tx/21267a74f69d019fa40c1f93a6953896113ae2ee0e62af35326852a86a07d775)**
— its memo is the audit log's head hash.

### Only the hash

Audit _content_ never leaves the operator's database. Audit records are exactly
the records most likely to contain something sensitive, and a public ledger is
irreversible. A digest proves the records existed unchanged while revealing
nothing about them.

### Honest scope

- **Testnet today.** Mainnet needs KMS-backed key management, funding and
  balance monitoring, and a rehearsed cutover — tracked as issues 190B–190D and
  not yet done.
- **Anchoring is scheduled, not per-entry.** A transaction per login would cost
  a fee and seconds each time and buy little, since the chain already links
  entries; anchoring the head commits to everything beneath it. How often is the
  operator's knob, and it bounds the window for undetected tampering.
- **Ledger-agnostic by construction.** Nothing above the adapter mentions
  Stellar. `HashAnchor` is the port; `StellarHashAnchor` is one implementation.

See `docs/adr/0003-stellar-audit-anchoring.md` for the full rationale.

## Architecture

Custos is a TypeScript pnpm-workspaces monorepo following Clean Architecture and
Domain-Driven Design: domain logic has no dependency on frameworks or databases,
and each bounded context (identity, credentials, sessions, authorization,
verification, audit, governance, notifications) lives in its own package.

Full details: [`docs/adr/0001-monorepo-and-stack.md`](docs/adr/0001-monorepo-and-stack.md)
records the stack decision; a broader architecture guide will grow under `docs/`
as more contexts are built. Every non-trivial architectural decision from here
on gets its own ADR — see [`docs/adr/0000-adr-process.md`](docs/adr/0000-adr-process.md)
for the process.

```
custos/
├── apps/api/        # Fastify HTTP app (composition root)
├── packages/        # Bounded-context packages (domain/application/infrastructure/interface)
├── infra/           # Deployment & infrastructure config
├── docs/            # Guides, ADRs, tutorials
└── tests/           # Cross-package integration/e2e tests
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22.13 or later (required by pnpm 11)
- [pnpm](https://pnpm.io/) 11 or later (`npm install -g pnpm`)

## Quickstart

```bash
pnpm install
pnpm --filter @custos/api dev
```

`pnpm install` also generates the Prisma client, which is platform-specific
and therefore never committed — see
[`docs/guides/database.md`](docs/guides/database.md).

The API starts on `http://localhost:3000` (override with `PORT`). Verify it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Prefer one command and don't want Node/pnpm installed locally at all? Run the
full stack (API + Postgres + Redis) in Docker instead:

```bash
docker compose up
```

See [`docs/guides/docker.md`](docs/guides/docker.md) for details, including
the production image (`apps/api/Dockerfile`), which is a separate,
intentionally different thing from the dev compose stack.

Other useful commands, run from the repo root:

```bash
pnpm build       # build all workspace packages
pnpm typecheck   # typecheck all workspace packages
pnpm test        # run all unit/integration tests
pnpm lint        # lint the whole workspace
pnpm format      # auto-fix formatting with Prettier
```

See [`docs/guides/code-style.md`](docs/guides/code-style.md) for what the
linter checks and why.

## Security

- **Never commit secrets** — keep keys, seed phrases, and `.env` files out of source control.
- **Testnet values have no real-world value**; treat testnet deployments as experimental.
- **Keys never leave the wallet** — signing is delegated to the user's Stellar wallet; the app does not store secret keys.
- Report vulnerabilities per `SECURITY.md` where present rather than opening a public issue.

## Contributing

Custos accepts external contributions through its **bounty programme**: open
issues titled `[Bounty: $X]` carry a reward for a solution that meets their
acceptance criteria. Pick an issue, read the criteria, and post your solution
as a comment on the issue or submit a pull request.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md): the local workflow,
conventions, and quality gates (lint, typecheck, tests) a solution must
satisfy. Drive-by pull requests outside the bounty issues are not reviewed at
this stage — the architecture and foundational tooling are still being laid
down.

## License

[MIT](LICENSE) — see [`NOTICE`](NOTICE) for third-party attributions and
[`docs/guides/licensing.md`](docs/guides/licensing.md) for why MIT.
