import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ReportStatus, ReportType } from '@prisma/client';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../providers/redis/redis.service';
import { AlertsService } from '../alert/alerts.service';
import {
  REPORT_GEO_PLAUSIBILITY_M,
  REPORT_REJECT_THRESHOLD,
  REPORT_TTL_S,
  REPORT_VERIFY_THRESHOLD,
  REPUTATION_REPORT_REJECTED,
  REPUTATION_REPORT_VERIFIED,
} from '../../common/constants';
import {
  BBOX_FORMAT_HINT,
  REPORT_RETRACT_FORBIDDEN_MSG,
  REPORT_RETRACT_NOT_FOUND_MSG,
  REPORT_SELF_RETRACT_REASON,
} from './constant/reports.constants';
import { haversineMeters } from '../../common/utils/geo.util';

const REPORTER_ID = '11111111-1111-1111-1111-111111111111';
const VOTER_ID = '22222222-2222-2222-2222-222222222222';
const REPORT_ID = '33333333-3333-3333-3333-333333333333';

/** `expect.any(Date)` typed as Date so it can sit inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;

/**
 * The SQL text of a recorded `$queryRaw` call, whichever way it was made: a
 * tagged template (first arg is the strings array) or a prebuilt `Prisma.sql`
 * fragment (which carries the same strings on `.strings`).
 *
 * Asserting on the text is the only way to prove a STATUS FILTER from a unit
 * test — the exclusion of retracted (REMOVED) reports lives in raw SQL, not in
 * a Prisma `where` object we could inspect.
 */
function sqlTextOf(call: unknown): string {
  const args = (call ?? []) as unknown[];
  const first = args[0];
  if (Array.isArray(first)) return (first as string[]).join(' ');
  if (first && typeof first === 'object' && 'strings' in first) {
    return (first as { strings: string[] }).strings.join(' ');
  }
  return String(first);
}

// A point in Lagos we treat as the reporter's ground truth.
const HERE = { lat: 6.5244, lng: 3.3792 };
// ~1.5km away (well within the 2km plausibility radius).
const NEARBY = { lat: 6.5354, lng: 3.3812 };
// ~11km away (well outside the plausibility radius).
const FAR = { lat: 6.6244, lng: 3.4792 };

type TxMock = {
  report: {
    create: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
  reportVote: {
    upsert: jest.Mock;
    count: jest.Mock;
  };
  user: {
    update: jest.Mock;
  };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
};

/** Builds a persisted Report row (as Prisma would return it). */
function buildReport(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date('2026-07-22T10:00:00.000Z');
  return {
    id: REPORT_ID,
    reporterId: REPORTER_ID,
    type: ReportType.ROBBERY,
    status: ReportStatus.UNCONFIRMED,
    lat: HERE.lat,
    lng: HERE.lng,
    note: null,
    confirmCount: 0,
    denyCount: 0,
    createdAt: now,
    expiresAt: new Date(
      now.getTime() + REPORT_TTL_S[ReportType.ROBBERY] * 1000,
    ),
    geog: null,
    ...overrides,
  };
}

describe('ReportsService', () => {
  let service: ReportsService;
  let prismaMock: {
    report: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    user: {
      update: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let redisMock: { getPresence: jest.Mock };
  let alertsMock: { handleNewReport: jest.Mock };
  let txMock: TxMock;

  beforeEach(async () => {
    // Silence the service logger so swallowed errors don't spam test output.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    txMock = {
      report: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      reportVote: {
        upsert: jest.fn().mockResolvedValue(undefined),
        count: jest.fn(),
      },
      user: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: REPORT_ID }]),
    };

    prismaMock = {
      report: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      // Run the callback against the tx mock so the transactional body executes.
      $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(txMock)),
      $queryRaw: jest.fn(),
    };

    redisMock = { getPresence: jest.fn().mockResolvedValue(null) };
    alertsMock = {
      handleNewReport: jest.fn().mockResolvedValue({ alertedUserIds: [] }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        { provide: AlertsService, useValue: alertsMock },
      ],
    }).compile();

    service = moduleRef.get(ReportsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── createReport ────────────────────────────────────────────────────────

  describe('createReport', () => {
    it('rejects a report dropped farther than REPORT_GEO_PLAUSIBILITY_M from presence', async () => {
      // Anchor the fixtures to the constant so the boundary stays meaningful.
      expect(
        haversineMeters(HERE.lat, HERE.lng, FAR.lat, FAR.lng),
      ).toBeGreaterThan(REPORT_GEO_PLAUSIBILITY_M);
      expect(
        haversineMeters(HERE.lat, HERE.lng, NEARBY.lat, NEARBY.lng),
      ).toBeLessThanOrEqual(REPORT_GEO_PLAUSIBILITY_M);

      redisMock.getPresence.mockResolvedValue(HERE);

      await expect(
        service.createReport(REPORTER_ID, {
          type: ReportType.ROBBERY,
          lat: FAR.lat,
          lng: FAR.lng,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      // Exact contract message.
      await expect(
        service.createReport(REPORTER_ID, {
          type: ReportType.ROBBERY,
          lat: FAR.lat,
          lng: FAR.lng,
        }),
      ).rejects.toThrow(
        'Reports must be dropped near your current location — you appear to be too far from this spot.',
      );

      // No persistence when the plausibility check fails.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('proceeds when presence is within REPORT_GEO_PLAUSIBILITY_M', async () => {
      redisMock.getPresence.mockResolvedValue(HERE);
      const created = buildReport({ lat: NEARBY.lat, lng: NEARBY.lng });
      txMock.report.create.mockResolvedValue(created);

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: NEARBY.lat,
        lng: NEARBY.lng,
      });

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(txMock.report.create).toHaveBeenCalledTimes(1);
      expect(view.id).toBe(REPORT_ID);
    });

    it('proceeds when presence is null (no ground-truth to check against)', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      const created = buildReport({ lat: FAR.lat, lng: FAR.lng });
      txMock.report.create.mockResolvedValue(created);

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: FAR.lat,
        lng: FAR.lng,
      });

      expect(view.id).toBe(REPORT_ID);
      expect(txMock.report.create).toHaveBeenCalledTimes(1);
    });

    it('skips the plausibility check (does not throw) when Redis presence lookup fails', async () => {
      redisMock.getPresence.mockRejectedValue(new Error('redis down'));
      const created = buildReport({ lat: FAR.lat, lng: FAR.lng });
      txMock.report.create.mockResolvedValue(created);

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: FAR.lat,
        lng: FAR.lng,
      });

      expect(view.id).toBe(REPORT_ID);
      expect(txMock.report.create).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid coordinates before touching presence or the database', async () => {
      await expect(
        service.createReport(REPORTER_ID, {
          type: ReportType.ROBBERY,
          lat: 999,
          lng: 3.3,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(redisMock.getPresence).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('sets expiresAt = createdAt + REPORT_TTL_S[type] for the report type', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      const fixedNow = new Date('2026-07-22T12:00:00.000Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      // Capture the data Prisma is asked to persist.
      let createdData: { expiresAt: Date } | undefined;
      txMock.report.create.mockImplementation(
        (args: { data: { expiresAt: Date } }) => {
          createdData = args.data;
          return Promise.resolve(
            buildReport({ expiresAt: args.data.expiresAt }),
          );
        },
      );

      await service.createReport(REPORTER_ID, {
        type: ReportType.CHECKPOINT,
        lat: HERE.lat,
        lng: HERE.lng,
      });

      const expectedExpiry =
        fixedNow + REPORT_TTL_S[ReportType.CHECKPOINT] * 1000;
      expect(createdData).toBeDefined();
      expect(createdData!.expiresAt.getTime()).toBe(expectedExpiry);
    });

    it('still creates the report when AlertsService.handleNewReport throws (fan-out is best-effort)', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      const created = buildReport();
      txMock.report.create.mockResolvedValue(created);
      alertsMock.handleNewReport.mockRejectedValue(
        new Error('alert fan-out boom'),
      );

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: HERE.lat,
        lng: HERE.lng,
      });

      expect(alertsMock.handleNewReport).toHaveBeenCalledTimes(1);
      // The report is returned despite the swallowed alert failure.
      expect(view.id).toBe(REPORT_ID);
    });

    it('returns the anonymized view and never exposes reporterId', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      const created = buildReport({ note: 'armed men at the junction' });
      txMock.report.create.mockResolvedValue(created);

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: HERE.lat,
        lng: HERE.lng,
      });

      expect(view).not.toHaveProperty('reporterId');
      expect(Object.keys(view)).toEqual([
        'id',
        'type',
        'status',
        'lat',
        'lng',
        'note',
        'confirmCount',
        'denyCount',
        'createdAt',
        'expiresAt',
        'mine',
      ]);
      expect(view.note).toBe('armed men at the junction');
    });
  });

  // ── vote ──────────────────────────────────────────────────────────────

  describe('vote', () => {
    it('throws ForbiddenException when voting on your own report', async () => {
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({ reporterId: VOTER_ID }),
      );

      await expect(service.vote(VOTER_ID, REPORT_ID, 1)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.vote(VOTER_ID, REPORT_ID, 1)).rejects.toThrow(
        'You cannot vote on your own report.',
      );
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the report does not exist', async () => {
      prismaMock.report.findUnique.mockResolvedValue(null);

      await expect(service.vote(VOTER_ID, REPORT_ID, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when the report is EXPIRED', async () => {
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({ status: ReportStatus.EXPIRED }),
      );

      await expect(service.vote(VOTER_ID, REPORT_ID, 1)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.vote(VOTER_ID, REPORT_ID, 1)).rejects.toThrow(
        'This report is no longer active.',
      );
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the report is REJECTED', async () => {
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({ status: ReportStatus.REJECTED }),
      );

      await expect(service.vote(VOTER_ID, REPORT_ID, -1)).rejects.toThrow(
        ConflictException,
      );
    });

    it('takes the FOR UPDATE row lock before recounting votes', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.reportVote.count.mockResolvedValue(0);
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(buildReport({ confirmCount: 1 }));
      txMock.report.update.mockResolvedValue(undefined);

      await service.vote(VOTER_ID, REPORT_ID, 1);

      // The lock query must run before the first vote recount.
      const lockOrder = txMock.$queryRaw.mock.invocationCallOrder[0];
      const firstCountOrder =
        txMock.reportVote.count.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(firstCountOrder);

      // And the lock is a raw SQL statement (FOR UPDATE), issued exactly once.
      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('recounts confirms/denies from reportVote.count (not increments)', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      // 1 confirm, 0 deny.
      txMock.reportVote.count
        .mockResolvedValueOnce(1) // vote: 1
        .mockResolvedValueOnce(0); // vote: -1
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(buildReport({ confirmCount: 1 }));
      txMock.report.update.mockResolvedValue(undefined);

      await service.vote(VOTER_ID, REPORT_ID, 1);

      // Below thresholds: no status transition, just a plain recount persist.
      expect(txMock.report.updateMany).not.toHaveBeenCalled();
      expect(txMock.report.update).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
        data: { confirmCount: 1, denyCount: 0 },
      });
      expect(txMock.user.update).not.toHaveBeenCalled();
    });

    it('transitions to VERIFIED at REPORT_VERIFY_THRESHOLD and applies +REPUTATION_REPORT_VERIFIED once', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.reportVote.count
        .mockResolvedValueOnce(REPORT_VERIFY_THRESHOLD) // confirms
        .mockResolvedValueOnce(0); // denies
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(
          buildReport({
            status: ReportStatus.VERIFIED,
            confirmCount: REPORT_VERIFY_THRESHOLD,
          }),
        );
      // Guarded transition matched (status still UNCONFIRMED).
      txMock.report.updateMany.mockResolvedValue({ count: 1 });

      const view = await service.vote(VOTER_ID, REPORT_ID, 1);

      // The status transition update is guarded on the prior status.
      expect(txMock.report.updateMany).toHaveBeenCalledWith({
        where: { id: REPORT_ID, status: ReportStatus.UNCONFIRMED },
        data: {
          status: ReportStatus.VERIFIED,
          confirmCount: REPORT_VERIFY_THRESHOLD,
          denyCount: 0,
        },
      });
      // Reputation applied exactly once, to the reporter, using the constant.
      expect(txMock.user.update).toHaveBeenCalledTimes(1);
      expect(txMock.user.update).toHaveBeenCalledWith({
        where: { id: REPORTER_ID },
        data: { reputation: { increment: REPUTATION_REPORT_VERIFIED } },
      });
      expect(view.status).toBe(ReportStatus.VERIFIED);
    });

    it('does not re-apply reputation when the guarded VERIFIED transition loses the race', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.reportVote.count
        .mockResolvedValueOnce(REPORT_VERIFY_THRESHOLD)
        .mockResolvedValueOnce(0);
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(buildReport({ status: ReportStatus.VERIFIED }));
      // Another voter already transitioned it: guarded update matches 0 rows.
      txMock.report.updateMany.mockResolvedValue({ count: 0 });
      txMock.report.update.mockResolvedValue(undefined);

      await service.vote(VOTER_ID, REPORT_ID, 1);

      expect(txMock.user.update).not.toHaveBeenCalled();
      // Fresh recount is still persisted after losing the race.
      expect(txMock.report.update).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
        data: { confirmCount: REPORT_VERIFY_THRESHOLD, denyCount: 0 },
      });
    });

    it('transitions to REJECTED at REPORT_REJECT_THRESHOLD when denies > confirms and applies REPUTATION_REPORT_REJECTED', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.reportVote.count
        .mockResolvedValueOnce(0) // confirms
        .mockResolvedValueOnce(REPORT_REJECT_THRESHOLD); // denies
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(
          buildReport({
            status: ReportStatus.REJECTED,
            denyCount: REPORT_REJECT_THRESHOLD,
          }),
        );
      txMock.report.updateMany.mockResolvedValue({ count: 1 });

      const view = await service.vote(VOTER_ID, REPORT_ID, -1);

      expect(txMock.report.updateMany).toHaveBeenCalledWith({
        where: { id: REPORT_ID, status: ReportStatus.UNCONFIRMED },
        data: {
          status: ReportStatus.REJECTED,
          confirmCount: 0,
          denyCount: REPORT_REJECT_THRESHOLD,
        },
      });
      expect(txMock.user.update).toHaveBeenCalledTimes(1);
      expect(txMock.user.update).toHaveBeenCalledWith({
        where: { id: REPORTER_ID },
        data: { reputation: { increment: REPUTATION_REPORT_REJECTED } },
      });
      expect(view.status).toBe(ReportStatus.REJECTED);
    });

    it('does not reject when denies reach the threshold but do not exceed confirms', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      // denies == confirms == threshold: not > confirms, so no rejection.
      txMock.reportVote.count
        .mockResolvedValueOnce(REPORT_REJECT_THRESHOLD) // confirms
        .mockResolvedValueOnce(REPORT_REJECT_THRESHOLD); // denies
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(buildReport({ status: ReportStatus.VERIFIED }));
      // confirms >= verify threshold and status UNCONFIRMED → VERIFIED wins.
      txMock.report.updateMany.mockResolvedValue({ count: 1 });

      await service.vote(VOTER_ID, REPORT_ID, 1);

      expect(txMock.report.updateMany).toHaveBeenCalledWith({
        where: { id: REPORT_ID, status: ReportStatus.UNCONFIRMED },
        data: {
          status: ReportStatus.VERIFIED,
          confirmCount: REPORT_REJECT_THRESHOLD,
          denyCount: REPORT_REJECT_THRESHOLD,
        },
      });
      expect(txMock.user.update).toHaveBeenCalledWith({
        where: { id: REPORTER_ID },
        data: { reputation: { increment: REPUTATION_REPORT_VERIFIED } },
      });
    });

    it('returns the anonymized view from vote (no reporterId leaked)', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.reportVote.count.mockResolvedValue(0);
      txMock.report.findUniqueOrThrow
        .mockResolvedValueOnce({
          status: ReportStatus.UNCONFIRMED,
          reporterId: REPORTER_ID,
        })
        .mockResolvedValueOnce(buildReport({ confirmCount: 1 }));
      txMock.report.update.mockResolvedValue(undefined);

      const view = await service.vote(VOTER_ID, REPORT_ID, 1);

      expect(view).not.toHaveProperty('reporterId');
    });
  });

  // ── findByBbox ────────────────────────────────────────────────────────

  describe('findByBbox', () => {
    it('throws BadRequestException with a format hint for a malformed bbox', async () => {
      await expect(service.findByBbox(VOTER_ID, 'not-a-bbox')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.findByBbox(VOTER_ID, '1,2,3')).rejects.toThrow(
        BBOX_FORMAT_HINT,
      );
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when bbox coordinates are out of range or min > max', async () => {
      // min lng greater than max lng.
      await expect(
        service.findByBbox(VOTER_ID, '3.42,6.44,3.35,6.52'),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('queries and maps rows to the anonymized view for a well-formed bbox', async () => {
      const row = {
        id: REPORT_ID,
        type: ReportType.ROBBERY,
        status: ReportStatus.UNCONFIRMED,
        lat: HERE.lat,
        lng: HERE.lng,
        note: 'checkpoint ahead',
        confirmCount: 2,
        denyCount: 0,
        createdAt: new Date('2026-07-22T10:00:00.000Z'),
        expiresAt: new Date('2026-07-22T14:00:00.000Z'),
        // The query compares reporter_id in SQL and returns only this boolean.
        mine: false,
      };
      prismaMock.$queryRaw.mockResolvedValue([row]);

      const views = await service.findByBbox(VOTER_ID, '3.35,6.44,3.42,6.52');

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(views).toHaveLength(1);
      expect(views[0]).not.toHaveProperty('reporterId');
      expect(views[0]).toEqual({
        id: REPORT_ID,
        type: ReportType.ROBBERY,
        status: ReportStatus.UNCONFIRMED,
        lat: HERE.lat,
        lng: HERE.lng,
        note: 'checkpoint ahead',
        confirmCount: 2,
        denyCount: 0,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        mine: false,
      });
    });

    it('accepts a types filter and returns the mapped rows', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      const views = await service.findByBbox(
        VOTER_ID,
        '3.35,6.44,3.42,6.52',
        'ROBBERY,checkpoint',
      );

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(views).toEqual([]);
    });

    it('rejects an unknown report type in the filter', async () => {
      await expect(
        service.findByBbox(VOTER_ID, '3.35,6.44,3.42,6.52', 'NOT_A_TYPE'),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ── clusterVerifyNearby ─────────────────────────────────────────────────

  describe('clusterVerifyNearby', () => {
    const NEAR_A = '44444444-4444-4444-4444-444444444444';
    const NEAR_B = '55555555-5555-5555-5555-555555555555';
    const REPORTER_A = '66666666-6666-6666-6666-666666666666';
    const REPORTER_B = '77777777-7777-7777-7777-777777777777';

    it('promotes UNCONFIRMED cluster members to VERIFIED with reputation, once each, when the cluster reaches the threshold', async () => {
      // A cluster of exactly the threshold size: the new report plus two more.
      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: REPORT_ID,
          reporterId: REPORTER_ID,
          status: ReportStatus.UNCONFIRMED,
        },
        {
          id: NEAR_A,
          reporterId: REPORTER_A,
          status: ReportStatus.UNCONFIRMED,
        },
        {
          id: NEAR_B,
          reporterId: REPORTER_B,
          status: ReportStatus.UNCONFIRMED,
        },
      ]);
      // Every guarded promotion matches its still-UNCONFIRMED row.
      prismaMock.report.updateMany.mockResolvedValue({ count: 1 });

      await service.clusterVerifyNearby(buildReport() as never);

      // Each UNCONFIRMED member is promoted with a status-guarded updateMany.
      expect(prismaMock.report.updateMany).toHaveBeenCalledTimes(3);
      expect(prismaMock.report.updateMany).toHaveBeenCalledWith({
        where: { id: NEAR_A, status: ReportStatus.UNCONFIRMED },
        data: { status: ReportStatus.VERIFIED },
      });
      // Reputation is rewarded exactly once per promoted member's reporter.
      expect(prismaMock.user.update).toHaveBeenCalledTimes(3);
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: REPORTER_A },
        data: { reputation: { increment: REPUTATION_REPORT_VERIFIED } },
      });
    });

    it('does not reward a member whose guarded promotion loses the race (count 0)', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: REPORT_ID,
          reporterId: REPORTER_ID,
          status: ReportStatus.UNCONFIRMED,
        },
        {
          id: NEAR_A,
          reporterId: REPORTER_A,
          status: ReportStatus.UNCONFIRMED,
        },
        {
          id: NEAR_B,
          reporterId: REPORTER_B,
          status: ReportStatus.UNCONFIRMED,
        },
      ]);
      // The first promotion wins; the rest were already promoted concurrently.
      prismaMock.report.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValue({ count: 0 });

      await service.clusterVerifyNearby(buildReport() as never);

      expect(prismaMock.report.updateMany).toHaveBeenCalledTimes(3);
      // Only the single winning transition rewards reputation.
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    });

    it('skips members that are already VERIFIED (no re-promotion, no double reward)', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: REPORT_ID,
          reporterId: REPORTER_ID,
          status: ReportStatus.UNCONFIRMED,
        },
        { id: NEAR_A, reporterId: REPORTER_A, status: ReportStatus.VERIFIED },
        {
          id: NEAR_B,
          reporterId: REPORTER_B,
          status: ReportStatus.UNCONFIRMED,
        },
      ]);
      prismaMock.report.updateMany.mockResolvedValue({ count: 1 });

      await service.clusterVerifyNearby(buildReport() as never);

      // The already-VERIFIED member is not touched; only the two UNCONFIRMED are.
      expect(prismaMock.report.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.report.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: NEAR_A, status: ReportStatus.UNCONFIRMED },
        }),
      );
      expect(prismaMock.user.update).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the cluster is below the threshold', async () => {
      // Fewer members than REPORT_CLUSTER_VERIFY_THRESHOLD.
      prismaMock.$queryRaw.mockResolvedValue([
        {
          id: REPORT_ID,
          reporterId: REPORTER_ID,
          status: ReportStatus.UNCONFIRMED,
        },
        {
          id: NEAR_A,
          reporterId: REPORTER_A,
          status: ReportStatus.UNCONFIRMED,
        },
      ]);

      await service.clusterVerifyNearby(buildReport() as never);

      expect(prismaMock.report.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('is best-effort inside createReport: a cluster failure never fails report creation', async () => {
      redisMock.getPresence.mockResolvedValue(null);
      const created = buildReport();
      txMock.report.create.mockResolvedValue(created);
      // The cluster query (a top-level $queryRaw during createReport) blows up.
      prismaMock.$queryRaw.mockRejectedValue(new Error('cluster query boom'));

      const view = await service.createReport(REPORTER_ID, {
        type: ReportType.ROBBERY,
        lat: HERE.lat,
        lng: HERE.lng,
      });

      // The report is still returned despite the swallowed cluster failure.
      expect(view.id).toBe(REPORT_ID);
    });
  });

  // ── removeReport ────────────────────────────────────────────────────────

  describe('removeReport', () => {
    const ADMIN_ID = '88888888-8888-8888-8888-888888888888';

    it('throws NotFoundException when the report does not exist', async () => {
      prismaMock.report.findUnique.mockResolvedValue(null);

      await expect(
        service.removeReport(ADMIN_ID, REPORT_ID, 'spam'),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.report.update).not.toHaveBeenCalled();
    });

    it('marks the report REMOVED with the moderation audit trail', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      prismaMock.report.update.mockResolvedValue(
        buildReport({
          status: ReportStatus.REMOVED,
          removedById: ADMIN_ID,
          removedReason: 'duplicate',
          removedAt: new Date(),
        }),
      );

      const view = await service.removeReport(ADMIN_ID, REPORT_ID, 'duplicate');

      expect(prismaMock.report.update).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
        data: {
          status: ReportStatus.REMOVED,
          removedById: ADMIN_ID,
          removedReason: 'duplicate',
          removedAt: ANY_DATE,
        },
      });
      expect(view.status).toBe(ReportStatus.REMOVED);
    });

    it('persists a null reason when none is given', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      prismaMock.report.update.mockResolvedValue(
        buildReport({ status: ReportStatus.REMOVED }),
      );

      await service.removeReport(ADMIN_ID, REPORT_ID);

      expect(prismaMock.report.update).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
        data: {
          status: ReportStatus.REMOVED,
          removedById: ADMIN_ID,
          removedReason: null,
          removedAt: ANY_DATE,
        },
      });
    });

    it('returns the anonymized view — never exposes reporterId', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      prismaMock.report.update.mockResolvedValue(
        buildReport({
          status: ReportStatus.REMOVED,
          removedById: ADMIN_ID,
          removedAt: new Date(),
        }),
      );

      const view = await service.removeReport(ADMIN_ID, REPORT_ID, 'abuse');

      expect(view).not.toHaveProperty('reporterId');
      expect(view).not.toHaveProperty('removedById');
      expect(Object.keys(view)).toEqual([
        'id',
        'type',
        'status',
        'lat',
        'lng',
        'note',
        'confirmCount',
        'denyCount',
        'createdAt',
        'expiresAt',
        'mine',
      ]);
    });
  });

  // ── retractReport (owner self-retraction) ───────────────────────────────

  describe('retractReport', () => {
    const ADMIN_ID = '88888888-8888-8888-8888-888888888888';

    it('lets the author take their own report down, with the self-retraction audit', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.UNCONFIRMED,
      });
      txMock.report.update.mockResolvedValue(
        buildReport({
          status: ReportStatus.REMOVED,
          removedById: REPORTER_ID,
          removedReason: REPORT_SELF_RETRACT_REASON,
          removedAt: new Date(),
        }),
      );

      const view = await service.retractReport(REPORTER_ID, REPORT_ID);

      expect(txMock.report.update).toHaveBeenCalledWith({
        where: { id: REPORT_ID },
        data: {
          status: ReportStatus.REMOVED,
          // removedById is the REPORTER on a self-retraction — that equality is
          // what tells it apart from an admin takedown in the audit.
          removedById: REPORTER_ID,
          removedReason: REPORT_SELF_RETRACT_REASON,
          removedAt: ANY_DATE,
        },
      });
      expect(view.status).toBe(ReportStatus.REMOVED);
      expect(view.mine).toBe(true);
      expect(view).not.toHaveProperty('reporterId');
    });

    it('refuses a report the caller did not file — 403 with the reason, and no write', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());

      await expect(service.retractReport(VOTER_ID, REPORT_ID)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.retractReport(VOTER_ID, REPORT_ID)).rejects.toThrow(
        REPORT_RETRACT_FORBIDDEN_MSG,
      );
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(txMock.report.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the report does not exist', async () => {
      prismaMock.report.findUnique.mockResolvedValue(null);

      await expect(
        service.retractReport(REPORTER_ID, REPORT_ID),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.retractReport(REPORTER_ID, REPORT_ID),
      ).rejects.toThrow(REPORT_RETRACT_NOT_FOUND_MSG);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('is idempotent on an already-removed report and never overwrites an admin audit', async () => {
      const removedAt = new Date('2026-07-22T11:00:00.000Z');
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({
          status: ReportStatus.REMOVED,
          removedById: ADMIN_ID,
          removedReason: 'abuse',
          removedAt,
        }),
      );

      const view = await service.retractReport(REPORTER_ID, REPORT_ID);

      // Already where the caller wanted it: no transaction, no second write, no
      // second reputation reversal, and the admin's reason survives.
      expect(view.status).toBe(ReportStatus.REMOVED);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(txMock.report.update).not.toHaveBeenCalled();
      expect(txMock.user.update).not.toHaveBeenCalled();
    });

    it('gives back the verification reward when the retracted report was VERIFIED', async () => {
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({ status: ReportStatus.VERIFIED }),
      );
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.VERIFIED,
      });
      txMock.report.update.mockResolvedValue(
        buildReport({ status: ReportStatus.REMOVED, removedById: REPORTER_ID }),
      );

      await service.retractReport(REPORTER_ID, REPORT_ID);

      // A reversal of the award that was granted, not a retraction penalty.
      expect(txMock.user.update).toHaveBeenCalledTimes(1);
      expect(txMock.user.update).toHaveBeenCalledWith({
        where: { id: REPORTER_ID },
        data: { reputation: { decrement: REPUTATION_REPORT_VERIFIED } },
      });
    });

    it('touches reputation for no other status — an UNCONFIRMED retraction is free', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.UNCONFIRMED,
      });
      txMock.report.update.mockResolvedValue(
        buildReport({ status: ReportStatus.REMOVED, removedById: REPORTER_ID }),
      );

      await service.retractReport(REPORTER_ID, REPORT_ID);

      expect(txMock.user.update).not.toHaveBeenCalled();
    });

    it('keeps the -5 of a REJECTED report — retracting must not erase a penalty', async () => {
      prismaMock.report.findUnique.mockResolvedValue(
        buildReport({ status: ReportStatus.REJECTED }),
      );
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.REJECTED,
      });
      txMock.report.update.mockResolvedValue(
        buildReport({ status: ReportStatus.REMOVED, removedById: REPORTER_ID }),
      );

      await service.retractReport(REPORTER_ID, REPORT_ID);

      expect(txMock.user.update).not.toHaveBeenCalled();
    });

    it('writes nothing when a concurrent takedown won the row lock', async () => {
      prismaMock.report.findUnique
        // First read (pre-lock): still active.
        .mockResolvedValueOnce(buildReport())
        // Re-read after the lost race, for the honest answer.
        .mockResolvedValueOnce(
          buildReport({ status: ReportStatus.REMOVED, removedById: ADMIN_ID }),
        );
      // Inside the lock it is already gone.
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.REMOVED,
      });

      const view = await service.retractReport(REPORTER_ID, REPORT_ID);

      expect(txMock.report.update).not.toHaveBeenCalled();
      expect(txMock.user.update).not.toHaveBeenCalled();
      expect(view.status).toBe(ReportStatus.REMOVED);
    });

    it('takes the same row lock the vote path takes', async () => {
      prismaMock.report.findUnique.mockResolvedValue(buildReport());
      txMock.report.findUniqueOrThrow.mockResolvedValue({
        status: ReportStatus.UNCONFIRMED,
      });
      txMock.report.update.mockResolvedValue(
        buildReport({ status: ReportStatus.REMOVED }),
      );

      await service.retractReport(REPORTER_ID, REPORT_ID);

      // FOR UPDATE, or a voter can verify the report between our read and write.
      expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
      expect(sqlTextOf(txMock.$queryRaw.mock.calls[0])).toContain('FOR UPDATE');
    });
  });

  // ── retracted reports disappear from the read paths ─────────────────────

  describe('retracted reports are excluded from the geo queries', () => {
    it('bbox only ever selects UNCONFIRMED/VERIFIED rows', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      await service.findByBbox(REPORTER_ID, '3.35,6.44,3.42,6.52');

      const sql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
      // REMOVED (which is where a retraction lands) can never match this filter.
      expect(sql).toContain("status IN ('UNCONFIRMED', 'VERIFIED')");
      expect(sql).not.toContain('REMOVED');
      // Authorship is compared in SQL; reporter_id itself is never selected.
      expect(sql).toContain('AS "mine"');
    });

    it('near only ever selects UNCONFIRMED/VERIFIED rows', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      await service.findNear(REPORTER_ID, HERE.lat, HERE.lng, 2000);

      const sql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
      expect(sql).toContain("status IN ('UNCONFIRMED', 'VERIFIED')");
      expect(sql).not.toContain('REMOVED');
      expect(sql).toContain('AS "mine"');
    });

    it('cluster auto-verify never counts a retracted report toward a cluster', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      await service.clusterVerifyNearby(buildReport() as never);

      const sql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
      expect(sql).toContain("status IN ('UNCONFIRMED', 'VERIFIED')");
      expect(sql).not.toContain('REMOVED');
    });
  });
});
