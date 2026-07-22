import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AlertChannel, type Report } from '@prisma/client';
import { AlertsService } from './alerts.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import { NotificationsService } from '../notification/notifications.service';
import { CHANNEL_ALERT_INCIDENT } from '../../providers/redis/constant/redis.constants';
import {
  REPORT_ALERT_CORRIDOR_RADIUS_M,
  REPORT_ALERT_PRESENCE_RADIUS_M,
} from '../../common/constants';
import {
  PUSH_BODY_FALLBACK,
  PUSH_BODY_MAX_CHARS,
  REPORT_TYPE_ALERT_TITLE,
} from './constant/alerts.constants';
import type {
  AlertIncidentMessage,
  CorridorMatchRow,
} from './type/alerts.types';

interface AuditRow {
  reportId: string;
  userId: string;
  tripId: string | null;
  channel: AlertChannel;
}
interface CreateManyArg {
  data: AuditRow[];
  skipDuplicates: boolean;
}
interface PushMsg {
  title: string;
  body: string;
  data?: Record<string, string>;
}

describe('AlertsService', () => {
  let service: AlertsService;
  let prismaMock: {
    $queryRaw: jest.Mock;
    alert: { createMany: jest.Mock };
  };
  let redisMock: {
    searchNearbyUserIds: jest.Mock;
    partitionOnline: jest.Mock;
    publishJson: jest.Mock;
  };
  let notificationsMock: { sendToUsers: jest.Mock };

  const REPORTER_ID = 'reporter-uuid';

  const buildReport = (overrides: Partial<Report> = {}): Report =>
    ({
      id: 'report-uuid',
      reporterId: REPORTER_ID,
      type: 'ROBBERY',
      status: 'UNCONFIRMED',
      lat: 6.5244,
      lng: 3.3792,
      geog: null,
      note: 'Two men on a bike',
      confirmCount: 0,
      denyCount: 0,
      createdAt: new Date('2026-07-22T10:00:00.000Z'),
      expiresAt: new Date('2026-07-22T11:00:00.000Z'),
      ...overrides,
    }) as Report;

  const corridorRow = (userId: string, tripId: string): CorridorMatchRow => ({
    trip_id: tripId,
    user_id: userId,
  });

  // Typed accessors for jest mock call args (mock.calls is typed `any`).
  const createManyArg = (): CreateManyArg => {
    const call = prismaMock.alert.createMany.mock.calls[0] as [CreateManyArg];
    return call[0];
  };
  const publishedMessage = (): AlertIncidentMessage => {
    const call = redisMock.publishJson.mock.calls[0] as [
      string,
      AlertIncidentMessage,
    ];
    return call[1];
  };
  const pushCall = (): { targets: string[]; msg: PushMsg } => {
    const call = notificationsMock.sendToUsers.mock.calls[0] as [
      string[],
      PushMsg,
    ];
    return { targets: call[0], msg: call[1] };
  };

  beforeEach(async () => {
    prismaMock = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      alert: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    redisMock = {
      searchNearbyUserIds: jest.fn().mockResolvedValue([]),
      partitionOnline: jest.fn().mockResolvedValue({ online: [], offline: [] }),
      publishJson: jest.fn().mockResolvedValue(undefined),
    };
    notificationsMock = { sendToUsers: jest.fn().mockResolvedValue(undefined) };

    // Silence the service logger so test output stays clean.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        { provide: NotificationsService, useValue: notificationsMock },
      ],
    }).compile();

    service = moduleRef.get(AlertsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleNewReport — affected set / union', () => {
    it('unions corridor-matched users and presence-nearby users', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow('corridor-user', 'trip-1'),
      ]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['presence-user']);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['corridor-user', 'presence-user'],
      });

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(
        expect.arrayContaining(['corridor-user', 'presence-user']),
      );
      expect(result.alertedUserIds).toHaveLength(2);
    });

    it('de-duplicates a user matched by both corridor and presence', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('dupe', 'trip-1')]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['dupe']);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['dupe'],
      });

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['dupe']);
    });

    it('EXCLUDES the reporter from the alerted set (corridor + presence)', async () => {
      // Reporter shows up in BOTH corridor and presence results.
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow(REPORTER_ID, 'trip-self'),
        corridorRow('other-user', 'trip-2'),
      ]);
      redisMock.searchNearbyUserIds.mockResolvedValue([
        REPORTER_ID,
        'other-user',
      ]);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['other-user'],
      });

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['other-user']);
      expect(result.alertedUserIds).not.toContain(REPORTER_ID);
    });

    it('queries corridor and presence with the report point and configured radii', async () => {
      const report = buildReport({ lat: 1.23, lng: 4.56 });
      await service.handleNewReport(report);

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(redisMock.searchNearbyUserIds).toHaveBeenCalledWith(
        report.lat,
        report.lng,
        REPORT_ALERT_PRESENCE_RADIUS_M,
      );
      // Radius constant is a template-literal param woven into the raw query.
      expect(REPORT_ALERT_CORRIDOR_RADIUS_M).toBe(500);
    });
  });

  describe('handleNewReport — empty union short-circuit', () => {
    it('returns { alertedUserIds: [] } and does NOT publish, push, or partition', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      redisMock.searchNearbyUserIds.mockResolvedValue([]);

      const result = await service.handleNewReport(buildReport());

      expect(result).toEqual({ alertedUserIds: [] });
      expect(redisMock.partitionOnline).not.toHaveBeenCalled();
      expect(prismaMock.alert.createMany).not.toHaveBeenCalled();
      expect(redisMock.publishJson).not.toHaveBeenCalled();
      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
    });

    it('returns empty when the only match is the reporter themselves', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow(REPORTER_ID, 'trip-self'),
      ]);
      redisMock.searchNearbyUserIds.mockResolvedValue([REPORTER_ID]);

      const result = await service.handleNewReport(buildReport());

      expect(result).toEqual({ alertedUserIds: [] });
      expect(redisMock.publishJson).not.toHaveBeenCalled();
      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
    });
  });

  describe('handleNewReport — audit rows', () => {
    it('writes WEBSOCKET rows for online users and PUSH rows for offline users', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow('online-user', 'trip-online'),
        corridorRow('offline-user', 'trip-offline'),
      ]);
      redisMock.searchNearbyUserIds.mockResolvedValue([]);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['online-user'],
        offline: ['offline-user'],
      });

      await service.handleNewReport(buildReport());

      expect(prismaMock.alert.createMany).toHaveBeenCalledTimes(1);
      const arg = createManyArg();
      expect(arg.skipDuplicates).toBe(true);
      expect(arg.data).toEqual(
        expect.arrayContaining([
          {
            reportId: 'report-uuid',
            userId: 'online-user',
            tripId: 'trip-online',
            channel: AlertChannel.WEBSOCKET,
          },
          {
            reportId: 'report-uuid',
            userId: 'offline-user',
            tripId: 'trip-offline',
            channel: AlertChannel.PUSH,
          },
        ]),
      );
    });

    it('records tripId=null for presence-only users (no corridor trip)', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['presence-only']);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['presence-only'],
      });

      await service.handleNewReport(buildReport());

      const arg = createManyArg();
      expect(arg.data).toEqual([
        {
          reportId: 'report-uuid',
          userId: 'presence-only',
          tripId: null,
          channel: AlertChannel.PUSH,
        },
      ]);
    });
  });

  describe('handleNewReport — realtime publish (privacy)', () => {
    it('publishes exactly ONE message on CHANNEL_ALERT_INCIDENT', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['u1'],
        offline: [],
      });

      await service.handleNewReport(buildReport());

      expect(redisMock.publishJson).toHaveBeenCalledTimes(1);
      expect(redisMock.publishJson).toHaveBeenCalledWith(
        CHANNEL_ALERT_INCIDENT,
        expect.any(Object),
      );
    });

    it('published report payload has NO reporterId (privacy) and includes userIds', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['u2']);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['u1'],
        offline: ['u2'],
      });

      await service.handleNewReport(buildReport());

      const message = publishedMessage();
      // Privacy invariant: reporter identity must not leak on the wire.
      expect(message.report).not.toHaveProperty('reporterId');
      expect(JSON.stringify(message)).not.toContain(REPORTER_ID);
      // Payload carries all affected users + serialized report fields.
      expect(message.userIds).toEqual(expect.arrayContaining(['u1', 'u2']));
      expect(message.report).toEqual({
        id: 'report-uuid',
        type: 'ROBBERY',
        lat: 6.5244,
        lng: 3.3792,
        note: 'Two men on a bike',
        status: 'UNCONFIRMED',
        confirmCount: 0,
        denyCount: 0,
        createdAt: '2026-07-22T10:00:00.000Z',
        expiresAt: '2026-07-22T11:00:00.000Z',
      });
      expect(message.tripIdByUserId).toEqual({ u1: 'trip-1' });
    });

    it('omits tripIdByUserId when there are no corridor matches', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['presence-only']);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['presence-only'],
        offline: [],
      });

      await service.handleNewReport(buildReport());

      const message = publishedMessage();
      expect(message).not.toHaveProperty('tripIdByUserId');
    });
  });

  describe('handleNewReport — FCM push to offline only', () => {
    it('sends FCM to the OFFLINE users only, never the online ones', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow('online-user', 'trip-a'),
        corridorRow('offline-user', 'trip-b'),
      ]);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['online-user'],
        offline: ['offline-user'],
      });

      await service.handleNewReport(buildReport({ type: 'ROBBERY' }));

      expect(notificationsMock.sendToUsers).toHaveBeenCalledTimes(1);
      const { targets, msg } = pushCall();
      expect(targets).toEqual(['offline-user']);
      expect(targets).not.toContain('online-user');
      expect(msg.title).toBe(REPORT_TYPE_ALERT_TITLE.ROBBERY);
      expect(msg.body).toBe('Two men on a bike');
      expect(msg.data).toEqual({
        reportId: 'report-uuid',
        type: 'ROBBERY',
        lat: '6.5244',
        lng: '3.3792',
      });
    });

    it('does NOT push when everyone is online', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('only-online', 't')]);
      redisMock.partitionOnline.mockResolvedValue({
        online: ['only-online'],
        offline: [],
      });

      await service.handleNewReport(buildReport());

      expect(notificationsMock.sendToUsers).not.toHaveBeenCalled();
      // Realtime leg still fires for the online user.
      expect(redisMock.publishJson).toHaveBeenCalledTimes(1);
    });

    it('uses the fallback push body when the report has no note', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['u']);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['u'],
      });

      await service.handleNewReport(buildReport({ note: null }));

      const { msg } = pushCall();
      expect(msg.body).toBe(PUSH_BODY_FALLBACK);
    });

    it('truncates a long note with an ellipsis for the push body', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['u']);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['u'],
      });
      const longNote = 'x'.repeat(PUSH_BODY_MAX_CHARS + 50);

      await service.handleNewReport(buildReport({ note: longNote }));

      const { msg } = pushCall();
      expect(msg.body).toHaveLength(PUSH_BODY_MAX_CHARS);
      expect(msg.body.endsWith('…')).toBe(true);
    });
  });

  describe('handleNewReport — graceful degradation', () => {
    it('still alerts corridor users when the presence lookup REJECTS', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        corridorRow('corridor-user', 'trip-1'),
      ]);
      redisMock.searchNearbyUserIds.mockRejectedValue(
        new Error('redis GEO down'),
      );
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['corridor-user'],
      });

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['corridor-user']);
      expect(redisMock.publishJson).toHaveBeenCalledTimes(1);
      expect(notificationsMock.sendToUsers).toHaveBeenCalledWith(
        ['corridor-user'],
        expect.any(Object),
      );
    });

    it('treats everyone as offline (push fallback) when partitionOnline REJECTS', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.searchNearbyUserIds.mockResolvedValue(['u2']);
      redisMock.partitionOnline.mockRejectedValue(new Error('hmget failed'));

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(
        expect.arrayContaining(['u1', 'u2']),
      );
      // Everyone treated offline → all audit rows PUSH, all get FCM.
      const arg = createManyArg();
      expect(arg.data.every((r) => r.channel === AlertChannel.PUSH)).toBe(true);
      const { targets } = pushCall();
      expect(targets).toEqual(expect.arrayContaining(['u1', 'u2']));
    });

    it('a failed audit write does not block publish or push', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['u1'],
      });
      prismaMock.alert.createMany.mockRejectedValue(new Error('db write fail'));

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['u1']);
      expect(redisMock.publishJson).toHaveBeenCalledTimes(1);
      expect(notificationsMock.sendToUsers).toHaveBeenCalledTimes(1);
    });

    it('a failed publish does not block the push leg', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['u1'],
      });
      redisMock.publishJson.mockRejectedValue(new Error('pub/sub down'));

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['u1']);
      expect(notificationsMock.sendToUsers).toHaveBeenCalledTimes(1);
    });

    it('a failed push leg does not prevent returning the alerted users', async () => {
      prismaMock.$queryRaw.mockResolvedValue([corridorRow('u1', 'trip-1')]);
      redisMock.partitionOnline.mockResolvedValue({
        online: [],
        offline: ['u1'],
      });
      notificationsMock.sendToUsers.mockRejectedValue(new Error('fcm boom'));

      const result = await service.handleNewReport(buildReport());

      expect(result.alertedUserIds).toEqual(['u1']);
      expect(redisMock.publishJson).toHaveBeenCalledTimes(1);
    });
  });
});
