import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { EMAIL_OTP_MAX_ATTEMPTS } from '../../common/constants';
import { EmailVerificationService } from './email-verification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import { UsersService } from '../user/users.service';
import { TokensService } from './tokens.service';
import type { ConfigService } from '@nestjs/config';

const OTP_SECRET = 'test-otp-secret';

/** Re-implements the service's keyed hash so tests can plant a matching code. */
function hashCode(userId: string, code: string): string {
  return createHmac('sha256', OTP_SECRET)
    .update(`email-otp:${userId}:${code}`)
    .digest('hex');
}

/** `expect.any(Date)` typed as Date so it fits inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;

const SESSION = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: 'user-1',
    email: 'traveller@example.com',
    name: 'Traveller',
    avatarUrl: null,
    reputation: 0,
  },
};

type PrismaMock = {
  emailVerificationOtp: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  user: { update: jest.Mock };
  $transaction: jest.Mock;
};

/** Prisma mock whose `$transaction(cb)` runs the callback against itself. */
function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    emailVerificationOtp: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((cb: (tx: PrismaMock) => unknown) =>
    cb(mock),
  );
  return mock;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'traveller@example.com',
    name: 'Traveller',
    avatarUrl: null,
    reputation: 0,
    passwordHash: 'hashed:current-secret',
    emailVerifiedAt: null,
    ...overrides,
  } as User;
}

interface OtpCreateArg {
  data: { userId: string; codeHash: string; expiresAt: Date };
}

describe('EmailVerificationService', () => {
  let prisma: PrismaMock;
  let usersService: { findByEmail: jest.Mock; markEmailVerified: jest.Mock };
  let tokensService: { issueSession: jest.Mock };
  let mailService: { sendVerificationCode: jest.Mock; sendWelcome: jest.Mock };
  let service: EmailVerificationService;

  beforeEach(() => {
    prisma = makePrismaMock();
    usersService = {
      findByEmail: jest.fn(),
      markEmailVerified: jest.fn().mockResolvedValue(undefined),
    };
    tokensService = { issueSession: jest.fn().mockResolvedValue(SESSION) };
    mailService = {
      sendVerificationCode: jest.fn().mockResolvedValue(undefined),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue(OTP_SECRET),
    } as unknown as ConfigService;

    service = new EmailVerificationService(
      prisma as unknown as PrismaService,
      usersService as unknown as UsersService,
      tokensService as unknown as TokensService,
      mailService as unknown as MailService,
      config,
    );
  });

  describe('start', () => {
    it('stores a keyed hash (never the raw code), sets expiry, retires old codes, and emails the code (force)', async () => {
      const user = makeUser();

      await service.start(user, { force: true });

      // force skips the cooldown lookup entirely
      expect(prisma.emailVerificationOtp.findFirst).not.toHaveBeenCalled();
      // old codes are retired before a new one is minted
      expect(prisma.emailVerificationOtp.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', consumedAt: null },
        data: { consumedAt: ANY_DATE },
      });

      const createArg = (
        prisma.emailVerificationOtp.create.mock.calls as Array<[OtpCreateArg]>
      )[0][0];
      expect(createArg.data.userId).toBe('user-1');
      expect(createArg.data.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(createArg.data.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // The emailed code is 6 digits AND hashes to exactly what we stored.
      const sendArgs = mailService.sendVerificationCode.mock.calls as Array<
        [string, string]
      >;
      const [toEmail, sentCode] = sendArgs[0];
      expect(toEmail).toBe('traveller@example.com');
      expect(sentCode).toMatch(/^\d{6}$/);
      expect(hashCode('user-1', sentCode)).toBe(createArg.data.codeHash);
    });

    it('skips sending within the resend cooldown (no force)', async () => {
      prisma.emailVerificationOtp.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 5_000), // 5s ago, inside cooldown
      });

      await service.start(makeUser());

      expect(prisma.emailVerificationOtp.create).not.toHaveBeenCalled();
      expect(mailService.sendVerificationCode).not.toHaveBeenCalled();
    });

    it('sends a fresh code once the cooldown has passed (no force)', async () => {
      prisma.emailVerificationOtp.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 120_000), // 2 min ago
      });

      await service.start(makeUser());

      expect(prisma.emailVerificationOtp.create).toHaveBeenCalledTimes(1);
      expect(mailService.sendVerificationCode).toHaveBeenCalledTimes(1);
    });

    it('throws ServiceUnavailable when the code email fails to send', async () => {
      mailService.sendVerificationCode.mockRejectedValue(
        new Error('resend down'),
      );

      await expect(service.start(makeUser(), { force: true })).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('verify', () => {
    function plantCode(code: string, overrides: Record<string, unknown> = {}) {
      prisma.emailVerificationOtp.findFirst.mockResolvedValue({
        id: 'otp-1',
        userId: 'user-1',
        codeHash: hashCode('user-1', code),
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        ...overrides,
      });
    }

    it('accepts a valid code: claims it atomically, marks the email verified, and issues a session', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      plantCode('123456');

      const result = await service.verify({
        email: 'traveller@example.com',
        code: '123456',
      });

      // single-use atomic claim
      expect(prisma.emailVerificationOtp.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', consumedAt: null },
        data: { consumedAt: ANY_DATE },
      });
      // durable verified flag
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { emailVerifiedAt: ANY_DATE },
      });
      expect(mailService.sendWelcome).toHaveBeenCalledWith(
        'traveller@example.com',
        'Traveller',
      );
      expect(tokensService.issueSession).toHaveBeenCalledWith(user);
      expect(result).toEqual(SESSION);
    });

    it('rejects an unknown email (uniform invalid-code error)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.verify({ email: 'ghost@example.com', code: '123456' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an already-verified email with the neutral message (no enumeration)', async () => {
      usersService.findByEmail.mockResolvedValue(
        makeUser({ emailVerifiedAt: new Date() }),
      );

      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(BadRequestException);
      // Must NOT surface a distinct "already verified" oracle.
      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(/invalid or has expired/i);
    });

    it('rejects when there is no active code', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      prisma.emailVerificationOtp.findFirst.mockResolvedValue(null);

      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an expired code', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      plantCode('123456', { expiresAt: new Date(Date.now() - 1_000) });

      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('atomically counts a wrong guess (increment guarded by the cap) and rejects', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      plantCode('654321');

      await expect(
        service.verify({ email: 'traveller@example.com', code: '000000' }),
      ).rejects.toThrow(BadRequestException);

      // The increment is a single conditional update that ALSO enforces the cap
      // (attemptCount < MAX) — this is what makes the limit race-safe.
      expect(prisma.emailVerificationOtp.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'otp-1',
          consumedAt: null,
          attemptCount: { lt: EMAIL_OTP_MAX_ATTEMPTS },
        },
        data: { attemptCount: { increment: 1 } },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('burns the code and rejects once the atomic cap-guarded increment matches nothing', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      plantCode('123456');
      // The guarded increment matches no row (already at the cap) → count 0.
      prisma.emailVerificationOtp.updateMany.mockResolvedValueOnce({
        count: 0,
      });

      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(/too many/i);

      // burned (consumed), never counted as a valid verification
      expect(prisma.emailVerificationOtp.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', consumedAt: null },
        data: { consumedAt: ANY_DATE },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects when the atomic claim loses the race (count 0)', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      plantCode('123456');
      prisma.emailVerificationOtp.updateMany
        .mockResolvedValueOnce({ count: 1 }) // guess counted (under the cap)
        .mockResolvedValueOnce({ count: 0 }); // claim loses the race

      await expect(
        service.verify({ email: 'traveller@example.com', code: '123456' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(tokensService.issueSession).not.toHaveBeenCalled();
    });
  });

  describe('resend', () => {
    it('sends a fresh code for an unverified account and returns the neutral message', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());

      const result = await service.resend({ email: 'traveller@example.com' });

      expect(mailService.sendVerificationCode).toHaveBeenCalledTimes(1);
      expect(result.message).toMatch(/sent a new code/i);
    });

    it('returns the SAME neutral message without sending for unknown / verified accounts (no enumeration)', async () => {
      usersService.findByEmail.mockResolvedValueOnce(makeUser()); // unverified
      const neutral = (await service.resend({ email: 'a@example.com' }))
        .message;

      usersService.findByEmail.mockResolvedValueOnce(null); // unknown
      const unknown = (await service.resend({ email: 'ghost@example.com' }))
        .message;

      usersService.findByEmail.mockResolvedValueOnce(
        makeUser({ emailVerifiedAt: new Date() }),
      ); // already verified
      const verified = (await service.resend({ email: 'v@example.com' }))
        .message;

      expect(unknown).toBe(neutral);
      expect(verified).toBe(neutral);
      // only the first (unverified) call actually sent a code
      expect(mailService.sendVerificationCode).toHaveBeenCalledTimes(1);
    });

    it('stays neutral even if sending throws internally', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      mailService.sendVerificationCode.mockRejectedValue(new Error('down'));

      const result = await service.resend({ email: 'traveller@example.com' });

      expect(result.message).toMatch(/sent a new code/i);
    });
  });
});
