import { completeChat } from './agent.js';
import { normalizeMediaType, type MediaUnderstanding } from './media-understand.js';
import { isFormsCatalogListAsk } from './forms-bot-catalog-context.js';
import { foldText, isNonAnswerText } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import {
  cleanRfqAnswer,
  detectRfqFieldFromQuestion,
  messageLooksLikeField,
  rfqSeparationPromptLines,
  type RfqFieldKey,
} from './rfq-answer-dictionary.js';

export type ExtractedAnswer = { questionId: string; text: string; type: string };
export type Extracted = {
  reply: string;
  answers: ExtractedAnswer[];
  complete: boolean;
  /** false = mensagem sem relação com o questionário → agente geral. */
  related: boolean;
};

export function parseExtracted(raw: string, media: MediaUnderstanding): Extracted {
  const jsonText = extractJson(raw);
  if (!jsonText) {
    return { reply: stripJsonNoise(raw), answers: [], complete: false, related: true };
  }
  try {
    const data = JSON.parse(jsonText) as {
      reply?: unknown;
      answers?: unknown;
      complete?: unknown;
      related?: unknown;
      deferFree?: unknown;
    };
    const answers = Array.isArray(data.answers)
      ? data.answers
          .map((item) => {
            const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            return {
              questionId: String(row.questionId || row.question_id || row.id || ''),
              text: String(row.text || row.answer || row.value || '').trim(),
              type: normalizeMediaType(String(row.type || media.type || 'text')),
            };
          })
          .filter((item) => item.questionId && item.text)
      : [];
    const related =
      data.related === false || data.deferFree === true
        ? false
        : data.related === true || answers.length > 0
          ? true
          : data.related === undefined
            ? true
            : Boolean(data.related);
    return {
      reply: String(data.reply || '').trim() || (related ? stripJsonNoise(raw) : ''),
      answers,
      complete: Boolean(data.complete),
      related,
    };
  } catch {
    return { reply: stripJsonNoise(raw), answers: [], complete: false, related: true };
  }
}

export function autoAssignMedia(
  candidates: QuestionnaireQuestion[],
  media: MediaUnderstanding,
): ExtractedAnswer[] {
  if (!media.mediaUrl && !media.summary) return [];
  if (media.type === 'text') return [];
  const eligible = candidates.filter((question) => typeFits(question.expected_type, media.type));
  const target = eligible.length === 1 ? eligible[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!target) return [];
  if (!media.understood && target.expected_type !== media.type) return [];
  return [{ questionId: target.id, text: media.summary || mediaLabel(media.type), type: media.type }];
}

export function normalizeExtractedAnswers(
  answers: ExtractedAnswer[],
  questions: QuestionnaireQuestion[],
  missing: QuestionnaireQuestion[],
): ExtractedAnswer[] {
  const byId = new Map(questions.map((item) => [item.id, item]));
  const validIds = new Set(missing.map((item) => item.id));
  const used = new Set<string>();
  return answers.flatMap((answer) => {
    const question = byId.get(answer.questionId);
    const raw = answer.text.trim();
    const text = question ? cleanAnswerForQuestion(raw, question) : raw;
    if (!text || !validIds.has(answer.questionId) || used.has(answer.questionId)) return [];
    used.add(answer.questionId);
    return [{ ...answer, text }];
  });
}

/** Normaliza a resposta conforme o campo RFQ / tipo da pergunta. */
export function cleanAnswerForQuestion(text: string, question: QuestionnaireQuestion): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const field = detectRfqFieldFromQuestion(question);
  return cleanRfqAnswer(raw, field) || raw;
}

export function filterAccepted(
  answers: ExtractedAnswer[],
  questions: QuestionnaireQuestion[],
  media: MediaUnderstanding,
): ExtractedAnswer[] {
  const byId = new Map(questions.map((item) => [item.id, item]));
  const seen = new Set<string>();
  return answers
    .map((answer) => ({
      ...answer,
      type: normalizeMediaType(answer.type || media.type),
      text: answer.text.trim() || media.summary || mediaLabel(media.type),
    }))
    .filter((answer) => {
      if (seen.has(answer.questionId)) return false;
      const question = byId.get(answer.questionId);
      if (!question || (!answer.text.trim() && !media.mediaUrl)) return false;
      if (!typeFits(question.expected_type, answer.type)) return false;
      seen.add(answer.questionId);
      return true;
    });
}

export function typeFits(expected: string, actual: string): boolean {
  if (!expected || expected === 'any') return true;
  if (expected === actual) return true;
  return expected === 'text' && actual === 'audio';
}

export function acceptedLabel(expected: string): string {
  if (expected === 'text') return 'texto ou áudio';
  if (expected === 'audio') return 'áudio';
  if (expected === 'image') return 'imagem';
  if (expected === 'video') return 'vídeo';
  return 'texto, áudio, imagem ou vídeo';
}

export async function salvageExtractAnswers(input: {
  missing: QuestionnaireQuestion[];
  userMessage: string;
  media: MediaUnderstanding;
}): Promise<ExtractedAnswer[]> {
  if (!input.missing.length) return [];
  const message = (input.media.summary || input.media.transcript || input.userMessage || '').trim();
  if (!message || isNonAnswerText(message)) return [];
  try {
    const raw = await completeChat(
      [
        {
          role: 'system',
          content: [
            'Extraia respostas de questionário a partir da mensagem do usuário.',
            'Retorne APENAS JSON válido:',
            '{"answers":[{"questionId":"id-exato","text":"resposta","type":"text"}]}',
            'Use somente os questionId listados. Não invente.',
            'Só omita uma pergunta se a mensagem claramente não falar dela.',
            ...rfqSeparationPromptLines(),
            'Perguntas pendentes:',
            ...input.missing.map((item, index) => {
              const field = detectRfqFieldFromQuestion(item);
              const fieldHint = field ? ` | campo=${field}` : '';
              return `${index + 1}. id=${item.id}${fieldHint} | ${item.body}`;
            }),
          ].join('\n'),
        },
        { role: 'user', content: `Mensagem do usuário:\n${message}` },
      ],
      { temperature: 0.1, timeoutMs: 25_000 },
    );
    return parseExtracted(raw, input.media).answers;
  } catch {
    return [];
  }
}

export function heuristicExtractAnswers(
  missing: QuestionnaireQuestion[],
  message: string,
): ExtractedAnswer[] {
  const text = String(message || '').trim();
  if (!text || isNonAnswerText(text) || !missing.length) return [];
  // Pedido de lista/opções nunca é resposta de preenchimento.
  if (isFormsCatalogListAsk(text)) return [];

  if (missing.length === 1) {
    const only = missing[0];
    const field = detectRfqFieldFromQuestion(only);
    if (!fieldAllowsHeuristicText(field, text)) return [];
    return [
      {
        questionId: only.id,
        text: cleanAnswerForQuestion(text, only),
        type: 'text',
      },
    ];
  }

  const results: ExtractedAnswer[] = [];
  const usedFields = new Set<RfqFieldKey>();
  for (const question of missing) {
    const field = detectRfqFieldFromQuestion(question);
    if (!field || usedFields.has(field)) continue;
    if (!messageLooksLikeField(text, field)) continue;
    // Datas: não atribuir a mesma mensagem a deadline e arrival sem pista no corpo.
    if (field === 'order_deadline' || field === 'expected_arrival') {
      const body = foldText(question.body);
      const mentionsArrival = /chegad|entrega|previs|arrival|fornecimento/.test(body);
      const mentionsDeadline = /deadline|prazo|compra|comprou/.test(body);
      if (field === 'expected_arrival' && !mentionsArrival && mentionsDeadline) continue;
      if (field === 'order_deadline' && !mentionsDeadline && mentionsArrival) continue;
    }
    const cleaned = cleanAnswerForQuestion(text, question);
    if (!cleaned) continue;
    // Só grava produto/qty/preço se a limpeza realmente isolou o valor.
    if (
      (field === 'products' || field === 'quantity' || field === 'unit_price') &&
      cleaned === text &&
      !messageLooksLikeField(text, field)
    ) {
      continue;
    }
    usedFields.add(field);
    results.push({ questionId: question.id, text: cleaned, type: 'text' });
  }
  return results;
}

function fieldAllowsHeuristicText(field: RfqFieldKey | '', text: string): boolean {
  if (!field) {
    // Sem vínculo RFQ: não engolir perguntas/conversa com '?'.
    return !/\?\s*$/.test(text.trim());
  }
  if (
    field === 'quantity' ||
    field === 'unit_price' ||
    field === 'taxes' ||
    field === 'payment_terms' ||
    field === 'order_deadline' ||
    field === 'expected_arrival' ||
    field === 'order_reference'
  ) {
    return messageLooksLikeField(text, field);
  }
  if (field === 'products') {
    if (messageLooksLikeField(text, 'products')) return true;
    // Nome solto de produto (fora do catálogo), desde que não seja só kg/preço/pergunta.
    return (
      !messageLooksLikeField(text, 'quantity') &&
      !messageLooksLikeField(text, 'unit_price') &&
      !/\?\s*$/.test(text.trim()) &&
      /\p{L}{2,}/u.test(text)
    );
  }
  if (field === 'vendor' || field === 'vendor_reference') {
    if (messageLooksLikeField(text, 'quantity') || messageLooksLikeField(text, 'unit_price')) {
      return false;
    }
    if (isFormsCatalogListAsk(text)) return false;
    // Pergunta (“quais…?”, “qual fornecedor…”) não é nome de fornecedor.
    if (/\b(quais?|lista|opcoes?)\b/i.test(foldText(text)) || /\?\s*$/.test(text.trim())) {
      return false;
    }
    return /\p{L}{2,}/u.test(text);
  }
  return false;
}

export function mergeExtracted(
  base: ExtractedAnswer[],
  extra: ExtractedAnswer[],
): ExtractedAnswer[] {
  const byId = new Map<string, ExtractedAnswer>();
  for (const item of base) byId.set(item.questionId, item);
  for (const item of extra) byId.set(item.questionId, item);
  return [...byId.values()];
}

export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : '';
}

function stripJsonNoise(raw: string): string {
  return raw.replace(/```json[\s\S]*```/i, '').replace(/\{[\s\S]*\}/, '').trim();
}

function mediaLabel(type: string): string {
  return (
    {
      audio: 'Áudio recebido',
      image: 'Imagem recebida',
      video: 'Vídeo recebido',
      document: 'Documento recebido',
    }[type] || 'Resposta recebida'
  );
}
