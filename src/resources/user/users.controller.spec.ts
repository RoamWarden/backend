import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CONTACT_LOOKUP_MAX_PER_WINDOW,
  CONTACT_LOOKUP_WINDOW_S,
} from './constant/users.constants';
import { CreateContactGroupDto } from './dto/create-contact-group.dto';
import { ListContactsQueryDto } from './dto/list-contacts.query.dto';
import { LookupContactUserDto } from './dto/lookup-contact-user.dto';
import { UpdateContactGroupDto } from './dto/update-contact-group.dto';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type {
  ContactGroupView,
  ContactUserLookupResult,
  PaginatedContacts,
} from './type/users.types';

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

describe('UsersController — paged contacts + contact groups', () => {
  let controller: UsersController;
  let usersService: {
    listContacts: jest.Mock;
    listContactsPage: jest.Mock;
    listContactGroups: jest.Mock;
    createContactGroup: jest.Mock;
    updateContactGroup: jest.Mock;
    deleteContactGroup: jest.Mock;
  };

  const caller = { id: 'u1', email: 'me@example.com' };

  const group: ContactGroupView = {
    id: 'g1',
    name: 'Family',
    favorite: false,
    memberCount: 2,
    contactIds: ['c1', 'c2'],
    createdAt: new Date('2026-07-26T09:00:00Z'),
  };

  beforeEach(async () => {
    usersService = {
      listContacts: jest.fn().mockResolvedValue([]),
      listContactsPage: jest.fn().mockResolvedValue({
        data: [],
        page: 1,
        limit: 10,
        total: 0,
      } satisfies PaginatedContacts),
      listContactGroups: jest.fn().mockResolvedValue([group]),
      createContactGroup: jest.fn().mockResolvedValue(group),
      updateContactGroup: jest.fn().mockResolvedValue(group),
      deleteContactGroup: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = moduleRef.get(UsersController);
  });

  // ── routes ───────────────────────────────────────────────────────────────

  describe('route wiring', () => {
    /* eslint-disable @typescript-eslint/unbound-method --
       These handlers are only ever read as decorator-metadata targets, never
       called, so there is no `this` to lose. */
    const listHandler: object = UsersController.prototype.listContacts;
    const pageHandler: object = UsersController.prototype.listContactsPage;
    const groupsHandler: object = UsersController.prototype.listContactGroups;
    /* eslint-enable @typescript-eslint/unbound-method */

    it('keeps the legacy contact list on its own unpaginated path', () => {
      // A TestFlight build in someone's hand calls exactly this path and
      // expects a flat array. Paging lives at a SEPARATE path, not behind a
      // query parameter that could change this response's shape.
      expect(Reflect.getMetadata('path', listHandler)).toBe('contacts');
      expect(Reflect.getMetadata('path', pageHandler)).toBe('contacts/page');
      expect(Reflect.getMetadata('path', groupsHandler)).toBe('contact-groups');
    });
  });

  // ── delegation (the caller always comes from the JWT) ─────────────────────

  it('returns the legacy contact list as a flat array', async () => {
    const rows = [{ id: 'c1' }];
    usersService.listContacts.mockResolvedValue(rows);
    const result = await controller.listContacts(caller);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toBe(rows);
  });

  it('passes the search + paging query through with the JWT caller', async () => {
    const query: ListContactsQueryDto = { q: 'mum', page: 2, limit: 25 };
    await controller.listContactsPage(caller, query);
    expect(usersService.listContactsPage).toHaveBeenCalledWith('u1', query);
  });

  it('scopes the group list to the JWT caller, never a body/query id', async () => {
    await expect(
      controller.listContactGroups(caller, { q: 'fam' }),
    ).resolves.toEqual([group]);
    expect(usersService.listContactGroups).toHaveBeenCalledWith('u1', {
      q: 'fam',
    });
  });

  it('creates, updates and deletes groups as the JWT caller', async () => {
    const create: CreateContactGroupDto = { name: 'Family' };
    await controller.createContactGroup(caller, create);
    expect(usersService.createContactGroup).toHaveBeenCalledWith('u1', create);

    const patch: UpdateContactGroupDto = { favorite: true };
    await controller.updateContactGroup(caller, 'g1', patch);
    expect(usersService.updateContactGroup).toHaveBeenCalledWith(
      'u1',
      'g1',
      patch,
    );

    await expect(
      controller.deleteContactGroup(caller, 'g1'),
    ).resolves.toBeUndefined();
    expect(usersService.deleteContactGroup).toHaveBeenCalledWith('u1', 'g1');
  });

  // ── DTOs under the real global pipe (main.ts settings, verbatim) ──────────

  describe('DTO validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });

    const run = <T>(body: unknown, metatype: ArgumentMetadata['metatype']) =>
      pipe.transform(body, {
        type: 'body',
        metatype,
      }) as Promise<T>;

    const rejectionMessages = async (
      body: unknown,
      metatype: ArgumentMetadata['metatype'],
    ): Promise<string> => {
      try {
        await run(body, metatype);
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse();
        const { message } = response as { message: string[] | string };
        return Array.isArray(message) ? message.join(' | ') : message;
      }
      throw new Error('expected the body to be rejected, but it passed');
    };

    it('trims a group name before it can be stored', async () => {
      await expect(
        run<CreateContactGroupDto>(
          { name: '  Family  ' },
          CreateContactGroupDto,
        ),
      ).resolves.toEqual({ name: 'Family' });
    });

    it('rejects a name that is only whitespace', async () => {
      // Trimming happens first, so "   " reaches @IsNotEmpty as "".
      await expect(
        rejectionMessages({ name: '   ' }, CreateContactGroupDto),
      ).resolves.toMatch(/name is required/);
    });

    it('rejects a name longer than 60 characters', async () => {
      await expect(
        rejectionMessages({ name: 'a'.repeat(61) }, CreateContactGroupDto),
      ).resolves.toMatch(/60 characters or fewer/);
    });

    it('rejects a contactIds entry that is not a UUID', async () => {
      await expect(
        rejectionMessages(
          { name: 'Family', contactIds: ['not-a-uuid'] },
          CreateContactGroupDto,
        ),
      ).resolves.toMatch(/must be a valid UUID/);
    });

    it('rejects an unknown property on a group body', async () => {
      await expect(
        rejectionMessages(
          { name: 'Family', userId: 'someone-else' },
          CreateContactGroupDto,
        ),
      ).resolves.toMatch(/property userId should not exist/);
    });

    it('lets a PATCH omit every field (membership then stays untouched)', async () => {
      await expect(
        run<UpdateContactGroupDto>({}, UpdateContactGroupDto),
      ).resolves.toEqual({});
    });

    it('coerces page and limit from their query strings', async () => {
      await expect(
        run<ListContactsQueryDto>(
          { q: '  mum  ', page: '2', limit: '25' },
          ListContactsQueryDto,
        ),
      ).resolves.toEqual({ q: 'mum', page: 2, limit: 25 });
    });

    it('rejects page 0 rather than silently paging from nowhere', async () => {
      await expect(
        rejectionMessages({ page: 0 }, ListContactsQueryDto),
      ).resolves.toMatch(/page must be at least 1/);
    });
  });
});
