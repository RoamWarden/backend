import type { Trip } from '@prisma/client';

import type { LimitValue } from '../../../common/entitlements';

/**
 * A trip row plus the ids of the trusted contacts watching it.
 *
 * WHY THIS EXISTS. `watcherContactIds` is not a scalar on the Prisma model — the
 * links live in `trip_watchers` — so a raw trip row carries no answer to "who
 * can see this journey?". The app nevertheless had a `watcherContactIds` field
 * and, receiving nothing, MANUFACTURED `[]` and printed it as fact: "Nobody is
 * following" on Home, "Private journey · no watchers selected" in the history,
 * and a no-contacts warning on the trip screen — for journeys that were shared
 * with several people. On a safety app that is the worst direction to be wrong
 * in, so the server now answers the question instead of the client guessing.
 *
 * The ids are `TripWatcher.contactId` — the SAME id space as `GET /me/contacts`,
 * so a client can resolve them to names without another round trip.
 *
 * ADDITIVE: this is a new property on an existing object. Older clients ignore
 * it, and an absent value must be read as UNKNOWN, never as "nobody".
 */
export type TripWithWatchers = Trip & { watcherContactIds: string[] };

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
