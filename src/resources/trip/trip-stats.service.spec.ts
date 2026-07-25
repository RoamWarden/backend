import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import { TRIP_STATS_UNAVAILABLE_MSG } from './constant/trips.constants';
import { TripStatsService } from './trip-stats.service';
import type {
  SosSummaryRow,
  TripAggregateRow,
  TripDestinationStatRow,
  TripDistanceRow,
  TripRouteStatRow,
} from './type/trip-stats.types';

type AnyMock = jest.Mock;

/** Which of the five statements a captured Prisma.Sql is. */
type QueryKind =
  'aggregate' | 'distance' | 'sos' | 'routes' | 'destinations' | 'unknown';

function classify(sql: string): QueryKind {
  if (sql.includes('ST_MakeLine')) return 'distance';
  if (sql.includes('sos_events')) return 'sos';
  if (sql.includes('WITH journey')) return 'routes';
  if (sql.includes('WITH arrival')) return 'destinations';
  if (sql.includes('"finishedTrips"')) return 'aggregate';
  return 'unknown';
}

const USER_ID = 'user-1';

const aggregateRow = (
  over: Partial<TripAggregateRow> = {},
): TripAggregateRow => ({
  trips: 10,
  completed: 7,
  cancelled: 2,
  inProgress: 1,
  checkins: 3,
  finishedTrips: 9,
  travelTimeS: 27_000,
  longestTripS: 7_200,
  firstTripAt: new Date('2026-05-01T08:00:00Z'),
  lastTripAt: new Date('2026-07-20T18:30:00Z'),
  ...over,
});

const EMPTY_AGGREGATE_ROW: TripAggregateRow = {
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

const ROUTE_ROW: TripRouteStatRow = {
  origin: 'Home',
  destination: 'Office',
  trips: 4,
  avgDurationS: 1_500,
  lastAt: new Date('2026-07-20T18:30:00Z'),
};

const DESTINATION_ROW: TripDestinationStatRow = {
  label: 'Office',
  trips: 4,
  lat: 6.6,
  lng: 3.4,
  lastAt: new Date('2026-07-20T18:30:00Z'),
};

/** Enforcement OFF — the shipping state. `since` null, `allowed` true. */
const freeUnenforcedWindow = {
  key: 'tripHistoryDays' as const,
  planCode: 'free',
  enforced: false,
  windowDays: 30,
  since: null,
  wouldApplySince: new Date('2026-06-25T00:00:00Z'),
};

const freeUnenforcedAnalytics = {
  key: 'analytics' as const,
  planCode: 'free',
  enforced: false,
  granted: false,
  allowed: true,
  wouldBlock: true,
  message: 'Trip history & analytics is part of Premium. Upgrade to unlock it.',
};

describe('TripStatsService', () => {
  let service: TripStatsService;
  let prisma: { $queryRaw: AnyMock };
  let entitlements: { assertCapability: AnyMock; getWindow: AnyMock };
  /** Every statement the service issued, in `kind → Sql` form. */
  let issued: Map<QueryKind, Prisma.Sql>;

  /** Routes each statement to its canned rows; override one to fail a query. */
  const rowsFor: Partial<Record<QueryKind, unknown[]>> = {};

  beforeEach(async () => {
    issued = new Map();
    rowsFor.aggregate = [aggregateRow()];
    rowsFor.distance = [{ distanceM: 123_456.7 } satisfies TripDistanceRow];
    rowsFor.sos = [{ raised: 1, resolved: 1 } satisfies SosSummaryRow];
    rowsFor.routes = [ROUTE_ROW];
    rowsFor.destinations = [DESTINATION_ROW];

    prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) => {
        const kind = classify(query.text);
        issued.set(kind, query);
        return Promise.resolve(rowsFor[kind] ?? []);
      }),
    };

    entitlements = {
      assertCapability: jest.fn().mockResolvedValue(freeUnenforcedAnalytics),
      getWindow: jest.fn().mockResolvedValue(freeUnenforcedWindow),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripStatsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: entitlements },
      ],
    }).compile();

    service = module.get(TripStatsService);
  });

  /** Makes one statement reject, to prove the degrade/fail paths. */
  const failQuery = (kind: QueryKind): void => {
    prisma.$queryRaw.mockImplementation((query: Prisma.Sql) => {
      const found = classify(query.text);
      issued.set(found, query);
      if (found === kind) return Promise.reject(new Error('db exploded'));
      return Promise.resolve(rowsFor[found] ?? []);
    });
  };

  // ── the switch ──────────────────────────────────────────────────────────

  describe('with enforcement OFF (the shipping state)', () => {
    it('gives a FREE user the full analysis and never narrows the window', async () => {
      const stats = await service.getStats(USER_ID);

      expect(entitlements.assertCapability).toHaveBeenCalledWith(
        USER_ID,
        'analytics',
      );
      // Real numbers, for a user whose plan does not include analytics.
      expect(stats.analytics.granted).toBe(false);
      expect(stats.analytics.allowed).toBe(true);
      expect(stats.totals.trips).toBe(10);
      expect(stats.range).toEqual({
        planCode: 'free',
        enforced: false,
        windowDays: 30,
        since: null,
        wouldApplySince: freeUnenforcedWindow.wouldApplySince,
        coversEverything: true,
      });
    });

    it('sends no started_at cutoff to Postgres at all', async () => {
      await service.getStats(USER_ID);

      for (const [, query] of issued) {
        expect(query.text).not.toContain('started_at >=');
        // The only bound value is the user id.
        expect(query.values).toEqual(
          expect.not.arrayContaining([expect.any(Date)]),
        );
      }
    });
  });

  describe('with enforcement ON', () => {
    it('propagates the 403 from assertCapability and runs no query', async () => {
      entitlements.assertCapability.mockRejectedValueOnce(
        new ForbiddenException({ code: 'PLAN_UPGRADE_REQUIRED' }),
      );

      await expect(service.getStats(USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('applies the cutoff EntitlementsService returns to every trip query', async () => {
      const since = new Date('2026-06-25T00:00:00Z');
      entitlements.getWindow.mockResolvedValueOnce({
        ...freeUnenforcedWindow,
        enforced: true,
        since,
      });

      const stats = await service.getStats(USER_ID);

      expect(stats.range.coversEverything).toBe(false);
      for (const kind of [
        'aggregate',
        'distance',
        'routes',
        'destinations',
      ] as const) {
        expect(issued.get(kind)?.text).toContain('t.started_at >=');
        expect(issued.get(kind)?.values).toContainEqual(since);
      }
      // SOS events are dated by their own column.
      expect(issued.get('sos')?.text).toContain('s.created_at >=');
    });
  });

  // ── honest numbers ──────────────────────────────────────────────────────

  describe('empty history', () => {
    beforeEach(() => {
      rowsFor.aggregate = [EMPTY_AGGREGATE_ROW];
      rowsFor.distance = [{ distanceM: 0 }];
      rowsFor.sos = [{ raised: 0, resolved: 0 }];
      rowsFor.routes = [];
      rowsFor.destinations = [];
    });

    it('reports unknown as null, never as a zero pretending to be an average', async () => {
      const stats = await service.getStats(USER_ID);

      expect(stats.totals.trips).toBe(0);
      expect(stats.totals.avgDurationS).toBeNull();
      expect(stats.totals.longestTripS).toBeNull();
      expect(stats.totals.firstTripAt).toBeNull();
      expect(stats.safety.arrivalRate).toBeNull();
      expect(stats.topRoutes).toEqual([]);
      expect(stats.topDestinations).toEqual([]);
    });

    it('survives a driver that returns no row at all', async () => {
      rowsFor.aggregate = [];
      rowsFor.sos = [];

      const stats = await service.getStats(USER_ID);

      expect(stats.totals.trips).toBe(0);
      expect(stats.safety.sosRaised).toBe(0);
    });
  });

  it('derives the average, the arrival rate and the safety summary', async () => {
    const stats = await service.getStats(USER_ID);

    // 27000s over 9 finished trips.
    expect(stats.totals.avgDurationS).toBe(3_000);
    expect(stats.totals.travelTimeS).toBe(27_000);
    // 7 arrived of 9 decided (the live one is not counted against the rate).
    expect(stats.safety).toEqual({
      completed: 7,
      cancelled: 2,
      inProgress: 1,
      sosRaised: 1,
      sosResolved: 1,
      checkins: 3,
      arrivalRate: 0.7778,
    });
  });

  it('returns the most-travelled routes and destinations as the server ranked them', async () => {
    const stats = await service.getStats(USER_ID);

    expect(stats.topRoutes).toEqual([ROUTE_ROW]);
    expect(stats.topDestinations).toEqual([DESTINATION_ROW]);
    expect(issued.get('routes')?.text).toContain(
      'ORDER BY "trips" DESC, "lastAt" DESC',
    );
  });

  it('aggregates in SQL — it never reads trip_points into memory', async () => {
    await service.getStats(USER_ID);

    const distance = issued.get('distance');
    expect(distance?.text).toContain('SUM(leg.meters)');
    expect(distance?.text).toContain('GROUP BY p.trip_id');
    // A lone breadcrumb is a dot, not a journey.
    expect(distance?.text).toContain('HAVING COUNT(*) > 1');
  });

  // ── failure paths ───────────────────────────────────────────────────────

  it('reports distance as UNKNOWN (null), not 0, when PostGIS fails', async () => {
    failQuery('distance');

    const stats = await service.getStats(USER_ID);

    expect(stats.totals.distanceM).toBeNull();
    // The rest of the page is intact.
    expect(stats.totals.trips).toBe(10);
    expect(stats.safety.completed).toBe(7);
  });

  it('rounds a measured distance to whole metres', async () => {
    const stats = await service.getStats(USER_ID);
    expect(stats.totals.distanceM).toBe(123_457);
  });

  it('fails with a human message — never a bare 500 — when the counters fail', async () => {
    failQuery('aggregate');

    await expect(service.getStats(USER_ID)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.getStats(USER_ID)).rejects.toThrow(
      TRIP_STATS_UNAVAILABLE_MSG,
    );
  });
});
