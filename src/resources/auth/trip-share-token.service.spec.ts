import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { TripShareTokenService } from './trip-share-token.service';
import { SHARE_TOKEN_SCOPE } from './constant/auth.constants';

const SHARE_SECRET = 'share-secret-under-test';
const OTHER_SECRET = 'a-totally-different-secret';
const SHARE_LINK_ERROR =
  'This share link is invalid or has expired — ask for a new link.';

describe('TripShareTokenService', () => {
  let service: TripShareTokenService;
  let configMock: { getOrThrow: jest.Mock; get: jest.Mock };

  beforeEach(async () => {
    configMock = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'TRIP_SHARE_TOKEN_SECRET') return SHARE_SECRET;
        throw new Error(`unexpected getOrThrow(${key})`);
      }),
      // Force the default TTL branch (returns undefined for TRIP_SHARE_TOKEN_TTL).
      get: jest.fn(() => undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TripShareTokenService,
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = moduleRef.get(TripShareTokenService);
  });

  describe('issue', () => {
    it('round-trips a payload via verify with tripId, scope and version', () => {
      const { token, expiresAt } = service.issue('trip-123', 7);
      expect(typeof token).toBe('string');
      expect(expiresAt).toBeInstanceOf(Date);

      const payload = service.verify(token);
      expect(payload.tripId).toBe('trip-123');
      expect(payload.scope).toBe('trip:live');
      expect(payload.scope).toBe(SHARE_TOKEN_SCOPE);
      expect(payload.v).toBe(7);
      expect(typeof payload.iat).toBe('number');
      expect(typeof payload.exp).toBe('number');
    });

    it('embeds the trip version in the raw JWT payload', () => {
      const { token } = service.issue('trip-abc', 42);
      const raw = jwt.decode(token) as jwt.JwtPayload;
      expect(raw.tripId).toBe('trip-abc');
      expect(raw.scope).toBe(SHARE_TOKEN_SCOPE);
      expect(raw.v).toBe(42);
    });

    it('sets expiresAt to now + the default 24h TTL', () => {
      const before = Date.now();
      const { expiresAt } = service.issue('trip-xyz', 1);
      const twentyFourHoursMs = 24 * 3600 * 1000;
      // Allow a little slack for execution time.
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + twentyFourHoursMs - 1000,
      );
      expect(expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + twentyFourHoursMs + 1000,
      );
    });
  });

  describe('verify', () => {
    it('throws UnauthorizedException with the share-link message on garbage', () => {
      expect(() => service.verify('not-a-jwt')).toThrow(UnauthorizedException);
      expect(() => service.verify('not-a-jwt')).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects a token signed with a different secret', () => {
      const forged = jwt.sign(
        { tripId: 'trip-123', scope: SHARE_TOKEN_SCOPE, v: 1 },
        OTHER_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => service.verify(forged)).toThrow(UnauthorizedException);
      expect(() => service.verify(forged)).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects an access-token-shaped token (wrong scope)', () => {
      // Signed with the correct secret but carrying an access-token payload
      // instead of the share scope — must not double as a share link.
      const accessShaped = jwt.sign(
        { sub: 'user-1', email: 'a@b.com', type: 'access' },
        SHARE_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => service.verify(accessShaped)).toThrow(UnauthorizedException);
      expect(() => service.verify(accessShaped)).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects a share-scoped token whose version is missing', () => {
      const noVersion = jwt.sign(
        { tripId: 'trip-123', scope: SHARE_TOKEN_SCOPE },
        SHARE_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => service.verify(noVersion)).toThrow(UnauthorizedException);
      expect(() => service.verify(noVersion)).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects a share-scoped token whose version is not a number', () => {
      const stringVersion = jwt.sign(
        { tripId: 'trip-123', scope: SHARE_TOKEN_SCOPE, v: '3' },
        SHARE_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => service.verify(stringVersion)).toThrow(
        UnauthorizedException,
      );
      expect(() => service.verify(stringVersion)).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects a token where tripId is missing', () => {
      const noTrip = jwt.sign(
        { scope: SHARE_TOKEN_SCOPE, v: 1 },
        SHARE_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 },
      );
      expect(() => service.verify(noTrip)).toThrow(UnauthorizedException);
      expect(() => service.verify(noTrip)).toThrow(SHARE_LINK_ERROR);
    });

    it('rejects an expired but otherwise valid share token', () => {
      const expired = jwt.sign(
        { tripId: 'trip-123', scope: SHARE_TOKEN_SCOPE, v: 1 },
        SHARE_SECRET,
        { algorithm: 'HS256', expiresIn: -10 },
      );
      expect(() => service.verify(expired)).toThrow(UnauthorizedException);
      expect(() => service.verify(expired)).toThrow(SHARE_LINK_ERROR);
    });
  });
});
