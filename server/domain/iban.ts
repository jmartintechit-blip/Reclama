// IBAN check (ISO 13616, ISO 7064 mod 97-10): move the first four characters to the end, turn
// each letter into two digits (A = 10 ... Z = 35) and the whole number must leave remainder 1
// when divided by 97. That number has up to 68 digits, too big for a JS number, so the
// remainder is updated one character at a time with integer arithmetic only.

// Returns the IBAN without spaces and in upper case, or null when it is not valid. Any
// country is accepted (letters and digits, 5 to 34 characters); Spanish ones (ES) must also
// have their exact shape: ES, two check digits and 20 digits.
export function parseIban(text: string): string | null {
  const compact = text.replace(/\s+/g, '');
  // ASCII only, checked before toUpperCase(): for example "ß" would become "SS" and "ı" would
  // become "I" and turn an invalid text into a valid one.
  if (!/^[A-Za-z0-9]{5,34}$/.test(compact)) return null;
  const iban = compact.toUpperCase();
  if (!/^[A-Z]{2}\d{2}/.test(iban)) return null;
  if (iban.startsWith('ES') && !/^ES\d{22}$/.test(iban)) return null;

  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const value = char >= 'A' ? char.charCodeAt(0) - 55 : Number(char);
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1 ? iban : null;
}
