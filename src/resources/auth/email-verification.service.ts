import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { createHmac, randomInt } from 'node:crypto';
import {
  EMAIL_OTP_LENGTH,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_MAX_SENDS_PER_WINDOW,
  EMAIL_OTP_RESEND_COOLDOWN_S,
  EMAIL_OTP_SEND_WINDOW_S,
  EMAIL_OTP_TTL_S,
} from '../../common/constants';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import { RedisService } from '../../providers/redis/redis.service';
import { normalizeEmail } from '../../common/transforms/normalize-email';
import { UsersService } from '../user/users.service';
import { TokensService } from './tokens.service';
import type { ResendVerificationDto } from './dto/resend-verification.dto';
import type { VerifyEmailDto } from './dto/verify-email.dto';
import type { AuthSession } from './type/auth.types';

/**
 * Email-verification via a 6-digit OTP. Codes are stored ONLY as a keyed
 * (HMAC-SHA256) hash — the 10^6 keyspace is brute-forceable under a plain hash,
 * so we key it with a server secret and namespace it per user. Codes are
 * single-use, short-lived, and attempt-limited (the cap is enforced ATOMICALLY
 * so concurrent guesses can't slip past it). No response reveals whether an
 * email exists or is verified — verify and resend give uniform answers.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly otpSecret: string;

  private readonly invalidCodeMessage =
    'That verification code is invalid or has expired — request a new one.';
  private readonly tooManyAttemptsMessage =
    'Too many incorrect attempts — request a new code.';
  private readonly resendMessage =
    "If your email still needs verifying, we've sent a new code.";
  private readonly mailFailedMessage =
    "We couldn't send your verification email. Please try again in a moment.";

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly tokensService: TokensService,
    private readonly mailService: MailService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    // Reuse the refresh-token secret to key the OTP HMAC — no new env var to
    // configure, and it never leaves the server.
    this.otpSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  /**
   * Issues a fresh code and emails it. `force` (register) always sends; without
   * it (resend / unverified login) a send inside the cooldown window is skipped
   * silently to prevent email-bombing. Throws only if a real send fails.
   */
  async start(user: User, options?: { force?: boolean }): Promise<void> {
    if (!options?.force) {
      // Only a still-LIVE code (unconsumed + unexpired) counts toward the
      // cooldown — a code burned by too-many-attempts or one that has expired
      // must never suppress a genuinely-needed resend.
      const recent = await this.prisma.emailVerificationOtp.findFirst({
        where: {
          userId: user.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (
        recent &&
        Date.now() - recent.createdAt.getTime() <
          EMAIL_OTP_RESEND_COOLDOWN_S * 1000
      ) {
        return; // within cooldown — do not send another code
      }
    }

    // Per-email hourly send quota (cross-IP anti email-bomb — per-IP throttling
    // can't stop a distributed sender targeting one address). Fail-open if Redis
    // is down; the DB cooldown above still limits rapid sends.
    if (!(await this.withinSendQuota(user.email))) {
      return;
    }

    // One live code at a time: retire any outstanding ones for this user.
    await this.prisma.emailVerificationOtp.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const code = this.generateCode();
    await this.prisma.emailVerificationOtp.create({
      data: {
        userId: user.id,
        codeHash: this.hashCode(user.id, code),
        expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_S * 1000),
      },
    });

    try {
      await this.mailService.sendVerificationCode(user.email, code);
    } catch (error) {
      this.logger.error(
        `Failed to send verification code to ${user.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(this.mailFailedMessage);
    }
  }

  /** Verifies a submitted code and, on success, marks the email verified and issues a session. */
  async verify(dto: VerifyEmailDto): Promise<AuthSession> {
    const user = await this.usersService.findByEmail(dto.email);
    // Uniform response for unknown / already-verified / bad-code so this endpoint
    // can't be used to enumerate which emails are registered or verified.
    if (!user || user.emailVerifiedAt) {
      throw new BadRequestException(this.invalidCodeMessage);
    }

    const record = await this.prisma.emailVerificationOtp.findFirst({
      where: { userId: user.id, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(this.invalidCodeMessage);
    }

    // Count this guess AND enforce the cap in ONE atomic statement: only a row
    // still under the cap is incremented, so a burst of concurrent guesses can't
    // slip past EMAIL_OTP_MAX_ATTEMPTS against a single live code (the check-
    // then-act on a stale attemptCount read would otherwise defeat the cap).
    const counted = await this.prisma.emailVerificationOtp.updateMany({
      where: {
        id: record.id,
        consumedAt: null,
        attemptCount: { lt: EMAIL_OTP_MAX_ATTEMPTS },
      },
      data: { attemptCount: { increment: 1 } },
    });
    if (counted.count === 0) {
      // At the cap (or consumed by a concurrent verify) — burn it.
      await this.prisma.emailVerificationOtp.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException(this.tooManyAttemptsMessage);
    }

    if (this.hashCode(user.id, dto.code) !== record.codeHash) {
      throw new BadRequestException(this.invalidCodeMessage);
    }

    const now = new Date();
    const claimed = await this.prisma.$transaction(async (tx) => {
      // Atomically claim the code: only one concurrent verify can flip
      // consumedAt from null, so a double-submit can't verify twice.
      const claim = await tx.emailVerificationOtp.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (claim.count === 0) {
        return false;
      }
      await tx.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: now },
      });
      return true;
    });
    if (!claimed) {
      throw new BadRequestException(this.invalidCodeMessage);
    }

    // Now that the account is live, send the welcome email best-effort.
    void this.mailService
      .sendWelcome(user.email, user.name)
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send welcome email to ${user.email}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.tokensService.issueSession(user);
  }

  /** Sends a fresh code for an unverified account. Neutral — never leaks existence. */
  async resend(dto: ResendVerificationDto): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(dto.email);
    if (user && user.passwordHash && !user.emailVerifiedAt) {
      try {
        await this.start(user);
      } catch (error) {
        // Never surface internal failures here — that would leak existence.
        this.logger.error(
          `Failed to resend verification code for user ${user.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return { message: this.resendMessage };
  }

  /**
   * Per-email send quota check (increments the window counter). Fail-open: a
   * null count means Redis is unavailable, so we allow the send rather than
   * block legitimate sign-ups (the DB cooldown still bounds abuse).
   */
  private async withinSendQuota(email: string): Promise<boolean> {
    const key = `otp:send-quota:${normalizeEmail(email)}`;
    const count = await this.redis.incrementCounter(
      key,
      EMAIL_OTP_SEND_WINDOW_S,
    );
    return count === null || count <= EMAIL_OTP_MAX_SENDS_PER_WINDOW;
  }

  /** Cryptographically-random zero-padded code, e.g. "004217". */
  private generateCode(): string {
    const max = 10 ** EMAIL_OTP_LENGTH;
    return randomInt(0, max).toString().padStart(EMAIL_OTP_LENGTH, '0');
  }

  /** Keyed, per-user hash so a DB dump can't be reversed or correlated. */
  private hashCode(userId: string, code: string): string {
    return createHmac('sha256', this.otpSecret)
      .update(`email-otp:${userId}:${code}`)
      .digest('hex');
  }
}
