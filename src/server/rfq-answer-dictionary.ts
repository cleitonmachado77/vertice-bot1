import { zonedNow } from './clock.js';
import { formatBrDate, parseOccurrenceDateRef } from './questionnaire-dates.js';
import { foldText } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import { PRODUCT_CANONICAL } from './rfq-product-catalog.js';
import { isRfqFieldKey } from './rfq-fields.js';

/** Chaves RFQ usadas na planilha / export_field. */
export type RfqFieldKey =
  | 'order_reference'
  | 'vendor'
  | 'order_deadline'
  | 'expected_arrival'
  | 'vendor_reference'
  | 'products'
  | 'quantity'
  | 'unit_price'
  | 'taxes'
  | 'payment_terms';

type FieldRule = {
  /** Sinônimos no texto da pergunta (já em foldText). */
  questionHints: RegExp;
  /** A mensagem parece falar deste campo. */
  looksLike: (text: string) => boolean;
  /** Extrai/normaliza o valor para gravar. */
  clean: (text: string) => string;
};

const QTY_UNIT = String.raw`(?:kg|kgs|kilos?|quilos?|ton(?:elada)?s?|g|gramas?|sacas?|sc|litros?|lts?|l\b|un(?:id(?:ades?)?)?|unidades?|pcs?|caixas?|cx|fardos?|bags?)`;
const QTY_VALUE = String.raw`\d+(?:[.,]\d+)?`;
const DATE =
  String.raw`(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:hoje|amanha|ontem|anteontem|depois\s+de\s+amanha|apos\s+amanha)|(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?)`;

const PAYMENT_CANONICAL: Array<{ match: RegExp; value: string }> = [
  { match: /\bpix\b/, value: 'PIX' },
  { match: /\bboleto\b/, value: 'boleto' },
  { match: /\bdinheiro\b|\bespecie\b|\besp[eé]cie\b/, value: 'dinheiro' },
  { match: /\bcart[aã]o\b|\bcredito\b|\bd[eé]bito\b/, value: 'cartão' },
  { match: /\btransfer[eê]ncia\b|\bted\b|\bdoc\b/, value: 'transferência' },
  { match: /\ba\s*prazo\b|\bprazo\b|\bparcelad/, value: 'a prazo' },
  { match: /\ba\s*vista\b|\bvista\b/, value: 'à vista' },
];

function hasQty(text: string): boolean {
  return new RegExp(`${QTY_VALUE}\\s*${QTY_UNIT}`, 'i').test(text);
}

function hasMoney(text: string): boolean {
  return /r\$|reais?/i.test(text) || /\b\d+[.,]\d{2}\b/.test(text);
}

function hasDate(text: string): boolean {
  return new RegExp(DATE, 'i').test(foldText(text));
}

function stripQtyAndMoney(text: string): string {
  return text
    .replace(new RegExp(`${QTY_VALUE}\\s*${QTY_UNIT}`, 'ig'), ' ')
    .replace(/r\$\s*/gi, ' ')
    .replace(/\b\d+[.,]\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuantity(text: string): string {
  const match = text.match(new RegExp(`(${QTY_VALUE})\\s*(${QTY_UNIT})`, 'i'));
  if (!match) return text.trim();
  const amount = match[1].replace(',', '.');
  const unit = foldText(match[2]).replace(/\.$/, '');
  if (/^ton/.test(unit)) return `${amount} ton`;
  if (unit === 'g' || unit.startsWith('grama')) return `${amount} g`;
  if (/^sac|^sc$/.test(unit)) return `${amount} sc`;
  if (/^l(t|itro)?s?$/.test(unit) || unit === 'l') return `${amount} L`;
  if (/^un|^pc/.test(unit)) return `${amount} un`;
  if (/^cx|^caixa/.test(unit)) return `${amount} cx`;
  if (/^fardo/.test(unit)) return `${amount} fardo`;
  if (/^bag/.test(unit)) return `${amount} bag`;
  return `${amount} kg`;
}

function extractProduct(text: string): string {
  const trimmed = text.trim();
  const folded = foldText(trimmed);
  for (const item of PRODUCT_CANONICAL) {
    if (item.match.test(folded)) return item.value;
  }
  const afterQty = trimmed.match(
    new RegExp(`${QTY_VALUE}\\s*${QTY_UNIT}\\s*(?:de\\s+)?(.+)$`, 'i'),
  );
  if (afterQty?.[1]) {
    let product = afterQty[1]
      .replace(/r\$\s*\d+(?:[.,]\d+)?/gi, ' ')
      .replace(/^[.,;:\-\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const productFolded = foldText(product);
    for (const item of PRODUCT_CANONICAL) {
      if (item.match.test(productFolded)) return item.value;
    }
    if (product && !new RegExp(`^${QTY_VALUE}$`).test(product)) return product;
  }
  const withoutNoise = stripQtyAndMoney(trimmed);
  return withoutNoise || trimmed;
}

function extractMoney(text: string): string {
  const withSymbol = text.match(/r\$\s*(\d+(?:[.,]\d+)?)/i);
  if (withSymbol) {
    const amount = withSymbol[1].replace('.', '').replace(',', '.');
    const normalized = amount.includes('.') ? amount : amount;
    return `R$ ${formatMoney(normalized)}`;
  }
  const plain = text.match(/\b(\d+[.,]\d{2})\b/);
  if (plain) return `R$ ${formatMoney(plain[1].replace('.', '').replace(',', '.'))}`;
  const integer = text.match(/\b(\d+)\s*reais?\b/i);
  if (integer) return `R$ ${integer[1]},00`;
  return text.trim();
}

function formatMoney(value: string): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return value.replace('.', ',');
  return num.toFixed(2).replace('.', ',');
}

function extractDate(text: string): string {
  const ref = parseOccurrenceDateRef(zonedNow().date, text);
  if (ref.explicit) return formatBrDate(ref.date);
  return text.trim();
}

function extractPayment(text: string): string {
  const folded = foldText(text);
  for (const item of PAYMENT_CANONICAL) {
    if (item.match.test(folded)) return item.value;
  }
  return text.trim();
}

function extractPersonOrVendor(text: string): string {
  let cleaned = stripQtyAndMoney(text);
  cleaned = cleaned
    .replace(new RegExp(DATE, 'ig'), ' ')
    .replace(
      /^(o\s+)?(fornecedor|vendedor|catador|nome|comprador)\s*(e\s*|foi\s*|:\s*)?/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || text.trim();
}

function extractOrderReference(text: string): string {
  const cupom = text.match(
    /\b(?:nf|nfe|cupom|pedido|ref(?:erencia)?|n[ºo°]?\.?)\s*[:#-]?\s*([a-z0-9/-]+)/i,
  );
  if (cupom?.[1]) return cupom[1].trim();
  const code = text.match(/\b([a-z]{0,3}\d{3,}[a-z0-9-]*)\b/i);
  if (code && !hasQty(code[0])) return code[1];
  return stripQtyAndMoney(text) || text.trim();
}

const RULES: Record<RfqFieldKey, FieldRule> = {
  quantity: {
    questionHints: /kg|quant|peso|quilo|tonel|volume/,
    looksLike: (text) => hasQty(text),
    clean: extractQuantity,
  },
  products: {
    questionHints: /produt|material|mercadoria|\bitem\b|metal|sucata/,
    looksLike: (text) =>
      PRODUCT_CANONICAL.some((item) => item.match.test(foldText(text))) ||
      (hasQty(text) && /de\s+\p{L}/u.test(text)),
    clean: extractProduct,
  },
  vendor: {
    questionHints: /fornec|vendedor|catador|quem\s+entreg/,
    looksLike: (text) =>
      !hasQty(text) &&
      !hasMoney(text) &&
      !hasDate(text) &&
      /[a-záàâãéêíóôõúç]{3,}/i.test(text),
    clean: extractPersonOrVendor,
  },
  vendor_reference: {
    questionHints: /comprador|quem\s+(esta|está)\s+(fazendo|compr)|responsavel|responsável/,
    looksLike: (text) =>
      !hasQty(text) &&
      !hasMoney(text) &&
      /[a-záàâãéêíóôõúç]{3,}/i.test(text),
    clean: extractPersonOrVendor,
  },
  order_reference: {
    questionHints: /referencia|referência|cupom|pedido|nf\b|nfe|nota\s*fiscal/,
    looksLike: (text) =>
      /\b(?:nf|nfe|cupom|pedido|ref)\b/i.test(text) ||
      /\b[a-z]{0,3}\d{3,}[a-z0-9-]*\b/i.test(text),
    clean: extractOrderReference,
  },
  order_deadline: {
    questionHints: /deadline|prazo|data\s+de\s+compra|compr(ou|a)|quando\s+comprou/,
    looksLike: (text) => hasDate(text),
    clean: extractDate,
  },
  expected_arrival: {
    questionHints: /chegad|entrega|previs|arrival|quando\s+(chega|vai)|fornecimento/,
    looksLike: (text) => hasDate(text),
    clean: extractDate,
  },
  unit_price: {
    questionHints: /pre[cç]o|valor\s*unit|unit\s*price|quanto\s+cust|custa/,
    looksLike: (text) => hasMoney(text) && !/tax|imposto|icms|ipi|iss/i.test(text),
    clean: extractMoney,
  },
  taxes: {
    questionHints: /taxa|tax|imposto|icms|ipi|iss/,
    looksLike: (text) =>
      hasMoney(text) || /\b(icms|ipi|iss|taxa|imposto)\b/i.test(text),
    clean: (text) => {
      const money = extractMoney(text);
      if (money.startsWith('R$')) return money;
      return text.trim();
    },
  },
  payment_terms: {
    questionHints: /pagamento|forma\s+de\s+pag|payment|pix|boleto/,
    looksLike: (text) => PAYMENT_CANONICAL.some((item) => item.match.test(foldText(text))),
    clean: extractPayment,
  },
};

const FIELD_PRIORITY: RfqFieldKey[] = [
  'quantity',
  'products',
  'unit_price',
  'taxes',
  'payment_terms',
  'order_deadline',
  'expected_arrival',
  'order_reference',
  'vendor',
  'vendor_reference',
];

export function detectRfqFieldFromQuestion(
  question: Pick<QuestionnaireQuestion, 'export_field' | 'body'>,
): RfqFieldKey | '' {
  const exportField = String(question.export_field || '').trim();
  if (exportField && isRfqFieldKey(exportField) && exportField in RULES) {
    return exportField as RfqFieldKey;
  }
  const body = foldText(question.body);
  if (!body) return '';
  for (const key of FIELD_PRIORITY) {
    if (RULES[key].questionHints.test(body)) return key;
  }
  return '';
}

export function cleanRfqAnswer(text: string, field: RfqFieldKey | ''): string {
  const raw = String(text || '').trim();
  if (!raw || !field || !(field in RULES)) return raw;
  const cleaned = RULES[field as RfqFieldKey].clean(raw).trim();
  return cleaned || raw;
}

export function messageLooksLikeField(text: string, field: RfqFieldKey | ''): boolean {
  if (!field || !(field in RULES)) return false;
  return RULES[field].looksLike(String(text || ''));
}

/** Texto de orientação para prompts do LLM. */
export function rfqSeparationPromptLines(): string[] {
  return [
    'Separe valores misturados na mesma mensagem conforme o tipo de pergunta:',
    '- quantity (kg/peso): só a quantidade (ex.: "399 kg")',
    '- products (produto/material): só o nome (ex.: "cobre"), sem kg nem preço',
    '- vendor: só o fornecedor; vendor_reference: só quem compra',
    '- order_deadline / expected_arrival: só a data respectiva',
    '- unit_price / taxes: só o valor monetário (ex.: "R$ 12,50")',
    '- payment_terms: só a forma (PIX, boleto, dinheiro, a prazo…)',
    '- order_reference: só a referência/cupom/NF',
  ];
}
