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
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { CreateGroupDto } from './dto/create-group.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { GroupsService } from './groups.service';
import type {
  GroupDetailView,
  GroupInviteView,
  GroupMemberView,
  GroupSummaryView,
  PendingInviteView,
} from './type/groups.types';

const groupIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Group id must be a valid UUID — copy it from GET /groups.',
    ),
});

const inviteIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Invitation id must be a valid UUID — copy it from GET /groups/invites.',
    ),
});

const memberIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(
      'Member id must be a RoamWarden user id (UUID) — copy it from GET /groups/:groupId/members.',
    ),
});

/**
 * Family / group plan (build plan §20). All routes require a Bearer JWT — the
 * global JwtAuthGuard covers them because nothing here is @Public().
 *
 * PRIVACY: none of these endpoints returns a location, a trip, presence or an
 * SOS, and none creates a membership without the invitee's own explicit accept.
 * See GroupsService for the full contract.
 *
 * ROUTE ORDER MATTERS: the `invites/...` routes are declared before `:groupId`
 * so the literal segment can never be swallowed by the parameter.
 */
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  // ── invitations addressed to the caller ───────────────────────────────

  /** Invitations waiting for the caller, matched on their verified email. */
  @Get('invites')
  listMyInvites(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PendingInviteView[]> {
    return this.groupsService.listMyInvites(user.id);
  }

  /** The consent step — the ONLY thing that creates a membership. */
  @Post('invites/:inviteId/accept')
  @HttpCode(HttpStatus.OK)
  acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('inviteId', inviteIdPipe) inviteId: string,
  ): Promise<GroupDetailView> {
    return this.groupsService.acceptInvite(user.id, inviteId);
  }

  @Post('invites/:inviteId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  declineInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('inviteId', inviteIdPipe) inviteId: string,
  ): Promise<void> {
    return this.groupsService.declineInvite(user.id, inviteId);
  }

  // ── groups ────────────────────────────────────────────────────────────

  /**
   * Creates the caller's group. The `familyPlan` capability check inside only
   * throws while ENFORCE_PLAN_LIMITS is on, so today every user may create one.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateGroupDto,
  ): Promise<GroupDetailView> {
    return this.groupsService.createGroup(user.id, dto);
  }

  @Get()
  listGroups(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GroupSummaryView[]> {
    return this.groupsService.listGroups(user.id);
  }

  @Get(':groupId')
  getGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
  ): Promise<GroupDetailView> {
    return this.groupsService.getGroup(user.id, groupId);
  }

  /** Owner disbands the group; every seat and invitation goes with it. */
  @Delete(':groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
  ): Promise<void> {
    return this.groupsService.deleteGroup(user.id, groupId);
  }

  // ── members ───────────────────────────────────────────────────────────

  @Get(':groupId/members')
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
  ): Promise<GroupMemberView[]> {
    return this.groupsService.listMembers(user.id, groupId);
  }

  /** Owner removes someone else. Revocable from this end. */
  @Delete(':groupId/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
    @Param('memberUserId', memberIdPipe) memberUserId: string,
  ): Promise<void> {
    return this.groupsService.removeMember(user.id, groupId, memberUserId);
  }

  /** A member walks out. Revocable from the other end too. */
  @Post(':groupId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leaveGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
  ): Promise<void> {
    return this.groupsService.leaveGroup(user.id, groupId);
  }

  // ── invitations the caller sends ──────────────────────────────────────

  /**
   * Owner invites an email address. Throttled: every call can push a
   * notification at whoever owns that address, so it must not be a free
   * megaphone.
   */
  @Throttle({ default: { limit: 20, ttl: 3600000 } })
  @Post(':groupId/invites')
  @HttpCode(HttpStatus.CREATED)
  inviteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
    @Body() dto: InviteMemberDto,
  ): Promise<GroupInviteView> {
    return this.groupsService.inviteMember(user.id, groupId, dto);
  }

  @Delete(':groupId/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId', groupIdPipe) groupId: string,
    @Param('inviteId', inviteIdPipe) inviteId: string,
  ): Promise<void> {
    return this.groupsService.revokeInvite(user.id, groupId, inviteId);
  }
}
