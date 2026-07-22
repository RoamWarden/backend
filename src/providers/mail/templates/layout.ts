/**
 * Shared branded email layout for RoamWarden. Email clients strip <style> and
 * external CSS unpredictably, so everything here is inline styles on a simple,
 * table-free, single-column structure that renders consistently across Gmail,
 * Apple Mail, Outlook and the major mobile clients. Max width ~560px.
 */

/** Brand palette — deep teal accent on dark ink text. */
const BRAND = {
  ink: '#0f2a2e',
  body: '#334247',
  muted: '#6b7c80',
  accent: '#0d7d6f',
  accentText: '#ffffff',
  bg: '#eef2f1',
  card: '#ffffff',
  border: '#dbe4e2',
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Escapes text for safe interpolation into HTML attribute/content contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailCta {
  label: string;
  url: string;
}

export interface RenderEmailInput {
  /** Big headline at the top of the card. */
  heading: string;
  /** Pre-composed, trusted HTML for the message body (already escaped by caller). */
  bodyHtml: string;
  /** Optional primary call-to-action button. */
  cta?: EmailCta;
  /** Hidden inbox-preview line shown by most clients next to the subject. */
  preheader: string;
}

/**
 * Renders a full, responsive HTML document for a RoamWarden email. Colours and
 * spacing are inline so they survive email-client sanitisers.
 */
export function renderEmail(input: RenderEmailInput): string {
  const { heading, bodyHtml, cta, preheader } = input;

  const ctaHtml = cta
    ? `
        <div style="margin: 28px 0 8px;">
          <a href="${escapeHtml(cta.url)}"
             style="display: inline-block; background: ${BRAND.accent}; color: ${BRAND.accentText};
                    text-decoration: none; font-weight: 600; font-size: 16px; line-height: 1;
                    padding: 15px 28px; border-radius: 10px; font-family: ${FONT_STACK};">
            ${escapeHtml(cta.label)}
          </a>
        </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: ${BRAND.bg}; font-family: ${FONT_STACK};">
    <span style="display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; mso-hide: all;">
      ${escapeHtml(preheader)}
    </span>
    <div style="max-width: 560px; margin: 0 auto; padding: 32px 16px;">
      <div style="padding: 0 4px 20px; font-family: ${FONT_STACK};">
        <span style="font-size: 20px; font-weight: 700; color: ${BRAND.accent}; letter-spacing: -0.2px;">
          Roam<span style="color: ${BRAND.ink};">Warden</span>
        </span>
      </div>
      <div style="background: ${BRAND.card}; border: 1px solid ${BRAND.border}; border-radius: 16px; padding: 32px 28px;">
        <h1 style="margin: 0 0 16px; font-size: 22px; line-height: 1.3; font-weight: 700; color: ${BRAND.ink}; font-family: ${FONT_STACK};">
          ${escapeHtml(heading)}
        </h1>
        <div style="font-size: 16px; line-height: 1.6; color: ${BRAND.body}; font-family: ${FONT_STACK};">
          ${bodyHtml}
        </div>
        ${ctaHtml}
      </div>
      <div style="padding: 20px 8px 0; font-size: 13px; line-height: 1.6; color: ${BRAND.muted}; font-family: ${FONT_STACK};">
        <p style="margin: 0 0 6px;">RoamWarden — community-powered travel safety.</p>
        <p style="margin: 0; color: ${BRAND.muted};">
          Wherever you're headed, don't travel uninformed.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

/** Footer note appended to the plain-text alternate. */
export const TEXT_FOOTER =
  'RoamWarden — community-powered travel safety.\n' +
  "Wherever you're headed, don't travel uninformed.";
