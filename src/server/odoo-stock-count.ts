import { run } from './db.js';
import type { FormDocument } from './forms.js';
import { odooCreate, odooExecuteKw, odooSearchRead, odooWrite } from './odoo-client.js';

function many2oneId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number' && value > 0) return value;
  return 0;
}

/**
 * Soma a quantidade contada no estoque interno do produto.
 * A separação de bags entra como unidades, sem converter para peso.
 * Cada ciclo soma uma vez.
 */
export async function addBotStockCount(doc: FormDocument, templateId: number): Promise<void> {
  if (doc.header.source !== 'bot' || doc.header.stock_applied) return;
  const add = Number(String(doc.header.qty_on_hand || '').replace(',', '.'));
  if (!Number.isFinite(add) || add <= 0 || templateId <= 0) return;

  const companyId = Number(doc.company_odoo_id || doc.header.company_odoo_id || 0);
  if (!companyId) throw new Error('Produto sem empresa para lançar o estoque');

  const [template] = await odooSearchRead<{ product_variant_id: unknown }>(
    'product.template',
    [['id', '=', templateId]],
    ['product_variant_id'],
    { limit: 1 },
  );
  const variantId = many2oneId(template?.product_variant_id);
  if (!variantId) throw new Error('Produto sem variante para lançar o estoque');

  const [warehouse] = await odooSearchRead<{ lot_stock_id: unknown }>(
    'stock.warehouse',
    [['company_id', '=', companyId]],
    ['lot_stock_id'],
    { limit: 1 },
  );
  const locationId = many2oneId(warehouse?.lot_stock_id);
  if (!locationId) throw new Error(`Empresa Odoo ${companyId} sem depósito interno`);

  const context = { inventory_mode: true, allowed_company_ids: [companyId] };
  const [quant] = await odooSearchRead<{ id: number; quantity: number }>(
    'stock.quant',
    [
      ['product_id', '=', variantId],
      ['location_id', '=', locationId],
    ],
    ['id', 'quantity'],
    { limit: 1 },
  );
  const balance = Math.round(((Number(quant?.quantity) || 0) + add) * 1000) / 1000;
  const quantId = quant?.id
    ? quant.id
    : await odooCreate(
        'stock.quant',
        { product_id: variantId, location_id: locationId, inventory_quantity: balance },
        { context },
      );
  if (quant?.id) {
    await odooWrite('stock.quant', [quant.id], { inventory_quantity: balance });
  }
  await odooExecuteKw('stock.quant', 'action_apply_inventory', [[quantId]], { context });

  const header = {
    ...doc.header,
    qty_on_hand: String(balance),
    stock_applied: doc.header.source_cycle_id || '1',
  };
  await run(`UPDATE forms_documents SET header_json = $2 WHERE id = $1`, [doc.id, JSON.stringify(header)]);
}
