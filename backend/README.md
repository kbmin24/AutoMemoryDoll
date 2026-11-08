# Backend API and compiler consumer

The API, queue consumer, owner setup command, and Prisma commands automatically
load `backend/.env` and `backend/.env.local`. Exported environment variables take
precedence over `.env.local`, which takes precedence over `.env`. Both files are
optional and Git-ignored. Files are resolved relative to `backend/`, regardless
of the working directory; restart a running service after changing them.

For example, create `backend/.env.local` with your local settings:

```dotenv
DATABASE_URL=postgresql://postgres:your-password@localhost:5432/automemorydoll
REDIS_URL=redis://localhost:6379
JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
STORAGE_ROOT=/absolute/path/to/shared/data
PORT=3000
NODE_ENV=development
```

For local HTTP testing, set `NODE_ENV=development` in the backend environment
file. This omits the session cookie's `Secure` flag; `HttpOnly`, `SameSite=Strict`,
and CSRF protection remain enabled. Every other environment, including an unset
`NODE_ENV`, keeps `Secure` enabled and requires HTTPS outside supported localhost
exceptions. Use `NODE_ENV=production` for deployment. Restart the API and clear
any old `amd_session` cookie in the browser before logging in again.

Then run `npm --workspace backend run db:generate`,
`npm --workspace backend run db:migrate:deploy`, and
`npm --workspace backend run create-owner` once before starting the API.
There is no need to source the environment file manually. Automated tests do
not load these backend files; supply test-service variables explicitly.

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
Worker logs contain safe compiler outcome categories, exit codes and timing; raw compiler stderr and template diagnostic text are excluded. Public errors describe the
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

## Logging

The API and consumer share a Winston interface. Each process emits one JSON object
per line to the console and its own rotating files. Errors use stderr; other
levels use stdout. Successful HTTP requests and actions use `info`, rejections
use `warn`, unexpected failures use `error`, and safe phase details use `debug`.
All categories, including action audit events, obey `LOG_LEVEL`.

| Variable              | Default    | Meaning                                                                                                          |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`           | `info`     | `error`, `warn`, `info`, or `debug`                                                                              |
| `LOG_DIR`             | `./logs`   | Absolute path or path relative to the process working directory                                                  |
| `LOG_RETENTION_DAYS`  | `180`      | Positive integer days; expiration uses UTC file dates                                                            |
| `LOG_MAX_FILE_BYTES`  | `20971520` | Positive integer rotation threshold; whole-KB thresholds round down; individual records can exceed the threshold |
| `LOG_MAX_TOTAL_BYTES` | unset      | Optional per-service application-log byte budget, at least `LOG_MAX_FILE_BYTES`; unset disables the cap          |
| `TRUSTED_PROXY_CIDRS` | unset      | Comma-separated trusted proxy IPs/CIDRs; unset trusts no proxies                                                 |

Empty provided settings and invalid values prevent startup without printing their
contents. API and consumer environments can set different thresholds. With npm
workspace commands the working directory is normally `backend/`.

Files rotate at UTC midnight on the next write or maintenance pass, and when the
configured size is reached. Maintenance advances rotation even when no events
are logged, so idle active files cannot bypass retention or the cap. Each service owns a separate directory: `api/`, `consumer/`, or
`owner-cli/` below `LOG_DIR`. Provision the root and service directories for their
service identity with mode `0700`; application log files use `0600`. Existing
insecure or inaccessible directories disable file output and trigger a safe
stderr report. Give UID/GID `65532:65532` a writable log mount for the consumer.
Keep these directories outside public web roots. There must be one writer per
service directory; concurrent setup CLI invocations need separate `LOG_DIR`
values, and future replicas need their own volumes/directories.

Age cleanup runs at startup, rotation, and hourly; with a disk cap it runs every
minute. The cap deletes the oldest closed application logs even before 180 days.
It is a soft budget: buffered writes and an active file can temporarily exceed
it. Cleanup also runs after normal logger drain. The rotation index
`.rotation-audit.json` is not counted toward the application-log cap and retains
suffix history until normal age expiry. Keep it in place across restarts. Cleanup
never intentionally deletes unrelated files or follows symlinks. It uses one
serialized pass per process. A cleanup failure is reported safely; file writes
may continue. A file transport failure disables that transport for the process
lifetime while console logging continues; fix provisioning/disk issues and
restart to recover file output. A single safe stderr fallback report is emitted
per process, independent of the configured level.

Configure trusted proxies by their actual IPs or CIDRs, for example
`TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128` for a local proxy or a narrowly scoped
container-network range when appropriate. This is independent of whether the
proxy is Caddy, Apache, or Nginx. Configure the proxy to handle forwarded headers
correctly and prevent untrusted direct access from its trusted network. Do not
set Express to trust all proxies or rely on a fixed hop count. HTTP and
authentication events include the client IP derived using this policy.

Every request receives a server-generated `X-Request-ID`; incoming request IDs
are ignored. HTTP events use constant route patterns (or `unmatched`), method,
status when available, duration, actor ID when authenticated, and IP. For example:

```json
{"event":"http.completed","message":"http.completed","level":"info","service":"api","timestamp":"2026-11-08T12:00:00.000Z","requestId":"11111111-1111-4111-8111-111111111111","method":"POST","route":"/api/templates/:id/generations","status":201,"durationMs":42,"clientIp":"198.51.100.2"}
{"event":"generation.submitted","message":"generation.submitted","level":"info","service":"api","timestamp":"2026-11-08T12:00:00.000Z","requestId":"11111111-1111-4111-8111-111111111111","jobId":"22222222-2222-4222-8222-222222222222","outcome":"success"}
{"event":"generation.succeeded","message":"generation.succeeded","level":"info","service":"consumer","timestamp":"2026-11-08T12:00:03.000Z","jobId":"22222222-2222-4222-8222-222222222222","durationMs":3000,"outcome":"success"}
```

Find the request ID, follow its `generation.submitted` job ID, and search that
job ID in consumer logs. Queue payloads and database schemas are unchanged.
Action events cover authentication/password changes, account/role management,
template/workspace changes, submissions, generation outcomes, and downloads.
Validated attempted target IDs may appear on rejected actions; this does not
confirm that those resources exist. A committed action can succeed even when the
HTTP connection aborts; action and delivery outcomes are recorded separately.

Never pass request bodies, headers, URLs, query strings, filenames, document
values, cookies, passwords, database connection strings, or arbitrary errors to
logging calls. The shared formatter whitelists fields and fixed event names.
Errors include fixed classifications plus original error messages and stacks.
Arbitrary properties and causes remain excluded. Error events without an
exception include a stack from the logging site. Error messages and stacks can
contain paths, document content, or secrets, and appear in both console and
rotating file output. HTTP responses retain their existing public errors. Raw compiler stderr remains bounded internally for container
cleanup control flow and is never forwarded to either sink. Debug does not relax
these privacy rules. Diagnose compilation failures using the job ID, phase,
exit/timeout facts, and the template available to its authorized owner.

This is an operational audit trail, not a transactional or tamper-proof ledger.
Filtering, file failures, retention/cap eviction, process crashes, and the gap
between a business commit and a log write can leave missing history. Configure
an external console collector if centralized storage across hosts is required;
this change centralizes the programming interface, not a hosted log service.

Startup failures include the original error message and stack in the structured
error record, drain logs, and exit with code 1. When logging cannot initialize,
a stderr JSON fallback includes these diagnostics. Logging infrastructure failures
also include error details in their stderr fallback records.
