# Backend API and compiler consumer

The API requires `DATABASE_URL`, `REDIS_URL`, and a `JWT_SECRET` of at least
32 characters. `STORAGE_ROOT` defaults to `./data`. Apply the backend Prisma
migrations before starting the API with `npm --workspace backend start`.

`POST /api/templates/:id/generations` accepts `{ "data": { ... } }` as JSON.
For per-job resources, send multipart form data with a `data` field containing
the JSON object and one file field per `@resource(alias)` in the template.
The authenticated owner can read status and history through `GET /api/jobs/:id`
and `GET /api/jobs`, and download a successful PDF through
`GET /api/jobs/:id/pdf`. Admin and owner roles do not bypass job ownership.

## Queue consumer

Start the separate consumer with `npm run worker` from the repository root.
It requires `DATABASE_URL` and `REDIS_URL`; it does not need the API's JWT secret.
The API queues only a job UUID. The consumer atomically claims it, launches the
compiler, validates the manifest, moves the named PDF into `pdfs/<job UUID>/`,
and records the terminal status. Snapshots and temporary output are removed;
PDFs and job history have no automatic expiry, including after template deletion.
Compiler diagnostics remain in private worker logs. Public errors describe the
failure without exposing paths or raw TeX diagnostics.

Run the consumer as **UID/GID `65532:65532`**, matching the compiler. Provision
the shared `STORAGE_ROOT` for that identity. Run the API with the same storage
identity so its private job snapshots and resource uploads can be read and
removed by the consumer and its retained PDFs can be read by the API. Separate
API/worker containers can use the same numeric UID while only the worker gets
Docker access. Do not give the API a Docker socket. Keep storage outside any
static web root. Job and retained-PDF directories use mode `0700`.

The worker needs a Docker daemon with the `runsc` runtime and the prebuilt image
from [the compiler instructions](../compiler/README.md). `COMPILER_IMAGE` defaults
to `automemorydoll-compiler:local`. Input and output paths must exist at the same
absolute paths on the Docker daemon host; this matters when the worker itself
runs inside a container. Job output and retained PDFs must share a filesystem
for atomic publication. Rootless Docker UID mapping needs separate deployment
verification; the numeric host UID requirement assumes a rootful daemon.

Each compiler run uses gVisor, no network, a read-only root and input, dropped
capabilities, no new privileges, and only writable output and private temporary
mounts. The full TeX bundle is already inside the read-only image. The launcher
never falls back to another runtime. It enforces these limits:

| Variable                | Development default | Production |
| ----------------------- | ------------------- | ---------- |
| `COMPILER_CPUS`         | `1`                 | Required   |
| `COMPILER_MEMORY_MB`    | `512`               | Required   |
| `COMPILER_PIDS`         | `64`                | Required   |
| `COMPILER_WALL_TIME_MS` | `60000`             | Required   |

Memory swap is capped at the same memory value. A timeout kills the Docker CLI
and forcibly removes its named container. With `NODE_ENV=production`, missing or
invalid limits prevent startup. Production values still need owner approval;
development defaults are not production recommendations. Every consumer sharing
a queue/storage root must use the same wall-time setting.

Workers do not automatically retry failed compilation. Reconciliation also fails
queued database rows whose BullMQ delivery has failed before a claim, so they
do not remain silently queued. Every 30 seconds and on
startup, reconciliation fails `generating` jobs older than the configured wall
time plus 60 seconds of recovery grace, stops their containers, and removes
output and any unpublished PDFs. It also cleans leftovers for terminal jobs,
preserving successful PDFs. Compare-and-set updates prevent repeated delivery
and late results from changing terminal status. SIGTERM/SIGINT stop accepting
work and wait for the active bounded compilation to finish.

## Verification

Run `npm test` and `npm run typecheck` at the repository root. PostgreSQL/Redis
integration tests require `TEST_DATABASE_URL` and `TEST_REDIS_URL` pointing at
dedicated test services.

The real compiler integration test is opt-in and never substitutes another
runtime when gVisor is unavailable. Run it as UID/GID 65532 with Docker access:

```sh
RUN_COMPILER_INTEGRATION=1 npm --workspace backend test -- container-integration.test.ts
```

Set `COMPILER_TEST_ROOT` to a writable directory visible at the same absolute
path to the daemon if `/tmp` is not shared. This check requires the prebuilt
compiler image and verifies a PDF plus failed-compilation cleanup under runsc.

Cleanup currently scans retained terminal job history on each reconciliation.
Its cost grows with history; use a targeted cleanup sweep before high job volumes.
