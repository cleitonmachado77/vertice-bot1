import { randomUUID } from 'node:crypto';
import { getSetting, one, run, setSetting, withTransaction } from './db.js';
import {
  DEFAULT_COMPANY_ODOO_ID,
  resolveCompanyOdooId,
  resolvePartnerCompanyOdooId,
  syncCompaniesFromOdoo,
} from './forms-companies.js';
import { documentTitle, emptyHeader, emptyLine } from './forms-fields.js';
import { odooConfigured, odooSearchRead } from './odoo-client.js';
import { pullOdooRefs } from './forms-odoo-refs.js';
import { odooLabelPt } from './odoo-pt.js';
import { joinNames, m2mIds, namesByIds } from './odoo-resolve.js';

const AUTO_PULL_MIN_MS = 2 * 60 * 1000;
/** Overlap para não perder edições na borda do cursor write_date. */
const INCREMENTAL_OVERLAP_MS = 3 * 60 * 1000;
/** Cadastros auxiliares (UOM, impostos…) mudam pouco — no incremental, no máximo a cada 6h. */
const REFS_PULL_MIN_MS = 6 * 60 * 60 * 1000;

export type OdooPullMode = 'full' | 'incremental';

export type OdooPullResult = {
  skipped?: boolean;
  mode?: OdooPullMode;
  companies: number;
  products: number;
  partners: number;
  sales: number;
  purchases: number;
  stockUpdated: number;
  at: string;
};

/** Converte ISO/ms para datetime UTC aceito pelo domain Odoo. */
function toOdooDateTime(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Combina domain base com filtro write_date >= since (com overlap).
 * `sinceIso` null/undefined → sem filtro (full).
 */
function withSince(baseDomain: unknown[], sinceIso: string | null | undefined): unknown[] {
  if (!sinceIso) return baseDomain;
  const sinceMs = Date.parse(sinceIso) - INCREMENTAL_OVERLAP_MS;
  if (!Number.isFinite(sinceMs)) return baseDomain;
  const odooDt = toOdooDateTime(sinceMs);
  if (!odooDt) return baseDomain;
  const leaf: unknown[] = ['write_date', '>=', odooDt];
  if (!baseDomain.length) return [leaf];
  // Domain polish: AND do bloco atual com write_date
  if (baseDomain[0] === '&' || baseDomain[0] === '|' || baseDomain[0] === '!') {
    return ['&', baseDomain, leaf];
  }
  if (baseDomain.length === 1 && Array.isArray(baseDomain[0])) {
    return ['&', baseDomain[0], leaf];
  }
  // Vários leaves implícitos (AND) → agrupa e adiciona write_date
  const grouped = baseDomain.reduce<unknown>((acc, item, index) => {
    if (index === 0) return item;
    return ['&', acc, item];
  }, null);
  return ['&', grouped, leaf];
}

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

function m2oName(value: unknown): string {
  return Array.isArray(value) ? String(value[1] || '') : '';
}

function m2oId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return 0;
}

function asDate(value: unknown): string {
  if (!value || value === false) return '';
  return String(value).slice(0, 10);
}

function orderStatus(state: string): string {
  const raw = String(state || 'draft').trim().toLowerCase();
  return raw || 'draft';
}

async function upsertPartnerRow(input: {
  name: string;
  isCustomer: boolean;
  isVendor: boolean;
  odooId: number;
  companyOdooId: string;
  /** Quando true, grava e-mail/telefone/endereço (pull de parceiros). */
  withDetails?: boolean;
  email?: string;
  phone?: string;
  vat?: string;
  street?: string;
  city?: string;
  isCompany?: boolean;
}): Promise<void> {
  const clean = input.name.trim();
  if (!clean) return;
  const key = nameKey(clean);
  const companyId = input.companyOdooId || DEFAULT_COMPANY_ODOO_ID;
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const vat = String(input.vat || '').trim();
  const street = String(input.street || '').trim();
  const city = String(input.city || '').trim();
  const isCompany = input.isCompany ? 1 : 0;
  // Preferir odoo_id global (reclassifica company_id false → compartilhado).
  const existing =
    (input.odooId > 0
      ? await one<{ id: string }>(
          `SELECT id FROM forms_partners WHERE odoo_id = $1 AND odoo_id <> '' LIMIT 1`,
          [String(input.odooId)],
        )
      : undefined) ||
    (await one<{ id: string }>(
      `SELECT id FROM forms_partners
       WHERE company_odoo_id = $1 AND name_key = $2
       LIMIT 1`,
      [companyId, key],
    ));
  if (existing) {
    if (input.withDetails) {
      // Pull completo: espelha ranks do Odoo (não GREATEST — senão nunca remove fornecedor).
      await run(
        `UPDATE forms_partners
         SET name = $2, name_key = $3, is_customer = $4, is_vendor = $5,
             odoo_id = $6, company_odoo_id = $7,
             email = $8, phone = $9, vat = $10, street = $11, city = $12, is_company = $13,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.id,
          clean,
          key,
          input.isCustomer ? 1 : 0,
          input.isVendor ? 1 : 0,
          String(input.odooId),
          companyId,
          email,
          phone,
          vat,
          street,
          city,
          isCompany,
        ],
      );
    } else {
      await run(
        `UPDATE forms_partners
         SET name = $2, name_key = $3, is_customer = GREATEST(is_customer, $4),
             is_vendor = GREATEST(is_vendor, $5), odoo_id = $6, company_odoo_id = $7, updated_at = NOW()
         WHERE id = $1`,
        [
          existing.id,
          clean,
          key,
          input.isCustomer ? 1 : 0,
          input.isVendor ? 1 : 0,
          String(input.odooId),
          companyId,
        ],
      );
    }
    return;
  }
  await run(
    `INSERT INTO forms_partners(
       id, name, name_key, is_customer, is_vendor, odoo_id, company_odoo_id,
       email, phone, vat, street, city, is_company, created_at, updated_at
     ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())`,
    [
      randomUUID(),
      clean,
      key,
      input.isCustomer ? 1 : 0,
      input.isVendor ? 1 : 0,
      String(input.odooId),
      companyId,
      email,
      phone,
      vat,
      street,
      city,
      isCompany,
    ],
  );
}

async function upsertDoc(input: {
  kind: 'product' | 'sale' | 'purchase';
  companyId: string;
  odooId: string;
  title: string;
  status: string;
  header: Record<string, string>;
  lines?: Array<Record<string, string>>;
  matchName?: string;
}): Promise<'created' | 'updated'> {
  const existing = await one<{ id: string; header_json: string }>(
    input.kind === 'product' && input.matchName
      ? `SELECT id, header_json FROM forms_documents
         WHERE kind = $1 AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2
           AND (header_json::json->>'odoo_id' = $3
             OR lower(trim(both FROM COALESCE(header_json::json->>'name', ''))) = $4)
         LIMIT 1`
      : `SELECT id, header_json FROM forms_documents
         WHERE kind = $1 AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2
           AND header_json::json->>'odoo_id' = $3
         LIMIT 1`,
    input.kind === 'product' && input.matchName
      ? [input.kind, input.companyId, input.odooId, nameKey(input.matchName)]
      : [input.kind, input.companyId, input.odooId],
  );

  const prev = existing ? parseHeader(existing.header_json) : {};
  const header = { ...prev, ...input.header, odoo_id: input.odooId, company_odoo_id: input.companyId };
  // Sempre Número · Parceiro (evita título só com fornecedor após o pull).
  const title = documentTitle(input.kind, header) || input.title || 'Registro';

  if (existing) {
    await withTransaction(async () => {
      // Não mexe em updated_at no pull — a lista continua com os últimos salvos no topo.
      await run(
        `UPDATE forms_documents
         SET title = $2, status = $3, header_json = $4, company_odoo_id = $5
         WHERE id = $1`,
        [existing.id, title, input.status, JSON.stringify(header), input.companyId],
      );
      if (input.lines) {
        await run(`DELETE FROM forms_document_lines WHERE document_id = $1`, [existing.id]);
        let order = 0;
        for (const values of input.lines) {
          await run(
            `INSERT INTO forms_document_lines(id, document_id, sort_order, line_json, created_at, updated_at)
             VALUES($1, $2, $3, $4, NOW(), NOW())`,
            [randomUUID(), existing.id, order, JSON.stringify(values)],
          );
          order += 1;
        }
      }
    });
    return 'updated';
  }

  const id = randomUUID();
  await withTransaction(async () => {
    await run(
      `INSERT INTO forms_documents(id, kind, title, status, header_json, company_odoo_id, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [id, input.kind, title, input.status, JSON.stringify(header), input.companyId],
    );
    if (input.lines?.length) {
      let order = 0;
      for (const values of input.lines) {
        await run(
          `INSERT INTO forms_document_lines(id, document_id, sort_order, line_json, created_at, updated_at)
           VALUES($1, $2, $3, $4, NOW(), NOW())`,
          [randomUUID(), id, order, JSON.stringify(values)],
        );
        order += 1;
      }
    } else if (input.kind !== 'product') {
      await run(
        `INSERT INTO forms_document_lines(id, document_id, sort_order, line_json, created_at, updated_at)
         VALUES($1, $2, 0, $3, NOW(), NOW())`,
        [randomUUID(), id, JSON.stringify(emptyLine(input.kind))],
      );
    }
  });
  return 'created';
}

async function pullStockQtyByTemplate(sinceIso?: string | null): Promise<Map<string, number>> {
  const baseDomain: unknown[] = [
    '&',
    ['quantity', '!=', 0],
    ['location_id.usage', '=', 'internal'],
  ];

  // Incremental: só quants alterados → depois recalcula o total desses produtos
  // (somar só o delta subcontaria o estoque).
  let quants = await odooSearchRead<{
    product_id: unknown;
    quantity: number;
    company_id: unknown;
  }>('stock.quant', withSince(baseDomain, sinceIso), ['product_id', 'quantity', 'company_id'], {
    limit: 5000,
  }).catch(() => []);

  if (!quants.length) return new Map();

  if (sinceIso) {
    const touchedVariantIds = [
      ...new Set(quants.map((row) => m2oId(row.product_id)).filter((id) => id > 0)),
    ];
    if (!touchedVariantIds.length) return new Map();
    quants = await odooSearchRead<{
      product_id: unknown;
      quantity: number;
      company_id: unknown;
    }>(
      'stock.quant',
      [
        '&',
        '&',
        ['quantity', '!=', 0],
        ['location_id.usage', '=', 'internal'],
        ['product_id', 'in', touchedVariantIds],
      ],
      ['product_id', 'quantity', 'company_id'],
      { limit: 5000 },
    ).catch(() => []);
    if (!quants.length) return new Map();
  }

  const variantIds = [
    ...new Set(quants.map((row) => m2oId(row.product_id)).filter((id) => id > 0)),
  ];
  const variants = variantIds.length
    ? await odooSearchRead<{ id: number; product_tmpl_id: unknown }>(
        'product.product',
        [['id', 'in', variantIds]],
        ['id', 'product_tmpl_id'],
        { limit: 5000 },
      )
    : [];
  const variantToTmpl = new Map(variants.map((row) => [row.id, m2oId(row.product_tmpl_id)]));
  const qty = new Map<string, number>();
  for (const row of quants) {
    const variantId = m2oId(row.product_id);
    const tmplId = variantToTmpl.get(variantId);
    if (!tmplId) continue;
    const companyId = resolveCompanyOdooId(row.company_id);
    const key = `${companyId}:${tmplId}`;
    qty.set(key, (qty.get(key) || 0) + Number(row.quantity || 0));
  }
  return qty;
}

async function pullProducts(
  stockMap: Map<string, number>,
  sinceIso?: string | null,
): Promise<{ products: number; stockUpdated: number }> {
  const rows = await odooSearchRead<{
    id: number;
    name: string;
    list_price: number;
    standard_price: number;
    default_code: string;
    categ_id: unknown;
    uom_id: unknown;
    company_id: unknown;
    is_storable?: boolean;
    type?: string;
  }>(
    'product.template',
    withSince([], sinceIso),
    [
      'name',
      'list_price',
      'standard_price',
      'default_code',
      'categ_id',
      'uom_id',
      'company_id',
      'is_storable',
      'type',
    ],
    { limit: 5000, order: 'name asc' },
  );

  let products = 0;
  let stockUpdated = 0;
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const companyId = resolveCompanyOdooId(row.company_id);
    const stockKey = `${companyId}:${row.id}`;
    const qty = stockMap.get(stockKey);
    const header = emptyHeader('product');
    header.name = name;
    header.sales_price = String(row.list_price ?? '');
    header.cost = String(row.standard_price ?? '');
    header.internal_ref = String(row.default_code || '');
    header.category = odooLabelPt(m2oName(row.categ_id));
    header.uom = odooLabelPt(m2oName(row.uom_id));
    header.track_inventory = row.is_storable || row.type === 'product' ? 'True' : 'False';
    header.odoo_id = String(row.id);
    header.odoo_synced_at = new Date().toISOString();
    header.company_odoo_id = companyId;
    if (qty != null) {
      header.qty_on_hand = String(qty);
      stockUpdated += 1;
    }
    await upsertDoc({
      kind: 'product',
      companyId,
      odooId: String(row.id),
      title: name,
      status: 'draft',
      header,
      matchName: name,
    });
    products += 1;
    if (products === 1 || products % 10 === 0 || products === rows.length) {
      touchPullStep(`produtos ${products}/${rows.length}`);
    }
  }
  return { products, stockUpdated };
}

async function pullPartners(sinceIso?: string | null): Promise<number> {
  const rows = await odooSearchRead<{
    id: number;
    name: string;
    customer_rank: number;
    supplier_rank: number;
    is_company: boolean;
    company_id: unknown;
    email: string | false;
    phone: string | false;
    vat: string | false;
    street: string | false;
    city: string | false;
  }>(
    'res.partner',
    withSince([['active', '=', true]], sinceIso),
    [
      'name',
      'customer_rank',
      'supplier_rank',
      'is_company',
      'company_id',
      'email',
      'phone',
      'vat',
      'street',
      'city',
    ],
    { limit: 5000, order: 'name asc' },
  );

  let partners = 0;
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    let isCustomer = Number(row.customer_rank || 0) > 0;
    let isVendor = Number(row.supplier_rank || 0) > 0;
    // Empresa sem rank: só cliente (não poluir lista de fornecedores).
    if (!isCustomer && !isVendor) {
      if (row.is_company) {
        isCustomer = true;
      } else {
        // Pessoa sem rank: se já existir no Vertice, zera cliente/fornecedor.
        if (row.id > 0) {
          await run(
            `UPDATE forms_partners
             SET is_customer = 0, is_vendor = 0,
                 company_odoo_id = $2, updated_at = NOW()
             WHERE odoo_id = $1`,
            [String(row.id), resolvePartnerCompanyOdooId(row.company_id)],
          );
        }
        continue;
      }
    }
    await upsertPartnerRow({
      name,
      isCustomer,
      isVendor,
      odooId: row.id,
      companyOdooId: resolvePartnerCompanyOdooId(row.company_id),
      withDetails: true,
      email: row.email ? String(row.email) : '',
      phone: row.phone ? String(row.phone) : '',
      vat: row.vat ? String(row.vat) : '',
      street: row.street ? String(row.street) : '',
      city: row.city ? String(row.city) : '',
      isCompany: Boolean(row.is_company),
    });
    partners += 1;
  }
  return partners;
}

type SaleOrderRow = {
  id: number;
  name: string;
  partner_id: unknown;
  date_order: string;
  validity_date: string | false;
  client_order_ref: string | false;
  payment_term_id?: unknown;
  team_id?: unknown;
  tag_ids?: number[];
  state: string;
  company_id: unknown;
  order_line: number[];
};

type SaleLineRow = {
  id: number;
  order_id: unknown;
  product_id: unknown;
  name: string;
  product_uom_qty: number;
  price_unit: number;
  tax_ids?: number[];
};

async function pullSales(sinceIso?: string | null): Promise<number> {
  const saleOrderFieldsFull = [
    'name',
    'partner_id',
    'date_order',
    'validity_date',
    'client_order_ref',
    'payment_term_id',
    'team_id',
    'tag_ids',
    'state',
    'company_id',
    'order_line',
  ];
  const saleOrderFieldsCore = [
    'name',
    'partner_id',
    'date_order',
    'validity_date',
    'client_order_ref',
    'payment_term_id',
    'team_id',
    'state',
    'company_id',
    'order_line',
  ];
  const orderDomain = withSince([], sinceIso);
  const orders =
    (await odooSearchRead<SaleOrderRow>('sale.order', orderDomain, saleOrderFieldsFull, {
      limit: 2000,
      order: 'id desc',
    }).catch(() => null)) ||
    (await odooSearchRead<SaleOrderRow>('sale.order', orderDomain, saleOrderFieldsCore, {
      limit: 2000,
      order: 'id desc',
    }));

  const lineIds = [...new Set(orders.flatMap((order) => order.order_line || []))];
  const lineRows: SaleLineRow[] = lineIds.length
    ? (await odooSearchRead<SaleLineRow>(
        'sale.order.line',
        [['id', 'in', lineIds]],
        ['order_id', 'product_id', 'name', 'product_uom_qty', 'price_unit', 'tax_ids'],
        { limit: 10000 },
      ).catch(() =>
        odooSearchRead<SaleLineRow>(
          'sale.order.line',
          [['id', 'in', lineIds]],
          ['order_id', 'product_id', 'name', 'product_uom_qty', 'price_unit'],
          { limit: 10000 },
        ),
      ))
    : [];
  const linesByOrder = new Map<number, typeof lineRows>();
  for (const line of lineRows) {
    const orderId = m2oId(line.order_id);
    const list = linesByOrder.get(orderId) || [];
    list.push(line);
    linesByOrder.set(orderId, list);
  }

  const tagIds = [...new Set(orders.flatMap((order) => m2mIds(order.tag_ids)))];
  const taxIds = [...new Set(lineRows.flatMap((line) => m2mIds(line.tax_ids)))];
  const tagNames = await namesByIds('crm.tag', tagIds).catch(() => new Map<number, string>());
  const taxNames = await namesByIds('account.tax', taxIds).catch(() => new Map<number, string>());

  let sales = 0;
  for (const order of orders) {
    if (order.state === 'cancel') continue;
    const companyId = resolveCompanyOdooId(order.company_id);
    const header = emptyHeader('sale');
    header.order_reference = String(order.name || '');
    header.customer = m2oName(order.partner_id);
    header.order_date = asDate(order.date_order);
    header.expiration = asDate(order.validity_date);
    header.payment_terms = m2oName(order.payment_term_id);
    header.sales_team = m2oName(order.team_id);
    header.customer_reference = order.client_order_ref ? String(order.client_order_ref) : '';
    header.tags = joinNames(m2mIds(order.tag_ids), tagNames);
    header.odoo_id = String(order.id);
    header.odoo_synced_at = new Date().toISOString();
    header.company_odoo_id = companyId;
    header.odoo_state = String(order.state || '');

    const lines = (linesByOrder.get(order.id) || []).map((line) => {
      const values = emptyLine('sale');
      values.product = m2oName(line.product_id) || String(line.name || '');
      values.quantity = String(line.product_uom_qty ?? '');
      values.unit_price = String(line.price_unit ?? '');
      values.taxes = joinNames(m2mIds(line.tax_ids), taxNames);
      return values;
    });

    await upsertDoc({
      kind: 'sale',
      companyId,
      odooId: String(order.id),
      title: documentTitle('sale', header),
      status: orderStatus(order.state),
      header,
      lines,
    });
    if (header.customer) {
      await upsertPartnerRow({
        name: header.customer,
        isCustomer: true,
        isVendor: false,
        odooId: m2oId(order.partner_id),
        companyOdooId: companyId,
      });
    }
    sales += 1;
  }
  return sales;
}

type PurchaseOrderRow = {
  id: number;
  name: string;
  partner_id: unknown;
  date_order: string;
  date_planned: string | false;
  partner_ref: string | false;
  payment_term_id?: unknown;
  state: string;
  company_id: unknown;
  order_line: number[];
};

type PurchaseLineRow = {
  id: number;
  order_id: unknown;
  product_id: unknown;
  name: string;
  product_qty: number;
  price_unit: number;
  taxes_id?: number[];
  tax_ids?: number[];
};

async function pullPurchases(sinceIso?: string | null): Promise<number> {
  const orders = await odooSearchRead<PurchaseOrderRow>(
    'purchase.order',
    withSince([], sinceIso),
    [
      'name',
      'partner_id',
      'date_order',
      'date_planned',
      'partner_ref',
      'payment_term_id',
      'state',
      'company_id',
      'order_line',
    ],
    { limit: 2000, order: 'id desc' },
  );

  const lineIds = [...new Set(orders.flatMap((order) => order.order_line || []))];
  const lineRows: PurchaseLineRow[] = lineIds.length
    ? (await odooSearchRead<PurchaseLineRow>(
        'purchase.order.line',
        [['id', 'in', lineIds]],
        ['order_id', 'product_id', 'name', 'product_qty', 'price_unit', 'taxes_id'],
        { limit: 10000 },
      ).catch(() =>
        odooSearchRead<PurchaseLineRow>(
          'purchase.order.line',
          [['id', 'in', lineIds]],
          ['order_id', 'product_id', 'name', 'product_qty', 'price_unit', 'tax_ids'],
          { limit: 10000 },
        ).catch(() =>
          odooSearchRead<PurchaseLineRow>(
            'purchase.order.line',
            [['id', 'in', lineIds]],
            ['order_id', 'product_id', 'name', 'product_qty', 'price_unit'],
            { limit: 10000 },
          ),
        ),
      ))
    : [];
  const linesByOrder = new Map<number, typeof lineRows>();
  for (const line of lineRows) {
    const orderId = m2oId(line.order_id);
    const list = linesByOrder.get(orderId) || [];
    list.push(line);
    linesByOrder.set(orderId, list);
  }

  const taxIds = [
    ...new Set(lineRows.flatMap((line) => m2mIds(line.taxes_id || line.tax_ids))),
  ];
  const taxNames = await namesByIds('account.tax', taxIds).catch(() => new Map<number, string>());

  let purchases = 0;
  for (const order of orders) {
    if (order.state === 'cancel') continue;
    const companyId = resolveCompanyOdooId(order.company_id);
    const header = emptyHeader('purchase');
    header.order_reference = String(order.name || '');
    header.vendor = m2oName(order.partner_id);
    header.order_deadline = asDate(order.date_order);
    header.expected_arrival = asDate(order.date_planned);
    header.vendor_reference = order.partner_ref ? String(order.partner_ref) : '';
    header.payment_terms = m2oName(order.payment_term_id);
    header.odoo_id = String(order.id);
    header.odoo_synced_at = new Date().toISOString();
    header.company_odoo_id = companyId;
    header.odoo_state = String(order.state || '');

    const lines = (linesByOrder.get(order.id) || []).map((line) => {
      const values = emptyLine('purchase');
      values.product = m2oName(line.product_id) || String(line.name || '');
      values.quantity = String(line.product_qty ?? '');
      values.unit_price = String(line.price_unit ?? '');
      values.taxes = joinNames(m2mIds(line.taxes_id || line.tax_ids), taxNames);
      return values;
    });

    await upsertDoc({
      kind: 'purchase',
      companyId,
      odooId: String(order.id),
      title: documentTitle('purchase', header),
      status: orderStatus(order.state),
      header,
      lines,
    });
    if (header.vendor) {
      await upsertPartnerRow({
        name: header.vendor,
        isCustomer: false,
        isVendor: true,
        odooId: m2oId(order.partner_id),
        companyOdooId: companyId,
      });
    }
    purchases += 1;
  }
  return purchases;
}

function emptyPull(at = new Date().toISOString()): OdooPullResult {
  return {
    companies: 0,
    products: 0,
    partners: 0,
    sales: 0,
    purchases: 0,
    stockUpdated: 0,
    at,
  };
}

/**
 * No incremental, estoque pode mudar sem touch em product.template.
 * Atualiza qty_on_hand dos produtos locais já conhecidos.
 */
async function applyStockQtyToExistingDocs(stockMap: Map<string, number>): Promise<number> {
  if (!stockMap.size) return 0;
  let updated = 0;
  for (const [key, qty] of stockMap) {
    const sep = key.indexOf(':');
    if (sep <= 0) continue;
    const companyId = key.slice(0, sep);
    const odooId = key.slice(sep + 1);
    if (!odooId) continue;
    const row = await one<{ id: string; header_json: string }>(
      `SELECT id, header_json FROM forms_documents
       WHERE kind = 'product'
         AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
         AND header_json::jsonb->>'odoo_id' = $2
       LIMIT 1`,
      [companyId || DEFAULT_COMPANY_ODOO_ID, odooId],
    ).catch(() =>
      one<{ id: string; header_json: string }>(
        `SELECT id, header_json FROM forms_documents
         WHERE kind = 'product'
           AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
           AND header_json LIKE $2
         LIMIT 1`,
        [companyId || DEFAULT_COMPANY_ODOO_ID, `%"odoo_id":"${odooId}"%`],
      ),
    );
    if (!row) continue;
    const header = parseHeader(row.header_json);
    if (String(header.qty_on_hand || '') === String(qty)) continue;
    header.qty_on_hand = String(qty);
    await run(`UPDATE forms_documents SET header_json = $2 WHERE id = $1`, [
      row.id,
      JSON.stringify(header),
    ]);
    updated += 1;
  }
  return updated;
}

export type OdooPullProgress = {
  running: boolean;
  step: string;
  startedAt: string;
  elapsedSec: number;
  lines: string[];
  error: string;
  result: OdooPullResult | null;
};

const MAX_PROGRESS_LINES = 24;
let pullLock: Promise<OdooPullResult> | null = null;
let pullProgress: OdooPullProgress = {
  running: false,
  step: '',
  startedAt: '',
  elapsedSec: 0,
  lines: [],
  error: '',
  result: null,
};

function pushProgress(step: string, started: number): void {
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  const line = `${step} (+${elapsedSec}s)`;
  console.log(`odoo-pull: ${line}`);
  pullProgress = {
    ...pullProgress,
    running: true,
    step,
    elapsedSec,
    lines: [...pullProgress.lines, line].slice(-MAX_PROGRESS_LINES),
  };
}

/** Atualiza só o passo atual (sem encher o log) — útil no loop de produtos. */
function touchPullStep(step: string): void {
  if (!pullProgress.running || !pullProgress.startedAt) return;
  const started = Date.parse(pullProgress.startedAt) || Date.now();
  pullProgress = {
    ...pullProgress,
    step,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
}

export function getOdooPullProgress(): OdooPullProgress {
  if (pullProgress.running && pullProgress.startedAt) {
    const startedMs = Date.parse(pullProgress.startedAt);
    if (startedMs) {
      return {
        ...pullProgress,
        elapsedSec: Math.round((Date.now() - startedMs) / 1000),
      };
    }
  }
  return pullProgress;
}

/**
 * Pull Odoo → Vertice.
 * - Manual / mode full: baixa tudo.
 * - auto + já houve pull: incremental por write_date (só alterados).
 * - auto sem cursor: full uma vez para popular o Vertice.
 */
export async function pullFromOdoo(
  options: { auto?: boolean; mode?: OdooPullMode } = {},
): Promise<OdooPullResult> {
  if (!odooConfigured()) {
    throw new Error('Configure URL, banco, login e API Key do Odoo');
  }

  const lastPullAt = getSetting('odoo_last_pull_at');
  const mode: OdooPullMode =
    options.mode ||
    (options.auto && lastPullAt ? 'incremental' : 'full');
  const sinceIso = mode === 'incremental' ? lastPullAt : null;

  if (options.auto) {
    const lastMs = lastPullAt ? Date.parse(lastPullAt) : 0;
    if (lastMs && Date.now() - lastMs < AUTO_PULL_MIN_MS) {
      return {
        ...emptyPull(lastPullAt || new Date().toISOString()),
        skipped: true,
        mode,
        companies: Number(getSetting('odoo_last_pull_companies') || 0),
        products: Number(getSetting('odoo_last_pull_products') || 0),
        partners: Number(getSetting('odoo_last_pull_partners') || 0),
        sales: Number(getSetting('odoo_last_pull_sales') || 0),
        purchases: Number(getSetting('odoo_last_pull_purchases') || 0),
        stockUpdated: Number(getSetting('odoo_last_pull_stock') || 0),
      };
    }
  }

  if (pullLock) return pullLock;

  pullLock = (async () => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    pullProgress = {
      running: true,
      step: 'iniciando',
      startedAt,
      elapsedSec: 0,
      lines: [],
      error: '',
      result: null,
    };

    try {
      if (mode === 'incremental' && sinceIso) {
        pushProgress(`incremental desde ${sinceIso} (overlap 3min)`, started);
      } else {
        pushProgress('full', started);
      }

      pushProgress('empresas', started);
      const companies = await syncCompaniesFromOdoo();
      pushProgress(`empresas ok (${companies.length})`, started);

      // Refs: full sempre; incremental só se passou o throttle.
      let skipRefs = false;
      if (mode === 'incremental') {
        const lastRefs = getSetting('odoo_last_refs_pull_at');
        const lastRefsMs = lastRefs ? Date.parse(lastRefs) : 0;
        if (lastRefsMs && Date.now() - lastRefsMs < REFS_PULL_MIN_MS) {
          skipRefs = true;
          pushProgress('cadastros auxiliares ignorados (throttle 6h)', started);
        }
      }
      if (!skipRefs) {
        try {
          pushProgress('cadastros auxiliares', started);
          await pullOdooRefs();
          await setSetting('odoo_last_refs_pull_at', new Date().toISOString());
          pushProgress('cadastros auxiliares ok', started);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('odoo-pull: cadastros auxiliares falharam (seguindo):', message);
          pushProgress(`cadastros auxiliares falharam · ${message}`, started);
        }
      }

      pushProgress(mode === 'incremental' ? 'estoque (delta)' : 'estoque', started);
      const stockMap = await pullStockQtyByTemplate(sinceIso);
      pushProgress(`estoque ok (${stockMap.size} itens)`, started);

      pushProgress(
        mode === 'incremental' ? 'produtos (delta)' : 'produtos (pode demorar)',
        started,
      );
      const { products, stockUpdated: stockFromProducts } = await pullProducts(stockMap, sinceIso);
      let stockUpdated = stockFromProducts;
      if (mode === 'incremental' && stockMap.size) {
        const stockOnly = await applyStockQtyToExistingDocs(stockMap);
        stockUpdated += stockOnly;
      }
      pushProgress(`produtos ok (${products})`, started);

      pushProgress(mode === 'incremental' ? 'parceiros (delta)' : 'parceiros', started);
      const partners = await pullPartners(sinceIso);
      pushProgress(`parceiros ok (${partners})`, started);

      pushProgress(mode === 'incremental' ? 'vendas (delta)' : 'vendas', started);
      const sales = await pullSales(sinceIso);
      pushProgress(`vendas ok (${sales})`, started);

      pushProgress(mode === 'incremental' ? 'compras (delta)' : 'compras', started);
      const purchases = await pullPurchases(sinceIso);
      pushProgress(`compras ok (${purchases})`, started);

      const at = new Date().toISOString();
      await setSetting('odoo_last_pull_at', at);
      await setSetting('odoo_last_pull_companies', String(companies.length));
      await setSetting('odoo_last_pull_products', String(products));
      await setSetting('odoo_last_pull_partners', String(partners));
      await setSetting('odoo_last_pull_sales', String(sales));
      await setSetting('odoo_last_pull_purchases', String(purchases));
      await setSetting('odoo_last_pull_stock', String(stockUpdated));

      const result: OdooPullResult = {
        mode,
        companies: companies.length,
        products,
        partners,
        sales,
        purchases,
        stockUpdated,
        at,
      };
      pushProgress(
        `concluído (${mode}) · ${products} produtos · ${partners} parceiros · ${sales} vendas · ${purchases} compras`,
        started,
      );
      pullProgress = { ...pullProgress, running: false, result, error: '' };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha no recebimento';
      pushProgress(`erro · ${message}`, started);
      pullProgress = { ...pullProgress, running: false, error: message, result: null };
      throw error;
    } finally {
      pullLock = null;
      if (pullProgress.running) {
        pullProgress = { ...pullProgress, running: false };
      }
    }
  })();

  return pullLock;
}

/** Compat: alias usado pelas rotas antigas. */
export async function pullOdooCatalog(): Promise<OdooPullResult> {
  return pullFromOdoo({ auto: false });
}

/** Reprocessa só parceiros (full domain) — útil após mudança de company compartilhada. */
export async function pullOdooPartnersOnly(): Promise<number> {
  if (!odooConfigured()) {
    throw new Error('Configure URL, banco, login e API Key do Odoo');
  }
  return pullPartners(null);
}
