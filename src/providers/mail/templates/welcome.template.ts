import { WELCOME_SUBJECT } from '../constant/mail.constants';
import { escapeHtml, renderEmail, TEXT_FOOTER } from './layout';
import type { ComposedEmail } from './password-reset.template';

/**
 * Welcome email: greets the new traveller by name, says what RoamWarden does in
 * a line, and points them at how to get started.
 */
export function welcomeEmail(name: string): ComposedEmail {
  const trimmed = name.trim();
  const greetingName = trimmed.length > 0 ? escapeHtml(trimmed) : 'there';

  const bodyHtml = `
    <p style="margin: 0 0 14px;">Hi ${greetingName}, welcome aboard.</p>
    <p style="margin: 0 0 14px;">RoamWarden is community-powered travel safety: log a trip and your trusted contacts can follow you to your destination, while fellow travellers keep the map current with real-time road alerts around you.</p>
    <p style="margin: 0 0 6px;"><strong>Getting started is quick:</strong></p>
    <ul style="margin: 0; padding-left: 20px;">
      <li style="margin-bottom: 6px;">Log a trip with where you're headed.</li>
      <li style="margin-bottom: 6px;">Share it with the people you trust.</li>
      <li>Get community alerts for incidents along your route.</li>
    </ul>`;

  const html = renderEmail({
    heading: 'Welcome to RoamWarden',
    preheader:
      'Log a trip, share it, and travel with the community watching your back.',
    bodyHtml,
  });

  const text = [
    'Welcome to RoamWarden',
    '',
    `Hi ${trimmed.length > 0 ? trimmed : 'there'}, welcome aboard.`,
    '',
    'RoamWarden is community-powered travel safety: log a trip and your trusted',
    'contacts can follow you to your destination, while fellow travellers keep the',
    'map current with real-time road alerts around you.',
    '',
    'Getting started is quick:',
    "  - Log a trip with where you're headed.",
    '  - Share it with the people you trust.',
    '  - Get community alerts for incidents along your route.',
    '',
    TEXT_FOOTER,
  ].join('\n');

  return { subject: WELCOME_SUBJECT, html, text };
}
