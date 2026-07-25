import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  SosDeliveryChannel,
  SosDeliveryStatus,
  SosEscalationStatus,
} from '@prisma/client';
import type { SosEscalation } from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import { CHANNEL_SOS } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { NotificationsService } from '../notification/notifications.service';
import { UsersService } from '../user/users.service';
import {
  SOS_ACK_NOT_FOUND_MSG,
  SOS_ESCALATION_ADVANCE_DELAY_MS,
  SOS_ESCALATION_MAX_ATTEMPTS,
  SOS_ESCALATION_MAX_ATTEMPTS_PER_CONTACT,
  SOS_ESCALATION_RETRY_BACKOFF_MS,
  SOS_ESCALATION_ROUND_DELAY_MS,
} from './constant/sos.constants';
import { SosEscalationService } from './sos-escalation.service';

/** The shape of a `sosDelivery.create({ data })` call. */
interface DeliveryCreateArg {
  data: {
    sosId: string;
    contactUserId: string;
    rank: number;
    round: number;
    attempt: number;
    channel: SosDeliveryChannel;
    status: SosDeliveryStatus;
    priority: boolean;
    detail: string | null;
  };
}

/** The shape of a `sosEscalation.update({ where, data })` call. */
interface EscalationUpdateArg {
  where: { id: string };
  data: {
    rank?: number;
    attempt?: number;
    totalAttempts?: number;
    nextAttemptAt?: Date;
  };
}

/** The shape of a `notifications.sendToUsers(userIds, msg)` call. */
type NotifyCall = [
  userIds: string[],
  msg: { title: string; body: string; data?: Record<string, string> },
];

/**
 * Reads one argument of one mock call, typed. `jest.Mock['mock']['calls']` is
 * `any[][]`, which the type-checked lint rules (rightly) refuse to index into.
 */
function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

const USER_ID = 'traveller-1';
const SOS_ID = 'sos-1';
const CONTACTS = ['contact-a', 'contact-b', 'contact-c'];
const RAISED_AT = new Date('2026-07-25T10:00:00.000Z');

function makeEscalation(overrides: Partial<SosEscalation> = {}): SosEscalation {
  return {
    id: 'esc-1',
    sosId: SOS_ID,
    userId: USER_ID,
    status: SosEscalationStatus.RUNNING,
    planCode: 'free',
    enforced: false,
    contactOrder: [...CONTACTS],
    rank: 0,
    attempt: 0,
    totalAttempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    acknowledgedBy: null,
    detail: null,
    startedAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

function makeSosRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOS_ID,
    userId: USER_ID,
    message: null,
    lat: 6.5,
    lng: 3.3,
    createdAt: RAISED_AT,
    resolvedAt: null,
    user: { name: 'Ada' },
    trip: null,
    ...overrides,
  };
}

describe('SosEscalationService', () => {
  let service: SosEscalationService;

  let prismaMock: {
    sosEvent: { findUnique: jest.Mock };
    sosEscalation: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    sosDelivery: {
      create: jest.Mock;
      createMany: jest.Mock;
      findMany: jest.Mock;
    };
    deviceToken: { findMany: jest.Mock; count: jest.Mock };
  };
  let redisMock: { partitionOnline: jest.Mock; publishJson: jest.Mock };
  let usersMock: { filterConsentingContactUserIds: jest.Mock };
  let notificationsMock: { sendToUsers: jest.Mock };
  let tripShareTokensMock: { issue: jest.Mock };
  let entitlementsMock: { checkCapability: jest.Mock };

  /** A capability answer as EntitlementsService would build it. */
  function capability(opts: {
    granted: boolean;
    enforced: boolean;
    planCode?: string;
  }) {
    return {
      key: 'prioritySos',
      planCode: opts.planCode ?? (opts.granted ? 'premium' : 'free'),
      enforced: opts.enforced,
      granted: opts.granted,
      // The real service computes exactly this: allowed while enforcement is off.
      allowed: !opts.enforced || opts.granted,
      wouldBlock: !opts.granted,
      message: opts.granted
        ? null
        : 'Priority SOS is part of Premium. Upgrade to unlock it.',
    };
  }

  beforeEach(async () => {
    prismaMock = {
      sosEvent: { findUnique: jest.fn().mockResolvedValue(makeSosRow()) },
      sosEscalation: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        // Default: the claim succeeds.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      sosDelivery: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      deviceToken: {
        findMany: jest
          .fn()
          .mockResolvedValue(CONTACTS.map((userId) => ({ userId }))),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    redisMock = {
      partitionOnline: jest
        .fn()
        .mockResolvedValue({ online: [], offline: [...CONTACTS] }),
      publishJson: jest.fn().mockResolvedValue(undefined),
    };
    usersMock = {
      // Default: everyone still consents.
      filterConsentingContactUserIds: jest
        .fn()
        .mockImplementation((_owner: string, ids: string[]) =>
          Promise.resolve(ids),
        ),
    };
    notificationsMock = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    tripShareTokensMock = {
      issue: jest.fn().mockReturnValue({
        token: 'share-token-abc',
        expiresAt: new Date(),
      }),
    };
    entitlementsMock = {
      checkCapability: jest
        .fn()
        .mockResolvedValue(capability({ granted: false, enforced: false })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SosEscalationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'API_BASE_URL'
                ? 'https://api.roamwarden.test'
                : undefined,
            ),
          },
        },
        { provide: UsersService, useValue: usersMock },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: TripShareTokenService, useValue: tripShareTokensMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
      ],
    }).compile();

    service = module.get(SosEscalationService);
  });

  /** All `sosDelivery.create` data arguments, in call order. */
  function trailRows(): DeliveryCreateArg['data'][] {
    return (
      prismaMock.sosDelivery.create.mock.calls as DeliveryCreateArg[][]
    ).map((call) => call[0].data);
  }

  /** The single `sosEscalation.update` data argument. */
  function updateData(): EscalationUpdateArg['data'] {
    const calls = prismaMock.sosEscalation.update.mock
      .calls as EscalationUpdateArg[][];
    return calls[0][0].data;
  }

  function start(contactUserIds = [...CONTACTS]) {
    return service.start({
      sosId: SOS_ID,
      userId: USER_ID,
      ownerName: 'Ada',
      contactUserIds,
    });
  }

  // ── who gets the ladder (the capability switch) ──────────────────────

  describe('start — the capability decides, never a hardcoded plan', () => {
    it('arms the ladder for a Free user while enforcement is OFF (nobody loses anything today)', async () => {
      entitlementsMock.checkCapability.mockResolvedValue(
        capability({ granted: false, enforced: false }),
      );

      const info = await start();

      expect(entitlementsMock.checkCapability).toHaveBeenCalledWith(
        USER_ID,
        'prioritySos',
      );
      expect(info.enabled).toBe(true);
      expect(info.enforced).toBe(false);
      expect(info.contactsInLadder).toBe(3);
      expect(prismaMock.sosEscalation.create).toHaveBeenCalledTimes(1);
    });

    it('freezes the contact order onto the escalation row', async () => {
      await start();
      const arg = callArg<{
        data: { contactOrder: string[]; sosId: string; planCode: string };
      }>(prismaMock.sosEscalation.create);
      expect(arg.data.contactOrder).toEqual(CONTACTS);
      expect(arg.data.sosId).toBe(SOS_ID);
    });

    it('skips the ladder for a Free user once enforcement is ON, with a human reason', async () => {
      entitlementsMock.checkCapability.mockResolvedValue(
        capability({ granted: false, enforced: true }),
      );

      const info = await start();

      expect(info.enabled).toBe(false);
      expect(info.reason).toMatch(/Premium/);
      expect(prismaMock.sosEscalation.create).not.toHaveBeenCalled();
      // Nothing extra is even written for the standard path.
      expect(prismaMock.sosDelivery.createMany).not.toHaveBeenCalled();
    });

    it('arms the ladder for an entitled user when enforcement is ON', async () => {
      entitlementsMock.checkCapability.mockResolvedValue(
        capability({ granted: true, enforced: true }),
      );

      const info = await start();

      expect(info.enabled).toBe(true);
      expect(info.planCode).toBe('premium');
      expect(prismaMock.sosEscalation.create).toHaveBeenCalledTimes(1);
    });

    it('never throws when scheduling fails — the contacts were already alerted', async () => {
      prismaMock.sosEscalation.create.mockRejectedValue(new Error('db down'));

      const info = await start();

      expect(info.enabled).toBe(false);
      expect(info.reason).toMatch(/contacts were alerted/i);
    });

    it('does nothing when there is nobody to escalate to', async () => {
      const info = await start([]);
      expect(info.enabled).toBe(false);
      expect(info.reason).toMatch(/no linked trusted contacts/i);
      expect(prismaMock.sosEscalation.create).not.toHaveBeenCalled();
    });
  });

  // ── the trail ────────────────────────────────────────────────────────

  describe('start — the broadcast is recorded on the trail', () => {
    it('writes one round-0 row per contact, in ladder order', async () => {
      await start();

      const arg = callArg<{
        data: DeliveryCreateArg['data'][];
      }>(prismaMock.sosDelivery.createMany);
      expect(arg.data).toHaveLength(3);
      expect(arg.data.map((r) => r.contactUserId)).toEqual(CONTACTS);
      expect(arg.data.map((r) => r.rank)).toEqual([0, 1, 2]);
      expect(arg.data.every((r) => r.round === 0)).toBe(true);
      // Round 0 is the standard fan-out, not a priority attempt.
      expect(arg.data.every((r) => r.priority === false)).toBe(true);
      expect(arg.data.every((r) => r.status === SosDeliveryStatus.SENT)).toBe(
        true,
      );
    });

    it('records NO_DEVICE for a contact with nothing to push to', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([
        { userId: 'contact-a' },
        { userId: 'contact-c' },
      ]);

      await start();

      const arg = callArg<{
        data: DeliveryCreateArg['data'][];
      }>(prismaMock.sosDelivery.createMany);
      const b = arg.data.find((r) => r.contactUserId === 'contact-b');
      expect(b?.status).toBe(SosDeliveryStatus.NO_DEVICE);
      expect(b?.detail).toMatch(/no device registered/i);
    });

    it('adds a REALTIME row for a contact who had the app open', async () => {
      redisMock.partitionOnline.mockResolvedValue({
        online: ['contact-b'],
        offline: ['contact-a', 'contact-c'],
      });

      await start();

      const arg = callArg<{
        data: DeliveryCreateArg['data'][];
      }>(prismaMock.sosDelivery.createMany);
      expect(arg.data).toHaveLength(4);
      expect(
        arg.data.filter((r) => r.channel === SosDeliveryChannel.REALTIME),
      ).toEqual([
        expect.objectContaining({
          contactUserId: 'contact-b',
          status: SosDeliveryStatus.SENT,
        }),
      ]);
    });

    it('still records the trail when presence lookup fails', async () => {
      redisMock.partitionOnline.mockRejectedValue(new Error('redis down'));
      const info = await start();
      expect(info.enabled).toBe(true);
      expect(prismaMock.sosDelivery.createMany).toHaveBeenCalledTimes(1);
    });

    it('still arms the ladder when the trail cannot be written (audit never costs the follow-up)', async () => {
      prismaMock.sosDelivery.createMany.mockRejectedValue(
        new Error('trail table down'),
      );

      const info = await start();

      expect(info.enabled).toBe(true);
      expect(prismaMock.sosEscalation.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── escalation ordering ──────────────────────────────────────────────

  describe('tick — escalates through the contact list in order', () => {
    it('pages the contact at the current rank, one at a time (never a re-fan-out)', async () => {
      await service.tick(makeEscalation({ rank: 1 }));

      const calls = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual(['contact-b']);
    });

    it('advances to the NEXT contact after a successful page', async () => {
      await service.tick(makeEscalation({ rank: 0 }));

      expect(updateData().rank).toBe(1);
      expect(updateData().attempt).toBe(0);
    });

    it('gives the paged contact a full round delay before moving on', async () => {
      const before = Date.now();
      await service.tick(makeEscalation({ rank: 0 }));

      const next = updateData().nextAttemptAt!.getTime();
      expect(next).toBeGreaterThanOrEqual(
        before + SOS_ESCALATION_ROUND_DELAY_MS,
      );
      expect(next).toBeLessThanOrEqual(
        Date.now() + SOS_ESCALATION_ROUND_DELAY_MS,
      );
    });

    it('walks the whole ladder across successive ticks: a → b → c', async () => {
      for (const rank of [0, 1, 2]) {
        notificationsMock.sendToUsers.mockClear();
        await service.tick(makeEscalation({ rank }));
        const calls = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
        expect(calls[0][0]).toEqual([CONTACTS[rank]]);
      }
    });

    it('records every escalation attempt on the trail as a priority attempt', async () => {
      await service.tick(makeEscalation({ rank: 1, totalAttempts: 2 }));

      expect(trailRows()).toEqual([
        expect.objectContaining({
          sosId: SOS_ID,
          contactUserId: 'contact-b',
          rank: 1,
          round: 3,
          attempt: 1,
          channel: SosDeliveryChannel.PUSH,
          status: SosDeliveryStatus.SENT,
          priority: true,
        }),
      ]);
    });

    it('re-publishes on the SOS channel so an open app resurfaces the alert', async () => {
      await service.tick(makeEscalation({ rank: 0 }));

      const publish = redisMock.publishJson.mock.calls.find(
        ([channel]) => channel === CHANNEL_SOS,
      ) as [string, { contactUserIds: string[]; escalationRound: number }];
      expect(publish[1].contactUserIds).toEqual(['contact-a']);
      expect(publish[1].escalationRound).toBe(1);
    });

    it('skips (and moves past) a contact who has withdrawn consent', async () => {
      usersMock.filterConsentingContactUserIds.mockResolvedValue([]);

      await service.tick(makeEscalation({ rank: 0 }));

      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
      expect(trailRows()[0].status).toBe(SosDeliveryStatus.SKIPPED);
      expect(updateData().rank).toBe(1);
    });
  });

  // ── retry with backoff ───────────────────────────────────────────────

  describe('tick — retries a failed delivery with backoff', () => {
    it('retries the SAME contact when they have no registered device', async () => {
      prismaMock.deviceToken.count.mockResolvedValue(0);
      const before = Date.now();

      await service.tick(makeEscalation({ rank: 0, attempt: 0 }));

      expect(trailRows()[0].status).toBe(SosDeliveryStatus.NO_DEVICE);
      // Same rank — we have not given up on them yet.
      expect(updateData().rank).toBeUndefined();
      expect(updateData().attempt).toBe(1);
      const next = updateData().nextAttemptAt!.getTime();
      expect(next).toBeGreaterThanOrEqual(
        before + SOS_ESCALATION_RETRY_BACKOFF_MS[0],
      );
    });

    it('backs off further on each successive retry', async () => {
      prismaMock.deviceToken.count.mockResolvedValue(0);
      const before = Date.now();

      await service.tick(makeEscalation({ rank: 0, attempt: 1 }));

      expect(updateData().attempt).toBe(2);
      const next = updateData().nextAttemptAt!.getTime();
      expect(next).toBeGreaterThanOrEqual(
        before + SOS_ESCALATION_RETRY_BACKOFF_MS[1],
      );
    });

    it('treats an expired device registration as a failed delivery', async () => {
      // Two tokens before the send, none after: NotificationsService pruned
      // them all as dead, so nothing was delivered.
      prismaMock.deviceToken.count
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0);

      await service.tick(makeEscalation({ rank: 0 }));

      expect(trailRows()[0].status).toBe(SosDeliveryStatus.FAILED);
      expect(trailRows()[0].detail).toMatch(/registration had expired/i);
      expect(updateData().attempt).toBe(1);
    });

    it('records FAILED (and retries) when the push call itself throws', async () => {
      notificationsMock.sendToUsers.mockRejectedValue(new Error('fcm down'));

      await service.tick(makeEscalation({ rank: 0 }));

      expect(trailRows()[0].status).toBe(SosDeliveryStatus.FAILED);
      expect(updateData().attempt).toBe(1);
      expect(updateData().rank).toBeUndefined();
    });

    it('gives up on that contact after the per-contact attempt cap and escalates', async () => {
      prismaMock.deviceToken.count.mockResolvedValue(0);
      const before = Date.now();

      await service.tick(
        makeEscalation({
          rank: 0,
          attempt: SOS_ESCALATION_MAX_ATTEMPTS_PER_CONTACT - 1,
        }),
      );

      expect(updateData().rank).toBe(1);
      expect(updateData().attempt).toBe(0);
      // Moves on FAST — a dead end must not cost a full round delay.
      const next = updateData().nextAttemptAt!.getTime();
      expect(next).toBeLessThanOrEqual(
        Date.now() + SOS_ESCALATION_ADVANCE_DELAY_MS,
      );
      expect(next).toBeGreaterThanOrEqual(
        before + SOS_ESCALATION_ADVANCE_DELAY_MS,
      );
    });
  });

  // ── stopping ─────────────────────────────────────────────────────────

  describe('tick — stop conditions', () => {
    it('stops the moment the traveller has marked themselves safe', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue(
        makeSosRow({ resolvedAt: new Date() }),
      );

      await service.tick(makeEscalation({ rank: 0 }));

      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
      const finish = callArg<{
        data: { status: SosEscalationStatus; nextAttemptAt: null };
      }>(prismaMock.sosEscalation.updateMany, 1);
      expect(finish.data.status).toBe(SosEscalationStatus.RESOLVED);
      expect(finish.data.nextAttemptAt).toBeNull();
    });

    it('exhausts once every contact has been paged, and tells the traveller plainly', async () => {
      await service.tick(makeEscalation({ rank: CONTACTS.length }));

      const finish = callArg<{
        data: { status: SosEscalationStatus; detail: string };
      }>(prismaMock.sosEscalation.updateMany, 1);
      expect(finish.data.status).toBe(SosEscalationStatus.EXHAUSTED);
      expect(finish.data.detail).toMatch(/local emergency services/i);

      const calls = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
      expect(calls[0][0]).toEqual([USER_ID]);
      expect(calls[0][1].body).toMatch(/local emergency services/i);
    });

    it('exhausts at the absolute attempt cap', async () => {
      await service.tick(
        makeEscalation({ rank: 0, totalAttempts: SOS_ESCALATION_MAX_ATTEMPTS }),
      );

      const finish = callArg<{
        data: { status: SosEscalationStatus };
      }>(prismaMock.sosEscalation.updateMany, 1);
      expect(finish.data.status).toBe(SosEscalationStatus.EXHAUSTED);
      const notified = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
      expect(notified[0][0]).toEqual([USER_ID]);
    });

    it('stops when the SOS record has gone', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue(null);

      await service.tick(makeEscalation());

      const finish = callArg<{
        data: { status: SosEscalationStatus };
      }>(prismaMock.sosEscalation.updateMany, 1);
      expect(finish.data.status).toBe(SosEscalationStatus.STOPPED);
    });

    it('does nothing when another instance already claimed this tick', async () => {
      prismaMock.sosEscalation.updateMany.mockResolvedValue({ count: 0 });

      await service.tick(makeEscalation({ rank: 0 }));

      expect(prismaMock.sosEvent.findUnique).not.toHaveBeenCalled();
      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
    });

    it('claims by pushing nextAttemptAt into the future, guarded on still being due', async () => {
      await service.tick(makeEscalation({ rank: 0 }));

      const claim = callArg<{
        where: {
          id: string;
          status: SosEscalationStatus;
          nextAttemptAt: unknown;
        };
        data: { nextAttemptAt: Date };
      }>(prismaMock.sosEscalation.updateMany);
      expect(claim.where.status).toBe(SosEscalationStatus.RUNNING);
      expect(claim.where.nextAttemptAt).toBeDefined();
      expect(claim.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('sweep', () => {
    it('processes every due escalation and survives one of them failing', async () => {
      const rows = [
        makeEscalation({ id: 'esc-1', sosId: 'sos-1' }),
        makeEscalation({ id: 'esc-2', sosId: 'sos-2' }),
      ];
      prismaMock.sosEscalation.findMany.mockResolvedValue(rows);
      prismaMock.sosEscalation.updateMany
        .mockRejectedValueOnce(new Error('claim blew up'))
        .mockResolvedValue({ count: 1 });

      await expect(service.sweep()).resolves.toBeUndefined();
      // The second escalation was still attempted.
      expect(prismaMock.sosEscalation.updateMany).toHaveBeenCalledTimes(2);
    });

    it('never throws when the due-escalation query fails', async () => {
      prismaMock.sosEscalation.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.sweep()).resolves.toBeUndefined();
    });

    it('only looks at RUNNING escalations that are due', async () => {
      await service.sweep();
      const arg = callArg<{
        where: { status: SosEscalationStatus; nextAttemptAt: { lte: Date } };
      }>(prismaMock.sosEscalation.findMany);
      expect(arg.where.status).toBe(SosEscalationStatus.RUNNING);
      expect(arg.where.nextAttemptAt.lte).toBeInstanceOf(Date);
    });
  });

  // ── acknowledgement ──────────────────────────────────────────────────

  describe('acknowledge', () => {
    beforeEach(() => {
      prismaMock.sosEvent.findUnique.mockResolvedValue({
        id: SOS_ID,
        userId: USER_ID,
      });
      prismaMock.sosEscalation.findUnique.mockResolvedValue(
        makeEscalation({ rank: 1, totalAttempts: 2 }),
      );
    });

    it('stops the ladder and records the acknowledgement on the trail', async () => {
      const res = await service.acknowledge('contact-b', SOS_ID, 'Bola');

      expect(res.escalationStopped).toBe(true);
      expect(trailRows()[0]).toEqual(
        expect.objectContaining({
          contactUserId: 'contact-b',
          rank: 1,
          status: SosDeliveryStatus.ACKNOWLEDGED,
        }),
      );
      const stop = callArg<{
        where: { sosId: string; status: SosEscalationStatus };
        data: { status: SosEscalationStatus; acknowledgedBy: string };
      }>(prismaMock.sosEscalation.updateMany);
      expect(stop.where.status).toBe(SosEscalationStatus.RUNNING);
      expect(stop.data.status).toBe(SosEscalationStatus.ACKNOWLEDGED);
      expect(stop.data.acknowledgedBy).toBe('contact-b');
    });

    it('tells the traveller someone has seen it, without implying rescue is coming', async () => {
      await service.acknowledge('contact-b', SOS_ID, 'Bola');
      const calls = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
      expect(calls[0][0]).toEqual([USER_ID]);
      expect(calls[0][1].body).toMatch(/local emergency services/i);
    });

    it('carries the honest "not an emergency service" notice', async () => {
      const res = await service.acknowledge('contact-b', SOS_ID, 'Bola');
      expect(res.notice).toMatch(/cannot contact emergency services/i);
    });

    it('404s for someone who is not a mutual trusted contact (no existence leak)', async () => {
      usersMock.filterConsentingContactUserIds.mockResolvedValue([]);

      await expect(
        service.acknowledge('stranger', SOS_ID, 'Nobody'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.acknowledge('stranger', SOS_ID, 'Nobody'),
      ).rejects.toThrow(SOS_ACK_NOT_FOUND_MSG);
      expect(prismaMock.sosEscalation.updateMany).not.toHaveBeenCalled();
    });

    it('404s when the SOS does not exist', async () => {
      prismaMock.sosEvent.findUnique.mockResolvedValue(null);
      await expect(
        service.acknowledge('contact-b', SOS_ID, 'Bola'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails CLOSED with a human message when the access check cannot run', async () => {
      usersMock.filterConsentingContactUserIds.mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        service.acknowledge('contact-b', SOS_ID, 'Bola'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.acknowledge('contact-b', SOS_ID, 'Bola'),
      ).rejects.toThrow(/local emergency services/i);
      expect(prismaMock.sosEscalation.updateMany).not.toHaveBeenCalled();
    });

    it('404s when the traveller tries to acknowledge their own SOS', async () => {
      await expect(
        service.acknowledge(USER_ID, SOS_ID, 'Ada'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent — a second acknowledgement reports nothing left to stop', async () => {
      prismaMock.sosEscalation.updateMany.mockResolvedValue({ count: 0 });
      const res = await service.acknowledge('contact-b', SOS_ID, 'Bola');
      expect(res.escalationStopped).toBe(false);
      expect(res.sosId).toBe(SOS_ID);
    });
  });

  describe('getTrail', () => {
    it('returns every attempt plus the ladder state and the honest notice', async () => {
      prismaMock.sosEscalation.findUnique.mockResolvedValue(
        makeEscalation({ rank: 2, totalAttempts: 3 }),
      );
      prismaMock.sosDelivery.findMany.mockResolvedValue([
        {
          contactUserId: 'contact-a',
          rank: 0,
          round: 0,
          attempt: 1,
          channel: SosDeliveryChannel.PUSH,
          status: SosDeliveryStatus.SENT,
          priority: false,
          detail: null,
          createdAt: RAISED_AT,
        },
      ]);

      const trail = await service.getTrail({
        id: SOS_ID,
        createdAt: RAISED_AT,
        resolvedAt: null,
      });

      expect(trail.sosId).toBe(SOS_ID);
      expect(trail.attempts).toHaveLength(1);
      expect(trail.attempts[0].at).toBe(RAISED_AT.toISOString());
      expect(trail.escalation?.contactsInLadder).toBe(3);
      expect(trail.escalation?.rank).toBe(2);
      expect(trail.notice).toMatch(/cannot contact emergency services/i);
    });

    it('returns a trail with no ladder when the SOS never had one', async () => {
      const trail = await service.getTrail({
        id: SOS_ID,
        createdAt: RAISED_AT,
        resolvedAt: null,
      });
      expect(trail.escalation).toBeNull();
      expect(trail.attempts).toEqual([]);
    });
  });

  describe('stopOnResolve', () => {
    it('closes a running ladder as RESOLVED', async () => {
      await service.stopOnResolve(SOS_ID);
      const arg = callArg<{
        where: { sosId: string; status: SosEscalationStatus };
        data: { status: SosEscalationStatus; nextAttemptAt: null };
      }>(prismaMock.sosEscalation.updateMany);
      expect(arg.where.sosId).toBe(SOS_ID);
      expect(arg.where.status).toBe(SosEscalationStatus.RUNNING);
      expect(arg.data.status).toBe(SosEscalationStatus.RESOLVED);
      expect(arg.data.nextAttemptAt).toBeNull();
    });

    it('never throws when the write fails — marking yourself safe must always work', async () => {
      prismaMock.sosEscalation.updateMany.mockRejectedValue(
        new Error('db down'),
      );
      await expect(service.stopOnResolve(SOS_ID)).resolves.toBeUndefined();
    });
  });

  // ── honesty ──────────────────────────────────────────────────────────

  describe('never implies an emergency-services integration', () => {
    it('says outright that RoamWarden cannot call emergency services in escalation pushes', async () => {
      await service.tick(makeEscalation({ rank: 0 }));
      const calls = notificationsMock.sendToUsers.mock.calls as NotifyCall[];
      expect(calls[0][1].body).toMatch(
        /RoamWarden cannot call emergency services/i,
      );
      expect(calls[0][1].body).not.toMatch(
        /police|ambulance|rescue|dispatch|911|999|112/i,
      );
    });
  });
});
