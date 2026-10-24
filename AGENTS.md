# Agent instructions

## Working agreement

- Ask the project owner before making an unresolved **design choice** that changes product behavior, architecture, the data model, a public contract, or a security boundary. Present the options and wait for a decision. Make routine implementation choices yourself; record consequential ones in the plan or design record rather than asking a stream of tiny questions.
- Do not turn an idea, research reference, or tentative architecture from `DESIGN.md` into a requirement. Keep decided facts separate from open questions.
- Work in milestone order: build the compiler container first. The backend, queue consumer, frontend, and database come later.
- Read `DESIGN.md` before planning or changing the project. Update it when the owner makes a decision; preserve unresolved questions as unresolved.
- Use the Superpowers workflow when preparing the final implementation plan, as requested by the owner.

## Current project shape

- `compiler/` contains the first milestone: a Rust program using MiniJinja and Tectonic as a Rust library in a container. It receives mounted job files and writes results to a dedicated output mount. The container runs without network access under gVisor when launched by the future host-side service.
- `backend/` will contain the Express API and a separate BullMQ queue consumer, both using Node.js and TypeScript. Organize backend code by service, with route, service, and repository files where applicable.
- `frontend/` will contain the Vue.js application.
- The root `package.json` will hold project metadata and commands for running the project.

## Decisions that must remain visible

- Treat uploaded templates and resources as untrusted. For the first compiler milestone, use Tectonic's untrusted mode through its Rust library API plus the isolated container under gVisor. Verify the exact API setting. Additional TeX command sanitization is deferred to a later security review; do not claim that untrusted mode alone confines all TeX file access.
- The backend resolves data bindings before dispatch. The compiler receives concrete JSON only. Data binding itself is deferred beyond the MVP.
- Escape interpolated strings for LaTeX by default. Template authors can explicitly use MiniJinja's `|safe` filter to insert a value as raw TeX. There is no `TeXallowList` or per-field frontend switch.
- The compiler must work offline using a full Tectonic bundle included in the image.
- Mount job input and the TeX bundle read-only. Give the compiler write access only to its output mount and a private temporary area.
- The first compiler-container milestone supports single-document generation. Batch support comes later. When implemented, a batch uses one fresh container, stops on the first failure, leaves no PDFs on failure, and then discards the container.

See `DESIGN.md` for the job contract, MVP data model, system design, and unresolved decisions.
