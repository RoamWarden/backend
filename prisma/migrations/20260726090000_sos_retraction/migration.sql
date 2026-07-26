-- SOS RETRACTION — the traveller withdraws an alert they raised.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PURELY ADDITIVE — SAFE TO APPLY BEFORE THE NEW CODE DEPLOYS.
-- ════════════════════════════════════════════════════════════════════════════
-- Everything below is a NEW NULLABLE COLUMN or a NEW INDEX. There is no
-- ALTER ... SET NOT NULL, no DROP, no rename, no type change, no new enum value
-- and no backfill. Concretely:
--
--   * A server running the CURRENT (pre-retraction) build keeps working
--     untouched. Prisma selects an explicit column list generated from the
--     schema it was built with, so the old client never reads these columns and
--     its INSERTs simply leave them NULL.
--   * A server running the NEW build works against a database that has NOT yet
--     had this migration only in the sense that it will error loudly on the
--     retract path — which is why this is applied FIRST, then the code ships.
--     Migration-then-deploy is the safe order and the only supported one.
--   * NULL is the correct value for every SOS raised before today: none of them
--     were retracted, so there is nothing to backfill and nothing is guessed.
--   * Adding a nullable column with no default is a catalog-only change in
--     Postgres: no table rewrite, O(1) regardless of how many rows exist.
--
-- WHAT THIS IS, HONESTLY: retracting withdraws an alert sent to the traveller's
-- OWN trusted contacts. RoamWarden has never contacted emergency services and
-- this does not change that — there is nothing here that can call anyone off.

-- The traveller withdrew this SOS. Deliberately SEPARATE from `resolved_at`:
-- "I am safe now" closes an SOS that really happened, "I withdraw this" says it
-- should not have gone out. Collapsing the two would destroy the distinction
-- that the whole feature (and its reputation cost) rests on.
ALTER TABLE "sos_events" ADD COLUMN "retracted_at" TIMESTAMP(3);

-- Optional free text from the traveller, forwarded verbatim to the contacts who
-- were already reached ("pocket dial", "false alarm, sorry").
ALTER TABLE "sos_events" ADD COLUMN "retract_reason" TEXT;

-- Receipt for the ONE-TIME reputation dent: the penalty actually applied to
-- `users.reputation` for this retraction. NULL means no dent was applied —
-- either it was never retracted, or the reputation write failed and we did not
-- pretend otherwise. It is an audit column, never an input to a calculation.
ALTER TABLE "sos_events" ADD COLUMN "reputation_penalty" INTEGER;

-- Retraction asks "is any OTHER SOS on this trip still live?" before handing the
-- trip back to ACTIVE. Postgres does not index a foreign key for you, and that
-- question must not degrade into a sequential scan while someone is waiting on
-- a safety action. Plain CREATE INDEX (not CONCURRENTLY) because Prisma runs a
-- migration inside a transaction and `sos_events` is small; it takes a SHARE
-- lock for a moment, blocking writes to this table only.
CREATE INDEX "sos_events_trip_id_idx" ON "sos_events" ("trip_id");
