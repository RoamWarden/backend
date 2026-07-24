import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { EMAIL_OTP_TTL_S } from '../../common/constants';
import { DEFAULT_MAIL_FROM } from './constant/mail.constants';
import type { ComposedEmail } from './templates/password-reset.template';
import { emailVerificationEmail } from './templates/email-verification.template';
import { passwordResetEmail } from './templates/password-reset.template';
import { welcomeEmail } from './templates/welcome.template';
import { waitlistConfirmationEmail } from './templates/waitlist.template';

type MailMode = 'resend' | 'smtp' | 'log-only';

/**
 * Outbound email. Prefers Resend (RESEND_API_KEY); falls back to a legacy SMTP
 * transport (SMTP_URL); if neither is configured, runs in log-only mode so
 * links are logged, never lost. No send method ever throws — email delivery
 * must not break the request that triggered it (build plan §10, "never fail
 * silently").
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private mode: MailMode = 'log-only';
  private resend: Resend | null = null;
  private transporter: Transporter | null = null;
  // Default to Resend's shared testing sender so a bare API key works out of
  // the box. Production should verify a domain in Resend and set MAIL_FROM.
  private from = DEFAULT_MAIL_FROM;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const resendKey = this.config.get<string>('RESEND_API_KEY');
    const smtpUrl = this.config.get<string>('SMTP_URL');
    const from = this.config.get<string>('MAIL_FROM');
    if (from && from.length > 0) {
      this.from = from;
    }

    if (resendKey && resendKey.length > 0) {
      this.resend = new Resend(resendKey);
      this.mode = 'resend';
      this.logger.log('Email enabled — Resend');
    } else if (smtpUrl && smtpUrl.length > 0) {
      this.transporter = nodemailer.createTransport(smtpUrl);
      this.mode = 'smtp';
      this.logger.log('Email enabled — SMTP (legacy)');
    } else {
      this.mode = 'log-only';
      this.logger.warn(
        'Email disabled — set RESEND_API_KEY; emails will be logged, not sent.',
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
   * calls are wrapped in try/catch so a failure is logged and never thrown.
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
      if (this.mode === 'resend' && this.resend) {
        await this.resend.emails.send({
          from: this.from,
          to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } else if (this.mode === 'smtp' && this.transporter) {
        await this.transporter.sendMail({
          from: this.from,
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
}
