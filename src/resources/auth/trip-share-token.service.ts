import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { DEFAULT_TRIP_SHARE_TOKEN_TTL } from '../../common/constants';
import { TripShareTokenPayload } from '../../common/types/auth.types';
import { parseDurationSeconds } from '../../common/utils/duration.util';
import { SHARE_TOKEN_SCOPE } from './constant/auth.constants';

/**
 * Trip-scoped share tokens: short-lived HS256 JWTs (separate secret from
 * access tokens) that let a trusted contact open a trip's live view without
 * an account. Scope-checked so an access token can never double as a share
 * link and vice versa.
 */
@Injectable()
export class TripShareTokenService {
  private readonly secret: string;
  private readonly ttlS: number;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('TRIP_SHARE_TOKEN_SECRET');
    this.ttlS = parseDurationSeconds(
      config.get<string>('TRIP_SHARE_TOKEN_TTL') ??
        DEFAULT_TRIP_SHARE_TOKEN_TTL,
      'TRIP_SHARE_TOKEN_TTL',
    );
  }

  /**
   * @param version the trip's current share_token_version — embedded so the
   * live view can reject links minted before the owner last reissued.
   */
  issue(tripId: string, version: number): { token: string; expiresAt: Date } {
    const token = jwt.sign(
      { tripId, scope: SHARE_TOKEN_SCOPE, v: version },
      this.secret,
      { algorithm: 'HS256', expiresIn: this.ttlS },
    );
    return { token, expiresAt: new Date(Date.now() + this.ttlS * 1000) };
  }

  verify(token: string): TripShareTokenPayload {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException(
        'This share link is invalid or has expired — ask for a new link.',
      );
    }
    if (
      typeof decoded === 'string' ||
      decoded.scope !== SHARE_TOKEN_SCOPE ||
      typeof decoded.tripId !== 'string' ||
      typeof decoded.v !== 'number'
    ) {
      throw new UnauthorizedException(
        'This share link is invalid or has expired — ask for a new link.',
      );
    }
    return {
      tripId: decoded.tripId,
      scope: SHARE_TOKEN_SCOPE,
      v: decoded.v,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  }
}
