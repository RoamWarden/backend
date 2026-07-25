-- Monetization foundation (build plan §20): a seeded plan catalog plus one
-- subscription row per user.
--
-- BACKWARDS COMPATIBLE / SAFE TO APPLY BEFORE THE NEW CODE SHIPS:
-- this migration is purely ADDITIVE. It creates one new enum and two new
-- tables and touches NO existing table or column (no ALTER TABLE anywhere), so
-- a currently-running older server keeps working unchanged — it simply never
-- reads these tables. Users are NOT backfilled with subscription rows: "no row"
-- is the canonical representation of the free tier, so this migration writes
-- nothing per-user and stays O(1) regardless of table size.

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('FREE', 'PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateTable: the plan catalog. Plans are data, not a hardcoded enum in three
-- codebases — copy/pricing edits are a row update, not three deploys.
CREATE TABLE "plans" (
  "id"                 UUID NOT NULL,
  "code"               TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "description"        TEXT NOT NULL,
  "price_amount_minor" INTEGER NOT NULL DEFAULT 0,
  "currency"           TEXT NOT NULL DEFAULT 'USD',
  "interval"           TEXT NOT NULL DEFAULT 'month',
  "features"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "sort_order"         INTEGER NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plans_code_key" ON "plans" ("code");
CREATE INDEX "plans_is_active_sort_order_idx" ON "plans" ("is_active", "sort_order");

-- CreateTable: at most ONE subscription per user — enforced by the UNIQUE index
-- on user_id below, never by app logic alone.
CREATE TABLE "subscriptions" (
  "id"                   UUID NOT NULL,
  "user_id"              UUID NOT NULL,
  "plan_id"              UUID NOT NULL,
  "status"               "subscription_status" NOT NULL DEFAULT 'FREE',
  "current_period_start" TIMESTAMP(3),
  "current_period_end"   TIMESTAMP(3),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions" ("user_id");
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" ("status");
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions" ("plan_id");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: a plan people are subscribed to must not be deletable out from under them.
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the two live tiers, verbatim from build plan §20. This block IS the seed:
-- it ships inside the migration, so a fresh database gets both plans from
-- `prisma migrate deploy` alone, with no separate seed step to forget.
-- IDEMPOTENT: keyed on the unique `code` with fixed ids, so re-running it (fresh
-- DB, replay, or pasting it into psql to change copy) updates in place and can
-- never duplicate a plan.
-- Premium is priced at the middle of the $3–8/mo band; change the row, not code.
INSERT INTO "plans" (
  "id", "code", "name", "description",
  "price_amount_minor", "currency", "interval",
  "features", "is_active", "sort_order", "updated_at"
) VALUES
  (
    'b6f0f7e8-4a1d-4a3a-9d2c-6f5c1a0b0001',
    'free',
    'Free',
    'Core safety for every traveller — always free.',
    0, 'USD', 'month',
    ARRAY[
      'Core safety alerts',
      'Basic trip sharing',
      'SOS'
    ]::TEXT[],
    true, 0, CURRENT_TIMESTAMP
  ),
  (
    'b6f0f7e8-4a1d-4a3a-9d2c-6f5c1a0b0002',
    'premium',
    'Premium',
    'For travellers who want the full safety net.',
    500, 'USD', 'month',
    ARRAY[
      'Unlimited trusted contacts',
      'Trip history & analytics',
      'Priority SOS',
      'Family/group plan',
      'Offline maps'
    ]::TEXT[],
    true, 1, CURRENT_TIMESTAMP
  )
ON CONFLICT ("code") DO UPDATE SET
  "name"               = EXCLUDED."name",
  "description"        = EXCLUDED."description",
  "price_amount_minor" = EXCLUDED."price_amount_minor",
  "currency"           = EXCLUDED."currency",
  "interval"           = EXCLUDED."interval",
  "features"           = EXCLUDED."features",
  "is_active"          = EXCLUDED."is_active",
  "sort_order"         = EXCLUDED."sort_order",
  "updated_at"         = CURRENT_TIMESTAMP;
