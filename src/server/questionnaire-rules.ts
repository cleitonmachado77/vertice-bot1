import type { MediaUnderstanding } from './media-understand.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

export function foldText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}

export function isNonAnswerText(text: string): boolean {
  const normalized = foldText(text);
  return !normalized || /^(\.+|-+)$/.test(normalized);
}

export function looksLikeQuestionnaireAnswer(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  if (inboundType && inboundType !== 'text' && mediaUrl) return true;
  return looksLikeAnswerPayload(
    {
      type: inboundType || 'text',
      summary: inbound,
      transcript: '',
      caption: '',
      mediaUrl,
      understood: true,
    },
    inbound,
  );
}

export function looksLikeQuestionnaireEdit(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  const text = String(inbound || '').toLowerCase();
  if (text.length < 4 && !(inboundType !== 'text' && mediaUrl)) return false;
  return (
    /engan/.test(text) ||
    /corrig/.test(text) ||
    /erra(do|da|mos)?/.test(text) ||
    /apag(ar|ue|a|o)?/.test(text) ||
    /delet/.test(text) ||
    /remov(er|a|e)/.test(text) ||
    /limpar|limpa/.test(text) ||
    /alter(ar|e)|trocar|mudar/.test(text) ||
    /n[aã]o foi/.test(text) ||
    /na verdade/.test(text) ||
    /\b(ontem|anteontem)\b/.test(text) ||
    /foi \d+/.test(text)
  );
}

/** Perguntas sobre o próprio questionário (listar, lembrar, etc.). */
export function looksLikeQuestionnaireMeta(inbound: string): boolean {
  const text = foldText(inbound);
  if (!text || text.length < 4) return false;
  if (/questionario/.test(text)) return true;
  if (
    /perguntas?/.test(text) &&
    /(quais|qual|lembre|lembrar|lista|sao|seria|mostrar|manda|falar|diz|me fala)/.test(text)
  ) {
    return true;
  }
  return /me lembre/.test(text) && /pergunt/.test(text);
}

/**
 * Conteúdo que parece resposta/registro RFQ (kg, produto, “registrar”…).
 * Mais restrito que looksLikeAnswerPayload para não sequestrar conversa livre.
 */
export function looksLikeRfqOrRegisterPayload(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  if (inboundType && inboundType !== 'text' && mediaUrl) return true;
  const text = foldText(inbound);
  if (!text || text.length < 4) return false;
  if (looksLikeQuestionnaireMeta(inbound)) return false;
  if (
    /\b\d+([.,]\d+)?\s?(kg|g|ton|t\b|un|unid|l\b|ml|m3|m2|m²)\b/.test(text) ||
    /\b(registrar|registre|anota|anotar|recebi|receber|entrega|entregue|comprei|compra)\b/.test(
      text,
    ) ||
    /\b(plastico|cobre|aluminio|ferro|papel|papelao|vidro|borracha|oleo|bateria|sucata)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return looksLikeQuestionnaireEdit(inboundType, inbound, mediaUrl);
}

/** Deve preferir o agente de questionário em vez do modo livre. */
export function wantsQuestionnaireContext(
  inboundType: string,
  inbound: string,
  mediaUrl = '',
): boolean {
  return (
    looksLikeQuestionnaireEdit(inboundType, inbound, mediaUrl) ||
    looksLikeQuestionnaireMeta(inbound) ||
    looksLikeRfqOrRegisterPayload(inboundType, inbound, mediaUrl)
  );
}

export function looksLikeAnswerPayload(media: MediaUnderstanding, inbound: string): boolean {
  if (media.type !== 'text' && (media.mediaUrl || media.summary)) return true;
  const text = (media.summary || inbound || '').trim();
  if (text.length < 1 || isNonAnswerText(text)) return false;
  if (/pergunta/i.test(text) && /^(quais|qual|pode|me fala|manda)/i.test(text)) return false;
  if (/^(sim|n[aã]o|ok|certo|isso|isso mesmo|pode|claro|obrigad\w*)\.?$/i.test(text)) return false;
  return true;
}

export function isFullyAnswered(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
): boolean {
  if (!questions.length) return false;
  return questions.every((question) =>
    answers.some(
      (row) => row.question_id === question.id && String(row.answer_text || '').trim(),
    ),
  );
}

export function coversQuestions(reply: string, questions: QuestionnaireQuestion[]): boolean {
  if (!reply.trim() || !questions.length) return false;
  const normalized = foldText(reply);
  return questions.every((question) => {
    const snippet = foldText(question.body).slice(0, 24);
    return snippet.length >= 8 && normalized.includes(snippet);
  });
}

export {
  formatBrDate,
  parseOccurrenceDateRef,
  relativeOccurrenceDate,
  temporalRelation,
  temporalRelationLabel,
  weekdayFromIsoDate,
  type OccurrenceDateRef,
  type TemporalRelation,
} from './questionnaire-dates.js';
