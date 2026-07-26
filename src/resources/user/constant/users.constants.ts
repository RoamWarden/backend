/** Validation and lookup messages shared by trusted-contact operations. */
export const CONTACT_NEEDS_REACHABLE_FIELD =
  'A contact needs at least a phone number, email, or linked RoamWarden user.';

export const CONTACT_NOT_FOUND =
  'No such contact in your trusted contacts list. It may have been deleted, or the id belongs to another account — list your contacts with GET /me/contacts.';

export const DUPLICATE_LINKED_CONTACT =
  'That RoamWarden user is already one of your trusted contacts. Edit the existing contact instead of adding a second one.';

/**
 * A `contactUserId` that resolves to nobody. Nobody types this id by hand any
 * more — the app gets it from POST /me/contacts/lookup — so the only realistic
 * causes are a stale lookup result or an account deleted mid-flow. The message
 * therefore points at the two things a human can actually do, and never quotes
 * the raw uuid back at them.
 */
export const LINKED_USER_NOT_FOUND =
  "That RoamWarden account no longer exists — it may have been deleted. Search for the person by email again, or save them as a contact you'll reach yourself.";

export const CONTACT_SELF_LINK =
  "You can't add yourself as your own trusted contact. Search for the email of the person you want to add.";

// ── trusted-contact lookup by email ─────────────────────────────────────

/**
 * Everything POST /me/contacts/lookup may reveal about a matched account.
 *
 * This is the WHOLE point of the endpoint being safe: id (so the app can link),
 * name and avatar (so the person adding can confirm they found the right
 * human). Never the email back, never phone, never reputation, never counts,
 * never anything about their trips or their own contacts. Widening this select
 * widens an account-enumeration surface — don't.
 */
export const CONTACT_LOOKUP_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
} as const;

/**
 * Per-account lookup budget: 20 per hour.
 *
 * Stricter than every auth route (the tightest is 5 per 15 min = 20/h, and
 * login is 10 per 15 min = 40/h) and ~300× stricter than the global default of
 * 100/min. An email lookup is an oracle for "does this address have an account",
 * so an unbounded version would let someone replay a breached email list against
 * our user base. 20/h still covers a real person adding their five free
 * contacts, typos included, in one sitting.
 *
 * Enforced TWICE, because each layer alone has a hole:
 *  - `@Throttle` on the route → per IP, but the global ThrottlerGuard runs
 *    before JwtAuthGuard, so it cannot see who is asking; a botnet defeats it.
 *  - {@link UsersService.lookupContactUserByEmail} → per ACCOUNT via Redis,
 *    which survives IP rotation. One attacker, one account, 20 guesses an hour.
 */
export const CONTACT_LOOKUP_MAX_PER_WINDOW = 20;
export const CONTACT_LOOKUP_WINDOW_S = 3600;

/** Route-level (per-IP) form of the same budget, for `@Throttle`. */
export const CONTACT_LOOKUP_THROTTLE = {
  limit: CONTACT_LOOKUP_MAX_PER_WINDOW,
  ttl: CONTACT_LOOKUP_WINDOW_S * 1000,
};

/** Redis fixed-window key for the per-account lookup budget. */
export const contactLookupQuotaKey = (userId: string): string =>
  `contact-lookup:${userId}`;

export const CONTACT_LOOKUP_RATE_LIMITED =
  "You've searched for a lot of people in a short time. Wait an hour and try again — or add this person as a contact you'll reach yourself.";

/**
 * Machine-readable code for "you looked up your own email". Shipped in the
 * error BODY alongside a human `message`, exactly like `NO_ACCOUNT` above, so
 * the app can branch on the code and never on the sentence.
 */
export const CONTACT_LOOKUP_SELF_CODE = 'SELF_LOOKUP';

export const CONTACT_LOOKUP_SELF =
  "That's your own account. Search for the email of the person you want to add as a trusted contact.";

/**
 * NOT an error. "No account with that email" is a completely normal outcome —
 * most people's mum is not on RoamWarden — so it comes back 200 with this
 * message and a next step, never a 404 the UI has to dress up as a failure.
 */
export const CONTACT_LOOKUP_NO_ACCOUNT =
  "No RoamWarden account uses that email — you can still save them as a contact you'll reach yourself.";

export const contactLookupFound = (name: string): string =>
  `${name} is on RoamWarden. Linking them means they get your trip and SOS alerts in the app.`;

/**
 * Found, but already in the caller's list. This is derived from the CALLER's
 * own rows, so it reveals nothing about the other account — and it saves the
 * app walking someone through a form that would only 409 on submit.
 */
export const contactLookupAlreadyAdded = (name: string): string =>
  `${name} is already one of your trusted contacts.`;

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

/**
 * Machine-readable code for "that Google identity has no RoamWarden account and
 * this caller is not allowed to create one" (login-only sign-in, i.e. the
 * website). Shipped in the error BODY, alongside a human `message`, exactly like
 * the login flow's `EMAIL_NOT_VERIFIED` — clients branch on the code, never on
 * the sentence. Deliberately NOT a bare 401: web clients read 401 as "dead
 * session" and would bounce into a refresh/redirect loop.
 */
export const GOOGLE_NO_ACCOUNT_CODE = 'NO_ACCOUNT';

/**
 * Accounts are built in the RoamWarden app — that is where the email is
 * verified, the push token is registered and trusted contacts are added. A
 * web-created account would be a half-configured shell, so we send them there.
 */
export const googleNoAccount = (email: string): string =>
  `There's no RoamWarden account for ${email} yet. Create one in the RoamWarden app first — that's where your email is verified and your trusted contacts are set up — then come back and sign in with Google.`;

/** Safe linked-user projection: never expose the linked user's email or phone. */
export const CONTACT_USER_SELECT = {
  contactUser: { select: { id: true, name: true, avatarUrl: true } },
} as const;

// ── paging + search over the caller's own contacts ──────────────────────

/**
 * Page size for `GET /me/contacts/page`. 10 fills a phone screen; 50 is the
 * ceiling so a client cannot turn the paged route back into an unbounded dump
 * of every contact — that is what the (deliberately unpaginated) legacy
 * `GET /me/contacts` is for, and it is capped by human behaviour instead.
 */
export const CONTACT_PAGE_DEFAULT_LIMIT = 10;
export const CONTACT_PAGE_MAX_LIMIT = 50;

/**
 * Favourites first, then A-Z, then id.
 *
 * The trailing `id` is NOT decoration: two contacts called "Mum" would
 * otherwise have no defined relative order, and Postgres is free to return
 * them differently on each query. With `skip`/`take` that means a row can be
 * shown twice and another never shown at all as the user pages. A total order
 * — and `id` is unique, so this is one — makes paging stable.
 */
export const CONTACT_PAGE_ORDER_BY = [
  { favorite: 'desc' },
  { name: 'asc' },
  { id: 'asc' },
] as const;

// ── contact groups ──────────────────────────────────────────────────────

export const CONTACT_GROUP_NAME_MAX_LENGTH = 60;

/**
 * Membership projection for a group view. Only the contact ids: the group list
 * is a picker, and re-serialising every contact inside every group would make
 * a screen that already calls `GET /me/contacts` pay for the same rows twice.
 * Ordered by id so `contactIds` is deterministic across calls.
 */
export const CONTACT_GROUP_MEMBERS_INCLUDE = {
  members: { select: { contactId: true }, orderBy: { contactId: 'asc' } },
} as const;

/** Same ordering rationale as {@link CONTACT_PAGE_ORDER_BY}. */
export const CONTACT_GROUP_ORDER_BY = [
  { favorite: 'desc' },
  { name: 'asc' },
  { id: 'asc' },
] as const;

/**
 * Deliberately the same 404 wording style as {@link CONTACT_NOT_FOUND}: a group
 * id belonging to somebody else gets this, NOT a 403, so the endpoint never
 * confirms that an id it refuses is an id that exists.
 */
export const CONTACT_GROUP_NOT_FOUND =
  'No such contact group in your account. It may have been deleted, or the id belongs to another account — list your groups with GET /me/contact-groups.';

/**
 * Duplicate group name. Quotes the name that is ALREADY stored (not what the
 * caller typed), so someone who types "family" when they already have "Family"
 * can see why it clashed.
 */
export const duplicateContactGroupName = (existingName: string): string =>
  `You already have a contact group called "${existingName}". Pick a different name, or edit that group instead.`;

/**
 * Contact ids that are not the caller's. Worded and shaped exactly like the
 * watcher-contact check in TripsService.createTrip, because it is the same
 * mistake from the app's point of view: a stale id in a list picker.
 */
export const contactIdsNotYours = (badIds: string[]): string =>
  `These contact ids are not in your trusted contacts: ${badIds.join(', ')}. Remove them or add the contacts first.`;
