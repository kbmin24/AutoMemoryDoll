# AutoMemoryDoll design record

This document records decisions made with the project owner and identifies work that remains undecided. It is not an implementation plan. Do not infer approval of a technology or feature merely because it appears in the context section.

## Purpose and possible product scope

AutoMemoryDoll is a web-based document generation platform intended to go beyond basic variable substitution. Discussed use cases include letters, duty rosters, examination papers, contracts, and other documents generated from templates and data. Potential longer-term capabilities include external datasets, dataset sharing, constraint-based selection, and batch generation. The exact general-purpose versus examination-focused product scope is still open.

The first milestone is **only the compiler container, with single-document generation**. Batch support comes later. Build the rest of the platform afterward. Data binding and dataset management are deferred beyond the MVP. An LLM worker is outside the MVP.

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

`template.tex` has a fixed filename. The backend resolves database bindings and transforms the request before dispatch, so `data.json` contains concrete values only. The worker does not access the database.
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

### Services and flow

- The frontend uses Vue.js and polls for generation status.
- The backend API uses Express on Node.js with TypeScript.
- The backend enqueues generation jobs in Redis using BullMQ. A separate Node.js/TypeScript queue consumer service, housed under `backend/`, consumes jobs and eventually launches compiler containers. The consumer is not part of the first compiler-container milestone.
- The backend resolves data bindings before dispatching concrete JSON. Data binding is deferred beyond the MVP; what transformation is needed for the MVP remains open.
- Generated PDFs and job history are retained. PDF files live on the backend filesystem in a fixed directory named by job ID.
- Use an abstract storage class with a default filesystem implementation, and an abstract PDF generator class with a compiler-backed implementation.
- Authentication uses JWT. Its token lifecycle and authorization rules remain open.

### PostgreSQL data model

The owner specified these MVP records. Column names below reflect the discussion; exact SQL names, types where unstated, constraints, and migrations remain open.

```text
users
  id: UUID primary key
  username
  password_hash

templates
  id: UUID primary key; also the template directory identifier
  ownedBy: foreign key to users.id
  name
  manifest: flexible JSON; no MVP fields are currently defined

generation_jobs
  id
  template_ID: foreign key to templates
  user: foreign key to users
  batch_count: integer
  timestamp
  status: { status: "ok|failed|generating", message: "..." }
```

Indexes requested: primary-key B-tree indexes on `users.id` and `templates.id`; an index on `templates.ownedBy`; and a B-tree index on `(generation_jobs.user, generation_jobs.timestamp)`. PostgreSQL creates indexes for primary keys, so avoid duplicate explicit `id` indexes. The owner has not specified a separate index on `generation_jobs.template_ID`.

No dataset tables are included in the MVP. No database-backed session table is planned because authentication uses JWT. Whether queued jobs need a `queued` status before `generating` is open.

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

- Product scope and acceptance criteria beyond the compiler milestone.
- Batch file layout and output naming; any compiler input/output behavior not specified above.
- Later TeX sanitization, resource limits, and the remaining sandbox policy.
- Whether separately bundled fonts or assets are needed beyond the selected full Tectonic 2022 bundle.
- JWT lifecycle and authorization, template sharing, template file storage and upload rules.
- Exact PostgreSQL schema details, job status lifecycle, migrations, and PDF retention policy.
- API routes, BullMQ payloads, queue consumer-to-container protocol, error propagation, and deployment topology.
- Frontend interaction design and remaining repository/build conventions.

The owner wants agents to ask about unresolved design choices that change product behavior, architecture, the data model, a public contract, or a security boundary. Agents should make routine implementation choices without asking a stream of tiny questions, while recording consequential choices for review.
