import { completeChat, type ChatMessage } from './agent.js';
import { getSetting } from './db.js';
import { normalizeMediaType, understandInbound, type MediaUnderstanding } from './media-understand.js';
import {
  markCycleCompleted,
  missingQuestions,
  upsertAnswers,
  type ActiveCycleContext,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

export type QuestionnaireDraft = {
  text: string;
  source: 'model' | 'fallback' | 'none';
  detail: string;
  completed: boolean;
};

type ExtractedAnswer = { questionId: string; text: string; type: string };
type Extracted = { reply: string; answers: ExtractedAnswer[]; complete: boolean };

export async function draftQuestionnaireReply(input: {
  context: ActiveCycleContext;
  contactName: string;
  inbound: string;
  inboundType: string;
  mediaUrl: string;
  history: { direction: string; text: string }[];
}): Promise<QuestionnaireDraft> {
  const fallback = getSetting('agent_fallback');
  if (getSetting('agent_active') !== '1') {
    return { text: '', source: 'none', detail: 'Agente desligado', completed: false };
  }
  if (!getSetting('agent_api_key')) {
    return fallback
      ? { text: fallback, source: 'fallback', detail: 'Sem chave do modelo', completed: false }
      : { text: '', source: 'none', detail: 'Sem chave do modelo', completed: false };
  }

  const media = await understandInbound({
    type: input.inboundType,
    text: input.inbound,
    mediaUrl: input.mediaUrl,
  });
  const questions = input.context.questionnaire.questions;
  const alreadySaved = input.context.answers;
  const startIntent = isStartOrContinueIntent(media.summary || input.inbound);
  const wantsList = startIntent || asksForQuestions(media.summary || input.inbound) || alreadySaved.length === 0;

  // Abertura do ciclo: usuário só confirmou continuidade → envia o questionário agora.
  if (wantsList && alreadySaved.length === 0 && (startIntent || asksForQuestions(media.summary || input.inbound))) {
    return {
      text: presentQuestionnaire(questions, input.contactName),
      source: 'model',
      detail: 'questionário apresentado',
      completed: false,
    };
  }

  const already = formatAnswers(questions, alreadySaved);
  const pending = input.context.missing.map(
    (item, index) =>
      `${index + 1}. [${item.id}] ${item.body} (aceita: ${acceptedLabel(item.expected_type)})`,
  );

  const system = [
    'Você supervisiona a coleta de respostas de um questionário no WhatsApp.',
    'Fale em português do Brasil, de forma curta e humana.',
    'O usuário pode responder em texto livre, áudio, imagem ou vídeo.',
    'Trate áudio transcrito, descrição de imagem e vídeo recebido como respostas válidas.',
    'REGRA OBRIGATÓRIA: se ainda não houver respostas salvas e o usuário disser que quer continuar, confirmar, ok, sim, ou pedir as perguntas, sua reply DEVE listar TODAS as perguntas numeradas.',
    'Nunca diga apenas "vamos continuar o questionário" sem enviar as perguntas.',
    'Frases como "vamos continuar", "ok", "sim", "pode ser" NÃO são respostas das perguntas — nesse caso answers deve ser [].',
    'Extraia respostas reais da mensagem atual. Se estiverem incompletas, confirme o que entendeu e peça o que falta, listando as faltantes.',
    'Quando todas as perguntas tiverem resposta válida, agradeça e encerre a coleta.',
    'Não invente respostas. Não mencione que você é um modelo.',
    '',
    `Questionário: ${input.context.questionnaire.name}`,
    `Contato: ${input.contactName || 'não informado'}`,
    'Perguntas:',
    questions
      .map((item, index) => `${index + 1}. id=${item.id} | aceita=${item.expected_type} | ${item.body}`)
      .join('\n'),
    '',
    'Respostas já salvas:',
    already || '(nenhuma)',
    '',
    'Ainda faltam:',
    pending.join('\n') || '(nenhuma)',
    '',
    'Responda APENAS com JSON válido neste formato:',
    '{"reply":"texto para o usuário","answers":[{"questionId":"id","text":"conteúdo entendido da resposta","type":"text|audio|image|video"}],"complete":false}',
  ].join('\n');

  const history = input.history
    .filter((item) => item.text.trim())
    .slice(-6)
    .map((item) => ({
      role: item.direction === 'OUTBOUND' ? 'assistant' : 'user',
      content: item.text,
    }));

  const userContent = [
    `Tipo da mensagem: ${media.type}`,
    media.mediaUrl ? `URL da mídia: ${media.mediaUrl}` : '',
    media.caption ? `Legenda original: ${media.caption}` : '',
    media.transcript ? `Conteúdo entendido/transcrito: ${media.transcript}` : '',
    `Resumo para coleta: ${media.summary || input.inbound}`,
    startIntent ? 'Intenção detectada: iniciar/continuar (NÃO salve como resposta; liste as perguntas).' : '',
    media.understood ? 'Interpretação: ok' : 'Interpretação: parcial — mesmo assim tente coletar se a mídia for a resposta.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: userContent },
    ];
    const raw = await completeChat(messages, { temperature: 0.2, timeoutMs: 40_000 });
    let extracted = parseExtracted(raw, questions, media);

    if (startIntent) {
      extracted = { ...extracted, answers: [] };
    } else if (!extracted.answers.length) {
      extracted = {
        ...extracted,
        answers: autoAssignMedia(input.context.missing, media),
      };
    }

    const accepted = filterAccepted(extracted.answers, questions, media);
    const answers = accepted.length
      ? await upsertAnswers(
          input.context.cycle.id,
          accepted.map((item) => ({
            questionId: item.questionId,
            text: item.text,
            type: item.type,
            mediaUrl: item.type === 'text' ? '' : media.mediaUrl || input.mediaUrl,
          })),
        )
      : alreadySaved;

    const missing = missingQuestions(questions, answers);
    const complete = missing.length === 0;
    if (complete) await markCycleCompleted(input.context.cycle.id);

    let reply = extracted.reply.trim() || defaultReply(questions, answers, missing, complete, media);
    if (!complete && answers.length === 0 && !replyListsQuestions(reply, questions)) {
      reply = presentQuestionnaire(questions, input.contactName);
    } else if (!complete && missing.length && answers.length > 0 && !replyListsQuestions(reply, missing)) {
      reply = `${reply.replace(/\s+$/, '')}\n\nAinda falta:\n${formatQuestionList(missing)}`;
    }

    return {
      text: reply.slice(0, 1500),
      source: 'model',
      detail: complete ? 'questionário concluído' : `coleta ${media.type}`,
      completed: complete,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha no modelo';
    if (startIntent || alreadySaved.length === 0) {
      return {
        text: presentQuestionnaire(questions, input.contactName),
        source: 'fallback',
        detail,
        completed: false,
      };
    }
    const auto = filterAccepted(autoAssignMedia(input.context.missing, media), questions, media);
    if (auto.length) {
      const answers = await upsertAnswers(
        input.context.cycle.id,
        auto.map((item) => ({
          questionId: item.questionId,
          text: item.text,
          type: item.type,
          mediaUrl: item.type === 'text' ? '' : media.mediaUrl || input.mediaUrl,
        })),
      );
      const missing = missingQuestions(questions, answers);
      const complete = missing.length === 0;
      if (complete) await markCycleCompleted(input.context.cycle.id);
      return {
        text: defaultReply(questions, answers, missing, complete, media),
        source: 'fallback',
        detail,
        completed: complete,
      };
    }
    if (fallback) return { text: fallback, source: 'fallback', detail, completed: false };
    return { text: '', source: 'none', detail, completed: false };
  }
}

function presentQuestionnaire(questions: QuestionnaireQuestion[], contactName: string): string {
  const hello = contactName?.trim() ? `Perfeito, ${contactName.trim().split(/\s+/)[0]}!` : 'Perfeito!';
  return [
    `${hello} Segue o questionário. Pode responder por texto, áudio, imagem ou vídeo.`,
    formatQuestionList(questions),
  ].join('\n\n');
}

function formatQuestionList(questions: QuestionnaireQuestion[]): string {
  return questions.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
}

function replyListsQuestions(reply: string, questions: QuestionnaireQuestion[]): boolean {
  const normalized = reply.toLowerCase();
  const hits = questions.filter((item) => {
    const body = item.body.trim().toLowerCase();
    if (body.length < 8) return normalized.includes(body);
    return normalized.includes(body.slice(0, Math.min(24, body.length)));
  }).length;
  return hits >= Math.min(2, questions.length) || (questions.length === 1 && hits === 1);
}

function isStartOrContinueIntent(value: string): boolean {
  const text = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 80) return false;
  return (
    /^(vamos\s+)?continuar\b/.test(text) ||
    /^(pode\s+)?continuar\b/.test(text) ||
    /^(ok|okay|certo|beleza|blz|sim|pode|vamos|segue|seguimos|iniciar|comecar|começar)\b/.test(text) ||
    /^(quero|pode|vamos)\s+(continuar|seguir|comecar|começar|iniciar)\b/.test(text) ||
    text === 'vamos continuar' ||
    text === 'pode continuar' ||
    text === 'quero continuar'
  );
}

function asksForQuestions(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes('perguntas') ||
    text.includes('questionario') ||
    text.includes('questionário') ||
    text.includes('o que preciso') ||
    text.includes('quais sao') ||
    text.includes('quais são')
  );
}

function parseExtracted(
  raw: string,
  questions: QuestionnaireQuestion[],
  media: MediaUnderstanding,
): Extracted {
  const jsonText = extractJson(raw);
  if (!jsonText) return heuristicExtract(raw);
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
            const type = normalizeMediaType(String(row.type || media.type || 'text'));
            const text = String(row.text || '').trim() || media.summary;
            return {
              questionId: String(row.questionId || ''),
              text,
              type,
            };
          })
          .filter((item) => item.questionId && item.text && !isStartOrContinueIntent(item.text))
      : [];
    return {
      reply: String(data.reply || '').trim(),
      answers,
      complete: Boolean(data.complete),
    };
  } catch {
    return heuristicExtract(raw);
  }
}

function heuristicExtract(raw: string): Extracted {
  const reply = raw.replace(/```json[\s\S]*```/i, '').replace(/\{[\s\S]*\}/, '').trim();
  return { reply, answers: [], complete: false };
}

function autoAssignMedia(candidates: QuestionnaireQuestion[], media: MediaUnderstanding): ExtractedAnswer[] {
  if (!media.summary && !media.mediaUrl) return [];
  if (media.type === 'text' && isStartOrContinueIntent(media.summary)) return [];
  // Texto livre só entra automático se sobrar exatamente uma pergunta.
  if (media.type === 'text' && candidates.length !== 1) return [];

  const eligible = candidates.filter((question) => typeFits(question.expected_type, media.type));
  const target = eligible[0] || (media.type !== 'text' ? candidates[0] : undefined);
  if (!target) return [];
  return [
    {
      questionId: target.id,
      text: media.summary || labelFor(media.type),
      type: media.type,
    },
  ];
}

function filterAccepted(
  answers: ExtractedAnswer[],
  questions: QuestionnaireQuestion[],
  media: MediaUnderstanding,
): ExtractedAnswer[] {
  const byId = new Map(questions.map((item) => [item.id, item]));
  return answers
    .map((answer) => ({
      ...answer,
      type: normalizeMediaType(answer.type || media.type),
      text: answer.text.trim() || media.summary || labelFor(media.type),
    }))
    .filter((answer) => {
      const question = byId.get(answer.questionId);
      if (!question) return false;
      if (!answer.text.trim() && !media.mediaUrl) return false;
      if (isStartOrContinueIntent(answer.text)) return false;
      return typeFits(question.expected_type, answer.type);
    });
}

function typeFits(expected: string, actual: string): boolean {
  if (!expected || expected === 'any') return true;
  if (expected === actual) return true;
  if (expected === 'text' && actual === 'audio') return true;
  return false;
}

function acceptedLabel(expected: string): string {
  if (expected === 'text') return 'texto ou áudio';
  if (expected === 'audio') return 'áudio';
  if (expected === 'image') return 'imagem';
  if (expected === 'video') return 'vídeo';
  return 'texto, áudio, imagem ou vídeo';
}

function labelFor(type: string): string {
  return (
    {
      audio: 'Áudio recebido',
      image: 'Imagem recebida',
      video: 'Vídeo recebido',
      document: 'Documento recebido',
    }[type] || 'Resposta recebida'
  );
}

function formatAnswers(questions: QuestionnaireQuestion[], answers: CycleAnswer[]): string {
  if (!answers.length) return '';
  const byId = new Map(answers.map((item) => [item.question_id, item]));
  return questions
    .map((question, index) => {
      const answer = byId.get(question.id);
      if (!answer) return '';
      const media = answer.media_url ? ` [${answer.answer_type}]` : '';
      return `${index + 1}. ${question.body} → ${answer.answer_text}${media}`;
    })
    .filter(Boolean)
    .join('\n');
}

function defaultReply(
  questions: QuestionnaireQuestion[],
  answers: CycleAnswer[],
  missing: QuestionnaireQuestion[],
  complete: boolean,
  media: MediaUnderstanding,
): string {
  if (complete) return 'Obrigado! Recebi todas as respostas do questionário.';
  if (!answers.length) return presentQuestionnaire(questions, '');
  const thanks =
    media.type === 'audio'
      ? 'Ouvi seu áudio.'
      : media.type === 'image'
        ? 'Recebi a imagem.'
        : media.type === 'video'
          ? 'Recebi o vídeo.'
          : 'Recebi sua mensagem.';
  return `${thanks} Ainda falta:\n${formatQuestionList(missing)}`;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return '';
}
