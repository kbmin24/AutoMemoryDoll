BEGIN;

ALTER TABLE "users" ADD COLUMN "display_id" TEXT;
UPDATE "users" SET "display_id" = "username";
ALTER TABLE "users" ALTER COLUMN "display_id" SET NOT NULL;

COMMIT;
