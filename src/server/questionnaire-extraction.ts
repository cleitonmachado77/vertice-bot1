import { completeChat } from './agent.js';
import { normalizeMediaType, type MediaUnderstanding } from './media-understand.js';
import { foldText, isNonAnswerText } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

export type ExtractedAnswer = { questionId: string; text: string; type: string };
export type Extracted = { reply: string; answers: ExtractedAnswer[]; complete: boolean };

export function parseExtracted(raw: string, media: MediaUnderstanding): Extracted {
  const jsonText = extractJson(raw);
  if (!jsonText) return { reply: stripJsonNoise(raw), answers: [], complete: false };
  try {
    const data = JSON.parse(jsonText) as {
      reply?: unknown;
      answers?: unknown;
      complete?: unknown;
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
    return {
      reply: String(data.reply || '').trim() || stripJsonNoise(raw),
      answers,
      complete: Boolean(data.complete),
    };
  } catch {
    return { reply: stripJsonNoise(raw), answers: [], complete: false };
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
  _questions: QuestionnaireQuestion[],
  missing: QuestionnaireQuestion[],
): ExtractedAnswer[] {
  const validIds = new Set(missing.map((item) => item.id));
  const used = new Set<string>();
  return answers.flatMap((answer) => {
    const text = answer.text.trim();
    if (!text || !validIds.has(answer.questionId) || used.has(answer.questionId)) return [];
    used.add(answer.questionId);
    return [{ ...answer, text }];
  });
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
            'Perguntas pendentes:',
            ...input.missing.map((item, index) => `${index + 1}. id=${item.id} | ${item.body}`),
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
  const hasQty = /\d+(\s*[.,]\d+)?\s*(kg|kgs|kilos?|quilos?)/i.test(text);
  if (missing.length === 1) {
    const body = foldText(missing[0].body);
    const isSupplier = /fornec|catador|nome|quem|entreg/.test(body);
    if (isSupplier && hasQty) return [];
    return [{ questionId: missing[0].id, text, type: 'text' }];
  }

  const results: ExtractedAnswer[] = [];
  for (const question of missing) {
    const body = foldText(question.body);
    const isQty = /kg|quant|receb|peso|quilo|tonel/.test(body);
    const isSupplier = /fornec|catador|nome|quem|entreg/.test(body);
    if (isQty && hasQty) results.push({ questionId: question.id, text, type: 'text' });
    else if (isSupplier && !hasQty) {
      results.push({ questionId: question.id, text, type: 'text' });
    }
  }
  return results;
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
