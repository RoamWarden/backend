/** Module-local constants for the reports module (domain-wide ones live in common/constants). */

/** Hard cap on the `radiusM` accepted by GET /reports/near (metres). */
export const REPORT_NEAR_MAX_RADIUS_M = 10_000;

/** Max rows returned by any report list query (bbox / near). */
export const REPORT_QUERY_LIMIT = 200;

export const BBOX_FORMAT_HINT =
  "Expected format: 'minLng,minLat,maxLng,maxLat' with valid WGS84 coordinates " +
  "(e.g. '3.35,6.44,3.42,6.52').";

// ─────────────────────────── self-retraction ────────────────────────────────
//
// A reporter taking their OWN report down. Deliberately the same terminal state
// as an admin takedown (`ReportStatus.REMOVED` + the removal audit columns) and
// NOT a new enum value: every read path already filters
// `status IN ('UNCONFIRMED','VERIFIED')`, so reusing REMOVED makes a retracted
// report disappear from the map, the bbox/near lists AND the clustering
// auto-verify the moment it is written — with zero migrations and no deploy
// ordering dance for a distinction nobody can see.
//
// The two are still told apart in the audit: on a self-retraction
// `removed_by_id` IS the reporter's own id (on a takedown it is the admin's).
// That equality is the machine-checkable discriminator; the reason below is the
// human one.

/** Written to `reports.removed_reason` when the reporter takes their own report down. */
export const REPORT_SELF_RETRACT_REASON = 'Retracted by the reporter.';

/** 404: the id is not a report we hold (already hard-deleted, or a bad link). */
export const REPORT_RETRACT_NOT_FOUND_MSG =
  'Report not found — it may have already been taken down or expired.';

/**
 * 403: somebody else's report. Says WHY, and says what they can do instead —
 * a stranger who thinks a report is wrong has the deny vote, not a delete key.
 */
export const REPORT_RETRACT_FORBIDDEN_MSG =
  'Only the person who filed this report can take it down. If you think it is wrong, mark it “not there / unclear” instead.';
