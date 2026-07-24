-- Normalise all existing emails to lowercase so case-insensitive sign-in works
-- with the new app-level normalisation (DTO @NormalizeEmail transforms +
-- upsertFromGoogle). Every future email is stored lowercased, so this one-time
-- backfill makes existing mixed-case rows match the same lookups.
--
-- If two accounts differ ONLY by case (e.g. John@x.com and john@x.com) this
-- UPDATE will fail on the unique(email) constraint — that is intentional: they
-- are duplicates and must be merged/removed by hand before this can apply.
UPDATE "users" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");
