-- Priority SOS (build plan §20 — Premium capability `prioritySos`): a durable
-- delivery/escalation trail plus the escalation ladder's own state.
--
-- BACKWARDS COMPATIBLE / SAFE TO APPLY BEFORE THE NEW CODE SHIPS:
-- purely ADDITIVE. It creates three new enums and two new tables and touches NO
-- existing table or column (no ALTER TABLE on anything that exists today), so a
-- currently-running older server keeps working unchanged — it simply never
-- reads or writes these tables. Nothing is backfilled: an SOS raised before this
-- deploy has no trail, which is correct (we did not record one). Applying it
-- writes no per-row data and stays O(1) regardless of table size.
--
-- It also takes NOTHING away: standard SOS (free tier's explicit promise) does
-- not read these tables at all. RoamWarden is not an emergency service — this
-- records attempts to reach the traveller's OWN trusted contacts, nothing more.

-- CreateEnum: outcome of one attempt to reach one contact.
CREATE TYPE "sos_delivery_status" AS ENUM ('SENT', 'NO_DEVICE', 'FAILED', 'SKIPPED', 'ACKNOWLEDGED');

-- CreateEnum: how the attempt was carried.
CREATE TYPE "sos_delivery_channel" AS ENUM ('PUSH', 'REALTIME');

-- CreateEnum: lifecycle of one SOS's escalation ladder.
CREATE TYPE "sos_escalation_status" AS ENUM ('RUNNING', 'ACKNOWLEDGED', 'RESOLVED', 'EXHAUSTED', 'STOPPED');

-- CreateTable: append-only audit trail. One row per attempt per contact.
-- `contact_user_id` deliberately carries NO foreign key: this is a record of who
-- we tried to reach at the time and must survive that account being deleted.
CREATE TABLE "sos_deliveries" (
  "id"              UUID NOT NULL,
  "sos_id"          UUID NOT NULL,
  "contact_user_id" UUID NOT NULL,
  "rank"            INTEGER NOT NULL,
  "round"           INTEGER NOT NULL,
  "attempt"         INTEGER NOT NULL,
  "channel"         "sos_delivery_channel" NOT NULL,
  "status"          "sos_delivery_status" NOT NULL,
  "priority"        BOOLEAN NOT NULL DEFAULT false,
  "detail"          TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sos_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sos_deliveries_sos_id_created_at_idx" ON "sos_deliveries" ("sos_id", "created_at");
CREATE INDEX "sos_deliveries_sos_id_contact_user_id_idx" ON "sos_deliveries" ("sos_id", "contact_user_id");

-- The trail belongs to the SOS event: deleting the event (which cascades from
-- the user) takes its trail with it.
ALTER TABLE "sos_deliveries"
  ADD CONSTRAINT "sos_deliveries_sos_id_fkey"
  FOREIGN KEY ("sos_id") REFERENCES "sos_events" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: at most ONE escalation ladder per SOS — enforced by the UNIQUE
-- index on sos_id below, never by app logic alone. This table is also the queue
-- the cron sweeper drains, so an in-flight escalation survives a redeploy.
CREATE TABLE "sos_escalations" (
  "id"              UUID NOT NULL,
  "sos_id"          UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "status"          "sos_escalation_status" NOT NULL DEFAULT 'RUNNING',
  "plan_code"       TEXT NOT NULL,
  "enforced"        BOOLEAN NOT NULL DEFAULT false,
  "contact_order"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rank"            INTEGER NOT NULL DEFAULT 0,
  "attempt"         INTEGER NOT NULL DEFAULT 0,
  "total_attempts"  INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "acknowledged_by" UUID,
  "detail"          TEXT,
  "started_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "finished_at"     TIMESTAMP(3),
  CONSTRAINT "sos_escalations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sos_escalations_sos_id_key" ON "sos_escalations" ("sos_id");

-- The sweeper's only query: RUNNING ladders whose next attempt is due.
CREATE INDEX "sos_escalations_status_next_attempt_at_idx" ON "sos_escalations" ("status", "next_attempt_at");

ALTER TABLE "sos_escalations"
  ADD CONSTRAINT "sos_escalations_sos_id_fkey"
  FOREIGN KEY ("sos_id") REFERENCES "sos_events" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
