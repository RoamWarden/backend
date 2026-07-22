import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import {
  PASSWORD_BCRYPT_ROUNDS,
  PASSWORD_RESET_TTL_S,
} from '../../common/constants';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../providers/mail/mail.service';
import { UsersService } from '../user/users.service';
import { PASSWORD_RESET_TOKEN_BYTES } from './constant/auth.constants';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { ForgotPasswordDto } from './dto/forgot-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import { TokensService } from './tokens.service';
import type { AuthSession, AuthTokenPair } from './type/auth.types';

/**
 * Email/password authentication. Passwords are bcrypt-hashed; reset tokens are
 * single-use, expiring, and stored only as a sha256 hash (build plan §10).
 * Auth responses never reveal whether an email exists or how an account signs
 * in — login and forgot-password give identical answers regardless.
 */
@Injectable()
export class PasswordAuthService {
  private readonly logger = new Logger(PasswordAuthService.name);
  private readonly forgotPasswordMessage =
    'If an account with that email exists, a password reset link has been sent.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly tokensService: TokensService,
    private readonly mailService: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthSession> {
    const passwordHash = await bcrypt.hash(
      dto.password,
      PASSWORD_BCRYPT_ROUNDS,
    );
    const user = await this.usersService.createLocalUser({
      email: dto.email,
      name: dto.name,
      passwordHash,
    });

    // Best-effort welcome email. MailService never throws, but guard anyway so
    // an unexpected rejection can never fail registration. Not awaited-to-throw.
    void this.mailService
      .sendWelcome(user.email, user.name)
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to send welcome email to ${user.email}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return this.issueSession(user);
  }

  async login(dto: LoginDto): Promise<AuthSession> {
    const user = await this.usersService.findByEmail(dto.email);
    // Generic failure for every branch — never reveal whether the email exists
    // or that it is a Google-only account.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Incorrect email or password.');
    }
    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Incorrect email or password.');
    }
    return this.issueSession(user);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(dto.email);
    // Only mint a token for accounts that actually have a password. Google-only
    // accounts and unknown emails resolve identically (no existence leak).
    if (user && user.passwordHash) {
      try {
        const rawToken = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString(
          'base64url',
        );
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_S * 1000);
        await this.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: this.hashToken(rawToken),
            expiresAt,
          },
        });
        const resetUrl = this.mailService.buildResetUrl(rawToken);
        await this.mailService.sendPasswordReset(user.email, resetUrl);
      } catch (error) {
        // Never surface internal failures here — that would leak that the email
        // exists. Log and still return the generic message.
        this.logger.error(
          `Failed to issue password-reset token for user ${user.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return { message: this.forgotPasswordMessage };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(dto.token) },
    });
    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException(
        'This password reset link is invalid or has expired — request a new one.',
      );
    }

    const passwordHash = await bcrypt.hash(
      dto.password,
      PASSWORD_BCRYPT_ROUNDS,
    );
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Atomically claim the token: only one concurrent reset can flip usedAt
      // from null, so a double-submit can't reset twice.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          'This password reset link is invalid or has expired — request a new one.',
        );
      }
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      // Invalidate every existing session — a reset should log out all devices.
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    return {
      message: 'Your password has been reset — sign in with your new password.',
    };
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<AuthTokenPair> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException(
        'Your account could not be found — please sign in again.',
      );
    }
    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account has no password set. Use the password reset flow to add one.',
      );
    }
    const matches = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!matches) {
      throw new UnauthorizedException('Your current password is incorrect.');
    }

    const passwordHash = await bcrypt.hash(
      dto.newPassword,
      PASSWORD_BCRYPT_ROUNDS,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    // Issue a fresh pair so the current session survives the mass revocation.
    const accessToken = this.tokensService.signAccessToken({
      id: user.id,
      email: user.email,
    });
    const { token: refreshToken } = await this.tokensService.issueRefreshToken(
      user.id,
    );
    return { accessToken, refreshToken };
  }

  private async issueSession(user: User): Promise<AuthSession> {
    const accessToken = this.tokensService.signAccessToken({
      id: user.id,
      email: user.email,
    });
    const { token: refreshToken } = await this.tokensService.issueRefreshToken(
      user.id,
    );
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        reputation: user.reputation,
      },
    };
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
