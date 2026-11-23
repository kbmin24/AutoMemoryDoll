BEGIN;

ALTER TABLE "datasets" ADD COLUMN "row_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "dataset_rows" ADD COLUMN "rank" TEXT COLLATE "C";

-- A fractional key starting with b has two base-62 integer digits.
-- The existing per-dataset limit of 1,000 fits within those 3,844 keys.
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "dataset_id" ORDER BY "position")::integer - 1 AS ordinal
  FROM "dataset_rows"
)
UPDATE "dataset_rows" AS row
SET "rank" = 'b'
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ordered.ordinal / 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ordered.ordinal % 62 + 1, 1)
FROM ordered
WHERE row."id" = ordered."id";

UPDATE "datasets" AS dataset
SET "row_count" = counts.total
FROM (
  SELECT "dataset_id", count(*)::integer AS total FROM "dataset_rows" GROUP BY "dataset_id"
) AS counts
WHERE dataset."id" = counts."dataset_id";

ALTER TABLE "dataset_rows" ALTER COLUMN "rank" SET NOT NULL;
CREATE UNIQUE INDEX "dataset_rows_dataset_id_rank_key" ON "dataset_rows"("dataset_id", "rank");

COMMIT;
