# Backend submission service

The API requires `DATABASE_URL`, `REDIS_URL`, and a `JWT_SECRET` of at least
32 characters. `STORAGE_ROOT` defaults to `./data`. Apply the backend Prisma
migrations before starting the API.

`POST /api/templates/:id/generations` accepts `{ "data": { ... } }` as JSON.
For per-job resources, send multipart form data with a `data` field containing
the JSON object and one file field per `@resource(alias)` in the template.
The authenticated owner can read status and history through `GET /api/jobs/:id`
and `GET /api/jobs`.

The API creates immutable job input and sends only a job ID to the
`pdf-generation` BullMQ queue. Task 6 adds the consumer that compiles jobs and
publishes PDFs; queued jobs do not generate a PDF until that consumer is built.
