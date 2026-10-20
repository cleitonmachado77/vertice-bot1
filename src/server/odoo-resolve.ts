import { odooCreate, odooSearchRead } from './odoo-client.js';
import { odooLookupNames } from './odoo-pt.js';

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
  const candidates = odooLookupNames(name).map(cleanName).filter(Boolean);
  for (const clean of candidates) {
    const exact = await odooSearchRead<{ id: number }>(
      model,
      [['name', '=', clean]],
      ['id'],
      { limit: 1 },
    );
    if (exact[0]?.id) return exact[0].id;
  }
  for (const clean of candidates) {
    const fuzzy = await odooSearchRead<{ id: number }>(
      model,
      [['name', 'ilike', clean]],
      ['id'],
      { limit: 1 },
    );
    if (fuzzy[0]?.id) return fuzzy[0].id;
  }
  return 0;
}

export async function findPaymentTermId(name: string): Promise<number> {
  return findIdByName('account.payment.term', name);
}

export async function findSalesTeamId(name: string): Promise<number> {
  return findIdByName('crm.team', name);
}

export async function findCategoryId(name: string): Promise<number> {
  for (const clean of odooLookupNames(name).map(cleanName).filter(Boolean)) {
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
    if (found[0]?.id) return found[0].id;
  }
  return 0;
}

export async function findUomId(name: string): Promise<number> {
  for (const clean of odooLookupNames(name).map(cleanName).filter(Boolean)) {
    const found = await odooSearchRead<{ id: number }>(
      'uom.uom',
      ['|', ['name', '=', clean], ['name', 'ilike', clean]],
      ['id'],
      { limit: 1 },
    );
    if (found[0]?.id) return found[0].id;
  }
  return 0;
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

/**
 * Tipo de operação "Recebimentos" (Deliver To) exigido em purchase.order.
 * Preferência: in_type_id do depósito da empresa → picking type incoming da empresa.
 */
export async function findIncomingPickingTypeId(companyId: number): Promise<number> {
  if (!companyId || companyId <= 0) return 0;

  const warehouses = await odooSearchRead<{ id: number; in_type_id: unknown }>(
    'stock.warehouse',
    [['company_id', '=', companyId]],
    ['id', 'in_type_id'],
    { limit: 5 },
  );
  for (const wh of warehouses) {
    const typeId = m2oIdNum(wh.in_type_id);
    if (typeId > 0) return typeId;
  }

  const types = await odooSearchRead<{ id: number }>(
    'stock.picking.type',
    [
      '&',
      ['code', '=', 'incoming'],
      '|',
      ['company_id', '=', companyId],
      ['company_id', '=', false],
    ],
    ['id'],
    { limit: 1 },
  );
  return types[0]?.id || 0;
}

/**
 * Garante um tipo de recebimento para a empresa: usa o existente ou cria um
 * stock.warehouse padrão no Odoo (fonte da verdade de inventário).
 */
export async function ensureIncomingPickingTypeId(companyId: number): Promise<number> {
  const existing = await findIncomingPickingTypeId(companyId);
  if (existing > 0) return existing;
  if (!companyId || companyId <= 0) return 0;

  const companies = await odooSearchRead<{ id: number; name: string }>(
    'res.company',
    [['id', '=', companyId]],
    ['id', 'name'],
    { limit: 1 },
  );
  const companyName = String(companies[0]?.name || `Empresa ${companyId}`).trim();
  const codeBase = `C${companyId}`.slice(0, 5);
  const codes = [codeBase, `W${companyId}`.slice(0, 5), `E${companyId}`.slice(0, 5)];

  let lastError = '';
  for (const code of codes) {
    try {
      const whId = await odooCreate(
        'stock.warehouse',
        {
          name: (companyName || `Depósito ${companyId}`).slice(0, 80),
          code,
          company_id: companyId,
        },
        {
          context: {
            allowed_company_ids: [companyId],
            force_company: companyId,
          },
        },
      );
      const created = await odooSearchRead<{ id: number; in_type_id: unknown }>(
        'stock.warehouse',
        [['id', '=', whId]],
        ['id', 'in_type_id'],
        { limit: 1 },
      );
      const typeId = m2oIdNum(created[0]?.in_type_id);
      if (typeId > 0) return typeId;
      const again = await findIncomingPickingTypeId(companyId);
      if (again > 0) return again;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Código duplicado ou warehouse já existe — tenta achar de novo.
      const again = await findIncomingPickingTypeId(companyId);
      if (again > 0) return again;
    }
  }
  if (lastError) {
    throw new Error(
      `Empresa Odoo ${companyId} sem depósito/tipo de recebimento e falha ao criar warehouse: ${lastError}`,
    );
  }
  return 0;
}

/** Empresas Odoo sem warehouse com recebimento — para aviso em Configurações. */
export async function listCompaniesWithoutIncomingWarehouse(): Promise<
  Array<{ id: number; name: string }>
> {
  const companies = await odooSearchRead<{ id: number; name: string }>(
    'res.company',
    [],
    ['id', 'name'],
    { limit: 50, order: 'id asc' },
  );
  const missing: Array<{ id: number; name: string }> = [];
  for (const company of companies) {
    const typeId = await findIncomingPickingTypeId(company.id);
    if (typeId <= 0) {
      missing.push({ id: company.id, name: String(company.name || company.id) });
    }
  }
  return missing;
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
