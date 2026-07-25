import type { Prisma, User } from '@prisma/client';
import type { CONTACT_USER_SELECT } from '../constant/users.constants';

/**
 * Verified Google identity handed to {@link UsersService.upsertFromGoogle}.
 * Structurally identical to the auth module's `GoogleProfile` so the controller
 * can pass one straight through, without the user module importing from auth.
 */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /**
   * Google's `email_verified` claim. Linking a Google identity onto an account
   * that already exists is only safe when this is true — see upsertFromGoogle.
   */
  emailVerified: boolean;
}

/** Options for {@link UsersService.upsertFromGoogle}. */
export interface GoogleUpsertOptions {
  /**
   * May a verified Google identity that matches no existing user CREATE an
   * account? Defaults to `true` — the mobile app's behaviour, unchanged.
   *
   * `false` is login-only mode (the website): an unknown identity is refused
   * with 404 `{ code: 'NO_ACCOUNT' }` and nothing is written. It does NOT
   * affect accounts that already exist — signing in, and linking Google onto an
   * email + password account, work identically in both modes.
   */
  allowSignup?: boolean;
}

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
