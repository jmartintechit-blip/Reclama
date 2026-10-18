// A mailer for tests: it keeps the messages in memory and can be told to fail. It never touches
// the network, so no test can send a real email.
import {
  MailerError,
  type MailMessage,
  type Mailer,
  type MailerErrorCode,
} from './mailer.ts';

export interface FakeMailer extends Mailer {
  readonly sent: MailMessage[]; // the messages the "provider" accepted
  readonly attempts: MailMessage[]; // every call to send, accepted or not
  // Until called with null, every send fails with this error.
  failWith(code: MailerErrorCode | null): void;
}

export function createFakeMailer(): FakeMailer {
  const sent: MailMessage[] = [];
  const attempts: MailMessage[] = [];
  let failure: MailerErrorCode | null = null;

  return {
    sent,
    attempts,
    failWith(code) {
      failure = code;
    },
    send(message) {
      attempts.push(message);
      if (failure !== null) return Promise.reject(new MailerError(failure));
      sent.push(message);
      return Promise.resolve({ id: `fake-${String(sent.length)}` });
    },
  };
}
