import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'node:crypto';
import { HANDOFF_TOKEN_TTL_S } from '../../common/constants';
import { keyHandoffToken } from '../../providers/redis/constant/redis.constants';
import { RedisService } from '../../providers/redis/redis.service';
import { UsersService } from '../user/users.service';
import { HANDOFF_TOKEN_BYTES } from './constant/auth.constants';
import { TokensService } from './tokens.service';
import type { AuthSession, HandoffToken } from './type/auth.types';

/**
 * App → web account hand-off (build plan §20). The mobile app never sells
 * anything in-app: it opens the web account area in a browser. To get the
 * already-signed-in user into a web session WITHOUT putting its own access or
 * refresh token in a URL (URLs leak into history, proxy logs and referrers),
 * the app asks for a hand-off token and the web page exchanges it for a normal
 * session.
 *
 * Defences, all deliberate:
 * - 48 random bytes — it buys a full session, so it must be as unguessable as a
 *   refresh token.
 * - Stored ONLY as a keyed (HMAC-SHA256) hash, mirroring refresh tokens and OTP
 *   codes: a Redis dump cannot be replayed.
 * - Lives in Redis under a 5-minute TTL, so expiry is enforced by the store
 *   itself and nothing lingers.
 * - Redeemed through an ATOMIC claim (single Lua GET+DEL), so a double-submit or
 *   two racing tabs can never both redeem the same token.
 * - Redis failures fail CLOSED with a clear message — never a silent success.
 */
@Injectable()
export class HandoffTokenService {
  private readonly logger = new Logger(HandoffTokenService.name);
  private readonly handoffSecret: string;

  private readonly invalidTokenMessage =
    'This account link is invalid, has expired, or has already been used — open your account from the app again.';
  private readonly storeFailedMessage =
    "We couldn't start the secure hand-off to your account page. Please try again in a moment.";
  private readonly claimFailedMessage =
    "We couldn't verify your account link right now. Please try again in a moment.";

  constructor(
    private readonly redis: RedisService,
    private readonly tokensService: TokensService,
    private readonly usersService: UsersService,
    config: ConfigService,
  ) {
    // Reuse the refresh-token secret to key the hand-off HMAC — no new env var
    // to configure, and it never leaves the server.
    this.handoffSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  /**
   * Mints a short-lived, single-use hand-off token for an ALREADY-authenticated
   * user. The raw token is returned to the caller once and never persisted.
   */
  async issue(userId: string): Promise<HandoffToken> {
    const token = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + HANDOFF_TOKEN_TTL_S * 1000);

    try {
      await this.redis.setWithTtl(
        keyHandoffToken(this.hash(token)),
        userId,
        HANDOFF_TOKEN_TTL_S,
      );
    } catch (error) {
      // Never hand back a token we failed to store — it could never be redeemed.
      this.logger.error(
        `Failed to store hand-off token for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(this.storeFailedMessage);
    }

    return { token, expiresAt };
  }

  /**
   * Exchanges a hand-off token for a normal session, exactly like login does,
   * and burns the token so it can never be replayed.
   */
  async exchange(rawToken: string): Promise<AuthSession> {
    let userId: string | null;
    try {
      // Atomic GET+DEL: the winner of a race gets the userId, everyone else gets
      // null. This single call is what makes the token single-use.
      userId = await this.redis.claimOnce(keyHandoffToken(this.hash(rawToken)));
    } catch (error) {
      // Fail CLOSED: if we cannot prove the token was valid AND unused, no session.
      this.logger.error(
        'Failed to claim a hand-off token (Redis unavailable)',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(this.claimFailedMessage);
    }

    if (!userId) {
      // Unknown, expired, or already redeemed — one uniform message, so this
      // endpoint can't be used to probe which tokens once existed.
      throw new UnauthorizedException(this.invalidTokenMessage);
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      // Account deleted between mint and redeem. The token is already burned.
      this.logger.warn(
        `Hand-off token redeemed for missing user ${userId} — treating as invalid.`,
      );
      throw new UnauthorizedException(this.invalidTokenMessage);
    }

    return this.tokensService.issueSession(user);
  }

  /** Keyed hash, so a leaked Redis dump cannot be replayed as a token. */
  private hash(rawToken: string): string {
    return createHmac('sha256', this.handoffSecret)
      .update(`handoff:${rawToken}`)
      .digest('hex');
  }
}
