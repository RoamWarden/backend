import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as firebaseApp from 'firebase-admin/app';
import * as firebaseMessaging from 'firebase-admin/messaging';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FCM_MULTICAST_MAX_TOKENS } from './constant/notifications.constants';
import type { PushMessage } from './type/notifications.types';

jest.mock('firebase-admin/app');
jest.mock('firebase-admin/messaging');

const mockedApp = firebaseApp as jest.Mocked<typeof firebaseApp>;
const mockedMessaging = firebaseMessaging as jest.Mocked<
  typeof firebaseMessaging
>;

describe('NotificationsService', () => {
  interface MulticastPayload {
    tokens: string[];
    notification: { title: string; body: string };
    data?: Record<string, string>;
  }
  interface MulticastResult {
    successCount: number;
    failureCount: number;
    responses: Array<{ success: boolean; error?: { code?: string } }>;
  }

  let prismaMock: {
    deviceToken: { findMany: jest.Mock; deleteMany: jest.Mock };
  };
  let configValues: Record<string, string | undefined>;
  let configMock: { get: jest.Mock };
  let sendEachForMulticast: jest.Mock<
    Promise<MulticastResult>,
    [MulticastPayload]
  >;

  /** Typed read of the payload passed to the Nth sendEachForMulticast call. */
  const batchPayload = (call: number): MulticastPayload =>
    sendEachForMulticast.mock.calls[call][0];

  const FAKE_APP = { name: 'roamwarden' } as unknown as firebaseApp.App;
  const FAKE_CERT = { type: 'cert' } as unknown as firebaseApp.Credential;

  /** A successful per-token response with no errors. */
  const okResponse = (count: number): MulticastResult => ({
    successCount: count,
    failureCount: 0,
    responses: Array.from({ length: count }, () => ({ success: true })),
  });

  const buildService = async (): Promise<NotificationsService> => {
    prismaMock = {
      deviceToken: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    configMock = {
      get: jest.fn((key: string) => configValues[key]),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: ConfigService, useValue: configMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    return moduleRef.get(NotificationsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Silence logger output; we assert on specific methods per-test.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    mockedApp.initializeApp.mockReturnValue(FAKE_APP);
    mockedApp.cert.mockReturnValue(FAKE_CERT);

    sendEachForMulticast = jest.fn<
      Promise<MulticastResult>,
      [MulticastPayload]
    >();
    sendEachForMulticast.mockResolvedValue(okResponse(0));
    mockedMessaging.getMessaging.mockReturnValue({
      sendEachForMulticast,
    } as unknown as firebaseMessaging.Messaging);

    // Fully-configured Firebase by default; individual tests override.
    configValues = {
      FIREBASE_PROJECT_ID: 'roamwarden',
      FIREBASE_CLIENT_EMAIL: 'sa@roamwarden.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\\nLINE1\\nLINE2\\n-----END PRIVATE KEY-----\\n',
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit — Firebase unconfigured', () => {
    it.each([
      'FIREBASE_PROJECT_ID',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY',
    ])(
      'logs one warning and never calls initializeApp when %s is missing',
      async (missingKey) => {
        configValues[missingKey] = undefined;
        const warnSpy = jest.spyOn(Logger.prototype, 'warn');

        const service = await buildService();
        service.onModuleInit();

        expect(mockedApp.initializeApp).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          'Push notifications DISABLED — FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY not fully configured',
        );
      },
    );

    it('makes sendToUsers a no-op (getMessaging not called) and does not throw', async () => {
      configValues.FIREBASE_PROJECT_ID = undefined;
      const service = await buildService();
      service.onModuleInit();

      await expect(
        service.sendToUsers(['user-1'], { title: 'Hi', body: 'There' }),
      ).resolves.toBeUndefined();

      expect(mockedMessaging.getMessaging).not.toHaveBeenCalled();
      // No token lookup happens either — the app guard short-circuits before it.
      expect(prismaMock.deviceToken.findMany).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit — Firebase configured', () => {
    it('calls initializeApp with a cert credential', async () => {
      const service = await buildService();
      service.onModuleInit();

      expect(mockedApp.cert).toHaveBeenCalledTimes(1);
      expect(mockedApp.initializeApp).toHaveBeenCalledTimes(1);
      expect(mockedApp.initializeApp).toHaveBeenCalledWith({
        credential: FAKE_CERT,
      });
    });

    it("converts literal '\\n' sequences in the private key to real newlines", async () => {
      const service = await buildService();
      service.onModuleInit();

      const certArg = mockedApp.cert.mock.calls[0][0] as unknown as {
        projectId: string;
        clientEmail: string;
        privateKey: string;
      };
      expect(certArg.projectId).toBe('roamwarden');
      expect(certArg.clientEmail).toBe('sa@roamwarden.iam.gserviceaccount.com');
      expect(certArg.privateKey).toBe(
        '-----BEGIN PRIVATE KEY-----\nLINE1\nLINE2\n-----END PRIVATE KEY-----\n',
      );
      expect(certArg.privateKey).not.toContain('\\n');
    });

    it('does not re-initialize when onModuleInit runs twice', async () => {
      const service = await buildService();
      service.onModuleInit();
      service.onModuleInit();

      expect(mockedApp.initializeApp).toHaveBeenCalledTimes(1);
    });

    it('stays disabled (no-op) when initializeApp throws', async () => {
      mockedApp.initializeApp.mockImplementation(() => {
        throw new Error('malformed private key');
      });
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const service = await buildService();
      service.onModuleInit();

      expect(errorSpy).toHaveBeenCalled();

      // sendToUsers should behave as disabled: no messaging, no lookup.
      await expect(
        service.sendToUsers(['user-1'], { title: 'T', body: 'B' }),
      ).resolves.toBeUndefined();
      expect(mockedMessaging.getMessaging).not.toHaveBeenCalled();
      expect(prismaMock.deviceToken.findMany).not.toHaveBeenCalled();
    });
  });

  describe('sendToUsers — token lookup guards', () => {
    let service: NotificationsService;

    beforeEach(async () => {
      service = await buildService();
      service.onModuleInit();
    });

    it('returns early for an empty user list (no lookup, no messaging)', async () => {
      await service.sendToUsers([], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.findMany).not.toHaveBeenCalled();
      expect(mockedMessaging.getMessaging).not.toHaveBeenCalled();
    });

    it('looks up device tokens for the given users', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([{ token: 'tok-1' }]);

      await service.sendToUsers(['u1', 'u2'], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.findMany).toHaveBeenCalledWith({
        where: { userId: { in: ['u1', 'u2'] } },
        select: { token: true },
      });
    });

    it('returns without messaging when no tokens are registered', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([]);

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.findMany).toHaveBeenCalledTimes(1);
      expect(mockedMessaging.getMessaging).not.toHaveBeenCalled();
      expect(sendEachForMulticast).not.toHaveBeenCalled();
    });
  });

  describe('sendToUsers — chunking and data coercion', () => {
    let service: NotificationsService;

    beforeEach(async () => {
      service = await buildService();
      service.onModuleInit();
    });

    it(`batches into chunks of <=${FCM_MULTICAST_MAX_TOKENS} tokens`, async () => {
      // 600 tokens across 2 users → 2 batches (500 + 100).
      const tokens = Array.from({ length: 600 }, (_, i) => ({
        token: `tok-${i}`,
      }));
      prismaMock.deviceToken.findMany.mockResolvedValue(tokens);
      sendEachForMulticast
        .mockResolvedValueOnce(okResponse(500))
        .mockResolvedValueOnce(okResponse(100));

      await service.sendToUsers(['u1', 'u2'], { title: 'T', body: 'B' });

      expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
      const firstBatch = batchPayload(0);
      const secondBatch = batchPayload(1);
      expect(firstBatch.tokens).toHaveLength(500);
      expect(secondBatch.tokens).toHaveLength(100);
      // No token is dropped or duplicated across batches.
      const allSent = [...firstBatch.tokens, ...secondBatch.tokens];
      expect(new Set(allSent).size).toBe(600);
    });

    it('sends a single batch for token counts at or below the limit', async () => {
      const tokens = Array.from(
        { length: FCM_MULTICAST_MAX_TOKENS },
        (_, i) => ({
          token: `tok-${i}`,
        }),
      );
      prismaMock.deviceToken.findMany.mockResolvedValue(tokens);
      sendEachForMulticast.mockResolvedValue(
        okResponse(FCM_MULTICAST_MAX_TOKENS),
      );

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
      expect(batchPayload(0).tokens).toHaveLength(FCM_MULTICAST_MAX_TOKENS);
    });

    it('coerces all data values to strings and forwards title/body', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([{ token: 'tok-1' }]);
      sendEachForMulticast.mockResolvedValue(okResponse(1));

      const msg = {
        title: 'Alert',
        body: 'Incident nearby',
        data: {
          tripId: 42,
          severity: true,
          kind: 'THEFT',
        },
      } as unknown as PushMessage;

      await service.sendToUsers(['u1'], msg);

      const payload = batchPayload(0);
      expect(payload.notification).toEqual({
        title: 'Alert',
        body: 'Incident nearby',
      });
      expect(payload.data).toEqual({
        tripId: '42',
        severity: 'true',
        kind: 'THEFT',
      });
      // Every coerced value must be a string (FCM hard requirement).
      Object.values(payload.data ?? {}).forEach((v) =>
        expect(typeof v).toBe('string'),
      );
    });

    it('omits the data field entirely when the message has no data', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([{ token: 'tok-1' }]);
      sendEachForMulticast.mockResolvedValue(okResponse(1));

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      const payload = batchPayload(0);
      expect(payload).not.toHaveProperty('data');
    });
  });

  describe('sendToUsers — dead token pruning', () => {
    let service: NotificationsService;

    beforeEach(async () => {
      service = await buildService();
      service.onModuleInit();
    });

    it("prunes tokens that return 'messaging/registration-token-not-registered'", async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([
        { token: 'good-1' },
        { token: 'dead-1' },
        { token: 'good-2' },
      ]);
      prismaMock.deviceToken.deleteMany.mockResolvedValue({ count: 1 });
      sendEachForMulticast.mockResolvedValue({
        successCount: 2,
        failureCount: 1,
        responses: [
          { success: true },
          {
            success: false,
            error: { code: 'messaging/registration-token-not-registered' },
          },
          { success: true },
        ],
      });

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.deleteMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: { in: ['dead-1'] } },
      });
    });

    it('does not call deleteMany when every token succeeds', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([
        { token: 'good-1' },
        { token: 'good-2' },
      ]);
      sendEachForMulticast.mockResolvedValue(okResponse(2));

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.deleteMany).not.toHaveBeenCalled();
    });

    it('does not prune tokens whose failure code is not a dead-token code', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([
        { token: 'good-1' },
        { token: 'rate-limited-1' },
      ]);
      sendEachForMulticast.mockResolvedValue({
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: true },
          {
            success: false,
            error: { code: 'messaging/internal-error' },
          },
        ],
      });

      await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

      expect(prismaMock.deviceToken.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('sendToUsers — never throws', () => {
    let service: NotificationsService;

    beforeEach(async () => {
      service = await buildService();
      service.onModuleInit();
    });

    it('resolves (does not throw) when sendEachForMulticast rejects', async () => {
      prismaMock.deviceToken.findMany.mockResolvedValue([{ token: 'tok-1' }]);
      sendEachForMulticast.mockRejectedValue(new Error('FCM network down'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await expect(
        service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      // A batch failure must not trigger pruning.
      expect(prismaMock.deviceToken.deleteMany).not.toHaveBeenCalled();
    });

    it('continues with remaining batches when one batch rejects', async () => {
      const tokens = Array.from({ length: 600 }, (_, i) => ({
        token: `tok-${i}`,
      }));
      prismaMock.deviceToken.findMany.mockResolvedValue(tokens);
      sendEachForMulticast
        .mockRejectedValueOnce(new Error('batch 1 failed'))
        .mockResolvedValueOnce(okResponse(100));

      await expect(
        service.sendToUsers(['u1', 'u2'], { title: 'T', body: 'B' }),
      ).resolves.toBeUndefined();

      // Both batches were attempted despite the first rejecting.
      expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    });

    it('resolves when the prisma token lookup rejects', async () => {
      prismaMock.deviceToken.findMany.mockRejectedValue(
        new Error('db unavailable'),
      );
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      await expect(
        service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      expect(sendEachForMulticast).not.toHaveBeenCalled();
    });
  });
});
