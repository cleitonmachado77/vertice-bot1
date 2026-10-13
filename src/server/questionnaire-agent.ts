import { completeChat, type ChatMessage } from './agent.js';
import { getSetting } from './db.js';
import { normalizeMediaType, understandInbound, type MediaUnderstanding } from './media-understand.js';
import {
  markCycleCompleted,
  markCycleNotified,
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
  const already = formatAnswers(questions, alreadySaved);
  const pending = input.context.missing.map(
    (item, index) =>
      `${index + 1}. [${item.id}] ${item.body} (aceita: ${acceptedLabel(item.expected_type)})`,
  );

  const sendTime = input.context.questionnaire.send_time || '';
  const system = [
    'Você é um atendente humano da Vértice acompanhando um questionário no WhatsApp.',
    'Fale em português do Brasil, de forma natural, curta e personalizada.',
    '',
    'Você tem autonomia para interpretar o cenário e decidir o próximo passo. Não use regras rígidas de palavras-chave.',
    '',
    'Horário agendado do disparo NÃO atrasa a coleta:',
    sendTime
      ? `- Este questionário tem envio previsto às ${sendTime}, mas isso é só um lembrete automático para quem ainda não falou.`
      : '- Pode existir um horário de disparo automático, mas isso é só um lembrete para quem ainda não falou.',
    '- Se a pessoa mandar respostas (ou começar a responder) ANTES desse horário, trate agora: salve o que for resposta e peça na hora o que ainda falta.',
    '- Nunca diga que vai esperar o horário do disparo. Nunca peça para a pessoa aguardar o envio automático.',
    '',
    'Exemplos de cenários (decida caso a caso):',
    '- Confirmar que quer continuar → apresente o questionário completo, numerado.',
    '- Pedir só uma pergunta (“qual é a terceira?”) → responda só essa, com o texto da pergunta.',
    '- Enviar respostas cedo (ex.: 2 primeiras de manhã) → salve essas respostas, confirme o que entendeu e pergunte imediatamente as que faltam.',
    '- Mandar resposta incompleta → confirme o que entendeu e peça o que falta na mesma mensagem.',
    '- Fazer pergunta fora do questionário → responda de forma útil e, se ainda faltarem respostas, reconduza com delicadeza.',
    '',
    'Importante:',
    '- Só preencha "answers" quando a mensagem realmente contiver conteúdo de resposta às perguntas.',
    '- Se a mensagem for só intenção, dúvida ou conversa (sem resposta às perguntas), deixe "answers": [].',
    '- Quando for apresentar o questionário, inclua TODAS as perguntas numeradas na "reply".',
    '- Quando já houver respostas salvas e ainda faltarem itens, a "reply" DEVE listar as perguntas faltantes.',
    '- Aceite texto, áudio (já transcrito), imagem (já descrita) e vídeo.',
    '- Não invente respostas. Não mencione que você é um modelo.',
    '',
    `Questionário: ${input.context.questionnaire.name}`,
    `Contato: ${input.contactName || 'não informado'}`,
    'Perguntas do questionário:',
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
    'Responda APENAS com JSON válido:',
    '{"reply":"mensagem natural para o usuário","answers":[{"questionId":"id","text":"conteúdo da resposta","type":"text|audio|image|video"}],"complete":false}',
  ].join('\n');

  const history = input.history
    .filter((item) => item.text.trim())
    .slice(-8)
    .map((item) => ({
      role: item.direction === 'OUTBOUND' ? 'assistant' : 'user',
      content: item.text,
    }));

  const userContent = [
    `Tipo da mensagem: ${media.type}`,
    media.mediaUrl ? `URL da mídia: ${media.mediaUrl}` : '',
    media.caption ? `Legenda original: ${media.caption}` : '',
    media.transcript ? `Conteúdo entendido/transcrito: ${media.transcript}` : '',
    `Mensagem do usuário: ${media.summary || input.inbound}`,
    media.understood
      ? 'Interpretação da mídia: ok'
      : 'Interpretação da mídia: parcial — use o contexto e decida o melhor próximo passo.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: userContent },
    ];
    const raw = await completeChat(messages, { temperature: 0.35, timeoutMs: 40_000 });
    const extracted = parseExtracted(raw, media);

    // Mídia sem texto: se o modelo não mapeou, tenta associar à próxima pergunta faltante.
    const provisional =
      extracted.answers.length > 0
        ? extracted.answers
        : media.type !== 'text' && media.mediaUrl
          ? autoAssignMedia(input.context.missing, media)
          : [];

    const accepted = filterAccepted(provisional, questions, media);
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

    let reply =
      extracted.reply.trim() ||
      defaultReply(questions, answers, missing, complete, media, input.contactName);
    // Se salvou resposta e ainda falta algo, garanta que a reply peça o que falta agora.
    if (!complete && answers.length > 0) {
      reply = ensureMissingAsked(reply, missing, answers, media, input.contactName, questions);
    }

    const presented = coversQuestions(reply, answers.length ? missing : questions);
    await syncCycleProgress(
      input.context.cycle.id,
      complete,
      accepted.length > 0 || alreadySaved.length > 0 || presented,
    );

    return {
      text: reply.slice(0, 1500),
      source: 'model',
      detail: complete ? 'questionário concluído' : `coleta ${media.type}`,
      completed: complete,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha no modelo';
    if (media.type !== 'text' && media.mediaUrl) {
      const auto = filterAccepted(autoAssignMedia(input.context.missing, media), questions, media);
      if (auto.length) {
        const answers = await upsertAnswers(
          input.context.cycle.id,
          auto.map((item) => ({
            questionId: item.questionId,
            text: item.text,
            type: item.type,
            mediaUrl: media.mediaUrl || input.mediaUrl,
          })),
        );
        const missing = missingQuestions(questions, answers);
        const complete = missing.length === 0;
        await syncCycleProgress(input.context.cycle.id, complete, true);
        return {
          text: defaultReply(questions, answers, missing, complete, media, input.contactName),
          source: 'fallback',
          detail,
          completed: complete,
        };
      }
    }
    if (fallback) return { text: fallback, source: 'fallback', detail, completed: false };
    return { text: '', source: 'none', detail, completed: false };
  }
}

function parseExtracted(raw: string, media: MediaUnderstanding): Extracted {
  const jsonText = extractJson(raw);
  if (!jsonText) {
    return { reply: stripJsonNoise(raw), answers: [], complete: false };
  }
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
              questionId: String(row.questionId || ''),
              text: String(row.text || '').trim(),
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

function autoAssignMedia(candidates: QuestionnaireQuestion[], media: MediaUnderstanding): ExtractedAnswer[] {
  if (!media.mediaUrl && !media.summary) return [];
  if (media.type === 'text') return [];
  const eligible = candidates.filter((question) => typeFits(question.expected_type, media.type));
  const target = eligible[0] || candidates[0];
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
  contactName: string,
): string {
  if (complete) return 'Obrigado! Recebi todas as respostas do questionário.';
  if (!answers.length) {
    const name = contactName?.trim().split(/\s+/)[0] || '';
    const hello = name ? `Certo, ${name}!` : 'Certo!';
    const list = questions.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
    return `${hello} Segue o questionário:\n${list}`;
  }
  const thanks =
    media.type === 'audio'
      ? 'Ouvi seu áudio.'
      : media.type === 'image'
        ? 'Recebi a imagem.'
        : media.type === 'video'
          ? 'Recebi o vídeo.'
          : 'Recebi sua mensagem.';
  const pending = missing.map((item, index) => `${index + 1}) ${item.body}`).join('\n');
  return `${thanks} Ainda falta:\n${pending}`;
}

/** Garante que, após salvar respostas parciais, a mensagem peça as faltantes na hora. */
function ensureMissingAsked(
  reply: string,
  missing: QuestionnaireQuestion[],
  answers: CycleAnswer[],
  media: MediaUnderstanding,
  contactName: string,
  questions: QuestionnaireQuestion[],
): string {
  if (!missing.length) return reply;
  if (coversQuestions(reply, missing)) return reply;
  return defaultReply(questions, answers, missing, false, media, contactName);
}

function coversQuestions(reply: string, questions: QuestionnaireQuestion[]): boolean {
  if (!reply.trim() || !questions.length) return false;
  const normalized = reply.toLowerCase();
  return questions.some((question) => {
    const snippet = question.body.trim().slice(0, 24).toLowerCase();
    return snippet.length >= 8 && normalized.includes(snippet);
  });
}

async function syncCycleProgress(cycleId: string, complete: boolean, engaged: boolean): Promise<void> {
  if (complete) {
    await markCycleCompleted(cycleId);
    return;
  }
  // Coleta antecipada: marca como notificado para o disparo agendado não reenviar o questionário.
  if (engaged) await markCycleNotified(cycleId);
}

function stripJsonNoise(raw: string): string {
  return raw.replace(/```json[\s\S]*```/i, '').replace(/\{[\s\S]*\}/, '').trim();
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return '';
}
