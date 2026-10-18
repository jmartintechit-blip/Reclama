import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailFromEnv, DEFAULT_EMAIL_CONFIG } from './config.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEmailFromEnv', () => {
  it('has no mailer and the safe defaults when nothing is set', () => {
    const { mailer, emailConfig } = createEmailFromEnv({});

    expect(mailer).toBeUndefined();
    expect(emailConfig).toEqual({
      from: 'Reclama <onboarding@resend.dev>',
      mode: 'sandbox',
      testRecipient: 'delivered@resend.dev',
    });
    expect(emailConfig).toEqual(DEFAULT_EMAIL_CONFIG);
  });

  it('treats empty values, as an empty field in a hosting dashboard gives them, as not set', () => {
    const { mailer, emailConfig } = createEmailFromEnv({
      RESEND_API_KEY: '  ',
      EMAIL_FROM: '',
      EMAIL_MODE: '',
      EMAIL_TEST_RECIPIENT: '',
    });

    expect(mailer).toBeUndefined();
    expect(emailConfig).toEqual(DEFAULT_EMAIL_CONFIG);
  });

  it('creates a mailer when there is a key, and reads the other values', () => {
    const { mailer, emailConfig } = createEmailFromEnv({
      RESEND_API_KEY: 're_fake_key_for_tests_only',
      EMAIL_FROM: 'Cobros <cobros@example.test>',
      EMAIL_MODE: ' Live ',
      EMAIL_TEST_RECIPIENT: 'Inbox@Example.test',
    });

    expect(mailer).toBeDefined();
    expect(emailConfig).toEqual({
      from: 'Cobros <cobros@example.test>',
      mode: 'live',
      testRecipient: 'inbox@example.test',
    });
  });

  it('stays in sandbox for any mode that is not exactly live, and warns without printing the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { emailConfig } = createEmailFromEnv({ EMAIL_MODE: 'prod-secret' });

    expect(emailConfig.mode).toBe('sandbox');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('prod-secret');
  });

  it('falls back to the default test inbox when the configured one is not an email address', () => {
    const { emailConfig } = createEmailFromEnv({
      EMAIL_TEST_RECIPIENT: 'a@b.test, c@d.test',
    });

    expect(emailConfig.testRecipient).toBe('delivered@resend.dev');
  });
});
