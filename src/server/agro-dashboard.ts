import { listAgroCatalog } from './agro-catalog.js';
import { listCosts } from './agro-costs.js';
import { listDeliveries, listHarvests, listPlantings } from './agro-model.js';
import { ensureAgroSchema } from './agro-schema.js';

export type AgroDashBar = { label: string; value: number; unit?: string };
export type AgroDashSeries = { label: string; revenue: number; expense: number };

function inPeriod(iso: string, month: number, year: number): boolean {
  if (!iso || iso.length < 7) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return y === year && m === month;
}

function productLabel(name: string, sigla: string): string {
  return (sigla || name || '—').trim() || '—';
}

function addMap(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) || 0) + value);
}

function barsFromMap(map: Map<string, number>, unit = ''): AgroDashBar[] {
  return [...map.entries()]
    .map(([label, value]) => ({ label, value: Math.round(value * 1000) / 1000, unit }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'pt-BR'));
}

function isActivePlanting(status: string): boolean {
  return status !== 'colhido';
}

export async function agroDashboard(
  companyId: string,
  month: number,
  year: number,
  productId = '',
) {
  await ensureAgroSchema();
  const now = new Date();
  const periodMonth = month >= 1 && month <= 12 ? month : now.getMonth() + 1;
  const periodYear = year >= 2000 && year <= 2100 ? year : now.getFullYear();
  const selectedProductId = String(productId || '').trim();

  const [plantings, harvests, deliveries, costs, catalog] = await Promise.all([
    listPlantings(companyId),
    listHarvests(companyId),
    listDeliveries(companyId),
    listCosts(companyId),
    listAgroCatalog(companyId),
  ]);

  const matchProduct = (id: string) => !selectedProductId || id === selectedProductId;

  const siglaByProductId = new Map(
    (catalog.products || []).map((item) => [item.id, String(item.sigla || '').trim()]),
  );
  const salesPriceByProductId = new Map(
    (catalog.products || []).map((item) => [item.id, Number(String(item.salesPrice || '').replace(',', '.')) || 0]),
  );
  const labelOf = (id: string, productName: string) =>
    productLabel(productName, siglaByProductId.get(id) || '');

  const plantingById = new Map(plantings.map((item) => [item.id, item]));

  /** Talhões com plantio da cultura filtrada (custos / receita por área). */
  const plotIdsForProduct = new Set(
    plantings.filter((item) => matchProduct(item.productId)).map((item) => item.plotId).filter(Boolean),
  );
  const matchPlot = (plotId: string) =>
    !selectedProductId || (plotId && plotIdsForProduct.has(plotId));

  const avgPriceByProduct = new Map<string, { value: number; qty: number }>();
  for (const item of deliveries) {
    if (!inPeriod(item.deliveredOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const key = item.productName || item.plantingId;
    const bucket = avgPriceByProduct.get(key) || { value: 0, qty: 0 };
    bucket.value += Number(item.totalValue || 0);
    bucket.qty += Number(item.quantity || 0);
    avgPriceByProduct.set(key, bucket);
  }

  function avgSalePrice(id: string, productName: string): number {
    const bucket = avgPriceByProduct.get(productName);
    if (bucket && bucket.qty > 0) return bucket.value / bucket.qty;
    return salesPriceByProductId.get(id) || 0;
  }

  const forecastByProduct = new Map<string, number>();
  const forecastTimeline: Array<{ product: string; date: string; qty: number }> = [];
  const plantingByProduct = new Map<string, number>();
  const harvestByProduct = new Map<string, number>();
  const deliveryByProduct = new Map<string, number>();
  const salesByProduct = new Map<string, number>();
  const stockByProduct = new Map<string, number>();
  const costsByArea = new Map<string, number>();
  const revenueByArea = new Map<string, number>();
  const expenseByArea = new Map<string, number>();

  let plantedAreaHa = 0;
  let estimatedQty = 0;

  for (const item of plantings) {
    if (!matchProduct(item.productId)) continue;
    const label = labelOf(item.productId, item.productName);

    if (isActivePlanting(item.status)) {
      plantedAreaHa += Number(item.areaPlanned || 0);
      estimatedQty += Number(item.forecastQty || 0);
    }

    if (inPeriod(item.plantedOn, periodMonth, periodYear)) {
      addMap(plantingByProduct, label, Number(item.forecastQty || 0));
    }
    if (item.forecastQty != null && item.forecastOn && inPeriod(item.forecastOn, periodMonth, periodYear)) {
      addMap(forecastByProduct, label, Number(item.forecastQty || 0));
      forecastTimeline.push({
        product: label,
        date: item.forecastOn,
        qty: Number(item.forecastQty || 0),
      });
    }
    const stock = Number(item.harvestedQty || 0) - Number(item.deliveredQty || 0);
    if (stock > 0.0001) addMap(stockByProduct, label, stock);
  }

  let harvestedQty = 0;
  for (const item of harvests) {
    if (!inPeriod(item.harvestedOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const qty = Number(item.quantity || 0);
    harvestedQty += qty;
    const label = labelOf(planting?.productId || '', item.productName);
    addMap(harvestByProduct, label, qty);
    const area = item.plotName || planting?.plotName || 'Sem talhão';
    const price = avgSalePrice(planting?.productId || '', item.productName);
    addMap(revenueByArea, area, qty * price);
  }

  let deliveredQty = 0;
  let soldValue = 0;
  for (const item of deliveries) {
    if (!inPeriod(item.deliveredOn, periodMonth, periodYear)) continue;
    const planting = plantingById.get(item.plantingId);
    if (!matchProduct(planting?.productId || '')) continue;
    const qty = Number(item.quantity || 0);
    const value = Number(item.totalValue || 0);
    deliveredQty += qty;
    soldValue += value;
    const label = labelOf(planting?.productId || '', item.productName);
    addMap(deliveryByProduct, label, qty);
    addMap(salesByProduct, label, value);
  }

  let productionCosts = 0;
  for (const item of costs) {
    if (!inPeriod(item.costOn, periodMonth, periodYear)) continue;
    if (!matchPlot(item.plotId)) continue;
    const area = item.plotName || 'Sem talhão';
    const amount = item.totalValue != null ? item.totalValue : Number(item.quantity || 0);
    productionCosts += amount;
    addMap(costsByArea, area, amount);
    addMap(expenseByArea, area, amount);
  }

  const areaKeys = new Set([...revenueByArea.keys(), ...expenseByArea.keys()]);
  const revenueExpenseByArea: AgroDashSeries[] = [...areaKeys]
    .map((label) => ({
      label,
      revenue: Math.round((revenueByArea.get(label) || 0) * 100) / 100,
      expense: Math.round((expenseByArea.get(label) || 0) * 100) / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.label.localeCompare(b.label, 'pt-BR'));

  const productOptions = new Map<string, { id: string; name: string; sigla: string; label: string }>();
  for (const item of plantings) {
    if (!item.productId || productOptions.has(item.productId)) continue;
    productOptions.set(item.productId, {
      id: item.productId,
      name: item.productName,
      sigla: siglaByProductId.get(item.productId) || '',
      label: labelOf(item.productId, item.productName),
    });
  }
  for (const item of catalog.products || []) {
    if (productOptions.has(item.id)) continue;
    productOptions.set(item.id, {
      id: item.id,
      name: item.name,
      sigla: item.sigla || '',
      label: productLabel(item.name, item.sigla || ''),
    });
  }

  return {
    period: { month: periodMonth, year: periodYear },
    productId: selectedProductId,
    products: [...productOptions.values()].sort((a, b) =>
      a.label.localeCompare(b.label, 'pt-BR'),
    ),
    summary: {
      plantedAreaHa: Math.round(plantedAreaHa * 1000) / 1000,
      estimatedQty: Math.round(estimatedQty * 1000) / 1000,
      harvestedQty: Math.round(harvestedQty * 1000) / 1000,
      deliveredQty: Math.round(deliveredQty * 1000) / 1000,
      soldValue: Math.round(soldValue * 100) / 100,
      costs: Math.round(productionCosts * 100) / 100,
    },
    forecast: {
      byProduct: barsFromMap(forecastByProduct),
      timeline: forecastTimeline.sort(
        (a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product),
      ),
    },
    plantingByProduct: barsFromMap(plantingByProduct),
    harvestByProduct: barsFromMap(harvestByProduct),
    deliveryByProduct: barsFromMap(deliveryByProduct),
    salesByProduct: barsFromMap(salesByProduct, 'R$'),
    stockByProduct: barsFromMap(stockByProduct),
    costsByArea: barsFromMap(costsByArea, 'R$'),
    revenueExpenseByArea,
  };
}
