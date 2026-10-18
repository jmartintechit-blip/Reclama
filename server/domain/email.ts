// The one rule for what counts as an email address, shared by the API schema and the CSV
// import. ASCII only on purpose: the database check `email = lower(email)` must agree with
// JavaScript's toLowerCase(), and for non-ASCII letters the two can differ. The shape is
// "something@label.label" with a linear regex (no nested repeats), so a long input cannot make
// it slow. It leaves out whitespace and the characters , ; < > " that would let one cell hold
// several addresses or a display name.
export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Trims and lowercases, then checks the length and the shape. Returns the normalised address,
// or null when it is not valid.
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email)
    ? email
    : null;
}
