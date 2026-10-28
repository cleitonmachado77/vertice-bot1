import { listOdooRefs } from './forms-odoo-refs.js';

/** Unidade de medida do Odoo (uom.uom) com o fator na unidade raiz da árvore (Bag → 100 KG). */
export type UomInfo = { name: string; rootId: string; factor: number };

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
}

/** “Bag”, “bag”, “bags” → mesma unidade (o Odoo não tem plural). */
export function findUom(uoms: UomInfo[], name: string): UomInfo | undefined {
  const wanted = fold(name);
  if (!wanted) return undefined;
  const singular = wanted.replace(/s$/, '');
  return (
    uoms.find((item) => fold(item.name) === wanted) ||
    uoms.find((item) => fold(item.name) === singular || fold(item.name).replace(/s$/, '') === singular)
  );
}

/** Conversão do Odoo: só entre unidades da mesma árvore (Bag ↔ KG); outras → null. */
export function convertUom(qty: number, from: UomInfo, to: UomInfo): number | null {
  if (from.rootId !== to.rootId || !from.factor || !to.factor) return null;
  return Math.round(((qty * from.factor) / to.factor) * 1000) / 1000;
}

/** Quantidade em kg, se a unidade for da mesma árvore de uma unidade chamada “kg”. */
export function toKg(qty: number, uomName: string, uoms: UomInfo[]): number | null {
  const from = findUom(uoms, uomName);
  if (!from) return null;
  const kg = uoms.find((item) => fold(item.name) === 'kg' && item.rootId === from.rootId);
  return kg ? convertUom(qty, from, kg) : null;
}

export async function listUomInfos(): Promise<UomInfo[]> {
  const rows = await listOdooRefs('uom');
  return rows.map((row) => ({
    name: row.name,
    rootId: row.meta.root_id || row.odoo_id,
    factor: Number(row.meta.factor) || 1,
  }));
}

const WEIGHT_UNIT_RE = /^(kg|kgs|quilos?|kilos?)$/;
const COUNT_UNITS: Array<{ re: RegExp; name: string }> = [
  { re: /^(big\s*)?bags?$/, name: 'Bag' },
  { re: /^(caixas?|cx)$/, name: 'Caixa' },
  { re: /^(sacos?|sacas?|sc)$/, name: 'Saco' },
  { re: /^fardos?$/, name: 'Fardo' },
  { re: /^bandejas?$/, name: 'Bandeja' },
  { re: /^lotes?$/, name: 'Lote' },
];

/**
 * “10 bags” → { quantity: '10', uom: 'Bag' }; “120 kg” → uom 'KG'; “12” → uom ''.
 * A unidade é o nome procurado nas unidades do Odoo (que convertem para a do produto).
 */
export function splitQuantityUnit(raw: string): { quantity: string; uom: string } {
  const match = /(\d+(?:[.,]\d+)?)\s*([\p{L}\s]*)/u.exec(String(raw || '').trim());
  if (!match) return { quantity: String(raw || '').trim(), uom: '' };
  const quantity = match[1].replace(',', '.');
  const word = fold(match[2]).replace(/\s+/g, ' ').trim();
  if (!word) return { quantity, uom: '' };
  if (WEIGHT_UNIT_RE.test(word)) return { quantity, uom: 'KG' };
  return { quantity, uom: COUNT_UNITS.find((item) => item.re.test(word))?.name || '' };
}
