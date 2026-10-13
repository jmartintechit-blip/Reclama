import { types as defaultTypes, type CustomTypesConfig } from 'pg';

// pg and PGlite identify the type of every column by its Postgres type id (20 and 1082, they
// never change). The ids come from pg because PGlite is a devDependency and this file is used
// by production code.
const OID_INT8 = defaultTypes.builtins.INT8;
const OID_DATE = defaultTypes.builtins.DATE;

// bigint columns (money in cents). By default pg returns a string and PGlite a number or a
// bigint depending on the size. A JS number is exact only up to 2^53 - 1 (about 90 trillion
// euros in cents), so a bigger value means a bug or corrupt data: fail instead of rounding.
export function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('int8 value is outside the safe integer range');
  }
  return value;
}

// date columns stay as the text "YYYY-MM-DD". A JS Date has a time and a time zone, so the
// same day would change depending on the zone of the server (the two drivers even disagree
// about it: local midnight in pg, UTC midnight in PGlite).
export function parseDate(text: string): string {
  return text;
}

// For PGlite (`parsers` option): type id -> function that receives the value as text.
export const typeParsers: Record<number, (text: string) => unknown> = {
  [OID_INT8]: parseInt8,
  [OID_DATE]: parseDate,
};

// For pg (`types` option of the Pool). It is passed per pool on purpose: changing the global
// `pg.types` would affect every other user of the library. Everything that is not int8 or date
// (timestamptz, uuid, jsonb...) keeps the default parser of pg.
export const pgTypes: CustomTypesConfig = {
  getTypeParser: (
    ...[oid, format]: Parameters<typeof defaultTypes.getTypeParser>
  ): unknown => {
    const override = format === 'binary' ? undefined : typeParsers[oid];
    return override ?? defaultTypes.getTypeParser(oid, format);
  },
};
