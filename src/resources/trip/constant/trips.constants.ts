export const LIVE_VIEW_REPORT_RADIUS_M = 1000;
export const LIVE_VIEW_REPORT_LIMIT = 200;
export const TRIP_DETAIL_POINT_LIMIT = 100;
export const LIVE_VIEW_POINT_LIMIT = 50;
/** Max ACTIVE trips the no-arrival/stall monitor processes per cron sweep. */
export const TRIP_MONITOR_SWEEP_LIMIT = 500;
export const TRIP_NOT_FOUND_MSG =
  'Trip not found — check the trip id and make sure the trip belongs to you.';
export const LIVE_LINK_INVALID_MSG =
  'This live trip link is invalid or has expired.';

/**
 * How many routes / destinations GET /trips/stats returns. Three is a summary a
 * phone screen can actually read; a longer list is a report, not an insight.
 */
export const TRIP_STATS_TOP_LIMIT = 3;

/**
 * Decimal places used to group unlabelled origins/destinations by coordinate.
 * 3dp ≈ 110 m, so two departures from the same street corner count as the same
 * place while two genuinely different stops stay apart.
 */
export const TRIP_STATS_COORD_PRECISION = 3;

/**
 * Shown when the stats aggregation itself fails. The history list is unaffected,
 * so the copy points back at the thing that still works instead of implying the
 * user's trips are gone.
 */
export const TRIP_STATS_UNAVAILABLE_MSG =
  "We couldn't work out your trip insights just now. Your trips are safe — please try again in a moment.";
