import type {
  GroupInviteStatus,
  GroupMemberRole,
  Prisma,
} from '@prisma/client';
import type { LimitValue } from '../../../common/entitlements';
import type { GROUP_WITH_MEMBERS_INCLUDE } from '../constant/groups.constants';

/**
 * Wire shapes for the family/group plan (build plan §20).
 *
 * WHAT A GROUP VIEW MAY CONTAIN — the rule these types encode:
 *   • a groupmate's id, display name and avatar. That is the entire roster.
 *   • NEVER a location, trip, presence flag, SOS, email address or phone
 *     number of another member.
 * Pending invitations carry a third party's email address, so they are visible
 * to the OWNER only (`pendingInvites` is null for everyone else).
 */

/** Group row joined to its roster, as every view is built from. */
export type GroupWithMembers = Prisma.GroupGetPayload<{
  include: typeof GROUP_WITH_MEMBERS_INCLUDE;
}>;

/** The caller's own account facts needed to match invitations. */
export interface AccountFacts {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}

/** One person on the roster. Display identity only — see the note above. */
export interface GroupMemberView {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: GroupMemberRole;
  joinedAt: Date;
  /** True for the caller's own row, so clients can render "You" without a compare. */
  isYou: boolean;
}

/** An invitation as the OWNER sees it (it contains the invited address). */
export interface GroupInviteView {
  id: string;
  email: string;
  status: GroupInviteStatus;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * An invitation as the INVITEE sees it: enough to decide (which group, who
 * runs it, how many people are in it) and nothing more. Deliberately no member
 * roster and no email addresses — you should not learn who is in a group you
 * have not joined.
 */
export interface PendingInviteView {
  id: string;
  groupId: string;
  groupName: string;
  /** Display name of the group owner. Never their email address. */
  invitedByName: string;
  memberCount: number;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Seat accounting, straight from the entitlement limits table — INFORMATION,
 * not a lock.
 *
 * `enforced` is false today (ENFORCE_PLAN_LIMITS is off), and while it is false
 * clients MUST NOT hide the invite button, grey out a row, or cap a list. Show
 * "3 of 6 seats used" and let every action through: `wouldBlock` describes a
 * hypothetical future, not the present.
 *
 * The numbers come from the OWNER's plan, so they are returned to the owner
 * only — a member has no business learning whether someone else pays us.
 */
export interface GroupSeatsView {
  /** People on the roster right now, owner included. */
  used: number;
  /** Seats the plan allows. `null` = unlimited. */
  limit: LimitValue;
  /** Seats left. `null` = unlimited. Never negative. */
  remaining: LimitValue;
  /** Plan the numbers came from (the owner's entitled plan). */
  planCode: string;
  /** Whether the server enforces this today. False = show, never block. */
  enforced: boolean;
  /** Would one more member be refused if enforcement were switched on? */
  wouldBlock: boolean;
  /** Human sentence to show alongside the numbers when `wouldBlock`. */
  message: string | null;
}

/** A group in a list. */
export interface GroupSummaryView {
  id: string;
  name: string;
  /** The CALLER's role in this group. */
  role: GroupMemberRole;
  memberCount: number;
  createdAt: Date;
}

/** A single group with its roster. */
export interface GroupDetailView extends GroupSummaryView {
  members: GroupMemberView[];
  /**
   * Outstanding invitations. Owner-only — they contain the email addresses of
   * people who have not agreed to be associated with this group yet. `null`
   * means "you are not the owner", not "there are none".
   */
  pendingInvites: GroupInviteView[] | null;
  /** Seat accounting on the OWNER's plan. Owner-only; `null` for members. */
  seats: GroupSeatsView | null;
}
