-- Email verification: a durable "verified" signal on the user.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Grandfather every existing account as verified so the new login gate never
-- locks out users who registered before OTP verification shipped (Google
-- accounts are already implicitly verified; pre-existing local accounts were
-- created without a verification step).
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- One-time 6-digit email-verification codes (keyed-hash, single-use, expiring,
-- attempt-limited). Mirrors password_reset_tokens but adds attempt_count.
CREATE TABLE "email_verification_otps" (
  "id"            UUID NOT NULL,
  "user_id"       UUID NOT NULL,
  "code_hash"     TEXT NOT NULL,
  "expires_at"    TIMESTAMP(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "consumed_at"   TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_verification_otps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_verification_otps_user_id_idx" ON "email_verification_otps" ("user_id");
ALTER TABLE "email_verification_otps"
  ADD CONSTRAINT "email_verification_otps_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
