-- Early-access waitlist (landing-page signups).
CREATE TABLE "waitlist_entries" (
  "id"         UUID NOT NULL,
  "email"      TEXT NOT NULL,
  "source"     TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "waitlist_entries_email_key" ON "waitlist_entries" ("email");
CREATE INDEX "waitlist_entries_created_at_idx" ON "waitlist_entries" ("created_at");
