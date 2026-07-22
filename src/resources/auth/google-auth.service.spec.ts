import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAuthService } from './google-auth.service';

// Mock the OAuth2Client so no real Google verification happens. Every instance
// shares the same verifyIdToken mock, which the tests configure per-case.
const verifyIdTokenMock = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: verifyIdTokenMock,
  })),
}));

const WEB_CLIENT_ID = 'web-client-id.apps.googleusercontent.com';
const IOS_CLIENT_ID = 'ios-client-id.apps.googleusercontent.com';
const ANDROID_CLIENT_ID = 'android-client-id.apps.googleusercontent.com';

const NOT_CONFIGURED_ERROR =
  'Google Sign-In is not configured on this server — set GOOGLE_*_CLIENT_ID and restart.';
const INVALID_TOKEN_ERROR =
  'Your Google sign-in token is invalid or has expired — please try signing in again.';
const NO_VERIFIED_EMAIL_ERROR =
  'Your Google account has no verified email — verify your email with Google, then try signing in again.';

/** Builds a service whose ConfigService returns the given client id map. */
async function buildService(
  env: Record<string, string | undefined>,
): Promise<GoogleAuthService> {
  const configMock = {
    get: jest.fn((key: string) => env[key]),
  };
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      GoogleAuthService,
      { provide: ConfigService, useValue: configMock },
    ],
  }).compile();
  return moduleRef.get(GoogleAuthService);
}

/** Wraps a fake payload into a verifyIdToken ticket shape. */
function fakeTicket(payload: unknown) {
  return { getPayload: () => payload };
}

describe('GoogleAuthService', () => {
  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    (OAuth2Client as unknown as jest.Mock).mockClear();
  });

  describe('when no Google client id is configured', () => {
    it('throws ServiceUnavailableException with the not-configured message', async () => {
      const service = await buildService({});
      await expect(service.verify('any-token')).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.verify('any-token')).rejects.toThrow(
        NOT_CONFIGURED_ERROR,
      );
      expect(verifyIdTokenMock).not.toHaveBeenCalled();
    });

    it('ignores empty-string client ids (treats them as unconfigured)', async () => {
      const service = await buildService({
        GOOGLE_WEB_CLIENT_ID: '',
        GOOGLE_IOS_CLIENT_ID: '',
        GOOGLE_ANDROID_CLIENT_ID: '',
      });
      await expect(service.verify('any-token')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('when Google client ids are configured', () => {
    let service: GoogleAuthService;

    beforeEach(async () => {
      service = await buildService({
        GOOGLE_WEB_CLIENT_ID: WEB_CLIENT_ID,
        GOOGLE_IOS_CLIENT_ID: IOS_CLIENT_ID,
        GOOGLE_ANDROID_CLIENT_ID: ANDROID_CLIENT_ID,
      });
    });

    it('returns a normalized profile for a valid verified-email ticket', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-1',
          email: 'jane@example.com',
          email_verified: true,
          name: 'Jane Traveller',
          picture: 'https://cdn.example.com/jane.png',
        }),
      );

      const profile = await service.verify('valid-id-token');
      expect(profile).toEqual({
        sub: 'google-sub-1',
        email: 'jane@example.com',
        name: 'Jane Traveller',
        avatarUrl: 'https://cdn.example.com/jane.png',
      });
    });

    it('passes an audience containing all configured client ids to verifyIdToken', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-2',
          email: 'j@example.com',
          email_verified: true,
        }),
      );

      await service.verify('valid-id-token');
      expect(verifyIdTokenMock).toHaveBeenCalledTimes(1);
      const calls = verifyIdTokenMock.mock.calls as Array<
        [{ idToken: string; audience: string[] }]
      >;
      const arg = calls[0][0];
      expect(arg.idToken).toBe('valid-id-token');
      expect(arg.audience).toEqual(
        expect.arrayContaining([
          WEB_CLIENT_ID,
          IOS_CLIENT_ID,
          ANDROID_CLIENT_ID,
        ]),
      );
    });

    it('falls back to given_name then email local-part when name is absent', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-3',
          email: 'noname@example.com',
          email_verified: true,
          given_name: 'Given',
        }),
      );
      const withGiven = await service.verify('t1');
      expect(withGiven.name).toBe('Given');
      expect(withGiven.avatarUrl).toBeUndefined();

      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-4',
          email: 'localpart@example.com',
          email_verified: true,
        }),
      );
      const withEmailFallback = await service.verify('t2');
      expect(withEmailFallback.name).toBe('localpart');
    });

    it('throws UnauthorizedException when the ticket has no email', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-5',
          email_verified: true,
        }),
      );
      await expect(service.verify('t')).rejects.toThrow(UnauthorizedException);
      await expect(service.verify('t')).rejects.toThrow(
        NO_VERIFIED_EMAIL_ERROR,
      );
    });

    it('throws UnauthorizedException when email_verified is false', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          sub: 'google-sub-6',
          email: 'unverified@example.com',
          email_verified: false,
        }),
      );
      await expect(service.verify('t')).rejects.toThrow(UnauthorizedException);
      await expect(service.verify('t')).rejects.toThrow(
        NO_VERIFIED_EMAIL_ERROR,
      );
    });

    it('throws UnauthorizedException when the payload has no sub', async () => {
      verifyIdTokenMock.mockResolvedValue(
        fakeTicket({
          email: 'jane@example.com',
          email_verified: true,
        }),
      );
      await expect(service.verify('t')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when verifyIdToken rejects', async () => {
      verifyIdTokenMock.mockRejectedValue(new Error('Invalid token signature'));
      await expect(service.verify('bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.verify('bad-token')).rejects.toThrow(
        INVALID_TOKEN_ERROR,
      );
    });
  });
});
