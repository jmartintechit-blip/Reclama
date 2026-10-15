import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProfile, updateProfile } from './profile.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { newUser } from './test-fixtures.ts';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

const EMPTY = {
  business_name: null,
  tax_id: null,
  address: null,
  iban: null,
  default_compensation: 'PER_CLAIM',
};

describe('getProfile', () => {
  it('returns the empty profile that registration creates', async () => {
    const userId = await newUser(db);

    expect(await getProfile(db, userId)).toEqual(EMPTY);
  });

  it('returns null for a user without a profile', async () => {
    expect(await getProfile(db, MISSING_ID)).toBeNull();
  });
});

describe('updateProfile', () => {
  it('changes only the fields in the patch', async () => {
    const userId = await newUser(db);

    const first = await updateProfile(db, userId, {
      business_name: 'Taller Pérez',
      iban: 'ES9121000418450200051332',
    });
    const second = await updateProfile(db, userId, {
      address: 'Calle Mayor 1',
      default_compensation: 'NONE',
    });

    expect(first).toEqual({
      ...EMPTY,
      business_name: 'Taller Pérez',
      iban: 'ES9121000418450200051332',
    });
    expect(second).toEqual({
      business_name: 'Taller Pérez',
      tax_id: null,
      address: 'Calle Mayor 1',
      iban: 'ES9121000418450200051332',
      default_compensation: 'NONE',
    });
    expect(await getProfile(db, userId)).toEqual(second);
  });

  it('clears a field set to null and keeps one set to undefined', async () => {
    const userId = await newUser(db);
    await updateProfile(db, userId, { business_name: 'A', tax_id: 'B1' });

    const result = await updateProfile(db, userId, {
      business_name: null,
      tax_id: undefined,
    });

    expect(result).toEqual({ ...EMPTY, tax_id: 'B1' });
  });

  it('returns the current profile for an empty patch', async () => {
    const userId = await newUser(db);
    await updateProfile(db, userId, { business_name: 'A' });

    expect(await updateProfile(db, userId, {})).toEqual({
      ...EMPTY,
      business_name: 'A',
    });
  });

  it("never touches another user's profile", async () => {
    const a = await newUser(db);
    const b = await newUser(db);
    await updateProfile(db, a, { business_name: 'Business of A' });

    await updateProfile(db, b, {
      business_name: 'Business of B',
      user_id: a,
    } as { business_name: string });

    expect(await getProfile(db, a)).toEqual({
      ...EMPTY,
      business_name: 'Business of A',
    });
    expect(await getProfile(db, b)).toEqual({
      ...EMPTY,
      business_name: 'Business of B',
    });
  });

  it('answers null for a user without a profile, for any patch', async () => {
    expect(
      await updateProfile(db, MISSING_ID, { business_name: 'x' }),
    ).toBeNull();
    expect(await updateProfile(db, MISSING_ID, {})).toBeNull();
  });
});
