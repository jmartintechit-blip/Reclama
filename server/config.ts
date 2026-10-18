import { normalizeEmail } from './domain/email.ts';
import { createResendMailer, type Mailer } from './services/mailer.ts';

// 'sandbox': every email goes to `testRecipient`, never to the debtor. 'live': to the debtor.
// Why sandbox is the default: without a verified sending domain Resend delivers only to the
// owner of the account, and an endpoint that sends a letter to any address its caller types
// would be a spam vector. Sending to real debtors is something to turn on on purpose, after the
// domain is verified.
export type EmailMode = 'sandbox' | 'live';

export interface EmailConfig {
  from: string;
  mode: EmailMode;
  testRecipient: string;
}

// The safe values: a test address of Resend and its shared sender, which need no domain.
export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  from: 'Reclama <onboarding@resend.dev>',
  mode: 'sandbox',
  testRecipient: 'delivered@resend.dev',
};

// Without RESEND_API_KEY there is no mailer: the rest of the API works and the email endpoint
// answers 503. Nothing here is logged except a warning that names the variable, never a value.
export function createEmailFromEnv(env: NodeJS.ProcessEnv): {
  mailer: Mailer | undefined;
  emailConfig: EmailConfig;
} {
  const apiKey = env.RESEND_API_KEY?.trim();
  const mode = env.EMAIL_MODE?.trim().toLowerCase();
  if (
    mode !== undefined &&
    mode !== '' &&
    mode !== 'sandbox' &&
    mode !== 'live'
  ) {
    console.warn('EMAIL_MODE must be "sandbox" or "live"; using "sandbox".');
  }

  return {
    mailer:
      apiKey === undefined || apiKey === ''
        ? undefined
        : createResendMailer({ apiKey }),
    emailConfig: {
      from: env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_CONFIG.from,
      // Anything that is not exactly "live" stays in the safe mode.
      mode: mode === 'live' ? 'live' : 'sandbox',
      testRecipient:
        normalizeEmail(env.EMAIL_TEST_RECIPIENT ?? '') ??
        DEFAULT_EMAIL_CONFIG.testRecipient,
    },
  };
}
