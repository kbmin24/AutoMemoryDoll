CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "owned_by" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "last_position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dataset_rows" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "values" JSONB NOT NULL,

    CONSTRAINT "dataset_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "datasets_owned_by_idx" ON "datasets"("owned_by");
CREATE UNIQUE INDEX "dataset_rows_dataset_id_position_key" ON "dataset_rows"("dataset_id", "position");

ALTER TABLE "datasets" ADD CONSTRAINT "datasets_owned_by_fkey" FOREIGN KEY ("owned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dataset_rows" ADD CONSTRAINT "dataset_rows_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
