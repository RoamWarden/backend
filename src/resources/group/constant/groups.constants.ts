/**
 * Family / group plan constants and copy (build plan §20).
 *
 * Every message here is written for a human being who is stuck. None of them
 * is a bare status code, and none of them can be reached today by a limit:
 * seat and capability gates only throw while ENFORCE_PLAN_LIMITS is on, and it
 * is off.
 */

/** Longest group name we accept. Long enough for "The Okonkwo family trip". */
export const GROUP_NAME_MAX_LENGTH = 60;

/** Practical maximum length of an email address (RFC 5321 path limit). */
export const INVITE_EMAIL_MAX_LENGTH = 254;

/**
 * How long an unanswered invitation stays actionable (14 days).
 *
 * Invitations rot on purpose: a group invite that never expires is a standing
 * offer to join a roster the invitee may have forgotten about, sitting in a
 * database indefinitely. Expiry is COMPUTED from `expiresAt` at read time —
 * there is no cron to fall behind and no status to drift out of date.
 */
export const GROUP_INVITE_TTL_S = 14 * 24 * 60 * 60;

/**
 * Safe roster projection. A group member may see a groupmate's display name
 * and avatar — nothing else. NEVER add email, phone, reputation or anything
 * positional here: this select is the whole reason a roster cannot become a
 * contact-details dump.
 */
export const GROUP_MEMBER_USER_SELECT = {
  user: { select: { id: true, name: true, avatarUrl: true } },
} as const;

/** Group + roster, the shape every group view is built from. */
export const GROUP_WITH_MEMBERS_INCLUDE = {
  members: { include: GROUP_MEMBER_USER_SELECT },
} as const;

// ── messages ──────────────────────────────────────────────────────────────

export const ACCOUNT_NOT_FOUND =
  'Your account could not be found — it may have been deleted. Please sign in again.';

export const GROUP_NOT_FOUND =
  "That group doesn't exist, or you're not in it. List the groups you belong to with GET /groups.";

export const NOT_GROUP_OWNER =
  'Only the group owner can do that. Ask whoever created the group to make the change.';

export const ALREADY_OWN_A_GROUP =
  'You already have a group. Everyone you travel with shares one group, so rename or reuse the one you have — or delete it and start again.';

export const CANNOT_INVITE_YOURSELF =
  "You're already in your own group, so there's nothing to accept. Invite the email address of the person you want to add.";

export const INVITE_NOT_FOUND =
  "That invitation isn't available — it may have been withdrawn, already answered, or sent to a different email address. Check GET /groups/invites for the invitations waiting for you.";

export const INVITE_EXPIRED =
  'That invitation has expired. Ask the group owner to send you a new one.';

export const INVITE_ALREADY_ACCEPTED =
  "You've already joined that group. Open it from GET /groups, or leave it if you'd rather not be a member.";

export const INVITE_ALREADY_ANSWERED =
  'That invitation is no longer open — it was already answered or withdrawn. Ask the group owner to send a new one.';

export const VERIFY_EMAIL_FIRST =
  "Confirm your email address before joining a group. Invitations are matched to a verified address so nobody can be added to a stranger's group by mistake.";

export const MEMBER_NOT_FOUND =
  "That person isn't a member of this group. Check the roster with GET /groups/:groupId/members.";

export const OWNER_CANNOT_BE_REMOVED =
  "You can't remove yourself as the owner. Delete the group instead — that removes everyone, including you.";

export const OWNER_CANNOT_LEAVE =
  "You own this group, so you can't leave it. Delete the group instead (that removes everyone), or remove the members you no longer travel with.";

export const NOT_A_MEMBER =
  "You're not a member of that group, so there's nothing to leave.";

/** The invited address is already on the roster. */
export const alreadyAMember = (email: string): string =>
  `${email} is already in this group. Check the roster with GET /groups/:groupId/members.`;

/**
 * Shown to an INVITEE whose acceptance would exceed the owner's seats. Written
 * for them, not for the owner — they cannot upgrade someone else's plan, so the
 * only useful instruction is "ask the owner".
 *
 * UNREACHABLE TODAY: seat checks only block while ENFORCE_PLAN_LIMITS is on.
 */
export const groupFullMessage = (groupName: string, limit: number): string =>
  `"${groupName}" is full — it already has all ${limit} seats its plan allows. Ask the group owner to free a seat or upgrade to Premium, then try again.`;
