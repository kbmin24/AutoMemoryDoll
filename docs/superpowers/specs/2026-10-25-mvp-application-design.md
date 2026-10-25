# MVP application design

Approved by the project owner on 2026-10-25. This design covers the backend, queue consumer, and frontend after the single-job compiler container. `DESIGN.md` remains the concise decision record.

## Intent and boundaries

An administrator creates user accounts. A user signs in, creates or edits a private LaTeX template workspace, optionally describes the values that template needs, submits one set of values and job resources, follows the generation status, and downloads the PDF. The MVP should make that path reliable and understandable. It does not include data binding, datasets, batch generation, sharing, an LLM worker, or a collaborative editor.

The agreed stack is Vue, Express/TypeScript, BullMQ/Redis, PostgreSQL, and the existing Rust compiler container. The compiler receives concrete JSON and files, runs offline under gVisor with read-only input and bundle mounts, and writes only to its output mount and private temporary area.

## Approaches considered

1. **Chosen: filesystem template workspaces with per-job snapshots.** A workspace is a real directory under a server-generated template UUID. The API copies its current files and the generation's resources into a private job input directory before enqueueing. Editing a template later cannot change a submitted job. This fits the compiler's mounted-file contract; backups must cover both PostgreSQL and filesystem storage.
2. **Database-backed workspace files.** Store each file as database content, then materialize a directory for editing and compiling. This centralizes backup but makes file operations and job preparation heavier.

Reading the live workspace when the consumer starts was dropped because a queued job could silently use a later edit.

## User-facing flow

### Authentication and account administration

Decided: no public self-signup. A one-time setup command creates the sole owner account. There are `user`, `admin`, and `owner` roles. Administrators create accounts in a web screen. The owner can do everything an administrator can and can additionally grant or remove `admin` privileges from users. Neither role has an application route to another user's templates, jobs, or PDFs.

**Decision:** The setup command prompts for a username and password rather than taking a password in CLI arguments or an environment variable and refuses to create an owner if one already exists. Administrators and the owner can create regular users with an initial password and disable accounts. Only the owner can promote a user to admin or demote an admin to user. The web UI cannot grant, demote, or disable the `owner` role. Users can change their own password. Password reset, email, invitations, and multi-factor authentication are outside this MVP. Login uses a short-lived JWT in an HttpOnly, Secure, SameSite cookie; logout clears it. The API checks account status and role on protected requests. A login or password change invalidates older tokens by comparing a token version stored on the user record. The exact token lifetime is a configuration value, with a proposed default of 12 hours. State-changing routes use CSRF protection. Passwords use a maintained password-hashing library with a modern adaptive algorithm. The admin screen never exposes password hashes.

### Templates and workspace

Decided: each user can add, edit, and delete their templates. The workspace has a directory browser on the left and a textarea editor on the right. Users can create, upload, rename, move, and delete files and folders. UTF-8 text files open in the editor; binary files are uploaded/downloaded. `template.tex` is the fixed compiler entry file. Workspace names use a conservative ASCII set. A generation may also upload files used only by that job.

**Decision:** A template is created with a name and an empty workspace containing `template.tex`. It remains private to its owning user, who can rename it. `template.tex` cannot be renamed, moved, or deleted, and a generation request requires it to be nonempty. The API accepts individual file uploads; archive extraction is outside MVP. No direct static serving of workspace files occurs. Downloaded binary files use attachment disposition. The workspace has no preview compile button; generation is the way to check a template.

Workspace path rules: the API accepts relative path *segments*, validates each after decoding, and constructs paths beneath its server-owned template root. It rejects absolute paths, `.` and `..`, separators inside a segment, leading dots, trailing dots/spaces, control characters, symlinks, special filesystem objects, and collisions. Proposed names contain only ASCII letters, digits, spaces, `_`, `-`, and `.`; they begin with a letter or digit. Limits are 128 bytes per segment, eight directory levels, and 512 bytes for a relative path. All file operations recheck ownership and path containment at the point of use; moves cannot cross template roots. The API writes files atomically and serializes mutations with snapshot creation. These checks apply to templates and per-job resources. The storage root is outside the web server's static files and is not executable. These rules apply [OWASP's file-upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) and [path-traversal](https://community.owasp.org/attacks/Path_Traversal) guidance to a workspace whose filenames must remain usable in TeX references.

**Proposed initial limits:** 20 MiB per file, 100 MiB per template workspace, 100 MiB per generation's resource uploads, and 1 MiB for editable text. Limits are server configuration values, enforced while streaming; the UI reports them. These are operational defaults, not a claim that any file type is safe. The compiler container remains the boundary for untrusted TeX.

### Data shape and generation

Decided: defining a data shape is offered by default, and the owner can turn it off. A field has a template variable name, display name, required/optional flag, and type `text`, `longtext`, `number`, or `boolean`. `longtext` sends a string but uses a textarea. With a shape, the generation screen builds a form. Without one, it provides a JSON box. Optional blank fields are omitted. There is no data binding.

**Decision:** Store the shape as a versioned object in `templates.manifest`. Fields are ordered. Shape variable names are unique and use `[A-Za-z_][A-Za-z0-9_]*`; display names are nonempty, human-readable text. An enabled shape must contain at least one field. A required text or longtext field must be nonempty, a required number must parse as a finite JSON number, and a required boolean must explicitly be true or false. Optional booleans have an unset choice. The API applies the same validation as the form and rejects unknown keys for shaped templates. JSON mode requires a top-level object and accepts any keys and JSON value types permitted by the compiler contract. The UI shows validation errors before enqueueing. Escaping is the compiler's existing behavior; the UI does not expose a raw-TeX switch.

Per-job uploads have user-visible aliases. The workspace editor can insert `@resource(alias)` into a text file; authors do not enter `../resources/` paths. **Decision:** aliases match `[A-Za-z][A-Za-z0-9_-]*`. The backend scans UTF-8 workspace text files for these tokens and the generation screen shows one required file upload per referenced alias. During snapshot preparation, the backend checks that each referenced alias has exactly one upload, stores each resource under a server-generated safe name, and replaces the token with the internal relative path required by the existing compiler layout. Missing or duplicate aliases fail before queueing. It never rewrites form/JSON data values or binary files. This applies to images and other per-job resources; reusable files within the template workspace can still use paths inside that workspace. The four data-shape field types do not change.

### Jobs and results

**Decision:** Submission creates a job record and immutable input snapshot, then enqueues only its job ID. Statuses are `queued`, `generating`, `ok`, and `failed`, each with a human-readable message. The frontend polls a status endpoint. The worker uses a fresh compiler container for each job, with `--runtime=runsc`, no network, read-only root and input mount, dropped capabilities, no new privileges, a writable output mount, and private tmpfs. It reads `result.json`, confirms the named PDF exists on success, and moves the PDF to a directory named by job ID. It records failure without exposing host paths or raw internal errors to the user. The worker has Docker/gVisor access; the API process does not. It invokes the container runtime with argument arrays, not a shell command.

The user's job history shows submission time, template name, status, message, and download action. A PDF remains available after the template is edited or deleted. Deleting a template hides it and its workspace from ordinary template views but retains its database row as a soft-deleted reference for job history. Job input snapshots are removed after a terminal status; PDFs and job metadata have no automatic expiry in this MVP. No automatic retry of compiler failures; interrupted `generating` jobs become failed after worker recovery or a startup reconciliation pass. A failed job exposes a useful, bounded compiler message while retaining full server-side diagnostics privately.

## Service boundaries and storage

- `backend/` has separate API and BullMQ consumer entry points. Both share service/repository code where useful, organized by `users`, `templates`, `jobs`, and `auth`. The compiler container has no database or Redis access. **Decision:** the Node queue consumer accesses PostgreSQL for job state and filesystem staging; only that consumer launches containers. This distinguishes the queue consumer from the Rust compiler program called a worker in parts of `DESIGN.md`.
- PostgreSQL holds users, template metadata and shape manifest, and job metadata. User records need a role, disabled flag, and token version. Templates need a deletion marker. Jobs need a UUID primary key, owner, template reference, timestamps, status/message, and PDF filename. The decided indexes in `DESIGN.md` remain; migrations add indexes only when justified by actual queries. `batch_count` remains `1` for this MVP.
- The filesystem storage implementation owns template workspaces, job snapshots, temporary compiler output, and retained PDFs. Its interface provides operations in terms of user/template/job IDs, never unchecked host paths. Root `package.json` provides project commands; backend and frontend have their own packages. A local deployment runs PostgreSQL, Redis, API, consumer, frontend, and a gVisor-capable container runtime.

## Verification and acceptance

Acceptance should demonstrate: admin bootstrap and account creation; a regular user cannot access another user's workspace, job, or PDF; template files can be edited and reorganized without escaping their root; a shaped template generates a typed form and omits blank optional values; an unshaped template accepts concrete JSON; a generation with a per-job resource yields a downloadable PDF; a failed compilation gives a failed status and no PDF; editing or deleting a template after submission does not alter the job or remove its retained PDF; and the consumer launches the compiler with the agreed isolation settings. Integration checks should use the real compiler image where the environment supports Docker and gVisor.

## What remains for implementation planning

After approval, choose routine library, package-manager, migration, and frontend component details; define exact route and queue payload schemas; and write the implementation plan in milestone order. Container image availability and gVisor must be checked in the target environment. Further resource ceilings for CPU, memory, process count, and wall time require a separate security/deployment decision before production exposure. No claim is made that Tectonic untrusted mode alone confines TeX file access.

## Approved choices and remaining deployment gate

The approval includes the authentication lifecycle and user-management actions, workspace path and upload rules, form validation, job status and retention rules, and the Node queue consumer's database access. Container resource ceilings remain a later deployment security decision before production exposure.
