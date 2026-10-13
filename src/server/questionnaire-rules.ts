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

export function relativeOccurrenceDate(today: string, text: string): string {
  const normalized = foldText(text);
  const offset = /\banteontem\b/.test(normalized) ? 2 : /\bontem\b/.test(normalized) ? 1 : 0;
  if (!offset) return today;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!match) return today;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
