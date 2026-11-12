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

type DeliveryPush = {
  companyId: string;
  deliveryId: string;
  created: boolean;
  saleDocumentId: string;
  propertyId: string;
  plotId: string;
  customerName: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  deliveredOn: string;
  document: string;
};

async function pushAgroSale(
  input: DeliveryPush,
  plotLocationId: number,
): Promise<{ saleDocumentId: string; odooOrderId: string; orderName: string }> {
  const existing = input.saleDocumentId ? await getFormDocument(input.saleDocumentId) : undefined;
  const sale = existing?.kind === 'sale' ? existing : undefined;
  const doc = sale || (await createFormDocument('sale', { companyOdooId: input.companyId }));
  const reference = `AGRO:${input.deliveryId}`;
  const saved = await saveSale(doc.id, sale?.status || 'draft', sale?.lines[0]?.id, input, input.document);
  try {
    const pushed = await pushSaleToOdoo(saved, { confirm: true, sourceLocationId: plotLocationId });
    return {
      saleDocumentId: pushed.id,
      odooOrderId: pushed.header.odoo_id || '',
      orderName: pushed.header.order_reference || '',
    };
  } catch (error) {
    if (!sale) {
      await cancelSaleByReference(input.companyId, reference);
      const current = (await getFormDocument(saved.id)) || saved;
      if (Number(current.header.odoo_id || 0) > 0) {
        await odooExecuteKw('sale.order', 'action_cancel', [[Number(current.header.odoo_id)]]).catch(() => undefined);
      }
      await deleteFormDocument(saved.id).catch(() => undefined);
    }
    throw error;
  }
}

function saveSale(
  id: string,
  status: string,
  lineId: string | undefined,
  input: DeliveryPush,
  reference: string,
) {
  return saveFormDocument(id, {
    status,
    header: {
      customer: input.customerName,
      order_date: `${input.deliveredOn} 12:00:00`,
      customer_reference: reference,
      source: 'agro',
      source_delivery_id: input.deliveryId,
    },
    lines: [
      {
        id: lineId,
        values: {
          product: input.productName,
          quantity: String(input.quantity),
          uom: input.unit,
          unit_price: input.unitPrice == null ? '' : String(input.unitPrice),
        },
      },
    ],
  });
}

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

export async function publishDelivery(input: DeliveryPush): Promise<void> {
  try {
    const place = await syncAgroPlace(input.companyId, input.propertyId, input.plotId);
    const result = await pushAgroSale(input, place.plotLocationId);
    await run(
      `UPDATE agro_deliveries
       SET sale_document_id = $2, odoo_order_id = $3,
           document = CASE WHEN document = '' THEN $4 ELSE document END,
           updated_at = NOW()
       WHERE id = $1`,
      [input.deliveryId, result.saleDocumentId, result.odooOrderId, result.orderName],
    );
  } catch (error) {
    if (input.created) await run(`DELETE FROM agro_deliveries WHERE id = $1`, [input.deliveryId]);
    throw error;
  }
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
