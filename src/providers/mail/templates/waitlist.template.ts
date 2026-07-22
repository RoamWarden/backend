import { WAITLIST_CONFIRMATION_SUBJECT } from '../constant/mail.constants';
import { renderEmail, TEXT_FOOTER } from './layout';
import type { ComposedEmail } from './password-reset.template';

/**
 * Waitlist confirmation: a warm "you're on the list" note letting them know
 * we'll reach out at launch.
 */
export function waitlistConfirmationEmail(): ComposedEmail {
  const bodyHtml = `
    <p style="margin: 0 0 14px;">You're on the list — thanks for signing up for RoamWarden.</p>
    <p style="margin: 0 0 14px;">We're building community-powered travel safety: a way to log your trips, keep your trusted contacts in the loop, and get real-time alerts from travellers around you.</p>
    <p style="margin: 0;">We'll email you the moment early access opens. No need to do anything until then.</p>
    <p style="margin: 18px 0 0; font-size: 13px; color: #6b7c80;">You're receiving this because you joined the RoamWarden waitlist. If that wasn't you, you can safely ignore this email.</p>`;

  const html = renderEmail({
    heading: "You're on the list",
    preheader:
      "You're on the RoamWarden waitlist — we'll let you know at launch.",
    bodyHtml,
  });

  const text = [
    "You're on the RoamWarden list",
    '',
    "You're on the list — thanks for signing up for RoamWarden.",
    '',
    "We're building community-powered travel safety: a way to log your trips, keep",
    'your trusted contacts in the loop, and get real-time alerts from travellers',
    'around you.',
    '',
    "We'll email you the moment early access opens. No need to do anything until then.",
    '',
    "You're receiving this because you joined the RoamWarden waitlist. If that wasn't",
    'you, you can safely ignore this email.',
    '',
    TEXT_FOOTER,
  ].join('\n');

  return { subject: WAITLIST_CONFIRMATION_SUBJECT, html, text };
}
