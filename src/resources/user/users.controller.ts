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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CreateContactDto } from './dto/create-contact.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';
import type {
  ContactWithLinkedUser,
  ProfileWithCounts,
  UserProfile,
} from './type/users.types';

const contactIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Contact id must be a valid UUID — copy it from GET /me/contacts.',
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
