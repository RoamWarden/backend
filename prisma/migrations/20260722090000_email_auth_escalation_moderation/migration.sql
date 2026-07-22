-- Email/password auth: googleSub becomes optional; add password hash + admin flag.
ALTER TABLE "users" ALTER COLUMN "google_sub" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- Password reset tokens (hashed, single-use, expiring).
CREATE TABLE "password_reset_tokens" (
  "id"         UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens" ("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" ("user_id");
ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No-arrival / stall escalation state on trips.
ALTER TABLE "trips" ADD COLUMN "last_point_at"       TIMESTAMP(3);
ALTER TABLE "trips" ADD COLUMN "checkin_at"          TIMESTAMP(3);
ALTER TABLE "trips" ADD COLUMN "overdue_notified_at" TIMESTAMP(3);
ALTER TABLE "trips" ADD COLUMN "escalated_at"        TIMESTAMP(3);

-- Report moderation audit.
ALTER TABLE "reports" ADD COLUMN "removed_by_id"  UUID;
ALTER TABLE "reports" ADD COLUMN "removed_reason" TEXT;
ALTER TABLE "reports" ADD COLUMN "removed_at"     TIMESTAMP(3);
