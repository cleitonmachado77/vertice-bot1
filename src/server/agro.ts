import { randomUUID } from 'node:crypto';
import { one, run, withTransaction } from './db.js';
import { listAgroCatalog } from './agro-catalog.js';
import { deleteCost, listCosts, saveCost } from './agro-costs.js';
import {
  getDelivery,
  getHarvest,
  getPlanting,
  listDeliveries,
  listHarvests,
  listPlantingEstimates,
  listPlantings,
  type AgroDelivery,
  type AgroHarvest,
  type AgroPlanting,
} from './agro-model.js';
import { productListPrice, syncAgroBuyer, syncAgroProduct } from './agro-odoo-catalog.js';
import {
  publishGroupedDeliverySale,
  publishHarvest,
  publishPlantingPlace,
  revertHarvestStock,
} from './agro-odoo-flow.js';
import { assignProducer, clip, resolveBuyer, resolvePlot, resolveProperty } from './agro-resolve.js';
import { upsertPartner } from './forms-catalog.js';
import { refreshAgroMirror } from './agro-mirror.js';
import { ensureAgroSchema } from './agro-schema.js';
import { zonedNow } from './clock.js';
import {
  assertCanDeliver,
  assertDateNotFuture,
  assertHarvestCoversDeliveries,
  deliveryTotal,
  derivePlantingForecast,
  isPlantingStatus,
  normalizeCurveIntensity,
  normalizeHarvestCount,
  normalizeHarvestCurve,
  normalizeHarvestInterval,
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
  const [plantings, harvests, deliveries, costs, estimates, catalog] = await Promise.all([
    listPlantings(companyId),
    listHarvests(companyId),
    listDeliveries(companyId),
    listCosts(companyId),
    listPlantingEstimates(companyId),
    listAgroCatalog(companyId),
  ]);
  return { plantings, harvests, deliveries, costs, estimates, catalog };
}

export { deleteCost, saveCost };

function plantingStatus(current: AgroPlanting | undefined, requested: unknown): PlantingStatus {
  if (!current || current.harvestedQty <= 0) return 'planejado';
  const value = String(requested || current.status);
  if (value === 'colhido') return 'colhido';
  if (isPlantingStatus(value) && value !== 'planejado') return value;
  return 'em_colheita';
}

function softQuantity(value: unknown): number | null {
  try {
    return parseOptionalQuantity(value, 'valor');
  } catch {
    return null;
  }
}

async function productAgroParams(companyId: string, productId: string) {
  const empty = {
    cycleDays: null as number | null,
    yieldPerHa: null as number | null,
    harvestCount: 1,
    harvestIntervalDays: 0,
    harvestCurve: 'Uniforme' as const,
    curveIntensity: 0,
    cyclesPerYear: null as number | null,
  };
  if (!productId) return empty;
  const row = await one<{ header_json: string }>(
    `SELECT header_json FROM forms_documents
     WHERE id = $1 AND kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $2`,
    [productId, companyId],
  );
  if (!row) return empty;
  try {
    const header = JSON.parse(row.header_json || '{}') as Record<string, unknown>;
    const harvestCount = normalizeHarvestCount(header.harvest_count ?? 1);
    const harvestCurve = normalizeHarvestCurve(header.harvest_curve);
    return {
      cycleDays: softQuantity(header.cycle_days),
      yieldPerHa: softQuantity(header.yield_per_ha),
      harvestCount,
      harvestIntervalDays: normalizeHarvestInterval(harvestCount, header.harvest_interval_days),
      harvestCurve,
      curveIntensity: normalizeCurveIntensity(harvestCurve, header.curve_intensity),
      cyclesPerYear: softQuantity(header.cycles_per_year),
    };
  } catch {
    return empty;
  }
}

async function replacePlantingEstimates(
  plantingId: string,
  estimates: Array<{ index: number; forecastOn: string; estimatedQty: number }>,
  stamp: string,
): Promise<void> {
  await run(`DELETE FROM agro_planting_estimates WHERE planting_id = $1`, [plantingId]);
  for (const line of estimates) {
    await run(
      `INSERT INTO agro_planting_estimates(
         id, planting_id, harvest_index, forecast_on, estimated_qty, created_at, updated_at
       ) VALUES($1, $2, $3, $4, $5, $6, $6)`,
      [
        randomUUID(),
        plantingId,
        line.index,
        line.forecastOn,
        line.estimatedQty,
        stamp,
      ],
    );
  }
}

export async function savePlanting(
  companyId: string,
  input: Record<string, unknown>,
  id = '',
): Promise<AgroPlanting> {
  await ensureAgroSchema();
  const plantedOn = assertDateNotFuture(parseIsoDate(input.plantedOn), zonedNow().date, 'Data do plantio');
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
  const params = await productAgroParams(companyId, product.id);
  let areaPlanned = 0;
  let plantedQty: number | null = null;
  let forecastOn: string | null = null;
  let forecastQty: number | null = null;

  await withTransaction(async () => {
    const propertyId = await resolveProperty(companyId, input);
    await assignProducer(companyId, propertyId, input);
    const plotId = await resolvePlot(propertyId, input);
    const plot = await one<{ area: number | null }>(
      `SELECT area FROM agro_plots WHERE id = $1 AND active = 1`,
      [plotId],
    );
    if (String(input.areaPlanned ?? '').trim() !== '') {
      areaPlanned = parseQuantity(input.areaPlanned, 'Área plantada');
    } else if (plot?.area != null && Number(plot.area) > 0) {
      areaPlanned = Math.round(Number(plot.area) * 1000) / 1000;
    } else {
      throw new Error('Informe a área plantada (ha) ou cadastre a área do talhão');
    }

    plantedQty = parseOptionalQuantity(input.plantedQty, 'Quantidade plantada');

    const derived = derivePlantingForecast({
      plantedOn,
      areaHa: areaPlanned,
      cycleDays: params.cycleDays,
      yieldPerHa: params.yieldPerHa,
      harvestCount: params.harvestCount,
      harvestIntervalDays: params.harvestIntervalDays,
      harvestCurve: params.harvestCurve,
      curveIntensity: params.curveIntensity,
    });
// Previsão e estimativa são calculadas pelo produto; não aceitam edição manual.
    forecastOn = derived.forecastOn;
    forecastQty = derived.forecastQty;
    if (forecastOn && forecastOn < plantedOn) {
      throw new Error('A previsão de colheita não pode ser anterior ao plantio');
    }

    const canRegenerateEstimates = !current || current.harvestedQty <= 0;
    const estimateLines =
      canRegenerateEstimates
        ? derived.estimates.length
          ? derived.estimates
          : forecastOn && forecastQty != null
            ? [{ index: 1, forecastOn, estimatedQty: forecastQty, weight: 1 }]
            : []
        : null;

    if (!current) {
      await run(
        `INSERT INTO agro_plantings(
           id, company_odoo_id, property_id, plot_id, product_id, product_name, unit,
area_planned, planted_qty, planted_on, forecast_on, forecast_qty, notes, status, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          plantingId, companyId, propertyId, plotId, product.id, product.name, product.unit,
          areaPlanned, plantedQty, plantedOn, forecastOn, forecastQty, notes, status, stamp,
        ],
      );
      if (estimateLines) await replacePlantingEstimates(plantingId, estimateLines, stamp);
      return;
    }
    await run(
      `UPDATE agro_plantings SET
         property_id = $1, plot_id = $2, product_id = $3, product_name = $4, unit = $5,
area_planned = $6, planted_qty = $7, planted_on = $8, forecast_on = $9, forecast_qty = $10,
         notes = $11, status = $12, updated_at = $13
       WHERE id = $14 AND company_odoo_id = $15`,
      [
        propertyId, plotId, product.id, product.name, product.unit, areaPlanned, plantedQty, plantedOn,
        forecastOn, forecastQty, notes, status, stamp, plantingId, companyId,
      ],
    );
    if (estimateLines) await replacePlantingEstimates(plantingId, estimateLines, stamp);
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

/** Marca o plantio como colhido (útil quando a colheita veio pelo Bot sem encerrar). */
export async function closePlanting(companyId: string, id: string): Promise<AgroPlanting> {
  await ensureAgroSchema();
  const current = await getPlanting(companyId, id);
  if (!current) throw new Error('Plantio não encontrado');
  if (current.status === 'colhido') return current;
  if (current.harvestedQty <= 0) {
    throw new Error('Registre ao menos uma colheita antes de encerrar o plantio');
  }
  await run(
    `UPDATE agro_plantings SET status = 'colhido', updated_at = NOW()
     WHERE id = $1 AND company_odoo_id = $2`,
    [id, companyId],
  );
  const saved = await getPlanting(companyId, id);
  if (!saved) throw new Error('Não foi possível encerrar o plantio');
  return saved;
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
  const areaHarvested = parseOptionalQuantity(input.areaHarvested, 'Área colhida');
  const harvestedOn = parseIsoDate(input.harvestedOn);
  if (harvestedOn < planting.plantedOn) throw new Error('A colheita não pode ser anterior ao plantio');
  const harvestedWithout = planting.harvestedQty - (current?.quantity || 0);
  assertHarvestCoversDeliveries(harvestedWithout + quantity, planting.deliveredQty);
  const close =
    input.close === true ||
    input.close === '1' ||
    input.close === 'true' ||
    String(input.status || '').toLowerCase() === 'fechada' ||
    String(input.status || '').toLowerCase() === 'colhido';
  const nextStatus: PlantingStatus =
    planting.status === 'colhido' || close ? 'colhido' : statusAfterHarvest(false);
  const harvestId = current?.id || randomUUID();
  const stamp = nowIso();
  const notes = clip(input.notes, 500);

  await withTransaction(async () => {
    if (!current) {
      await run(
        `INSERT INTO agro_harvests(
           id, planting_id, harvested_on, quantity, area_harvested, notes, created_at, updated_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, $7)`,
        [harvestId, planting.id, harvestedOn, quantity, areaHarvested, notes, stamp],
      );
    } else {
      await run(
        `UPDATE agro_harvests
         SET harvested_on = $1, quantity = $2, area_harvested = $3, notes = $4, updated_at = $5
         WHERE id = $6`,
        [harvestedOn, quantity, areaHarvested, notes, stamp, harvestId],
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
  if (current?.odooOrderId) {
    throw new Error('Esta entrega já tem pedido no Odoo. Não é possível editar.');
  }
  const quantity = parseQuantity(input.quantity, 'Quantidade entregue');
  const deliveredOn = parseIsoDate(input.deliveredOn);
  if (deliveredOn < planting.plantedOn) throw new Error('A entrega não pode ser anterior ao plantio');
  let unitPrice = parseMoney(input.unitPrice);
  if (unitPrice == null) unitPrice = await productListPrice(planting.productId);
  const total = deliveryTotal(quantity, unitPrice);
  let buyer = await resolveBuyer(companyId, input);
  if (!buyer.id) {
    const created = await upsertPartner(buyer.name, 'customer', companyId);
    if (!created) throw new Error('Informe o local de entrega');
    buyer = { id: created.id, name: created.name };
  }
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

  const saved = await getDelivery(companyId, deliveryId);
  if (!saved) throw new Error('Não foi possível salvar a entrega');
  return saved;
}

export async function groupDeliveriesSale(
  companyId: string,
  deliveryIdsInput: unknown,
): Promise<{ orderName: string; odooOrderId: string; items: AgroDelivery[] }> {
  await ensureAgroSchema();
  const deliveryIds = Array.isArray(deliveryIdsInput)
    ? [...new Set(deliveryIdsInput.map((item) => clip(item, 80)).filter(Boolean))]
    : [];
  if (!deliveryIds.length) throw new Error('Selecione ao menos uma entrega');

  const all = await listDeliveries(companyId);
  const selected = deliveryIds.map((id) => {
    const item = all.find((entry) => entry.id === id);
    if (!item) throw new Error('Entrega não encontrada');
    return item;
  });
  if (selected.some((item) => item.odooOrderId)) {
    throw new Error('Uma ou mais entregas já têm pedido no Odoo');
  }
  const partnerId = selected[0]?.partnerId || '';
  if (!partnerId || selected.some((item) => item.partnerId !== partnerId)) {
    throw new Error('Selecione entregas do mesmo local de entrega');
  }
  const customerName = selected[0]?.partnerName || '';
  if (!customerName) throw new Error('Local de entrega sem nome');
  await syncAgroBuyer(companyId, { partnerId, partnerName: customerName });

  const plantings = await listPlantings(companyId);
  const lines = selected.map((item) => {
    const planting = plantings.find((entry) => entry.id === item.plantingId);
    if (!planting) throw new Error(`Plantio não encontrado para a entrega ${item.id}`);
    return {
      deliveryId: item.id,
      propertyId: planting.propertyId,
      plotId: planting.plotId || item.plotId,
      productName: item.productName || planting.productName,
      unit: item.unit || planting.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      deliveredOn: item.deliveredOn,
    };
  });

  const result = await publishGroupedDeliverySale({
    companyId,
    customerName,
    deliveryIds: selected.map((item) => item.id),
    lines,
  });

  const items = (await listDeliveries(companyId)).filter((item) =>
    selected.some((entry) => entry.id === item.id),
  );
  return { orderName: result.orderName, odooOrderId: result.odooOrderId, items };
}

export async function deleteDelivery(companyId: string, id: string): Promise<void> {
  await ensureAgroSchema();
  const current = await getDelivery(companyId, id);
  if (!current) throw new Error('Entrega não encontrada');
  if (current.odooOrderId || current.saleDocumentId) {
    throw new Error(
      'Esta entrega já tem pedido no Odoo. Cancele/estorne o pedido no Odoo antes de excluir no Vertice.',
    );
  }
  await run(`DELETE FROM agro_deliveries WHERE id = $1`, [current.id]);
}
