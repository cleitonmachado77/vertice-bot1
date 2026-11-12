import { one, run } from './db.js';
import { ensureProductByName, upsertPartner } from './forms-catalog.js';
import { getFormDocument } from './forms.js';
import { odooCreate, odooSearchRead } from './odoo-client.js';
import { pushProductToOdoo } from './odoo-sync.js';
import { parseMoney } from './agro-rules.js';
import { resolveBuyer, resolveProduct } from './agro-resolve.js';
import { assertOdooReady } from './agro-odoo-place.js';

function many2oneId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number' && value > 0) return value;
  return 0;
}

async function variantOfTemplate(templateId: number): Promise<number> {
  const [template] = await odooSearchRead<{ product_variant_id: unknown }>(
    'product.template',
    [['id', '=', templateId]],
    ['product_variant_id'],
    { limit: 1 },
  );
  const variantId = many2oneId(template?.product_variant_id);
  if (!variantId) throw new Error('Produto sem variante no Odoo');
  return variantId;
}

/** Garante o produto no inventário local e no Odoo. Não regrava produto que já tem id. */
export async function syncAgroProduct(
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string; unit: string; variantId: number }> {
  assertOdooReady();
  let resolved = await resolveProduct(companyId, input);
  if (!resolved.id) {
    const created = await ensureProductByName(resolved.name, { uom: resolved.unit }, companyId);
    if (!created) throw new Error('Não foi possível cadastrar o produto');
    resolved = { id: created.id, name: created.name, unit: created.uom || resolved.unit };
  }
  const doc = await getFormDocument(resolved.id);
  if (!doc || doc.kind !== 'product') throw new Error('Produto não encontrado no inventário desta empresa');
  const ready = Number(doc.header.odoo_id || 0) > 0 ? doc : await pushProductToOdoo(doc);
  const templateId = Number(ready.header.odoo_id || 0);
  if (!templateId) throw new Error('Produto sem cadastro no Odoo');
  return {
    id: ready.id,
    name: ready.header.name?.trim() || resolved.name,
    unit: ready.header.uom?.trim() || resolved.unit,
    variantId: await variantOfTemplate(templateId),
  };
}

async function ensurePartnerOdooId(partnerId: string, companyId: string): Promise<number> {
  const row = await one<{ name: string; odoo_id: string }>(
    `SELECT name, COALESCE(odoo_id, '') AS odoo_id FROM forms_partners WHERE id = $1`,
    [partnerId],
  );
  if (!row) throw new Error('Comprador não encontrado');
  const existing = Number(row.odoo_id || 0);
  if (existing > 0) return existing;
  const company = Number(companyId) || 0;
  const found = await odooSearchRead<{ id: number }>(
    'res.partner',
    ['&', ['name', '=', row.name.trim()], '|', ['company_id', '=', company], ['company_id', '=', false]],
    ['id'],
    { limit: 1 },
  );
  const odooId =
    found[0]?.id ||
    (await odooCreate(
      'res.partner',
      { name: row.name.trim(), customer_rank: 1, company_id: company || false },
      { context: { allowed_company_ids: company ? [company] : [], force_company: company || false } },
    ));
  await run(`UPDATE forms_partners SET odoo_id = $2, updated_at = NOW() WHERE id = $1`, [
    partnerId,
    String(odooId),
  ]);
  return odooId;
}

/** Comprador do cadastro ou nome novo, sempre com res.partner no Odoo. */
export async function syncAgroBuyer(
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; name: string; odooId: number }> {
  assertOdooReady();
  let buyer = await resolveBuyer(companyId, input);
  if (!buyer.id) {
    const created = await upsertPartner(buyer.name, 'customer', companyId);
    if (!created) throw new Error('Informe o comprador');
    buyer = { id: created.id, name: created.name };
  }
  const odooId = await ensurePartnerOdooId(buyer.id, companyId);
  return { id: buyer.id, name: buyer.name, odooId };
}

export async function productListPrice(productId: string): Promise<number | null> {
  if (!productId) return null;
  const row = await one<{ header_json: string }>(
    `SELECT header_json FROM forms_documents WHERE id = $1 AND kind = 'product'`,
    [productId],
  );
  if (!row) return null;
  try {
    const header = JSON.parse(row.header_json || '{}') as Record<string, unknown>;
    return parseMoney(header.sales_price ?? '');
  } catch {
    return null;
  }
}
