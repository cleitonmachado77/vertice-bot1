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

/** Previsão e estimativa a partir dos parâmetros do produto (dias e produtividade/ha). */
export function derivePlantingForecast(input: {
  plantedOn: string;
  areaHa: number;
  cycleDays: number | null;
  yieldPerHa: number | null;
}): { forecastOn: string | null; forecastQty: number | null } {
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
  };
}
