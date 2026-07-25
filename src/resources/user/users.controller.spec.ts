import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CONTACT_LOOKUP_MAX_PER_WINDOW,
  CONTACT_LOOKUP_WINDOW_S,
} from './constant/users.constants';
import { LookupContactUserDto } from './dto/lookup-contact-user.dto';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type { ContactUserLookupResult } from './type/users.types';

/**
 * @nestjs/throttler's metadata keys are internal to the package (not re-exported
 * from its index), so we assert against the literal keys it writes. They are
 * part of v6's on-disk contract — if a future bump renames them this test fails
 * loudly, which is exactly what we want for a rate limit that guards an
 * enumeration surface.
 */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

describe('UsersController — POST /me/contacts/lookup', () => {
  let controller: UsersController;
  let usersService: { lookupContactUserByEmail: jest.Mock };

  const found: ContactUserLookupResult = {
    found: true,
    user: { id: 'friend', name: 'Ada Lovelace', avatarUrl: null },
    alreadyAdded: false,
    existingContactId: null,
    message: 'Ada Lovelace is on RoamWarden.',
  };

  beforeEach(async () => {
    usersService = {
      lookupContactUserByEmail: jest.fn().mockResolvedValue(found),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = moduleRef.get(UsersController);
  });

  it('passes the authenticated caller and the email to the service', async () => {
    const dto = new LookupContactUserDto();
    dto.email = 'ada@example.com';

    await expect(
      controller.lookupContactUser({ id: 'u1', email: 'me@example.com' }, dto),
    ).resolves.toBe(found);

    // The caller comes from the JWT, never from the body — nobody can look up
    // "on behalf of" someone else and spend their budget.
    expect(usersService.lookupContactUserByEmail).toHaveBeenCalledWith(
      'u1',
      'ada@example.com',
    );
  });

  // ── rate limit ───────────────────────────────────────────────────────────

  describe('throttling', () => {
    /* eslint-disable @typescript-eslint/unbound-method --
       These handlers are only ever read as decorator-metadata targets, never
       called, so there is no `this` to lose. */
    const lookupHandler: object = UsersController.prototype.lookupContactUser;
    const createHandler: object = UsersController.prototype.createContact;
    /* eslint-enable @typescript-eslint/unbound-method */

    it('carries a per-route budget of 20 per hour', () => {
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'default', lookupHandler),
      ).toBe(CONTACT_LOOKUP_MAX_PER_WINDOW);
      expect(
        Reflect.getMetadata(THROTTLER_TTL + 'default', lookupHandler),
      ).toBe(CONTACT_LOOKUP_WINDOW_S * 1000);
    });

    it('is stricter than the strictest auth route and the global default', () => {
      const perHour = (limit: number, ttlMs: number): number =>
        limit / (ttlMs / 3_600_000);
      const lookup = perHour(
        CONTACT_LOOKUP_MAX_PER_WINDOW,
        CONTACT_LOOKUP_WINDOW_S * 1000,
      );
      // POST /auth/verify-email/resend — the tightest auth budget (5/15 min).
      expect(lookup).toBeLessThanOrEqual(perHour(5, 900_000));
      // Global default from app.module.ts (100/min).
      expect(lookup).toBeLessThan(perHour(100, 60_000));
    });

    it('does not throttle the other contact routes into uselessness', () => {
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'default', createHandler),
      ).toBeUndefined();
    });
  });

  // ── DTO under the real global pipe (main.ts settings, verbatim) ───────────

  describe('LookupContactUserDto validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });
    const meta: ArgumentMetadata = {
      type: 'body',
      metatype: LookupContactUserDto,
    };
    const run = (body: unknown): Promise<LookupContactUserDto> =>
      pipe.transform(body, meta) as Promise<LookupContactUserDto>;

    /**
     * The human copy lives in the 400 BODY (`message: string[]`), not in
     * `error.message` — which Nest fills with the generic "Bad Request
     * Exception". Assert on what the app actually receives.
     */
    const rejectionMessages = async (body: unknown): Promise<string> => {
      try {
        await run(body);
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse();
        const { message } = response as { message: string[] | string };
        return Array.isArray(message) ? message.join(' | ') : message;
      }
      throw new Error('expected the body to be rejected, but it passed');
    };

    it('normalises case and whitespace before the service ever sees it', async () => {
      await expect(run({ email: '  AdA@Example.COM  ' })).resolves.toEqual({
        email: 'ada@example.com',
      });
    });

    it('rejects a non-email with a message a human can act on', async () => {
      await expect(rejectionMessages({ email: 'ada' })).resolves.toMatch(
        /full address they signed up with/,
      );
    });

    it('rejects a missing email', async () => {
      await expect(rejectionMessages({})).resolves.toMatch(
        /email address|too long/i,
      );
    });

    it('rejects an absurdly long address', async () => {
      const email = `${'a'.repeat(320)}@example.com`;
      await expect(rejectionMessages({ email })).resolves.toMatch(/too long/);
    });

    it('accepts NO search field other than email (no wildcard/prefix search)', async () => {
      // whitelist + forbidNonWhitelisted means a "q" or "name" parameter is a
      // 400, so this can never quietly grow into a directory search.
      await expect(
        rejectionMessages({ email: 'ada@example.com', q: 'ada' }),
      ).resolves.toMatch(/property q should not exist/);
    });
  });
});
