import {
  CONFIRM_QUESTION_BODY,
  FORMS_BOT_CONFIRM_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  hasExplicitUnit,
  isConfirmCorrectionAnswer,
  isConfirmYesAnswer,
  isLinesMoreDoneAnswer,
  parseQtyProductChunks,
} from './forms-bot-fields.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import { isCorrectionOrDeleteRequest } from './questionnaire-edits.js';
import type { ExtractedAnswer } from './questionnaire-extraction.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

// Encerramento do Forms Bot: resumo, confirmação “sim / corrigir” e itens que chegam depois.

const fieldOf = (question: QuestionnaireQuestion) => String(question.export_field || '').trim();

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

/** “Fornecedor Teste Vertice; 100 kg de manga; 20 kg de mandioca” (sem “não”/confirmação). */
export function formsAnswersSummary(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): string {
  return questions
    .filter((item) => fieldOf(item) !== FORMS_BOT_CONFIRM_FIELD)
    .map((item) => ({ item, text: answers.find((row) => row.question_id === item.id)?.answer_text || '' }))
    .filter(({ item, text }) => text.trim() && !(fieldOf(item) === FORMS_BOT_LINES_MORE_FIELD && isLinesMoreDoneAnswer(text)))
    .map(({ text }) => describeLinesAnswer(text))
    .join('; ');
}

export function isConfirmQuestion(question: QuestionnaireQuestion | undefined): boolean {
  return Boolean(question) && fieldOf(question as QuestionnaireQuestion) === FORMS_BOT_CONFIRM_FIELD;
}

/** Pergunta final com o resumo do que vai ser registrado. */
export function confirmPromptText(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): string {
  const summary = formsAnswersSummary(questions, answers);
  return [summary ? `Confira o registro: ${summary}.` : '', CONFIRM_QUESTION_BODY].filter(Boolean).join('\n');
}

export const CONFIRM_CORRECTION_REPLY =
  'Certo! Me diga o que corrigir — ex.: “corrigir fornecedor para MUNICIPIO DE CAMBE” ou “corrigir manga para 30 kg”.';

/** Resposta à confirmação: só quando ela é a pergunta da vez. */
export function tryConfirmCapture(input: {
  inbound: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  pendingQuestionId?: string;
}): { kind: 'yes'; accepted: ExtractedAnswer[] } | { kind: 'correct'; questionId: string } | null {
  const missing = missingQuestions(input.questions, input.alreadySaved);
  const confirm = missing.find(isConfirmQuestion);
  if (!confirm) return null;
  const pendingId = String(input.pendingQuestionId || '').trim();
  const asked = pendingId ? pendingId === confirm.id : missing[0]?.id === confirm.id;
  if (!asked) return null;
  if (isConfirmYesAnswer(input.inbound)) {
    return { kind: 'yes', accepted: [{ questionId: confirm.id, text: 'sim', type: 'text' }] };
  }
  if (isConfirmCorrectionAnswer(input.inbound)) return { kind: 'correct', questionId: confirm.id };
  return null;
}

/**
 * Registro já concluído e chegam mais itens (“10 kg de banana”): acrescenta em “Mais produtos?”
 * para o documento ser atualizado. Correções (“na verdade eram 30 kg”) seguem o fluxo de edição.
 */
export function tryLateLinesCapture(input: {
  inbound: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
}): { accepted: ExtractedAnswer[]; summary: string } | null {
  const more = input.questions.find((item) => fieldOf(item) === FORMS_BOT_LINES_MORE_FIELD);
  if (!more || missingQuestions(input.questions, input.alreadySaved).length) return null;
  if (isCorrectionOrDeleteRequest(input.inbound)) return null;
  const chunks = parseQtyProductChunks(input.inbound);
  if (!chunks.length || !(chunks.length > 1 || hasExplicitUnit(input.inbound))) return null;
  const added = chunks.map((chunk) => `${chunk.quantity} de ${chunk.product}`).join('; ');
  const existing = String(input.alreadySaved.find((row) => row.question_id === more.id)?.answer_text || '').trim();
  const merged = existing && !isLinesMoreDoneAnswer(existing) ? `${existing}; ${added}` : added;
  return { accepted: [{ questionId: more.id, text: merged, type: 'text' }], summary: added };
}
