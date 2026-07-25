import type { CapabilityCheck } from '../../../common/entitlements';
import type { TripHistoryWindow } from './trips.types';

/**
 * Shapes for GET /trips/stats — "trip history & analytics" (build plan §20,
 * Premium capability `analytics`).
 *
 * Everything here is DERIVED from trips the user already has: no schema change,
 * no new writes, nothing recorded. Aggregation happens in SQL — a year of
 * breadcrumbs must never be pulled into Node just to add up a distance.
 *
 * READ THIS BEFORE RENDERING: `range` reports the retention window the plan
 * DESCRIBES; `range.since` is the cutoff actually applied, and it is null while
 * ENFORCE_PLAN_LIMITS is off (the shipping state), which means every user sees
 * their whole history. Clients must render the window as information, never as a
 * lock, and must never fake a cut-off the server did not make.
 */

/** The headline counters. */
export interface TripStatsTotals {
  /** Journeys in range, whatever their status. */
  trips: number;
  /**
   * Metres travelled, summed per trip from its recorded breadcrumbs.
   * `null` means we could not measure it (a PostGIS failure) — NOT zero. Render
   * the difference: "—", never "0 km".
   */
  distanceM: number | null;
  /** Seconds of recorded travel (finished trips only — a live trip has no duration yet). */
  travelTimeS: number;
  /** Mean finished-trip duration in seconds; null until a trip has finished. */
  avgDurationS: number | null;
  /** The longest single finished trip in seconds; null until a trip has finished. */
  longestTripS: number | null;
  /** Oldest / newest journey start in range; null when there are no trips. */
  firstTripAt: Date | null;
  lastTripAt: Date | null;
}

/** "Did these journeys end well?" — the safety half of the summary. */
export interface TripSafetySummary {
  completed: number;
  cancelled: number;
  /** ACTIVE + SOS: journeys still under way. */
  inProgress: number;
  /** SOS alarms raised in range (sos_events, not trip status). */
  sosRaised: number;
  /** How many of those alarms were resolved. */
  sosResolved: number;
  /** Trips where the traveller answered an "I'm OK" nudge. */
  checkins: number;
  /**
   * completed / (completed + cancelled), 0–1. `null` when nothing has finished —
   * a rate over zero journeys is not 0%, it is unknown.
   */
  arrivalRate: number | null;
}

/** One origin→destination pair the user travels. */
export interface TripRouteStat {
  origin: string;
  destination: string;
  trips: number;
  /** Mean duration for this pair; null when none of them have finished. */
  avgDurationS: number | null;
  lastAt: Date;
}

/** One place the user travels TO. */
export interface TripDestinationStat {
  label: string;
  trips: number;
  /** Centroid of the grouped destinations — enough to drop a pin. */
  lat: number;
  lng: number;
  lastAt: Date;
}

/** The whole response of GET /trips/stats. */
export interface TripStatsView {
  /** How far back these numbers reach — see {@link TripHistoryWindow}. */
  range: TripHistoryWindow;
  /**
   * The `analytics` capability check for this user. While `enforced` is false,
   * `allowed` is true for everyone — so a Free user gets real numbers and the
   * client should LABEL this as a Premium feature they currently have, never
   * blur it or lock it.
   */
  analytics: CapabilityCheck;
  totals: TripStatsTotals;
  safety: TripSafetySummary;
  /** Most-travelled routes first. Empty when there are no trips in range. */
  topRoutes: TripRouteStat[];
  /** Most-visited destinations first. Empty when there are no trips in range. */
  topDestinations: TripDestinationStat[];
}

// ── raw SQL row shapes ──────────────────────────────────────────────────────
// Every numeric column is cast in SQL (::int / ::float8) so Prisma hands back
// plain numbers — an uncast COUNT(*) arrives as a BigInt, which JSON.stringify
// throws on.

export interface TripAggregateRow {
  trips: number;
  completed: number;
  cancelled: number;
  inProgress: number;
  checkins: number;
  /** Trips with a recorded duration — the denominator of the average. */
  finishedTrips: number;
  travelTimeS: number;
  longestTripS: number | null;
  firstTripAt: Date | null;
  lastTripAt: Date | null;
}

export interface TripDistanceRow {
  distanceM: number;
}

export interface SosSummaryRow {
  raised: number;
  resolved: number;
}

export interface TripRouteStatRow {
  origin: string;
  destination: string;
  trips: number;
  avgDurationS: number | null;
  lastAt: Date;
}

export interface TripDestinationStatRow {
  label: string;
  trips: number;
  lat: number;
  lng: number;
  lastAt: Date;
}
