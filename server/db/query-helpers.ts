export interface Page {
  limit?: number;
  offset?: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

// Anything that is not a sane integer falls back to a safe value: a list can never be
// unbounded, whatever the caller passes.
export function normalizePage({ limit, offset }: Page = {}): {
  limit: number;
  offset: number;
} {
  return {
    limit: Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit as number, 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE,
    offset:
      Number.isSafeInteger(offset) && (offset as number) > 0
        ? (offset as number)
        : 0,
  };
}

// "col = $n, col = $n+1" for a partial update. `columns` is a fixed list written in the
// repository (never user input) and is checked against the keys of the patch type, so only
// those names can ever reach the SQL text; the values always travel as parameters. A key that
// is `undefined` is left alone; `null` is a value (it clears the column).
export function buildSet<P extends object>(
  patch: P,
  columns: readonly (keyof P & string)[],
  firstParam: number,
): { sets: string; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const column of columns) {
    const value: unknown = patch[column];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${String(firstParam + params.length - 1)}`);
  }
  return { sets: sets.join(', '), params };
}
