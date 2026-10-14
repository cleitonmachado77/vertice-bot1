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
  formatBrDate,
  parseOccurrenceDateRef,
  temporalRelation,
  temporalRelationLabel,
} from './questionnaire-dates.js';
import {
  isFullyAnswered,
  looksLikeAnswerPayload,
  looksLikeQuestionnaireEdit,
  looksLikeQuestionnaireMeta,
  looksLikeRfqOrRegisterPayload,
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
} from './questionnaire-replies.js';

export type QuestionnaireDraft = {
  text: string;
  source: 'model' | 'fallback' | 'none';
  detail: string;
  completed: boolean;
  /** Mensagem sem relação com o questionário — reply.ts deve usar o agente geral. */
  deferToFree?: boolean;
};

export async function draftQuestionnaireReply(input: {
  context: ActiveCycleContext;
  contactName: string;
  inbound: string;
  inboundType: string;
  mediaUrl: string;
  history: { direction: string; text: string }[];
  forceCompletedEdit?: boolean;
  /** Só lista as perguntas (ex.: “quais são as perguntas?”). */
  listQuestionsOnly?: boolean;
  /** Data de calendário de hoje (YYYY-MM-DD), para temporalidade. */
  today?: string;
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
  let alreadySaved = input.context.answers;

  const amending = input.context.cycle.status === 'completed';
  const sendTime = input.context.questionnaire.send_time || '';
  const today = input.today || input.context.cycle.occurrence_date;
  const cycleDate = input.context.cycle.occurrence_date;
  const cycleRelation = temporalRelation(today, cycleDate);
  const msgDateRef = parseOccurrenceDateRef(today, input.inbound);

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

  const wantsEdit =
    input.forceCompletedEdit ||
    looksLikeQuestionnaireEdit(media.type, input.inbound, media.mediaUrl || input.mediaUrl) ||
    looksLikeRfqOrRegisterPayload(
      media.type,
      input.inbound,
      media.mediaUrl || input.mediaUrl,
    );

  let seededFromHeuristic = false;

  // Atalhos rápidos (não substituem o julgamento por contexto no LLM).
  if (input.listQuestionsOnly || looksLikeQuestionnaireMeta(input.inbound)) {
    const lines = questions.map((item, index) => `${index + 1}) ${item.body}`);
    const savedList = formatAnswers(questions, alreadySaved);
    const dayLabel = formatBrDate(cycleDate);
    const saved = savedList ? `\n\nJá registradas em ${dayLabel}:\n${savedList}` : '';
    return {
      text: [
        `As perguntas de “${input.context.questionnaire.name}” (${dayLabel}) são:`,
        ...lines,
        saved,
        '',
        amending
          ? 'Se quiser atualizar alguma, diga o número da pergunta e a nova resposta.'
          : 'Pode responder quando quiser — pode mandar tudo de uma vez.',
      ]
        .filter((line) => line !== undefined)
        .join('\n')
        .trim(),
      source: 'fallback',
      detail: 'listagem de perguntas',
      completed: amending,
    };
  }

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
    if (edited && edited.detail !== 'edição sem mudança clara') return edited;

    const capture = tryHeuristicQuestionnaireCapture({
      questions,
      missing: questions,
      alreadySaved,
      media,
      inbound: input.inbound,
      contactName: input.contactName,
    });
    if (capture?.complete) {
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
        detail: 'registro em ciclo concluído',
        completed: true,
      };
    }
    if (capture?.accepted.length) {
      const persisted = await persistAcceptedAnswers({
        cycleId: input.context.cycle.id,
        questions,
        alreadySaved,
        accepted: capture.accepted,
        media,
        mediaUrl: input.mediaUrl,
      });
      alreadySaved = persisted.answers;
      seededFromHeuristic = true;
    }
  }

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

  let captureTargets =
    amending || input.forceCompletedEdit ? questions : missingQuestions(questions, alreadySaved);

  if (
    !isCorrectionOrDeleteRequest(input.inbound) &&
    looksLikeAnswerPayload(media, input.inbound)
  ) {
    const capture = tryHeuristicQuestionnaireCapture({
      questions,
      missing: captureTargets,
      alreadySaved,
      media,
      inbound: input.inbound,
      contactName: input.contactName,
    });
    if (capture?.complete) {
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
        detail: 'atalho heuristico concluido',
        completed: true,
      };
    }
    if (capture?.accepted.length) {
      // Parcial: grava o que a heurística pegou; a IA redige o pedido do restante.
      const persisted = await persistAcceptedAnswers({
        cycleId: input.context.cycle.id,
        questions,
        alreadySaved,
        accepted: capture.accepted,
        media,
        mediaUrl: input.mediaUrl,
      });
      alreadySaved = persisted.answers;
      seededFromHeuristic = true;
      captureTargets =
        amending || input.forceCompletedEdit ? questions : missingQuestions(questions, alreadySaved);
    }
  }

  const already = formatAnswers(questions, alreadySaved);
  const pendingMissing = missingQuestions(questions, alreadySaved);
  const pending = pendingMissing.map((item, index) => {
    const field = detectRfqFieldFromQuestion(item);
    const fieldHint = field ? ` campo=${field};` : '';
    return `${index + 1}. [${item.id}]${fieldHint} ${item.body} (aceita: ${acceptedLabel(item.expected_type)})`;
  });

  const system = [
    'Você é um atendente humano da Vértice acompanhando um questionário no WhatsApp.',
    'Fale em português do Brasil, de forma natural, curta e personalizada.',
    '',
    'Prioridade absoluta: CONTEXTO e intenção da mensagem em relação às perguntas abaixo.',
    'NÃO dependa de palavras-chave, sinônimos pré-mapeados ou frases “oficiais”.',
    'Leia o histórico recente. Se a mensagem IMPLICAR resposta, correção, complemento, listagem ou dúvida sobre qualquer pergunta — mesmo com outras palavras — trate no questionário (related:true).',
    'Exemplos de implicação: “foi o mesmo do João”, “pode anotar o que falei”, “muda só a quantidade”, “recebi 20 kg de plástico” — tudo isso pode ser answer se encaixar nas perguntas.',
    '',
    'Temporalidade (passado / presente / futuro) — obrigatório entender:',
    `- Hoje no calendário: ${today} (${formatBrDate(today)}).`,
    `- Data DESTE ciclo: ${cycleDate} (${formatBrDate(cycleDate)}) → ${temporalRelationLabel(cycleRelation)}.`,
    msgDateRef.explicit
      ? `- A mensagem citou: “${msgDateRef.label}” → ${formatBrDate(msgDateRef.date)} (${temporalRelationLabel(msgDateRef.relation)}).`
      : '- A mensagem não citou outro dia → trate como o dia deste ciclo.',
    '- As respostas que você gravar neste JSON são SEMPRE deste ciclo (data acima), nunca de outro dia.',
    '- Se o ciclo for futuro (ex.: amanhã), registre como previsão/agenda daquele dia e confirme a data na reply (“Anotei para amanhã / 15/10”).',
    '- Se o ciclo for passado (ex.: ontem), trate como correção/complemento daquele dia e confirme (“Atualizei o de ontem”).',
    '- Se o ciclo for hoje, confirme de forma natural sem inventar outro dia.',
    '- Nunca diga que alterou “hoje” se a data do ciclo for outra.',
    '',
    amending
      ? 'Estado: este ciclo já foi marcado como concluído, mas você CONTINUA atento. Pode atualizar respostas ou listar perguntas se o contexto pedir — sem exigir termos especiais de edição.'
      : 'Estado: ciclo em andamento — colete o que faltar com naturalidade.',
    '',
    'Horário agendado do disparo NÃO atrasa a coleta:',
    sendTime
      ? `- Este questionário tem envio previsto às ${sendTime}, mas isso é só um lembrete automático para quem ainda não falou.`
      : '- Pode existir um horário de disparo automático, mas isso é só um lembrete para quem ainda não falou.',
    '- Se a pessoa mandar respostas (ou começar a responder) ANTES desse horário, trate agora: salve o que for resposta e peça na hora o que ainda falta.',
    '- Nunca diga que vai esperar o horário do disparo. Nunca peça para a pessoa aguardar o envio automático.',
    '',
    'Exemplos de cenários (decida caso a caso pelo contexto):',
    '- Pedir para lembrar/listar as perguntas → related:true e liste na reply (numeradas).',
    '- Conteúdo que responde às perguntas (direto ou por paráfrase) → related:true e preencha answers com o questionId certo.',
    '- Confirmar que quer continuar → apresente o questionário completo, numerado.',
    '- Pedir só uma pergunta (“qual é a terceira?”) → responda só essa, com o texto da pergunta.',
    '- Responder várias perguntas numa mensagem só → salve TODAS em "answers" com o questionId correto.',
    '- Resposta parcial (ex.: 3 de 5) → salve o que veio em "answers", complete:false, e na reply peça com naturalidade SÓ o que ainda falta.',
    '- Conversa sem relação com o questionário (ex.: “oi”, horário comercial genérico, assunto outro) → related:false, reply:"", answers:[].',
    '',
    'Importante:',
    '- related=true sempre que o sentido da mensagem tocar nas perguntas — termos exatos NÃO são necessários.',
    '- related=false SOMENTE se for claramente outro assunto — aí outro agente responde.',
    '- Só preencha "answers" quando houver conteúdo de resposta às perguntas.',
    '- Use SEMPRE o questionId exato listado (nunca invente id).',
    '- O campo "answers" é obrigatório para gravar — a reply sozinha NÃO salva nada.',
    '- Quando for apresentar o questionário, inclua TODAS as perguntas numeradas na "reply".',
    '- Você conduz a conversa: se ainda faltarem itens, a reply deve pedir só as faltantes de forma natural (pode listar; não precisa copiar o enunciado palavra por palavra).',
    '- NUNCA diga que anotou tudo se ainda houver itens em “Ainda faltam”.',
    '- NUNCA peça confirmação de respostas já capturadas.',
    '- Se cobrir todas as pendentes: answers completos, complete:true, reply curta (“Anotei tudo, obrigado!”).',
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
    pending.join('\n') || '(nenhuma — ciclo concluído; ainda assim pode atualizar pelo contexto)',
    '',
    'Responda APENAS com JSON válido:',
    '{"related":true,"reply":"mensagem natural","answers":[{"questionId":"id","text":"conteúdo","type":"text|audio|image|video"}],"complete":false}',
  ].join('\n');

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

    if (!extracted.related && extracted.answers.length === 0 && !seededFromHeuristic) {
      return {
        text: '',
        source: 'model',
        detail: 'contexto fora do questionário',
        completed: amending,
        deferToFree: true,
      };
    }

    // Mídia sem texto: se o modelo não mapeou, tenta associar à próxima pergunta faltante.
    let provisional =
      extracted.answers.length > 0
        ? normalizeExtractedAnswers(extracted.answers, questions, captureTargets)
        : media.type !== 'text' && media.mediaUrl
          ? autoAssignMedia(captureTargets, media)
          : [];

    let accepted = filterAccepted(provisional, questions, media);

    const acceptedIds = new Set(accepted.map((item) => item.questionId));
    let pendingAfterExtraction = captureTargets.filter(
      (question) => !acceptedIds.has(question.id),
    );

    // Heurística antes do salvage LLM (evita 2ª chamada na maioria dos casos).
    // Se a heurística inicial já semeou respostas, não reextrai o mesmo texto.
    if (
      !seededFromHeuristic &&
      pendingAfterExtraction.length &&
      looksLikeAnswerPayload(media, input.inbound) &&
      (accepted.length < captureTargets.length || mentionsUnderstoodAnswers(extracted.reply))
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
        pendingAfterExtraction = captureTargets.filter(
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
    if (complete && (accepted.length > 0 || seededFromHeuristic)) {
      reply = completionReply(input.contactName);
    } else if (complete) {
      // Já estava completo sem novo save — não inventar "anotei tudo" de novo.
      reply = asksForMore(reply) || asksConfirmation(reply) ? completionReply(input.contactName) : reply;
    } else {
      // Incompleto: a IA conduz; só cai no template se reply vazia / confirmação / “anotei tudo”.
      reply = ensureMissingAsked({
        reply,
        missing,
        answers,
        media,
        contactName: input.contactName,
        questions,
      });
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
