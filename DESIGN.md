# AutoMemoryDoll design record

This document records decisions made with the project owner and identifies work that remains undecided. It is not an implementation plan. Do not infer approval of a technology or feature merely because it appears in the context section.

## Purpose and possible product scope

AutoMemoryDoll is a web-based document generation platform intended to go beyond basic variable substitution. Discussed use cases include letters, duty rosters, examination papers, contracts, and other documents generated from templates and data. Potential longer-term capabilities include external datasets, dataset sharing, constraint-based selection, and batch generation. The exact general-purpose versus examination-focused product scope is still open.

The first milestone is **only the compiler container, with single-document generation**. Batch support comes later. Build the rest of the platform afterward. Data binding and dataset management are deferred beyond the MVP. An LLM worker is outside the MVP.

The next MVP application milestone covers user authentication, adding/deleting/managing templates, and generating one PDF from user-entered values.

## Compiler container: decided behavior

### Technology and isolation

- The compiler program is written in Rust. It renders a MiniJinja-based LaTeX template, then compiles the result with Tectonic linked as a Rust library to produce a PDF.
- The compiler container has no network access or network address and communicates through files. The future launcher runs it under gVisor.
- Job input and the TeX bundle are read-only. The compiler may write only to its output mount and a private temporary area.
- The container's job input is mounted at `/input`; its output is mounted at `/output`.
- Each ordinary generation uses a fresh container that is discarded afterward. One batch may run inside one fresh container, which is discarded when the batch finishes.
- Pin the Tectonic Rust crate to version `0.17.0` and include the official full Tectonic 2022 default bundle (`tlextras-2022.0r0.tar`, from `https://data1.fullyjustified.net/tlextras-2022.0r0.tar`) so compilation works offline. The owner selected this bundle for the compiler milestone. A template that needs unavailable support files fails clearly. Record the artifact digest when packaging it in the image.
- The first deliverable is the container alone; its host-side launcher and supervisor are later work.

### Single-job input and output

Each job receives a folder with this shape:

```text
job/
  template/
    template.tex
    something.cls
    ...other files referenced by the template
  resources/
    ...uploads for this generation
  data.json
```

`template.tex` has a fixed filename. For the MVP, the backend writes user-entered concrete values to `data.json`; future data bindings are resolved before dispatch. The Rust compiler container does not access the database. The separate Node.js queue consumer may access PostgreSQL for job state, as approved in the MVP application design.
`data.json` must have a JSON object at its top level; any other top-level type is a job error.

Each top-level key in `data.json` becomes a MiniJinja template variable. There is no reserved `TeXallowList` key.
JSON object keys may contain dots; the earlier restriction existed only for allowlist-path parsing and is removed.

For the first compiler milestone, remove MiniJinja include/import statements from the template before rendering instead of loading other MiniJinja templates or failing solely because those statements appear. The exact handling of all include/import syntax variants remains to be specified.
Missing MiniJinja variables render as empty text rather than failing the job.
When rendered as scalar values, JSON `null` becomes empty text, while booleans and numbers use ordinary JSON spellings such as `true`, `false`, and `123`.
From `template/template.tex`, uploaded resources are referenced with relative paths such as `../resources/logo.png`. The future backend handles image-path rewriting before dispatch; the precise rewrite rule remains open.

The worker writes to a dedicated output folder bind-mounted to a temporary host directory. On success it writes `result.json` and the named PDF:

```json
{
  "result": "ok",
  "filename": "<UUID>.pdf",
  "message": "PDF generated"
}
```

The output folder is mounted at `/output`. The compiler generates the randomized PDF filename itself as `<UUID>.pdf`. On failure, `result` is `"failed"`, `filename` is `null`, and `message` contains a human-readable error. On success, `message` contains a short confirmation; `"PDF generated"` above is an illustrative wording, not a fixed string.

### Interpolation and raw TeX

- Strings inserted from JSON are escaped for LaTeX by default.
- Template authors can apply MiniJinja's `|safe` filter to a value to insert raw TeX deliberately. The frontend has no per-field raw-TeX switch, and `data.json` has no `TeXallowList` metadata.
- For the first milestone, use Tectonic's untrusted mode through its Rust library API and the isolated container under gVisor. An additional TeX command sanitizer is deferred to a later security review. Do not treat untrusted mode as a guarantee of file-access confinement; the container's filesystem boundaries remain important. The exact library setting must be verified.

### Batch generation

Batch generation is a later milestone, not part of the first compiler-container delivery. The following decisions apply when it is implemented:

- A batch shares one `template/` folder and has multiple data inputs.
- Each batch item has its own `resources/` folder.
- The worker stops on the first compilation failure. A failed batch leaves no PDFs, including PDFs produced before that failure.
- The exact on-disk batch input layout, batch result manifest, output naming, and cleanup mechanism are open.

## MVP application: decided behavior

The owner approved the [MVP application design](docs/superpowers/specs/2026-10-25-mvp-application-design.md) on 2026-10-25. Its proposals are now decisions for this milestone; this record highlights the main contracts, while the approved design gives their details.

### Services and flow

- The frontend uses Vue.js and polls for generation status.
- The backend API uses Express on Node.js with TypeScript.
- The backend enqueues generation jobs in Redis using BullMQ. A separate Node.js/TypeScript queue consumer service, housed under `backend/`, consumes jobs and eventually launches compiler containers. The consumer is not part of the first compiler-container milestone.
- On 2026-11-08, the owner confirmed that the queue consumer runs as UID/GID `65532:65532`, matching the compiler, so private output directories need neither root nor broad write permissions. The API and consumer must share storage access; input snapshot files must be readable by that identity. Interrupted jobs become failed without automatic recompilation.
- The owner selected Prisma ORM for PostgreSQL access and migrations on 2026-11-01. The implementation plan pins the supported Prisma 7 line for this MVP.
- The backend dispatches concrete JSON. Data binding is deferred beyond the MVP.
- Generated PDFs and job history are retained. PDF files live on the backend filesystem in a fixed directory named by job ID.
- Use an abstract storage class with a default filesystem implementation, and an abstract PDF generator class with a compiler-backed implementation.
- Authentication uses JWT in a short-lived HttpOnly, Secure, SameSite cookie with CSRF protection. There are `user`, `admin`, and `owner` roles. Accounts are created by an administrator through a web screen rather than through public self-signup. Administrators manage accounts but do not gain access to other users' templates, jobs, or PDFs. The sole owner can perform administrator actions and additionally grant or remove `admin` privileges from users; ownership does not change the privacy of other users' work. Each user's work is private to that user. The owner account is created by a one-time server setup command.
- Task 2 implements password hashing with Argon2id through the maintained `argon2` package, following the approved application's adaptive password-hashing requirement. This replaces the implementation plan's `crypto.scrypt` step without changing the account contract.
- All user-controlled input must be validated at the boundary where it enters the system, before it is used in database queries, filesystem operations, or document generation. Express routes use `express-validator` field chains such as `body(...)` and `param(...)`, followed by `checkExact()` and a shared `validateRequest` middleware. These reject malformed and unexpected body, path, and query values without implicit type coercion. Authentication cookies and CSRF headers retain their dedicated checks; uploads, the owner setup command, and compiler job files require validation appropriate to their own input formats. New endpoints must add validation chains when implemented. Validation errors must not echo passwords or other sensitive input.
- When adding a template, the user may define a data shape. This option is on by default, but the user can choose not to define one. Each shape field has a template variable name, a display name, an optional/required setting, and one of four types: `text`, `longtext`, `number`, or `boolean`. `longtext` is a string like `text`, but uses a textarea in the frontend. The app generates a form from a defined shape when generating a single PDF. Without a defined shape, the generation screen provides a box for the user to enter JSON.
- The generated form omits a blank optional field's key from the JSON sent for generation. An optional boolean therefore has an unset state distinct from `false`.
- Users can edit an existing template, including its TeX/support files and data-shape field definitions.
- Users can manage a directory-like workspace for each template and keep reusable template files there. Its screen has a directory browser on the left and a textarea editor for template content on the right. The directory browser supports creating, uploading, renaming, moving, and deleting files and folders. The editor opens UTF-8 text files; binary files such as images are managed through upload/download instead of text editing. The generation screen also accepts files supplied for that single job. Workspace file and directory names use the conservative ASCII validation and storage boundaries in the approved design.
- Template workspaces use filesystem directories. On a generation request, the backend snapshots the current template files and that job's resource uploads into a private job input directory before enqueuing. A later workspace edit does not change an already submitted job.
- HTTP file uploads use Multer disk staging in a private server-owned directory. The filesystem storage service validates a staged file and moves it into the workspace or job resources; it does not accept upload streams directly.
- Per-job resource uploads use user-visible aliases rather than user-entered filesystem paths. The editor can insert `@resource(alias)` into UTF-8 template text. During snapshot preparation, the backend validates each alias, stores the upload under a server-generated name, and replaces the exact token with the internal relative path. Missing or duplicate aliases fail before queueing. The four data-shape field types remain unchanged.
- MVP generation uses plain values entered by the user. There is no data binding to external or stored datasets.

### PostgreSQL data model

The owner specified these MVP records. The approved application design adds the fields needed for roles, disabling accounts, token invalidation, data shape, soft deletion, and job retention. Exact SQL names, types where unstated, constraints, and migrations are implementation-plan details.

```text
users
  id: UUID primary key
  username
  password_hash
  role: user|admin|owner
  disabled
  token_version

templates
  id: UUID primary key; also the template directory identifier
  ownedBy: foreign key to users.id
  name
  manifest: versioned JSON containing the optional data shape
  deleted_at

generation_jobs
  id
  template_ID: foreign key to templates
  user: foreign key to users
  batch_count: integer
  timestamp
  status: { status: "queued|generating|ok|failed", message: "..." }
  PDF filename and lifecycle timestamps
```

Indexes requested: primary-key B-tree indexes on `users.id` and `templates.id`; an index on `templates.ownedBy`; and a B-tree index on `(generation_jobs.user, generation_jobs.timestamp)`. PostgreSQL creates indexes for primary keys, so avoid duplicate explicit `id` indexes. The owner has not specified a separate index on `generation_jobs.template_ID`.

No dataset tables are included in the MVP. No database-backed session table is planned because authentication uses JWT. PDFs and job history are retained without automatic expiry in this MVP. A deleted template is soft-deleted so existing jobs and their PDFs remain available.

## Repository structure

```text
package.json        project metadata and commands for running the project
compiler/           first milestone: Rust compiler program and container
backend/            Express API and separate queue consumer service
  package.json
  users/
    users.service.ts
    users.routes.ts
    users.repository.ts
  ...other service directories as approved
  utils/
frontend/           Vue.js application
  package.json
```

The specific subdirectories under `compiler/`, the remaining backend service directories, package manager, shared code layout, and build/test tooling are open. Choose routine details while planning or implementing; ask the owner if a choice changes the agreed architecture or public contract.

## Context considered but not selected

Typst, Mustache, Carbone, ODT/DOCX templating, a custom templating engine, LaTTe, Testmaker, DMOJ, and other GitHub projects were research references. A load balancer and multiple API/frontend replicas were conceptual architecture ideas, not MVP decisions. Dataset sharing, collaboration, constraint solving, and an LLM worker have no approved implementation scope.

## Open decisions to resolve before relevant implementation

- Product scope beyond this approved MVP.
- Batch file layout and output naming; any compiler input/output behavior not specified above.
- Later TeX sanitization, resource limits, and the remaining sandbox policy.
- Whether separately bundled fonts or assets are needed beyond the selected full Tectonic 2022 bundle.
- Template sharing beyond this private-template MVP.
- Production resource ceilings for CPU, memory, process count, and wall time; this must be decided before production exposure.
- Routine API route names, migration layout, package manager, detailed queue payloads, and remaining build/test conventions are left to implementation planning.

The owner wants agents to ask about unresolved design choices that change product behavior, architecture, the data model, a public contract, or a security boundary. Agents should make routine implementation choices without asking a stream of tiny questions, while recording consequential choices for review.
