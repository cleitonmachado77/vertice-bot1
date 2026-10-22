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
  isLinesMoreDoneAnswer,
  isQuantityOnly,
  mentionsNoMoreLines,
  parseQtyProductChunks,
} from './forms-bot-fields.js';
import type { MediaUnderstanding } from './media-understand.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import type { ExtractedAnswer } from './questionnaire-extraction.js';
import { defaultQuestionnaireReply } from './questionnaire-replies.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

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
): Promise<string> {
  if (!missing.length) return '';
  if (isFormsBotQuestionnaire(questionnaire)) {
    const guided = await buildFormsBotGuidedPrompt({ questionnaire, questions: missing });
    if (guided.trim()) return guided;
  }
  return missing.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
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
  const prompt = await missingPromptFor(input.questionnaire, input.missing);
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
  const forceCatalogIndex = shouldForceCatalogIndexCapture(
    input.inbound,
    input.questionnaire,
    input.alreadySaved,
    pendingQuestionId,
  );
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
  const combined = await tryLeadingIndexWithLines({ ...input, pendingQuestionId });
  if (combined) return combined;
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

// “4, 100 kg de manga…” / “4 - 100 kg…”. Vírgula só com espaço depois, para não pegar “4,5 kg”.
const LEADING_INDEX_RE = /^\s*(\d{1,3})\s*(?:[;\-–—]|,(?=\s))\s*(\S[\s\S]*)$/u;

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

/** JSON de linhas → “50 kg de abacate; 20 kg de mandioca”; texto livre fica como está. */
export function describeLinesAnswer(text: string): string {
  try {
    const rows = JSON.parse(text) as Array<{ product?: string; quantity?: string }>;
    if (Array.isArray(rows)) {
      return rows.map((row) => `${row.quantity || ''} de ${row.product || ''}`.trim()).join('; ');
    }
  } catch {
    /* texto livre */
  }
  return text;
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
