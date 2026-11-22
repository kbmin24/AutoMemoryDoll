CREATE TABLE "settings" (
    "key" TEXT PRIMARY KEY,
    "value" JSONB NOT NULL
);

INSERT INTO "settings" ("key", "value") VALUES
    ('ai.appMonthlyTokens', '5000000'::jsonb),
    ('ai.userMonthlyTokens', '100000'::jsonb);

CREATE TABLE "ai_quota_reservations" (
    "id" UUID PRIMARY KEY,
    "user_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "reserved_tokens" BIGINT NOT NULL CHECK ("reserved_tokens" > 0),
    "settled_tokens" BIGINT CHECK ("settled_tokens" >= 0)
);

CREATE INDEX "ai_quota_reservations_month_user_id_idx"
    ON "ai_quota_reservations" ("month", "user_id");
