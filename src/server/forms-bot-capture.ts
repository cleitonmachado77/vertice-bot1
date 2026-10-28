import { isFormsBotQuestionnaire } from './forms-bot-agenda.js';
import {
  buildFormsBotGuidedPrompt,
  buildFormsCatalogBrief,
  isFormsCatalogListAsk,
  parseCatalogListCursor,
  shouldForceCatalogIndexCapture,
  tryFormsCatalogListReply,
  tryResolveCatalogIndexAnswer,
} from './forms-bot-catalog-context.js';
import {
  FORMS_BOT_LINES_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  fixedLinesProduct,
  hasExplicitUnit,
  isConfirmCorrectionAnswer,
  isConfirmYesAnswer,
  isLinesMoreDoneAnswer,
  isMarkedNewValue,
  isQuantityOnly,
  mentionsNoMoreLines,
  parseQtyProductChunks,
  unmarkNewValue,
} from './forms-bot-fields.js';
import { listCatalogOptionsForField, unknownLineProducts } from './forms-bot-match.js';
import { isFormKind } from './forms-fields.js';
import {
  CONFIRM_CORRECTION_REPLY,
  confirmPromptText,
  describeLinesAnswer,
  isConfirmQuestion,
  tryConfirmCapture,
  tryLateLinesCapture,
} from './forms-bot-closing.js';
import type { MediaUnderstanding } from './media-understand.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import type { ExtractedAnswer } from './questionnaire-extraction.js';
import { defaultQuestionnaireReply } from './questionnaire-replies.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

export { describeLinesAnswer };
export { buildFormsCatalogBrief as catalogContextBrief };
export { isFormsCatalogListAsk as isCatalogListAsk };
export { tryFormsCatalogListReply as tryCatalogListReply };

export type FormsBotCapture =
  | { kind: 'list'; text: string; pendingQuestionId: string }
  | { kind: 'reask'; text: string; pendingQuestionId: string }
  | { kind: 'answers'; accepted: ExtractedAnswer[]; summary: string; detail: string };

export function promptQuestionId(missing: QuestionnaireQuestion[]): string {
  return missing[0]?.id || '';
}

/** Captura linhas Forms (vários “N kg de produto”) sem LLM. */
export function tryFormsLinesCapture(input: {
  inbound: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  pendingQuestionId?: string;
}): ExtractedAnswer[] | null {
  const missing = missingQuestions(input.questions, input.alreadySaved);
  const linesQ = missing.find(
    (item) => String(item.export_field || '').trim() === FORMS_BOT_LINES_FIELD,
  );
  const moreQ = missing.find(
    (item) => String(item.export_field || '').trim() === FORMS_BOT_LINES_MORE_FIELD,
  );
  if (!linesQ && !moreQ) return null;

  const pendingId = String(input.pendingQuestionId || '').trim();
  const pending = pendingId ? input.questions.find((item) => item.id === pendingId) : undefined;
  const pendingField = String(pending?.export_field || '').trim();
  const askingOtherField =
    Boolean(pending) &&
    pendingField !== FORMS_BOT_LINES_FIELD &&
    pendingField !== FORMS_BOT_LINES_MORE_FIELD;

  const chunks = parseQtyProductChunks(input.inbound);
  // Perguntando outro campo (ex.: fornecedor), só vira linha o que é claramente linha:
  // unidade explícita ou vários itens — “3 Irmãos” continua sendo nome.
  if (askingOtherField && !(chunks.length > 1 || hasExplicitUnit(input.inbound))) return null;
  if (chunks.length) {
    const accepted: ExtractedAnswer[] = [];
    if (linesQ) {
      accepted.push({
        questionId: linesQ.id,
        text: JSON.stringify(
          chunks.map((chunk) => ({ product: chunk.product, quantity: chunk.quantity })),
        ),
        type: 'text',
      });
    } else if (moreQ) {
      accepted.push({
        questionId: moreQ.id,
        text: chunks.map((chunk) => `${chunk.quantity} de ${chunk.product}`).join('; '),
        type: 'text',
      });
    }
    if (moreQ && linesQ && mentionsNoMoreLines(input.inbound)) {
      accepted.push({ questionId: moreQ.id, text: 'não', type: 'text' });
    }
    return accepted;
  }

  // “Qtd de ABACATE?” → “50”: produto vem do padrão, só a quantidade é do usuário.
  const fixedProduct = fixedLinesProduct(linesQ);
  const linesAsked = pending ? pendingField === FORMS_BOT_LINES_FIELD : missing[0]?.id === linesQ?.id;
  if (linesQ && fixedProduct && linesAsked && isQuantityOnly(input.inbound)) {
    return [
      {
        questionId: linesQ.id,
        text: JSON.stringify([{ product: fixedProduct, quantity: input.inbound.trim() }]),
        type: 'text',
      },
    ];
  }

  if (moreQ && !linesQ && isLinesMoreDoneAnswer(input.inbound)) {
    if (pendingId && pendingId !== moreQ.id) return null;
    return [{ questionId: moreQ.id, text: 'não', type: 'text' }];
  }
  return null;
}

/** Faltantes: catálogo guiado no Forms Bot, lista numerada nos demais. */
export async function missingPromptFor(
  questionnaire: Questionnaire,
  missing: QuestionnaireQuestion[],
  answers: CycleAnswer[] = [],
): Promise<string> {
  if (!missing.length) return '';
  if (isFormsBotQuestionnaire(questionnaire)) {
    const pendingNew = markedAnswerFor(missing[0], answers);
    if (pendingNew) return newValuePrompt(questionnaire, missing[0], pendingNew);
    if (isConfirmQuestion(missing[0])) return confirmPromptText(questionnaire.questions, answers);
    const guided = await buildFormsBotGuidedPrompt({ questionnaire, questions: missing });
    if (guided.trim()) return guided;
  }
  return missing.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
}

function markedAnswerFor(question: QuestionnaireQuestion | undefined, answers: CycleAnswer[]): string {
  if (!question) return '';
  const text = String(answers.find((row) => row.question_id === question.id)?.answer_text || '');
  return isMarkedNewValue(text) ? unmarkNewValue(text) : '';
}

function isLinesField(question: QuestionnaireQuestion): boolean {
  const field = String(question.export_field || '').trim();
  return field === FORMS_BOT_LINES_FIELD || field === FORMS_BOT_LINES_MORE_FIELD;
}

function partnerLabel(question: QuestionnaireQuestion): string {
  return String(question.export_field || '').trim() === 'customer' ? 'cliente' : 'fornecedor';
}

const RESEND_LINES_HINT = 'mande produto e quantidade de novo (ex.: 50 kg de abacate)';

/** “Não encontrei X… é novo?” — fornecedor/cliente com a lista; produtos com o que faltou no cadastro. */
async function newValuePrompt(
  questionnaire: Questionnaire,
  question: QuestionnaireQuestion,
  value: string,
): Promise<string> {
  if (isLinesField(question)) {
    const kind = String(questionnaire.formKind || '').trim();
    const unknown = isFormKind(kind)
      ? await unknownLineProducts({
          kind,
          field: String(question.export_field || '').trim(),
          text: value,
          companyOdooId: String(questionnaire.companyOdooId || '').trim() || '1',
        })
      : [];
    const names = unknown.length ? unknown.map((name) => `“${name}”`).join(', ') : `“${describeLinesAnswer(value)}”`;
    return [
      `Não encontrei no cadastro de produtos: ${names}.`,
      `É produto novo? Responda *sim* para cadastrar, ou ${RESEND_LINES_HINT}.`,
    ].join('\n');
  }
  const label = partnerLabel(question);
  const list = await buildFormsBotGuidedPrompt({ questionnaire, questions: [question] });
  return [
    `Não encontrei “${value}” entre os ${label === 'cliente' ? 'clientes' : 'fornecedores'} cadastrados.`,
    `Se for um ${label} novo, responda *sim* para cadastrar. Se não, escolha na lista:`,
    '',
    list,
  ].join('\n');
}

/** Resposta ao “é novo?”: “sim” grava sem a marca; “não/corrigir” pede de novo. */
async function tryNewValueConfirm(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  pendingQuestionId: string;
}): Promise<FormsBotCapture | null> {
  const target = missingQuestions(input.questions, input.alreadySaved)[0];
  const value = markedAnswerFor(target, input.alreadySaved);
  if (!target || !value) return null;
  if (input.pendingQuestionId && input.pendingQuestionId !== target.id) return null;
  if (isConfirmYesAnswer(input.inbound)) {
    return {
      kind: 'answers',
      accepted: [{ questionId: target.id, text: value, type: 'text', confirmedNew: true }],
      summary: `${describeLinesAnswer(value)} (cadastro novo)`,
      detail: 'valor novo confirmado',
    };
  }
  if (isConfirmCorrectionAnswer(input.inbound)) {
    const text = isLinesField(target)
      ? `Certo! Então ${RESEND_LINES_HINT}.`
      : [
          `Certo! Escolha o ${partnerLabel(target)} na lista ou digite o nome:`,
          '',
          await buildFormsBotGuidedPrompt({ questionnaire: input.questionnaire, questions: [target] }),
        ].join('\n');
    return { kind: 'reask', text, pendingQuestionId: target.id };
  }
  return null;
}

/** Resumo do que foi gravado, sem os valores que ainda aguardam “é novo?”. */
export function acceptedSummary(accepted: ExtractedAnswer[], skipQuestionIds: string[]): string {
  const skip = new Set(skipQuestionIds);
  return accepted
    .filter((item) => !skip.has(item.questionId) && !isLinesMoreDoneAnswer(item.text))
    .map((item) => describeLinesAnswer(item.text))
    .filter(Boolean)
    .join('; ');
}

/** defaultQuestionnaireReply, mas sem numerar perguntas Forms (conflita com “1) opção”). */
export async function formsAwareMissingReply(input: {
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  answers: CycleAnswer[];
  missing: QuestionnaireQuestion[];
  media: MediaUnderstanding;
  contactName: string;
}): Promise<string> {
  const base = defaultQuestionnaireReply(
    input.questions,
    input.answers,
    input.missing,
    false,
    input.media,
    input.contactName,
  );
  if (!isFormsBotQuestionnaire(input.questionnaire) || !input.missing.length) return base;
  const prompt = await missingPromptFor(input.questionnaire, input.missing, input.answers);
  const intro = base.split('\n')[0] || 'Recebi.';
  return [intro, prompt].filter(Boolean).join('\n');
}

/** Atalhos determinísticos do Forms Bot; null se a mensagem não for desse fluxo. */
export async function tryFormsBotCapture(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  history: { direction: string; text: string }[];
  pendingQuestionId?: string;
}): Promise<FormsBotCapture | null> {
  if (!isFormsBotQuestionnaire(input.questionnaire)) return null;

  const catalogListReply = await tryFormsCatalogListReply({
    inbound: input.inbound,
    questionnaire: input.questionnaire,
    history: input.history,
  });
  if (catalogListReply) {
    return {
      kind: 'list',
      text: catalogListReply,
      pendingQuestionId:
        questionIdForCatalogList(input.questionnaire, catalogListReply) ||
        promptQuestionId(missingQuestions(input.questions, input.alreadySaved)),
    };
  }

  const pendingQuestionId = String(input.pendingQuestionId || '').trim();

  const newValue = await tryNewValueConfirm({ ...input, pendingQuestionId });
  if (newValue) return newValue;

  const confirm = tryConfirmCapture({ ...input, pendingQuestionId });
  if (confirm?.kind === 'yes') {
    return { kind: 'answers', accepted: confirm.accepted, summary: '', detail: 'confirmação Forms' };
  }
  if (confirm?.kind === 'correct') {
    return { kind: 'reask', text: CONFIRM_CORRECTION_REPLY, pendingQuestionId: confirm.questionId };
  }
  const late = tryLateLinesCapture(input);
  if (late) {
    return { kind: 'answers', accepted: late.accepted, summary: late.summary, detail: 'linhas após encerramento' };
  }

  const forceCatalogIndex = shouldForceCatalogIndexCapture(
    input.inbound,
    input.questionnaire,
    input.alreadySaved,
    pendingQuestionId,
  );
  const switched = await tryExplicitPartnerSwitch(input);
  if (switched) return switched;
  // Antes do número sozinho: “fornecedor 2, 50 kg de abacate” também resolve como “fornecedor 2”.
  const combined = await tryLeadingIndexWithLines({ ...input, pendingQuestionId });
  if (combined) return combined;
  const catalogIndex = await tryResolveCatalogIndexAnswer({
    inbound: input.inbound,
    questionnaire: input.questionnaire,
    history: input.history,
    alreadySaved: input.alreadySaved,
    pendingQuestionId,
  });
  if (catalogIndex) {
    return {
      kind: 'answers',
      accepted: [{ questionId: catalogIndex.questionId, text: catalogIndex.value, type: 'text' }],
      summary: catalogIndex.value,
      detail: 'catálogo Forms por número',
    };
  }
  if (forceCatalogIndex) {
    const again = await buildFormsBotGuidedPrompt({
      questionnaire: input.questionnaire,
      questions: missingQuestions(input.questions, input.alreadySaved),
    });
    return {
      kind: 'reask',
      text: ['Não consegui identificar a opção. Escolha de novo o número:', again]
        .filter(Boolean)
        .join('\n\n'),
      pendingQuestionId:
        questionIdForCatalogList(input.questionnaire, again) ||
        promptQuestionId(missingQuestions(input.questions, input.alreadySaved)),
    };
  }

  const linesCapture = tryFormsLinesCapture({
    inbound: input.inbound,
    questions: input.questions,
    alreadySaved: input.alreadySaved,
    pendingQuestionId,
  });
  if (!linesCapture?.length) return null;
  const summary = linesCapture
    .filter((item) => !isLinesMoreDoneAnswer(item.text))
    .map((item) => describeLinesAnswer(item.text))
    .join('; ');
  return {
    kind: 'answers',
    accepted: linesCapture,
    summary,
    detail: 'linhas Forms (atalho)',
  };
}

// “4, 100 kg…”, “fornecedor 2, 50 kg…”, “2 e 50 kg…”. Vírgula só com espaço depois (“4,5 kg” é quantidade).
const LEADING_INDEX_RE =
  /^\s*(?:(?:fornecedor|cliente|produto|op[cç][aã]o|n[uú]mero)\s*)?(\d{1,3})(?:\s*[;\-–—]|\s*,(?=\s)|\s+e\s+)\s*(\S[\s\S]*)$/iu;

const EXPLICIT_PARTNER_INDEX_RE =
  /^\s*(fornecedor|cliente)\s+(?:n[º°o]?\.?\s*)?(\d{1,3})(?![\d.,]\d)\s*(?:[,;\-–—]\s*|\s+e\s+)?([\s\S]*)$/iu;

/**
 * “fornecedor 2” (opcionalmente com linhas) quando o campo JÁ tem valor: troca pelo item 2
 * do catálogo e avisa a troca. Campo vazio/“[novo?]” segue o fluxo normal da lista.
 */
async function tryExplicitPartnerSwitch(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
}): Promise<FormsBotCapture | null> {
  const match = EXPLICIT_PARTNER_INDEX_RE.exec(input.inbound);
  if (!match) return null;
  const kind = String(input.questionnaire.formKind || '').trim();
  if (!isFormKind(kind)) return null;
  const fieldKey = match[1].toLowerCase() === 'cliente' ? 'customer' : 'vendor';
  const question = input.questions.find((item) => String(item.export_field || '').trim() === fieldKey);
  if (!question) return null;
  const previous = String(
    input.alreadySaved.find((row) => row.question_id === question.id)?.answer_text || '',
  ).trim();
  if (!previous || isMarkedNewValue(previous)) return null;

  const options = await listCatalogOptionsForField(
    kind,
    fieldKey,
    String(input.questionnaire.companyOdooId || '').trim() || '1',
  );
  const chosen = options[Number(match[2]) - 1]?.value;
  if (!chosen) return null;

  const rest = String(match[3] || '').trim();
  const lines = rest
    ? tryFormsLinesCapture({ inbound: rest, questions: input.questions, alreadySaved: input.alreadySaved })
    : [];
  if (rest && !lines?.length) return null;

  const label = fieldKey === 'customer' ? 'cliente' : 'fornecedor';
  const change =
    chosen === previous ? `${label}: ${chosen}` : `${label} alterado para ${chosen} (antes: ${previous})`;
  const lineItems = lines || [];
  return {
    kind: 'answers',
    accepted: [{ questionId: question.id, text: chosen, type: 'text' }, ...lineItems],
    summary: [change, acceptedSummary(lineItems, [])].filter(Boolean).join('; '),
    detail: `troca de ${label} por número`,
  };
}

/** Número da lista + linhas na mesma mensagem: grava a opção do catálogo e as linhas. */
async function tryLeadingIndexWithLines(input: {
  inbound: string;
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  history: { direction: string; text: string }[];
  pendingQuestionId: string;
}): Promise<FormsBotCapture | null> {
  const lead = LEADING_INDEX_RE.exec(input.inbound);
  if (!lead) return null;
  const rest = lead[2];
  if (!parseQtyProductChunks(rest).length) return null;
  const catalogIndex = await tryResolveCatalogIndexAnswer({
    inbound: lead[1],
    questionnaire: input.questionnaire,
    history: input.history,
    alreadySaved: input.alreadySaved,
    pendingQuestionId: input.pendingQuestionId,
  });
  if (!catalogIndex) return null;
  const withIndex: CycleAnswer[] = [
    ...input.alreadySaved,
    {
      id: catalogIndex.questionId,
      cycle_id: '',
      question_id: catalogIndex.questionId,
      answer_text: catalogIndex.value,
      answer_type: 'text',
      media_url: '',
    },
  ];
  // O número já respondeu a pergunta pendente; o restante é avaliado como linhas.
  const lines = tryFormsLinesCapture({ inbound: rest, questions: input.questions, alreadySaved: withIndex });
  if (!lines?.length) return null;
  return {
    kind: 'answers',
    accepted: [{ questionId: catalogIndex.questionId, text: catalogIndex.value, type: 'text' }, ...lines],
    summary: [
      catalogIndex.value,
      ...lines.filter((item) => !isLinesMoreDoneAnswer(item.text)).map((item) => describeLinesAnswer(item.text)),
    ].join('; '),
    detail: 'catálogo Forms por número + linhas',
  };
}

/**
 * Lista enviada (“Fornecedor — escolha o número…”) → pergunta que ela responde.
 * Lista de produtos responde a pergunta de linhas. '' se o texto não for uma lista conhecida.
 */
export function questionIdForCatalogList(questionnaire: Questionnaire, text: string): string {
  const cursor = parseCatalogListCursor(text);
  if (!cursor) return '';
  const keys = cursor.fieldKey === 'product' ? ['product', FORMS_BOT_LINES_FIELD] : [cursor.fieldKey];
  for (const key of keys) {
    const question = questionnaire.questions.find((item) => String(item.export_field || '').trim() === key);
    if (question) return question.id;
  }
  return '';
}
