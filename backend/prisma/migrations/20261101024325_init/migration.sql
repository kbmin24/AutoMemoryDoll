-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "token_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "owned_by" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "batch_count" INTEGER NOT NULL DEFAULT 1,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "message" TEXT NOT NULL,
    "pdf_filename" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- Exactly one account may hold the owner role. Bootstrap creates it later.
CREATE UNIQUE INDEX "users_single_owner_idx" ON "users" ("role") WHERE "role" = 'owner';

ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin', 'owner'));
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_status_check" CHECK ("status" IN ('queued', 'generating', 'ok', 'failed'));
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_batch_count_check" CHECK ("batch_count" = 1);

-- CreateIndex
CREATE INDEX "templates_owned_by_idx" ON "templates"("owned_by");

-- CreateIndex
CREATE INDEX "generation_jobs_user_id_timestamp_idx" ON "generation_jobs"("user_id", "timestamp");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_owned_by_fkey" FOREIGN KEY ("owned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
