# Contributing to Verixa

Verixa isn't yet open for external contributions — the initial architecture
and foundational tooling are still being laid down (see the roadmap
referenced from the main README). This document covers the local developer
workflow for the maintainers doing that early work, and will grow into full
contribution guidelines before the project opens up.

## Security

Found a security issue? Do not open an issue or PR for it — report it privately per [`SECURITY.md`](SECURITY.md).

## Getting started

See the [README quickstart](README.md#quickstart) for prerequisites and the
core `pnpm` commands (`build`, `typecheck`, `test`, `lint`, `format`).

## Editor setup

Opening the repo in VS Code prompts you to install the recommended
extensions in `.vscode/extensions.json` (ESLint, Prettier, EditorConfig).
`.editorconfig` normalizes indentation and line endings (LF) across editors
and operating systems — without it, a contributor on an editor that defaults
to CRLF or tabs produces diffs that are noisy with whitespace churn on every
line they touch, obscuring the actual change. EditorConfig fixes this at the
source (the editor itself respects it while you type) rather than relying on
Prettier to clean it up after the fact.

## Local git hooks

Running `pnpm install` sets up a `pre-commit` hook (via
[Husky](https://typicode.github.io/husky/)) that runs automatically on every
`git commit`:

1. **[lint-staged](https://github.com/lint-staged/lint-staged)** runs ESLint
   (with `--fix`) and Prettier against only the files you staged — not the
   whole repo — auto-fixing what it can and re-staging the result. If an
   issue can't be auto-fixed (e.g. a real lint error like `no-explicit-any`),
   the commit is blocked with the error printed to your terminal.
2. **`pnpm typecheck`** then runs across the whole workspace. This one isn't
   scoped to staged files — TypeScript needs full-program context to type-check
   correctly (a change in one file can break a caller in another), so there's
   no meaningful way to "typecheck only the staged files."

If the hook blocks your commit, fix what it reports and commit again — it
doesn't skip or bypass anything you'd need to fix eventually anyway.

### Why a local hook, not just CI

This is a **shift-left** quality gate: catching a problem at the moment you
create it (locally, in seconds) is cheaper than catching it after a push (in
CI, minutes later, often after you've mentally moved on) or after a review
comment (after someone else's time is spent noticing it). The hook and CI
intentionally run the _same_ commands (`eslint`, `prettier --check`,
`tsc --noEmit`) — the hook is a fast local preview of what CI will enforce
anyway, not a separate set of rules.

### Tradeoffs

Local hooks aren't a replacement for CI — they're a convenience layered on
top of it:

- A hook can be bypassed (`git commit --no-verify`), skipped by contributors
  who never ran `pnpm install`, or simply not exist yet on a fresh clone
  before the first install finishes. CI is the actual, unskippable gate;
  Phase 19 adds a CI job that runs the same checks so nothing merges without
  them regardless of what happened locally.
- Hooks add friction to every commit, which is the point (catching issues
  early) but also a real cost — keeping the hook fast (staged-files-only
  linting, not a full test suite) matters so it doesn't get reflexively
  bypassed out of impatience.

## Commit messages

See [`docs/guides/conventional-commits.md`](docs/guides/conventional-commits.md)
— commit messages are linted locally and in CI.

## Issue and PR templates

Opening a PR pre-fills [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
(linked issue, description, testing notes, a pre-merge checklist); opening an
issue offers [`.github/ISSUE_TEMPLATE/bug_report.md`](.github/ISSUE_TEMPLATE/bug_report.md).
These exist to front-load the information a maintainer needs to triage or
review — without them, that information gets pulled out one comment at a
time, which costs more of a maintainer's time, in public, than asking for it
up front in a template. [`.github/CODEOWNERS`](.github/CODEOWNERS) defines
who's automatically requested for review.
