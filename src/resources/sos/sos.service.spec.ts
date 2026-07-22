import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TripStatus } from '@prisma/client';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { NotificationsService } from '../notification/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHANNEL_SOS,
  channelTripLive,
} from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { TripsService } from '../trip/trips.service';
import { UsersService } from '../user/users.service';
import { SosService } from './sos.service';
import {
  NOTIFY_FAILED_WARNING,
  NO_CONTACTS_WARNING,
  NO_LINKED_CONTACTS_WARNING,
  TRIP_NOT_FOUND_MSG,
} from './constant/sos.constants';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import type { SosRaisedMessage } from './type/sos.types';

/** Shape of a `redis.publishJson(channel, payload)` mock call. */
type PublishCall = [channel: string, payload: SosRaisedMessage];

/** Shape of a `notifications.sendToUsers(userIds, msg)` mock call. */
type NotifyCall = [
  userIds: string[],
  msg: { title: string; body: string; data?: Record<string, string> },
];

/** Shape of the `data` passed to `sosEvent.create`. */
interface SosCreateArg {
  data: {
    userId: string;
    tripId: string | null;
    lat: number | null;
    lng: number | null;
    message: string | null;
  };
}

/** Reads the `data` argument of the first `sosEvent.create` call, typed. */
function firstCreateData(create: jest.Mock): SosCreateArg['data'] {
  const calls = create.mock.calls as SosCreateArg[][];
  return calls[0][0].data;
}

/** A caller identity — only `id` is read by the service. */
const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'me@example.com',
};

/** Builds a Trip-shaped object; only the read fields matter for these tests. */
function makeTrip(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'trip-1',
    userId: USER.id,
    status: TripStatus.ACTIVE,
    originLat: 10,
    originLng: 20,
    destLat: 30,
    destLng: 40,
    shareTokenVersion: 7,
    ...overrides,
  };
}

describe('SosService', () => {
  let service: SosService;

  // Prisma: sosEvent CRUD, trip.findUnique/update, $transaction runs cb(tx).
  let txMock: {
    sosEvent: { create: jest.Mock };
    trip: { update: jest.Mock };
  };
  let prismaMock: {
    trip: { findUnique: jest.Mock };
    sosEvent: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let redisMock: { getPresence: jest.Mock; publishJson: jest.Mock };
  let configMock: { get: jest.Mock };
  let tripsMock: { getActiveTripForUser: jest.Mock };
  let usersMock: {
    getTrustedContacts: jest.Mock;
    findById: jest.Mock;
    filterConsentingContactUserIds: jest.Mock;
  };
  let notificationsMock: { sendToUsers: jest.Mock };
  let tripShareTokensMock: { issue: jest.Mock };

  const CREATED_AT = new Date('2026-07-22T10:00:00.000Z');

  beforeEach(async () => {
    txMock = {
      sosEvent: {
        create: jest.fn().mockResolvedValue({
          id: 'sos-1',
          createdAt: CREATED_AT,
        }),
      },
      trip: { update: jest.fn().mockResolvedValue({}) },
    };
    prismaMock = {
      trip: { findUnique: jest.fn() },
      sosEvent: { findUnique: jest.fn(), update: jest.fn() },
      // Run the callback against the tx mock, mirroring real $transaction(cb).
      $transaction: jest.fn((cb: (tx: typeof txMock) => unknown) => cb(txMock)),
    };
    redisMock = {
      getPresence: jest.fn().mockResolvedValue(null),
      publishJson: jest.fn().mockResolvedValue(undefined),
    };
    configMock = {
      get: jest.fn((key: string) => {
        if (key === 'API_BASE_URL') return 'https://api.roamwarden.test';
        return undefined;
      }),
    };
    tripsMock = { getActiveTripForUser: jest.fn().mockResolvedValue(null) };
    usersMock = {
      getTrustedContacts: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue({ id: USER.id, name: 'Ada' }),
      filterConsentingContactUserIds: jest.fn(),
    };
    notificationsMock = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    tripShareTokensMock = {
      issue: jest.fn().mockReturnValue({
        token: 'share-token-abc',
        expiresAt: new Date('2026-07-23T10:00:00.000Z'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SosService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
        { provide: TripsService, useValue: tripsMock },
        { provide: UsersService, useValue: usersMock },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: TripShareTokenService, useValue: tripShareTokensMock },
      ],
    }).compile();

    service = module.get(SosService);
  });

  describe('raise — coordinate validation', () => {
    it('rejects when only lat is provided', async () => {
      await expect(service.raise(USER, { lat: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // No event should be written when input is invalid.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when only lng is provided', async () => {
      await expect(service.raise(USER, { lng: 2 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('carries a clear message telling the user to provide both', async () => {
      await expect(service.raise(USER, { lat: 1 })).rejects.toThrow(
        /Provide both lat and lng together/,
      );
    });

    it('accepts when both lat and lng are provided', async () => {
      const res = await service.raise(USER, { lat: 1, lng: 2 });
      expect(res.sosId).toBe('sos-1');
    });

    it('accepts when both are omitted', async () => {
      const res = await service.raise(USER, {});
      expect(res.sosId).toBe('sos-1');
    });
  });

  describe('raise — trip resolution (no existence leak)', () => {
    it('404s when the referenced trip does not exist', async () => {
      prismaMock.trip.findUnique.mockResolvedValue(null);
      await expect(
        service.raise(USER, { tripId: 'trip-x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s (not 403) when the trip belongs to someone else', async () => {
      prismaMock.trip.findUnique.mockResolvedValue(
        makeTrip({ id: 'trip-x', userId: 'other-user' }),
      );
      await expect(
        service.raise(USER, { tripId: 'trip-x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uses the exact TRIP_NOT_FOUND_MSG (no leak of which condition failed)', async () => {
      prismaMock.trip.findUnique.mockResolvedValue(
        makeTrip({ id: 'trip-x', userId: 'other-user' }),
      );
      await expect(service.raise(USER, { tripId: 'trip-x' })).rejects.toThrow(
        TRIP_NOT_FOUND_MSG,
      );
    });

    it('falls back to the active trip when no tripId is given', async () => {
      tripsMock.getActiveTripForUser.mockResolvedValue(makeTrip());
      await service.raise(USER, {});
      expect(tripsMock.getActiveTripForUser).toHaveBeenCalledWith(USER.id);
      expect(prismaMock.trip.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('raise — event is the source of truth', () => {
    it('always writes the SOS event row, even with no trip and no contacts', async () => {
      const res = await service.raise(USER, {});
      expect(txMock.sosEvent.create).toHaveBeenCalledTimes(1);
      expect(res.sosId).toBe('sos-1');
    });

    it('persists the event with null tripId when there is no trip', async () => {
      await service.raise(USER, { lat: 1, lng: 2, message: 'help' });
      expect(txMock.sosEvent.create).toHaveBeenCalledWith({
        data: {
          userId: USER.id,
          tripId: null,
          lat: 1,
          lng: 2,
          message: 'help',
        },
      });
    });

    it('records the event but returns a warning when notification fan-out throws (no 5xx)', async () => {
      // A downstream lookup throws after the row is committed.
      usersMock.getTrustedContacts.mockRejectedValue(
        new Error('contacts db down'),
      );
      const res = await service.raise(USER, {});

      // Event still created; request resolves (not rejected).
      expect(txMock.sosEvent.create).toHaveBeenCalledTimes(1);
      expect(res.sosId).toBe('sos-1');
      expect(res.warning).toBe(NOTIFY_FAILED_WARNING);
      expect(res.notifiedContactCount).toBe(0);
    });
  });

  describe('raise — no trusted contacts', () => {
    it('creates the event and warns about adding contacts + local emergency services', async () => {
      usersMock.getTrustedContacts.mockResolvedValue([]);
      const res = await service.raise(USER, {});

      expect(res.sosId).toBe('sos-1');
      expect(res.warning).toBe(NO_CONTACTS_WARNING);
      expect(res.warning).toMatch(/local emergency services/);
      expect(res.notifiedContactCount).toBe(0);
      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
      // Consent filter is never reached when there are no contacts at all.
      expect(usersMock.filterConsentingContactUserIds).not.toHaveBeenCalled();
    });
  });

  describe('raise — consent gate', () => {
    it('filters linked contacts through filterConsentingContactUserIds and never notifies a non-consenting contact', async () => {
      // Two linked contacts + one unlinked (null contactUserId, must be dropped).
      usersMock.getTrustedContacts.mockResolvedValue([
        { contactUserId: 'consenting-1' },
        { contactUserId: 'non-consenting-2' },
        { contactUserId: null },
      ]);
      // Only the consenting one survives the consent gate.
      usersMock.filterConsentingContactUserIds.mockResolvedValue([
        'consenting-1',
      ]);

      const res = await service.raise(USER, {});

      // Invoked with the caller id and the linked (non-null) contact ids only.
      expect(usersMock.filterConsentingContactUserIds).toHaveBeenCalledWith(
        USER.id,
        ['consenting-1', 'non-consenting-2'],
      );

      // The non-consenting contact is never pushed to.
      const publishCalls = redisMock.publishJson.mock.calls as PublishCall[];
      const publishedSos = publishCalls.find(
        ([channel]) => channel === CHANNEL_SOS,
      );
      expect(publishedSos).toBeDefined();
      expect(publishedSos![1].contactUserIds).toEqual(['consenting-1']);

      const notifyCalls = notificationsMock.sendToUsers.mock
        .calls as NotifyCall[];
      const [notifiedIds] = notifyCalls[0];
      expect(notifiedIds).toEqual(['consenting-1']);
      expect(notifiedIds).not.toContain('non-consenting-2');

      expect(res.notifiedContactCount).toBe(1);
      expect(res.warning).toBeUndefined();
    });

    it('warns (NO_LINKED_CONTACTS_WARNING) and notifies no one when the consent gate leaves nobody', async () => {
      usersMock.getTrustedContacts.mockResolvedValue([
        { contactUserId: 'linked-but-not-consenting' },
      ]);
      usersMock.filterConsentingContactUserIds.mockResolvedValue([]);

      const res = await service.raise(USER, {});

      expect(usersMock.filterConsentingContactUserIds).toHaveBeenCalledWith(
        USER.id,
        ['linked-but-not-consenting'],
      );
      expect(res.warning).toBe(NO_LINKED_CONTACTS_WARNING);
      expect(res.notifiedContactCount).toBe(0);
      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
      // No SOS fan-out publish when nobody consented.
      expect(
        redisMock.publishJson.mock.calls.some(
          ([channel]) => channel === CHANNEL_SOS,
        ),
      ).toBe(false);
    });

    it('notifiedContactCount equals the number of consented linked contacts', async () => {
      usersMock.getTrustedContacts.mockResolvedValue([
        { contactUserId: 'a' },
        { contactUserId: 'b' },
        { contactUserId: 'c' },
      ]);
      usersMock.filterConsentingContactUserIds.mockResolvedValue(['a', 'c']);

      const res = await service.raise(USER, {});
      expect(res.notifiedContactCount).toBe(2);
      const notifyCalls = notificationsMock.sendToUsers.mock
        .calls as NotifyCall[];
      expect(notifyCalls[0][0]).toEqual(['a', 'c']);
    });
  });

  describe('raise — active trip', () => {
    beforeEach(() => {
      tripsMock.getActiveTripForUser.mockResolvedValue(makeTrip());
      usersMock.getTrustedContacts.mockResolvedValue([
        { contactUserId: 'consenting-1' },
      ]);
      usersMock.filterConsentingContactUserIds.mockResolvedValue([
        'consenting-1',
      ]);
    });

    it('flips the active trip to SOS status inside the transaction', async () => {
      await service.raise(USER, {});
      expect(txMock.trip.update).toHaveBeenCalledWith({
        where: { id: 'trip-1' },
        data: { status: TripStatus.SOS },
      });
    });

    it("publishes a status message on the trip's live channel", async () => {
      await service.raise(USER, {});
      const publishCalls = redisMock.publishJson.mock.calls as Array<
        [channel: string, payload: unknown]
      >;
      const call = publishCalls.find(
        ([channel]) => channel === channelTripLive('trip-1'),
      );
      expect(call).toBeDefined();
      expect(call![1]).toEqual({
        kind: 'status',
        tripId: 'trip-1',
        status: TripStatus.SOS,
      });
    });

    it("issues a share token with the trip's shareTokenVersion and returns a share URL", async () => {
      const res = await service.raise(USER, {});
      expect(tripShareTokensMock.issue).toHaveBeenCalledWith('trip-1', 7);
      expect(res.shareUrl).toBe(
        'https://api.roamwarden.test/trips/trip-1/live?token=share-token-abc',
      );
    });

    it('includes tripId + shareUrl in the push data payload', async () => {
      await service.raise(USER, {});
      const notifyCalls = notificationsMock.sendToUsers.mock
        .calls as NotifyCall[];
      const [, msg] = notifyCalls[0];
      expect(msg.data?.tripId).toBe('trip-1');
      expect(msg.data?.shareUrl).toBe(
        'https://api.roamwarden.test/trips/trip-1/live?token=share-token-abc',
      );
      expect(msg.data?.sosId).toBe('sos-1');
    });

    it('does NOT flip status or publish trip-live status for a non-active trip', async () => {
      tripsMock.getActiveTripForUser.mockResolvedValue(
        makeTrip({ status: TripStatus.COMPLETED }),
      );
      await service.raise(USER, {});
      expect(txMock.trip.update).not.toHaveBeenCalled();
      expect(
        redisMock.publishJson.mock.calls.some(
          ([channel]) => channel === channelTripLive('trip-1'),
        ),
      ).toBe(false);
    });
  });

  describe('raise — coordinate resolution', () => {
    it('falls back to Redis presence when coords omitted', async () => {
      redisMock.getPresence.mockResolvedValue({ lat: 51, lng: -0.1 });
      await service.raise(USER, {});
      expect(redisMock.getPresence).toHaveBeenCalledWith(USER.id);
      expect(firstCreateData(txMock.sosEvent.create).lat).toBe(51);
      expect(firstCreateData(txMock.sosEvent.create).lng).toBe(-0.1);
    });

    it('falls back to trip origin when coords omitted and presence unavailable', async () => {
      tripsMock.getActiveTripForUser.mockResolvedValue(makeTrip());
      redisMock.getPresence.mockResolvedValue(null);
      await service.raise(USER, {});
      expect(firstCreateData(txMock.sosEvent.create).lat).toBe(10);
      expect(firstCreateData(txMock.sosEvent.create).lng).toBe(20);
    });

    it('persists null coords when nothing is known and there is no trip', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      await service.raise(USER, {});
      expect(firstCreateData(txMock.sosEvent.create).lat).toBeNull();
      expect(firstCreateData(txMock.sosEvent.create).lng).toBeNull();
    });

    it('still raises the SOS when presence lookup throws', async () => {
      redisMock.getPresence.mockRejectedValue(new Error('redis down'));
      const res = await service.raise(USER, {});
      expect(res.sosId).toBe('sos-1');
    });
  });

  describe('resolve', () => {
    it('404s when the SOS event does not exist', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue(null);
      await expect(service.resolve(USER, 'sos-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s (not 403) when the SOS belongs to another user', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue({
        id: 'sos-1',
        userId: 'other-user',
        resolvedAt: null,
      });
      await expect(service.resolve(USER, 'sos-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prismaMock.sosEvent.update).not.toHaveBeenCalled();
    });

    it('is idempotent when already resolved', async () => {
      const already = new Date('2026-07-20T00:00:00.000Z');
      prismaMock.sosEvent.findUnique.mockResolvedValue({
        id: 'sos-1',
        userId: USER.id,
        resolvedAt: already,
      });
      const res = await service.resolve(USER, 'sos-1');
      expect(res).toEqual({ sosId: 'sos-1', resolvedAt: already });
      expect(prismaMock.sosEvent.update).not.toHaveBeenCalled();
    });

    it('sets resolvedAt on an unresolved event', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue({
        id: 'sos-1',
        userId: USER.id,
        resolvedAt: null,
      });
      const res = await service.resolve(USER, 'sos-1');
      expect(prismaMock.sosEvent.update).toHaveBeenCalledWith({
        where: { id: 'sos-1' },
        data: { resolvedAt: res.resolvedAt },
      });
      expect(res.resolvedAt).toBeInstanceOf(Date);
    });
  });
});
