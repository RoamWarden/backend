import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';
import {
  EMAIL_VERIFICATION_SUBJECT,
  PASSWORD_RESET_SUBJECT,
  WELCOME_SUBJECT,
  WAITLIST_CONFIRMATION_SUBJECT,
} from './constant/mail.constants';

// Mock nodemailer so no real SMTP transport is ever created.
const sendMailMock = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
}));
const createTransportMock = nodemailer.createTransport as unknown as jest.Mock;

// Mock the global fetch used by the Brevo transport.
const fetchMock = jest.fn();
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = fetchMock;
});
afterAll(() => {
  global.fetch = realFetch;
});

const BREVO_API_KEY = 'xkeysib-test-key';
const SMTP_URL = 'smtp://user:pass@smtp.example.com:587';
const MAIL_FROM = 'RoamWarden Support <support@roamwarden.app>';

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface BrevoPayload {
  sender: { name: string; email: string };
  to: Array<{ email: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
}

/** A minimal Response stand-in for the fetch mock. */
function fakeResponse(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

async function buildService(
  env: Record<string, string | number | undefined>,
): Promise<MailService> {
  const configMock = { get: jest.fn((key: string) => env[key]) };
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [MailService, { provide: ConfigService, useValue: configMock }],
  }).compile();
  return moduleRef.get(MailService);
}

function spyLogger(service: MailService, method: 'log' | 'warn' | 'error') {
  return jest
    .spyOn(
      (service as unknown as { logger: Record<string, jest.Mock> }).logger,
      method,
    )
    .mockImplementation(() => undefined);
}

/** The POST to Brevo's send endpoint (skips the startup /v3/account verify GET). */
function brevoSendCall(): { url: string; init: FetchInit } | undefined {
  const call = (fetchMock.mock.calls as Array<[string, FetchInit]>).find(
    ([url, init]) => url.includes('/v3/smtp/email') && init.method === 'POST',
  );
  return call ? { url: call[0], init: call[1] } : undefined;
}

function sentPayload(): BrevoPayload {
  const call = brevoSendCall();
  if (!call?.init.body) throw new Error('no Brevo send call captured');
  return JSON.parse(call.init.body) as BrevoPayload;
}

describe('MailService', () => {
  beforeEach(() => {
    createTransportMock.mockClear();
    sendMailMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(fakeResponse(201, '{"messageId":"<id>"}'));
  });

  describe('when nothing is configured (log-only)', () => {
    it('onModuleInit logs one disabled warning and creates no provider', async () => {
      const service = await buildService({});
      const warnSpy = spyLogger(service, 'warn');

      service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Email disabled'),
      );
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats empty-string keys as unconfigured', async () => {
      const service = await buildService({ BREVO_API_KEY: '', SMTP_URL: '' });
      const warnSpy = spyLogger(service, 'warn');

      service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Email disabled'),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sendPasswordReset logs the link, does not throw, and calls no provider', async () => {
      const service = await buildService({});
      service.onModuleInit();
      const logSpy = spyLogger(service, 'log');

      const resetUrl = 'https://app.roamwarden.app/reset-password?token=abc';
      await expect(
        service.sendPasswordReset('traveller@example.com', resetUrl),
      ).resolves.toBeUndefined();

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(resetUrl));
    });

    it('welcome / waitlist / verification code are safe no-throw log-only', async () => {
      const service = await buildService({});
      service.onModuleInit();

      await expect(
        service.sendWelcome('traveller@example.com', 'Ada'),
      ).resolves.toBeUndefined();
      await expect(
        service.sendWaitlistConfirmation('traveller@example.com'),
      ).resolves.toBeUndefined();
      await expect(
        service.sendVerificationCode('traveller@example.com', '123456'),
      ).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('when Brevo is configured', () => {
    it('onModuleInit selects Brevo, logs enabled, and verifies the API key', async () => {
      const service = await buildService({ BREVO_API_KEY });
      const logSpy = spyLogger(service, 'log');

      service.onModuleInit();
      await Promise.resolve(); // let the fire-and-forget verify settle

      expect(createTransportMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Brevo'));
      const verifyCall = (
        fetchMock.mock.calls as Array<[string, FetchInit]>
      ).find(
        ([url, init]) => url.includes('/v3/account') && init.method === 'GET',
      );
      expect(verifyCall).toBeDefined();
      expect(verifyCall?.[1].headers['api-key']).toBe(BREVO_API_KEY);
    });

    it('sends password reset via Brevo with sender, subject, and url', async () => {
      const service = await buildService({ BREVO_API_KEY, MAIL_FROM });
      service.onModuleInit();

      const resetUrl =
        'https://app.roamwarden.app/reset-password?token=reset-token';
      await service.sendPasswordReset('traveller@example.com', resetUrl);

      const call = brevoSendCall();
      expect(call).toBeDefined();
      expect(call?.init.headers['api-key']).toBe(BREVO_API_KEY);
      const payload = sentPayload();
      expect(payload.sender).toEqual({
        name: 'RoamWarden Support',
        email: 'support@roamwarden.app',
      });
      expect(payload.to).toEqual([{ email: 'traveller@example.com' }]);
      expect(payload.subject).toBe(PASSWORD_RESET_SUBJECT);
      expect(payload.htmlContent).toContain(resetUrl);
      expect(payload.textContent).toContain(resetUrl);
    });

    it('sends welcome via Brevo with the recipient name', async () => {
      const service = await buildService({ BREVO_API_KEY });
      service.onModuleInit();

      await service.sendWelcome('traveller@example.com', 'Ada');

      const payload = sentPayload();
      expect(payload.subject).toBe(WELCOME_SUBJECT);
      expect(payload.htmlContent).toContain('Ada');
      expect(payload.textContent).toContain('Ada');
    });

    it('sends the verification code via Brevo with the code and subject', async () => {
      const service = await buildService({ BREVO_API_KEY });
      service.onModuleInit();

      await service.sendVerificationCode('traveller@example.com', '123456');

      const payload = sentPayload();
      expect(payload.subject).toBe(EMAIL_VERIFICATION_SUBJECT);
      expect(payload.htmlContent).toContain('123456');
    });

    it('falls back to the default (no-reply) sender when MAIL_FROM is absent', async () => {
      const service = await buildService({ BREVO_API_KEY });
      service.onModuleInit();

      await service.sendWaitlistConfirmation('traveller@example.com');

      const payload = sentPayload();
      expect(payload.subject).toBe(WAITLIST_CONFIRMATION_SUBJECT);
      expect(payload.sender.email).toBe('no-reply@roamwarden.app');
    });

    it('swallows a Brevo failure for non-critical emails — never throws', async () => {
      const service = await buildService({ BREVO_API_KEY });
      service.onModuleInit();
      fetchMock.mockResolvedValue(
        fakeResponse(400, '{"message":"bad request"}'),
      );
      const errorSpy = spyLogger(service, 'error');

      await expect(
        service.sendWelcome('traveller@example.com', 'Ada'),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
    });

    it('RE-THROWS when the verification email fails (critical, unlike other emails)', async () => {
      const service = await buildService({ BREVO_API_KEY });
      service.onModuleInit();
      fetchMock.mockResolvedValue(
        fakeResponse(400, '{"message":"bad request"}'),
      );
      spyLogger(service, 'error');

      await expect(
        service.sendVerificationCode('traveller@example.com', '123456'),
      ).rejects.toThrow(/Brevo API returned 400/);
    });
  });

  describe('when only SMTP is configured (legacy fallback)', () => {
    it('onModuleInit creates a transport from SMTP_URL', async () => {
      const service = await buildService({ SMTP_URL });
      service.onModuleInit();

      expect(createTransportMock).toHaveBeenCalledWith(SMTP_URL);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends via nodemailer with the sender and the reset url', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'msg-1' });
      const service = await buildService({ SMTP_URL, MAIL_FROM });
      service.onModuleInit();

      const resetUrl =
        'https://app.roamwarden.app/reset-password?token=reset-token';
      await service.sendPasswordReset('traveller@example.com', resetUrl);

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const arg = (
        sendMailMock.mock.calls as Array<
          [
            {
              from: string;
              to: string;
              subject: string;
              text: string;
              html: string;
            },
          ]
        >
      )[0][0];
      expect(arg.from).toContain('support@roamwarden.app');
      expect(arg.to).toBe('traveller@example.com');
      expect(arg.subject).toBe(PASSWORD_RESET_SUBJECT);
      expect(arg.text).toContain(resetUrl);
      expect(arg.html).toContain(resetUrl);
    });

    it('swallows a sendMail rejection — never throws (non-critical)', async () => {
      sendMailMock.mockRejectedValue(new Error('SMTP connection refused'));
      const service = await buildService({ SMTP_URL, MAIL_FROM });
      service.onModuleInit();
      const errorSpy = spyLogger(service, 'error');

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
      expect(service.buildResetUrl('a b/c')).toBe(
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
