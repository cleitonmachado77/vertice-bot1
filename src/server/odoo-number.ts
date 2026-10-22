/** Texto do Forms → número do Odoo. “20 kg”, “R$ 15,50” usam o número contido. */
export function toOdooNumber(value: string | undefined, fallback = 0): number {
  const raw = String(value || '').trim();
  const n = Number(raw.replace(',', '.'));
  if (Number.isFinite(n)) return n;
  const match = /-?\d+(?:[.,]\d+)?/.exec(raw);
  const embedded = match ? Number(match[0].replace(',', '.')) : NaN;
  return Number.isFinite(embedded) ? embedded : fallback;
}

/**
 * Número do Odoo → texto do Forms. Odoo manda `false` em campo vazio (vira "", não "false")
 * e floats como 0.30000000000000004 (arredonda a 6 casas: "0.3").
 */
export function fromOdooNumber(value: unknown): string {
  if (value == null || value === false || value === '') return '';
  const n = typeof value === 'number' ? value : toOdooNumber(String(value), NaN);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(6)));
}
