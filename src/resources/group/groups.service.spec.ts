import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  GroupInviteStatus,
  GroupMemberRole,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { EntitlementsService } from '../../common/entitlements';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notification/notifications.service';
import { UsersService } from '../user/users.service';
import { GroupsService } from './groups.service';
import {
  ALREADY_OWN_A_GROUP,
  CANNOT_INVITE_YOURSELF,
  GROUP_NOT_FOUND,
  INVITE_ALREADY_ACCEPTED,
  INVITE_EXPIRED,
  INVITE_NOT_FOUND,
  MEMBER_NOT_FOUND,
  NOT_GROUP_OWNER,
  OWNER_CANNOT_BE_REMOVED,
  OWNER_CANNOT_LEAVE,
  VERIFY_EMAIL_FIRST,
} from './constant/groups.constants';

/**
 * Family/group plan tests, aimed at the three things that can actually hurt
 * someone:
 *   1. the invitation lifecycle — nobody joins without accepting;
 *   2. seat accounting — reported, and (today) never applied;
 *   3. the privacy gate — a group never widens who can see your location.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const INVITEE_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';

const OWNER = {
  id: OWNER_ID,
  email: 'owner@example.com',
  name: 'Ada',
  emailVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
};
const INVITEE = {
  id: INVITEE_ID,
  email: 'invitee@example.com',
  name: 'Grace',
  emailVerifiedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const HOUR = 60 * 60 * 1000;

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: 'test',
  });
}

/** Jest matchers, typed so they fit inside typed object literals. */
const ANY_STRING = expect.any(String) as unknown as string;
const ANY_DATE = expect.any(Date) as unknown as Date;
const containing = (fragment: string): string => {
  const matcher: unknown = expect.stringContaining(fragment);
  return matcher as string;
};
const objectWith = (
  shape: Record<string, unknown>,
): Record<string, unknown> => {
  const matcher: unknown = expect.objectContaining(shape);
  return matcher as Record<string, unknown>;
};

/** First argument of the first call to a jest mock, typed by the caller. */
const firstArg = <T>(mock: jest.Mock): T => {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[0][0];
};

function memberRow(
  userId: string,
  role: GroupMemberRole = GroupMemberRole.MEMBER,
  name = 'Someone',
): {
  id: string;
  groupId: string;
  userId: string;
  role: GroupMemberRole;
  joinedAt: Date;
  user: { id: string; name: string; avatarUrl: string | null };
} {
  return {
    id: `member-${userId}`,
    groupId: GROUP_ID,
    userId,
    role,
    joinedAt: new Date('2026-07-02T00:00:00.000Z'),
    user: { id: userId, name, avatarUrl: null },
  };
}

function groupRow(
  members = [memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada')],
): {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  members: ReturnType<typeof memberRow>[];
} {
  return {
    id: GROUP_ID,
    ownerId: OWNER_ID,
    name: 'Family',
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    members,
  };
}

function inviteRow(
  overrides: Partial<{
    id: string;
    groupId: string;
    email: string;
    status: GroupInviteStatus;
    expiresAt: Date;
    respondedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
): Record<string, unknown> {
  return {
    id: INVITE_ID,
    groupId: GROUP_ID,
    email: INVITEE.email,
    status: GroupInviteStatus.PENDING,
    expiresAt: new Date(Date.now() + 24 * HOUR),
    respondedAt: null,
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    group: { id: GROUP_ID, name: 'Family', ownerId: OWNER_ID },
    ...overrides,
  };
}

type PrismaMock = {
  group: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
  };
  groupMember: {
    count: jest.Mock;
    create: jest.Mock;
    upsert: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    deleteMany: jest.Mock;
  };
  groupInvite: {
    count: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  user: { findUnique: jest.Mock };
  subscription: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

describe('GroupsService', () => {
  let prisma: PrismaMock;
  let users: { filterConsentingContactUserIds: jest.Mock };
  let notifications: { sendToUsers: jest.Mock };
  let entitlements: EntitlementsService;
  let service: GroupsService;

  /**
   * Builds the service with the REAL EntitlementsService, because the whole
   * point of these tests is that the shipped configuration (enforcement OFF)
   * takes nothing away. A stub would let a regression hide.
   */
  function build(env: Record<string, string | undefined> = {}): void {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    entitlements = new EntitlementsService(
      prisma as unknown as PrismaService,
      config,
    );
    service = new GroupsService(
      prisma as unknown as PrismaService,
      entitlements,
      users as unknown as UsersService,
      notifications as unknown as NotificationsService,
    );
    const { logger } = service as unknown as {
      logger: { log: jest.Mock; error: jest.Mock };
    };
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  }

  /** Puts the user on a paid, ACTIVE plan — the only way to be entitled. */
  function givePremium(): void {
    prisma.subscription.findUnique.mockResolvedValue({
      status: SubscriptionStatus.ACTIVE,
      plan: { code: 'premium' },
    });
  }

  beforeEach(() => {
    prisma = {
      group: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
      groupMember: {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn(),
        upsert: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      groupInvite: {
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
      user: { findUnique: jest.fn().mockResolvedValue(OWNER) },
      subscription: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    users = { filterConsentingContactUserIds: jest.fn() };
    notifications = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    // Boot-time INFO and the per-check `[plan-limits][shadow]` debug lines from
    // EntitlementsService would drown the output. Warnings and errors still
    // print — those are the ones worth seeing.
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── nothing is taken away today ───────────────────────────────────────

  describe('with enforcement OFF (the shipping state)', () => {
    it('lets a FREE user create a group, even though familyPlan is a premium capability', async () => {
      prisma.group.create.mockResolvedValue(groupRow());

      const view = await service.createGroup(OWNER_ID, { name: 'Family' });

      expect(view.id).toBe(GROUP_ID);
      expect(view.role).toBe(GroupMemberRole.OWNER);
      expect(prisma.group.create).toHaveBeenCalled();
    });

    it('reports the free seat limit without applying it', async () => {
      prisma.group.create.mockResolvedValue(groupRow());

      const view = await service.createGroup(OWNER_ID, { name: 'Family' });

      // Free grants 0 family seats, so the owner is already "over" it...
      expect(view.seats).toEqual({
        used: 1,
        limit: 0,
        remaining: 0,
        planCode: 'free',
        enforced: false,
        wouldBlock: true,
        message: ANY_STRING,
      });
      // ...and yet the group exists and nothing was blocked.
      expect(view.seats?.enforced).toBe(false);
    });

    it('lets a FREE owner invite past the seat limit', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );
      prisma.groupInvite.count.mockResolvedValue(9);
      prisma.groupInvite.upsert.mockResolvedValue(inviteRow());
      prisma.user.findUnique.mockResolvedValue(OWNER);

      await expect(
        service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email }),
      ).resolves.toMatchObject({ status: GroupInviteStatus.PENDING });
    });

    it('lets an invitee accept into a group that is already over its seats', async () => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());
      prisma.groupMember.count.mockResolvedValue(99);
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );

      const view = await service.acceptInvite(INVITEE_ID, INVITE_ID);

      expect(view.members.map((m) => m.userId)).toContain(INVITEE_ID);
      expect(prisma.groupMember.upsert).toHaveBeenCalled();
    });
  });

  // ── seat accounting ───────────────────────────────────────────────────

  describe('seat accounting', () => {
    it('counts the owner as a seat and reads the limit from the OWNER plan', async () => {
      givePremium();
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );

      const view = await service.getGroup(OWNER_ID, GROUP_ID);

      expect(view.seats).toMatchObject({
        used: 2, // owner + 1 member
        limit: 6, // premium familyMembers
        remaining: 4,
        planCode: 'premium',
        wouldBlock: false,
      });
    });

    it('counts outstanding invitations as reserved seats when inviting', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );
      prisma.groupInvite.count.mockResolvedValue(3);
      prisma.groupInvite.upsert.mockResolvedValue(inviteRow());
      const assertSpy = jest.spyOn(entitlements, 'assertWithinLimit');

      await service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email });

      // 2 on the roster + 3 outstanding = 5 seats already spoken for.
      expect(assertSpy).toHaveBeenCalledWith(OWNER_ID, 'familyMembers', 5);
    });

    it('does not count the address being re-invited as a second reserved seat', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupInvite.upsert.mockResolvedValue(inviteRow());

      await service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email });

      const where = firstArg<{ where: Record<string, unknown> }>(
        prisma.groupInvite.count,
      ).where;
      expect(where).toMatchObject({ email: { not: INVITEE.email } });
    });

    it('hides seats and pending invites from members — they reveal the owner plan and third-party emails', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );

      const view = await service.getGroup(INVITEE_ID, GROUP_ID);

      expect(view.seats).toBeNull();
      expect(view.pendingInvites).toBeNull();
      expect(prisma.groupInvite.findMany).not.toHaveBeenCalled();
    });
  });

  describe('with enforcement ON (the future state)', () => {
    beforeEach(() => {
      build({ ENFORCE_PLAN_LIMITS: 'true' });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    it('blocks a free user from creating a group (familyPlan capability)', async () => {
      await expect(
        service.createGroup(OWNER_ID, { name: 'Family' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.group.create).not.toHaveBeenCalled();
    });

    it('blocks an accept that would exceed the owner seats, with an invitee-facing message', async () => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());
      // The owner is on premium (6 seats) and the group is already full.
      prisma.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.ACTIVE,
        plan: { code: 'premium' },
      });
      prisma.groupMember.count.mockResolvedValue(6);

      await expect(
        service.acceptInvite(INVITEE_ID, INVITE_ID),
      ).rejects.toMatchObject({
        response: {
          code: 'PLAN_LIMIT_REACHED',
          limitKey: 'familyMembers',
          limit: 6,
          message: containing('is full'),
        },
      });
      expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    });

    it('still lets a premium owner with room accept', async () => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());
      prisma.subscription.findUnique.mockResolvedValue({
        status: SubscriptionStatus.ACTIVE,
        plan: { code: 'premium' },
      });
      prisma.groupMember.count.mockResolvedValue(2);
      prisma.group.findFirst.mockResolvedValue(groupRow());

      await expect(
        service.acceptInvite(INVITEE_ID, INVITE_ID),
      ).resolves.toBeDefined();
    });
  });

  // ── invitation lifecycle ──────────────────────────────────────────────

  describe('inviteMember', () => {
    beforeEach(() => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupInvite.upsert.mockResolvedValue(inviteRow());
    });

    it('writes an OFFER only — no membership is created', async () => {
      await service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email });

      expect(prisma.groupMember.create).not.toHaveBeenCalled();
      expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
      expect(prisma.groupInvite.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupId_email: { groupId: GROUP_ID, email: INVITEE.email } },
          create: objectWith({
            groupId: GROUP_ID,
            email: INVITEE.email,
          }),
        }),
      );
    });

    it('normalises the address so Grace@Example.com and grace@example.com are one invitation', async () => {
      await service.inviteMember(OWNER_ID, GROUP_ID, {
        email: '  INVITEE@Example.COM ',
      });

      expect(prisma.groupInvite.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupId_email: { groupId: GROUP_ID, email: INVITEE.email } },
        }),
      );
    });

    it('resets a declined invitation instead of stacking a second row', async () => {
      await service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email });

      const args = firstArg<{ update: Record<string, unknown> }>(
        prisma.groupInvite.upsert,
      );
      expect(args.update).toMatchObject({
        status: GroupInviteStatus.PENDING,
        respondedAt: null,
      });
    });

    it('never reveals whether the invited address has an account', async () => {
      // No account for this address: the invitation still succeeds identically.
      prisma.user.findUnique.mockImplementation(
        (args: { where: { id?: string; email?: string } }) =>
          args.where.id ? Promise.resolve(OWNER) : Promise.resolve(null),
      );

      const view = await service.inviteMember(OWNER_ID, GROUP_ID, {
        email: 'nobody@example.com',
      });

      expect(view.status).toBe(GroupInviteStatus.PENDING);
      expect(notifications.sendToUsers).not.toHaveBeenCalled();
    });

    it('pushes a best-effort heads-up when the address does have an account', async () => {
      prisma.user.findUnique.mockImplementation(
        (args: { where: { id?: string; email?: string } }) =>
          args.where.id
            ? Promise.resolve(OWNER)
            : Promise.resolve({ id: INVITEE_ID }),
      );

      await service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email });

      expect(notifications.sendToUsers).toHaveBeenCalledWith(
        [INVITEE_ID],
        objectWith({ title: ANY_STRING }),
      );
    });

    it('does not fail the invitation when the heads-up push blows up', async () => {
      prisma.user.findUnique.mockImplementation(
        (args: { where: { id?: string; email?: string } }) =>
          args.where.id
            ? Promise.resolve(OWNER)
            : Promise.reject(new Error('database down')),
      );

      await expect(
        service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email }),
      ).resolves.toMatchObject({ status: GroupInviteStatus.PENDING });
    });

    it('refuses to invite yourself, with a human message', async () => {
      await expect(
        service.inviteMember(OWNER_ID, GROUP_ID, { email: OWNER.email }),
      ).rejects.toThrow(CANNOT_INVITE_YOURSELF);
    });

    it('refuses to invite someone already on the roster', async () => {
      prisma.groupMember.findFirst.mockResolvedValue({ id: 'member-1' });

      await expect(
        service.inviteMember(OWNER_ID, GROUP_ID, { email: INVITEE.email }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a non-owner member with a 403 that says who can', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );

      await expect(
        service.inviteMember(INVITEE_ID, GROUP_ID, {
          email: 'someone@example.com',
        }),
      ).rejects.toThrow(NOT_GROUP_OWNER);
    });

    it('404s an outsider rather than confirming the group exists', async () => {
      prisma.group.findFirst.mockResolvedValue(null);

      await expect(
        service.inviteMember(OUTSIDER_ID, GROUP_ID, {
          email: 'someone@example.com',
        }),
      ).rejects.toThrow(GROUP_NOT_FOUND);
    });
  });

  describe('acceptInvite', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );
    });

    it('creates the membership and marks the invitation accepted, in one transaction', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());

      await service.acceptInvite(INVITEE_ID, INVITE_ID);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.groupMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupId_userId: { groupId: GROUP_ID, userId: INVITEE_ID } },
        }),
      );
      expect(prisma.groupInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectWith({ status: GroupInviteStatus.ACCEPTED }),
        }),
      );
    });

    it('is idempotent: a double tap upserts one seat', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());

      await service.acceptInvite(INVITEE_ID, INVITE_ID);

      const args = firstArg<{ update: Record<string, unknown> }>(
        prisma.groupMember.upsert,
      );
      expect(args.update).toEqual({});
    });

    it('404s when the invitation was addressed to a different email', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ email: 'someone.else@example.com' }),
      );

      await expect(service.acceptInvite(INVITEE_ID, INVITE_ID)).rejects.toThrow(
        INVITE_NOT_FOUND,
      );
      expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    });

    it('404s an unknown invitation with the identical message — ids are not probeable', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(null);

      await expect(service.acceptInvite(INVITEE_ID, INVITE_ID)).rejects.toThrow(
        INVITE_NOT_FOUND,
      );
    });

    it('refuses an UNVERIFIED account, so nobody can claim a stranger address into a group', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...INVITEE,
        emailVerifiedAt: null,
      });
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());

      await expect(service.acceptInvite(INVITEE_ID, INVITE_ID)).rejects.toThrow(
        VERIFY_EMAIL_FIRST,
      );
      expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    });

    it('410s an expired invitation and tells them to ask for a new one', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ expiresAt: new Date(Date.now() - HOUR) }),
      );

      const failure = service.acceptInvite(INVITEE_ID, INVITE_ID);
      await expect(failure).rejects.toBeInstanceOf(GoneException);
      await expect(failure).rejects.toThrow(INVITE_EXPIRED);
    });

    it('409s a revoked invitation', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ status: GroupInviteStatus.REVOKED }),
      );

      await expect(
        service.acceptInvite(INVITEE_ID, INVITE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s a second accept of an already-accepted invitation', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ status: GroupInviteStatus.ACCEPTED }),
      );

      await expect(service.acceptInvite(INVITEE_ID, INVITE_ID)).rejects.toThrow(
        INVITE_ALREADY_ACCEPTED,
      );
    });
  });

  describe('declineInvite', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
    });

    it('marks it declined and creates no membership', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(inviteRow());

      await service.declineInvite(INVITEE_ID, INVITE_ID);

      expect(prisma.groupInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectWith({ status: GroupInviteStatus.DECLINED }),
        }),
      );
      expect(prisma.groupMember.upsert).not.toHaveBeenCalled();
    });

    it('is idempotent when already declined', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ status: GroupInviteStatus.DECLINED }),
      );

      await expect(
        service.declineInvite(INVITEE_ID, INVITE_ID),
      ).resolves.toBeUndefined();
      expect(prisma.groupInvite.update).not.toHaveBeenCalled();
    });

    it('lets someone dismiss an expired invitation without an error', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ expiresAt: new Date(Date.now() - HOUR) }),
      );

      await expect(
        service.declineInvite(INVITEE_ID, INVITE_ID),
      ).resolves.toBeUndefined();
    });

    it('404s an invitation addressed to someone else', async () => {
      prisma.groupInvite.findUnique.mockResolvedValue(
        inviteRow({ email: 'someone.else@example.com' }),
      );

      await expect(
        service.declineInvite(INVITEE_ID, INVITE_ID),
      ).rejects.toThrow(INVITE_NOT_FOUND);
    });
  });

  describe('listMyInvites', () => {
    it('matches on the caller verified email and hides expired ones', async () => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);

      await service.listMyInvites(INVITEE_ID);

      const where = firstArg<{ where: Record<string, unknown> }>(
        prisma.groupInvite.findMany,
      ).where;
      expect(where).toMatchObject({
        email: INVITEE.email,
        status: GroupInviteStatus.PENDING,
        expiresAt: { gt: ANY_DATE },
      });
    });

    it('refuses an unverified account with a message that says why', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...INVITEE,
        emailVerifiedAt: null,
      });

      await expect(service.listMyInvites(INVITEE_ID)).rejects.toThrow(
        VERIFY_EMAIL_FIRST,
      );
    });

    it('shows the group name and owner name, never any member email', async () => {
      prisma.user.findUnique.mockResolvedValue(INVITEE);
      prisma.groupInvite.findMany.mockResolvedValue([
        {
          ...inviteRow(),
          group: {
            id: GROUP_ID,
            name: 'Family',
            owner: { name: 'Ada' },
            _count: { members: 3 },
          },
        },
      ]);

      const [invite] = await service.listMyInvites(INVITEE_ID);

      expect(invite).toEqual({
        id: INVITE_ID,
        groupId: GROUP_ID,
        groupName: 'Family',
        invitedByName: 'Ada',
        memberCount: 3,
        expiresAt: ANY_DATE,
        createdAt: ANY_DATE,
      });
      expect(JSON.stringify(invite)).not.toContain('@');
    });
  });

  describe('revokeInvite', () => {
    it('withdraws only a still-pending invitation on the owner group', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());

      await service.revokeInvite(OWNER_ID, GROUP_ID, INVITE_ID);

      expect(prisma.groupInvite.updateMany).toHaveBeenCalledWith({
        where: {
          id: INVITE_ID,
          groupId: GROUP_ID,
          status: GroupInviteStatus.PENDING,
        },
        data: objectWith({ status: GroupInviteStatus.REVOKED }),
      });
    });

    it('404s when there was nothing open to withdraw', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.revokeInvite(OWNER_ID, GROUP_ID, INVITE_ID),
      ).rejects.toThrow(INVITE_NOT_FOUND);
    });
  });

  // ── membership is revocable from both ends ────────────────────────────

  describe('removeMember / leaveGroup', () => {
    it('lets the owner remove a member', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());

      await service.removeMember(OWNER_ID, GROUP_ID, INVITEE_ID);

      expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({
        where: {
          groupId: GROUP_ID,
          userId: INVITEE_ID,
          role: GroupMemberRole.MEMBER,
        },
      });
    });

    it('404s removing someone who is not in the group', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.removeMember(OWNER_ID, GROUP_ID, OUTSIDER_ID),
      ).rejects.toThrow(MEMBER_NOT_FOUND);
    });

    it('refuses to let the owner remove themselves, and says what to do instead', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());

      await expect(
        service.removeMember(OWNER_ID, GROUP_ID, OWNER_ID),
      ).rejects.toThrow(OWNER_CANNOT_BE_REMOVED);
    });

    it('lets a member leave under their own steam', async () => {
      prisma.groupMember.findUnique.mockResolvedValue({
        role: GroupMemberRole.MEMBER,
      });

      await service.leaveGroup(INVITEE_ID, GROUP_ID);

      expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({
        where: { groupId: GROUP_ID, userId: INVITEE_ID },
      });
    });

    it('refuses to let the owner leave, and points at delete', async () => {
      prisma.groupMember.findUnique.mockResolvedValue({
        role: GroupMemberRole.OWNER,
      });

      const failure = service.leaveGroup(OWNER_ID, GROUP_ID);
      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(OWNER_CANNOT_LEAVE);
    });
  });

  describe('createGroup', () => {
    it('maps the one-group-per-owner unique violation to a clear conflict', async () => {
      prisma.group.create.mockRejectedValue(prismaError('P2002'));

      const failure = service.createGroup(OWNER_ID, { name: 'Second' });
      await expect(failure).rejects.toBeInstanceOf(ConflictException);
      await expect(failure).rejects.toThrow(ALREADY_OWN_A_GROUP);
    });

    it('seats the creator as OWNER in the same write', async () => {
      prisma.group.create.mockResolvedValue(groupRow());

      await service.createGroup(OWNER_ID, { name: '  Family  ' });

      const args = firstArg<{ data: Record<string, unknown> }>(
        prisma.group.create,
      );
      expect(args.data).toMatchObject({
        ownerId: OWNER_ID,
        name: 'Family',
        members: { create: { userId: OWNER_ID, role: GroupMemberRole.OWNER } },
      });
    });
  });

  // ── THE PRIVACY GATE ──────────────────────────────────────────────────

  describe('privacy', () => {
    it('exposes only display identity on the roster — no email, phone or location', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([
          memberRow(OWNER_ID, GroupMemberRole.OWNER, 'Ada'),
          memberRow(INVITEE_ID, GroupMemberRole.MEMBER, 'Grace'),
        ]),
      );

      const members = await service.listMembers(INVITEE_ID, GROUP_ID);

      expect(Object.keys(members[0]).sort()).toEqual([
        'avatarUrl',
        'isYou',
        'joinedAt',
        'name',
        'role',
        'userId',
      ]);
      const serialized = JSON.stringify(members);
      expect(serialized).not.toContain('@');
      expect(serialized).not.toMatch(/lat|lng|phone|trip|presence/i);
    });

    it('routes group fan-out through the SAME mutual-consent gate as trusted contacts', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupMember.findMany.mockResolvedValue([
        { userId: INVITEE_ID },
        { userId: OUTSIDER_ID },
      ]);
      // Only one of the two groupmates has added the caller back.
      users.filterConsentingContactUserIds.mockResolvedValue([INVITEE_ID]);

      const recipients = await service.getConsentingGroupMemberUserIds(
        OWNER_ID,
        GROUP_ID,
      );

      expect(users.filterConsentingContactUserIds).toHaveBeenCalledWith(
        OWNER_ID,
        [INVITEE_ID, OUTSIDER_ID],
      );
      // Being in the group is NOT enough: the non-reciprocating member is out.
      expect(recipients).toEqual([INVITEE_ID]);
      expect(recipients).not.toContain(OUTSIDER_ID);
    });

    it('returns nobody when no groupmate has reciprocated — a group alone shares nothing', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupMember.findMany.mockResolvedValue([
        { userId: INVITEE_ID },
        { userId: OUTSIDER_ID },
      ]);
      users.filterConsentingContactUserIds.mockResolvedValue([]);

      await expect(
        service.getConsentingGroupMemberUserIds(OWNER_ID, GROUP_ID),
      ).resolves.toEqual([]);
    });

    it('never asks the consent gate about the caller themselves', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());
      prisma.groupMember.findMany.mockResolvedValue([]);
      users.filterConsentingContactUserIds.mockResolvedValue([]);

      await service.getConsentingGroupMemberUserIds(OWNER_ID, GROUP_ID);

      const where = firstArg<{ where: Record<string, unknown> }>(
        prisma.groupMember.findMany,
      ).where;
      expect(where).toMatchObject({ userId: { not: OWNER_ID } });
      expect(users.filterConsentingContactUserIds).not.toHaveBeenCalled();
    });

    it('refuses the fan-out helper to a non-member, without confirming the group exists', async () => {
      prisma.group.findFirst.mockResolvedValue(null);

      const failure = service.getConsentingGroupMemberUserIds(
        OUTSIDER_ID,
        GROUP_ID,
      );
      await expect(failure).rejects.toBeInstanceOf(NotFoundException);
      await expect(failure).rejects.toThrow(GROUP_NOT_FOUND);
    });

    it('scopes every group read to the caller membership', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow());

      await service.getGroup(OWNER_ID, GROUP_ID);

      const where = firstArg<{ where: Record<string, unknown> }>(
        prisma.group.findFirst,
      ).where;
      expect(where).toMatchObject({
        id: GROUP_ID,
        members: { some: { userId: OWNER_ID } },
      });
    });
  });
});
