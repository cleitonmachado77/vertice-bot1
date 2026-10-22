import {
  formatAmbiguousOptions,
  isFormsCatalogField,
  listCatalogOptionsForField,
  type MatchCandidate,
} from './forms-bot-match.js';
import { FORMS_BOT_LINES_FIELD } from './forms-bot-fields.js';
import { headerFieldsFor, isFormKind, lineFieldsFor, type FormField, type FormKind } from './forms-fields.js';
import { foldText } from './questionnaire-rules.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

const LIST_ASK =
  /(lista|opcoes|opcao|quais sao|quais as|me passa|me manda|mostra|mostrar|tem quais|disponiveis|cadastrad)/;
const ENTITY_ASK =
  /(fornecedor|fornecedores|cliente|clientes|produto|produtos|parceiro|parceiros|catador|catadores)/;
const MAX_PROMPT_ITEMS = 40;
const MAX_REPLY_ITEMS = 60;

const VENDOR_FIELD: FormField = { key: 'vendor', label: 'Fornecedor', required: true };
const CUSTOMER_FIELD: FormField = { key: 'customer', label: 'Cliente', required: true };
const PRODUCT_FIELD: FormField = { key: 'product', label: 'Produto', required: true };

function fieldByKey(kind: FormKind, key: string): FormField | undefined {
  return [...headerFieldsFor(kind), ...lineFieldsFor(kind)].find((field) => field.key === key);
}

function resolveFormKind(questionnaire: Questionnaire): FormKind | '' {
  const raw = String(questionnaire.formKind || '').trim();
  if (isFormKind(raw)) return raw;
  const keys = new Set(
    questionnaire.questions.map((item) => String(item.export_field || '').trim()).filter(Boolean),
  );
  if (keys.has('vendor')) return 'purchase';
  if (keys.has('customer')) return 'sale';
  if (keys.has('name') || keys.has('sales_price')) return 'product';
  if (questionnaire.questions.some((item) => /fornec/i.test(item.body))) return 'purchase';
  if (questionnaire.questions.some((item) => /cliente/i.test(item.body))) return 'sale';
  return '';
}

function catalogFieldsInQuestionnaire(
  kind: FormKind,
  questions: QuestionnaireQuestion[],
): FormField[] {
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    const key = String(question.export_field || '').trim();
    if (!key) continue;
    if (key === FORMS_BOT_LINES_FIELD) {
      const product = fieldByKey(kind, 'product');
      if (product && isFormsCatalogField(product) && !seen.has(product.key)) {
        seen.add(product.key);
        out.push(product);
      }
      continue;
    }
    const field = fieldByKey(kind, key);
    if (!field || !isFormsCatalogField(field) || seen.has(field.key)) continue;
    seen.add(field.key);
    out.push(field);
  }
  return out;
}

function aliasesForField(field: FormField): string[] {
  const base = [field.key, field.label];
  if (field.key === 'vendor') return [...base, 'fornecedor', 'fornecedores', 'catador', 'vendedor'];
  if (field.key === 'customer') return [...base, 'cliente', 'clientes'];
  if (field.key === 'product') return [...base, 'produto', 'produtos', 'item', 'itens'];
  return base;
}

/** Pedido de lista/opções (não é resposta de preenchimento). */
export function isFormsCatalogListAsk(inbound: string): boolean {
  const text = foldText(inbound);
  if (!text || text.length < 4) return false;
  if (!ENTITY_ASK.test(text)) return false;
  return (
    LIST_ASK.test(text) ||
    /\bquais?\b/.test(text) ||
    /\bopcoes?\b/.test(text) ||
    /\blista\b/.test(text)
  );
}

/** Detecta pedido de lista/opções de um campo de catálogo Forms. */
export function detectCatalogListRequest(
  inbound: string,
  fields: FormField[],
): FormField | undefined {
  if (!isFormsCatalogListAsk(inbound) && !fields.length) return undefined;
  const text = foldText(inbound);
  if (!text || text.length < 4) return undefined;
  const asksList =
    LIST_ASK.test(text) ||
    (/\bquais?\b/.test(text) && ENTITY_ASK.test(text)) ||
    isFormsCatalogListAsk(inbound);
  if (!asksList) return undefined;

  const pool = fields.length
    ? fields
    : [VENDOR_FIELD, CUSTOMER_FIELD, PRODUCT_FIELD];

  for (const field of pool) {
    const aliases = aliasesForField(field).map((item) => foldText(item)).filter(Boolean);
    if (aliases.some((alias) => text.includes(alias))) return field;
  }
  if (fields.length === 1) return fields[0];
  return undefined;
}

function formatListReply(field: FormField, options: MatchCandidate[]): string {
  if (!options.length) {
    return `Ainda não há ${field.label.toLowerCase()} cadastrado(a) nesta empresa. Pode digitar o nome que eu anoto.`;
  }
  const slice = options.slice(0, MAX_REPLY_ITEMS);
  const body = formatAmbiguousOptions(slice);
  const extra =
    options.length > MAX_REPLY_ITEMS
      ? `\n… e mais ${options.length - MAX_REPLY_ITEMS}. Pode digitar o nome ou o número.`
      : '\nPode responder com o nome ou o número da lista.';
  return `Lista de ${field.label.toLowerCase()}:\n${body}${extra}`;
}

/** Atalho determinístico: usuário pediu a lista → devolve opções do catálogo. */
export async function tryFormsCatalogListReply(input: {
  inbound: string;
  questionnaire: Questionnaire;
}): Promise<string | null> {
  if (!isFormsCatalogListAsk(input.inbound)) return null;
  const kind = resolveFormKind(input.questionnaire);
  const fields = kind
    ? catalogFieldsInQuestionnaire(kind, input.questionnaire.questions)
    : [];
  const field =
    detectCatalogListRequest(input.inbound, fields) ||
    (ENTITY_ASK.test(foldText(input.inbound)) && /fornec|catador|vendedor/.test(foldText(input.inbound))
      ? VENDOR_FIELD
      : undefined);
  if (!field) return null;
  const kindForLookup: FormKind = kind || (field.key === 'customer' ? 'sale' : 'purchase');
  const companyId = String(input.questionnaire.companyOdooId || '').trim() || '1';
  const options = await listCatalogOptionsForField(kindForLookup, field.key, companyId);
  return formatListReply(field, options);
}

/** Bloco de contexto para o prompt do agente (nunca inventar “sem acesso”). */
export async function buildFormsCatalogBrief(questionnaire: Questionnaire): Promise<string> {
  const kind = resolveFormKind(questionnaire);
  if (!kind) return '';
  const fields = catalogFieldsInQuestionnaire(kind, questionnaire.questions);
  if (!fields.length) return '';
  const companyId = String(questionnaire.companyOdooId || '').trim() || '1';
  const lines: string[] = [];
  for (const field of fields) {
    const options = await listCatalogOptionsForField(kind, field.key, companyId);
    if (!options.length) {
      lines.push(`- ${field.label} (${field.key}): (vazio — aceite nome digitado)`);
      continue;
    }
    const names = options.slice(0, MAX_PROMPT_ITEMS).map((item) => item.label);
    const more = options.length > MAX_PROMPT_ITEMS ? ` …(+${options.length - MAX_PROMPT_ITEMS})` : '';
    lines.push(`- ${field.label} (${field.key}): ${names.join('; ')}${more}`);
  }
  return [
    'Catálogo Forms deste questionário (fonte oficial — USE ao listar opções):',
    ...lines,
    'Se pedirem a lista/opções, responda com itens numerados desse catálogo e continue pedindo a resposta.',
    'NUNCA diga que não tem acesso à lista de fornecedores, clientes, produtos ou opções de catálogo.',
    'Pedido de lista NÃO é resposta: related:true, answers:[], complete:false.',
  ].join('\n');
}
