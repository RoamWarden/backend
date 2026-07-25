import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../user/users.service';
import { AuthController } from './auth.controller';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { EmailVerificationService } from './email-verification.service';
import { GoogleAuthService } from './google-auth.service';
import { HandoffTokenService } from './handoff-token.service';
import { PasswordAuthService } from './password-auth.service';
import { TokensService } from './tokens.service';
import type { GoogleProfile } from './type/auth.types';

/**
 * The Google endpoint's wiring: the login-only flag must reach UsersService
 * untouched, and the DTO must survive the GLOBAL pipe settings from main.ts.
 */
describe('AuthController — POST /auth/google', () => {
  let controller: AuthController;
  let googleAuthService: { verify: jest.Mock };
  let usersService: { upsertFromGoogle: jest.Mock };
  let tokensService: { issueSession: jest.Mock };

  const profile: GoogleProfile = {
    sub: 'sub-123',
    email: 'ada@b.com',
    name: 'Ada',
    emailVerified: true,
  };
  const user = { id: 'u1', email: 'ada@b.com' };
  const session = {
    accessToken: 'access',
    refreshToken: 'refresh',
    user: {
      id: 'u1',
      email: 'ada@b.com',
      name: 'Ada',
      avatarUrl: null,
      reputation: 0,
    },
  };

  beforeEach(async () => {
    googleAuthService = { verify: jest.fn().mockResolvedValue(profile) };
    usersService = { upsertFromGoogle: jest.fn().mockResolvedValue(user) };
    tokensService = { issueSession: jest.fn().mockResolvedValue(session) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: GoogleAuthService, useValue: googleAuthService },
        { provide: TokensService, useValue: tokensService },
        { provide: UsersService, useValue: usersService },
        { provide: PasswordAuthService, useValue: {} },
        { provide: EmailVerificationService, useValue: {} },
        { provide: HandoffTokenService, useValue: {} },
      ],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  it('signs in and forwards no flag when the app sends only idToken', async () => {
    const dto = new GoogleAuthDto();
    dto.idToken = 'app-token';

    await expect(controller.google(dto)).resolves.toBe(session);

    expect(googleAuthService.verify).toHaveBeenCalledWith('app-token');
    // The default lives in UsersService (undefined → allowed), so the app keeps
    // creating an account on first sign-in without sending anything new.
    expect(usersService.upsertFromGoogle).toHaveBeenCalledWith(profile, {
      allowSignup: undefined,
    });
    expect(tokensService.issueSession).toHaveBeenCalledWith(user);
  });

  it('forwards allowSignup:false verbatim for the website', async () => {
    const dto = new GoogleAuthDto();
    dto.idToken = 'web-token';
    dto.allowSignup = false;

    await controller.google(dto);

    expect(usersService.upsertFromGoogle).toHaveBeenCalledWith(profile, {
      allowSignup: false,
    });
  });

  it('never issues a session when the identity has no account', async () => {
    const noAccount = new Error('NO_ACCOUNT');
    usersService.upsertFromGoogle.mockRejectedValue(noAccount);
    const dto = new GoogleAuthDto();
    dto.idToken = 'web-token';
    dto.allowSignup = false;

    await expect(controller.google(dto)).rejects.toBe(noAccount);
    expect(tokensService.issueSession).not.toHaveBeenCalled();
  });

  // ── DTO under the real global pipe (main.ts settings, verbatim) ───────────

  describe('GoogleAuthDto validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });
    const meta: ArgumentMetadata = { type: 'body', metatype: GoogleAuthDto };
    const run = (body: unknown): Promise<GoogleAuthDto> =>
      pipe.transform(body, meta) as Promise<GoogleAuthDto>;

    it('leaves allowSignup undefined when the app omits it', async () => {
      const dto = await run({ idToken: 'app-token' });
      expect(dto.allowSignup).toBeUndefined();
    });

    it('accepts real JSON booleans', async () => {
      await expect(run({ idToken: 't', allowSignup: false })).resolves.toEqual({
        idToken: 't',
        allowSignup: false,
      });
      await expect(run({ idToken: 't', allowSignup: true })).resolves.toEqual({
        idToken: 't',
        allowSignup: true,
      });
    });

    it('rejects the STRING "false" instead of silently allowing sign-up', async () => {
      // enableImplicitConversion would coerce 'false' to Boolean('false') === true
      // and quietly re-enable account creation. Fail loud, never open.
      await expect(run({ idToken: 't', allowSignup: 'false' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(run({ idToken: 't', allowSignup: 0 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an explicit null rather than falling back to "allowed"', async () => {
      // Only an ABSENT field means "app default". A sent-but-malformed one is a
      // client bug the caller must see, not a silent licence to create accounts.
      await expect(run({ idToken: 't', allowSignup: null })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('explains a bad allowSignup in a human sentence', async () => {
      const err = await run({ idToken: 't', allowSignup: 'nope' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(response.message.join(' ')).toContain(
        'allowSignup must be a JSON boolean',
      );
    });
  });
});
