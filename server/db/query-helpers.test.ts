import { describe, expect, it } from 'vitest';
import {
  buildSet,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePage,
} from './query-helpers.ts';

describe('normalizePage', () => {
  it('uses the defaults when nothing is given', () => {
    expect(normalizePage()).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(normalizePage({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it('keeps sane values', () => {
    expect(normalizePage({ limit: 10, offset: 20 })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it.each([
    [1_000_000, MAX_PAGE_SIZE],
    [MAX_PAGE_SIZE + 1, MAX_PAGE_SIZE],
    [0, 1],
    [-5, 1],
    [Number.NaN, DEFAULT_PAGE_SIZE],
    [Number.POSITIVE_INFINITY, DEFAULT_PAGE_SIZE],
    [1.5, DEFAULT_PAGE_SIZE],
  ])('turns the limit %s into %s', (limit, expected) => {
    expect(normalizePage({ limit }).limit).toBe(expected);
  });

  it.each([-1, Number.NaN, 2.5, Number.POSITIVE_INFINITY])(
    'turns the offset %s into 0',
    (offset) => {
      expect(normalizePage({ offset }).offset).toBe(0);
    },
  );
});

describe('buildSet', () => {
  it('numbers the parameters from firstParam and skips undefined keys', () => {
    const patch: { a?: string; b?: string | null; c?: number } = {
      a: 'x',
      c: 3,
    };

    expect(buildSet(patch, ['a', 'b', 'c'], 3)).toEqual({
      sets: 'a = $3, c = $4',
      params: ['x', 3],
    });
  });

  it('keeps null (it clears a column) and ignores keys that are not in the column list', () => {
    const patch: { a?: string | null; b?: string } = { a: null, b: 'ignored' };

    expect(buildSet(patch, ['a'], 2)).toEqual({
      sets: 'a = $2',
      params: [null],
    });
  });

  it('gives an empty set for an empty patch', () => {
    expect(buildSet<{ a?: string }>({}, ['a'], 2)).toEqual({
      sets: '',
      params: [],
    });
  });
});
