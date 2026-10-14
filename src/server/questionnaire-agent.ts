import { completeChat, type ChatMessage } from './agent.js';
import { getSetting, withTransaction } from './db.js';
import { understandInbound, type MediaUnderstanding } from './media-understand.js';
import {
  markCycleCompleted,
  markCycleInProgress,
  missingQuestions,
  upsertAnswers,
  type ActiveCycleContext,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';
import { applyQuestionnaireEdit, isCorrectionOrDeleteRequest } from './questionnaire-edits.js';
import { QuestionnaireTemporarilyUnavailableError } from './questionnaire-errors.js';
import {
  isFullyAnswered,
  looksLikeAnswerPayload,
  looksLikeQuestionnaireEdit,
} from './questionnaire-rules.js';
import {
  acceptedLabel,
  autoAssignMedia,
  filterAccepted,
  heuristicExtractAnswers,
  mergeExtracted,
  normalizeExtractedAnswers,
  parseExtracted,
  salvageExtractAnswers,
  type ExtractedAnswer,
} from './questionnaire-extraction.js';
import {
  detectRfqFieldFromQuestion,
  rfqSeparationPromptLines,
} from './rfq-answer-dictionary.js';
import {
  asksConfirmation,
  asksForMore,
  completionReply,
  defaultQuestionnaireReply,
  ensureMissingAsked,
  formatAnswers,
  mentionsUnderstoodAnswers,
  pretendsToHaveSaved,
} from './questionnaire-replies.js';

export type QuestionnaireDraft = {
  text: string;
  source: 'model' | 'fallback' | 'none';
  detail: string;
  completed: boolean;
};

export async function draftQuestionnaireReply(input: {
  context: ActiveCycleContext;
  contactName: string;
  inbound: string;
  inboundType: string;
  mediaUrl: string;
  history: { direction: string; text: string }[];
  forceCompletedEdit?: boolean;
}): Promise<QuestionnaireDraft> {
  const fallback = getSetting('agent_fallback');
  if (getSetting('agent_active') !== '1') {
    throw new QuestionnaireTemporarilyUnavailableError('Agente de questionário desligado');
  }
  if (!getSetting('agent_api_key')) {
    throw new QuestionnaireTemporarilyUnavailableError('Sem chave do modelo');
  }

  const media = await understandInbound({
    type: input.inboundType,
    text: input.inbound,
    mediaUrl: input.mediaUrl,
  });
  const questions = input.context.questionnaire.questions;
  const alreadySaved = input.context.answers;
  const already = formatAnswers(questions, alreadySaved);
  const pending = input.context.missing.map((item, index) => {
    const field = detectRfqFieldFromQuestion(item);
    const fieldHint = field ? ` campo=${field};` : '';
    return `${index + 1}. [${item.id}]${fieldHint} ${item.body} (aceita: ${acceptedLabel(item.expected_type)})`;
  });

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
    '- Responder várias perguntas numa mensagem só → salve TODAS em "answers" com o questionId correto de cada uma.',
    '- Enviar respostas parciais → salve o que veio em "answers" e na reply peça SÓ o que ainda falta (sem repetir o que já entendeu).',
    '- Fazer pergunta fora do questionário → responda de forma útil e, se ainda faltarem respostas, reconduza com delicadeza.',
    '',
    'Importante:',
    '- Só preencha "answers" quando a mensagem realmente contiver conteúdo de resposta às perguntas.',
    '- Se a mensagem for só intenção, dúvida ou conversa (sem resposta às perguntas), deixe "answers": [].',
    '- Use SEMPRE o questionId exato listado em "Ainda faltam" / perguntas (nunca invente id).',
    '- O campo "answers" é obrigatório para gravar no sistema — a reply sozinha NÃO salva nada.',
    '- Quando for apresentar o questionário, inclua TODAS as perguntas numeradas na "reply".',
    '- Quando já houver respostas salvas e ainda faltarem itens, a "reply" DEVE listar apenas as faltantes.',
    '- NUNCA peça confirmação de respostas já capturadas. Não invente etapa de “confirmar”.',
    '- Se a mensagem cobrir todas as perguntas pendentes: preencha TODOS os "answers", "complete": true, e na reply diga só algo curto como “Anotei tudo, obrigado!” — NÃO repita nem liste as respostas.',
    ...rfqSeparationPromptLines(),
    '- Aceite texto, áudio (já transcrito), imagem (já descrita) e vídeo.',
    '- Não invente respostas. Não mencione que você é um modelo.',
    '',
    `Questionário: ${input.context.questionnaire.name}`,
    `Contato: ${input.contactName || 'não informado'}`,
    'Perguntas do questionário:',
    questions
      .map((item, index) => {
        const field = detectRfqFieldFromQuestion(item);
        const fieldHint = field ? ` | campo=${field}` : '';
        return `${index + 1}. id=${item.id}${fieldHint} | aceita=${item.expected_type} | ${item.body}`;
      })
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

  const amending = input.context.cycle.status === 'completed';
  const wantsEdit =
    input.forceCompletedEdit ||
    looksLikeQuestionnaireEdit(media.type, input.inbound, media.mediaUrl || input.mediaUrl);

  // Ciclo fechado + pedido de editar/complementar/apagar.
  if (amending && wantsEdit) {
    const edited = await applyQuestionnaireEdit({
      cycleId: input.context.cycle.id,
      questions,
      alreadySaved,
      userMessage: input.inbound,
      media,
      mediaUrl: input.mediaUrl,
      contactName: input.contactName,
      occurrenceDate: input.context.cycle.occurrence_date,
    });
    return (
      edited || {
        text: 'Pode repetir a alteração? Quero registrar certinho no questionário.',
        source: 'fallback' as const,
        detail: 'edição sem mudança clara',
        completed: true,
      }
    );
  }

  // Ciclo aberto, mas já há respostas e o usuário pede correção/exclusão.
  if (!amending && alreadySaved.length && isCorrectionOrDeleteRequest(input.inbound)) {
    const edited = await applyQuestionnaireEdit({
      cycleId: input.context.cycle.id,
      questions,
      alreadySaved,
      userMessage: input.inbound,
      media,
      mediaUrl: input.mediaUrl,
      contactName: input.contactName,
      occurrenceDate: input.context.cycle.occurrence_date,
    });
    if (edited) return edited;
  }

  if (amending) {
    // Conversa comum após o ciclo — deixa o agente geral responder.
    return { text: '', source: 'none', detail: 'ciclo já concluído', completed: true };
  }

  // Atalho seguro: respostas claras sem chamar o LLM.
  if (
    !wantsEdit &&
    !isCorrectionOrDeleteRequest(input.inbound) &&
    looksLikeAnswerPayload(media, input.inbound)
  ) {
    const capture = tryHeuristicQuestionnaireCapture({
      questions,
      missing: input.context.missing,
      alreadySaved,
      media,
      inbound: input.inbound,
      contactName: input.contactName,
    });
    if (capture) {
      await persistAcceptedAnswers({
        cycleId: input.context.cycle.id,
        questions,
        alreadySaved,
        accepted: capture.accepted,
        media,
        mediaUrl: input.mediaUrl,
      });
      return {
        text: capture.reply.slice(0, 1500),
        source: 'fallback',
        detail: capture.complete ? 'atalho heuristico concluido' : 'atalho heuristico parcial',
        completed: capture.complete,
      };
    }
  }

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: userContent },
    ];
    const raw = await completeChat(messages, {
      temperature: 0.35,
      timeoutMs: 40_000,
      maxTokens: 220,
    });
    const extracted = parseExtracted(raw, media);

    // Mídia sem texto: se o modelo não mapeou, tenta associar à próxima pergunta faltante.
    let provisional =
      extracted.answers.length > 0
        ? normalizeExtractedAnswers(extracted.answers, questions, input.context.missing)
        : media.type !== 'text' && media.mediaUrl
          ? autoAssignMedia(input.context.missing, media)
          : [];

    let accepted = filterAccepted(provisional, questions, media);

    const acceptedIds = new Set(accepted.map((item) => item.questionId));
    let pendingAfterExtraction = input.context.missing.filter(
      (question) => !acceptedIds.has(question.id),
    );

    // Heurística antes do salvage LLM (evita 2ª chamada na maioria dos casos).
    if (
      pendingAfterExtraction.length &&
      looksLikeAnswerPayload(media, input.inbound) &&
      (accepted.length < input.context.missing.length || mentionsUnderstoodAnswers(extracted.reply))
    ) {
      const heuristicExtra = filterAccepted(
        normalizeExtractedAnswers(
          heuristicExtractAnswers(pendingAfterExtraction, media.summary || input.inbound),
          questions,
          pendingAfterExtraction,
        ),
        questions,
        media,
      );
      if (heuristicExtra.length) {
        accepted = mergeExtracted(accepted, heuristicExtra);
        const acceptedNow = new Set(accepted.map((item) => item.questionId));
        pendingAfterExtraction = input.context.missing.filter(
          (question) => !acceptedNow.has(question.id),
        );
      }

      if (
        pendingAfterExtraction.length &&
        (accepted.length === 0 || mentionsUnderstoodAnswers(extracted.reply))
      ) {
        const salvaged = await salvageExtractAnswers({
          missing: pendingAfterExtraction,
          userMessage: input.inbound,
          media,
        });
        const extra = filterAccepted(
          normalizeExtractedAnswers(salvaged, questions, pendingAfterExtraction),
          questions,
          media,
        );
        if (extra.length) accepted = mergeExtracted(accepted, extra);
      }
    }

    const persisted = await persistAcceptedAnswers({
      cycleId: input.context.cycle.id,
      questions,
      alreadySaved,
      accepted,
      media,
      mediaUrl: input.mediaUrl,
    });
    const { answers, missing, complete } = persisted;

    let reply =
      extracted.reply.trim() ||
      defaultQuestionnaireReply(questions, answers, missing, complete, media, input.contactName);
    if (complete && accepted.length > 0) {
      reply = completionReply(input.contactName);
    } else if (complete) {
      // Já estava completo sem novo save — não inventar "anotei tudo" de novo.
      reply = asksForMore(reply) || asksConfirmation(reply) ? completionReply(input.contactName) : reply;
    } else if (accepted.length > 0) {
      reply = ensureMissingAsked({
        reply,
        missing,
        answers,
        media,
        contactName: input.contactName,
        questions,
      });
    } else if (pretendsToHaveSaved(reply)) {
      // Nunca dizer que gravou se não houve upsert.
      reply = defaultQuestionnaireReply(
        questions,
        answers,
        missing,
        false,
        media,
        input.contactName,
      );
    }

    return {
      text: reply.slice(0, 1500),
      source: 'model',
      detail: complete ? 'questionário concluído' : `coleta ${media.type}`,
      completed: complete,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Falha no modelo';
    throw new QuestionnaireTemporarilyUnavailableError(detail || fallback || 'Falha no modelo');
  }
}

/** Extrai respostas sem LLM; null se a mensagem não casar com o questionário. */
export function tryHeuristicQuestionnaireCapture(input: {
  questions: QuestionnaireQuestion[];
  missing: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  media: MediaUnderstanding;
  inbound: string;
  contactName: string;
}): { accepted: ExtractedAnswer[]; reply: string; complete: boolean } | null {
  if (!input.missing.length) return null;
  let accepted = filterAccepted(
    normalizeExtractedAnswers(
      heuristicExtractAnswers(input.missing, input.media.summary || input.inbound),
      input.questions,
      input.missing,
    ),
    input.questions,
    input.media,
  );
  if (!accepted.length && input.media.type !== 'text' && input.media.mediaUrl) {
    accepted = filterAccepted(
      autoAssignMedia(input.missing, input.media),
      input.questions,
      input.media,
    );
  }
  if (!accepted.length) return null;

  const merged = mergeAnswersForCheck(input.alreadySaved, accepted);
  const missing = missingQuestions(input.questions, merged);
  const complete = isFullyAnswered(input.questions, merged);
  const reply = complete
    ? completionReply(input.contactName)
    : defaultQuestionnaireReply(
        input.questions,
        merged,
        missing,
        false,
        input.media,
        input.contactName,
      );
  return { accepted, reply, complete };
}

function mergeAnswersForCheck(
  alreadySaved: CycleAnswer[],
  accepted: ExtractedAnswer[],
): CycleAnswer[] {
  const byId = new Map(alreadySaved.map((item) => [item.question_id, item]));
  for (const item of accepted) {
    byId.set(item.questionId, {
      id: item.questionId,
      cycle_id: '',
      question_id: item.questionId,
      answer_text: item.text,
      answer_type: item.type,
      media_url: '',
    });
  }
  return [...byId.values()];
}

async function persistAcceptedAnswers(input: {
  cycleId: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  accepted: ExtractedAnswer[];
  media: MediaUnderstanding;
  mediaUrl: string;
}): Promise<{ answers: CycleAnswer[]; missing: QuestionnaireQuestion[]; complete: boolean }> {
  return withTransaction(async () => {
    const answers = input.accepted.length
      ? await upsertAnswers(
          input.cycleId,
          input.accepted.map((item) => ({
            questionId: item.questionId,
            text: item.text,
            type: item.type,
            mediaUrl: item.type === 'text' ? '' : input.media.mediaUrl || input.mediaUrl,
          })),
        )
      : input.alreadySaved;
    let missing = missingQuestions(input.questions, answers);
    const complete = isFullyAnswered(input.questions, answers);
    if (!complete && missing.length === 0) {
      missing = input.questions.filter(
        (question) =>
          !answers.some((row) => row.question_id === question.id && row.answer_text.trim()),
      );
    }
    await syncCycleProgress(
      input.cycleId,
      complete,
      input.accepted.length > 0 || input.alreadySaved.length > 0,
    );
    return { answers, missing, complete };
  });
}

async function syncCycleProgress(cycleId: string, complete: boolean, engaged: boolean): Promise<void> {
  if (complete) {
    await markCycleCompleted(cycleId);
    return;
  }
  if (engaged) await markCycleInProgress(cycleId);
}
