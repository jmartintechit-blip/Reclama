// Tax ids are compared without spaces or dashes and in upper case: "b-12 345 678" is B12345678.
export function normalizeTaxId(taxId: string): string {
  return taxId.toUpperCase().replace(/[\s-]/g, '');
}

// How the same debtor is recognised again (for example in a CSV import). The name is compared
// without accents (NFD, then marks removed), in lower case, with runs of spaces collapsed and
// trimmed. When a tax id is given it is part of the identity: the same name with another tax id
// is another debtor. A JSON array keeps the two parts apart whatever characters they hold.
export function debtorMatchKey(name: string, taxId?: string | null): string {
  const normalizedName = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify([normalizeTaxId(taxId ?? ''), normalizedName]);
}
