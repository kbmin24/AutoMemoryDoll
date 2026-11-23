CREATE TABLE "template_shares" (
    "template_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,

    CONSTRAINT "template_shares_pkey" PRIMARY KEY ("template_id", "recipient_id")
);

CREATE INDEX "template_shares_recipient_id_idx" ON "template_shares"("recipient_id");

ALTER TABLE "template_shares" ADD CONSTRAINT "template_shares_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "template_shares" ADD CONSTRAINT "template_shares_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
