import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EMAIL_OTP_TTL_S } from '../../common/constants';
import {
  DEFAULT_BREVO_API_BASE_URL,
  DEFAULT_MAIL_FROM,
} from './constant/mail.constants';
import type { ComposedEmail } from './templates/password-reset.template';
import { emailVerificationEmail } from './templates/email-verification.template';
import { passwordResetEmail } from './templates/password-reset.template';
import { welcomeEmail } from './templates/welcome.template';
import { waitlistConfirmationEmail } from './templates/waitlist.template';

type MailMode = 'brevo' | 'smtp' | 'log-only';

/** Sender identity — Brevo needs a name + a verified email, split out of MAIL_FROM. */
interface MailSender {
  name: string;
  email: string;
}

/**
 * Outbound email. Prefers Brevo's transactional API (BREVO_API_KEY); falls back
 * to a legacy SMTP transport (SMTP_URL); if neither is configured, runs in
 * log-only mode so links/codes are logged, never lost. No send method throws —
 * email delivery must not break the request that triggered it (build plan §10,
 * "never fail silently") — EXCEPT a `critical` send (a verification code the
 * user is waiting on), which re-throws so the caller can surface it.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private mode: MailMode = 'log-only';
  private transporter: Transporter | null = null;
  private brevoApiKey = '';
  private brevoSendEndpoint = '';
  private brevoAccountEndpoint = '';
  // Sender used by every provider. Defaults to a placeholder — set MAIL_FROM to
  // a sender/domain you've VERIFIED in Brevo or sends will be rejected.
  private sender: MailSender = parseMailFrom(DEFAULT_MAIL_FROM);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const brevoKey = this.config.get<string>('BREVO_API_KEY');
    const smtpUrl = this.config.get<string>('SMTP_URL');
    const from = this.config.get<string>('MAIL_FROM');
    if (from && from.length > 0) {
      this.sender = parseMailFrom(from);
    }

    if (brevoKey && brevoKey.length > 0) {
      this.brevoApiKey = brevoKey;
      const base = (
        this.config.get<string>('BREVO_API_BASE_URL') ??
        DEFAULT_BREVO_API_BASE_URL
      ).replace(/\/+$/, '');
      this.brevoSendEndpoint = `${base}/v3/smtp/email`;
      this.brevoAccountEndpoint = `${base}/v3/account`;
      this.mode = 'brevo';
      this.logger.log(`Email enabled — Brevo API (from ${this.sender.email})`);
      void this.verifyBrevoConnection();
    } else if (smtpUrl && smtpUrl.length > 0) {
      this.transporter = nodemailer.createTransport(smtpUrl);
      this.mode = 'smtp';
      this.logger.log('Email enabled — SMTP (legacy)');
    } else {
      this.mode = 'log-only';
      this.logger.warn(
        'Email disabled — set BREVO_API_KEY; emails will be logged, not sent.',
      );
    }
  }

  /**
   * Builds the user-facing password-reset URL. Points at the web app
   * (WEB_APP_URL) when configured, otherwise falls back to API_BASE_URL, then
   * to a localhost dev URL — always with the raw token in the query string.
   */
  buildResetUrl(token: string): string {
    const port = this.config.get<string | number>('PORT') ?? 3000;
    const base =
      this.config.get<string>('WEB_APP_URL') ??
      this.config.get<string>('API_BASE_URL') ??
      `http://localhost:${port}`;
    return `${base.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * Sends a password-reset link. Never throws — transport errors are caught and
   * logged so the caller's flow is unaffected.
   */
  async sendPasswordReset(email: string, resetUrl: string): Promise<void> {
    const composed = passwordResetEmail(resetUrl);
    await this.dispatch(email, composed, `password reset → ${resetUrl}`);
  }

  /**
   * Sends the welcome email to a newly registered traveller. Never throws.
   */
  async sendWelcome(email: string, name: string): Promise<void> {
    const composed = welcomeEmail(name);
    await this.dispatch(email, composed, 'welcome');
  }

  /**
   * Confirms a waitlist sign-up. Never throws.
   */
  async sendWaitlistConfirmation(email: string): Promise<void> {
    const composed = waitlistConfirmationEmail();
    await this.dispatch(email, composed, 'waitlist confirmation');
  }

  /**
   * Sends a 6-digit email-verification code. Unlike the other emails this one is
   * CRITICAL: if a real provider fails to deliver it, the caller must know (the
   * user is stuck without a code), so it re-throws when actually sending. In
   * log-only mode it logs the code and resolves (dev can read it from the logs).
   */
  async sendVerificationCode(email: string, code: string): Promise<void> {
    const ttlMinutes = Math.max(1, Math.round(EMAIL_OTP_TTL_S / 60));
    const composed = emailVerificationEmail(code, ttlMinutes);
    await this.dispatch(email, composed, 'verification code', {
      critical: true,
    });
  }

  /**
   * Dispatches a composed email via whichever provider is active. In log-only
   * mode it logs a concise line (including the key link/summary). All transport
   * calls are wrapped in try/catch so a failure is logged and never thrown —
   * unless `critical`, in which case it re-throws so the caller can surface it.
   */
  private async dispatch(
    to: string,
    email: ComposedEmail,
    logSummary: string,
    options?: { critical?: boolean },
  ): Promise<void> {
    if (this.mode === 'log-only') {
      this.logger.log(`[mail:log-only] to ${to} — ${logSummary}`);
      return;
    }

    try {
      if (this.mode === 'brevo') {
        await this.sendViaBrevo(to, email);
      } else if (this.mode === 'smtp' && this.transporter) {
        await this.transporter.sendMail({
          from: `${this.sender.name} <${this.sender.email}>`,
          to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed to send email (${logSummary}) to ${to}`,
        err instanceof Error ? err.stack : String(err),
      );
      // Non-critical emails (welcome, waitlist, reset) must never break the
      // triggering request. Critical ones (a verification code the user is
      // waiting on) re-throw so the caller can tell the user it failed.
      if (options?.critical) {
        throw err;
      }
    }
  }

  /** Sends one transactional email through Brevo's REST API (POST /v3/smtp/email). */
  private async sendViaBrevo(to: string, email: ComposedEmail): Promise<void> {
    const payload = {
      sender: { name: this.sender.name, email: this.sender.email },
      to: [{ email: to }],
      subject: email.subject,
      htmlContent: email.html,
      textContent: email.text,
    };

    const response = await withRequestTimeout(
      (signal) =>
        fetch(this.brevoSendEndpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'api-key': this.brevoApiKey,
          },
          body: JSON.stringify(payload),
          signal,
        }),
      15000,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Brevo API returned ${response.status} ${response.statusText}: ${body}`,
      );
    }
  }

  /** Best-effort startup check that the Brevo API key works. Only logs. */
  private async verifyBrevoConnection(): Promise<void> {
    try {
      const response = await withRequestTimeout(
        (signal) =>
          fetch(this.brevoAccountEndpoint, {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'api-key': this.brevoApiKey,
            },
            signal,
          }),
        10000,
      );
      if (!response.ok) {
        this.logger.error(
          `Brevo API verification failed (${response.status} ${response.statusText})`,
        );
        return;
      }
      this.logger.log('Brevo API verification successful');
    } catch (err) {
      this.logger.error(
        `Brevo API verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Splits `"RoamWarden <hello@x.com>"` (or a bare email) into a Brevo sender. */
function parseMailFrom(value: string): MailSender {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value);
  if (match && match[2]) {
    return { name: match[1]?.trim() || 'RoamWarden', email: match[2].trim() };
  }
  return { name: 'RoamWarden', email: value.trim() };
}

/** Runs `run` with an abort signal that fires after `timeoutMs`. */
async function withRequestTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Brevo request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(handle);
  }
}
