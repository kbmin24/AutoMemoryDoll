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

`GET /api/templates/:id/resources` returns `{ "aliases": ["logo"] }` for the
user who owns the template, regardless of their account role. It discovers unique
aliases in UTF-8 workspace files using the same token rules as generation.

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

Run the API and consumer as the same dedicated non-root system account.
The consumer validates its actual UID and primary GID and supplies them to Docker
through `--user`, overriding the compiler image's standalone default. Private
job and PDF directories remain mode `0700`. Only the consumer gets Docker socket
access; do not give the API a Docker socket. Keep storage outside any static web
root. This assumes rootful Docker; rootless UID mappings need separate validation.

### Starting services as a named account

From the repository root, run these in separate terminals:

```bash
npm run dev:backend -- automemorydoll
npm run worker -- automemorydoll
npm run dev:frontend
```

The backend workspace also accepts the username directly:
`npm --workspace backend start -- automemorydoll` and
`npm --workspace backend run worker -- automemorydoll`.
The account must already exist and own the configured storage and log directories.
The commands use `sudo setpriv` and may prompt for your sudo password. They use
the same Node executable that is running npm, set `HOME` to the selected account’s
configured home path, and start from `backend/` so both
services read the same environment files and resolve relative paths consistently.
Only the worker receives the Docker socket's supplementary group; the API clears
supplementary groups. Root accounts are rejected when a username is supplied.
Omitting the username preserves startup as the invoking user; the worker still
requires a non-root identity. These commands do not create users, change file
ownership, or grant permanent group memberships.

### Local service account setup

Create an account with an OS-assigned UID/GID, no home directory, and no login
shell (once, on this Linux host):

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin automemorydoll
```

Stop existing API/consumer processes before migrating ownership. From this
checkout, provision its configured storage and default log paths:

```bash
service_uid=$(id -u automemorydoll)
service_gid=$(id -g automemorydoll)
sudo mkdir -p (AutoMemoryDoll Path)/data (AutoMemoryDoll Path)/backend/logs
sudo chown -R "$service_uid:$service_gid" (AutoMemoryDoll Path)/data (AutoMemoryDoll Path)/backend/logs
sudo chmod 700 (AutoMemoryDoll Path)/data (AutoMemoryDoll Path)/backend/logs
sudo setfacl -m "u:$service_uid:--x" (Parent path)
```

Use the actual configured paths if `STORAGE_ROOT` or `LOG_DIR` differs. The
ownership migration preserves stored templates, jobs, and PDFs. Existing service
log directories must have mode `0700`, and log files mode `0600`. Run backend
commands that access this private state under the service identity; a CLI under
a different account needs its own private `LOG_DIR`.

The service account needs search access through each parent of the checkout,
Node installation, storage, and logs. The ACL command above grants traversal
through this host's private home without granting directory listing or write
access. Provision any other private parents similarly. The logger requires
its root and service directories to be owned by its process identity with mode
`0700`; shared group write access alone is insufficient.

File-log permission errors fall back to console logging and do not themselves
stop generation. Look for subsequent `generation.execution_failed` or
`compiler.failed` events. Interrupted jobs are failed by reconciliation; submit
a fresh job after restarting rather than expecting an automatic retry.

When the compiler produces no `result.json`, the consumer records a
`compiler.failed` event with the Docker exit code before failing the job. Check
the selected image, configured runtime, Docker socket access, and bind-mount
paths under the same service identity. Raw compiler stderr is not added to logs.
The consumer removes failed job snapshots and output directories, so an empty
`data/jobs` after a terminal failure is expected; the failed job record remains
in the database.

The worker needs a Docker daemon with the `runsc` runtime and the prebuilt image
from [the compiler instructions](../compiler/README.md). `COMPILER_IMAGE` defaults
to `automemorydoll-compiler:local`. Input and output paths must exist at the same
absolute paths on the Docker daemon host; this matters when the worker itself
runs inside a container. Job output and retained PDFs must share a filesystem
for atomic publication. Rootless Docker UID mapping needs separate deployment
verification; the numeric host UID requirement assumes a rootful daemon.

An installed `runsc` executable must also be registered with the Docker daemon.
If `docker info` lists only `runc`, register the existing installation and reload
Docker, following the [official gVisor installation guide](https://gvisor.dev/docs/user_guide/install/):

```bash
sudo runsc install
sudo systemctl reload docker
sudo docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}'
```

The runtime list must include `runsc`. Do not substitute `runc` for compiler jobs.

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
runtime when gVisor is unavailable. Run it under a non-root service identity with Docker access:

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

| Variable              | Default         | Meaning                                                                                                          |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`           | `info`          | `error`, `warn`, `info`, or `debug`                                                                              |
| `LOG_DIR`             | `./logs`        | Absolute path or path relative to the process working directory                                                  |
| `LOG_RETENTION_DAYS`  | `180`           | Positive integer days; expiration uses UTC file dates                                                            |
| `LOG_MAX_FILE_BYTES`  | `20971520`      | Positive integer rotation threshold; whole-KB thresholds round down; individual records can exceed the threshold |
| `LOG_MAX_TOTAL_BYTES` | unset           | Optional per-service application-log byte budget, at least `LOG_MAX_FILE_BYTES`; unset disables the cap          |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1,::1` | Comma-separated trusted proxy IPs/CIDRs; overrides the loopback defaults                                         |

Empty provided settings and invalid values prevent startup without printing their
contents. API and consumer environments can set different thresholds. With npm
workspace commands the working directory is normally `backend/`.

Files rotate at UTC midnight on the next write or maintenance pass, and when the
configured size is reached. Maintenance advances rotation even when no events
are logged, so idle active files cannot bypass retention or the cap. Each service owns a separate directory: `api/`, `consumer/`, or
`owner-cli/` below `LOG_DIR`. Provision the root and service directories for their
service identity with mode `0700`; application log files use `0600`. Existing
insecure or inaccessible directories disable file output and trigger a safe
stderr report. Give the configured service identity a writable private log mount for the consumer.
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

## Automatic template previews

Successful template creation and saved workspace/data-shape changes schedule a
preview after a 30-second quiet period. New saves replace delayed work; edits
during a run retain one follow-up. Display-name-only/unchanged-shape updates do
not schedule work. Preview jobs share `pdf-generation` with ordinary jobs but
have priority 10; ordinary jobs retain their higher default priority. Keep one
consumer at concurrency 1. Priority never interrupts a running preview, and
continuous document demand can delay/starve previews.

Previews compile saved sample values, never user document data: number `1`, text
`Loream Ipsum`, boolean `true`, and one fixed Lorem Ipsum paragraph for longtext,
including optional fields. Templates without a shape use `{}`. Required per-job
resource uploads make the new preview unavailable; no sample files are invented.
A previous successful image remains visible if generation or conversion fails.
There are no automatic retries or user-visible preview jobs/history records.

Files live at `<STORAGE_ROOT>/previews/<template UUID>/preview.webp`. Each holds
only the first page, fitted within 768 × 768 pixels at WebP quality 80. Images
are replaced atomically, and deleted with their template; user-generated PDFs
retain their existing lifecycle. Private intermediate runs live under
`preview-runs/<run UUID>/` and are removed after completion. Consumer startup
stops leftover preview containers before removing orphan runs, without retrying.
The API and consumer must share private read/write access to these directories.

`GET /api/templates/:id/preview` requires the template owner's authenticated
session, including for administrator/owner-role accounts. It serves WebP with
`Cache-Control: private, no-store`, or 404 when unavailable. Do not publicly map
the storage directory. Template cards request this endpoint and show the existing
unavailable placeholder on image errors; reload/re-enter the list to see new
images. There is no live polling or template DTO change.

Snapshot copies and saves use a shared filesystem `flock` guard plus the same
PostgreSQL template row lock across API and consumer processes, including
data-shape reads. Both are released before compilation and queue I/O. The host
requires util-linux `flock` (the service launcher already uses util-linux
`setpriv`). Lock files live in private `template-locks/<template UUID>.lock` and
must not be unlinked while services run; retaining their inodes prevents split
locks. The file guard remains held until filesystem work settles even if a
PostgreSQL transaction times out. Publication and destructive deletion occur
only after transaction completion is confirmed, while that guard remains held. Separate saves are still separate operations; the
quiet period reduces capture of unfinished edits. Lock wait is bounded at five
seconds and the operation transaction at sixty seconds; failures are reported
rather than publishing an unconfirmed snapshot.

### Rollout and one-time backfill

1. Rebuild the existing compiler image with its Poppler/WebP tools; verify the
   offline runsc smoke tests described in `compiler/README.md`.
2. Deploy the updated consumer before enabling API preview scheduling. Continue
   running only one consumer. Then deploy the updated API and frontend.
3. Ensure shared storage/private service identity permissions and Redis
   persistence are configured. There is no database migration or availability
   column. The additional PostgreSQL row locks do not store scheduling state.
4. Queue missing previews for existing active templates once:

   ```sh
   npm run previews:backfill -- <service-user>
   ```

   The root command forwards the username to the backend launcher. It clears
   supplementary groups; this CLI does not need Docker socket access. Omitting
   the username runs under the invoking identity, which still needs storage,
   database and Redis access. It loads the existing backend environment files.

Backfill pages 100 active template IDs at a time, skips existing images and uses
non-replacing deduplication so pending/active saved-edit jobs stay intact. A
partial failure exits nonzero; rerun the command to schedule remaining missing
previews. It does not run automatically on restart.

Scheduling is best effort after a completed save. A Redis outage does not undo
the saved content, but may miss its preview update until another saved change.
Pending updates survive only according to Redis persistence. Preview errors do
not change ordinary document outcomes; failed replacements retain the old image.

Real concurrency suites use isolated test schemas/queue names:

```sh
TEST_DATABASE_URL=<disposable-postgres-url> npm --workspace backend test -- template-lock-integration.test.ts
TEST_REDIS_URL=<disposable-redis-url> npm --workspace backend test -- preview-queue-integration.test.ts
```

They skip explicitly without their service URLs. The existing opt-in
`RUN_COMPILER_INTEGRATION=1` suite now also verifies container preview mode;
run it as the non-root consumer identity with the rebuilt image and Docker
access. Mocked Docker argument tests do not replace this check.
