import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import { WaitlistService } from './waitlist.service';
import {
  WAITLIST_DEFAULT_LIMIT,
  WAITLIST_DEFAULT_PAGE,
  WAITLIST_MAX_LIMIT,
} from './constant/waitlist.constants';

type WaitlistRow = {
  id: string;
  email: string;
  source: string | null;
  createdAt: Date;
};

/** A P2002 unique-constraint violation as Prisma raises it. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('WaitlistService', () => {
  let service: WaitlistService;
  let prismaMock: {
    waitlistEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let mailMock: { sendWaitlistConfirmation: jest.Mock };

  beforeEach(async () => {
    prismaMock = {
      waitlistEntry: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      // The service passes an array of query promises; resolve them all.
      $transaction: jest.fn(
        (ops: Array<Promise<unknown>>): Promise<unknown[]> => Promise.all(ops),
      ),
    };
    mailMock = {
      sendWaitlistConfirmation: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WaitlistService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MailService, useValue: mailMock },
      ],
    }).compile();

    service = moduleRef.get(WaitlistService);
  });

  describe('join', () => {
    it('normalizes the email (lowercase/trim), creates the entry and sends one confirmation', async () => {
      prismaMock.waitlistEntry.create.mockResolvedValue({ id: 'w-1' });

      const result = await service.join({
        email: '  Traveller@Example.COM  ',
        source: '  landing  ',
      });

      expect(result).toEqual({ joined: true, alreadyJoined: false });
      expect(prismaMock.waitlistEntry.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.waitlistEntry.create).toHaveBeenCalledWith({
        data: { email: 'traveller@example.com', source: 'landing' },
      });

      // Confirmation is fire-and-forget; let the microtask queue drain.
      await Promise.resolve();
      expect(mailMock.sendWaitlistConfirmation).toHaveBeenCalledTimes(1);
      expect(mailMock.sendWaitlistConfirmation).toHaveBeenCalledWith(
        'traveller@example.com',
      );
    });

    it('stores a null source when none is provided', async () => {
      prismaMock.waitlistEntry.create.mockResolvedValue({ id: 'w-2' });

      await service.join({ email: 'a@b.com' });

      expect(prismaMock.waitlistEntry.create).toHaveBeenCalledWith({
        data: { email: 'a@b.com', source: null },
      });
    });

    it('treats a P2002 as an idempotent re-join and does NOT resend', async () => {
      prismaMock.waitlistEntry.create.mockRejectedValue(uniqueViolation());

      const result = await service.join({ email: 'dup@example.com' });

      expect(result).toEqual({ joined: true, alreadyJoined: true });
      await Promise.resolve();
      expect(mailMock.sendWaitlistConfirmation).not.toHaveBeenCalled();
    });

    it('rethrows non-P2002 database errors', async () => {
      prismaMock.waitlistEntry.create.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(service.join({ email: 'x@example.com' })).rejects.toThrow(
        'connection reset',
      );
      expect(mailMock.sendWaitlistConfirmation).not.toHaveBeenCalled();
    });

    it('never fails the join when the confirmation email rejects', async () => {
      prismaMock.waitlistEntry.create.mockResolvedValue({ id: 'w-3' });
      mailMock.sendWaitlistConfirmation.mockRejectedValue(
        new Error('mail provider down'),
      );
      const errorSpy = jest
        .spyOn(
          (service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      const result = await service.join({ email: 'safe@example.com' });

      expect(result).toEqual({ joined: true, alreadyJoined: false });
      // Drain the rejection so it is handled (service .catch) and does not leak.
      await Promise.resolve();
      await Promise.resolve();
      expect(mailMock.sendWaitlistConfirmation).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('list', () => {
    const rows: WaitlistRow[] = [
      {
        id: 'w-1',
        email: 'a@example.com',
        source: 'landing',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        id: 'w-2',
        email: 'b@example.com',
        source: null,
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
      },
    ];

    it('paginates with skip/take and returns entries + total', async () => {
      prismaMock.waitlistEntry.findMany.mockResolvedValue(rows);
      prismaMock.waitlistEntry.count.mockResolvedValue(42);

      const result = await service.list({ page: 3, limit: 10 });

      expect(result).toEqual({ entries: rows, total: 42, page: 3, limit: 10 });
      expect(prismaMock.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
          skip: 20, // (3 - 1) * 10
          take: 10,
        }),
      );
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it('applies default page and limit when omitted', async () => {
      prismaMock.waitlistEntry.findMany.mockResolvedValue([]);
      prismaMock.waitlistEntry.count.mockResolvedValue(0);

      const result = await service.list({});

      expect(result.page).toBe(WAITLIST_DEFAULT_PAGE);
      expect(result.limit).toBe(WAITLIST_DEFAULT_LIMIT);
      expect(prismaMock.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: WAITLIST_DEFAULT_LIMIT }),
      );
    });

    it('caps the limit at WAITLIST_MAX_LIMIT', async () => {
      prismaMock.waitlistEntry.findMany.mockResolvedValue([]);
      prismaMock.waitlistEntry.count.mockResolvedValue(0);

      const result = await service.list({ page: 1, limit: 10_000 });

      expect(result.limit).toBe(WAITLIST_MAX_LIMIT);
      expect(prismaMock.waitlistEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: WAITLIST_MAX_LIMIT }),
      );
    });
  });

  describe('count', () => {
    it('returns the total number of waitlist entries', async () => {
      prismaMock.waitlistEntry.count.mockResolvedValue(7);

      await expect(service.count()).resolves.toBe(7);
      expect(prismaMock.waitlistEntry.count).toHaveBeenCalledTimes(1);
    });
  });
});
