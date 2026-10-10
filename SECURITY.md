# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately via GitHub's vulnerability reporting for this repository:

**https://github.com/Custos-Labs/custos/security/advisories/new**

The report goes to the maintainers only — never to a public thread.

Please include:

- What you found and why it matters. The bar is impact on authentication, authorization, audit-log integrity, or tenant isolation — the threat-model documents in `docs/security/` show how the maintainers reason about these.
- Steps to reproduce, or a minimal proof of concept.
- The commit SHA (or release tag) you tested against.

## Scope

**In scope:** `apps/api`, every package under `packages/`, and the local development stack (`docker-compose.yml`, `scripts/`, `.env.example`).

**Out of scope:** `planning/` and `docs/` prose (a typo or broken link belongs in a regular issue, not a security report), and third-party dependencies without a demonstrated exploitable path through this codebase.

## Ground rules

- Do not test against live deployments or real user accounts — reproduce locally with `docker compose up`.
- Do not exfiltrate data beyond what proves the finding, and delete anything you touched.
- Give the maintainers a chance to fix before any public disclosure.

## What to expect

- **Acknowledgement within 5 business days** of a private report.
- We will tell you whether we consider the report in scope, and keep you updated as a fix is developed.
- Once a fix is released, you are welcome to publish a write-up — please coordinate timing with us so users can upgrade first.
