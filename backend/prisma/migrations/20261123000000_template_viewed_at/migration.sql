CREATE TABLE "template_viewed_at" (
    "template_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_viewed_at_pkey" PRIMARY KEY ("template_id", "user_id"),
    CONSTRAINT "template_viewed_at_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_viewed_at_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "template_viewed_at_user_id_idx" ON "template_viewed_at"("user_id");
