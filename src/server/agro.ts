import { randomUUID } from 'node:crypto';
import { one, run, withTransaction } from './db.js';
import { listAgroCatalog } from './agro-catalog.js';
import {
  getDelivery,
  getHarvest,
  getPlanting,
  listDeliveries,
  listHarvests,
  listPlantings,
  type AgroDelivery,
  type AgroHarvest,
  type AgroPlanting,
} from './agro-model.js';
import { productListPrice, syncAgroBuyer, syncAgroProduct } from './agro-odoo-catalog.js';
import {
  publishDelivery,
  publishHarvest,
  publishPlantingPlace,
  revertSavedDelivery,
  revertHarvestStock,
} from './agro-odoo-flow.js';
import { assignProducer, clip, resolvePlot, resolveProperty } from './agro-resolve.js';
import { refreshAgroMirror } from './agro-mirror.js';
import { ensureAgroSchema } from './agro-schema.js';
import {
  assertCanDeliver,
  assertHarvestCoversDeliveries,
  deliveryTotal,
  isPlantingStatus,
  parseIsoDate,
  parseMoney,
  parseOptionalDate,
  parseOptionalQuantity,
  parseQuantity,
  statusAfterHarvest,
  statusAfterHarvestRemoval,
  type PlantingStatus,
} from './agro-rules.js';

const nowIso = () => new Date().toISOString();
export async function agroOverview(companyId: string) {
  await ensureAgroSchema();
  await refreshAgroMirror(companyId);
  const [plantings, harvests, deliveries, catalog] = await Promise.all([
    listPlantings(companyId),
    listHarvests(companyId),
    listDeliveries(companyId),
    listAgroCatalog(companyId),
  ]);
  return { plantings, harvests, deliveries, catalog };
}

function plantingStatus(current: AgroPlanting | undefined, requested: unknown): PlantingStatus {
  if (!current || current.harvestedQty <= 0) return 'planejado';
  const value = String(requested || current.status);
  if (value === 'colhido') return 'colhido';
  if (isPlantingStatus(value) && value !== 'planejado') return value;
  return 'em_colheita';
}

export async function savePlanting(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroPlanting> {
  await ensureAgroSchema();
  const plantedOn = parseIsoDate(input.plantedOn);
  const forecastOn = parseOptionalDate(input.forecastOn);
  if (forecastOn && forecastOn < plantedOn) {
    throw new Error('A previsão de colheita não pode ser anterior ao plantio');
  }
  const areaPlanned = parseQuantity(input.areaPlanned, 'Área planejada');
  const forecastQty = parseOptionalQuantity(input.forecastQty, 'Quantidade prevista');
  const notes = clip(input.notes, 500);
  const product = await syncAgroProduct(companyId, input);
  const current = id ? await getPlanting(companyId, id) : undefined;
  if (id && !current) throw new Error('Plantio não encontrado');
  if (current && current.deliveredQty > 0 && product.name !== current.productName) {
    throw new Error('Não é possível trocar o produto depois de registrar entregas');
  }
  const status = plantingStatus(current, input.status);
  const plantingId = current?.id || randomUUID();
  const stamp = nowIso();

  await withTransaction(async () => {
    const propertyId = await resolveProperty(companyId, input);
    await assignProducer(companyId, propertyId, input);
    const plotId = await resolvePlot(propertyId, input);
    if (!current) {
      await run(
        `INSERT INTO agro_plantings(
           id, company_odoo_id, property_id, plot_id, product_id, product_name, unit,
           area_planned, planted_on, forecast_on, forecast_qty, notes, status, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [
          plantingId, companyId, propertyId, plotId, product.id, product.name, product.unit,
          areaPlanned, plantedOn, forecastOn, forecastQty, notes, status, stamp,
        ],
      );
      return;
    }
    await run(
      `UPDATE agro_plantings SET
         property_id = $1, plot_id = $2, product_id = $3, product_name = $4, unit = $5,
         area_planned = $6, planted_on = $7, forecast_on = $8, forecast_qty = $9,
         notes = $10, status = $11, updated_at = $12
       WHERE id = $13 AND company_odoo_id = $14`,
      [
        propertyId, plotId, product.id, product.name, product.unit, areaPlanned, plantedOn,
        forecastOn, forecastQty, notes, status, stamp, plantingId, companyId,
      ],
    );
  });

  const saved = await getPlanting(companyId, plantingId);
  if (!saved) throw new Error('Não foi possível salvar o plantio');
  await publishPlantingPlace(companyId, plantingId, !current);
  return saved;
}

export async function deletePlanting(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const current = await getPlanting(companyId, id);
  if (!current) throw new Error('Plantio não encontrado');
  if (current.harvestedQty > 0 || current.deliveredQty > 0) {
    throw new Error('Este plantio tem colheitas ou entregas. Remova esses registros antes de excluir.');
  }
  await run(`DELETE FROM agro_plantings WHERE id = $1 AND company_odoo_id = $2`, [id, companyId]);
}

export async function saveHarvest(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroHarvest> {
  await ensureAgroSchema();
  const planting = await getPlanting(companyId, clip(input.plantingId, 80));
  if (!planting) throw new Error('Plantio não encontrado');
  const current = id ? await getHarvest(companyId, id) : undefined;
  if (id && !current) throw new Error('Colheita não encontrada');
  if (current && current.plantingId !== planting.id) throw new Error('A colheita permanece no plantio de origem');
  if (!current && planting.status === 'colhido') {
    throw new Error('Este plantio já está com a colheita encerrada');
  }
  const quantity = parseQuantity(input.quantity, 'Quantidade colhida');
  const harvestedOn = parseIsoDate(input.harvestedOn);
  if (harvestedOn < planting.plantedOn) throw new Error('A colheita não pode ser anterior ao plantio');
  const harvestedWithout = planting.harvestedQty - (current?.quantity || 0);
  assertHarvestCoversDeliveries(harvestedWithout + quantity, planting.deliveredQty);
  const close = input.close === true || input.close === '1' || input.close === 'true';
  const nextStatus: PlantingStatus =
    planting.status === 'colhido' || close ? 'colhido' : statusAfterHarvest(false);
  const harvestId = current?.id || randomUUID();
  const stamp = nowIso();
  const notes = clip(input.notes, 500);

  await withTransaction(async () => {
    if (!current) {
      await run(
        `INSERT INTO agro_harvests(id, planting_id, harvested_on, quantity, notes, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $6)`,
        [harvestId, planting.id, harvestedOn, quantity, notes, stamp],
      );
    } else {
      await run(
        `UPDATE agro_harvests SET harvested_on = $1, quantity = $2, notes = $3, updated_at = $4 WHERE id = $5`,
        [harvestedOn, quantity, notes, stamp, harvestId],
      );
    }
    await run(`UPDATE agro_plantings SET status = $1, updated_at = $2 WHERE id = $3`, [
      nextStatus,
      stamp,
      planting.id,
    ]);
  });

  await publishHarvest({
    companyId,
    plantingId: planting.id,
    propertyId: planting.propertyId,
    plotId: planting.plotId,
    productId: planting.productId,
    productName: planting.productName,
    unit: planting.unit,
    harvestId,
    quantity,
    created: !current,
    previousStatus: planting.status,
  });

  const saved = await getHarvest(companyId, harvestId);
  if (!saved) throw new Error('Não foi possível salvar a colheita');
  return saved;
}

export async function deleteHarvest(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const current = await getHarvest(companyId, id);
  if (!current) throw new Error('Colheita não encontrada');
  const planting = await getPlanting(companyId, current.plantingId);
  if (!planting) throw new Error('Plantio não encontrado');
  assertHarvestCoversDeliveries(planting.harvestedQty - current.quantity, planting.deliveredQty);
  const remaining = await one<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agro_harvests WHERE planting_id = $1 AND id <> $2`,
    [planting.id, current.id],
  );
  const status = statusAfterHarvestRemoval(remaining?.total || 0, planting.status as PlantingStatus);
  await revertHarvestStock({
    companyId,
    plantingId: planting.id,
    propertyId: planting.propertyId,
    plotId: planting.plotId,
    productId: planting.productId,
    productName: planting.productName,
    unit: planting.unit,
    harvestId: current.id,
  });
  const stamp = nowIso();
  await withTransaction(async () => {
    await run(`DELETE FROM agro_harvests WHERE id = $1`, [current.id]);
    await run(`UPDATE agro_plantings SET status = $1, updated_at = $2 WHERE id = $3`, [
      status,
      stamp,
      planting.id,
    ]);
  });
}

export async function saveDelivery(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroDelivery> {
  await ensureAgroSchema();
  const planting = await getPlanting(companyId, clip(input.plantingId, 80));
  if (!planting) throw new Error('Plantio não encontrado');
  const current = id ? await getDelivery(companyId, id) : undefined;
  if (id && !current) throw new Error('Entrega não encontrada');
  if (current && current.plantingId !== planting.id) throw new Error('A entrega permanece no plantio de origem');
  const quantity = parseQuantity(input.quantity, 'Quantidade entregue');
  const deliveredOn = parseIsoDate(input.deliveredOn);
  if (deliveredOn < planting.plantedOn) throw new Error('A entrega não pode ser anterior ao plantio');
  let unitPrice = parseMoney(input.unitPrice);
  if (unitPrice == null) unitPrice = await productListPrice(planting.productId);
  const total = deliveryTotal(quantity, unitPrice);
  const buyer = await syncAgroBuyer(companyId, input);
  const deliveredWithout = planting.deliveredQty - (current?.quantity || 0);
  assertCanDeliver(planting.harvestedQty, deliveredWithout, quantity);
  const deliveryId = current?.id || randomUUID();
  const stamp = nowIso();
  const document = clip(input.document, 150);
  const notes = clip(input.notes, 500);

  if (!current) {
    await run(
      `INSERT INTO agro_deliveries(
         id, planting_id, partner_id, partner_name, delivered_on, quantity,
         unit_price, total_value, document, notes, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [
        deliveryId, planting.id, buyer.id, buyer.name, deliveredOn, quantity,
        unitPrice, total, document, notes, stamp,
      ],
    );
  } else {
    await run(
      `UPDATE agro_deliveries SET
         partner_id = $1, partner_name = $2, delivered_on = $3, quantity = $4,
         unit_price = $5, total_value = $6, document = $7, notes = $8, updated_at = $9
       WHERE id = $10`,
      [buyer.id, buyer.name, deliveredOn, quantity, unitPrice, total, document, notes, stamp, deliveryId],
    );
  }

  await publishDelivery({
    companyId,
    deliveryId,
    created: !current,
    saleDocumentId: current?.saleDocumentId || '',
    propertyId: planting.propertyId,
    plotId: planting.plotId,
    customerName: buyer.name,
    productName: planting.productName,
    unit: planting.unit,
    quantity,
    unitPrice,
    deliveredOn,
    document,
  });

  const saved = await getDelivery(companyId, deliveryId);
  if (!saved) throw new Error('Não foi possível salvar a entrega');
  return saved;
}

export async function deleteDelivery(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const current = await getDelivery(companyId, id);
  if (!current) throw new Error('Entrega não encontrada');
  await revertSavedDelivery(companyId, current);
  await run(`DELETE FROM agro_deliveries WHERE id = $1`, [current.id]);
}
