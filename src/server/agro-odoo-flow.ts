import { one, run } from './db.js';
import { getPlanting } from './agro-model.js';
import { createFormDocument, deleteFormDocument, getFormDocument, saveFormDocument } from './forms.js';
import { odooExecuteKw, odooSearchRead } from './odoo-client.js';
import { addProductStockAtLocation } from './odoo-stock-count.js';
import { pushSaleToOdoo } from './odoo-sync.js';
import { stockDelta } from './agro-rules.js';
import { syncAgroProduct } from './agro-odoo-catalog.js';
import { assertOdooReady, syncAgroPlace } from './agro-odoo-place.js';

type PlantingRef = {
  companyId: string;
  plantingId: string;
  propertyId: string;
  plotId: string;
  productId: string;
  productName: string;
  unit: string;
};

async function variantFor(planting: PlantingRef): Promise<number> {
  const product = await syncAgroProduct(
    planting.companyId,
    planting.productId
      ? { productId: planting.productId }
      : { productId: '__custom__', productName: planting.productName, unit: planting.unit },
  );
  return product.variantId;
}

export async function publishPlantingPlace(companyId: string, plantingId: string, created: boolean): Promise<void> {
  const planting = await one<{ property_id: string; plot_id: string }>(
    `SELECT property_id, COALESCE(plot_id, '') AS plot_id
     FROM agro_plantings WHERE id = $1 AND company_odoo_id = $2`,
    [plantingId, companyId],
  );
  if (!planting?.plot_id) throw new Error('Plantio sem talhão');
  try {
    await syncAgroPlace(companyId, planting.property_id, planting.plot_id);
  } catch (error) {
    if (created) await run(`DELETE FROM agro_plantings WHERE id = $1`, [plantingId]);
    throw error;
  }
}

export async function publishHarvest(
  input: PlantingRef & { harvestId: string; quantity: number; created: boolean; previousStatus: string },
): Promise<void> {
  try {
    assertOdooReady();
    const place = await syncAgroPlace(input.companyId, input.propertyId, input.plotId);
    const variantId = await variantFor(input);
    const applied = await one<{ odoo_qty: number }>(
      `SELECT COALESCE(odoo_qty, 0) AS odoo_qty FROM agro_harvests WHERE id = $1`,
      [input.harvestId],
    );
    const delta = stockDelta(Number(applied?.odoo_qty) || 0, input.quantity);
    if (delta) {
      await addProductStockAtLocation(Number(input.companyId), variantId, place.plotLocationId, delta);
    }
    try {
      await run(`UPDATE agro_harvests SET odoo_qty = $2, updated_at = NOW() WHERE id = $1`, [
        input.harvestId,
        input.quantity,
      ]);
    } catch (error) {
      if (delta) {
        await addProductStockAtLocation(Number(input.companyId), variantId, place.plotLocationId, -delta).catch(
          () => undefined,
        );
      }
      throw error;
    }
  } catch (error) {
    if (input.created) {
      await run(`DELETE FROM agro_harvests WHERE id = $1`, [input.harvestId]);
      await run(`UPDATE agro_plantings SET status = $1, updated_at = NOW() WHERE id = $2`, [
        input.previousStatus,
        input.plantingId,
      ]);
    }
    throw error;
  }
}

export async function revertHarvestStock(input: PlantingRef & { harvestId: string }): Promise<void> {
  const applied = await one<{ odoo_qty: number }>(
    `SELECT COALESCE(odoo_qty, 0) AS odoo_qty FROM agro_harvests WHERE id = $1`,
    [input.harvestId],
  );
  const quantity = Number(applied?.odoo_qty) || 0;
  if (!quantity) return;
  assertOdooReady();
  const place = await syncAgroPlace(input.companyId, input.propertyId, input.plotId);
  const variantId = await variantFor(input);
  await addProductStockAtLocation(Number(input.companyId), variantId, place.plotLocationId, stockDelta(quantity, 0));
}

export type DeliverySaleLine = {
  deliveryId: string;
  propertyId: string;
  plotId: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  deliveredOn: string;
};

export type GroupedDeliverySale = {
  companyId: string;
  customerName: string;
  deliveryIds: string[];
  lines: DeliverySaleLine[];
};

async function cancelSaleByReference(companyId: string, reference: string): Promise<void> {
  const rows = await odooSearchRead<{ id: number }>(
    'sale.order',
    [
      ['origin', '=', reference],
      ['company_id', '=', Number(companyId)],
      ['state', '!=', 'cancel'],
    ],
    ['id'],
    { limit: 1, order: 'id desc' },
  );
  if (!rows[0]) return;
  await odooExecuteKw('sale.order', 'action_cancel', [[rows[0].id]]).catch(() => undefined);
}

/** Um pedido de venda no Odoo com N linhas (entregas do mesmo local). */
export async function publishGroupedDeliverySale(
  input: GroupedDeliverySale,
): Promise<{ saleDocumentId: string; odooOrderId: string; orderName: string }> {
  assertOdooReady();
  if (!input.lines.length) throw new Error('Selecione ao menos uma entrega');
  const groupId = randomGroupId();
  const reference = `AGRO:group:${groupId}`;
  const orderDate = input.lines
    .map((line) => line.deliveredOn)
    .sort()
    .at(-1) || new Date().toISOString().slice(0, 10);

  const plotIds = [...new Set(input.lines.map((line) => line.plotId).filter(Boolean))];
  let sourceLocationId = 0;
  if (plotIds.length === 1) {
    const first = input.lines.find((line) => line.plotId === plotIds[0]);
    if (first) {
      const place = await syncAgroPlace(input.companyId, first.propertyId, first.plotId);
      sourceLocationId = place.plotLocationId;
    }
  } else {
    // Locais diferentes: sincroniza cada talhão; o pedido usa o depósito padrão.
    for (const line of input.lines) {
      if (line.plotId) await syncAgroPlace(input.companyId, line.propertyId, line.plotId);
    }
  }

  const doc = await createFormDocument('sale', { companyOdooId: input.companyId });
  const saved = await saveFormDocument(doc.id, {
    status: 'draft',
    header: {
      customer: input.customerName,
      order_date: `${orderDate} 12:00:00`,
      customer_reference: reference,
      source: 'agro',
      source_delivery_ids: input.deliveryIds.join(','),
    },
    lines: input.lines.map((line) => ({
      values: {
        product: line.productName,
        quantity: String(line.quantity),
        uom: line.unit,
        unit_price: line.unitPrice == null ? '' : String(line.unitPrice),
      },
    })),
  });

  try {
    const pushed = await pushSaleToOdoo(saved, { confirm: true, sourceLocationId });
    const saleDocumentId = pushed.id;
    const odooOrderId = pushed.header.odoo_id || '';
    const orderName = pushed.header.order_reference || '';
    await run(
      `UPDATE agro_deliveries
       SET sale_document_id = $2, odoo_order_id = $3, odoo_order_ref = $4, updated_at = NOW()
       WHERE id = ANY($1::text[])`,
      [input.deliveryIds, saleDocumentId, odooOrderId, orderName],
    );
    return { saleDocumentId, odooOrderId, orderName };
  } catch (error) {
    await cancelSaleByReference(input.companyId, reference);
    const current = (await getFormDocument(saved.id)) || saved;
    if (Number(current.header.odoo_id || 0) > 0) {
      await odooExecuteKw('sale.order', 'action_cancel', [[Number(current.header.odoo_id)]]).catch(() => undefined);
    }
    await deleteFormDocument(saved.id).catch(() => undefined);
    throw error;
  }
}

function randomGroupId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function revertSavedDelivery(
  companyId: string,
  delivery: { saleDocumentId: string; plantingId: string; quantity: number },
): Promise<void> {
  const planting = await getPlanting(companyId, delivery.plantingId);
  if (!planting) throw new Error('Plantio não encontrado');
  await revertDelivery({
    saleDocumentId: delivery.saleDocumentId,
    companyId,
    plantingId: planting.id,
    propertyId: planting.propertyId,
    plotId: planting.plotId,
    productId: planting.productId,
    productName: planting.productName,
    unit: planting.unit,
    quantity: delivery.quantity,
  });
}

async function revertDelivery(input: PlantingRef & { saleDocumentId: string; quantity: number }): Promise<void> {
  if (!input.saleDocumentId) return;
  const doc = await getFormDocument(input.saleDocumentId);
  if (!doc) return;
  assertOdooReady();
  const place = await syncAgroPlace(input.companyId, input.propertyId, input.plotId);
  const variantId = await variantFor(input);
  const company = Number(input.companyId);
  const before = await addProductStockAtLocation(company, variantId, place.plotLocationId, 0);
  const odooId = Number(doc.header.odoo_id || 0);
  if (odooId > 0) {
    const [order] = await odooSearchRead<{ state: string; name: string }>(
      'sale.order',
      [['id', '=', odooId]],
      ['state', 'name'],
      { limit: 1 },
    );
    const state = String(order?.state || '');
    if (state && state !== 'cancel') {
      try {
        await odooExecuteKw('sale.order', 'action_cancel', [[odooId]]);
      } catch {
        throw new Error(
          `Não foi possível cancelar ${order?.name || 'o pedido'} no Odoo. Estorne a entrega lá antes de excluir.`,
        );
      }
    }
  }
  const after = await addProductStockAtLocation(company, variantId, place.plotLocationId, 0);
  const gap = stockDelta(after, before + input.quantity);
  if (gap > 0) await addProductStockAtLocation(company, variantId, place.plotLocationId, gap);
  await deleteFormDocument(doc.id);
}
