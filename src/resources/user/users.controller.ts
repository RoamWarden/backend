import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CONTACT_LOOKUP_THROTTLE } from './constant/users.constants';
import { CreateContactDto } from './dto/create-contact.dto';
import { CreateContactGroupDto } from './dto/create-contact-group.dto';
import { ListContactGroupsQueryDto } from './dto/list-contact-groups.query.dto';
import { ListContactsQueryDto } from './dto/list-contacts.query.dto';
import { LookupContactUserDto } from './dto/lookup-contact-user.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { UpdateContactGroupDto } from './dto/update-contact-group.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';
import type {
  ContactGroupView,
  ContactUserLookupResult,
  ContactWithLinkedUser,
  PaginatedContacts,
  ProfileWithCounts,
  UserProfile,
} from './type/users.types';

const contactIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      "We couldn't read that contact — reopen your trusted contacts and try again.",
    ),
});

const contactGroupIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      "We couldn't read that contact group — reopen your groups and try again.",
    ),
});

/** All routes require a Bearer JWT (global JwtAuthGuard; nothing here is @Public). */
@Controller('me')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── profile ───────────────────────────────────────────────────────────

  /** Own profile incl. reputation + counts of trips/reports/contacts. */
  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<ProfileWithCounts> {
    return this.usersService.getProfile(user.id);
  }

  @Patch()
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    return this.usersService.updateProfile(user.id, dto);
  }

  /** GDPR delete: removes the account and, via schema cascades, all its data. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMe(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.usersService.deleteAccount(user.id);
  }

  // ── trusted contacts ──────────────────────────────────────────────────

  /**
   * EVERY contact as a FLAT ARRAY. This shape is frozen — TestFlight builds
   * already in users' hands index straight into it, so it is never paginated
   * and never wrapped in an envelope. Extra fields per item are fine (that is
   * how `favorite` shipped). Want paging or search? Use `contacts/page`.
   */
  @Get('contacts')
  listContacts(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ContactWithLinkedUser[]> {
    return this.usersService.listContacts(user.id);
  }

  /**
   * The paged, searchable view of the same contacts — a SEPARATE route rather
   * than a query parameter on the one above, so the legacy shape stays
   * unconditional and no client can accidentally opt into a new envelope.
   *
   * ROUTE ORDER MATTERS: this literal segment is declared before
   * `contacts/:id`, so `page` can never be parsed as a contact id.
   */
  @Get('contacts/page')
  listContactsPage(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListContactsQueryDto,
  ): Promise<PaginatedContacts> {
    return this.usersService.listContactsPage(user.id, query);
  }

  /**
   * Find a RoamWarden account by EXACT email, so linking a trusted contact
   * never requires anyone to read a uuid down the phone.
   *
   * POST, not GET, on purpose: the address stays in a request body instead of a
   * URL that proxies, access logs and browser history would keep forever, and
   * nothing can cache the answer. `@HttpCode(200)` because this creates
   * nothing — and a miss is a 200 too (`found: false` + a next step), never a
   * 404 the UI has to present as a failure.
   *
   * Throttled far tighter than the global default; see
   * {@link CONTACT_LOOKUP_THROTTLE}. This decorator is the per-IP half — the
   * per-account half is enforced inside the service, because the global
   * ThrottlerGuard runs before the JWT guard and so cannot see who is asking.
   */
  @Throttle({ default: CONTACT_LOOKUP_THROTTLE })
  @Post('contacts/lookup')
  @HttpCode(HttpStatus.OK)
  lookupContactUser(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LookupContactUserDto,
  ): Promise<ContactUserLookupResult> {
    return this.usersService.lookupContactUserByEmail(user.id, dto.email);
  }

  @Post('contacts')
  createContact(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateContactDto,
  ): Promise<ContactWithLinkedUser> {
    return this.usersService.createContact(user.id, dto);
  }

  @Patch('contacts/:id')
  updateContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', contactIdPipe) contactId: string,
    @Body() dto: UpdateContactDto,
  ): Promise<ContactWithLinkedUser> {
    return this.usersService.updateContact(user.id, contactId, dto);
  }

  @Delete('contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', contactIdPipe) contactId: string,
  ): Promise<void> {
    return this.usersService.deleteContact(user.id, contactId);
  }

  // ── contact groups ────────────────────────────────────────────────────
  //
  // The caller's PRIVATE labels over their own contacts ("Family", "Work").
  // Unrelated to the family-plan groups under /groups: nobody joins one and
  // nobody is notified because of one. Every route is scoped to the caller, and
  // another account's id is a 404 (never a 403 — see UsersService).

  @Get('contact-groups')
  listContactGroups(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListContactGroupsQueryDto,
  ): Promise<ContactGroupView[]> {
    return this.usersService.listContactGroups(user.id, query);
  }

  @Post('contact-groups')
  createContactGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateContactGroupDto,
  ): Promise<ContactGroupView> {
    return this.usersService.createContactGroup(user.id, dto);
  }

  /** `contactIds` present REPLACES the membership; absent leaves it alone. */
  @Patch('contact-groups/:id')
  updateContactGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', contactGroupIdPipe) groupId: string,
    @Body() dto: UpdateContactGroupDto,
  ): Promise<ContactGroupView> {
    return this.usersService.updateContactGroup(user.id, groupId, dto);
  }

  /** Removes the label only — the contacts inside it are never deleted. */
  @Delete('contact-groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteContactGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', contactGroupIdPipe) groupId: string,
  ): Promise<void> {
    return this.usersService.deleteContactGroup(user.id, groupId);
  }

  // ── device tokens ─────────────────────────────────────────────────────

  @Post('devices')
  registerDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceDto,
  ): ReturnType<UsersService['registerDevice']> {
    return this.usersService.registerDevice(user.id, dto);
  }

  @Delete('devices/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    return this.usersService.removeDevice(user.id, token);
  }
}
