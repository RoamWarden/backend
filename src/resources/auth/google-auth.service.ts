import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import type { GoogleProfile } from './type/auth.types';

/**
 * Verifies Google Sign-In ID tokens against every configured client id
 * (web / iOS / Android). If none is configured the feature degrades to a
 * clear 503 instead of a cryptic verification failure.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly client = new OAuth2Client();
  private readonly audiences: string[];

  constructor(config: ConfigService) {
    this.audiences = [
      config.get<string>('GOOGLE_WEB_CLIENT_ID'),
      config.get<string>('GOOGLE_IOS_CLIENT_ID'),
      config.get<string>('GOOGLE_ANDROID_CLIENT_ID'),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (this.audiences.length === 0) {
      this.logger.warn(
        'No Google client id configured (GOOGLE_WEB_CLIENT_ID / GOOGLE_IOS_CLIENT_ID / GOOGLE_ANDROID_CLIENT_ID) — Google Sign-In will return 503 until one is set.',
      );
    }
  }

  /** Verifies the ID token and returns the profile needed to upsert a user. */
  async verify(idToken: string): Promise<GoogleProfile> {
    if (this.audiences.length === 0) {
      throw new ServiceUnavailableException(
        'Google Sign-In is not configured on this server — set GOOGLE_*_CLIENT_ID and restart.',
      );
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audiences,
      });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(
        `Google ID token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException(
        'Your Google sign-in token is invalid or has expired — please try signing in again.',
      );
    }

    if (!payload || !payload.sub) {
      throw new UnauthorizedException(
        'Google returned an unusable sign-in token — please try signing in again.',
      );
    }
    if (!payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException(
        'Your Google account has no verified email — verify your email with Google, then try signing in again.',
      );
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.given_name ?? payload.email.split('@')[0],
      avatarUrl: payload.picture ?? undefined,
    };
  }
}
