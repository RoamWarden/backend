import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';
import {
  PASSWORD_RESET_SUBJECT,
  WELCOME_SUBJECT,
  WAITLIST_CONFIRMATION_SUBJECT,
} from './constant/mail.constants';

// Mock nodemailer so no real SMTP transport is ever created.
const sendMailMock = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));

// Mock resend so no real Resend client is ever created.
const resendSendMock = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: resendSendMock } })),
}));

const createTransportMock = nodemailer.createTransport as unknown as jest.Mock;
const ResendMock = jest.requireMock<{ Resend: jest.Mock }>('resend').Resend;

const RESEND_API_KEY = 're_test_key';
const SMTP_URL = 'smtp://user:pass@smtp.example.com:587';
const MAIL_FROM = 'RoamWarden Support <support@roamwarden.app>';

/** Builds a MailService whose ConfigService returns the given env map. */
async function buildService(
  env: Record<string, string | number | undefined>,
): Promise<MailService> {
  const configMock = {
    get: jest.fn((key: string) => env[key]),
  };
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [MailService, { provide: ConfigService, useValue: configMock }],
  }).compile();
  return moduleRef.get(MailService);
}

type SendArg = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

describe('MailService', () => {
  beforeEach(() => {
    createTransportMock.mockClear();
    sendMailMock.mockReset();
    resendSendMock.mockReset();
    ResendMock.mockClear();
  });

  describe('when nothing is configured (log-only)', () => {
    it('onModuleInit logs one disabled warning and creates no provider', async () => {
      const service = await buildService({});
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Email disabled'),
      );
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(ResendMock).not.toHaveBeenCalled();
    });

    it('treats empty-string keys as unconfigured', async () => {
      const service = await buildService({ RESEND_API_KEY: '', SMTP_URL: '' });
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Email disabled'),
      );
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(ResendMock).not.toHaveBeenCalled();
    });

    it('sendPasswordReset logs the link, does not throw, and calls no provider', async () => {
      const service = await buildService({});
      service.onModuleInit();
      const logSpy = jest
        .spyOn(
          (service as unknown as { logger: { log: jest.Mock } }).logger,
          'log',
        )
        .mockImplementation(() => undefined);

      const resetUrl = 'https://app.roamwarden.app/reset-password?token=abc';
      await expect(
        service.sendPasswordReset('traveller@example.com', resetUrl),
      ).resolves.toBeUndefined();

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(resetUrl));
    });

    it('sendWelcome and sendWaitlistConfirmation are safe no-throw log-only', async () => {
      const service = await buildService({});
      service.onModuleInit();

      await expect(
        service.sendWelcome('traveller@example.com', 'Ada'),
      ).resolves.toBeUndefined();
      await expect(
        service.sendWaitlistConfirmation('traveller@example.com'),
      ).resolves.toBeUndefined();

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(resendSendMock).not.toHaveBeenCalled();
    });
  });

  describe('when Resend is configured', () => {
    it('onModuleInit constructs Resend and logs enabled', async () => {
      const service = await buildService({ RESEND_API_KEY });
      const logSpy = jest
        .spyOn(
          (service as unknown as { logger: { log: jest.Mock } }).logger,
          'log',
        )
        .mockImplementation(() => undefined);

      service.onModuleInit();

      expect(ResendMock).toHaveBeenCalledTimes(1);
      expect(ResendMock).toHaveBeenCalledWith(RESEND_API_KEY);
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Resend'));
    });

    it('prefers Resend over SMTP when both are set', async () => {
      const service = await buildService({ RESEND_API_KEY, SMTP_URL });
      service.onModuleInit();

      expect(ResendMock).toHaveBeenCalledTimes(1);
      expect(createTransportMock).not.toHaveBeenCalled();
    });

    it('sends password reset via Resend with MAIL_FROM, subject and url', async () => {
      resendSendMock.mockResolvedValue({ data: { id: 'e-1' }, error: null });
      const service = await buildService({ RESEND_API_KEY, MAIL_FROM });
      service.onModuleInit();

      const resetUrl =
        'https://app.roamwarden.app/reset-password?token=reset-token';
      await service.sendPasswordReset('traveller@example.com', resetUrl);

      expect(resendSendMock).toHaveBeenCalledTimes(1);
      const arg = (resendSendMock.mock.calls as Array<[SendArg]>)[0][0];
      expect(arg.from).toBe(MAIL_FROM);
      expect(arg.to).toBe('traveller@example.com');
      expect(arg.subject).toBe(PASSWORD_RESET_SUBJECT);
      expect(arg.text).toContain(resetUrl);
      expect(arg.html).toContain(resetUrl);
    });

    it('sends welcome via Resend with the recipient name', async () => {
      resendSendMock.mockResolvedValue({ data: { id: 'e-2' }, error: null });
      const service = await buildService({ RESEND_API_KEY });
      service.onModuleInit();

      await service.sendWelcome('traveller@example.com', 'Ada');

      const arg = (resendSendMock.mock.calls as Array<[SendArg]>)[0][0];
      expect(arg.subject).toBe(WELCOME_SUBJECT);
      expect(arg.html).toContain('Ada');
      expect(arg.text).toContain('Ada');
    });

    it('sends waitlist confirmation via Resend', async () => {
      resendSendMock.mockResolvedValue({ data: { id: 'e-3' }, error: null });
      const service = await buildService({ RESEND_API_KEY });
      service.onModuleInit();

      await service.sendWaitlistConfirmation('traveller@example.com');

      const arg = (resendSendMock.mock.calls as Array<[SendArg]>)[0][0];
      expect(arg.subject).toBe(WAITLIST_CONFIRMATION_SUBJECT);
    });

    it('falls back to the default resend.dev sender when MAIL_FROM is absent', async () => {
      resendSendMock.mockResolvedValue({ data: { id: 'e-4' }, error: null });
      const service = await buildService({ RESEND_API_KEY });
      service.onModuleInit();

      await service.sendWaitlistConfirmation('traveller@example.com');

      const arg = (resendSendMock.mock.calls as Array<[SendArg]>)[0][0];
      expect(arg.from).toContain('onboarding@resend.dev');
    });

    it('swallows a Resend rejection — never throws to the caller', async () => {
      resendSendMock.mockRejectedValue(new Error('Resend network error'));
      const service = await buildService({ RESEND_API_KEY });
      service.onModuleInit();
      const errorSpy = jest
        .spyOn(
          (service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.sendWelcome('traveller@example.com', 'Ada'),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('when only SMTP is configured (legacy fallback)', () => {
    it('onModuleInit creates a transport from SMTP_URL', async () => {
      const service = await buildService({ SMTP_URL });
      service.onModuleInit();

      expect(createTransportMock).toHaveBeenCalledTimes(1);
      expect(createTransportMock).toHaveBeenCalledWith(SMTP_URL);
      expect(ResendMock).not.toHaveBeenCalled();
    });

    it('sends via nodemailer with MAIL_FROM and the reset url', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'msg-1' });
      const service = await buildService({ SMTP_URL, MAIL_FROM });
      service.onModuleInit();

      const resetUrl =
        'https://app.roamwarden.app/reset-password?token=reset-token';
      await service.sendPasswordReset('traveller@example.com', resetUrl);

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const arg = (sendMailMock.mock.calls as Array<[SendArg]>)[0][0];
      expect(arg.from).toBe(MAIL_FROM);
      expect(arg.to).toBe('traveller@example.com');
      expect(arg.subject).toBe(PASSWORD_RESET_SUBJECT);
      expect(arg.text).toContain(resetUrl);
      expect(arg.html).toContain(resetUrl);
    });

    it('swallows a sendMail rejection — never throws to the caller', async () => {
      sendMailMock.mockRejectedValue(new Error('SMTP connection refused'));
      const service = await buildService({ SMTP_URL, MAIL_FROM });
      service.onModuleInit();
      const errorSpy = jest
        .spyOn(
          (service as unknown as { logger: { error: jest.Mock } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.sendPasswordReset(
          'traveller@example.com',
          'https://app.roamwarden.app/reset-password?token=t',
        ),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildResetUrl', () => {
    it('prefers WEB_APP_URL and encodes the token', async () => {
      const service = await buildService({
        WEB_APP_URL: 'https://app.roamwarden.app/',
      });
      const url = service.buildResetUrl('a b/c');
      expect(url).toBe(
        'https://app.roamwarden.app/reset-password?token=a%20b%2Fc',
      );
    });

    it('falls back to API_BASE_URL then localhost', async () => {
      const withApiBase = await buildService({
        API_BASE_URL: 'https://api.roamwarden.app',
      });
      expect(withApiBase.buildResetUrl('tok')).toBe(
        'https://api.roamwarden.app/reset-password?token=tok',
      );

      const withPort = await buildService({ PORT: 4000 });
      expect(withPort.buildResetUrl('tok')).toBe(
        'http://localhost:4000/reset-password?token=tok',
      );
    });
  });
});
