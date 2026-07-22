import { PASSWORD_RESET_SUBJECT } from '../constant/mail.constants';
import { escapeHtml, renderEmail, TEXT_FOOTER } from './layout';

export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Password-reset email: a warm, concise note explaining a reset was requested
 * with a big CTA to the reset URL. Notes the 1-hour expiry and that ignoring it
 * is safe.
 */
export function passwordResetEmail(resetUrl: string): ComposedEmail {
  const safeUrl = escapeHtml(resetUrl);

  const bodyHtml = `
    <p style="margin: 0 0 14px;">We got a request to reset the password for your RoamWarden account. Tap the button below to choose a new one.</p>
    <p style="margin: 0;">This link expires in <strong>1 hour</strong>. If you didn't ask to reset your password, you can safely ignore this email — nothing will change.</p>
    <p style="margin: 18px 0 0; font-size: 13px; color: #6b7c80;">If the button doesn't work, copy and paste this link into your browser:<br /><a href="${safeUrl}" style="color: #0d7d6f; word-break: break-all;">${safeUrl}</a></p>`;

  const html = renderEmail({
    heading: 'Reset your password',
    preheader: 'Reset your RoamWarden password — this link expires in 1 hour.',
    bodyHtml,
    cta: { label: 'Reset password', url: resetUrl },
  });

  const text = [
    'Reset your RoamWarden password',
    '',
    'We got a request to reset the password for your RoamWarden account.',
    'Reset it here (this link expires in 1 hour):',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password will stay the same.",
    '',
    TEXT_FOOTER,
  ].join('\n');

  return { subject: PASSWORD_RESET_SUBJECT, html, text };
}
