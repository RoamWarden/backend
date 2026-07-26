import type { Prisma, User } from '@prisma/client';
import type {
  CONTACT_GROUP_MEMBERS_INCLUDE,
  CONTACT_USER_SELECT,
} from '../constant/users.constants';

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

/**
 * One page of the caller's own contacts.
 *
 * `data` carries exactly the same objects as the unpaginated
 * `GET /me/contacts`, so a client can move between the two routes without a
 * second mapper.
 */
export interface PaginatedContacts {
  data: ContactWithLinkedUser[];
  page: number;
  limit: number;
  /** Rows matching the search, NOT the size of this page. */
  total: number;
}

/** A contact group row with just its membership ids attached. */
export type ContactGroupWithMembers = Prisma.ContactGroupGetPayload<{
  include: typeof CONTACT_GROUP_MEMBERS_INCLUDE;
}>;

/**
 * A contact group as the API returns it.
 *
 * `memberCount` is redundant with `contactIds.length` on purpose: a list screen
 * shows "4 people" without caring which four, and shipping the number means it
 * never has to reach into an array to render a label.
 */
export interface ContactGroupView {
  id: string;
  name: string;
  favorite: boolean;
  memberCount: number;
  contactIds: string[];
  createdAt: Date;
}

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

/**
 * The only shape of another person's account this API ever hands out.
 * Deliberately the same three fields the contact list already exposes for a
 * linked user (`CONTACT_USER_SELECT`): enough to recognise a face and a name,
 * nothing that could be harvested.
 */
export interface PublicContactUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Result of POST /me/contacts/lookup. Both arms are HTTP 200 — "there is no
 * account with that email" is an ordinary answer, not a failure — and both
 * carry a `message` the app can show verbatim.
 *
 * `alreadyAdded` / `existingContactId` describe the CALLER's own contact list,
 * never the matched user's, so they leak nothing about the other person. In
 * particular this never says whether they have added the caller back: that
 * reciprocity is their private business, and the mutual-consent gate in
 * {@link UsersService.filterConsentingContactUserIds} enforces it server-side
 * regardless of what the client knows.
 */
export type ContactUserLookupResult =
  | {
      found: true;
      user: PublicContactUser;
      /** True when this account is already one of the caller's contacts. */
      alreadyAdded: boolean;
      /** Id of that existing TrustedContact row, so the app can open it. */
      existingContactId: string | null;
      message: string;
    }
  | {
      found: false;
      user: null;
      alreadyAdded: false;
      existingContactId: null;
      message: string;
    };
