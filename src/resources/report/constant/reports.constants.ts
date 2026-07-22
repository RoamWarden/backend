/** Module-local constants for the reports module (domain-wide ones live in common/constants). */

/** Hard cap on the `radiusM` accepted by GET /reports/near (metres). */
export const REPORT_NEAR_MAX_RADIUS_M = 10_000;

/** Max rows returned by any report list query (bbox / near). */
export const REPORT_QUERY_LIMIT = 200;

export const BBOX_FORMAT_HINT =
  "Expected format: 'minLng,minLat,maxLng,maxLat' with valid WGS84 coordinates " +
  "(e.g. '3.35,6.44,3.42,6.52').";
