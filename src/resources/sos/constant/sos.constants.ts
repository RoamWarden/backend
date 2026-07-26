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
 * MASTER SWITCH for the escalation ladder itself, independent of any plan.
 * Defaults to FALSE, and false is the shipping state.
 *
 * WHY IT EXISTS. The ladder's only humane stop conditions are a traveller
 * resolving their SOS (`POST /sos/:id/resolve`) and a contact acknowledging it
 * (`POST /sos/:id/ack`). No shipped client calls either one yet, so with the
 * ladder armed EVERY SOS runs to exhaustion and ends by pushing the traveller
 * "No one has answered your SOS" — a claim the server cannot know, on the one
 * screen where a false alarm costs the most. Arming a ladder nobody can stop
 * would degrade the standard SOS instead of adding reliability to it.
 *
 * While it is off, SOS behaves EXACTLY as it does today: every consenting
 * contact is still alerted at once (that has already happened before any of this
 * runs), the delivery trail is still written for everyone, `GET /sos/:id/trail`
 * still answers, and retraction still stands people down. The only thing that
 * does not happen is re-paging.
 *
 * Flip it to 'true' once the app can resolve and acknowledge an SOS.
 */
export const SOS_ESCALATION_ENABLED_ENV = 'SOS_ESCALATION_ENABLED';

/**
 * Why no ladder was armed while the switch is off. Descriptive only — it never
 * means fewer people were alerted (see `SosPriorityInfo`).
 */
export const SOS_ESCALATION_DISABLED_REASON =
  'Your contacts were all alerted immediately. Follow-up reminders are switched off on the server, so we will not page them again — if you are still in danger, contact local emergency services or someone nearby.';

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

// ──────────────────────────── retraction ────────────────────────────────────
//
// Withdrawing an SOS. NOT the same act as resolving one: `resolve` says "I am
// safe now" about an SOS that really happened; `retract` says "that should not
// have gone out". Both stop the paging. Only retraction owes the people it
// already alarmed an explicit stand-down, and only retraction costs reputation.
//
// THE POINT OF THIS FEATURE IS THE STAND-DOWN, not the penalty. Someone who got
// an SOS and never hears it was withdrawn keeps worrying, or keeps driving.

/**
 * Trail `round` for the retraction notice. Negative on purpose: the broadcast is
 * round 0 and escalation rounds count up from 1, so -1 sorts and reads as "this
 * happened outside the paging ladder" without touching either numbering.
 */
export const SOS_RETRACTION_ROUND = -1;

/**
 * Redis channel for a withdrawn SOS.
 *
 * NOT `CHANNEL_SOS`: the gateway relays everything on that channel as
 * `sos:raised`, so publishing a retraction there would re-fire the alarm on
 * every open app — the precise opposite of the intent. Its own channel is inert
 * until the gateway subscribes to it (see the note on `notifyRetraction`); the
 * push notification is the delivery guarantee, this is the live-screen tidy-up.
 */
export const CHANNEL_SOS_RETRACTED = 'sos:retracted';

/**
 * Reputation cost of withdrawing an SOS.
 *
 * WHY -3, and why not more. The scale already in use: a report the community
 * votes down costs -5, a report it verifies earns +2. A retraction sits BELOW a
 * rejected report on purpose. A rejected report is a claim about the world that
 * turned out to be wrong and stayed up until strangers voted it down. A
 * retraction is someone who hit a panic button — in a real moment of fear, or
 * with a phone in a pocket — and then had the honesty to come back and say so.
 *
 * The cost has to be real, or the button means nothing. It must NOT be so harsh
 * that the cheapest move is to leave a false SOS running and let contacts keep
 * driving toward you: that is the failure mode this number is chosen to avoid.
 * At -3 the dent is felt, is smaller than being voted down, and is repaid by two
 * verified reports (+4). It is one number in one place; tune it here.
 */
export const REPUTATION_SOS_RETRACTED = -3;

/**
 * Floor this penalty may never push someone below.
 *
 * Read precisely: it bounds what THIS behaviour can cost. It is not a global
 * floor on reputation (a serial false-reporter can still sink lower through the
 * report path) and it never RAISES anyone — a user already below it simply stops
 * being charged. Seven retractions from zero reach it, which is well past the
 * point where more subtraction teaches anybody anything.
 *
 * AND IT IS COSMETIC WHERE IT COUNTS: nothing in the SOS raise path reads
 * reputation. Someone at the floor raises an SOS exactly like someone at +100.
 * Safety is never rate-limited by a score — if that ever changes, it must not
 * change here.
 */
export const SOS_RETRACTION_REPUTATION_FLOOR = -20;

export const SOS_ALREADY_RESOLVED_MSG =
  'You already marked yourself safe on this SOS, so your contacts have been told it is over — there is nothing left to withdraw.';

/** Shown to the traveller after a retraction. Says exactly what just happened. */
export const SOS_RETRACTED_NOTICE =
  'We have told the contacts who actually received your SOS that you have withdrawn it. RoamWarden only ever alerts your own trusted contacts — it never contacted emergency services, so if you called them yourself, please call back and stand down.';

/**
 * Nothing on record shows the alert reaching anyone, so there was nobody for us
 * to stand down.
 *
 * SAYS WHAT THE RECORD SHOWS, NOT WHAT HAPPENED. The delivery trail is written
 * best-effort while the traveller is waiting on their SOS, so "no trail" is an
 * absence of evidence, not evidence of absence — and telling someone as a fact
 * that nobody got their alarm, when a contact may be driving toward them, is the
 * exact harm this feature exists to prevent. The stand-down itself already falls
 * back to the frozen ladder order before this sentence can be reached.
 */
export const SOS_RETRACT_NOBODY_REACHED =
  'Your SOS was withdrawn. Nothing on our records shows it reaching a contact, so there was no one for us to stand down — if you know someone saw it, please tell them yourself. RoamWarden only ever alerts your own trusted contacts — it never contacted emergency services.';

/**
 * The stand-down failed. This is the one outcome the traveller MUST hear about:
 * people are still out there believing they need help.
 */
export const SOS_RETRACT_NOTIFY_FAILED_WARNING =
  'Your SOS was withdrawn, but we could not tell the contacts who received it. They may still think you are in danger — please contact them yourself.';

/** Detail written on the escalation row when a retraction closes the ladder. */
export const SOS_RETRACT_ESCALATION_DETAIL = 'The traveller withdrew this SOS.';

/** Push title telling a contact the alert they got has been withdrawn. */
export function retractionPushTitle(name: string): string {
  return `${name} has withdrawn their SOS`;
}

/**
 * Push body for the stand-down. Every clause earns its place: they are told it
 * is withdrawn, they are told they can stop, they are given the traveller's own
 * words if there are any, and they are reminded that RoamWarden never called
 * anyone official — because if THEY called for help, only they can call it off.
 */
export function retractionPushBody(name: string, reason?: string): string {
  const said = reason ? ` They said: “${reason}”` : '';
  return `${name} says they no longer need help and has withdrawn the SOS you were sent.${said} You can stand down. RoamWarden only alerts trusted contacts — if you called emergency services, please tell them too.`;
}

/** Trail detail for one stand-down message. */
export const SOS_RETRACTION_DELIVERY_DETAIL =
  'Told them you had withdrawn this SOS.';

/** Trail detail when the person we reached has since unregistered every device. */
export const SOS_RETRACTION_NO_DEVICE_DETAIL =
  'They no longer have a device registered with RoamWarden, so the withdrawal could not be pushed to them.';

/** Plain-language summary of the reputation dent. Never a bare number. */
export function retractionReputationNote(
  penalty: number,
  reputation: number | null,
): string {
  if (penalty === 0) {
    return 'This SOS was already withdrawn, so your reputation was not affected again.';
  }
  const now =
    reputation === null ? '' : ` Your reputation is now ${reputation}.`;
  return `Withdrawing an SOS costs ${Math.abs(penalty)} reputation.${now} It never affects your ability to raise another SOS — if you need help, raise one.`;
}

/** The dent could not be recorded. Said plainly rather than not at all. */
export const SOS_RETRACT_REPUTATION_UNRECORDED =
  'Your SOS was withdrawn. We could not record the reputation change for it, which costs you nothing — raising another SOS is unaffected either way.';
