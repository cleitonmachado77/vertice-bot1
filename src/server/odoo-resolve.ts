import { odooSearchRead } from './odoo-client.js';

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function splitNames(csv: string): string[] {
  return String(csv || '')
    .split(/[,;|/]+/)
    .map((part) => cleanName(part))
    .filter(Boolean);
}

async function findIdByName(model: string, name: string): Promise<number> {
  const clean = cleanName(name);
  if (!clean) return 0;
  const exact = await odooSearchRead<{ id: number }>(
    model,
    [['name', '=', clean]],
    ['id'],
    { limit: 1 },
  );
  if (exact[0]?.id) return exact[0].id;
  const fuzzy = await odooSearchRead<{ id: number }>(
    model,
    [['name', 'ilike', clean]],
    ['id'],
    { limit: 1 },
  );
  return fuzzy[0]?.id || 0;
}

export async function findPaymentTermId(name: string): Promise<number> {
  return findIdByName('account.payment.term', name);
}

export async function findSalesTeamId(name: string): Promise<number> {
  return findIdByName('crm.team', name);
}

export async function findCategoryId(name: string): Promise<number> {
  const clean = cleanName(name);
  if (!clean) return 0;
  const found = await odooSearchRead<{ id: number }>(
    'product.category',
    [
      '|',
      '|',
      ['complete_name', '=', clean],
      ['name', '=', clean],
      '|',
      ['complete_name', 'ilike', clean],
      ['name', 'ilike', clean],
    ],
    ['id'],
    { limit: 1 },
  );
  return found[0]?.id || 0;
}

export async function findUomId(name: string): Promise<number> {
  const clean = cleanName(name);
  if (!clean) return 0;
  const found = await odooSearchRead<{ id: number }>(
    'uom.uom',
    ['|', ['name', '=', clean], ['name', 'ilike', clean]],
    ['id'],
    { limit: 1 },
  );
  return found[0]?.id || 0;
}

async function findIdsByNames(model: string, csv: string): Promise<number[]> {
  const names = splitNames(csv);
  const ids: number[] = [];
  for (const name of names) {
    const id = await findIdByName(model, name);
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function m2oIdNum(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number' && value > 0) return value;
  return 0;
}

export async function findTaxIds(
  csv: string,
  options: { companyId?: number; countryId?: number; typeTaxUse?: 'sale' | 'purchase' } = {},
): Promise<number[]> {
  const names = splitNames(csv);
  const ids: number[] = [];
  for (const name of names) {
    const clean = cleanName(name);
    if (!clean) continue;
    const rows = await odooSearchRead<{
      id: number;
      name: string;
      type_tax_use?: string;
      company_id?: unknown;
      country_id?: unknown;
    }>(
      'account.tax',
      ['&', ['active', '=', true], '|', ['name', '=', clean], ['name', 'ilike', clean]],
      ['id', 'name', 'type_tax_use', 'company_id', 'country_id'],
      { limit: 30 },
    ).catch(() => []);

    const ranked = rows
      .filter((row) => {
        const companyId = m2oIdNum(row.company_id);
        const countryId = m2oIdNum(row.country_id);
        const use = String(row.type_tax_use || '');
        if (options.companyId && companyId > 0 && companyId !== options.companyId) return false;
        if (options.countryId && countryId > 0 && countryId !== options.countryId) return false;
        if (
          options.typeTaxUse &&
          use &&
          use !== options.typeTaxUse &&
          use !== 'all'
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Preferência: nome exato → mesma empresa → mesmo país
        const aExact = cleanName(a.name) === clean ? 0 : 1;
        const bExact = cleanName(b.name) === clean ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aCo = m2oIdNum(a.company_id) === options.companyId ? 0 : 1;
        const bCo = m2oIdNum(b.company_id) === options.companyId ? 0 : 1;
        if (aCo !== bCo) return aCo - bCo;
        return 0;
      });

    const id = ranked[0]?.id || 0;
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Marcadores de pedido de venda (crm.tag no Odoo 16+). */
export async function findSaleTagIds(csv: string): Promise<number[]> {
  return findIdsByNames('crm.tag', csv);
}

export async function namesByIds(
  model: string,
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  const map = new Map<number, string>();
  if (!unique.length) return map;
  const rows = await odooSearchRead<{ id: number; name: string }>(
    model,
    [['id', 'in', unique]],
    ['id', 'name'],
    { limit: unique.length },
  );
  for (const row of rows) {
    map.set(row.id, String(row.name || ''));
  }
  return map;
}

export function m2mIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => typeof id === 'number' && id > 0);
}

export function joinNames(ids: number[], names: Map<number, string>): string {
  return ids
    .map((id) => names.get(id) || '')
    .filter(Boolean)
    .join(', ');
}
