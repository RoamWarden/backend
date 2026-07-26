-- Contact groups + favourites: the owner's own labels over their own trusted
-- contacts, plus a "pin this person to the top" flag.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ SAFE TO APPLY BEFORE THE CODE DEPLOYS.                                   │
-- │                                                                          │
-- │ PURELY ADDITIVE: two new tables and ONE new column that carries a        │
-- │ DEFAULT, so every existing `trusted_contacts` row is valid the instant   │
-- │ the column lands. Nothing is dropped, nothing is renamed, no type        │
-- │ changes, and there is no NOT NULL without a default. Nothing is          │
-- │ backfilled either, so this is O(1) no matter how many contacts exist.    │
-- │                                                                          │
-- │ A currently-running older server keeps working unchanged: TestFlight     │
-- │ builds already in users' hands call GET /me/contacts, which still        │
-- │ returns the same flat array — now with one extra field they ignore.      │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- WHAT WAS DELIBERATELY REMOVED FROM THE GENERATED DIFF. `prisma migrate dev`
-- also emitted five `DROP INDEX ..._gix` statements plus two
-- `ALTER COLUMN ... DROP DEFAULT` statements. None of them belong to this
-- feature: the GiST indexes on the PostGIS `geography` columns and the
-- `ARRAY[]::TEXT[]` defaults on `plans.features` /
-- `sos_escalations.contact_order` were all written by hand in earlier
-- migrations precisely because the Prisma datamodel cannot express them, so
-- every diff since has proposed undoing them. Applying those would silently
-- drop the indexes that every corridor / radius query depends on. They stay.
--
-- PRIVACY, stated here because the schema is where it must hold: a contact
-- group is PRIVATE TO ITS OWNER. It is not the family-plan `groups` table and
-- has no relationship to it — nobody joins one, nobody is notified because of
-- one, and no other account can see or address one. There is deliberately no
-- foreign key from either table below to trips, trip_points, sos_events or
-- anything positional. Live location keeps flowing only through
-- `trusted_contacts` under the existing MUTUAL-consent rule (both people added
-- each other) — see UsersService.filterConsentingContactUserIds.

-- AlterTable: "pin this person to the top of my list". A display preference and
-- nothing more — it grants no extra reach and no priority in an SOS fan-out.
-- DEFAULT false is what makes this safe to run ahead of the deploy.
ALTER TABLE "trusted_contacts" ADD COLUMN     "favorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: one label ("Family", "Work") owned by one user.
CREATE TABLE "contact_groups" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable: "contact X is filed under group Y". The composite primary key
-- makes a double insert impossible, so a double-tap can never duplicate a row.
CREATE TABLE "contact_group_members" (
    "group_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "contact_group_members_pkey" PRIMARY KEY ("group_id","contact_id")
);

-- CreateIndex: "show me my groups" — the only listing query this feature has.
CREATE INDEX "contact_groups_user_id_idx" ON "contact_groups"("user_id");

-- CreateIndex: one name per owner, enforced by the database rather than app
-- logic — two groups both called "Family" would be indistinguishable in the
-- picker, and a concurrent double-create must lose here rather than produce them.
CREATE UNIQUE INDEX "contact_groups_user_id_name_key" ON "contact_groups"("user_id", "name");

-- AddForeignKey: cascade from the account, so the existing GDPR account delete
-- stays a single `user.delete` with no new bookkeeping.
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: cascade from the group. Deleting a group removes only these
-- membership rows — the contacts themselves survive. A folder is not its
-- contents, and losing a trusted contact to a tidy-up would be a safety bug.
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "contact_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: cascade from the contact, so deleting a trusted contact
-- quietly unfiles it from every group and no group can point at a dead row.
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "trusted_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
