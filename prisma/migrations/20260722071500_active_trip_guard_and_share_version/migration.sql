-- Share-link revocation: reissuing a token bumps this; the live view checks it.
ALTER TABLE "trips" ADD COLUMN "share_token_version" INTEGER NOT NULL DEFAULT 0;

-- DB backstop for the one-ACTIVE-trip-per-user rule. The app pre-check has a
-- TOCTOU window (it awaits a Google Directions call between check and insert);
-- this partial unique index makes a second concurrent ACTIVE trip impossible,
-- surfacing as a P2002 the service maps to 409.
CREATE UNIQUE INDEX "trips_one_active_per_user"
  ON "trips" ("user_id")
  WHERE "status" = 'ACTIVE';
