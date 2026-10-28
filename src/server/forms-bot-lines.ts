import {
  isLinesMoreDoneAnswer,
  isQuantityOnly,
  parseQtyProductChunks,
  quantityNumber,
} from './forms-bot-fields.js';
import { lineFieldsFor, type FormKind } from './forms-fields.js';
import { splitQuantityUnit } from './forms-uom.js';

export type BotLineRow = Record<string, string>;

/** Linhas do documento antes de resolver nomes no catálogo (puro, sem banco). */
export type BotLinesPlan = {
  primary: BotLineRow[];
  primaryKeys: string[];
  /** false quando as linhas vêm direto do padrão (nada respondido em __lines__). */
  resolvePrimary: boolean;
  extra: BotLineRow[];
  extraKeys: string[];
};

export function planBotLines(input: {
  kind: FormKind;
  presetLines: Array<{ values: Record<string, string> }>;
  visibleLineKeys: string[];
  linesAnswer: string;
  moreAnswer: string;
}): BotLinesPlan {
  const empty: BotLinesPlan = { primary: [], primaryKeys: [], resolvePrimary: false, extra: [], extraKeys: [] };
  if (!lineFieldsFor(input.kind).length) return empty;

  const baseLines = input.presetLines.length ? input.presetLines : [{ values: {} as BotLineRow }];
  const plan = { ...empty };
  const linesAnswer = String(input.linesAnswer || '').trim();
  if (linesAnswer) {
    // “uom” sempre: “10 bags” traz a unidade mesmo com o campo oculto no padrão.
    plan.primaryKeys = [
      ...new Set([...input.visibleLineKeys, ...Object.keys(baseLines[0]?.values || {}), 'uom']),
    ];
    plan.resolvePrimary = true;
    const productFixed = !input.visibleLineKeys.includes('product');
    plan.primary = parseLinesAnswer(linesAnswer, input.kind, input.visibleLineKeys).map((row, index) => {
      // Linha além do padrão herda só campos genéricos (ex.: impostos), não produto/preço.
      const base =
        index < baseLines.length
          ? { ...(baseLines[index]?.values || {}) }
          : withoutProductSpecific(baseLines[baseLines.length - 1]?.values || {});
      // “50 kg de abacate” para o produto fixo “ABACATE - KG”: mantém o produto do padrão
      // (senão o catálogo pode escolher outro abacate).
      if (productFixed && base.product && row.product) {
        // Outro produto no lugar do fixo (“manga” para “Qtd de ABACATE?”): não herda o preço do abacate.
        return sameProduct(row.product, base.product)
          ? { ...base, ...row, product: base.product }
          : { ...withoutProductSpecific(base), ...row };
      }
      return { ...base, ...row };
    });
  } else if (input.presetLines.length) {
    plan.primary = input.presetLines.map((line) => ({ ...line.values }));
  }

  const moreAnswer = String(input.moreAnswer || '').trim();
  if (moreAnswer && !isLinesMoreDoneAnswer(moreAnswer)) {
    plan.extraKeys = [...new Set([...input.visibleLineKeys, 'product', 'quantity', 'unit_price', 'uom'])];
    plan.extra = parseLinesAnswer(moreAnswer, input.kind, plan.extraKeys);
  }
  return plan;
}

function foldName(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

function sameProduct(typed: string, catalogName: string): boolean {
  const a = foldName(typed);
  const b = foldName(catalogName);
  return Boolean(a && b) && (b.includes(a) || a.includes(b));
}

/**
 * Quantidade + unidade de contagem do Odoo (“10 bags” → 10, “Bag”): o Odoo converte para a
 * unidade de estoque. Peso (“50 kg”) fica na unidade do produto, como antes.
 */
function lineQuantity(raw: string): BotLineRow {
  const split = splitQuantityUnit(raw);
  const quantity = quantityNumber(raw) || split.quantity || String(raw || '').trim();
  return split.uom && split.uom !== 'KG' ? { quantity, uom: split.uom } : { quantity };
}

function withoutProductSpecific(values: BotLineRow): BotLineRow {
  const { product: _product, unit_price: _price, quantity: _quantity, ...rest } = values;
  return rest;
}

/** JSON do atalho, “50 kg de abacate, 20 kg de mandioca”, “3 kg” ou linhas “a; b; c”. */
export function parseLinesAnswer(raw: string, kind: FormKind, visibleKeys: string[]): BotLineRow[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  // product/quantity sempre: o padrão pode mostrar só a quantidade, mas o item extra tem produto.
  const keys = [...new Set([...visibleKeys, 'product', 'quantity', 'uom'])];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          const src = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const values: BotLineRow = {};
          for (const key of keys) {
            if (src[key] != null && String(src[key]).trim()) values[key] = String(src[key]);
          }
          return values.quantity && !values.uom ? { ...values, ...lineQuantity(values.quantity) } : values;
        })
        .filter((row) => Object.values(row).some((value) => value.trim()));
    }
  } catch {
    /* texto livre */
  }

  const chunks = parseQtyProductChunks(text);
  if (chunks.length) {
    return chunks.map((chunk) => ({
      ...lineQuantity(chunk.quantity),
      product: chunk.product,
    }));
  }

  // “Qtd de ABACATE?” → “3” / “3 kg”: só a quantidade; o produto vem da linha do padrão.
  if (isQuantityOnly(text)) {
    const row = lineQuantity(text);
    if (row.quantity) return [row];
  }

  const lineFields = lineFieldsFor(kind).filter((field) => visibleKeys.includes(field.key));
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*]?\s*\d+[).:-]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[;|,]/).map((part) => part.trim()).filter(Boolean);
      const values: BotLineRow = {};
      for (const field of lineFields) values[field.key] = '';
      if (parts.length === 1 && lineFields[0]) {
        values[lineFields[0].key] = parts[0];
        return values;
      }
      for (let index = 0; index < lineFields.length; index += 1) {
        values[lineFields[index].key] = parts[index] || '';
      }
      return values;
    })
    .filter((row) => Object.values(row).some((value) => value.trim()));
}
