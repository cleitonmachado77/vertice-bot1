/** Regras do ciclo agrícola (plantio → colheita → entrega), sem acesso ao banco. */

export type PlantingStatus = 'planejado' | 'em_colheita' | 'colhido';

const DATE_ERROR = 'Informe uma data válida';

export function parseIsoDate(value: unknown): string {
  const raw = String(value ?? '').trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error(DATE_ERROR);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(DATE_ERROR);
  }
  return raw;
}

export function parseOptionalDate(value: unknown): string | null {
  if (String(value ?? '').trim() === '') return null;
  return parseIsoDate(value);
}

/** Impede data futura (comparação em YYYY-MM-DD). */
export function assertDateNotFuture(iso: string, todayIso: string, label = 'Data'): string {
  const date = parseIsoDate(iso);
  const today = parseIsoDate(todayIso);
  if (date > today) throw new Error(`${label} não pode ser futura`);
  return date;
}

function normalizeNumber(value: unknown): number {
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!raw) throw new Error('Informe um número');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error('Informe um número válido');
  return parsed;
}

export function parseQuantity(value: unknown, label = 'Quantidade'): number {
  if (String(value ?? '').trim() === '') throw new Error(`Informe ${label.toLowerCase()}`);
  const parsed = normalizeNumber(value);
  if (parsed <= 0) throw new Error(`${label} deve ser maior que zero`);
  return Math.round(parsed * 1000) / 1000;
}

export function parseOptionalQuantity(value: unknown, label = 'Quantidade'): number | null {
  if (String(value ?? '').trim() === '') return null;
  return parseQuantity(value, label);
}

export function parseMoney(value: unknown): number | null {
  if (String(value ?? '').trim() === '') return null;
  const parsed = normalizeNumber(value);
  if (parsed < 0) throw new Error('O valor não pode ser negativo');
  return Math.round(parsed * 100) / 100;
}

/** Diferença ainda não lançada no estoque (quantidade nova − quantidade já aplicada). */
export function stockDelta(applied: number, next: number): number {
  return Math.round((next - applied) * 1000) / 1000;
}

export function deliveryTotal(quantity: number, unitPrice: number | null): number | null {
  if (unitPrice == null) return null;
  return Math.round(quantity * unitPrice * 100) / 100;
}

export function assertCanDeliver(harvested: number, delivered: number, quantity: number): void {
  if (harvested <= 0) throw new Error('Registre a colheita antes da entrega');
  const remaining = Math.round((harvested - delivered) * 1000) / 1000;
  if (quantity - remaining > 0.0001) {
    throw new Error('A quantidade da entrega passa do que foi colhido');
  }
}

export function assertHarvestCoversDeliveries(harvested: number, delivered: number): void {
  if (delivered - harvested > 0.0001) {
    throw new Error('A colheita ficaria menor do que a quantidade já entregue');
  }
}

export function statusAfterHarvest(close: boolean): PlantingStatus {
  return close ? 'colhido' : 'em_colheita';
}

export function statusAfterHarvestRemoval(remainingHarvests: number, current: PlantingStatus): PlantingStatus {
  if (remainingHarvests > 0) return current === 'colhido' ? 'colhido' : 'em_colheita';
  return 'planejado';
}

export function isPlantingStatus(value: string): value is PlantingStatus {
  return value === 'planejado' || value === 'em_colheita' || value === 'colhido';
}

/** Soma dias a uma data ISO (AAAA-MM-DD), em UTC civil. */
export function addDaysIso(isoDate: string, days: number): string {
  const base = parseIsoDate(isoDate);
  const [year, month, day] = base.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export const HARVEST_CURVES = ['Uniforme', 'Decrescente', 'Crescente', 'Pico no meio'] as const;
export type HarvestCurve = (typeof HARVEST_CURVES)[number];
export const CURVE_INTENSITIES = [0, 0.5, 1, 1.5, 2] as const;

export type HarvestEstimateLine = {
  index: number;
  forecastOn: string;
  estimatedQty: number;
  weight: number;
};

export type ProductEstimateParams = {
  cycleDays: number | null;
  yieldPerHa: number | null;
  harvestCount: number | null;
  harvestIntervalDays: number | null;
  harvestCurve: HarvestCurve | null;
  curveIntensity: number | null;
  cyclesPerYear: number | null;
};

export function isHarvestCurve(value: unknown): value is HarvestCurve {
  return typeof value === 'string' && (HARVEST_CURVES as readonly string[]).includes(value);
}

export function normalizeHarvestCurve(value: unknown): HarvestCurve {
  return isHarvestCurve(value) ? value : 'Uniforme';
}

export function normalizeCurveIntensity(curve: HarvestCurve, value: unknown): number {
  if (curve === 'Uniforme') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  const allowed = CURVE_INTENSITIES as readonly number[];
  if (allowed.includes(parsed)) return parsed;
  return Math.min(2, Math.max(0, Math.round(parsed * 2) / 2));
}

export function normalizeHarvestCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(30, Math.trunc(parsed));
}

export function normalizeHarvestInterval(harvestCount: number, value: unknown): number {
  if (harvestCount <= 1) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

/** Peso da colheita i (1…N), espelhando a aba Colheitas da planilha. */
export function harvestCurveWeight(
  index: number,
  harvestCount: number,
  curve: HarvestCurve,
  intensity: number,
): number {
  if (index < 1 || index > harvestCount) return 0;
  let base = 1;
  if (curve === 'Decrescente') base = 2 * harvestCount + 1 - index;
  else if (curve === 'Crescente') base = index;
  else if (curve === 'Pico no meio') base = Math.min(index, harvestCount + 1 - index);
  const power = curve === 'Uniforme' ? 0 : intensity;
  return base ** power;
}

/**
 * Gera as N colheitas previstas de um plantio.
 * Produção do ciclo = área_ha × yield_per_ha; qty_i = total × peso_i / Σ pesos.
 * Dia_i = planted_on + cycle_days + (i−1) × intervalo.
 */
export function deriveHarvestEstimates(input: {
  plantedOn: string;
  areaHa: number;
  cycleDays: number | null;
  yieldPerHa: number | null;
  harvestCount?: number | null;
  harvestIntervalDays?: number | null;
  harvestCurve?: HarvestCurve | string | null;
  curveIntensity?: number | null;
}): HarvestEstimateLine[] {
  const cycleDays =
    input.cycleDays != null && Number.isFinite(input.cycleDays) && input.cycleDays > 0
      ? Math.trunc(input.cycleDays)
      : null;
  const yieldPerHa =
    input.yieldPerHa != null && Number.isFinite(input.yieldPerHa) && input.yieldPerHa > 0
      ? input.yieldPerHa
      : null;
  if (cycleDays == null || yieldPerHa == null || !(input.areaHa > 0)) return [];

  const harvestCount = normalizeHarvestCount(input.harvestCount);
  const intervalDays = normalizeHarvestInterval(harvestCount, input.harvestIntervalDays);
  const curve = normalizeHarvestCurve(input.harvestCurve);
  const intensity = normalizeCurveIntensity(curve, input.curveIntensity);
  const productionPerCycle = Math.round(input.areaHa * yieldPerHa * 1000) / 1000;

  const weights = Array.from({ length: harvestCount }, (_, i) =>
    harvestCurveWeight(i + 1, harvestCount, curve, intensity),
  );
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (!(weightSum > 0)) return [];

  return weights.map((weight, i) => {
    const index = i + 1;
    return {
      index,
      forecastOn: addDaysIso(input.plantedOn, cycleDays + (index - 1) * intervalDays),
      estimatedQty: Math.round(((productionPerCycle * weight) / weightSum) * 1000) / 1000,
      weight,
    };
  });
}

/** Previsão e estimativa a partir dos parâmetros do produto (dias e produtividade/ha). */
export function derivePlantingForecast(input: {
  plantedOn: string;
  areaHa: number;
  cycleDays: number | null;
  yieldPerHa: number | null;
  harvestCount?: number | null;
  harvestIntervalDays?: number | null;
  harvestCurve?: HarvestCurve | string | null;
  curveIntensity?: number | null;
}): { forecastOn: string | null; forecastQty: number | null; estimates: HarvestEstimateLine[] } {
  const estimates = deriveHarvestEstimates(input);
  if (!estimates.length) {
    const cycleDays =
      input.cycleDays != null && Number.isFinite(input.cycleDays) && input.cycleDays > 0
        ? Math.trunc(input.cycleDays)
        : null;
    const yieldPerHa =
      input.yieldPerHa != null && Number.isFinite(input.yieldPerHa) && input.yieldPerHa > 0
        ? input.yieldPerHa
        : null;
    return {
      forecastOn: cycleDays == null ? null : addDaysIso(input.plantedOn, cycleDays),
      forecastQty:
        yieldPerHa == null || !(input.areaHa > 0)
          ? null
          : Math.round(input.areaHa * yieldPerHa * 1000) / 1000,
      estimates: [],
    };
  }
  const forecastQty = Math.round(estimates.reduce((sum, line) => sum + line.estimatedQty, 0) * 1000) / 1000;
  return {
    forecastOn: estimates[0]?.forecastOn || null,
    forecastQty,
    estimates,
  };
}

/** Janela ±dias (civil UTC) em torno de uma data ISO. */
export function isoDateWithinWindow(targetIso: string, centerIso: string, days = 30): boolean {
  try {
    const target = parseIsoDate(targetIso);
    const center = parseIsoDate(centerIso);
    const [ty, tm, td] = target.split('-').map(Number);
    const [cy, cm, cd] = center.split('-').map(Number);
    const t = Date.UTC(ty, tm - 1, td);
    const c = Date.UTC(cy, cm - 1, cd);
    const diff = Math.abs(t - c) / 86_400_000;
    return diff <= days;
  } catch {
    return false;
  }
}
