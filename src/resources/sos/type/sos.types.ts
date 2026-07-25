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

/** What `SosEscalationService.start` needs to know about a just-raised SOS. */
export interface StartEscalationInput {
  sosId: string;
  userId: string;
  ownerName: string;
  /** Consenting contact userIds, in the order the ladder will page them. */
  contactUserIds: string[];
  travellerMessage?: string;
}
