import { api, type ApiResult } from './api.ts';
import type { Debtor, DebtorsPage } from './api-types.ts';

const DEBTOR_PAGE = 100;

// The invoice list carries the debtor's id, not its name, so the names come from the debtors
// endpoint (a few pages at most) and are matched by id.
export async function loadDebtors(): Promise<ApiResult<Map<string, Debtor>>> {
  const names = new Map<string, Debtor>();
  let offset = 0;
  for (;;) {
    const result = await api<DebtorsPage>(
      'GET',
      `/api/debtors?limit=${String(DEBTOR_PAGE)}&offset=${String(offset)}`,
    );
    if (!result.ok) return result;
    for (const debtor of result.data.debtors) names.set(debtor.id, debtor);
    offset += result.data.page.limit;
    if (result.data.debtors.length === 0 || offset >= result.data.page.total) {
      return { ok: true, data: names };
    }
  }
}
