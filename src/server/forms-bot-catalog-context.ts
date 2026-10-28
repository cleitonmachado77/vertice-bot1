import {
  formatAmbiguousOptions,
  isFormsCatalogField,
  listCatalogOptionsForField,
  resolveCatalogValue,
  type MatchCandidate,
} from './forms-bot-match.js';
import { FORMS_BOT_LINES_FIELD, fixedLinesProduct, isMarkedNewValue } from './forms-bot-fields.js';
import { headerFieldsFor, isFormKind, lineFieldsFor, type FormField, type FormKind } from './forms-fields.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import { foldText } from './questionnaire-rules.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

const LIST_ASK =
  /(lista|opcoes|opcao|quais sao|quais as|quais os|quais as|me passa|me manda|mostra|mostrar|tem quais|disponiveis|cadastrad)/;
const ENTITY_ASK =
  /(fornecedor|fornecedores|cliente|clientes|produto|produtos|parceiro|parceiros|catador|catadores)/;
const MORE_ASK = /^(mais|ver mais|outras|outros|proxima|proximo|continuar|seguintes?)$/;
const BACK_ASK = /^(voltar|inicio|comeco|anterior)$/;

/** Itens por página na lista numerada do WhatsApp. */
export const CATALOG_PAGE_SIZE = 10;
const MAX_PROMPT_ITEMS = 40;

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
      // Produto fixado no padrão (“Qtd de ABACATE?”): não há o que escolher no catálogo.
      if (fixedLinesProduct(question)) continue;
      // Fabricação: “PET 120 kg, papelão 300 kg” digitado; a lista de todos os produtos atrapalharia.
      if (kind === 'production') continue;
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
  if (isCatalogMoreAsk(text) || isCatalogBackAsk(text)) return true;
  if (!ENTITY_ASK.test(text)) return false;
  return (
    LIST_ASK.test(text) ||
    /\bquais?\b/.test(text) ||
    /\bopcoes?\b/.test(text) ||
    /\blista\b/.test(text)
  );
}

export function isCatalogMoreAsk(inbound: string): boolean {
  return MORE_ASK.test(foldText(inbound));
}

export function isCatalogBackAsk(inbound: string): boolean {
  return BACK_ASK.test(foldText(inbound));
}

/** Detecta pedido de lista/opções de um campo de catálogo Forms. */
export function detectCatalogListRequest(
  inbound: string,
  fields: FormField[],
): FormField | undefined {
  if (!isFormsCatalogListAsk(inbound) && !fields.length) return undefined;
  const text = foldText(inbound);
  if (!text || text.length < 4) return undefined;
  if (isCatalogMoreAsk(text) || isCatalogBackAsk(text)) return undefined;
  const asksList =
    LIST_ASK.test(text) ||
    (/\bquais?\b/.test(text) && ENTITY_ASK.test(text)) ||
    isFormsCatalogListAsk(inbound);
  if (!asksList) return undefined;

  const pool = fields.length ? fields : [VENDOR_FIELD, CUSTOMER_FIELD, PRODUCT_FIELD];

  for (const field of pool) {
    const aliases = aliasesForField(field).map((item) => foldText(item)).filter(Boolean);
    if (aliases.some((alias) => text.includes(alias))) return field;
  }
  if (fields.length === 1) return fields[0];
  return undefined;
}

/**
 * Lista numerada com numeração global contínua (1…N) e página de {@link CATALOG_PAGE_SIZE}.
 * Assim “15” resolve o 15º item mesmo após “mais”.
 */
export function formatCatalogListPage(
  field: FormField,
  options: MatchCandidate[],
  offset = 0,
  pageSize = CATALOG_PAGE_SIZE,
): string {
  if (!options.length) {
    return `Ainda não há ${field.label.toLowerCase()} cadastrado(a) nesta empresa. Pode digitar o nome que eu anoto.`;
  }
  const start = Math.min(Math.max(0, offset), Math.max(0, options.length - 1));
  const slice = options.slice(start, start + pageSize);
  if (!slice.length) {
    return formatCatalogListPage(field, options, 0, pageSize);
  }
  const end = start + slice.length;
  const lines = slice.map((item, index) => `${start + index + 1}) ${item.label}`);
  const parts = [`${field.label} — escolha o número:`, ...lines];
  if (end < options.length) {
    const nextEnd = Math.min(end + pageSize, options.length);
    parts.push(`Digite *mais* para ver ${end + 1}–${nextEnd} (total ${options.length}).`);
  } else if (start > 0) {
    parts.push(`Fim da lista (${options.length}). Digite *voltar* para o início, ou o nome.`);
  } else {
    parts.push('Responda com o número ou o nome.');
  }
  return parts.join('\n');
}

function formatListReply(field: FormField, options: MatchCandidate[], offset = 0): string {
  return formatCatalogListPage(field, options, offset);
}

type CatalogListCursor = { fieldKey: string; offset: number };

/** Isola o bloco da lista (ignora “Depois: …Mais produtos?” do convite). */
function catalogListBlock(text: string): string {
  const raw = String(text || '');
  return raw.split(/\n\s*Depois:|\n\s*Pode responder/i)[0] || raw;
}

/**
 * Detecta campo + offset da última lista numerada.
 * Usa o cabeçalho “Fornecedor — escolha o número” — não a palavra “produtos” do rodapé.
 */
export function parseCatalogListCursor(text: string): CatalogListCursor | null {
  const listBlock = catalogListBlock(text);
  if (!/\n\s*\d+\)/.test(listBlock)) return null;
  const folded = foldText(listBlock);
  const looksLikeList =
    /escolha o numero|responda com o numero|digite \*mais\*|digite mais/.test(folded) ||
    /^(fornecedor|cliente|produto)\b/.test(folded.trim()) ||
    /\n(fornecedor|cliente|produto)\s*[—\-:]/.test(`\n${folded}`);
  if (!looksLikeList) return null;

  const header =
    /(?:^|\n)(fornecedor|cliente|produto)\s*[—\-:]\s*escolha o numero/.exec(folded) ||
    /(?:^|\n)(fornecedor|cliente|produto)\s*:/.exec(folded);
  let fieldKey = 'vendor';
  if (header) {
    fieldKey =
      header[1] === 'cliente' ? 'customer' : header[1] === 'produto' ? 'product' : 'vendor';
  } else if (/\bfornecedor\b/.test(folded)) {
    fieldKey = 'vendor';
  } else if (/\bcliente\b/.test(folded)) {
    fieldKey = 'customer';
  } else if (/\bproduto\b/.test(folded)) {
    fieldKey = 'product';
  }

  const firstNum = Number(/^\s*(\d+)\)/m.exec(listBlock)?.[1] || 0);
  const offset = firstNum >= 1 ? firstNum - 1 : 0;
  return { fieldKey, offset };
}

/** "3" ou "é o fornecedor 3" → índice. */
export function extractCatalogIndexInbound(inbound: string): string | null {
  const raw = String(inbound || '').trim();
  if (/^\d{1,3}$/.test(raw)) return raw;
  const folded = foldText(raw);
  const match = folded.match(
    /\b(?:fornecedor|cliente|produto|opcao|numero)\s*(\d{1,3})\b|\b(\d{1,3})\s*$/,
  );
  if (!match) return null;
  if (
    !/(fornecedor|cliente|produto|opcao|confirm|ja |escolh)/.test(folded) &&
    !/^\d{1,3}$/.test(raw)
  ) {
    return null;
  }
  return match[1] || match[2] || null;
}

function firstPendingCatalogField(
  kind: FormKind,
  questionnaire: Questionnaire,
  alreadySaved: CycleAnswer[] = [],
): { fieldKey: string; questionId: string } | null {
  const fields = catalogFieldsInQuestionnaire(kind, questionnaire.questions);
  for (const field of fields) {
    const question = questionnaire.questions.find(
      (item) => String(item.export_field || '').trim() === field.key,
    );
    if (!question) continue;
    const saved = alreadySaved.find((row) => row.question_id === question.id);
    const text = String(saved?.answer_text || '').trim();
    if (text && !isMarkedNewValue(text)) continue;
    return { fieldKey: field.key, questionId: question.id };
  }
  return null;
}

function isCatalogFieldPending(
  questionnaire: Questionnaire,
  fieldKey: string,
  alreadySaved: CycleAnswer[],
): boolean {
  const question = questionnaire.questions.find(
    (item) => String(item.export_field || '').trim() === fieldKey,
  );
  if (!question) return false;
  const saved = alreadySaved.find((row) => row.question_id === question.id);
  const text = String(saved?.answer_text || '').trim();
  return !text || isMarkedNewValue(text);
}

function lastCatalogListOutbound(
  history: { direction: string; text: string }[],
): { cursor: CatalogListCursor; text: string } | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.direction !== 'OUTBOUND') continue;
    const cursor = parseCatalogListCursor(item.text || '');
    if (cursor) return { cursor, text: item.text || '' };
  }
  return null;
}

function lastOutboundText(history: { direction: string; text: string }[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].direction === 'OUTBOUND') return history[index].text || '';
  }
  return '';
}

/** Lê "1) Nome" do texto da lista enviada (fonte da verdade do que o usuário viu). */
export function optionsFromCatalogOutbound(text: string): Map<number, string> {
  const block = catalogListBlock(text);
  const map = new Map<number, string>();
  for (const line of block.split('\n')) {
    const match = /^\s*(\d{1,3})\)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const label = String(match[2] || '').trim();
    if (!label || /digite|responda|escolha|total/i.test(label)) continue;
    map.set(Number(match[1]), label);
  }
  return map;
}

/** Atalho determinístico: usuário pediu a lista → devolve opções do catálogo. */
export async function tryFormsCatalogListReply(input: {
  inbound: string;
  questionnaire: Questionnaire;
  history?: { direction: string; text: string }[];
}): Promise<string | null> {
  const folded = foldText(input.inbound);
  const kind = resolveFormKind(input.questionnaire);
  const companyId = String(input.questionnaire.companyOdooId || '').trim() || '1';
  const fields = kind
    ? catalogFieldsInQuestionnaire(kind, input.questionnaire.questions)
    : [];

  const moreOrBack = isCatalogMoreAsk(folded) || isCatalogBackAsk(folded);
  if (moreOrBack) {
    const listed = lastCatalogListOutbound(input.history || []);
    if (!listed) return null;
    const field =
      fields.find((item) => item.key === listed.cursor.fieldKey) ||
      (listed.cursor.fieldKey === 'customer'
        ? CUSTOMER_FIELD
        : listed.cursor.fieldKey === 'product'
          ? PRODUCT_FIELD
          : VENDOR_FIELD);
    const kindForLookup: FormKind = kind || (field.key === 'customer' ? 'sale' : 'purchase');
    const options = await listCatalogOptionsForField(kindForLookup, field.key, companyId);
    const nextOffset = isCatalogBackAsk(folded)
      ? 0
      : listed.cursor.offset + CATALOG_PAGE_SIZE;
    if (isCatalogMoreAsk(folded) && nextOffset >= options.length) {
      return formatCatalogListPage(field, options, Math.max(0, options.length - CATALOG_PAGE_SIZE));
    }
    return formatCatalogListPage(field, options, nextOffset);
  }

  if (!isFormsCatalogListAsk(input.inbound)) return null;
  const field =
    detectCatalogListRequest(input.inbound, fields) ||
    (ENTITY_ASK.test(folded) && /fornec|catador|vendedor/.test(folded)
      ? VENDOR_FIELD
      : undefined);
  if (!field) return null;
  const kindForLookup: FormKind = kind || (field.key === 'customer' ? 'sale' : 'purchase');
  const options = await listCatalogOptionsForField(kindForLookup, field.key, companyId);
  return formatListReply(field, options, 0);
}

/**
 * Resposta "3" / "fornecedor 3" após lista numerada → grava só o campo de catálogo.
 * Prioriza o rótulo exatamente como enviado no WhatsApp (não depende de reconsultar o DB).
 */
function isCatalogExportField(kind: FormKind, exportField: string): boolean {
  const key = String(exportField || '').trim();
  if (!key || key === FORMS_BOT_LINES_FIELD) return false;
  const field = fieldByKey(kind, key);
  return Boolean(field && isFormsCatalogField(field));
}

export async function tryResolveCatalogIndexAnswer(input: {
  inbound: string;
  questionnaire: Questionnaire;
  history: { direction: string; text: string }[];
  alreadySaved?: CycleAnswer[];
  /** Pergunta que o bot acabou de fazer — prevalece sobre o histórico. */
  pendingQuestionId?: string;
}): Promise<{ questionId: string; value: string; fieldKey: string } | null> {
  const indexRaw = extractCatalogIndexInbound(input.inbound);
  if (!indexRaw) return null;
  const kind = resolveFormKind(input.questionnaire);
  if (!kind) return null;

  const pendingQuestion = input.pendingQuestionId
    ? input.questionnaire.questions.find((item) => item.id === input.pendingQuestionId)
    : undefined;
  const askedField = String(pendingQuestion?.export_field || '').trim();

  const listed = lastCatalogListOutbound(input.history);
  const pending = firstPendingCatalogField(
    kind,
    input.questionnaire,
    input.alreadySaved || [],
  );
  const listedFieldPending = Boolean(
    listed &&
      isCatalogFieldPending(input.questionnaire, listed.cursor.fieldKey, input.alreadySaved || []),
  );
  // A última mensagem do bot é o que o usuário viu: se ela é a lista de um campo ainda
  // sem resposta, o número se refere a ela, mesmo que pending_question_id diga outra coisa.
  const listedIsLatest = Boolean(listed && listed.text === lastOutboundText(input.history));
  const listedWins = listedFieldPending && listedIsLatest;
  if (pendingQuestion && !isCatalogExportField(kind, askedField) && !listedWins) return null;

  // Lista antiga no histórico só vale se for a pergunta que estamos esperando.
  const listedUsable =
    listedWins || (listedFieldPending && (!askedField || listed?.cursor.fieldKey === askedField));
  const fieldKey =
    (listedWins ? listed?.cursor.fieldKey : '') ||
    (askedField && isCatalogExportField(kind, askedField) ? askedField : '') ||
    (listedUsable ? listed?.cursor.fieldKey : '') ||
    pending?.fieldKey;
  if (!fieldKey) return null;

  const question = input.questionnaire.questions.find(
    (item) => String(item.export_field || '').trim() === fieldKey,
  );
  if (!question) return null;

  const index = Number(indexRaw);
  if (listedUsable && listed?.text) {
    const fromMessage = optionsFromCatalogOutbound(listed.text).get(index);
    if (fromMessage) {
      return { questionId: question.id, value: fromMessage, fieldKey };
    }
  }

  const companyId = String(input.questionnaire.companyOdooId || '').trim() || '1';
  const resolved = await resolveCatalogValue({
    kind,
    fieldKey,
    raw: indexRaw,
    companyOdooId: companyId,
  });
  if (!resolved.matched || !resolved.value) return null;
  return { questionId: question.id, value: resolved.value, fieldKey };
}

/** True quando a mensagem é só escolha numérica de catálogo pendente. */
export function shouldForceCatalogIndexCapture(
  inbound: string,
  questionnaire: Questionnaire,
  alreadySaved: CycleAnswer[] = [],
  pendingQuestionId = '',
): boolean {
  if (!extractCatalogIndexInbound(inbound)) return false;
  const kind = resolveFormKind(questionnaire);
  if (!kind) return false;
  if (pendingQuestionId) {
    const asked = questionnaire.questions.find((item) => item.id === pendingQuestionId);
    const field = String(asked?.export_field || '').trim();
    if (asked && !isCatalogExportField(kind, field)) return false;
  }
  return Boolean(firstPendingCatalogField(kind, questionnaire, alreadySaved));
}

/**
 * Primeira mensagem / retomada: lista numerada do 1º campo de catálogo pendente,
 * sem numerar as perguntas (evita conflito 1) pergunta vs 1) opção).
 */
export async function buildFormsBotGuidedPrompt(input: {
  questionnaire: Questionnaire;
  /** Se informado, usa só estas perguntas (faltantes). */
  questions?: QuestionnaireQuestion[];
}): Promise<string> {
  const questions = input.questions?.length
    ? input.questions
    : input.questionnaire.questions;
  if (!questions.length) return '';

  const kind = resolveFormKind(input.questionnaire);
  const companyId = String(input.questionnaire.companyOdooId || '').trim() || '1';
  const catalogFields = kind ? catalogFieldsInQuestionnaire(kind, questions) : [];
  const firstCatalog = catalogFields[0];

  if (firstCatalog && kind) {
    const options = await listCatalogOptionsForField(kind, firstCatalog.key, companyId);
    const listBlock = formatCatalogListPage(firstCatalog, options, 0);
    const rest = questions.filter(
      (item) =>
        String(item.export_field || '').trim() !== firstCatalog.key &&
        // linhas usam product no catálogo embutido só se for a 1ª pergunta de catálogo
        !(firstCatalog.key === 'product' && String(item.export_field || '').trim() === FORMS_BOT_LINES_FIELD),
    );
    const restHint = rest.length
      ? `\n\nDepois: ${rest.map((item) => item.body.replace(/\?$/, '')).join('; ')}.`
      : '';
    return `${listBlock}${restHint}`;
  }

  // Sem numerar perguntas: “1) Qtd…” confundiria com uma resposta “1”.
  const [first, ...rest] = questions;
  const restHint = rest.length
    ? `\n\nDepois: ${rest.map((item) => item.body.replace(/\?$/, '')).join('; ')}.`
    : '';
  return `${first.body}${restHint}`;
}

/** Convite completo (saudação + lista guiada). */
export async function buildFormsBotGuidedInvite(input: {
  greeting: string;
  questionnaire: Questionnaire;
}): Promise<string> {
  const body = await buildFormsBotGuidedPrompt({ questionnaire: input.questionnaire });
  return [input.greeting, '', body, '', 'Pode responder por texto, áudio, imagem ou vídeo.']
    .filter((part, index, all) => part !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    'Se pedirem a lista/opções, responda com itens numerados desse catálogo (páginas de 10; “mais” / “voltar”).',
    'NUNCA diga que não tem acesso à lista de fornecedores, clientes, produtos ou opções de catálogo.',
    'Pedido de lista NÃO é resposta: related:true, answers:[], complete:false.',
    'Não numere as perguntas do questionário com 1) 2) 3) no mesmo bloco da lista de opções — a numeração é só das opções.',
  ].join('\n');
}

export { formatAmbiguousOptions };
