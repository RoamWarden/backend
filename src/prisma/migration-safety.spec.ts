/**
 * A guard over the migration folder, because one careless `migrate dev` can
 * silently cost production every spatial index it has.
 *
 * ── The bug this exists to prevent ──────────────────────────────────────────
 * Five GiST indexes and two TEXT[] defaults were originally written by hand, in
 * raw SQL, because the Prisma datamodel could not express them. Prisma therefore
 * could not SEE them, so every `prisma migrate dev --create-only` opened its
 * generated migration with seven statements that had nothing to do with the
 * change being made:
 *
 *     DROP INDEX "reports_geog_gix";            (× 5 spatial indexes)
 *     ALTER TABLE "plans" ALTER COLUMN "features" DROP DEFAULT;   (× 2)
 *
 * Applying those turns every corridor, radius and bbox query in TripsService and
 * ReportsService into a sequential scan — on a table of every breadcrumb ever
 * recorded. It would not throw. It would just get slower and slower.
 *
 * ── Why this file is the SECOND line of defence ─────────────────────────────
 * The real fix was to stop lying to Prisma: the indexes are now declared as
 * `@@index([...], type: Gist, map: "<original name>")` and the defaults as
 * `@default([])` in schema.prisma, so the datamodel matches the database and the
 * diff comes back empty. That removes the cause.
 *
 * This test guards the SYMPTOM, for the case where someone edits schema.prisma
 * in a way that drops one of those declarations and then generates a migration
 * from the newly-drifted model. It is cheap, it runs on every push, and it fails
 * with the name of the object about to be destroyed.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * Database objects that exist in production and must survive every migration.
 * Adding one here is how you protect it; the names are the real ones, so a
 * failure message can be acted on without opening the database.
 */
const PROTECTED_INDEXES = [
  'reports_geog_gix',
  'trip_points_geog_gix',
  'trip_routes_path_gix',
  'trips_destination_gix',
  'trips_origin_gix',
] as const;

/** `table.column` pairs whose DEFAULT is load-bearing. */
const PROTECTED_DEFAULTS = [
  { table: 'plans', column: 'features' },
  { table: 'sos_escalations', column: 'contact_order' },
] as const;

/**
 * SQL with comments removed.
 *
 * This matters: migrations in this repo DOCUMENT the forbidden statements in
 * their header comments (that is how the trap was communicated before it was
 * fixed). Matching raw text would fail on the very files that are behaving
 * correctly, so the guard would be turned off within a day.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' '); // line comments
}

function migrationFiles(): { name: string; sql: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    // No migrations directory checked out (a shallow tooling context). Nothing
    // to guard is not the same as a failure — the assertions below simply have
    // no input, and the "there is at least one migration" test catches a real
    // misconfiguration.
    return [];
  }
  return entries
    .filter((entry) => {
      try {
        return statSync(join(MIGRATIONS_DIR, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((dir) => ({
      name: dir,
      path: join(MIGRATIONS_DIR, dir, 'migration.sql'),
    }))
    .filter(({ path }) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map(({ name, path }) => ({
      name,
      sql: stripSqlComments(readFileSync(path, 'utf8')),
    }));
}

describe('prisma migrations', () => {
  const files = migrationFiles();

  it('finds the migrations directory (guard is actually running)', () => {
    // Without this, a bad path would make every assertion below vacuously pass
    // and the guard would protect nothing while looking green.
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(PROTECTED_INDEXES)('%s', (index) => {
    it('is never dropped by a migration', () => {
      const offenders = files
        .filter(({ sql }) =>
          new RegExp(`DROP\\s+INDEX[^;]*"?${index}"?`, 'i').test(sql),
        )
        .map(({ name }) => name);

      expect(offenders).toEqual([]);
    });
  });

  describe.each(PROTECTED_DEFAULTS)('$table.$column', ({ table, column }) => {
    it('never has its DEFAULT dropped by a migration', () => {
      const offenders = files
        .filter(({ sql }) =>
          new RegExp(
            `ALTER\\s+TABLE\\s+"?${table}"?[\\s\\S]*?ALTER\\s+COLUMN\\s+"?${column}"?\\s+DROP\\s+DEFAULT`,
            'i',
          ).test(sql),
        )
        .map(({ name }) => name);

      expect(offenders).toEqual([]);
    });
  });

  it('never drops a *_gix index under any name', () => {
    // A catch-all for spatial indexes added later that nobody remembered to add
    // to PROTECTED_INDEXES. The `_gix` suffix is this repo's convention for
    // hand-written GiST indexes.
    const offenders = files
      .filter(({ sql }) => /DROP\s+INDEX[^;]*_gix/i.test(sql))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('the comment-stripper does not neuter the guard', () => {
    // Proves the regexes still bite on real SQL — otherwise a bug in
    // stripSqlComments() would silently disarm every assertion above.
    const sql = stripSqlComments(
      '-- DROP INDEX "reports_geog_gix"; (documented, not executed)\n' +
        'DROP INDEX "reports_geog_gix";',
    );
    expect(sql).not.toMatch(/documented/);
    expect(/DROP\s+INDEX[^;]*"?reports_geog_gix"?/i.test(sql)).toBe(true);
  });
});
