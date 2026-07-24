/** Subject line for the password-reset email. */
export const PASSWORD_RESET_SUBJECT = 'Reset your RoamWarden password';

/** Subject line for the welcome email sent after sign-up. */
export const WELCOME_SUBJECT = 'Welcome to RoamWarden';

/** Subject line for the email-verification code sent during sign-up. */
export const EMAIL_VERIFICATION_SUBJECT = 'Your RoamWarden verification code';

/** Subject line for the waitlist confirmation email. */
export const WAITLIST_CONFIRMATION_SUBJECT = "You're on the RoamWarden list";

/**
 * Default sender. MUST be a sender/domain you have VERIFIED in Brevo — Brevo
 * rejects transactional sends from unverified senders. Override with MAIL_FROM
 * (e.g. 'RoamWarden <no-reply@roamwarden.app>').
 */
export const DEFAULT_MAIL_FROM = 'RoamWarden <no-reply@roamwarden.app>';

/** Brevo transactional API base URL (override with BREVO_API_BASE_URL). */
export const DEFAULT_BREVO_API_BASE_URL = 'https://api.brevo.com';
