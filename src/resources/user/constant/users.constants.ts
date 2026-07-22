/** Validation and lookup messages shared by trusted-contact operations. */
export const CONTACT_NEEDS_REACHABLE_FIELD =
  'A contact needs at least a phone number, email, or linked RoamWarden user.';

export const CONTACT_NOT_FOUND =
  'No such contact in your trusted contacts list. It may have been deleted, or the id belongs to another account — list your contacts with GET /me/contacts.';

export const DUPLICATE_LINKED_CONTACT =
  'That RoamWarden user is already one of your trusted contacts. Edit the existing contact instead of adding a second one.';

/** Safe linked-user projection: never expose the linked user's email or phone. */
export const CONTACT_USER_SELECT = {
  contactUser: { select: { id: true, name: true, avatarUrl: true } },
} as const;
