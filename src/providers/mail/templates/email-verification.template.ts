import { EMAIL_VERIFICATION_SUBJECT } from '../constant/mail.constants';
import { escapeHtml, renderEmail, TEXT_FOOTER } from './layout';
import type { ComposedEmail } from './password-reset.template';

/**
 * Email-verification code: a short note with the 6-digit code shown large and
 * spaced so it is easy to read and copy. Notes the expiry and that ignoring it
 * is safe. The code is digits-only but still escaped, per convention.
 */
export function emailVerificationEmail(
  code: string,
  ttlMinutes: number,
): ComposedEmail {
  const safeCode = escapeHtml(code);

  const bodyHtml = `
    <p style="margin: 0 0 16px;">Welcome to RoamWarden! Enter this code in the app to verify your email and finish setting up your account.</p>
    <div style="margin: 0 0 18px; text-align: center;">
      <span style="display: inline-block; font-size: 34px; font-weight: 700; letter-spacing: 10px;
                   color: #0f2a2e; background: #eef2f1; border: 1px solid #dbe4e2; border-radius: 12px;
                   padding: 16px 22px 16px 32px;">${safeCode}</span>
    </div>
    <p style="margin: 0;">This code expires in <strong>${ttlMinutes} minutes</strong>. If you didn't create a RoamWarden account, you can safely ignore this email.</p>`;

  const html = renderEmail({
    heading: 'Verify your email',
    preheader: `Your RoamWarden verification code is ${code} — it expires in ${ttlMinutes} minutes.`,
    bodyHtml,
  });

  const text = [
    'Verify your email',
    '',
    'Welcome to RoamWarden! Enter this code in the app to verify your email:',
    '',
    `    ${code}`,
    '',
    `This code expires in ${ttlMinutes} minutes.`,
    "If you didn't create a RoamWarden account, you can safely ignore this email.",
    '',
    TEXT_FOOTER,
  ].join('\n');

  return { subject: EMAIL_VERIFICATION_SUBJECT, html, text };
}
