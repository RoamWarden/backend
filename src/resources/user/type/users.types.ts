import type { Prisma, User } from '@prisma/client';
import type { CONTACT_USER_SELECT } from '../constant/users.constants';

/** Trusted contact plus the safe subset of its linked user's profile. */
export type ContactWithLinkedUser = Prisma.TrustedContactGetPayload<{
  include: typeof CONTACT_USER_SELECT;
}>;

/** Public profile shape — never exposes googleSub or passwordHash. */
export type UserProfile = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'avatarUrl'
  | 'phone'
  | 'reputation'
  | 'isAdmin'
  | 'createdAt'
  | 'updatedAt'
>;

export interface ProfileWithCounts extends UserProfile {
  counts: { trips: number; reports: number; contacts: number };
}
