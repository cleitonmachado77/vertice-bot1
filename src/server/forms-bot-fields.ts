import { headerFieldsFor, lineFieldsFor, type FormKind } from './forms-fields.js';

export const FORMS_BOT_LINES_FIELD = '__lines__';
/** Confirmação: mais itens ou encerrar linhas do Forms Bot. */
export const FORMS_BOT_LINES_MORE_FIELD = '__lines_more__';

export function formsBotQuestionnaireId(presetId: string): string {
  return `forms-preset:${presetId}`;
}

/** Pergunta de linhas quando o padrão já fixa o produto e só falta a quantidade. */
export function quantityOnlyLinesQuestion(product: string): string {
  return `Qtd de ${product}?`;
}

/** Produto fixado pelo padrão na pergunta de linhas (ou '' se o usuário escolhe o produto). */
export function fixedLinesProduct(question: { export_field?: string; fixed_value?: string } | undefined): string {
  if (String(question?.export_field || '').trim() !== FORMS_BOT_LINES_FIELD) return '';
  return String(question?.fixed_value || '').trim();
}

export function isFormsBotExportField(kind: FormKind, exportField: string): boolean {
  const key = String(exportField || '').trim();
  if (!key) return true;
  if (key === FORMS_BOT_LINES_FIELD || key === FORMS_BOT_LINES_MORE_FIELD) {
    return lineFieldsFor(kind).length > 0;
  }
  return (
    headerFieldsFor(kind).some((field) => field.key === key) ||
    lineFieldsFor(kind).some((field) => field.key === key)
  );
}

function fold(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .replace(/[!.,;:?“”"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * “não”, “não tem mais”, “não, só isso”, “só isso mesmo”, “nada mais” → encerra linhas.
 * Qualquer dígito ou sinal de acréscimo (“também”, “ainda”, “mais banana”) NÃO encerra.
 */
export function isLinesMoreDoneAnswer(text: string): boolean {
  const folded = fold(text);
  if (!folded || /\d/.test(folded)) return false;
  const addsMore =
    /\b(tambem|ainda|falta\w*|faltou)\b/.test(folded) ||
    /(?<!\b(?:tem|temos|tenho|nada|sem|ha)\s)\bmais\b/.test(folded);
  if (addsMore) return false;
  if (/^(nao|n|nope|negativo)\b/.test(folded)) return true;
  return (
    /^(fim|pronto|encerrar|obrigad[oa]|valeu)$/.test(folded) ||
    /\b(so isso|apenas isso|somente isso|nada mais|nao tem mais|e so|por enquanto|era so|foi so)\b/.test(
      folded,
    )
  );
}

/**
 * Mensagem com linhas E encerramento no mesmo texto:
 * “20 kg de abacate, não temos mais produtos” → true.
 */
export function mentionsNoMoreLines(text: string): boolean {
  return String(text || '')
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !/\d/.test(segment))
    .some((segment) => isLinesMoreDoneAnswer(segment));
}

/** “Mais produtos” só fecha com “não”/“só isso” ou texto com produto + quantidade. */
export function isUsableLinesMoreAnswer(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isLinesMoreDoneAnswer(raw)) return true;
  return parseQtyProductChunks(raw).length > 0;
}

const UNIT_RE = String.raw`(?:kgs?|quilos?|kilos?|g|gramas?|un|unid|unidades?|pcs?|l|lts?|litros?|cx|caixas?|sc|sacas?|ton|toneladas?|fardos?|bags?)`;
const QTY_RE = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(${UNIT_RE})?\.?(?![\p{L}\d])`, 'giu');
const UNIT_ONLY_RE = new RegExp(`^${UNIT_RE}$`, 'i');
const NOISE_WORDS =
  /^(recebi|recebemos|comprei|compramos|peguei|pegamos|foram|foi|chegou|chegaram|entrou|entraram|anota|anote|registra|registre|tem|temos|e|mais|tambem|hoje|ontem)$/i;
const SEGMENT_SPLIT_RE = /\s*(?:,|;|\n|\+|\be\b|\bmais\b)\s*/i;

function cleanProduct(raw: string): string {
  let product = String(raw || '')
    .replace(/^[\s:\-–—.]+|[\s:\-–—.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove verbos/conectores soltos nas pontas (“recebi abacate”, “abacate hoje”).
  let changed = true;
  while (changed && product) {
    changed = false;
    const words = product.split(' ');
    if (words.length && (NOISE_WORDS.test(words[0]) || /^(de|da|do|das|dos)$/i.test(words[0]))) {
      words.shift();
      changed = true;
    }
    if (words.length && NOISE_WORDS.test(words[words.length - 1])) {
      words.pop();
      changed = true;
    }
    product = words.join(' ').trim();
  }
  if (!product || UNIT_ONLY_RE.test(product)) return '';
  if (!/\p{L}{2,}/u.test(product)) return '';
  return product;
}

const EXPLICIT_UNIT_RE = new RegExp(String.raw`\d\s*${UNIT_RE}\.?(?![\p{L}\d])`, 'iu');

export function hasExplicitUnit(text: string): boolean {
  return EXPLICIT_UNIT_RE.test(String(text || ''));
}

const QUANTITY_ONLY_RE = new RegExp(String.raw`^\s*\d+(?:[.,]\d+)?\s*(?:${UNIT_RE})?\.?\s*$`, 'iu');

/** “50”, “50 kg”, “1,5kg” — só quantidade, sem produto. */
export function isQuantityOnly(text: string): boolean {
  return QUANTITY_ONLY_RE.test(String(text || ''));
}

/** “50 kg” → “50”; “1,5 kg” → “1.5”. Odoo/Forms guardam só o número (a unidade é do produto). */
export function quantityNumber(quantity: string): string {
  const match = /\d+(?:[.,]\d+)?/.exec(String(quantity || ''));
  return match ? match[0].replace(',', '.') : '';
}

function formatQuantity(amount: string, unit: string): string {
  const normalizedUnit = String(unit || 'kg').toLowerCase().replace(/\.$/, '') || 'kg';
  return `${amount} ${normalizedUnit}`;
}

/**
 * Ex.: “60 kg de abacate e 23 kg de mandioca”, “abacate 60 kg, mandioca 23 kg”,
 * “Recebi 60kg abacate” → linhas produto/qtd. Texto sem quantidade é ignorado.
 */
export function parseQtyProductChunks(
  text: string,
): Array<{ quantity: string; product: string }> {
  const out: Array<{ quantity: string; product: string }> = [];
  const segments = String(text || '')
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const hits = [...segment.matchAll(QTY_RE)].filter((hit) => hit.index != null);
    if (!hits.length) continue;
    const last = hits[hits.length - 1];
    const tail = cleanProduct(segment.slice((last.index ?? 0) + last[0].length));
    const head = cleanProduct(segment.slice(0, hits[0].index ?? 0));
    // “abacate 60 kg” (produto antes) vs “60 kg de abacate” (produto depois).
    const productFirst = !tail && Boolean(head);

    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      const start = hit.index ?? 0;
      const end = start + hit[0].length;
      const product = productFirst
        ? cleanProduct(
            segment.slice(
              index === 0 ? 0 : (hits[index - 1].index ?? 0) + hits[index - 1][0].length,
              start,
            ),
          )
        : cleanProduct(segment.slice(end, hits[index + 1]?.index ?? segment.length)) ||
          (index === 0 ? head : '');
      if (!product) continue;
      out.push({ quantity: formatQuantity(hit[1], hit[2] || ''), product });
    }
  }
  return out;
}
