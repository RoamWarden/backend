import type { CapabilityKey } from '../../../common/entitlements';

export const TRIP_NOT_FOUND_MSG =
  'Trip not found — check the trip id and make sure the trip belongs to you, or omit tripId to use your current active trip.';
export const SOS_NOT_FOUND_MSG =
  'SOS event not found — check the id and make sure it belongs to your account.';
export const NO_CONTACTS_WARNING =
  'You have no trusted contacts yet — add some so SOS can reach them. If you are in danger, contact local emergency services now.';
export const NO_LINKED_CONTACTS_WARNING =
  'None of your trusted contacts are linked RoamWarden users, so no one could be notified in-app. If you are in danger, contact local emergency services now.';
export const NOTIFY_FAILED_WARNING =
  'Your SOS was recorded, but we could not notify your contacts because of a server error. If you are in danger, contact local emergency services now.';

// ────────────────────── priority SOS (Premium capability) ──────────────────────
//
// Priority SOS adds RELIABILITY on top of the standard alert every user already
// gets: failed deliveries are retried with backoff, unanswered ones escalate to
// the next trusted contact, and every attempt is written to an audit trail.
//
// It adds NOTHING to the emergency-services story, because there is none.
// RoamWarden never contacts the authorities — priority or not, it pages the
// traveller's OWN trusted contacts, and says so in every message it sends.

/** The capability that decides who gets the escalation ladder. */
export const PRIORITY_SOS_CAPABILITY: CapabilityKey = 'prioritySos';

/**
 * How long after the immediate broadcast the ladder makes its first escalation.
 *
 * Every SOS still alerts EVERY consenting contact at once, immediately — that
 * is the standard path, and the ladder never delays or replaces it. This delay
 * exists so a contact who is already picking up the phone is not paged again a
 * second later: long enough to answer, short enough to still matter.
 */
export const SOS_ESCALATION_FIRST_DELAY_MS = 60_000;

/**
 * Wait after a contact has been paged before moving to the next one. If nobody
 * has acknowledged by then, the ladder steps down the contact list.
 */
export const SOS_ESCALATION_ROUND_DELAY_MS = 120_000;

/**
 * Backoff before RETRYING the same contact after a failed delivery, indexed by
 * the attempts already made at that contact. A failure here means "we could not
 * hand it to their device" (no registration, expired token, provider error) — a
 * transient class of problem worth retrying, unlike a silent recipient.
 */
export const SOS_ESCALATION_RETRY_BACKOFF_MS: readonly number[] = [
  15_000, 45_000, 120_000,
];

/**
 * Move on to the next contact quickly when this one cannot be reached at all —
 * a dead end must not cost the traveller a full round delay.
 */
export const SOS_ESCALATION_ADVANCE_DELAY_MS = 10_000;

/** Attempts at one contact before the ladder gives up on them and moves on. */
export const SOS_ESCALATION_MAX_ATTEMPTS_PER_CONTACT = 3;

/**
 * Absolute cap on attempts for one SOS. A safety feature that pages forever is
 * a nuisance that gets muted, which makes the NEXT SOS less safe.
 */
export const SOS_ESCALATION_MAX_ATTEMPTS = 12;

/** Absolute wall-clock cap on one ladder, however few attempts it has made. */
export const SOS_ESCALATION_MAX_DURATION_MS = 30 * 60 * 1000;

/** Escalations processed per sweep — bounds the work in one cron tick. */
export const SOS_ESCALATION_SWEEP_LIMIT = 200;

/**
 * How long a sweeper "owns" an escalation after claiming it. The claim is a
 * conditional UPDATE that pushes `nextAttemptAt` into the future, so a second
 * API instance sweeping in the same second cannot page the same contact twice.
 */
export const SOS_ESCALATION_LEASE_MS = 30_000;

/** Trail `round` value for the immediate broadcast every SOS performs. */
export const SOS_BROADCAST_ROUND = 0;

export const SOS_ACK_NOT_FOUND_MSG =
  'SOS not found — check the link, and make sure you are one of this person’s trusted contacts.';

/**
 * On every escalation push and on the trail. RoamWarden is not an emergency
 * service and must never let anyone believe otherwise — least of all someone
 * being paged about a person in trouble.
 */
export const SOS_NOT_EMERGENCY_SERVICE_NOTICE =
  'RoamWarden alerts trusted contacts only — it cannot contact emergency services. If someone is in danger, call local emergency services.';

/** Push title for an escalation round. */
export function escalationPushTitle(name: string): string {
  return `🆘 ${name} still needs help`;
}

/** Push body for an escalation round. `rank` is the 0-based ladder position. */
export function escalationPushBody(
  name: string,
  rank: number,
  travellerMessage?: string,
): string {
  const lead =
    rank === 0
      ? `${name} raised an SOS and no one has responded yet.`
      : `${name} raised an SOS and their earlier contacts have not responded yet.`;
  const detail = travellerMessage ? ` They said: “${travellerMessage}”` : '';
  return `${lead}${detail} Please check on them — RoamWarden cannot call emergency services.`;
}

/** Push copy telling the traveller a contact has seen their SOS. */
export function ackPushBody(contactName: string): string {
  return `${contactName} has seen your SOS and knows you need help. If you are in danger, keep trying local emergency services too.`;
}

/**
 * Push copy telling the traveller nobody could be reached. This is a hard thing
 * to say, and it gets said plainly — silence here is the worst possible outcome
 * for a safety feature.
 */
export const ESCALATION_EXHAUSTED_TITLE = 'No one has answered your SOS';
export const ESCALATION_EXHAUSTED_BODY =
  'We could not get a response from any of your trusted contacts. Please call local emergency services or someone nearby.';
