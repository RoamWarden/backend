import type { LimitValue } from '../../../common/entitlements';

/**
 * How far back a caller's trip history reaches, and how far their plan SAYS it
 * may reach (build plan §20, `tripHistoryDays`).
 *
 * Reported by both `GET /trips` and `GET /trips/stats`. `since` is the cutoff
 * ACTUALLY applied and is null while ENFORCE_PLAN_LIMITS is off — the shipping
 * state — so everyone sees their entire history. `wouldApplySince` is what the
 * cutoff would be if the switch were on: safe to display ("Free covers the last
 * 30 days"), because showing a window is not the same as hiding trips.
 *
 * A CLIENT MUST NEVER TRIM THE LIST ITSELF. If the server sent a row, the user
 * is entitled to see it.
 */
export interface TripHistoryWindow {
  /** The plan whose window applies (the entitled plan). */
  planCode: string;
  /** Whether the window is enforced right now. False today. */
  enforced: boolean;
  /** The plan's window in days; null = unlimited. */
  windowDays: LimitValue;
  /** The cutoff actually applied. null = none: everything is included. */
  since: Date | null;
  /** The cutoff that WOULD apply if enforcement were on; null when unlimited. */
  wouldApplySince: Date | null;
  /** True when nothing was cut off (`since === null`). */
  coversEverything: boolean;
}

export interface TripPointView {
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  accuracy: number | null;
  recordedAt: Date;
}

/** Anonymized report shape for the live view. */
export interface LiveViewReport {
  id: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  note: string | null;
  confirmCount: number;
  denyCount: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface RouteGeoJsonRow {
  source: string | null;
  geojson: string | null;
}

/** ACTIVE-trip row the no-arrival/stall monitor evaluates each sweep. */
export interface MonitoredTrip {
  id: string;
  userId: string;
  startedAt: Date;
  expectedDurationS: number | null;
  lastPointAt: Date | null;
  checkinAt: Date | null;
  overdueNotifiedAt: Date | null;
  escalatedAt: Date | null;
  destLabel: string | null;
  shareTokenVersion: number;
  user: { name: string };
}
