import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { TripStatus } from '@prisma/client';
import { TripMonitorService } from './trip-monitor.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import { NotificationsService } from '../notification/notifications.service';
import { TripsService } from './trips.service';
import {
  TRIP_ESCALATE_AFTER_S,
  TRIP_OVERDUE_GRACE_S,
} from '../../common/constants';
import { channelTripLive } from '../../providers/redis/constant/redis.constants';
import type { MonitoredTrip } from './type/trips.types';

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-07-22T12:00:00.000Z').getTime();

/** `expect.any(Date)` typed as Date so it can sit inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;

type AnyMock = jest.Mock;

/**
 * Builds a MonitoredTrip row (as the sweep's findMany select returns it). By
 * default the trip is freshly started and NOT overdue: startedAt is `now`, no
 * expectedDurationS (so dueAt = now + TRIP_MAX_DURATION_S + grace, far ahead).
 */
function buildTrip(overrides: Partial<MonitoredTrip> = {}): MonitoredTrip {
  return {
    id: 'trip-1',
    userId: OWNER_ID,
    startedAt: new Date(NOW),
    expectedDurationS: null,
    lastPointAt: null,
    checkinAt: null,
    overdueNotifiedAt: null,
    escalatedAt: null,
    destLabel: 'Airport',
    shareTokenVersion: 0,
    user: { name: 'Ada' },
    ...overrides,
  };
}

/** An overdue trip: started long ago, short expected duration, past grace. */
function overdueTrip(overrides: Partial<MonitoredTrip> = {}): MonitoredTrip {
  return buildTrip({
    // Started 2h ago with a 30-min expectation → dueAt is well in the past.
    startedAt: new Date(NOW - 2 * 3600 * 1000),
    expectedDurationS: 30 * 60,
    ...overrides,
  });
}

describe('TripMonitorService', () => {
  let service: TripMonitorService;
  let prisma: {
    trip: { findMany: AnyMock; updateMany: AnyMock };
  };
  let notifications: { sendToUsers: AnyMock };
  let redis: { publishJson: AnyMock };
  let trips: { getWatcherUserIds: AnyMock; buildLiveShareUrl: AnyMock };

  beforeEach(async () => {
    // Freeze the clock so dueAt / escalate-window arithmetic is deterministic.
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // Silence the service logger so swallowed errors don't spam test output.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    prisma = {
      trip: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    notifications = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    redis = { publishJson: jest.fn().mockResolvedValue(undefined) };
    trips = {
      getWatcherUserIds: jest.fn().mockResolvedValue([]),
      buildLiveShareUrl: jest
        .fn()
        .mockReturnValue(
          'https://api.roamwarden.test/trips/trip-1/live?token=x',
        ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TripMonitorService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: RedisService, useValue: redis },
        { provide: TripsService, useValue: trips },
      ],
    }).compile();

    service = moduleRef.get(TripMonitorService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── STAGE 1: nudge the owner ────────────────────────────────────────────

  describe('escalateOverdueTrips — stage 1 (owner nudge)', () => {
    it('nudges the OWNER and guards overdueNotifiedAt from null for an overdue trip', async () => {
      const trip = overdueTrip();
      prisma.trip.findMany.mockResolvedValue([trip]);

      await service.escalateOverdueTrips();

      // Guarded transition: only flips overdueNotifiedAt when it is still null.
      expect(prisma.trip.updateMany).toHaveBeenCalledWith({
        where: {
          id: trip.id,
          status: TripStatus.ACTIVE,
          overdueNotifiedAt: null,
        },
        data: { overdueNotifiedAt: ANY_DATE },
      });

      // The nudge targets ONLY the traveller (owner), not any contacts.
      expect(notifications.sendToUsers).toHaveBeenCalledTimes(1);
      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        [OWNER_ID],
        expect.objectContaining({ title: 'Are you OK?' }),
      );

      // Flags the live view overdue; contacts are NOT alerted in stage 1.
      expect(redis.publishJson).toHaveBeenCalledWith(
        channelTripLive(trip.id),
        expect.objectContaining({ kind: 'status', overdue: true }),
      );
      expect(trips.getWatcherUserIds).not.toHaveBeenCalled();
    });

    it('does nothing when the guarded overdueNotifiedAt update matches 0 rows (idempotent)', async () => {
      prisma.trip.findMany.mockResolvedValue([overdueTrip()]);
      // A concurrent sweep already flipped overdueNotifiedAt.
      prisma.trip.updateMany.mockResolvedValue({ count: 0 });

      await service.escalateOverdueTrips();

      // Lost the guard race → no nudge, no publish.
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
      expect(redis.publishJson).not.toHaveBeenCalled();
    });

    it('nudges when a moving trip has stalled (stale lastPointAt) even if not yet overdue', async () => {
      // Not overdue (fresh dueAt) but stalled: active long enough with a
      // breadcrumb older than the stall timeout.
      const trip = buildTrip({
        startedAt: new Date(NOW - 60 * 60 * 1000),
        lastPointAt: new Date(NOW - 60 * 60 * 1000),
      });
      prisma.trip.findMany.mockResolvedValue([trip]);

      await service.escalateOverdueTrips();

      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        [OWNER_ID],
        expect.objectContaining({ title: 'Are you OK?' }),
      );
    });

    it('does nothing for a not-yet-due, non-stalled trip', async () => {
      prisma.trip.findMany.mockResolvedValue([buildTrip()]);

      await service.escalateOverdueTrips();

      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
      expect(redis.publishJson).not.toHaveBeenCalled();
    });

    it('does not nudge when the traveller checked in after going overdue', async () => {
      // Overdue, but a fresh check-in (in the future relative to the sweep)
      // suppresses the nudge.
      const trip = overdueTrip({ checkinAt: new Date(NOW + 60 * 1000) });
      prisma.trip.findMany.mockResolvedValue([trip]);

      await service.escalateOverdueTrips();

      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });
  });

  // ── STAGE 2: alert contacts ─────────────────────────────────────────────

  describe('escalateOverdueTrips — stage 2 (contact alert)', () => {
    /** Already-nudged trip whose escalate window has elapsed with no check-in. */
    function escalatableTrip(
      overrides: Partial<MonitoredTrip> = {},
    ): MonitoredTrip {
      return overdueTrip({
        overdueNotifiedAt: new Date(NOW - (TRIP_ESCALATE_AFTER_S + 60) * 1000),
        ...overrides,
      });
    }

    it('alerts consented watcher contacts and guards escalatedAt from null', async () => {
      const trip = escalatableTrip();
      prisma.trip.findMany.mockResolvedValue([trip]);
      trips.getWatcherUserIds.mockResolvedValue([CONTACT_ID]);
      // Guarded escalatedAt transition wins.
      prisma.trip.updateMany.mockResolvedValue({ count: 1 });

      await service.escalateOverdueTrips();

      expect(trips.getWatcherUserIds).toHaveBeenCalledWith(trip.id);
      // Guarded transition on escalatedAt === null.
      expect(prisma.trip.updateMany).toHaveBeenCalledWith({
        where: { id: trip.id, status: TripStatus.ACTIVE, escalatedAt: null },
        data: { escalatedAt: ANY_DATE },
      });
      // Contacts (not the owner) receive the no-arrival alert.
      expect(notifications.sendToUsers).toHaveBeenCalledTimes(1);
      const [recipients, message] = notifications.sendToUsers.mock.calls[0] as [
        string[],
        { data: { kind: string } },
      ];
      expect(recipients).toEqual([CONTACT_ID]);
      expect(message.data.kind).toBe('no_arrival');
      expect(redis.publishJson).toHaveBeenCalledWith(
        channelTripLive(trip.id),
        expect.objectContaining({ kind: 'status', escalated: true }),
      );
    });

    it('marks escalated but sends nothing when there are no consented contacts', async () => {
      const trip = escalatableTrip();
      prisma.trip.findMany.mockResolvedValue([trip]);
      trips.getWatcherUserIds.mockResolvedValue([]);

      await service.escalateOverdueTrips();

      // Still flips escalatedAt so the trip stops being re-evaluated each minute.
      expect(prisma.trip.updateMany).toHaveBeenCalledWith({
        where: { id: trip.id, status: TripStatus.ACTIVE, escalatedAt: null },
        data: { escalatedAt: ANY_DATE },
      });
      // But no one is notified.
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
      expect(redis.publishJson).not.toHaveBeenCalled();
    });

    it('does not alert twice when the guarded escalatedAt update matches 0 rows', async () => {
      const trip = escalatableTrip();
      prisma.trip.findMany.mockResolvedValue([trip]);
      trips.getWatcherUserIds.mockResolvedValue([CONTACT_ID]);
      // Another sweep already escalated.
      prisma.trip.updateMany.mockResolvedValue({ count: 0 });

      await service.escalateOverdueTrips();

      expect(notifications.sendToUsers).not.toHaveBeenCalled();
      expect(redis.publishJson).not.toHaveBeenCalled();
    });

    it('does NOT escalate when checkinAt is AFTER overdueNotifiedAt (traveller answered the nudge)', async () => {
      const overdueNotifiedAt = new Date(
        NOW - (TRIP_ESCALATE_AFTER_S + 60) * 1000,
      );
      const trip = escalatableTrip({
        overdueNotifiedAt,
        // Checked in one second after being nudged.
        checkinAt: new Date(overdueNotifiedAt.getTime() + 1000),
      });
      prisma.trip.findMany.mockResolvedValue([trip]);
      trips.getWatcherUserIds.mockResolvedValue([CONTACT_ID]);

      await service.escalateOverdueTrips();

      // Stage 2 condition fails → no escalation, no updateMany, no alert.
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      expect(trips.getWatcherUserIds).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('does NOT escalate before the escalate window has elapsed', async () => {
      // Nudged only 1 minute ago — TRIP_ESCALATE_AFTER_S has not passed yet.
      const trip = overdueTrip({
        overdueNotifiedAt: new Date(NOW - 60 * 1000),
      });
      prisma.trip.findMany.mockResolvedValue([trip]);

      await service.escalateOverdueTrips();

      expect(trips.getWatcherUserIds).not.toHaveBeenCalled();
      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });
  });

  // ── sweep resilience ────────────────────────────────────────────────────

  describe('escalateOverdueTrips — sweep resilience', () => {
    it('continues the sweep when one trip throws (per-trip isolation)', async () => {
      const bad = overdueTrip({ id: 'bad-trip' });
      const good = overdueTrip({ id: 'good-trip', userId: 'owner-2' });
      prisma.trip.findMany.mockResolvedValue([bad, good]);

      // The first trip's guarded update throws; the second must still be nudged.
      prisma.trip.updateMany
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue({ count: 1 });

      await service.escalateOverdueTrips();

      // The good trip's owner was still nudged despite the earlier failure.
      expect(notifications.sendToUsers).toHaveBeenCalledTimes(1);
      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        ['owner-2'],
        expect.objectContaining({ title: 'Are you OK?' }),
      );
    });

    it('returns early (no per-trip work) when loading active trips fails', async () => {
      prisma.trip.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.escalateOverdueTrips()).resolves.toBeUndefined();

      expect(prisma.trip.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('never throws when the live-channel publish fails (best-effort)', async () => {
      prisma.trip.findMany.mockResolvedValue([overdueTrip()]);
      redis.publishJson.mockRejectedValue(new Error('redis down'));

      await expect(service.escalateOverdueTrips()).resolves.toBeUndefined();

      // The owner nudge still went out; only the publish failed (swallowed).
      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        [OWNER_ID],
        expect.objectContaining({ title: 'Are you OK?' }),
      );
    });
  });

  // ── loaded trip shape ───────────────────────────────────────────────────

  it('queries only ACTIVE trips with the escalation state selected', async () => {
    await service.escalateOverdueTrips();

    expect(prisma.trip.findMany).toHaveBeenCalledTimes(1);
    const [args] = prisma.trip.findMany.mock.calls[0] as [
      {
        where: { status: TripStatus };
        select: Record<string, boolean>;
      },
    ];
    expect(args.where).toEqual({ status: TripStatus.ACTIVE });
    expect(args.select).toMatchObject({
      overdueNotifiedAt: true,
      escalatedAt: true,
      checkinAt: true,
      lastPointAt: true,
    });
    // Anchor the fixtures to real constants so the boundaries stay meaningful.
    expect(TRIP_OVERDUE_GRACE_S).toBeGreaterThan(0);
    expect(TRIP_ESCALATE_AFTER_S).toBeGreaterThan(0);
  });
});
