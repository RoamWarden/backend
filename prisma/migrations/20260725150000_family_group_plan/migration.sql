-- Family / group plan (build plan §20, Premium capability `familyPlan`).
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ SAFE TO APPLY BEFORE THE CODE DEPLOYS.                                   │
-- │                                                                          │
-- │ This migration is PURELY ADDITIVE: it creates two new enum types and     │
-- │ three new tables and contains NO `ALTER TABLE` against any existing      │
-- │ table — no new column, no changed type, no dropped or renamed anything.  │
-- │ The only statements that touch `users` are FOREIGN KEY constraints on    │
-- │ the NEW tables that reference it, which add no column and no row to      │
-- │ `users`.                                                                 │
-- │                                                                          │
-- │ A currently-running older server therefore keeps working unchanged: it   │
-- │ simply never reads these tables. Nothing is backfilled, so the migration │
-- │ is O(1) regardless of how many users exist, and no user loses anything.  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- PRIVACY, stated once here because the schema is where it must hold:
-- a group is a ROSTER. There is deliberately no foreign key from any table
-- below to trips, trip_points, sos_events or anything positional, and no
-- column that could carry a location. Membership grants a display name and an
-- avatar and nothing else. Live location keeps flowing only through
-- `trusted_contacts` under the existing MUTUAL-consent rule (both people added
-- each other) — see UsersService.filterConsentingContactUserIds.

-- CreateEnum: exactly one OWNER per group; the owner also holds a member row so
-- seat counting is a single COUNT over group_members.
CREATE TYPE "group_member_role" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum: an invitation is an OFFER. It becomes a membership only when the
-- invitee accepts — nobody is ever auto-joined by email address.
CREATE TYPE "group_invite_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateTable: one family/group plan. UNIQUE on owner_id — seats are a per-plan
-- resource, so allowing N groups per owner would make the seat limit meaningless.
CREATE TABLE "groups" (
  "id"         UUID NOT NULL,
  "owner_id"   UUID NOT NULL,
  "name"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "groups_owner_id_key" ON "groups" ("owner_id");

-- CreateTable: a seat. A row exists ONLY because that user created the group or
-- accepted an invitation.
CREATE TABLE "group_members" (
  "id"        UUID NOT NULL,
  "group_id"  UUID NOT NULL,
  "user_id"   UUID NOT NULL,
  "role"      "group_member_role" NOT NULL DEFAULT 'MEMBER',
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);
-- One seat per user per group, enforced by the database rather than app logic,
-- so a double-accept race can never consume two seats.
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "group_members" ("group_id", "user_id");
CREATE INDEX "group_members_user_id_idx" ON "group_members" ("user_id");

-- CreateTable: an invitation. It stores ONLY the invited email address and has
-- NO foreign key to a user account, on purpose: inviting must not reveal
-- whether that address has a RoamWarden account, and an unanswered invitation
-- must not link a real person to a group they never agreed to join.
CREATE TABLE "group_invites" (
  "id"           UUID NOT NULL,
  "group_id"     UUID NOT NULL,
  "email"        TEXT NOT NULL,
  "status"       "group_invite_status" NOT NULL DEFAULT 'PENDING',
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "responded_at" TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "group_invites_pkey" PRIMARY KEY ("id")
);
-- One invitation row per address per group for the life of the group: a
-- re-invite after a decline RESETS this row instead of piling up history the
-- invitee cannot see or clear.
CREATE UNIQUE INDEX "group_invites_group_id_email_key" ON "group_invites" ("group_id", "email");
-- "Which groups have invited me?" — the invitee's inbox query.
CREATE INDEX "group_invites_email_status_idx" ON "group_invites" ("email", "status");

-- Cascade everywhere: deleting an account disbands the group it owns and drops
-- its seat in everyone else's, so the existing GDPR account delete stays a
-- single `user.delete` with no new bookkeeping.
ALTER TABLE "groups"
  ADD CONSTRAINT "groups_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_members"
  ADD CONSTRAINT "group_members_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_members"
  ADD CONSTRAINT "group_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_invites"
  ADD CONSTRAINT "group_invites_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
