import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupInviteStatus, GroupMemberRole, Prisma } from '@prisma/client';
import {
  EntitlementsService,
  PLAN_LIMIT_ERROR_CODE,
} from '../../common/entitlements';
import { normalizeEmail } from '../../common/transforms/normalize-email';
import { PrismaService } from '../../prisma/prisma.service';
import { PREMIUM_PLAN_CODE } from '../billing/constant/billing.constants';
import { NotificationsService } from '../notification/notifications.service';
import { UsersService } from '../user/users.service';
import type { CreateGroupDto } from './dto/create-group.dto';
import type { InviteMemberDto } from './dto/invite-member.dto';
import {
  ACCOUNT_NOT_FOUND,
  ALREADY_OWN_A_GROUP,
  CANNOT_INVITE_YOURSELF,
  GROUP_INVITE_TTL_S,
  GROUP_NOT_FOUND,
  GROUP_WITH_MEMBERS_INCLUDE,
  INVITE_ALREADY_ACCEPTED,
  INVITE_ALREADY_ANSWERED,
  INVITE_EXPIRED,
  INVITE_NOT_FOUND,
  MEMBER_NOT_FOUND,
  NOT_A_MEMBER,
  NOT_GROUP_OWNER,
  OWNER_CANNOT_BE_REMOVED,
  OWNER_CANNOT_LEAVE,
  VERIFY_EMAIL_FIRST,
  alreadyAMember,
  groupFullMessage,
} from './constant/groups.constants';
import type {
  AccountFacts,
  GroupDetailView,
  GroupInviteView,
  GroupMemberView,
  GroupSeatsView,
  GroupSummaryView,
  GroupWithMembers,
  PendingInviteView,
} from './type/groups.types';

/** An invitation with just enough of its group to decide anything about it. */
type InviteWithGroup = Prisma.GroupInviteGetPayload<{
  include: { group: { select: { id: true; name: true; ownerId: true } } };
}>;

const INVITE_GROUP_INCLUDE = {
  group: { select: { id: true, name: true, ownerId: true } },
} as const;

/**
 * Family / group plan (build plan §20, Premium capability `familyPlan`).
 *
 * ══════════════════════ PRIVACY — READ BEFORE CHANGING ANYTHING ══════════════
 * RoamWarden is a LOCATION app, so the dangerous failure here is not a bug, it
 * is a design that quietly turns "we're in a group" into "I can see where you
 * are". This module refuses to be that.
 *
 * A group is a ROSTER. What a member CAN see:
 *   • the group's name and when it was created;
 *   • every member's user id, display name, avatar, role and join date.
 * What a member CANNOT see, by construction:
 *   • any location — live, historical, or last-known — of anyone;
 *   • any trip (active or past), route, breadcrumb, ETA or arrival;
 *   • presence / online state, SOS events, or SOS trails;
 *   • any member's email address, phone number, trusted contacts or plan.
 * Owner-only additions: outstanding invitations (they contain a third party's
 * email address) and seat counts (they reveal the owner's plan).
 *
 * Joining is CONSENSUAL and cannot be skipped: an invitation names an email
 * address and creates NOTHING. A `group_members` row appears only when a
 * signed-in user whose OWN verified email matches accepts. Inviting an address
 * never tells the inviter whether an account exists for it.
 *
 * Location sharing is NOT changed by this module. It continues to run through
 * trusted contacts under the existing MUTUAL-consent rule — both people must
 * have added each other (UsersService.filterConsentingContactUserIds). If a
 * future feature fans a trip out to "the group", it must call
 * {@link GroupsService.getConsentingGroupMemberUserIds}, which INTERSECTS the
 * roster with that same gate: a group can then only ever narrow the audience,
 * never widen it. There is no other sanctioned path, and no group table has a
 * foreign key to trips, points, presence or SOS.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * PLAN LIMITS ARE INFORMATION, NOT A LOCK. Seats come from the OWNER's plan
 * (`familyMembers`: free 0, premium 6, owner included) and the capability gate
 * is `familyPlan`. Both go through EntitlementsService, whose `assert*` helpers
 * throw ONLY while ENFORCE_PLAN_LIMITS is on — and it is off, so today ANY user
 * may create a group and fill it. The numbers are reported in `seats` so the UI
 * can show them; nothing is capped, hidden or removed.
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── groups ────────────────────────────────────────────────────────────

  /**
   * Creates the caller's group and seats them in it as OWNER.
   *
   * The `familyPlan` capability gate below throws ONLY while enforcement is on.
   * Today it is off, so this is a no-op check that merely records what it would
   * have done — every user can create a group.
   */
  async createGroup(
    userId: string,
    dto: CreateGroupDto,
  ): Promise<GroupDetailView> {
    await this.entitlements.assertCapability(userId, 'familyPlan');

    try {
      const group = await this.prisma.group.create({
        data: {
          ownerId: userId,
          name: dto.name.trim(),
          // The owner holds a member row like anyone else, so seat counting is
          // one COUNT and the roster needs no special case.
          members: { create: { userId, role: GroupMemberRole.OWNER } },
        },
        include: GROUP_WITH_MEMBERS_INCLUDE,
      });
      this.logger.log(`User ${userId} created group ${group.id}`);
      return this.toDetailView(group, userId);
    } catch (error) {
      // UNIQUE(owner_id): one group per owner, enforced by the database.
      if (isPrismaError(error, 'P2002')) {
        throw new ConflictException(ALREADY_OWN_A_GROUP);
      }
      if (isPrismaError(error, 'P2003')) {
        throw new NotFoundException(ACCOUNT_NOT_FOUND);
      }
      this.logger.error(
        `Unexpected error creating a group for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /** Every group the caller belongs to — owned or joined. */
  async listGroups(userId: string): Promise<GroupSummaryView[]> {
    const groups = await this.prisma.group.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
      include: GROUP_WITH_MEMBERS_INCLUDE,
    });
    return groups.map((group) => this.toSummaryView(group, userId));
  }

  /** One group with its roster. 404 unless the caller is a member. */
  async getGroup(userId: string, groupId: string): Promise<GroupDetailView> {
    const group = await this.requireMembership(userId, groupId);
    return this.toDetailView(group, userId);
  }

  /**
   * Disbands the group. Owner only. Cascades remove every seat and every
   * outstanding invitation — the group leaves nothing behind.
   */
  async deleteGroup(userId: string, groupId: string): Promise<void> {
    await this.requireOwnedGroup(userId, groupId);
    await this.prisma.group.delete({ where: { id: groupId } });
    this.logger.log(`User ${userId} deleted group ${groupId}`);
  }

  // ── members ───────────────────────────────────────────────────────────

  /** The roster. Display identity only — never emails, phones or locations. */
  async listMembers(
    userId: string,
    groupId: string,
  ): Promise<GroupMemberView[]> {
    const group = await this.requireMembership(userId, groupId);
    return this.toMemberViews(group, userId);
  }

  /** Owner removes someone. The owner's own seat can only go with the group. */
  async removeMember(
    userId: string,
    groupId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.requireOwnedGroup(userId, groupId);
    if (memberUserId === userId) {
      throw new BadRequestException(OWNER_CANNOT_BE_REMOVED);
    }
    const { count } = await this.prisma.groupMember.deleteMany({
      where: { groupId, userId: memberUserId, role: GroupMemberRole.MEMBER },
    });
    if (count === 0) {
      throw new NotFoundException(MEMBER_NOT_FOUND);
    }
    this.logger.log(
      `Owner ${userId} removed member ${memberUserId} from group ${groupId}`,
    );
  }

  /**
   * A member leaves under their own steam. Membership must always be
   * revocable from BOTH ends: the owner can remove, the member can walk.
   */
  async leaveGroup(userId: string, groupId: string): Promise<void> {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true },
    });
    if (!membership) {
      throw new NotFoundException(NOT_A_MEMBER);
    }
    if (membership.role === GroupMemberRole.OWNER) {
      throw new BadRequestException(OWNER_CANNOT_LEAVE);
    }
    await this.prisma.groupMember.deleteMany({ where: { groupId, userId } });
    this.logger.log(`User ${userId} left group ${groupId}`);
  }

  // ── invitations ───────────────────────────────────────────────────────

  /**
   * Invites an email address. Owner only.
   *
   * This writes an OFFER and nothing else: no membership, no link to any
   * account, and no signal back to the owner about whether that address is even
   * registered. Re-inviting a declined or withdrawn address resets the same row
   * (UNIQUE(group_id, email)) instead of stacking up history.
   */
  async inviteMember(
    userId: string,
    groupId: string,
    dto: InviteMemberDto,
  ): Promise<GroupInviteView> {
    const group = await this.requireOwnedGroup(userId, groupId);
    const account = await this.requireAccount(userId);
    const email = normalizeEmail(dto.email);

    if (email === account.email) {
      throw new BadRequestException(CANNOT_INVITE_YOURSELF);
    }

    // Roster check by email. This is an internal join, and the answer leaks
    // nothing: the owner invited every member of their own group, so they
    // already know which addresses are on it.
    const existingMember = await this.prisma.groupMember.findFirst({
      where: { groupId, user: { email } },
      select: { id: true },
    });
    if (existingMember) {
      throw new ConflictException(alreadyAMember(email));
    }

    const now = new Date();
    // The roster came back with the group, so no second COUNT — and the number
    // the seat check sees can never disagree with the one the caller is shown.
    const memberCount = group.members.length;
    const outstandingInvites = await this.prisma.groupInvite.count({
      where: {
        groupId,
        status: GroupInviteStatus.PENDING,
        expiresAt: { gt: now },
        // Re-inviting the same address reuses its row, so it must not be
        // counted as a second reserved seat.
        email: { not: email },
      },
    });

    // Reserved seats = roster + invitations still outstanding, so an owner
    // cannot quietly over-subscribe by sending twenty invitations for six
    // seats. Throws ONLY while ENFORCE_PLAN_LIMITS is on; today it records
    // `wouldBlock` and lets the invitation through.
    await this.entitlements.assertWithinLimit(
      userId,
      'familyMembers',
      memberCount + outstandingInvites,
    );

    const expiresAt = new Date(now.getTime() + GROUP_INVITE_TTL_S * 1000);
    const invite = await this.prisma.groupInvite.upsert({
      where: { groupId_email: { groupId, email } },
      create: { groupId, email, expiresAt },
      update: {
        status: GroupInviteStatus.PENDING,
        expiresAt,
        respondedAt: null,
      },
    });

    this.logger.log(
      `Owner ${userId} invited an address to group ${groupId} (invite ${invite.id})`,
    );
    await this.notifyInvitee(email, group.name, account.name);
    return toInviteView(invite);
  }

  /** Owner withdraws an invitation before it is answered. */
  async revokeInvite(
    userId: string,
    groupId: string,
    inviteId: string,
  ): Promise<void> {
    await this.requireOwnedGroup(userId, groupId);
    const { count } = await this.prisma.groupInvite.updateMany({
      where: { id: inviteId, groupId, status: GroupInviteStatus.PENDING },
      data: { status: GroupInviteStatus.REVOKED, respondedAt: new Date() },
    });
    if (count === 0) {
      // Already answered, already withdrawn, or not this group's invitation.
      throw new NotFoundException(INVITE_NOT_FOUND);
    }
    this.logger.log(
      `Owner ${userId} revoked invite ${inviteId} on group ${groupId}`,
    );
  }

  /**
   * Invitations waiting for the CALLER, matched on their own verified email.
   *
   * Deliberately thin: which group, who owns it, how big it is. Not the roster
   * — you should not learn who is in a group you have not joined.
   */
  async listMyInvites(userId: string): Promise<PendingInviteView[]> {
    const account = await this.requireVerifiedAccount(userId);
    const invites = await this.prisma.groupInvite.findMany({
      where: {
        email: account.email,
        status: GroupInviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        group: {
          select: {
            id: true,
            name: true,
            owner: { select: { name: true } },
            _count: { select: { members: true } },
          },
        },
      },
    });
    return invites.map((invite) => ({
      id: invite.id,
      groupId: invite.group.id,
      groupName: invite.group.name,
      invitedByName: invite.group.owner.name,
      memberCount: invite.group._count.members,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    }));
  }

  /**
   * The consent step. THIS is the only thing that ever creates a membership.
   *
   * The caller must be signed in AND own the invited address (verified), so an
   * unverified account registered on someone else's email cannot walk into
   * their family group.
   */
  async acceptInvite(
    userId: string,
    inviteId: string,
  ): Promise<GroupDetailView> {
    const account = await this.requireVerifiedAccount(userId);
    const invite = this.requireOpenInvite(
      await this.findInvite(inviteId),
      account,
    );

    const memberCount = await this.prisma.groupMember.count({
      where: { groupId: invite.groupId },
    });
    // Seats belong to the OWNER's plan, so that is whose limit we read. `allowed`
    // is ALWAYS true while enforcement is off, so this cannot block anyone today.
    const seats = await this.entitlements.checkLimit(
      invite.group.ownerId,
      'familyMembers',
      memberCount,
    );
    if (!seats.allowed) {
      // Reachable only with ENFORCE_PLAN_LIMITS on. The message is written for
      // the invitee: they cannot upgrade someone else's plan.
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: groupFullMessage(invite.group.name, seats.limit ?? 0),
        code: PLAN_LIMIT_ERROR_CODE,
        limitKey: seats.key,
        limit: seats.limit,
        current: seats.current,
        planCode: seats.planCode,
        upgradeTo: PREMIUM_PLAN_CODE,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // upsert, not create: two taps on "Accept" must consume one seat, not
      // blow up on the unique index.
      await tx.groupMember.upsert({
        where: { groupId_userId: { groupId: invite.groupId, userId } },
        create: {
          groupId: invite.groupId,
          userId,
          role: GroupMemberRole.MEMBER,
        },
        update: {},
      });
      await tx.groupInvite.update({
        where: { id: invite.id },
        data: {
          status: GroupInviteStatus.ACCEPTED,
          respondedAt: new Date(),
        },
      });
    });

    this.logger.log(`User ${userId} accepted invite ${invite.id}`);
    return this.getGroup(userId, invite.groupId);
  }

  /** The other half of consent: saying no, and being able to say it once. */
  async declineInvite(userId: string, inviteId: string): Promise<void> {
    const account = await this.requireVerifiedAccount(userId);
    const invite = this.requireOwnInvite(
      await this.findInvite(inviteId),
      account,
    );

    // Idempotent: declining twice is not an error.
    if (
      invite.status === GroupInviteStatus.DECLINED ||
      invite.status === GroupInviteStatus.REVOKED
    ) {
      return;
    }
    if (invite.status === GroupInviteStatus.ACCEPTED) {
      throw new ConflictException(INVITE_ALREADY_ACCEPTED);
    }
    // An EXPIRED-by-time invitation is still declinable — dismissing something
    // stale should never be an error the user has to understand.
    await this.prisma.groupInvite.update({
      where: { id: invite.id },
      data: { status: GroupInviteStatus.DECLINED, respondedAt: new Date() },
    });
    this.logger.log(`User ${userId} declined invite ${invite.id}`);
  }

  // ── the privacy gate ──────────────────────────────────────────────────

  /**
   * THE ONLY SANCTIONED WAY to fan anything sensitive out to "the group".
   *
   * Returns the userIds of groupmates who ALSO pass the existing mutual-consent
   * gate — i.e. the caller and that person have each added the other as a
   * trusted contact (UsersService.filterConsentingContactUserIds).
   *
   * It is an INTERSECTION of the roster with the trusted-contact consent set,
   * so it can only ever be a SUBSET of who could already receive the caller's
   * location. Being in a group therefore never widens the audience by one
   * person; it only lets a user address a subset of contacts by group name.
   *
   * Do not "optimise" this into `members.map(m => m.userId)`. That single edit
   * would turn every group into a live-location broadcast to people who never
   * consented — which is the whole failure mode this module exists to avoid.
   */
  async getConsentingGroupMemberUserIds(
    userId: string,
    groupId: string,
  ): Promise<string[]> {
    await this.requireMembership(userId, groupId);
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, userId: { not: userId } },
      select: { userId: true },
    });
    if (members.length === 0) return [];
    return this.users.filterConsentingContactUserIds(
      userId,
      members.map((member) => member.userId),
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** 404 (never 403) unless the caller is on this group's roster. */
  private async requireMembership(
    userId: string,
    groupId: string,
  ): Promise<GroupWithMembers> {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, members: { some: { userId } } },
      include: GROUP_WITH_MEMBERS_INCLUDE,
    });
    if (!group) {
      // Same answer for "no such group" and "not yours", so group ids are not
      // probeable.
      throw new NotFoundException(GROUP_NOT_FOUND);
    }
    return group;
  }

  /** As above, but the caller must own it. Members get a specific 403. */
  private async requireOwnedGroup(
    userId: string,
    groupId: string,
  ): Promise<GroupWithMembers> {
    const group = await this.requireMembership(userId, groupId);
    if (group.ownerId !== userId) {
      // They are a member, so the group's existence is not a secret from them —
      // an honest 403 is more useful here than a 404.
      throw new ForbiddenException(NOT_GROUP_OWNER);
    }
    return group;
  }

  /** The caller's own account row. The JWT's email may be stale; this is not. */
  private async requireAccount(userId: string): Promise<AccountFacts> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
    if (!user) {
      throw new NotFoundException(ACCOUNT_NOT_FOUND);
    }
    return user;
  }

  /**
   * Same, but the address must be PROVEN. Invitations are matched by email, so
   * an unverified address would let whoever merely CLAIMED it answer someone
   * else's invitation.
   */
  private async requireVerifiedAccount(userId: string): Promise<AccountFacts> {
    const account = await this.requireAccount(userId);
    if (!account.emailVerifiedAt) {
      throw new ForbiddenException(VERIFY_EMAIL_FIRST);
    }
    return account;
  }

  private findInvite(inviteId: string): Promise<InviteWithGroup | null> {
    return this.prisma.groupInvite.findUnique({
      where: { id: inviteId },
      include: INVITE_GROUP_INCLUDE,
    });
  }

  /**
   * The invitation must exist AND be addressed to the caller. Both failures
   * give the identical 404: someone holding a stray invitation id must not be
   * able to tell "that isn't real" from "that isn't yours".
   */
  private requireOwnInvite(
    invite: InviteWithGroup | null,
    account: AccountFacts,
  ): InviteWithGroup {
    if (!invite || invite.email !== account.email) {
      throw new NotFoundException(INVITE_NOT_FOUND);
    }
    return invite;
  }

  /** As above, and still open: not answered, not withdrawn, not expired. */
  private requireOpenInvite(
    invite: InviteWithGroup | null,
    account: AccountFacts,
  ): InviteWithGroup {
    const own = this.requireOwnInvite(invite, account);
    if (own.status === GroupInviteStatus.ACCEPTED) {
      throw new ConflictException(INVITE_ALREADY_ACCEPTED);
    }
    if (own.status !== GroupInviteStatus.PENDING) {
      throw new ConflictException(INVITE_ALREADY_ANSWERED);
    }
    if (own.expiresAt.getTime() <= Date.now()) {
      throw new GoneException(INVITE_EXPIRED);
    }
    return own;
  }

  /**
   * Best-effort heads-up to an invited address that already has an account.
   *
   * The lookup happens INSIDE this method and its result never leaves it, so
   * the inviter still learns nothing about whether the address is registered.
   * No email is sent to non-users — that would make the invite endpoint a spam
   * cannon. Never throws: a missed notification must not fail an invitation
   * that is already written.
   */
  private async notifyInvitee(
    email: string,
    groupName: string,
    inviterName: string,
  ): Promise<void> {
    try {
      const invitee = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (!invitee) return;
      await this.notifications.sendToUsers([invitee.id], {
        title: `${inviterName} invited you to a group`,
        body: `Join "${groupName}" on RoamWarden. You choose whether to accept.`,
        data: { kind: 'group-invite' },
      });
    } catch (error) {
      this.logger.error(
        `Group invitation to "${groupName}" was saved, but notifying the invitee failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private toSummaryView(
    group: GroupWithMembers,
    viewerId: string,
  ): GroupSummaryView {
    return {
      id: group.id,
      name: group.name,
      role: roleOf(group, viewerId),
      memberCount: group.members.length,
      createdAt: group.createdAt,
    };
  }

  private async toDetailView(
    group: GroupWithMembers,
    viewerId: string,
  ): Promise<GroupDetailView> {
    const isOwner = group.ownerId === viewerId;
    // Invitations carry a third party's email address, and seat counts reveal
    // the owner's plan. Neither is a member's business.
    const [pendingInvites, seats] = await Promise.all([
      isOwner ? this.listPendingInvites(group.id) : Promise.resolve(null),
      isOwner
        ? this.buildSeats(group.ownerId, group.members.length)
        : Promise.resolve(null),
    ]);
    return {
      ...this.toSummaryView(group, viewerId),
      members: this.toMemberViews(group, viewerId),
      pendingInvites,
      seats,
    };
  }

  private toMemberViews(
    group: GroupWithMembers,
    viewerId: string,
  ): GroupMemberView[] {
    return (
      [...group.members]
        // Owner first, then longest-standing member first.
        .sort((a, b) => {
          if (a.role !== b.role)
            return a.role === GroupMemberRole.OWNER ? -1 : 1;
          return a.joinedAt.getTime() - b.joinedAt.getTime();
        })
        .map((member) => ({
          userId: member.userId,
          name: member.user.name,
          avatarUrl: member.user.avatarUrl,
          role: member.role,
          joinedAt: member.joinedAt,
          isYou: member.userId === viewerId,
        }))
    );
  }

  private async listPendingInvites(
    groupId: string,
  ): Promise<GroupInviteView[]> {
    const invites = await this.prisma.groupInvite.findMany({
      where: {
        groupId,
        status: GroupInviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map(toInviteView);
  }

  /**
   * Seat accounting for the UI. INFORMATION ONLY while `enforced` is false —
   * `checkLimit` never throws and never blocks; it just reports the numbers and
   * whether they WOULD block if the switch were flipped.
   */
  private async buildSeats(
    ownerId: string,
    memberCount: number,
  ): Promise<GroupSeatsView> {
    const check = await this.entitlements.checkLimit(
      ownerId,
      'familyMembers',
      memberCount,
    );
    return {
      used: check.current,
      limit: check.limit,
      remaining: check.remaining,
      planCode: check.planCode,
      enforced: check.enforced,
      wouldBlock: check.wouldBlock,
      message: check.message,
    };
  }
}

/** The caller's role in a group they are known to belong to. */
function roleOf(group: GroupWithMembers, viewerId: string): GroupMemberRole {
  const membership = group.members.find((member) => member.userId === viewerId);
  return membership?.role ?? GroupMemberRole.MEMBER;
}

function toInviteView(invite: {
  id: string;
  email: string;
  status: GroupInviteStatus;
  expiresAt: Date;
  createdAt: Date;
}): GroupInviteView {
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}
