import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TripStatus } from '@prisma/client';
import { TripsService } from './trips.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import { DirectionsService } from '../../providers/google/directions.service';
import { TokensService } from '../auth/tokens.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { UsersService } from '../user/users.service';
import { NotificationsService } from '../notification/notifications.service';
import { EntitlementsService } from '../../common/entitlements';
import {
  ACTIVE_TRIP_CONFLICT_MSG,
  CHECKIN_DURING_SOS_MSG,
  LIVE_LINK_INVALID_MSG,
  SOS_TRIP_CONFLICT_MSG,
  TRIP_NOT_FOUND_MSG,
} from './constant/trips.constants';
import { channelTripLive } from '../../providers/redis/constant/redis.constants';

const ACTIVE_CONFLICT_MSG = ACTIVE_TRIP_CONFLICT_MSG;

/**
 * The statuses a trip can be ended from. Spelled out here rather than imported
 * so the test fails loudly if someone quietly drops SOS from the live set —
 * that omission is exactly the bug this suite exists to prevent.
 */
const LIVE_STATUSES = [TripStatus.ACTIVE, TripStatus.SOS];

/** `expect.any(Date)` typed as Date so it can sit inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;
const ANY_NUMBER = expect.any(Number) as unknown as number;
const ANY_STRING = expect.any(String) as unknown as string;

type AnyMock = jest.Mock;

interface PrismaMock {
  trip: {
    findFirst: AnyMock;
    findUnique: AnyMock;
    findMany: AnyMock;
    count: AnyMock;
    create: AnyMock;
    update: AnyMock;
    updateMany: AnyMock;
    delete: AnyMock;
    findUniqueOrThrow: AnyMock;
  };
  tripWatcher: { findMany: AnyMock; createMany: AnyMock };
  tripRoute: { create: AnyMock };
  trustedContact: { findMany: AnyMock };
  tripPoint: { findMany: AnyMock };
  $transaction: AnyMock;
  $executeRaw: AnyMock;
  $queryRaw: AnyMock;
}

describe('TripsService', () => {
  let service: TripsService;
  let prisma: PrismaMock;
  let redis: {
    updatePresence: AnyMock;
    clearPresence: AnyMock;
    publishJson: AnyMock;
  };
  let config: { get: AnyMock };
  let directions: { getRoute: AnyMock };
  let tokens: { verifyAccessToken: AnyMock };
  let tripShareTokens: { issue: AnyMock; verify: AnyMock };
  let users: { filterConsentingContactUserIds: AnyMock; findById: AnyMock };
  let notifications: { sendToUsers: AnyMock };
  let entitlements: { getWindow: AnyMock };

  /** The shipping state: enforcement off ⇒ `since` null ⇒ nothing is narrowed. */
  const unenforcedWindow = () => ({
    key: 'tripHistoryDays' as const,
    planCode: 'free',
    enforced: false,
    windowDays: 30,
    since: null,
    wouldApplySince: new Date('2026-06-22T08:00:00Z'),
  });

  // A minimal tx object whose model methods mirror the ones createTrip touches.
  let txMock: {
    trip: { create: AnyMock };
    tripWatcher: { createMany: AnyMock };
    tripRoute: { create: AnyMock };
    $executeRaw: AnyMock;
  };

  const owner = { id: 'owner-1', email: 'owner@example.com' };

  const baseTrip = () => ({
    id: 'trip-1',
    userId: owner.id,
    mode: 'CAR',
    status: TripStatus.ACTIVE,
    originLabel: 'Home',
    destLabel: 'Airport',
    originLat: 6.5,
    originLng: 3.3,
    destLat: 6.6,
    destLng: 3.4,
    startedAt: new Date('2026-07-22T08:00:00Z'),
    endedAt: null,
    durationS: null,
    expectedDurationS: null,
    shareTokenVersion: 0,
  });

  beforeEach(async () => {
    txMock = {
      trip: { create: jest.fn() },
      tripWatcher: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      tripRoute: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    prisma = {
      trip: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
      },
      tripWatcher: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tripRoute: { create: jest.fn().mockResolvedValue({}) },
      trustedContact: { findMany: jest.fn().mockResolvedValue([]) },
      tripPoint: { findMany: jest.fn().mockResolvedValue([]) },
      // Runs the callback against txMock so the transactional body executes.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: typeof txMock) => unknown)(txMock)
          : Promise.resolve(arg),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    redis = {
      updatePresence: jest.fn().mockResolvedValue(undefined),
      clearPresence: jest.fn().mockResolvedValue(undefined),
      publishJson: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((key: string) =>
        key === 'API_BASE_URL' ? 'https://api.roamwarden.test' : undefined,
      ),
    };
    directions = { getRoute: jest.fn().mockResolvedValue(null) };
    tokens = { verifyAccessToken: jest.fn() };
    tripShareTokens = {
      issue: jest.fn().mockReturnValue({
        token: 'share-token',
        expiresAt: new Date('2026-07-23T08:00:00Z'),
      }),
      verify: jest.fn(),
    };
    users = {
      filterConsentingContactUserIds: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue({ id: owner.id, name: 'Ada' }),
    };
    notifications = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    entitlements = {
      getWindow: jest.fn().mockResolvedValue(unenforcedWindow()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
        { provide: DirectionsService, useValue: directions },
        { provide: TokensService, useValue: tokens },
        { provide: TripShareTokenService, useValue: tripShareTokens },
        { provide: UsersService, useValue: users },
        { provide: NotificationsService, useValue: notifications },
        { provide: EntitlementsService, useValue: entitlements },
      ],
    }).compile();

    service = module.get(TripsService);
  });

  // ── createTrip ──────────────────────────────────────────────────────────

  describe('createTrip', () => {
    const dto = {
      mode: 'CAR' as never,
      origin: { lat: 6.5, lng: 3.3, label: 'Home' },
      destination: { lat: 6.6, lng: 3.4, label: 'Airport' },
    };

    it('rejects a second ACTIVE trip with the exact conflict message', async () => {
      // Both invocations below see an existing active trip.
      prisma.trip.findFirst.mockResolvedValue(baseTrip());

      await expect(service.createTrip(owner, dto as never)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.createTrip(owner, dto as never)).rejects.toThrow(
        ACTIVE_CONFLICT_MSG,
      );
      // Short-circuits before touching the transaction.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('blocks a new trip while one is in SOS, with copy that fits an open alarm', async () => {
      // A trip in SOS is still running — it must occupy the one-live-trip slot.
      prisma.trip.findFirst.mockResolvedValue({
        ...baseTrip(),
        status: TripStatus.SOS,
      });

      await expect(service.createTrip(owner, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.createTrip(owner, dto)).rejects.toThrow(
        SOS_TRIP_CONFLICT_MSG,
      );
      expect(prisma.trip.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: owner.id, status: { in: LIVE_STATUSES } },
        }),
      );
      expect(txMock.trip.create).not.toHaveBeenCalled();
    });

    it('maps a P2002 unique-index violation from the tx to the same 409', async () => {
      const created = baseTrip();
      txMock.trip.create.mockResolvedValue(created);
      // The partial-unique-index backstop: the tx body throws P2002.
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test' },
      );
      prisma.$transaction.mockRejectedValueOnce(p2002);

      await expect(service.createTrip(owner, dto as never)).rejects.toThrow(
        ConflictException,
      );
      prisma.$transaction.mockRejectedValueOnce(p2002);
      await expect(service.createTrip(owner, dto as never)).rejects.toThrow(
        ACTIVE_CONFLICT_MSG,
      );
    });

    it('rethrows a non-P2002 known request error untouched', async () => {
      const other = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: 'test',
      });
      prisma.$transaction.mockRejectedValueOnce(other);

      await expect(service.createTrip(owner, dto as never)).rejects.toBe(other);
    });

    it('lists the bad watcher contact ids in a BadRequestException', async () => {
      const badId = '11111111-1111-1111-1111-111111111111';
      const goodId = '22222222-2222-2222-2222-222222222222';
      // Only goodId belongs to the caller.
      prisma.trustedContact.findMany.mockResolvedValueOnce([
        { id: goodId, contactUserId: null },
      ]);

      const withWatchers = {
        ...dto,
        watcherContactIds: [goodId, badId],
      };

      await expect(
        service.createTrip(owner, withWatchers as never),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createTrip(owner, withWatchers as never),
      ).rejects.toThrow(badId);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('uses the DirectionsService route (source "directions") when present', async () => {
      const created = baseTrip();
      txMock.trip.create.mockResolvedValue(created);
      directions.getRoute.mockResolvedValueOnce({
        points: [
          { lat: 6.5, lng: 3.3 },
          { lat: 6.55, lng: 3.35 },
          { lat: 6.6, lng: 3.4 },
        ],
        durationS: 1800,
        distanceM: 12000,
      });

      const result = await service.createTrip(owner, dto);

      expect(result.trip).toBe(created);
      expect(txMock.tripRoute.create).toHaveBeenCalledWith({
        data: { tripId: created.id, source: 'directions' },
      });
    });

    it('falls back to a straight-line corridor (source "straight_line") when getRoute returns null', async () => {
      const created = baseTrip();
      txMock.trip.create.mockResolvedValue(created);
      directions.getRoute.mockResolvedValueOnce(null);

      await service.createTrip(owner, dto);

      expect(txMock.tripRoute.create).toHaveBeenCalledWith({
        data: { tripId: created.id, source: 'straight_line' },
      });
    });

    it('passes the trip shareTokenVersion to tripShareTokens.issue', async () => {
      const created = { ...baseTrip(), shareTokenVersion: 7 };
      txMock.trip.create.mockResolvedValue(created);

      const result = await service.createTrip(owner, dto);

      expect(tripShareTokens.issue).toHaveBeenCalledWith(created.id, 7);
      expect(result.shareToken).toBe('share-token');
      // shareUrl is built from API_BASE_URL and the issued token.
      expect(result.shareUrl).toBe(
        `https://api.roamwarden.test/trips/${created.id}/live?token=share-token`,
      );
    });
  });

  // ── listTrips (plan retention) ──────────────────────────────────────────

  describe('listTrips', () => {
    /** Prisma.$transaction is mocked to resolve its argument — an array here. */
    const paged = (trips: unknown[], total: number) => {
      prisma.$transaction.mockResolvedValueOnce([trips, total]);
    };

    it('adds NO date filter while enforcement is off — the query is unchanged', async () => {
      paged([baseTrip()], 1);

      const result = await service.listTrips(owner.id, {});

      // The exact `where` the endpoint used before plans existed.
      expect(prisma.trip.findMany).toHaveBeenCalledWith({
        where: { userId: owner.id },
        orderBy: { startedAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(prisma.trip.count).toHaveBeenCalledWith({
        where: { userId: owner.id },
      });
      expect(result.total).toBe(1);
    });

    it("attaches each trip's watcher contact ids in ONE batched query", async () => {
      const a = { ...baseTrip(), id: 'trip-a' };
      const b = { ...baseTrip(), id: 'trip-b' };
      paged([a, b], 2);
      prisma.tripWatcher.findMany.mockResolvedValueOnce([
        { tripId: 'trip-a', contactId: 'contact-1' },
        { tripId: 'trip-a', contactId: 'contact-2' },
      ]);

      const result = await service.listTrips(owner.id, {});

      // Shared trip reports its real watchers…
      expect(result.trips[0].watcherContactIds).toEqual([
        'contact-1',
        'contact-2',
      ]);
      // …and a trip with no rows reports a KNOWN empty list, which is what lets
      // the client say "nobody" instead of guessing.
      expect(result.trips[1].watcherContactIds).toEqual([]);
      // One query for the whole page, not one per trip.
      expect(prisma.tripWatcher.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.tripWatcher.findMany).toHaveBeenCalledWith({
        where: { tripId: { in: ['trip-a', 'trip-b'] } },
        select: { tripId: true, contactId: true },
      });
    });

    it('queries no watchers at all for an empty page', async () => {
      paged([], 0);

      const result = await service.listTrips(owner.id, {});

      expect(result.trips).toEqual([]);
      expect(prisma.tripWatcher.findMany).not.toHaveBeenCalled();
    });

    it('reports the window as information: enforced false, since null', async () => {
      paged([], 0);

      const result = await service.listTrips(owner.id, {});

      expect(result.retention).toEqual({
        planCode: 'free',
        enforced: false,
        windowDays: 30,
        since: null,
        wouldApplySince: new Date('2026-06-22T08:00:00Z'),
        coversEverything: true,
      });
    });

    it('narrows to the window ONLY when EntitlementsService returns a cutoff', async () => {
      const since = new Date('2026-06-25T00:00:00Z');
      entitlements.getWindow.mockResolvedValueOnce({
        ...unenforcedWindow(),
        enforced: true,
        since,
        wouldApplySince: since,
      });
      paged([], 0);

      const result = await service.listTrips(owner.id, {
        status: TripStatus.COMPLETED,
      });

      expect(prisma.trip.findMany).toHaveBeenCalledWith({
        where: {
          userId: owner.id,
          status: TripStatus.COMPLETED,
          startedAt: { gte: since },
        },
        orderBy: { startedAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result.retention.coversEverything).toBe(false);
    });

    it('still caps the page size at 100 and honours page/limit', async () => {
      paged([], 0);

      await service.listTrips(owner.id, { page: 3, limit: 500 });

      expect(prisma.trip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 200, take: 100 }),
      );
    });
  });

  // ── getTrip ─────────────────────────────────────────────────────────────

  describe('getTrip', () => {
    it("returns the trip's watcher contact ids on the detail payload", async () => {
      prisma.trip.findUnique.mockResolvedValue(baseTrip());
      prisma.tripWatcher.findMany.mockResolvedValueOnce([
        { contactId: 'contact-9' },
      ]);

      const result = await service.getTrip(owner.id, 'trip-1');

      expect(result.trip.watcherContactIds).toEqual(['contact-9']);
      expect(prisma.tripWatcher.findMany).toHaveBeenCalledWith({
        where: { tripId: 'trip-1' },
        select: { contactId: true },
      });
    });

    it('returns an empty list — not a missing field — when nobody is watching', async () => {
      prisma.trip.findUnique.mockResolvedValue(baseTrip());

      const result = await service.getTrip(owner.id, 'trip-1');

      // The client distinguishes "we asked and it is empty" from "we never
      // knew", so the key must be present and the array real.
      expect(result.trip.watcherContactIds).toEqual([]);
    });
  });

  // ── getWatcherUserIds ───────────────────────────────────────────────────

  describe('getWatcherUserIds', () => {
    it('delegates to UsersService.filterConsentingContactUserIds with owner id + candidates', async () => {
      prisma.tripWatcher.findMany.mockResolvedValueOnce([
        { trip: { userId: owner.id }, contact: { contactUserId: 'u-a' } },
        { trip: { userId: owner.id }, contact: { contactUserId: 'u-b' } },
      ]);
      users.filterConsentingContactUserIds.mockResolvedValueOnce(['u-a']);

      const result = await service.getWatcherUserIds('trip-1');

      expect(users.filterConsentingContactUserIds).toHaveBeenCalledWith(
        owner.id,
        ['u-a', 'u-b'],
      );
      // Only consented users are returned.
      expect(result).toEqual(['u-a']);
    });

    it('returns [] without delegating when there are no linked watchers', async () => {
      prisma.tripWatcher.findMany.mockResolvedValueOnce([]);

      const result = await service.getWatcherUserIds('trip-1');

      expect(result).toEqual([]);
      expect(users.filterConsentingContactUserIds).not.toHaveBeenCalled();
    });
  });

  // ── isValidShareToken ───────────────────────────────────────────────────

  describe('isValidShareToken', () => {
    it('is true when the token verifies, tripId matches, and version matches', async () => {
      tripShareTokens.verify.mockReturnValueOnce({ tripId: 'trip-1', v: 3 });
      prisma.trip.findUnique.mockResolvedValueOnce({ shareTokenVersion: 3 });

      await expect(service.isValidShareToken('trip-1', 'tok')).resolves.toBe(
        true,
      );
    });

    it('is false when the embedded version differs (revoked link)', async () => {
      tripShareTokens.verify.mockReturnValueOnce({ tripId: 'trip-1', v: 2 });
      prisma.trip.findUnique.mockResolvedValueOnce({ shareTokenVersion: 5 });

      await expect(service.isValidShareToken('trip-1', 'tok')).resolves.toBe(
        false,
      );
    });

    it('is false when the token tripId does not match', async () => {
      tripShareTokens.verify.mockReturnValueOnce({ tripId: 'other', v: 3 });

      await expect(service.isValidShareToken('trip-1', 'tok')).resolves.toBe(
        false,
      );
      expect(prisma.trip.findUnique).not.toHaveBeenCalled();
    });

    it('is false when verify throws', async () => {
      tripShareTokens.verify.mockImplementationOnce(() => {
        throw new UnauthorizedException('bad');
      });

      await expect(service.isValidShareToken('trip-1', 'tok')).resolves.toBe(
        false,
      );
    });

    it('is false when the trip no longer exists', async () => {
      tripShareTokens.verify.mockReturnValueOnce({ tripId: 'trip-1', v: 3 });
      prisma.trip.findUnique.mockResolvedValueOnce(null);

      await expect(service.isValidShareToken('trip-1', 'tok')).resolves.toBe(
        false,
      );
    });
  });

  // ── reissueShareToken ───────────────────────────────────────────────────

  describe('reissueShareToken', () => {
    it('increments shareTokenVersion and issues a token with the NEW version', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce(baseTrip());
      prisma.trip.update.mockResolvedValueOnce({ shareTokenVersion: 4 });
      tripShareTokens.issue.mockReturnValueOnce({
        token: 'new-tok',
        expiresAt: new Date('2026-07-24T08:00:00Z'),
      });

      const result = await service.reissueShareToken(owner, 'trip-1');

      expect(prisma.trip.update).toHaveBeenCalledWith({
        where: { id: 'trip-1' },
        data: { shareTokenVersion: { increment: 1 } },
        select: { shareTokenVersion: true },
      });
      expect(tripShareTokens.issue).toHaveBeenCalledWith('trip-1', 4);
      expect(result.shareToken).toBe('new-tok');
    });

    it('404s (not found) when the trip is not owned by the caller', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        userId: 'someone-else',
      });

      await expect(service.reissueShareToken(owner, 'trip-1')).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
      expect(prisma.trip.update).not.toHaveBeenCalled();
    });
  });

  // ── getLiveView ─────────────────────────────────────────────────────────

  describe('getLiveView', () => {
    it('rejects with 401 when neither token nor bearer is supplied', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        user: { name: 'Ada' },
      });

      await expect(service.getLiveView('trip-1')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.getLiveView('trip-1')).rejects.toThrow(
        LIVE_LINK_INVALID_MSG,
      );
    });

    it('rejects a share token whose version is stale (does not match current)', async () => {
      prisma.trip.findUnique.mockResolvedValue({
        ...baseTrip(),
        shareTokenVersion: 5,
        user: { name: 'Ada' },
      });
      tripShareTokens.verify.mockReturnValue({ tripId: 'trip-1', v: 2 });

      await expect(
        service.getLiveView('trip-1', 'stale-token'),
      ).rejects.toThrow(LIVE_LINK_INVALID_MSG);
    });

    it('authorizes a share token whose version matches the current one', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        shareTokenVersion: 5,
        user: { name: 'Ada' },
      });
      tripShareTokens.verify.mockReturnValueOnce({ tripId: 'trip-1', v: 5 });

      const view = await service.getLiveView('trip-1', 'good-token');

      expect(view.trip.id).toBe('trip-1');
      expect(view.trip.owner).toEqual({ name: 'Ada' });
      expect(view.lastPoints).toEqual([]);
      expect(view.activeReports).toEqual([]);
    });

    it('returns the same 401 for a missing trip (no existence leak)', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce(null);

      await expect(service.getLiveView('trip-1', 'any-token')).rejects.toThrow(
        LIVE_LINK_INVALID_MSG,
      );
      // Never called verify — the 401 is identical to the bad-token path.
      expect(tripShareTokens.verify).not.toHaveBeenCalled();
    });

    it('authorizes the owner via a valid bearer token', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        user: { name: 'Ada' },
      });
      tokens.verifyAccessToken.mockReturnValueOnce({
        sub: owner.id,
        email: owner.email,
        type: 'access',
      });

      const view = await service.getLiveView(
        'trip-1',
        undefined,
        'Bearer abc.def.ghi',
      );

      expect(view.trip.id).toBe('trip-1');
    });
  });

  // ── stopTrip / completeTrip ─────────────────────────────────────────────

  describe('stopTrip (completeTrip)', () => {
    it('scopes updateMany to EVERY live status and, on success, clears presence and notifies watchers', async () => {
      const trip = baseTrip();
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.COMPLETED,
        endedAt: new Date(),
        durationS: 60,
      });
      // Owner has one consenting linked watcher.
      prisma.tripWatcher.findMany.mockResolvedValueOnce([
        { trip: { userId: owner.id }, contact: { contactUserId: 'w-1' } },
      ]);
      users.filterConsentingContactUserIds.mockResolvedValueOnce(['w-1']);

      const { trip: result } = await service.stopTrip(owner, 'trip-1', {});

      expect(prisma.trip.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'trip-1', status: { in: LIVE_STATUSES } },
        }),
      );
      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(redis.clearPresence).toHaveBeenCalledWith(owner.id);
      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        ['w-1'],
        expect.objectContaining({ title: 'Safe arrival' }),
      );
    });

    it('does NOT re-publish or re-notify when the conditional update loses the race (count === 0)', async () => {
      const trip = baseTrip();
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.COMPLETED,
      });

      const { trip: result } = await service.stopTrip(owner, 'trip-1', {});

      expect(result.status).toBe(TripStatus.COMPLETED);
      // Lost the race: no side effects fire the second time.
      expect(redis.publishJson).not.toHaveBeenCalled();
      expect(redis.clearPresence).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('ends a trip that is in SOS, and does NOT tell watchers they arrived safely', async () => {
      const trip = { ...baseTrip(), status: TripStatus.SOS };
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.COMPLETED,
        endedAt: new Date(),
        durationS: 60,
      });
      prisma.tripWatcher.findMany.mockResolvedValueOnce([
        { trip: { userId: owner.id }, contact: { contactUserId: 'w-1' } },
      ]);
      users.filterConsentingContactUserIds.mockResolvedValueOnce(['w-1']);

      const { trip: result } = await service.stopTrip(owner, 'trip-1', {});

      expect(result.status).toBe(TripStatus.COMPLETED);
      const [, message] = notifications.sendToUsers.mock.calls[0] as [
        string[],
        { title: string; body: string },
      ];
      expect(message.title).toBe('Trip ended');
      expect(message.body).toContain('SOS alert');
      expect(message.body).not.toContain('arrived safely');
    });

    it('is a no-op success on an already-ended trip: no final point, no presence write', async () => {
      const endedAt = new Date('2026-07-22T09:00:00Z');
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        status: TripStatus.COMPLETED,
        endedAt,
        durationS: 3600,
      });

      const { trip: result } = await service.stopTrip(owner, 'trip-1', {
        lat: 6.6,
        lng: 3.4,
      });

      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(result.endedAt).toEqual(endedAt);
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      // No breadcrumb insert and no presence write: the traveller may already
      // have a NEW trip running, and this dead one must not touch its state.
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(redis.updatePresence).not.toHaveBeenCalled();
      expect(redis.clearPresence).not.toHaveBeenCalled();
    });
  });

  // ── cancelTrip ──────────────────────────────────────────────────────────

  describe('cancelTrip', () => {
    it('CANCELS A TRIP THAT IS IN SOS — this is the bug: it used to match no rows and report success anyway', async () => {
      const trip = { ...baseTrip(), status: TripStatus.SOS };
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.CANCELLED,
        endedAt: new Date(),
        durationS: 120,
      });

      const { trip: result } = await service.cancelTrip(owner, 'trip-1');

      expect(prisma.trip.updateMany).toHaveBeenCalledWith({
        where: { id: 'trip-1', status: { in: LIVE_STATUSES } },
        data: {
          status: TripStatus.CANCELLED,
          endedAt: ANY_DATE,
          durationS: ANY_NUMBER,
        },
      });
      expect(result.status).toBe(TripStatus.CANCELLED);
      // Teardown must be identical to an ACTIVE cancel: presence gone, watchers
      // told the journey is over.
      expect(redis.clearPresence).toHaveBeenCalledWith(owner.id);
      expect(redis.publishJson).toHaveBeenCalledWith(
        channelTripLive('trip-1'),
        expect.objectContaining({
          kind: 'status',
          status: TripStatus.CANCELLED,
          endedAt: ANY_STRING,
        }),
      );
      // Cancelling is not "I'm safe": no push goes out, and the SOS event is
      // left for the traveller to stand down themselves.
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('cancels an ACTIVE trip and tears tracking down', async () => {
      const trip = baseTrip();
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.CANCELLED,
        endedAt: new Date(),
        durationS: 60,
      });

      const { trip: result } = await service.cancelTrip(owner, 'trip-1');

      expect(result.status).toBe(TripStatus.CANCELLED);
      expect(redis.clearPresence).toHaveBeenCalledWith(owner.id);
    });

    it.each([TripStatus.COMPLETED, TripStatus.CANCELLED])(
      'is a no-op SUCCESS on a trip that already ended (%s) — never a 409 the traveller cannot act on',
      async (status) => {
        const endedAt = new Date('2026-07-22T09:00:00Z');
        prisma.trip.findUnique.mockResolvedValueOnce({
          ...baseTrip(),
          status,
          endedAt,
          durationS: 3600,
        });

        const { trip: result } = await service.cancelTrip(owner, 'trip-1');

        // Reports the truth and rewrites nothing: an arrival stays an arrival.
        expect(result.status).toBe(status);
        expect(result.endedAt).toEqual(endedAt);
        expect(prisma.trip.updateMany).not.toHaveBeenCalled();
        expect(redis.clearPresence).not.toHaveBeenCalled();
        expect(redis.publishJson).not.toHaveBeenCalled();
      },
    );

    it('404s (not found) when the trip belongs to someone else', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        userId: 'someone-else',
      });

      await expect(service.cancelTrip(owner, 'trip-1')).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── addPoints auto-arrival ──────────────────────────────────────────────

  describe('addPoints auto-arrival', () => {
    const activeTrip = () => ({ ...baseTrip(), status: TripStatus.ACTIVE });

    it('auto-completes when the last point is within AUTO_ARRIVAL_RADIUS_M of the destination', async () => {
      const trip = activeTrip();
      prisma.trip.findUnique.mockResolvedValueOnce(trip);
      prisma.trip.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.trip.findUniqueOrThrow.mockResolvedValueOnce({
        ...trip,
        status: TripStatus.COMPLETED,
      });

      const dto = {
        points: [
          {
            // Essentially on top of the destination (6.6, 3.4).
            lat: trip.destLat,
            lng: trip.destLng,
            recordedAt: new Date('2026-07-22T09:00:00Z'),
          },
        ],
      };

      const result = await service.addPoints(owner, 'trip-1', dto);

      expect(result.autoCompleted).toBe(true);
      expect(result.accepted).toBe(1);
      expect(prisma.trip.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'trip-1', status: { in: LIVE_STATUSES } },
        }),
      );
    });

    it('does NOT auto-complete when the last point is far from the destination', async () => {
      const trip = activeTrip();
      prisma.trip.findUnique.mockResolvedValueOnce(trip);

      const dto = {
        points: [
          {
            // ~11km north of the destination — well outside the geofence.
            lat: trip.destLat + 0.1,
            lng: trip.destLng,
            recordedAt: new Date('2026-07-22T09:00:00Z'),
          },
        ],
      };

      const result = await service.addPoints(owner, 'trip-1', dto);

      expect(result.autoCompleted).toBe(false);
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
    });

    it('accepts breadcrumbs while the trip is in SOS — tracking must not die mid-alarm', async () => {
      const trip = { ...activeTrip(), status: TripStatus.SOS };
      prisma.trip.findUnique.mockResolvedValueOnce(trip);

      const result = await service.addPoints(owner, 'trip-1', {
        points: [
          {
            lat: trip.destLat + 0.1,
            lng: trip.destLng,
            recordedAt: new Date('2026-07-22T09:00:00Z'),
          },
        ],
      });

      expect(result.accepted).toBe(1);
      expect(redis.publishJson).toHaveBeenCalledWith(
        channelTripLive('trip-1'),
        expect.objectContaining({ kind: 'position' }),
      );
    });

    it('does NOT auto-complete a trip in SOS at the destination (no false "safe arrival")', async () => {
      const trip = { ...activeTrip(), status: TripStatus.SOS };
      prisma.trip.findUnique.mockResolvedValueOnce(trip);

      const result = await service.addPoints(owner, 'trip-1', {
        points: [
          {
            lat: trip.destLat,
            lng: trip.destLng,
            recordedAt: new Date('2026-07-22T09:00:00Z'),
          },
        ],
      });

      expect(result.autoCompleted).toBe(false);
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('409s on a trip that already ended, with a sentence that says what to do next', async () => {
      prisma.trip.findUnique.mockResolvedValue({
        ...activeTrip(),
        status: TripStatus.COMPLETED,
      });
      const dto = {
        points: [
          { lat: 6.5, lng: 3.3, recordedAt: new Date('2026-07-22T09:00:00Z') },
        ],
      };

      await expect(service.addPoints(owner, 'trip-1', dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.addPoints(owner, 'trip-1', dto)).rejects.toThrow(
        'Start a new trip to share your location again.',
      );
    });
  });

  // ── checkin ─────────────────────────────────────────────────────────────

  describe('checkin', () => {
    it('404s (not found) when the trip is not owned by the caller', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        userId: 'someone-else',
      });

      await expect(service.checkin(owner, 'trip-1')).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
      expect(prisma.trip.update).not.toHaveBeenCalled();
    });

    it('404s when the trip is missing', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce(null);

      await expect(service.checkin(owner, 'trip-1')).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
      expect(prisma.trip.update).not.toHaveBeenCalled();
    });

    it('409s on a finished trip and says what to do instead', async () => {
      prisma.trip.findUnique.mockResolvedValue({
        ...baseTrip(),
        status: TripStatus.COMPLETED,
      });

      await expect(service.checkin(owner, 'trip-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.checkin(owner, 'trip-1')).rejects.toThrow(
        'Start a new trip when you next set off.',
      );
      expect(prisma.trip.update).not.toHaveBeenCalled();
    });

    it('409s during an SOS, saying plainly that a check-in does not stand the alarm down', async () => {
      prisma.trip.findUnique.mockResolvedValue({
        ...baseTrip(),
        status: TripStatus.SOS,
      });

      await expect(service.checkin(owner, 'trip-1')).rejects.toThrow(
        CHECKIN_DURING_SOS_MSG,
      );
      expect(prisma.trip.update).not.toHaveBeenCalled();
    });

    it('records checkinAt, clears the escalation ladder, and publishes on ACTIVE', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce(baseTrip());
      prisma.trip.update.mockResolvedValueOnce({});

      const result = await service.checkin(owner, 'trip-1');

      // Resets overdueNotifiedAt/escalatedAt so the monitor starts fresh.
      expect(prisma.trip.update).toHaveBeenCalledWith({
        where: { id: 'trip-1' },
        data: {
          checkinAt: ANY_DATE,
          overdueNotifiedAt: null,
          escalatedAt: null,
        },
      });
      expect(redis.publishJson).toHaveBeenCalledWith(
        channelTripLive('trip-1'),
        expect.objectContaining({
          kind: 'status',
          status: TripStatus.ACTIVE,
          checkedIn: true,
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.checkinAt).toBeInstanceOf(Date);
    });
  });

  // ── deleteTrip ──────────────────────────────────────────────────────────

  describe('deleteTrip', () => {
    it('404s (not found) when the trip is not owned by the caller', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        userId: 'someone-else',
      });

      await expect(service.deleteTrip(owner, 'trip-1')).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
      expect(prisma.trip.delete).not.toHaveBeenCalled();
    });

    it('409s while the trip is still ACTIVE (must stop/cancel first)', async () => {
      prisma.trip.findUnique.mockResolvedValue(baseTrip());

      await expect(service.deleteTrip(owner, 'trip-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.deleteTrip(owner, 'trip-1')).rejects.toThrow(
        'Stop or cancel this trip before deleting it.',
      );
      expect(prisma.trip.delete).not.toHaveBeenCalled();
    });

    it('409s while the trip is in SOS — a live journey is never deleted out from under its watchers', async () => {
      prisma.trip.findUnique.mockResolvedValue({
        ...baseTrip(),
        status: TripStatus.SOS,
      });

      await expect(service.deleteTrip(owner, 'trip-1')).rejects.toThrow(
        'Stop or cancel this trip before deleting it.',
      );
      expect(prisma.trip.delete).not.toHaveBeenCalled();
    });

    it('deletes the trip when it is no longer ACTIVE', async () => {
      prisma.trip.findUnique.mockResolvedValueOnce({
        ...baseTrip(),
        status: TripStatus.COMPLETED,
      });
      prisma.trip.delete.mockResolvedValueOnce({});

      await service.deleteTrip(owner, 'trip-1');

      expect(prisma.trip.delete).toHaveBeenCalledWith({
        where: { id: 'trip-1' },
      });
    });
  });
});
