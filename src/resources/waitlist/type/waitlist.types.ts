/** Response shapes for the waitlist API. */

/** Result of a POST /waitlist join. */
export interface JoinWaitlistResult {
  joined: true;
  /** true when the email was already on the list (no confirmation re-sent). */
  alreadyJoined: boolean;
}

/** A single waitlist entry as returned to admins. */
export interface WaitlistEntryView {
  id: string;
  email: string;
  source: string | null;
  createdAt: Date;
}

/** Paginated admin listing of waitlist entries. */
export interface WaitlistListResult {
  entries: WaitlistEntryView[];
  total: number;
  page: number;
  limit: number;
}

/** Public social-proof count. */
export interface WaitlistCountResult {
  count: number;
}
