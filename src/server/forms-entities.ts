import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { getActiveCompanyId, sqlPartnerVisibleInCompany } from './forms-companies.js';
import { emptyHeader } from './forms-fields.js';
import { listCatalogProducts, type CatalogProduct } from './forms-catalog.js';
import { partnerNameKey } from './forms-name-key.js';

export type EntityPartner = {
  id: string;
  name: string;
  is_customer: boolean;
  is_vendor: boolean;
  odoo_id: string;
  email: string;
  phone: string;
  vat: string;
  street: string;
  city: string;
  is_company: boolean;
  updated_at: string;
};

export type EntityProduct = CatalogProduct & {
  weight?: string;
  odoo_id: string;
  odoo_sync_error?: string;
  track_inventory?: string;
  updated_at?: string;
};

function parseHeader(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) {
      out[key] = item == null ? '' : String(item);
    }
    return out;
  } catch {
    return {};
  }
}

function mapPartner(row: {
  id: string;
  name: string;
  is_customer: number;
  is_vendor: number;
  odoo_id: string;
  email?: string;
  phone?: string;
  vat?: string;
  street?: string;
  city?: string;
  is_company?: number;
  updated_at: string;
}): EntityPartner {
  return {
    id: row.id,
    name: row.name,
    is_customer: Number(row.is_customer) === 1,
    is_vendor: Number(row.is_vendor) === 1,
    odoo_id: row.odoo_id || '',
    email: row.email || '',
    phone: row.phone || '',
    vat: row.vat || '',
    street: row.street || '',
    city: row.city || '',
    is_company: Number(row.is_company) === 1,
    updated_at: row.updated_at,
  };
}

const PARTNER_SELECT = `id, name, is_customer, is_vendor, COALESCE(odoo_id, '') AS odoo_id,
  COALESCE(email, '') AS email, COALESCE(phone, '') AS phone, COALESCE(vat, '') AS vat,
  COALESCE(street, '') AS street, COALESCE(city, '') AS city, COALESCE(is_company, 0) AS is_company,
  updated_at`;

export async function getEntityPartner(id: string): Promise<EntityPartner | undefined> {
  const companyId = getActiveCompanyId();
  const row = await one<{
    id: string;
    name: string;
    is_customer: number;
    is_vendor: number;
    odoo_id: string;
    email: string;
    phone: string;
    vat: string;
    street: string;
    city: string;
    is_company: number;
    updated_at: string;
  }>(
    `SELECT ${PARTNER_SELECT}
     FROM forms_partners
     WHERE id = $1 AND ${sqlPartnerVisibleInCompany('$2')}`,
    [id, companyId],
  );
  return row ? mapPartner(row) : undefined;
}

export async function listEntityPartners(
  role: 'customer' | 'vendor' | 'all' = 'all',
): Promise<EntityPartner[]> {
  const companyId = getActiveCompanyId();
  let sql = `SELECT ${PARTNER_SELECT}
             FROM forms_partners
             WHERE ${sqlPartnerVisibleInCompany('$1')}`;
  const params: unknown[] = [companyId];
  if (role === 'customer') sql += ` AND is_customer = 1`;
  if (role === 'vendor') sql += ` AND is_vendor = 1`;
  sql += ` ORDER BY name ASC`;
  const rows = await many<{
    id: string;
    name: string;
    is_customer: number;
    is_vendor: number;
    odoo_id: string;
    email: string;
    phone: string;
    vat: string;
    street: string;
    city: string;
    is_company: number;
    updated_at: string;
  }>(sql, params);
  return rows.map(mapPartner);
}

export async function saveEntityPartner(input: {
  id?: string;
  name: string;
  is_customer?: boolean;
  is_vendor?: boolean;
  email?: string;
  phone?: string;
  vat?: string;
  street?: string;
  city?: string;
  is_company?: boolean;
}): Promise<EntityPartner> {
  const clean = input.name.trim();
  if (!clean) throw new Error('Nome obrigatório');
  const key = partnerNameKey(clean);
  const isCustomer = input.is_customer ? 1 : 0;
  const isVendor = input.is_vendor ? 1 : 0;
  if (!isCustomer && !isVendor) throw new Error('Marque cliente e/ou fornecedor');

  const companyId = getActiveCompanyId();
  const email = (input.email || '').trim();
  const phone = (input.phone || '').trim();
  const vat = (input.vat || '').trim();
  const street = (input.street || '').trim();
  const city = (input.city || '').trim();
  const isCompany = input.is_company ? 1 : 0;

  if (input.id) {
    await run(
      `UPDATE forms_partners
       SET name = $2, name_key = $3, is_customer = $4, is_vendor = $5,
           email = $6, phone = $7, vat = $8, street = $9, city = $10, is_company = $11,
           updated_at = NOW()
       WHERE id = $1 AND ${sqlPartnerVisibleInCompany('$12')}`,
      [input.id, clean, key, isCustomer, isVendor, email, phone, vat, street, city, isCompany, companyId],
    );
    const row = await one<{
      id: string;
      name: string;
      is_customer: number;
      is_vendor: number;
      odoo_id: string;
      email: string;
      phone: string;
      vat: string;
      street: string;
      city: string;
      is_company: number;
      updated_at: string;
    }>(`SELECT ${PARTNER_SELECT} FROM forms_partners WHERE id = $1`, [input.id]);
    if (!row) throw new Error('Parceiro não encontrado');
    return mapPartner(row);
  }

  const conflict = await one<{ id: string }>(
    `SELECT id FROM forms_partners
     WHERE name_key = $1 AND ${sqlPartnerVisibleInCompany('$2')}
     ORDER BY CASE WHEN company_odoo_id = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [key, companyId],
  );
  if (conflict) {
    await run(
      `UPDATE forms_partners
       SET name = $2, is_customer = GREATEST(is_customer, $3), is_vendor = GREATEST(is_vendor, $4),
           email = CASE WHEN $5 = '' THEN email ELSE $5 END,
           phone = CASE WHEN $6 = '' THEN phone ELSE $6 END,
           vat = CASE WHEN $7 = '' THEN vat ELSE $7 END,
           street = CASE WHEN $8 = '' THEN street ELSE $8 END,
           city = CASE WHEN $9 = '' THEN city ELSE $9 END,
           is_company = GREATEST(is_company, $10),
           updated_at = NOW()
       WHERE id = $1`,
      [conflict.id, clean, isCustomer, isVendor, email, phone, vat, street, city, isCompany],
    );
    const row = await one<{
      id: string;
      name: string;
      is_customer: number;
      is_vendor: number;
      odoo_id: string;
      email: string;
      phone: string;
      vat: string;
      street: string;
      city: string;
      is_company: number;
      updated_at: string;
    }>(`SELECT ${PARTNER_SELECT} FROM forms_partners WHERE id = $1`, [conflict.id]);
    if (!row) throw new Error('Parceiro não encontrado');
    return mapPartner(row);
  }

  const id = randomUUID();
  await run(
    `INSERT INTO forms_partners(
       id, name, name_key, is_customer, is_vendor, odoo_id, company_odoo_id,
       email, phone, vat, street, city, is_company, created_at, updated_at
     ) VALUES($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
    [id, clean, key, isCustomer, isVendor, companyId, email, phone, vat, street, city, isCompany],
  );
  return {
    id,
    name: clean,
    is_customer: Boolean(isCustomer),
    is_vendor: Boolean(isVendor),
    odoo_id: '',
    email,
    phone,
    vat,
    street,
    city,
    is_company: Boolean(isCompany),
    updated_at: new Date().toISOString(),
  };
}

export async function deleteEntityPartner(id: string): Promise<void> {
  await run(`DELETE FROM forms_partners WHERE id = $1`, [id]);
}

export async function listEntityProducts(): Promise<EntityProduct[]> {
  const companyId = getActiveCompanyId();
  const rows = await many<{ id: string; header_json: string; updated_at: string }>(
    `SELECT id, header_json, updated_at FROM forms_documents
     WHERE kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
     ORDER BY title ASC`,
    [companyId],
  );
  return rows.map((row) => {
    const header = parseHeader(row.header_json);
    return {
      id: row.id,
      name: header.name || '',
      sigla: header.sigla || '',
      category: header.category || '',
      sales_price: header.sales_price || '',
      cost: header.cost || '',
      uom: header.uom || '',
      internal_ref: header.internal_ref || '',
      weight: header.weight || '',
      qty_on_hand: header.qty_on_hand || '',
      track_inventory: header.track_inventory || 'True',
      cycle_days: header.cycle_days || '',
      yield_per_ha: header.yield_per_ha || '',
      harvest_count: header.harvest_count || '',
      harvest_interval_days: header.harvest_interval_days || '',
      harvest_curve: header.harvest_curve || 'Uniforme',
      curve_intensity: header.curve_intensity || '',
      cycles_per_year: header.cycles_per_year || '',
      plants_per_area: header.plants_per_area || '',
      odoo_id: header.odoo_id || '',
      odoo_sync_error: header.odoo_sync_error || '',
      updated_at: row.updated_at,
    };
  });
}

function normalizeProductEstimateFields(input: {
  harvest_count?: string;
  harvest_interval_days?: string;
  harvest_curve?: string;
  curve_intensity?: string;
}) {
  const curve = String(input.harvest_curve || 'Uniforme').trim() || 'Uniforme';
  const countRaw = String(input.harvest_count || '').trim();
  const harvestCount = countRaw ? Math.max(1, Math.trunc(Number(countRaw) || 1)) : '';
  const intervalRaw = String(input.harvest_interval_days || '').trim();
  const harvestInterval =
    harvestCount === 1 || harvestCount === ''
      ? harvestCount === 1
        ? '0'
        : intervalRaw
      : intervalRaw;
  const intensity =
    curve === 'Uniforme' ? '0' : String(input.curve_intensity || '').trim() || '1';
  return {
    harvest_count: harvestCount === '' ? '' : String(harvestCount),
    harvest_interval_days: harvestInterval,
    harvest_curve: curve,
    curve_intensity: intensity,
  };
}

export async function saveEntityProduct(input: {
  id?: string;
  name: string;
  sigla?: string;
  category?: string;
  sales_price?: string;
  cost?: string;
  uom?: string;
  internal_ref?: string;
  weight?: string;
  qty_on_hand?: string;
  track_inventory?: string;
  cycle_days?: string;
  yield_per_ha?: string;
  harvest_count?: string;
  harvest_interval_days?: string;
  harvest_curve?: string;
  curve_intensity?: string;
  cycles_per_year?: string;
  plants_per_area?: string;
}): Promise<EntityProduct> {
  const clean = input.name.trim();
  if (!clean) throw new Error('Nome do produto obrigatório');
  const estimate = normalizeProductEstimateFields(input);
  const header = emptyHeader('product');
  header.name = clean;
  header.sigla = input.sigla || '';
  header.category = input.category || '';
  header.sales_price = input.sales_price || '';
  header.cost = input.cost || '';
  header.uom = input.uom || '';
  header.internal_ref = input.internal_ref || '';
  header.weight = input.weight || '';
  header.qty_on_hand = input.qty_on_hand || '';
  header.track_inventory = input.track_inventory || 'True';
  header.cycle_days = input.cycle_days || '';
  header.yield_per_ha = input.yield_per_ha || '';
  header.harvest_count = estimate.harvest_count;
  header.harvest_interval_days = estimate.harvest_interval_days;
  header.harvest_curve = estimate.harvest_curve;
  header.curve_intensity = estimate.curve_intensity;
  header.cycles_per_year = input.cycles_per_year || '';
  header.plants_per_area = input.plants_per_area || '';

  const companyId = getActiveCompanyId();
  header.company_odoo_id = companyId;

  if (input.id) {
    const existing = await one<{ header_json: string }>(
      `SELECT header_json FROM forms_documents
       WHERE id = $1 AND kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`,
      [input.id, companyId],
    );
    if (!existing) throw new Error('Produto não encontrado');
    const prev = parseHeader(existing.header_json);
    const merged: Record<string, string> = { ...prev, ...header, odoo_id: prev.odoo_id || '' };
    await run(
      `UPDATE forms_documents SET title = $2, header_json = $3, company_odoo_id = $4, updated_at = NOW() WHERE id = $1`,
      [input.id, clean, JSON.stringify(merged), companyId],
    );
    return {
      id: input.id,
      name: clean,
      sigla: merged.sigla || '',
      category: merged.category || '',
      sales_price: merged.sales_price || '',
      cost: merged.cost || '',
      uom: merged.uom || '',
      internal_ref: merged.internal_ref || '',
      weight: merged.weight || '',
      qty_on_hand: merged.qty_on_hand || '',
      track_inventory: merged.track_inventory || 'True',
      cycle_days: merged.cycle_days || '',
      yield_per_ha: merged.yield_per_ha || '',
      harvest_count: merged.harvest_count || '',
      harvest_interval_days: merged.harvest_interval_days || '',
      harvest_curve: merged.harvest_curve || 'Uniforme',
      curve_intensity: merged.curve_intensity || '',
      cycles_per_year: merged.cycles_per_year || '',
      plants_per_area: merged.plants_per_area || '',
      odoo_id: merged.odoo_id || '',
    };
  }

  const id = randomUUID();
  await run(
    `INSERT INTO forms_documents(id, kind, title, status, header_json, company_odoo_id, created_at, updated_at)
     VALUES($1, 'product', $2, 'draft', $3, $4, NOW(), NOW())`,
    [id, clean, JSON.stringify(header), companyId],
  );
  return {
    id,
    name: clean,
    sigla: header.sigla || '',
    category: header.category || '',
    sales_price: header.sales_price || '',
    cost: header.cost || '',
    uom: header.uom || '',
    internal_ref: header.internal_ref || '',
    weight: header.weight || '',
    qty_on_hand: header.qty_on_hand || '',
    track_inventory: header.track_inventory || 'True',
    cycle_days: header.cycle_days || '',
    yield_per_ha: header.yield_per_ha || '',
    harvest_count: header.harvest_count || '',
    harvest_interval_days: header.harvest_interval_days || '',
    harvest_curve: header.harvest_curve || 'Uniforme',
    curve_intensity: header.curve_intensity || '',
    cycles_per_year: header.cycles_per_year || '',
    plants_per_area: header.plants_per_area || '',
    odoo_id: '',
  };
}

export async function deleteEntityProduct(id: string): Promise<void> {
  await run(`DELETE FROM forms_document_lines WHERE document_id = $1`, [id]);
  await run(`DELETE FROM forms_documents WHERE id = $1 AND kind = 'product'`, [id]);
}

export async function entitiesSummary(): Promise<{
  products: number;
  customers: number;
  vendors: number;
}> {
  const [products, partners] = await Promise.all([listCatalogProducts(), listEntityPartners('all')]);
  return {
    products: products.length,
    customers: partners.filter((p) => p.is_customer).length,
    vendors: partners.filter((p) => p.is_vendor).length,
  };
}
