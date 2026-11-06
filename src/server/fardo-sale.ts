import { BAG_MATERIALS, ensureBagMaterials, fardoVariantRef, findBagMaterial, lookupBagType, type BagMaterial } from './bag-materials.js';
import { FARDO_SALE_FIELD, isMarkedNewValue, markNewValue, unmarkNewValue } from './forms-bot-fields.js';
import { odooExecuteKw } from './odoo-client.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

/** Padrão Entrega de Fardos da Reciclabrasil. */
export const FARDO_DELIVERY_PRESET_ID = 'ff297445-83fb-4dc2-89f8-3b30976a5d95';

export const FARDO_SALE_QUESTION = 'Qual fardo do estoque e qual o peso? (ex.: pts 87 kg)';

export type FardoSale = {
  code: string;
  name: string;
  fardos: string;
  weight: string;
};

export type FardoSaleReading = { understood: FardoSale[]; unknown: string[] };

const FILLER = /^(fardos?|bags?|unidades?|de|do|da|o|a|com|peso)$/;

export function isFardoDeliveryPreset(preset: { id?: string; kind?: string; name?: string }): boolean {
  if (preset.kind && preset.kind !== 'sale') return false;
  if (String(preset.id || '') === FARDO_DELIVERY_PRESET_ID) return true;
  const name = fold(preset.name || '');
  return name.includes('entrega') && name.includes('fardo');
}

/** “pts 87 kg” ou “1 plástico seco 87 kg”. O peso é o que foi pesado naquele fardo. */
export function interpretFardoSales(text: string): FardoSaleReading {
  const pieces = String(text || '')
    .split(/\s*(?:,(?!\d)|;|\n|\s+\be\b\s+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const understood: FardoSale[] = [];
  const unknown: string[] = [];
  for (const piece of pieces) {
    const outcome = readSalePiece(piece);
    if (outcome.sale) understood.push(outcome.sale);
    else unknown.push(outcome.note || piece);
  }
  return { understood: mergeSales(understood), unknown };
}

/** Tira da venda o tipo que não tem fardo suficiente no estoque. */
export function salesInStock(
  sales: FardoSale[],
  stock: Map<string, number>,
): { available: FardoSale[]; missing: string[] } {
  const available: FardoSale[] = [];
  const missing: string[] = [];
  for (const sale of sales) {
    const have = stock.get(sale.code) || 0;
    const need = Number(sale.fardos);
    if (have >= need) {
      available.push(sale);
      continue;
    }
    missing.push(have > 0 ? `${sale.code} (há ${formatQty(have)} fardo no estoque)` : `${sale.code} (não há fardo no estoque)`);
  }
  return { available, missing };
}

export function fardoSaleClarification(understood: FardoSale[], unknown: string[]): string {
  const lines: string[] = [];
  if (understood.length) {
    lines.push('Entendi:', ...understood.map((item) => `- ${item.fardos} fardo ${item.code} (${item.name}), ${item.weight} kg`));
  }
  if (unknown.length) {
    if (lines.length) lines.push('');
    lines.push('Não entendi:', ...unknown.map((item) => `- ${item}`));
  }
  lines.push('', 'Informe um fardo que já está no estoque e o peso. Ex.: pts 87 kg');
  return lines.join('\n');
}

export function salesFromAnswer(text: string): FardoSale[] | null {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('[novo?]')) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const items: FardoSale[] = [];
    for (const row of parsed) {
      const source = row && typeof row === 'object' ? (row as { code?: string; fardos?: string; weight?: string }) : {};
      const material = findBagMaterial(String(source.code || ''));
      const fardos = Number(String(source.fardos || '').replace(',', '.'));
      const weight = Number(String(source.weight || '').replace(',', '.'));
      if (!material || !Number.isFinite(fardos) || fardos <= 0 || !Number.isFinite(weight) || weight <= 0) return null;
      items.push({ code: material.code, name: material.name, fardos: formatQty(fardos), weight: formatQty(weight) });
    }
    return items.length ? mergeSales(items) : null;
  } catch {
    return null;
  }
}

export async function answerFardoSale(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  pendingQuestionId?: string;
}): Promise<
  | { kind: 'reask'; text: string; pendingQuestionId: string }
  | { kind: 'answers'; accepted: { questionId: string; text: string; type: string }[]; summary: string; detail: string }
  | null
> {
  const question = input.questions.find((item) => String(item.export_field || '').trim() === FARDO_SALE_FIELD);
  if (!question) return null;
  const isDelivery =
    String(input.questionnaire.sourcePresetId || '') === FARDO_DELIVERY_PRESET_ID ||
    String(question.body || '').startsWith('Qual fardo');
  if (!isDelivery) return null;
  const missing = missingQuestions(input.questions, input.alreadySaved);
  if (!missing.some((item) => item.id === question.id)) return null;
  const pendingId = String(input.pendingQuestionId || '').trim();
  const answering = pendingId ? pendingId === question.id : missing[0]?.id === question.id;
  if (!answering) return null;

  const saved = String(input.alreadySaved.find((row) => row.question_id === question.id)?.answer_text || '');
  const reading = interpretFardoSales(input.inbound);
  const understood = mergeSaleCorrection(readPartial(saved), reading.understood);
  if (!reading.understood.length && !reading.unknown.length) {
    return { kind: 'reask', text: fardoSaleClarification([], ['informe o fardo e o peso. Ex.: pts 87 kg']), pendingQuestionId: question.id };
  }
  let missingStock: string[] = [];
  if (understood.length) {
    try {
      const stock = await fardoStock(Number(input.questionnaire.companyOdooId || 0));
      missingStock = salesInStock(understood, stock).missing;
    } catch (error) {
      return {
        kind: 'reask',
        text: error instanceof Error ? error.message : 'Não consegui ver o estoque de fardos.',
        pendingQuestionId: question.id,
      };
    }
  }
  const unknown = [...reading.unknown, ...missingStock];
  const available = understood.filter((item) => !missingStock.some((note) => note.startsWith(`${item.code} (`)));
  if (unknown.length) {
    const text = fardoSaleClarification(available, unknown);
    if (!available.length) return { kind: 'reask', text, pendingQuestionId: question.id };
    return {
      kind: 'answers',
      accepted: [{ questionId: question.id, text: markNewValue(JSON.stringify({ understood: available })), type: 'text' }],
      summary: text,
      detail: 'entrega de fardos parcial',
    };
  }
  const summary = available.map((item) => `${item.fardos} fardo ${item.code}, ${item.weight} kg`).join(', ');
  return {
    kind: 'answers',
    accepted: [
      {
        questionId: question.id,
        text: JSON.stringify(available.map((item) => ({ code: item.code, fardos: item.fardos, weight: item.weight }))),
        type: 'text',
      },
    ],
    summary,
    detail: 'entrega de fardos',
  };
}

export async function fardoStock(companyId: number): Promise<Map<string, number>> {
  if (!companyId) throw new Error('Empresa do Odoo obrigatória para ver o estoque de fardos');
  if (!fardoVariantRef(companyId, 'PTS')) await ensureBagMaterials(companyId);
  const codeByVariant = new Map<number, string>();
  for (const material of BAG_MATERIALS) {
    const ref = fardoVariantRef(companyId, material.code);
    if (!ref) continue;
    codeByVariant.set(ref.variantId, material.code);
  }
  const variantIds = [...codeByVariant.keys()];
  if (!variantIds.length) throw new Error('Nenhum tipo de fardo está cadastrado');
  const rows = await odooExecuteKw<Array<{ id: number; qty_available: number }>>(
    'product.product',
    'read',
    [variantIds, ['qty_available']],
    { context: { allowed_company_ids: [companyId], force_company: companyId } },
  );
  const stock = new Map<string, number>();
  for (const row of rows || []) {
    const code = codeByVariant.get(row.id);
    if (code) stock.set(code, Number(row.qty_available) || 0);
  }
  return stock;
}

function readSalePiece(piece: string): { sale?: FardoSale; note?: string } {
  const kg = /(\d+(?:[.,]\d+)?)\s*(?:kgs?|quilos?|kilos?)\b/iu.exec(piece);
  if (!kg) return { note: piece };
  const weight = Number(kg[1].replace(',', '.'));
  if (!Number.isFinite(weight) || weight <= 0) return { note: piece };
  const rest = `${piece.slice(0, kg.index)} ${piece.slice(kg.index + kg[0].length)}`.trim();
  const countMatch = /^(\d+(?:[.,]\d+)?)\s*(.*)$/u.exec(rest);
  const count = countMatch ? Number(countMatch[1].replace(',', '.')) : 1;
  const phrase = typeWords(countMatch ? countMatch[2] : rest);
  if (!Number.isFinite(count) || count <= 0 || !phrase) return { note: piece };
  const found = lookupBagType(phrase);
  if (found.ambiguous?.length) {
    return { note: `${piece} (pode ser ${found.ambiguous.map((item) => `${item.code} ${item.name}`).join(', ')})` };
  }
  if (!found.material) return { note: piece };
  return { sale: toSale(found.material, count, weight) };
}

function typeWords(value: string): string {
  return fold(value)
    .replace(/[,.;]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLER.test(word))
    .join(' ');
}

function toSale(material: BagMaterial, fardos: number, weight: number): FardoSale {
  return { code: material.code, name: material.name, fardos: formatQty(fardos), weight: formatQty(weight) };
}

function mergeSales(items: FardoSale[]): FardoSale[] {
  const byCode = new Map<string, FardoSale>();
  for (const item of items) {
    const current = byCode.get(item.code);
    if (!current) {
      byCode.set(item.code, { ...item });
      continue;
    }
    current.fardos = formatQty(Number(current.fardos) + Number(item.fardos));
    current.weight = formatQty(Number(current.weight) + Number(item.weight));
  }
  return [...byCode.values()];
}

function mergeSaleCorrection(previous: FardoSale[], next: FardoSale[]): FardoSale[] {
  const byCode = new Map<string, FardoSale>();
  for (const item of [...previous, ...next]) byCode.set(item.code, item);
  return [...byCode.values()];
}

function readPartial(text: string): FardoSale[] {
  if (!isMarkedNewValue(text)) return [];
  try {
    const parsed = JSON.parse(unmarkNewValue(text)) as { understood?: FardoSale[] };
    return Array.isArray(parsed.understood) ? parsed.understood : [];
  } catch {
    return [];
  }
}

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}
