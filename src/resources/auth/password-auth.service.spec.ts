import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PasswordAuthService } from './password-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import { UsersService } from '../user/users.service';
import { EmailVerificationService } from './email-verification.service';
import { TokensService } from './tokens.service';

// Mock bcryptjs so hashing/comparison are deterministic and observable. hash
// prefixes the raw so the stored value is verifiably not the plaintext; compare
// is configured per-case.
jest.mock('bcryptjs', () => ({
  hash: jest.fn((raw: string) => Promise.resolve(`hashed:${raw}`)),
  compare: jest.fn(),
}));

const bcryptHash = bcrypt.hash as unknown as jest.Mock;
const bcryptCompare = bcrypt.compare as unknown as jest.Mock;

const INCORRECT_CREDENTIALS = 'Incorrect email or password.';
const FORGOT_PASSWORD_MESSAGE =
  'If an account with that email exists, a password reset link has been sent.';

/** `expect.any(Date)` typed as Date so it can sit inside typed matcher literals. */
const ANY_DATE = expect.any(Date) as unknown as Date;

type PrismaMock = {
  passwordResetToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { update: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
  $transaction: jest.Mock;
};

/** Prisma mock whose `$transaction(cb)` runs the callback against itself. */
function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((cb: (tx: PrismaMock) => unknown) =>
    cb(mock),
  );
  return mock;
}

/** A local (email/password) user row with sane defaults. Verified by default. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'traveller@example.com',
    name: 'Traveller',
    avatarUrl: null,
    reputation: 0,
    passwordHash: 'hashed:current-secret',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

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

describe('PasswordAuthService', () => {
  let prisma: PrismaMock;
  let usersService: {
    createLocalUser: jest.Mock;
    findByEmail: jest.Mock;
    findById: jest.Mock;
    updateLocalCredentials: jest.Mock;
  };
  let tokensService: {
    signAccessToken: jest.Mock;
    issueRefreshToken: jest.Mock;
    issueSession: jest.Mock;
  };
  let mailService: {
    buildResetUrl: jest.Mock;
    sendPasswordReset: jest.Mock;
    sendWelcome: jest.Mock;
  };
  let emailVerification: { start: jest.Mock };
  let service: PasswordAuthService;

  beforeEach(() => {
    bcryptHash.mockClear();
    bcryptCompare.mockReset();

    prisma = makePrismaMock();
    usersService = {
      createLocalUser: jest.fn(),
      findByEmail: jest.fn(),
      findById: jest.fn(),
      updateLocalCredentials: jest.fn(),
    };
    tokensService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      issueRefreshToken: jest.fn().mockResolvedValue({
        token: 'refresh-token',
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      issueSession: jest.fn().mockResolvedValue(SESSION),
    };
    mailService = {
      buildResetUrl: jest
        .fn()
        .mockReturnValue('https://app/reset-password?token=raw'),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
    };
    emailVerification = { start: jest.fn().mockResolvedValue(undefined) };

    service = new PasswordAuthService(
      prisma as unknown as PrismaService,
      usersService as unknown as UsersService,
      tokensService as unknown as TokensService,
      mailService as unknown as MailService,
      emailVerification as unknown as EmailVerificationService,
    );
  });

  describe('register', () => {
    it('hashes the password, creates an unverified user, starts verification, and issues NO session', async () => {
      const user = makeUser({
        passwordHash: 'hashed:s3cret-pass',
        emailVerifiedAt: null,
      });
      usersService.findByEmail.mockResolvedValue(null);
      usersService.createLocalUser.mockResolvedValue(user);

      const result = await service.register({
        email: 'traveller@example.com',
        password: 's3cret-pass',
        name: 'Traveller',
      });

      expect(bcryptHash).toHaveBeenCalledWith(
        's3cret-pass',
        expect.any(Number),
      );
      const createCalls = usersService.createLocalUser.mock.calls as Array<
        [{ email: string; name: string; passwordHash: string }]
      >;
      const storedHash = createCalls[0][0].passwordHash;
      expect(storedHash).not.toBe('s3cret-pass');
      expect(storedHash).toBe('hashed:s3cret-pass');

      // A code is sent, but NO session is minted until it's verified.
      expect(emailVerification.start).toHaveBeenCalledWith(user);
      expect(tokensService.issueSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        verificationRequired: true,
        email: 'traveller@example.com',
      });
    });

    it('rejects re-registering an already-verified email with ConflictException', async () => {
      usersService.findByEmail.mockResolvedValue(
        makeUser({ emailVerifiedAt: new Date() }),
      );

      await expect(
        service.register({
          email: 'traveller@example.com',
          password: 's3cret-pass',
          name: 'Dupe',
        }),
      ).rejects.toThrow(ConflictException);
      expect(usersService.createLocalUser).not.toHaveBeenCalled();
      expect(usersService.updateLocalCredentials).not.toHaveBeenCalled();
      expect(emailVerification.start).not.toHaveBeenCalled();
    });

    it('lets an unverified email re-register (overwrites credentials) and re-sends a code', async () => {
      const unverified = makeUser({ id: 'user-1', emailVerifiedAt: null });
      const updated = makeUser({
        id: 'user-1',
        emailVerifiedAt: null,
        passwordHash: 'hashed:s3cret-pass',
      });
      usersService.findByEmail.mockResolvedValue(unverified);
      usersService.updateLocalCredentials.mockResolvedValue(updated);

      const result = await service.register({
        email: 'traveller@example.com',
        password: 's3cret-pass',
        name: 'Traveller',
      });

      expect(usersService.updateLocalCredentials).toHaveBeenCalledWith(
        'user-1',
        { name: 'Traveller', passwordHash: 'hashed:s3cret-pass' },
      );
      expect(usersService.createLocalUser).not.toHaveBeenCalled();
      expect(emailVerification.start).toHaveBeenCalledWith(updated);
      expect(result).toEqual({
        verificationRequired: true,
        email: 'traveller@example.com',
      });
    });
  });

  describe('login', () => {
    it('issues a session on success for a verified account', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);
      bcryptCompare.mockResolvedValue(true);

      const session = await service.login({
        email: 'traveller@example.com',
        password: 'current-secret',
      });

      expect(bcryptCompare).toHaveBeenCalledWith(
        'current-secret',
        'hashed:current-secret',
      );
      expect(tokensService.issueSession).toHaveBeenCalledWith(user);
      expect(session.accessToken).toBe('access-token');
      expect(session.refreshToken).toBe('refresh-token');
    });

    it('blocks an unverified account, sends a fresh code, and throws EMAIL_NOT_VERIFIED', async () => {
      const user = makeUser({ emailVerifiedAt: null });
      usersService.findByEmail.mockResolvedValue(user);
      bcryptCompare.mockResolvedValue(true);

      const err = await service
        .login({ email: 'traveller@example.com', password: 'current-secret' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
      });
      expect(emailVerification.start).toHaveBeenCalledWith(user);
      expect(tokensService.issueSession).not.toHaveBeenCalled();
    });

    it('throws the generic error for an unknown email', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'whatever12' }),
      ).rejects.toThrow(new UnauthorizedException(INCORRECT_CREDENTIALS));
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('throws the generic error for a Google-only (password-less) account', async () => {
      usersService.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: null }),
      );

      await expect(
        service.login({
          email: 'traveller@example.com',
          password: 'whatever12',
        }),
      ).rejects.toThrow(new UnauthorizedException(INCORRECT_CREDENTIALS));
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('throws the same generic error for a wrong password', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      bcryptCompare.mockResolvedValue(false);

      await expect(
        service.login({
          email: 'traveller@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toThrow(new UnauthorizedException(INCORRECT_CREDENTIALS));
    });
  });

  describe('forgotPassword', () => {
    it('creates a reset token and mails a real local user, returning the generic message', async () => {
      const user = makeUser();
      usersService.findByEmail.mockResolvedValue(user);

      const result = await service.forgotPassword({ email: user.email });

      expect(result.message).toBe(FORGOT_PASSWORD_MESSAGE);
      expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
      const createCalls = prisma.passwordResetToken.create.mock.calls as Array<
        [{ data: { userId: string; tokenHash: string; expiresAt: Date } }]
      >;
      const createArg = createCalls[0][0];
      expect(createArg.data.userId).toBe('user-1');
      expect(typeof createArg.data.tokenHash).toBe('string');
      expect(createArg.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(mailService.sendPasswordReset).toHaveBeenCalledWith(
        user.email,
        'https://app/reset-password?token=raw',
      );
    });

    it('returns the same message and does NOT reveal that an unknown email is unknown', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword({
        email: 'ghost@example.com',
      });

      expect(result.message).toBe(FORGOT_PASSWORD_MESSAGE);
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mailService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('does not mint a token for a Google-only account', async () => {
      usersService.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: null }),
      );

      const result = await service.forgotPassword({
        email: 'traveller@example.com',
      });

      expect(result.message).toBe(FORGOT_PASSWORD_MESSAGE);
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mailService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('returns the generic message even when token issuance fails (no existence leak)', async () => {
      usersService.findByEmail.mockResolvedValue(makeUser());
      prisma.passwordResetToken.create.mockRejectedValue(new Error('db down'));

      const result = await service.forgotPassword({
        email: 'traveller@example.com',
      });

      expect(result.message).toBe(FORGOT_PASSWORD_MESSAGE);
      expect(mailService.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown token with BadRequestException', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'nope', password: 'new-password1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an expired token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'prt-1',
        userId: 'user-1',
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.resetPassword({ token: 'raw', password: 'new-password1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an already-used token', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'prt-1',
        userId: 'user-1',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.resetPassword({ token: 'raw', password: 'new-password1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sets the new password, marks the token used, and revokes all refresh tokens', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'prt-1',
        userId: 'user-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.resetPassword({
        token: 'raw',
        password: 'new-password1',
      });

      expect(bcryptHash).toHaveBeenCalledWith(
        'new-password1',
        expect.any(Number),
      );
      // token claimed atomically (usedAt: null guard)
      const claimMatcher: Record<string, unknown> = {
        where: { id: 'prt-1', usedAt: null },
        data: { usedAt: ANY_DATE },
      };
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining(claimMatcher),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: { passwordHash: 'hashed:new-password1' },
        }),
      );
      const revokeMatcher: Record<string, unknown> = {
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: ANY_DATE },
      };
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining(revokeMatcher),
      );
      expect(result.message).toContain('reset');
    });

    it('rejects when the atomic claim loses the race (count 0)', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 'prt-1',
        userId: 'user-1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.resetPassword({ token: 'raw', password: 'new-password1' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('throws BadRequestException when the account has no password set', async () => {
      usersService.findById.mockResolvedValue(makeUser({ passwordHash: null }));

      await expect(
        service.changePassword('user-1', {
          currentPassword: 'anything10',
          newPassword: 'new-password1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(bcryptCompare).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the current password is wrong', async () => {
      usersService.findById.mockResolvedValue(makeUser());
      bcryptCompare.mockResolvedValue(false);

      await expect(
        service.changePassword('user-1', {
          currentPassword: 'wrong-current',
          newPassword: 'new-password1',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('sets the new password, revokes refresh tokens, and returns a fresh pair', async () => {
      usersService.findById.mockResolvedValue(makeUser());
      bcryptCompare.mockResolvedValue(true);

      const pair = await service.changePassword('user-1', {
        currentPassword: 'current-secret',
        newPassword: 'new-password1',
      });

      expect(bcryptCompare).toHaveBeenCalledWith(
        'current-secret',
        'hashed:current-secret',
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: { passwordHash: 'hashed:new-password1' },
        }),
      );
      const revokeMatcher: Record<string, unknown> = {
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: ANY_DATE },
      };
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining(revokeMatcher),
      );
      expect(tokensService.signAccessToken).toHaveBeenCalledWith({
        id: 'user-1',
        email: 'traveller@example.com',
      });
      expect(tokensService.issueRefreshToken).toHaveBeenCalledWith('user-1');
      expect(pair).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
    });
  });
});
