import type {
  SosDeliveryChannel,
  SosDeliveryStatus,
  SosEscalationStatus,
} from '@prisma/client';

export interface SosRaisedMessage {
  sosId: string;
  user: { id: string; name: string };
  tripId?: string;
  lat?: number;
  lng?: number;
  message?: string;
  contactUserIds: string[];
  raisedAt: string;
  /**
   * 0 (or absent) for the immediate broadcast every SOS performs; 1..n for a
   * Priority-SOS escalation re-page. Clients may use it to re-surface an alert
   * that was dismissed, but must treat the broadcast exactly as they do today.
   */
  escalationRound?: number;
}

/**
 * Priority-SOS state attached to a raise response. PURELY INFORMATIONAL:
 * `enabled: false` never means the SOS did less than it does today — the
 * standard alert to every consenting contact has already gone out either way.
 */
export interface SosPriorityInfo {
  /** Is the reliability ladder running for this SOS? */
  enabled: boolean;
  /** The entitled plan the decision came from ('free' unless ACTIVE premium). */
  planCode: string;
  /** Whether plan enforcement is on. While it is off, everyone gets the ladder. */
  enforced: boolean;
  /** How many trusted contacts are in the ladder. */
  contactsInLadder: number;
  /** Why the ladder is not running, when it is not. Never a bare flag. */
  reason: string | null;
}

export interface RaiseSosResult {
  sosId: string;
  notifiedContactCount: number;
  shareUrl?: string;
  warning?: string;
  /** Additive: older clients that ignore this field behave exactly as before. */
  priority?: SosPriorityInfo;
}

/** One recorded attempt to reach one contact. Append-only. */
export interface SosDeliveryAttemptView {
  contactUserId: string;
  /** Ladder position (0-based); -1 for the broadcast wave. */
  rank: number;
  /** 0 = the immediate broadcast; 1..n = escalation rounds. */
  round: number;
  /** 1-based attempt counter for this contact. */
  attempt: number;
  channel: SosDeliveryChannel;
  status: SosDeliveryStatus;
  priority: boolean;
  detail: string | null;
  at: string;
}

/** The escalation ladder's own state, for the trail view. */
export interface SosEscalationView {
  status: SosEscalationStatus;
  planCode: string;
  enforced: boolean;
  contactsInLadder: number;
  /** Ladder position currently being paged. */
  rank: number;
  totalAttempts: number;
  nextAttemptAt: string | null;
  acknowledgedBy: string | null;
  finishedAt: string | null;
  detail: string | null;
}

/**
 * The auditable answer to "what actually happened when I hit SOS?" — every
 * attempt, in order, with the honest limits of what RoamWarden can do.
 */
export interface SosTrailView {
  sosId: string;
  raisedAt: string;
  resolvedAt: string | null;
  /** Set when the traveller WITHDREW this alert (never the same as resolving). */
  retractedAt: string | null;
  /** Their own words for why, when they gave any. */
  retractReason: string | null;
  escalation: SosEscalationView | null;
  attempts: SosDeliveryAttemptView[];
  notice: string;
}

export interface SosAckResult {
  sosId: string;
  acknowledgedAt: string;
  /** Did this acknowledgement stop a ladder that was still paging? */
  escalationStopped: boolean;
  notice: string;
}

/**
 * Published on `CHANNEL_SOS_RETRACTED` when a traveller withdraws an SOS, so a
 * contact with the app open can clear the alarm without waiting for a push.
 * Carries NO location, NO trip and NO share link — a withdrawal must not be a
 * second delivery of the thing being withdrawn.
 */
export interface SosRetractedMessage {
  sosId: string;
  user: { id: string; name: string };
  /** The traveller's own words, when they gave any. */
  reason?: string;
  /** ISO-8601. */
  retractedAt: string;
  /** Exactly the contacts who were actually reached by the original alert. */
  contactUserIds: string[];
}

/** What the retraction stand-down actually managed to do. */
export interface SosRetractionNotifyResult {
  /** Contacts we told, i.e. those the original SOS actually reached. */
  notifiedContactCount: number;
  /** Set when we could NOT tell them — the traveller has to hear this. */
  warning?: string;
}

/** The reputation half of a retraction. Bounded, once, and explained. */
export interface SosRetractionReputation {
  /** Applied by THIS call: the penalty, or 0 for a repeat/failed write. */
  penalty: number;
  /** Reputation after the penalty, when we could read it back. */
  value: number | null;
  /** Plain-language explanation. Never just a number. */
  note: string;
}

export interface RetractSosResult {
  sosId: string;
  retractedAt: string;
  /** True when this call found it already withdrawn (idempotent, not an error). */
  alreadyRetracted: boolean;
  /** Did this call actually halt a paging ladder that was still running? */
  escalationStopped: boolean;
  /** How many already-reached contacts were told to stand down. */
  notifiedContactCount: number;
  reputation: SosRetractionReputation;
  /** Set when something the traveller needs to know about went wrong. */
  warning?: string;
  notice: string;
}

/** What `SosEscalationService.start` needs to know about a just-raised SOS. */
export interface StartEscalationInput {
  sosId: string;
  userId: string;
  ownerName: string;
  /** Consenting contact userIds, in the order the ladder will page them. */
  contactUserIds: string[];
  travellerMessage?: string;
}
