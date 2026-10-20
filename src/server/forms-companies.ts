import { getSetting, many, one, run, setSetting } from './db.js';
import { odooSearchRead } from './odoo-client.js';
import {
  ensureIncomingPickingTypeId,
  listCompaniesWithoutIncomingWarehouse,
} from './odoo-resolve.js';

/** Empresa padrão (Reciclarenda) para registros sem company_id no Odoo. */
export const DEFAULT_COMPANY_ODOO_ID = '1';

/**
 * Parceiros Odoo com company_id vazio são compartilhados entre empresas.
 * Usamos '0' (id inexistente) para não colidir com COALESCE(..., '1') nem com a migração que zera ''.
 */
export const SHARED_COMPANY_ODOO_ID = '0';

/** True quando o many2one/company_id do Odoo está vazio (False/null). */
export function isOdooCompanyUnset(raw: unknown): boolean {
  if (raw === false || raw == null || raw === '') return true;
  if (Array.isArray(raw) && (raw[0] === false || raw[0] == null || raw[0] === '')) return true;
  return false;
}

/** company_odoo_id para res.partner: compartilhado ('0') ou id da empresa. */
export function resolvePartnerCompanyOdooId(raw: unknown): string {
  if (isOdooCompanyUnset(raw)) return SHARED_COMPANY_ODOO_ID;
  return resolveCompanyOdooId(raw);
}

/** SQL: parceiros da empresa ativa + compartilhados. `param` = placeholder ($1, $2…). */
export function sqlPartnerVisibleInCompany(param: string, column = 'company_odoo_id'): string {
  return `(${column} = ${param} OR ${column} = '${SHARED_COMPANY_ODOO_ID}')`;
}

export type FormsCompany = {
  id: string;
  name: string;
  email: string;
  phone: string;
  vat: string;
  currency: string;
  partner_odoo_id: string;
  /** País fiscal (res.country id) usado para filtrar account.tax. */
  country_odoo_id: string;
  synced_at: string;
};

function textField(value: unknown): string {
  if (value === false || value == null) return '';
  return String(value);
}

function many2oneId(value: unknown): string {
  if (Array.isArray(value) && value[0] != null) return String(value[0]);
  return '';
}

function many2oneName(value: unknown): string {
  if (Array.isArray(value) && value[1] != null) return String(value[1]);
  return '';
}

export function resolveCompanyOdooId(raw: unknown): string {
  const fromM2o = many2oneId(raw);
  if (fromM2o) return fromM2o;
  if (raw != null && raw !== false && String(raw).trim()) return String(raw).trim();
  return DEFAULT_COMPANY_ODOO_ID;
}

export function getActiveCompanyId(): string {
  return getSetting('odoo_active_company_id') || DEFAULT_COMPANY_ODOO_ID;
}

export async function setActiveCompanyId(id: string): Promise<FormsCompany> {
  const clean = String(id || '').trim();
  if (!clean) throw new Error('Empresa inválida');
  const company = await one<FormsCompany>(`SELECT * FROM forms_companies WHERE id = $1`, [clean]);
  if (!company) throw new Error('Empresa não encontrada. Sincronize as empresas do Odoo.');
  await setSetting('odoo_active_company_id', clean);
  return company;
}

export async function listCompanies(): Promise<FormsCompany[]> {
  return many<FormsCompany>(`SELECT * FROM forms_companies ORDER BY name ASC`);
}

export async function getActiveCompany(): Promise<FormsCompany | null> {
  const id = getActiveCompanyId();
  const row = await one<FormsCompany>(`SELECT * FROM forms_companies WHERE id = $1`, [id]);
  if (row) return row;
  return (
    (await one<FormsCompany>(`SELECT * FROM forms_companies WHERE id = $1`, [DEFAULT_COMPANY_ODOO_ID])) ||
    null
  );
}

export async function companiesPayload(options?: {
  /** Filtra/trava empresas para usuário vinculado a uma empresa. */
  companyOdooId?: string;
  canSwitchCompany?: boolean;
}): Promise<{
  items: FormsCompany[];
  activeId: string;
  active: FormsCompany | null;
  canSwitchCompany: boolean;
}> {
  let items = await listCompanies();
  if (!items.length) {
    try {
      items = await syncCompaniesFromOdoo();
    } catch {
      items = [];
    }
  }

  const lockedId = String(options?.companyOdooId || '').trim();
  const canSwitchCompany = options?.canSwitchCompany !== false && !lockedId;

  if (lockedId) {
    items = items.filter((item) => item.id === lockedId);
    if (items.length && getActiveCompanyId() !== lockedId) {
      await setSetting('odoo_active_company_id', lockedId);
    }
  }

  const activeId = lockedId || getActiveCompanyId();
  const active =
    items.find((item) => item.id === activeId) ||
    items.find((item) => item.id === DEFAULT_COMPANY_ODOO_ID) ||
    items[0] ||
    null;
  if (!lockedId && active && active.id !== getActiveCompanyId()) {
    await setSetting('odoo_active_company_id', active.id);
  }
  return { items, activeId: active?.id || activeId, active, canSwitchCompany };
}

export async function syncCompaniesFromOdoo(): Promise<FormsCompany[]> {
  await run(`ALTER TABLE forms_companies ADD COLUMN IF NOT EXISTS country_odoo_id TEXT NOT NULL DEFAULT ''`);

  const rows = await odooSearchRead<{
    id: number;
    name: string;
    partner_id: unknown;
    email: string | false;
    phone: string | false;
    vat: string | false;
    currency_id: unknown;
    country_id: unknown;
  }>('res.company', [], ['id', 'name', 'partner_id', 'email', 'phone', 'vat', 'currency_id', 'country_id'], {
    order: 'id asc',
  });

  const now = new Date().toISOString();
  for (const row of rows) {
    const id = String(row.id);
    await run(
      `INSERT INTO forms_companies(id, name, email, phone, vat, currency, partner_odoo_id, country_odoo_id, synced_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         vat = EXCLUDED.vat,
         currency = EXCLUDED.currency,
         partner_odoo_id = EXCLUDED.partner_odoo_id,
         country_odoo_id = EXCLUDED.country_odoo_id,
         synced_at = EXCLUDED.synced_at`,
      [
        id,
        textField(row.name) || `Empresa ${id}`,
        textField(row.email),
        textField(row.phone),
        textField(row.vat),
        many2oneName(row.currency_id),
        many2oneId(row.partner_id),
        many2oneId(row.country_id),
        now,
      ],
    );
  }

  const active = getActiveCompanyId();
  const stillExists = await one<{ id: string }>(`SELECT id FROM forms_companies WHERE id = $1`, [active]);
  if (!stillExists) {
    await setSetting('odoo_active_company_id', DEFAULT_COMPANY_ODOO_ID);
  }

  // Garante depósito/recebimento no Odoo para cada empresa (necessário em compras).
  for (const row of rows) {
    try {
      await ensureIncomingPickingTypeId(row.id);
    } catch (error) {
      console.warn(
        `odoo-companies: warehouse empresa ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  try {
    const missing = await listCompaniesWithoutIncomingWarehouse();
    await setSetting('odoo_companies_without_warehouse', JSON.stringify(missing));
  } catch {
    await setSetting('odoo_companies_without_warehouse', '[]');
  }

  return listCompanies();
}

export function companiesWithoutWarehouseFromCache(): Array<{ id: number; name: string }> {
  try {
    const raw = getSetting('odoo_companies_without_warehouse') || '[]';
    const parsed = JSON.parse(raw) as Array<{ id: number; name: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
