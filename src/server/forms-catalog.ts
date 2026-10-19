import { randomUUID } from 'node:crypto';
import { many, one, run } from './db.js';
import { getActiveCompany, getActiveCompanyId } from './forms-companies.js';
import { emptyHeader } from './forms-fields.js';
import { listOdooRefsGrouped, type OdooRefItem, type OdooRefType } from './forms-odoo-refs.js';
import { odooLabelPt } from './odoo-pt.js';
import type { FormDocument } from './forms.js';

/** Impostos visíveis para a empresa ativa (company_id + país fiscal), como no Odoo. */
function filterTaxesForCompany(
  taxes: OdooRefItem[],
  companyId: string,
  countryId: string,
): OdooRefItem[] {
  return taxes.filter((tax) => {
    const taxCompany = String(tax.meta.company_id || '');
    const taxCountry = String(tax.meta.country_id || '');
    const companyOk = !taxCompany || taxCompany === companyId;
    const countryOk = !taxCountry || !countryId || taxCountry === countryId;
    return companyOk && countryOk;
  });
}

export type CatalogProduct = {
  id: string;
  name: string;
  category: string;
  sales_price: string;
  cost: string;
  uom: string;
  internal_ref: string;
  qty_on_hand: string;
};

export type CatalogPartner = {
  id: string;
  name: string;
  is_customer: boolean;
  is_vendor: boolean;
  odoo_id?: string;
};

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

export async function listCatalogProducts(): Promise<CatalogProduct[]> {
  const companyId = getActiveCompanyId();
  const rows = await many<{ id: string; header_json: string }>(
    `SELECT id, header_json FROM forms_documents
     WHERE kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
     ORDER BY updated_at DESC`,
    [companyId],
  );
  const products: CatalogProduct[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const header = parseHeader(row.header_json);
    const name = header.name?.trim();
    if (!name) continue;
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({
      id: row.id,
      name,
      category: header.category || '',
      sales_price: header.sales_price || '',
      cost: header.cost || '',
      uom: header.uom || '',
      internal_ref: header.internal_ref || '',
      qty_on_hand: header.qty_on_hand || '',
    });
  }
  return products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export async function listCatalogPartners(): Promise<CatalogPartner[]> {
  const companyId = getActiveCompanyId();
  const rows = await many<{
    id: string;
    name: string;
    is_customer: number;
    is_vendor: number;
    odoo_id: string;
  }>(
    `SELECT id, name, is_customer, is_vendor, COALESCE(odoo_id, '') AS odoo_id
     FROM forms_partners
     WHERE COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
     ORDER BY name ASC`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    is_customer: Number(row.is_customer) === 1,
    is_vendor: Number(row.is_vendor) === 1,
    odoo_id: row.odoo_id || '',
  }));
}

export async function getFormsCatalog(options: { backfill?: boolean } = {}): Promise<{
  products: CatalogProduct[];
  partners: CatalogPartner[];
  refs: Record<OdooRefType, OdooRefItem[]>;
  activeCompanyId: string;
  activeCountryId: string;
}> {
  // Backfill é caro (N writes). Só sob demanda — o pull Odoo já alimenta o catálogo.
  if (options.backfill) await backfillSharedCatalog();
  const companyId = getActiveCompanyId();
  const [products, partners, refs, company] = await Promise.all([
    listCatalogProducts(),
    listCatalogPartners(),
    listOdooRefsGrouped(),
    getActiveCompany(),
  ]);
  const countryId = company?.country_odoo_id || '';
  refs.tax = filterTaxesForCompany(refs.tax, companyId, countryId);
  // Exibe cadastros auxiliares padrão do Odoo em português (Units → Unidades, etc.).
  for (const key of ['category', 'uom'] as const) {
    refs[key] = (refs[key] || []).map((item) => ({
      ...item,
      name: odooLabelPt(item.name),
      meta: {
        ...item.meta,
        ...(item.meta?.short_name ? { short_name: odooLabelPt(item.meta.short_name) } : {}),
      },
    }));
  }
  const productsPt = products.map((item) => ({
    ...item,
    uom: odooLabelPt(item.uom),
    category: odooLabelPt(item.category),
  }));
  return {
    products: productsPt,
    partners,
    refs,
    activeCompanyId: companyId,
    activeCountryId: countryId,
  };
}

/** Garante que clientes/fornecedores/produtos já salvos entrem no catálogo. */
async function backfillSharedCatalog(): Promise<void> {
  const companyId = getActiveCompanyId();
  const docs = await many<{ id: string; kind: string; header_json: string }>(
    `SELECT id, kind, header_json FROM forms_documents
     WHERE kind IN ('sale', 'purchase')
       AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1`,
    [companyId],
  );
  if (!docs.length) return;
  const lines = await many<{ document_id: string; line_json: string }>(
    `SELECT document_id, line_json FROM forms_document_lines
     WHERE document_id = ANY($1::text[])`,
    [docs.map((doc) => doc.id)],
  );
  for (const doc of docs) {
    const header = parseHeader(doc.header_json);
    if (doc.kind === 'sale') await upsertPartner(header.customer || '', 'customer');
    if (doc.kind === 'purchase') await upsertPartner(header.vendor || '', 'vendor');
  }
  for (const line of lines) {
    const values = parseHeader(line.line_json);
    const productName = values.product || '';
    if (!productName.trim()) continue;
    const parent = docs.find((doc) => doc.id === line.document_id);
    await ensureProductByName(productName, {
      sales_price: parent?.kind === 'sale' ? values.unit_price || '' : '',
      cost: parent?.kind === 'purchase' ? values.unit_price || '' : '',
    });
  }
}

export async function upsertPartner(
  name: string,
  role: 'customer' | 'vendor',
): Promise<CatalogPartner | null> {
  const clean = name.trim();
  if (!clean) return null;
  const key = nameKey(clean);
  const companyId = getActiveCompanyId();
  const existing = await one<{
    id: string;
    name: string;
    is_customer: number;
    is_vendor: number;
  }>(
    `SELECT id, name, is_customer, is_vendor FROM forms_partners
     WHERE name_key = $1 AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`,
    [key, companyId],
  );

  if (existing) {
    const isCustomer = role === 'customer' ? 1 : Number(existing.is_customer);
    const isVendor = role === 'vendor' ? 1 : Number(existing.is_vendor);
    await run(
      `UPDATE forms_partners
       SET name = $2, is_customer = $3, is_vendor = $4, updated_at = NOW()
       WHERE id = $1`,
      [existing.id, clean, isCustomer, isVendor],
    );
    return {
      id: existing.id,
      name: clean,
      is_customer: isCustomer === 1,
      is_vendor: isVendor === 1,
    };
  }

  const id = randomUUID();
  await run(
    `INSERT INTO forms_partners(id, name, name_key, is_customer, is_vendor, company_odoo_id, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [id, clean, key, role === 'customer' ? 1 : 0, role === 'vendor' ? 1 : 0, companyId],
  );
  return {
    id,
    name: clean,
    is_customer: role === 'customer',
    is_vendor: role === 'vendor',
  };
}

export async function ensureProductByName(
  name: string,
  hints: Partial<CatalogProduct> = {},
): Promise<CatalogProduct | null> {
  const clean = name.trim();
  if (!clean) return null;
  const key = nameKey(clean);
  const companyId = getActiveCompanyId();
  const existing = await one<{ id: string; header_json: string }>(
    `SELECT id, header_json FROM forms_documents
     WHERE kind = 'product'
       AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
       AND lower(trim(both FROM COALESCE(header_json::json->>'name', ''))) = $2
     LIMIT 1`,
    [companyId, key],
  );
  if (existing) {
    const header = parseHeader(existing.header_json);
    return {
      id: existing.id,
      name: header.name || clean,
      category: header.category || '',
      sales_price: header.sales_price || '',
      cost: header.cost || '',
      uom: header.uom || '',
      internal_ref: header.internal_ref || '',
      qty_on_hand: header.qty_on_hand || '',
    };
  }

  const id = randomUUID();
  const header = emptyHeader('product');
  header.name = clean;
  header.company_odoo_id = companyId;
  if (hints.category) header.category = hints.category;
  if (hints.sales_price) header.sales_price = hints.sales_price;
  if (hints.cost) header.cost = hints.cost;
  if (hints.uom) header.uom = hints.uom;
  if (hints.internal_ref) header.internal_ref = hints.internal_ref;
  const now = new Date().toISOString();
  await run(
    `INSERT INTO forms_documents(id, kind, title, status, header_json, company_odoo_id, created_at, updated_at)
     VALUES($1, 'product', $2, 'draft', $3, $4, $5, $5)`,
    [id, clean, JSON.stringify(header), companyId, now],
  );
  return {
    id,
    name: clean,
    category: header.category || '',
    sales_price: header.sales_price || '',
    cost: header.cost || '',
    uom: header.uom || '',
    internal_ref: header.internal_ref || '',
    qty_on_hand: header.qty_on_hand || '',
  };
}

/** Propaga vínculos compartilhados após salvar um documento. */
export async function syncSharedCatalog(doc: FormDocument): Promise<void> {
  if (doc.kind === 'sale') {
    await upsertPartner(doc.header.customer || '', 'customer');
    for (const line of doc.lines) {
      const productName = line.values.product || '';
      if (!productName.trim()) continue;
      await ensureProductByName(productName, {
        sales_price: line.values.unit_price || '',
      });
    }
    return;
  }

  if (doc.kind === 'purchase') {
    await upsertPartner(doc.header.vendor || '', 'vendor');
    for (const line of doc.lines) {
      const productName = line.values.product || '';
      if (!productName.trim()) continue;
      await ensureProductByName(productName, {
        cost: line.values.unit_price || '',
      });
    }
    return;
  }

  if (doc.kind === 'product') {
    // Produto no inventário já é a fonte do catálogo (listCatalogProducts).
    // Se veio de linha de venda/compra com mesmo nome, só o registro de inventário importa.
  }
}
