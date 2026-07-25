/** Validation and lookup messages shared by trusted-contact operations. */
export const CONTACT_NEEDS_REACHABLE_FIELD =
  'A contact needs at least a phone number, email, or linked RoamWarden user.';

export const CONTACT_NOT_FOUND =
  'No such contact in your trusted contacts list. It may have been deleted, or the id belongs to another account — list your contacts with GET /me/contacts.';

export const DUPLICATE_LINKED_CONTACT =
  'That RoamWarden user is already one of your trusted contacts. Edit the existing contact instead of adding a second one.';

/**
 * The email is already linked to a *different* Google identity — the only
 * genuine conflict during Google sign-in. (A password-only account with the
 * same email is not a conflict: it gets linked.)
 */
export const googleEmailLinkedElsewhere = (email: string): string =>
  `${email} is already connected to a different Google account on RoamWarden. Sign in with the Google account you first used for ${email}, or contact support.`;

/**
 * Google would not vouch for the address, so we refuse to hand over an existing
 * account. Fail closed: an unverified `email_verified` claim is exactly how an
 * attacker would try to take over someone else's password account.
 */
export const googleEmailNotVerified = (email: string): string =>
  `Google hasn't confirmed that ${email} belongs to you, so we can't connect it to the existing RoamWarden account. Verify the address with Google, or sign in with your email and password instead.`;

/** Safe linked-user projection: never expose the linked user's email or phone. */
export const CONTACT_USER_SELECT = {
  contactUser: { select: { id: true, name: true, avatarUrl: true } },
} as const;
