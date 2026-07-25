import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TRIP_STATS_COORD_PRECISION,
  TRIP_STATS_TOP_LIMIT,
  TRIP_STATS_UNAVAILABLE_MSG,
} from './constant/trips.constants';
import type {
  SosSummaryRow,
  TripAggregateRow,
  TripDestinationStatRow,
  TripDistanceRow,
  TripRouteStatRow,
  TripStatsView,
} from './type/trip-stats.types';

/** The answer for a user with no trips at all — never a row of NULLs. */
const EMPTY_AGGREGATE: TripAggregateRow = {
  trips: 0,
  completed: 0,
  cancelled: 0,
  inProgress: 0,
  checkins: 0,
  finishedTrips: 0,
  travelTimeS: 0,
  longestTripS: null,
  firstTripAt: null,
  lastTripAt: null,
};

const EMPTY_SOS: SosSummaryRow = { raised: 0, resolved: 0 };

/**
 * Trip history & analytics — the Premium `analytics` capability (build plan §20).
 *
 * ─────────────────────────── HOW THE PLAN APPLIES ────────────────────────────
 * Two entitlement touch-points, both routed through EntitlementsService so the
 * single ENFORCE_PLAN_LIMITS switch governs them:
 *
 *   1. `assertCapability('analytics')` — throws 403 ONLY while enforcement is on.
 *      It is off today, so EVERY user gets the full analysis. The resulting
 *      `CapabilityCheck` is returned in the payload so the client can say "this
 *      is a Premium feature you currently have" instead of inventing a lock.
 *   2. `getWindow('tripHistoryDays')` — the retention window. `since` is the
 *      cutoff to APPLY and is null while enforcement is off, so the queries below
 *      read exactly the same rows they would with no plan system at all.
 *      `wouldApplySince` is reported alongside, for honest UI copy.
 *
 * Nothing here removes anything from anyone today.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every number is aggregated IN POSTGRES. A traveller with a year of one-second
 * breadcrumbs has millions of trip_points rows; loading them to sum a distance in
 * Node would be a memory incident, so distance is measured with PostGIS
 * (ST_MakeLine per trip → ST_Length on the geography) and the counters are one
 * FILTERed aggregate scan.
 */
@Injectable()
export class TripStatsService {
  private readonly logger = new Logger(TripStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getStats(userId: string): Promise<TripStatsView> {
    // 403 only when ENFORCE_PLAN_LIMITS is on. Off today ⇒ never throws, and the
    // check itself is what the client renders as the Premium label.
    const analytics = await this.entitlements.assertCapability(
      userId,
      'analytics',
    );
    const window = await this.entitlements.getWindow(userId, 'tripHistoryDays');
    // THE cutoff. Null while enforcement is off — the queries then see everything.
    const since = window.since;

    // Started first so it overlaps the rest. It never rejects: distance is the
    // one figure that depends on PostGIS, and losing it must not lose the page.
    const distancePromise = this.totalDistanceM(userId, since);

    let aggregate: TripAggregateRow;
    let sos: SosSummaryRow;
    let topRoutes: TripRouteStatRow[];
    let topDestinations: TripDestinationStatRow[];
    try {
      [aggregate, sos, topRoutes, topDestinations] = await Promise.all([
        this.tripAggregate(userId, since),
        this.sosSummary(userId, since),
        this.topRoutes(userId, since),
        this.topDestinations(userId, since),
      ]);
    } catch (error) {
      this.logger.error(
        `Failed to compute trip stats for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      // A human sentence, never a bare 500 — and it says the history is intact.
      throw new ServiceUnavailableException(TRIP_STATS_UNAVAILABLE_MSG);
    }

    const distanceM = await distancePromise;

    const finishedTrips = aggregate.finishedTrips;
    const decided = aggregate.completed + aggregate.cancelled;

    return {
      range: {
        planCode: window.planCode,
        enforced: window.enforced,
        windowDays: window.windowDays,
        since: window.since,
        wouldApplySince: window.wouldApplySince,
        coversEverything: window.since === null,
      },
      analytics,
      totals: {
        trips: aggregate.trips,
        distanceM,
        travelTimeS: Math.round(aggregate.travelTimeS),
        // A mean over zero finished trips is UNKNOWN, not zero.
        avgDurationS:
          finishedTrips > 0
            ? Math.round(aggregate.travelTimeS / finishedTrips)
            : null,
        longestTripS:
          aggregate.longestTripS === null
            ? null
            : Math.round(aggregate.longestTripS),
        firstTripAt: aggregate.firstTripAt,
        lastTripAt: aggregate.lastTripAt,
      },
      safety: {
        completed: aggregate.completed,
        cancelled: aggregate.cancelled,
        inProgress: aggregate.inProgress,
        sosRaised: sos.raised,
        sosResolved: sos.resolved,
        checkins: aggregate.checkins,
        // Same rule: a rate over nothing is unknown, not 0%.
        arrivalRate:
          decided > 0 ? round(aggregate.completed / decided, 4) : null,
      },
      topRoutes,
      topDestinations,
    };
  }

  // ── queries ───────────────────────────────────────────────────────────

  /**
   * One scan of the user's trips for every counter, using FILTER so a single
   * pass answers "how many, how long, how did they end".
   */
  private async tripAggregate(
    userId: string,
    since: Date | null,
  ): Promise<TripAggregateRow> {
    const rows = await this.prisma.$queryRaw<TripAggregateRow[]>(
      Prisma.sql`
        SELECT
          COUNT(*)::int                                             AS "trips",
          COUNT(*) FILTER (WHERE t.status = 'COMPLETED')::int       AS "completed",
          COUNT(*) FILTER (WHERE t.status = 'CANCELLED')::int       AS "cancelled",
          COUNT(*) FILTER (WHERE t.status IN ('ACTIVE', 'SOS'))::int AS "inProgress",
          COUNT(*) FILTER (WHERE t.checkin_at IS NOT NULL)::int     AS "checkins",
          COUNT(*) FILTER (WHERE t.duration_s IS NOT NULL)::int     AS "finishedTrips",
          COALESCE(SUM(t.duration_s), 0)::float8                    AS "travelTimeS",
          MAX(t.duration_s)::float8                                 AS "longestTripS",
          MIN(t.started_at)                                         AS "firstTripAt",
          MAX(t.started_at)                                         AS "lastTripAt"
        FROM trips t
        WHERE t.user_id = ${userId}::uuid
          ${this.tripWindow(since)}`,
    );
    return rows[0] ?? EMPTY_AGGREGATE;
  }

  /**
   * Metres travelled: each trip's breadcrumbs stitched into a line, measured on
   * the spheroid, then summed. Built from lat/lng rather than the `geog` column
   * so a row whose geography failed to write still counts.
   *
   * NEVER REJECTS. A PostGIS failure returns null — "we couldn't measure this",
   * which the client renders as "—". Reporting 0 km would be a lie.
   */
  private async totalDistanceM(
    userId: string,
    since: Date | null,
  ): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRaw<TripDistanceRow[]>(
        Prisma.sql`
          SELECT COALESCE(SUM(leg.meters), 0)::float8 AS "distanceM"
          FROM (
            SELECT ST_Length(
                     ST_MakeLine(
                       ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)
                       ORDER BY p.recorded_at, p.id
                     )::geography
                   ) AS meters
            FROM trip_points p
            JOIN trips t ON t.id = p.trip_id
            WHERE t.user_id = ${userId}::uuid
              ${this.tripWindow(since)}
            GROUP BY p.trip_id
            -- A single breadcrumb is a dot, not a journey: no line, no length.
            HAVING COUNT(*) > 1
          ) leg`,
      );
      const meters = rows[0]?.distanceM;
      return typeof meters === 'number' && Number.isFinite(meters)
        ? Math.round(meters)
        : null;
    } catch (error) {
      this.logger.error(
        `Failed to measure trip distance for user ${userId} — reporting it as unknown`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /** SOS alarms raised in range, and how many were resolved. */
  private async sosSummary(
    userId: string,
    since: Date | null,
  ): Promise<SosSummaryRow> {
    const rows = await this.prisma.$queryRaw<SosSummaryRow[]>(
      Prisma.sql`
        SELECT
          COUNT(*)::int                                          AS "raised",
          COUNT(*) FILTER (WHERE s.resolved_at IS NOT NULL)::int AS "resolved"
        FROM sos_events s
        WHERE s.user_id = ${userId}::uuid
          ${since ? Prisma.sql`AND s.created_at >= ${since}` : Prisma.empty}`,
    );
    return rows[0] ?? EMPTY_SOS;
  }

  /** The origin→destination pairs the user travels most. */
  private async topRoutes(
    userId: string,
    since: Date | null,
  ): Promise<TripRouteStatRow[]> {
    return this.prisma.$queryRaw<TripRouteStatRow[]>(
      Prisma.sql`
        WITH journey AS (
          SELECT
            ${this.placeKey('origin_label', 'origin_lat', 'origin_lng')} AS origin,
            ${this.placeKey('dest_label', 'dest_lat', 'dest_lng')}       AS destination,
            t.duration_s,
            t.started_at
          FROM trips t
          WHERE t.user_id = ${userId}::uuid
            ${this.tripWindow(since)}
        )
        SELECT
          origin,
          destination,
          COUNT(*)::int           AS "trips",
          AVG(duration_s)::float8 AS "avgDurationS",
          MAX(started_at)         AS "lastAt"
        FROM journey
        GROUP BY origin, destination
        ORDER BY "trips" DESC, "lastAt" DESC
        LIMIT ${TRIP_STATS_TOP_LIMIT}`,
    );
  }

  /** The places the user travels TO most, with a centroid to drop a pin on. */
  private async topDestinations(
    userId: string,
    since: Date | null,
  ): Promise<TripDestinationStatRow[]> {
    return this.prisma.$queryRaw<TripDestinationStatRow[]>(
      Prisma.sql`
        WITH arrival AS (
          SELECT
            ${this.placeKey('dest_label', 'dest_lat', 'dest_lng')} AS label,
            t.dest_lat,
            t.dest_lng,
            t.started_at
          FROM trips t
          WHERE t.user_id = ${userId}::uuid
            ${this.tripWindow(since)}
        )
        SELECT
          label,
          COUNT(*)::int         AS "trips",
          AVG(dest_lat)::float8 AS "lat",
          AVG(dest_lng)::float8 AS "lng",
          MAX(started_at)       AS "lastAt"
        FROM arrival
        GROUP BY label
        ORDER BY "trips" DESC, "lastAt" DESC
        LIMIT ${TRIP_STATS_TOP_LIMIT}`,
    );
  }

  // ── SQL fragments ─────────────────────────────────────────────────────

  /**
   * The retention cutoff as SQL. `Prisma.empty` when there is none — which is
   * ALWAYS the case while enforcement is off, so the statement sent to Postgres
   * is byte-for-byte the one that existed before plans did.
   */
  private tripWindow(since: Date | null): Prisma.Sql {
    return since ? Prisma.sql`AND t.started_at >= ${since}` : Prisma.empty;
  }

  /**
   * How a place is identified for grouping: its label when the user gave one,
   * otherwise its rounded coordinates, so repeated journeys to the same
   * unlabelled spot still group together.
   *
   * Column names are interpolated with `Prisma.raw` — they are compile-time
   * literals from this file, never user input.
   */
  private placeKey(
    labelColumn: string,
    latColumn: string,
    lngColumn: string,
  ): Prisma.Sql {
    return Prisma.sql`
      COALESCE(
        NULLIF(btrim(t.${Prisma.raw(labelColumn)}), ''),
        round(t.${Prisma.raw(latColumn)}::numeric, ${TRIP_STATS_COORD_PRECISION}::int)::text
          || ', ' ||
        round(t.${Prisma.raw(lngColumn)}::numeric, ${TRIP_STATS_COORD_PRECISION}::int)::text
      )`;
  }
}

/** Rounds to `places` decimals without dragging in a float artefact tail. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
