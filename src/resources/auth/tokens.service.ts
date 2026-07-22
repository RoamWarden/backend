import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'node:crypto';
import {
  DEFAULT_JWT_ACCESS_TTL,
  DEFAULT_JWT_REFRESH_TTL,
} from '../../common/constants';
import { AccessTokenPayload } from '../../common/types/auth.types';
import { parseDurationSeconds } from '../../common/utils/duration.util';
import { PrismaService } from '../../prisma/prisma.service';
import { REFRESH_TOKEN_BYTES } from './constant/auth.constants';

/**
 * Access tokens: short-lived HS256 JWTs. Refresh tokens: opaque 48-byte
 * base64url secrets stored as sha256 hex, rotated on every use with reuse
 * detection — replaying a revoked token nukes every session for that user
 * (build plan §10).
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlS: number;
  private readonly refreshTtlS: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    // Keys the HMAC used to store refresh tokens, so a leaked DB dump of
    // token_hash cannot be reversed or correlated without the server secret.
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtlS = parseDurationSeconds(
      config.get<string>('JWT_ACCESS_TTL') ?? DEFAULT_JWT_ACCESS_TTL,
      'JWT_ACCESS_TTL',
    );
    this.refreshTtlS = parseDurationSeconds(
      config.get<string>('JWT_REFRESH_TTL') ?? DEFAULT_JWT_REFRESH_TTL,
      'JWT_REFRESH_TTL',
    );
  }

  signAccessToken(user: { id: string; email: string }): string {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      this.accessSecret,
      { algorithm: 'HS256', expiresIn: this.accessTtlS },
    );
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.accessSecret, { algorithms: ['HS256'] });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException(
          'Your session has expired — refresh your token or sign in again.',
        );
      }
      throw new UnauthorizedException(
        'Your session token is invalid — please sign in again.',
      );
    }
    if (
      typeof decoded === 'string' ||
      decoded.type !== 'access' ||
      typeof decoded.sub !== 'string' ||
      typeof decoded.email !== 'string'
    ) {
      throw new UnauthorizedException(
        'Your session token is invalid — please sign in again.',
      );
    }
    return {
      sub: decoded.sub,
      email: decoded.email,
      type: 'access',
      iat: decoded.iat,
      exp: decoded.exp,
    };
  }

  async issueRefreshToken(
    userId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlS * 1000);
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: this.hash(token), expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Rotates a refresh token: revokes the presented one and issues a fresh
   * access + refresh pair. Reuse of an already-revoked token is treated as
   * theft — every session for that user is revoked.
   */
  async rotateRefreshToken(rawToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string };
  }> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!record) {
      throw new UnauthorizedException(
        'This session is no longer valid — please sign in again.',
      );
    }

    if (record.revokedAt) {
      // Reuse of a rotated-out token: assume the token leaked and revoke everything.
      const { count } = await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${record.userId} (token ${record.id}) — revoked ${count} active session(s).`,
      );
      throw new UnauthorizedException(
        'This session is no longer valid — please sign in again.',
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(
        'Your session has expired — please sign in again.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      throw new UnauthorizedException(
        'This account no longer exists — please sign in again.',
      );
    }

    const newToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const newExpiresAt = new Date(Date.now() + this.refreshTtlS * 1000);
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Atomically claim the presented token. The conditional updateMany is a
      // single UPDATE that only ONE concurrent rotation can satisfy (row lock
      // under READ COMMITTED), closing the check-then-revoke race — the loser
      // sees count 0 and is handled as reuse below.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) {
        return null;
      }
      const created = await tx.refreshToken.create({
        data: {
          userId: record.userId,
          tokenHash: this.hash(newToken),
          expiresAt: newExpiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: record.id },
        data: { replacedByTokenId: created.id },
      });
      return created;
    });

    if (!rotated) {
      // Lost the atomic claim — the same token was rotated concurrently, i.e.
      // presented twice. Treat as theft and revoke every active session.
      const { count } = await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Concurrent refresh-token reuse detected for user ${record.userId} (token ${record.id}) — revoked ${count} active session(s).`,
      );
      throw new UnauthorizedException(
        'This session is no longer valid — please sign in again.',
      );
    }

    return {
      accessToken: this.signAccessToken({ id: user.id, email: user.email }),
      refreshToken: newToken,
      user: { id: user.id, email: user.email },
    };
  }

  /** Revokes the presented refresh token. Idempotent — unknown tokens are a no-op. */
  async revokeRefreshToken(rawToken: string): Promise<void> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      this.logger.debug(
        'Logout with an unknown or already-revoked refresh token — nothing to do.',
      );
    }
  }

  private hash(rawToken: string): string {
    return createHmac('sha256', this.refreshSecret)
      .update(rawToken)
      .digest('hex');
  }
}
