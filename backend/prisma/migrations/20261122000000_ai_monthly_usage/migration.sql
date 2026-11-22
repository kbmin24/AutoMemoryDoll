BEGIN;

LOCK TABLE "ai_quota_reservations" IN SHARE MODE;

CREATE TABLE "ai_app_monthly_usage" (
    "month" DATE PRIMARY KEY,
    "used_tokens" BIGINT NOT NULL CHECK ("used_tokens" >= 0)
);

CREATE TABLE "ai_user_monthly_usage" (
    "month" DATE NOT NULL,
    "user_id" UUID NOT NULL,
    "used_tokens" BIGINT NOT NULL CHECK ("used_tokens" >= 0),
    PRIMARY KEY ("month", "user_id")
);

INSERT INTO "ai_user_monthly_usage" ("month", "user_id", "used_tokens")
SELECT "month", "user_id", SUM(COALESCE("settled_tokens", "reserved_tokens"))
FROM "ai_quota_reservations"
GROUP BY "month", "user_id";

INSERT INTO "ai_app_monthly_usage" ("month", "used_tokens")
SELECT "month", SUM("used_tokens")
FROM "ai_user_monthly_usage"
GROUP BY "month";

COMMIT;
