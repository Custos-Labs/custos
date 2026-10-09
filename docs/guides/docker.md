# Docker

`apps/api/Dockerfile` builds a production image for the API. Because this is
a pnpm workspace — `apps/api` depends on `packages/config` and
`packages/shared-kernel` via `workspace:*` — the build context must be the
**repo root**, not `apps/api/`:

```bash
docker build -f apps/api/Dockerfile -t verixa-api .
docker run -p 3000:3000 verixa-api
curl http://localhost:3000/health
```

For local development with Postgres and Redis, see [Local development
stack](#local-development-stack) below instead.

## Multi-stage build

The Dockerfile has four stages:

1. **`base`** — Node 22 (Alpine) with pnpm enabled via Corepack. Nothing else.
2. **`deps`** — copies only `package.json` files (root + every workspace
   package) and the lockfile, then runs `pnpm install --frozen-lockfile`.
   Docker layer caching means this expensive step is skipped entirely on
   rebuilds where only application code changed, not dependencies.
3. **`build`** — copies the actual source and compiles `apps/api` and its
   workspace dependencies (`pnpm --filter @verixa/api... run build`), then
   runs `pnpm deploy /out --prod` — a pnpm feature purpose-built for this:
   it bundles `apps/api` plus its _resolved_ (real files, not symlinks)
   workspace dependencies — compiled `dist/` included — into one
   self-contained directory. That directory has everything needed to run,
   and nothing else from the monorepo.
4. **`runtime`** — a fresh, minimal `node:22-alpine`, with only `/out` from
   the `build` stage copied in. No pnpm, no TypeScript, no dev dependencies,
   no monorepo source — just the deployed bundle and a Node runtime.

Only the `runtime` stage ships. Everything in `base`/`deps`/`build` (the
lockfile, every package's source, the TypeScript compiler, `devDependencies`)
exists purely to _produce_ the final image and is discarded — the shipped
image doesn't carry any of it, which keeps it small and reduces its attack
surface (nothing to exploit that was never even in the final layer).

## Why the container doesn't run as root

The runtime stage creates and switches to an unprivileged `verixa` user
before `CMD` runs. Containers are **process isolation, not a security
boundary on their own** — if the containerized process is root and an
attacker finds a container-escape vulnerability (a kernel bug, a
misconfigured volume mount, a Docker daemon misconfiguration), they land as
root on the host, not as some unprivileged user. Running as a non-root user
by default costs nothing here and closes off that entire escalation path;
it's one of the most common, easily-avoided container misconfigurations in
real-world deployments.

## Verifying the image in CI

`.github/workflows/ci.yml`'s `docker` job builds the image, starts a
container from it, polls `/health` until it responds (or times out and fails
with the container logs attached), and asserts `docker exec ... whoami`
returns something other than `root`. This is the same three-part acceptance
criteria as the issue that introduced the Dockerfile: **builds, serves
`/health`, doesn't run as root** — verified as actual behavior, not just
"the Dockerfile looks right."

## Local development stack

Before starting the stack on a fresh clone, prepare a `.env` file from the
example template and populate the two secrets required by the API:

```bash
cp .env.example .env
# Generate local secrets:
# - SESSION_ACCESS_TOKEN_SECRET: openssl rand -base64 48
# - MFA_ENCRYPTION_KEY: openssl rand -base64 32
```

For convenience in purely ephemeral local development, `docker-compose.yml` also
provides fallback dev defaults for these keys if `.env` is omitted.

Start the stack:

```bash
docker compose up
```

brings up three containers:

- **`api`** — the API in watch mode (`tsx watch`), source mounted from the
  repo so edits hot-reload without rebuilding a container.
- **`postgres`** — Postgres 16, `verixa`/`verixa`/`verixa` (user/password/db),
  exposed on `5432`.
- **`redis`** — Redis 7, exposed on `6379`.

`docker compose down` stops everything; add `-v` to also drop the named
volumes (Postgres/Redis data, `node_modules`) if you want a fully clean
slate.

### Why `api` doesn't use `apps/api/Dockerfile`

The production image (above) is intentionally minimal: no source, no
TypeScript compiler, no dev dependencies, and it runs pre-built `dist/`
output. None of that supports hot-reload — there's no source in the image to
watch, and rebuilding the image on every save would be far too slow for
inner-loop development. So `docker-compose.yml` instead runs a plain
`node:22-alpine` container with the repo bind-mounted in and `pnpm --filter
@verixa/api run dev` (`tsx watch`) as its command.

This isn't a contradiction of **dev/prod parity** (the [12-factor
app](https://12factor.net/dev-prod-parity) principle that dev and prod
environments should be as similar as possible, to catch environment-specific
bugs before production instead of after) — parity is about _environment_:
same Node version, same OS base image, same Postgres/Redis versions, same
config-via-environment-variables mechanism (`@verixa/config`). All of that is
identical between the compose dev container and the production image. What
differs is _tooling for iteration speed_ — hot-reload vs. a slim artifact —
which 12-factor doesn't ask you to sacrifice; it asks you not to let
_backing services_ (databases, caches, queues) or _runtime versions_ drift
between dev and prod, which this setup deliberately avoids.

### `node_modules` volumes

`docker-compose.yml` gives every `node_modules` directory in the workspace
(root, `apps/api`, `packages/config`, `packages/shared-kernel`) its own named
volume, separate from the bind-mounted source. Two reasons:

1. **Native binaries aren't portable across OS/architecture.** Some
   dependencies (esbuild, used by `tsx` and Vitest) ship platform-specific
   native binaries. A `node_modules` installed on a Windows or macOS host and
   then bind-mounted into a Linux container (or vice versa) will fail at
   runtime with the wrong binary for the platform.
2. **Bind-mounted `node_modules` is slow**, especially on Windows/macOS Docker
   Desktop, where cross-filesystem I/O for tens of thousands of small files
   measurably slows down module resolution and test runs.

### Manual verification checklist

Automated CI coverage for the compose stack itself is deferred (there's no
managed CI runner cost-effective for a long-lived multi-container stack at
this stage) — until then, verify manually after changing
`docker-compose.yml`:

- [ ] `docker compose up` brings up all three containers without exiting/crash-looping
- [ ] `docker compose ps` shows `postgres` and `redis` as `healthy`
- [ ] `curl http://localhost:3000/health` returns `{"status":"ok"}`
- [ ] Editing `apps/api/src/app.ts` (e.g. changing the `/health` response)
      and saving triggers `tsx watch` to reload, visible in
      `docker compose logs -f api`, without restarting the container
- [ ] `docker compose exec api sh -c "nc -zv postgres 5432"` succeeds — the
      API container can reach Postgres by service name
- [ ] `docker compose exec api sh -c "nc -zv redis 6379"` succeeds — the API
      container can reach Redis by service name
- [ ] `docker compose down -v` removes all containers and named volumes cleanly

(Application code doesn't talk to Postgres/Redis yet — that starts in Phase
03 and Phase 05 — so "connects successfully to both" is verified at the
network level for now, via `nc`, not through app behavior.)
