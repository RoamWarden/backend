/** Subject line for the password-reset email. */
export const PASSWORD_RESET_SUBJECT = 'Reset your RoamWarden password';

/** Subject line for the welcome email sent after sign-up. */
export const WELCOME_SUBJECT = 'Welcome to RoamWarden';

/** Subject line for the waitlist confirmation email. */
export const WAITLIST_CONFIRMATION_SUBJECT = "You're on the RoamWarden list";

/**
 * Default sender. Uses Resend's shared testing domain so a bare RESEND_API_KEY
 * works out of the box. In production, verify your own domain in Resend and set
 * MAIL_FROM (e.g. 'RoamWarden <hello@roamwarden.app>').
 */
export const DEFAULT_MAIL_FROM = 'RoamWarden <onboarding@resend.dev>';
