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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CONTACT_LOOKUP_THROTTLE } from './constant/users.constants';
import { CreateContactDto } from './dto/create-contact.dto';
import { LookupContactUserDto } from './dto/lookup-contact-user.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';
import type {
  ContactUserLookupResult,
  ContactWithLinkedUser,
  ProfileWithCounts,
  UserProfile,
} from './type/users.types';

const contactIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      "We couldn't read that contact — reopen your trusted contacts and try again.",
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

  @Get('contacts')
  listContacts(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ContactWithLinkedUser[]> {
    return this.usersService.listContacts(user.id);
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
