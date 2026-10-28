import { draftReply, type Draft } from './agent.js';
import { getSetting, one, withTransaction } from './db.js';
import { zonedNow } from './clock.js';
import {
  buildConversationContextPack,
  pendingPreviousDaysNotice,
  type ConversationContextPack,
} from './conversation-context.js';
import { formsBotCompletionNote } from './forms-bot.js';
import { questionIdForCatalogList } from './forms-bot-capture.js';
import { tryFormsCatalogListReply } from './forms-bot-catalog-context.js';
import {
  draftQuestionnaireReply,
  type QuestionnaireDraft,
} from './questionnaire-agent.js';
import {
  parseOccurrenceDateRef,
  splitDatedSegments,
  weekdayFromIsoDate,
} from './questionnaire-dates.js';
import { draftMultiDayQuestionnaireReply } from './questionnaire-multi-day.js';
import {
  looksLikeQuestionnaireEdit,
  looksLikeRfqOrRegisterPayload,
  wantsQuestionnaireContext,
} from './questionnaire-rules.js';
import {
  clearConversationCompletedEditContext,
  listCompletedCycleContexts,
  readCyclePrompt,
  rememberCyclePrompt,
  setConversationCycleCandidates,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';
import {
  listCycleContextsForDate,
  resolveActiveCycleForConversation,
  type ActiveCycleResolution,
} from './questionnaire-routing.js';
import {
  applyFormsBotAgendaIntent,
  isFormsBotQuestionnaire,
  looksLikeFormsBotAgendaMeta,
  offerRemainingFormsBotAgenda,
} from './forms-bot-agenda.js';
import { isFormsCatalogListAsk } from './forms-bot-catalog-context.js';
import { looksLikeHumanHandoff } from './human-handoff.js';
import { enqueueOutbound } from './outbound-outbox.js';
import {
  getContact,
  getConversation,
  hasEvent,
  insertEvent,
  recentMessages,
  setAwaitingHuman,
} from './store.js';

const RECENT_MS = 30 * 60 * 1000;

export type AgentAnswer = {
  sent: boolean;
  text: string;
  detail: string;
  phone: string;
  channelId: string;
  source: string;
};

export type AnswerInboundInput = {
  messageId: string;
  conversationId: string;
  text: string;
  createdAt?: string;
  phone?: string;
  channelId?: string;
  contactId?: string;
  contactName?: string;
  inboundType?: string;
  mediaUrl?: string;
};

export async function answerInbound(input: AnswerInboundInput): Promise<AgentAnswer> {
  return answerInboundTransaction(input);
}

async function answerInboundTransaction(input: AnswerInboundInput): Promise<AgentAnswer> {
  const empty = (detail: string): AgentAnswer => ({
    sent: false,
    text: '',
    detail,
    phone: input.phone || '',
    channelId: input.channelId || '',
    source: 'none',
  });
  const inboundType = input.inboundType || 'text';
  const mediaUrl = input.mediaUrl || '';
  const inboundText =
    input.text.trim() ||
    (mediaUrl
      ? inboundType === 'audio'
        ? 'O contato enviou um áudio.'
        : inboundType === 'image'
          ? 'O contato enviou uma imagem.'
          : inboundType === 'video'
            ? 'O contato enviou um vídeo.'
            : 'O contato enviou uma mídia.'
      : '');
  if (!input.messageId || !input.conversationId || !inboundText) return empty('Mensagem sem conteúdo');
  if (inboundText.includes('Unsupported message')) return empty('Mensagem não suportada pelo WhatsApp');
  if (input.createdAt && !isRecent(input.createdAt)) return empty('Mensagem antiga');
  const storedAt = await messageTime(input.messageId);
  const createdAt = storedAt || input.createdAt || '';
  if (createdAt && !isRecent(createdAt)) return empty('Mensagem antiga');

  const marker = `agent-reply:${input.messageId}`;
  if (await hasEvent(marker)) return empty('Resposta já enfileirada');
  const followed = createdAt ? await hasLaterOutbound(input.conversationId, createdAt) : false;
  if (followed) return empty('Conversa já seguida');

  const conversation = await getConversation(input.conversationId);
  const contactId = input.contactId || conversation?.contact_id || '';
  const contact = contactId ? await getContact(contactId) : undefined;
  if (Number(contact?.hidden) === 1) return empty('Contato excluído');
  if (contact && !contact.bot_enabled) return empty('Bot pausado neste contato');
  if (contact?.human_handoff) return empty('Humano assumiu a conversa');

  const phone = input.phone || conversation?.contact_phone || contact?.phone || '';
  const channelId = input.channelId || conversation?.channel_id || getSetting('nevoa_channel_id');
  if (!phone) return empty('Contato sem telefone');

  const limit = Number(getSetting('agent_history') || '16');
  const history = (await recentMessages(input.conversationId, limit)).filter(
    (item, index, all) =>
      !(index === all.length - 1 && item.direction === 'INBOUND' && item.text === inboundText),
  );
  const clock = zonedNow();
  const editLike = looksLikeQuestionnaireEdit(inboundType, inboundText, mediaUrl);
  const dateSegments = splitDatedSegments(clock.date, inboundText);
  const dateRef = parseOccurrenceDateRef(clock.date, inboundText);
  const targetDate = dateRef.date;
  const questionnaireIntent =
    editLike ||
    wantsQuestionnaireContext(inboundType, inboundText, mediaUrl) ||
    looksLikeRfqOrRegisterPayload(inboundType, inboundText, mediaUrl);
  const multiDayDates = [
    ...new Set(dateSegments.filter((item) => item.explicit).map((item) => item.date)),
  ];
  const multiDayIntent = multiDayDates.length > 1 && questionnaireIntent;
  const pointedToOtherDay = dateRef.explicit && targetDate !== clock.date;
  const otherDayIntent = pointedToOtherDay && questionnaireIntent && !multiDayIntent;
  let resolution: ActiveCycleResolution = { ambiguous: [] };
  const contactName =
    contact?.name || input.contactName || conversation?.contact_name || '';
  const historyRows = history.map((item) => ({ direction: item.direction, text: item.text }));
  const contextPack: ConversationContextPack = contactId
    ? await buildConversationContextPack({
        contactId,
        today: clock.date,
        inbound: inboundText,
        history: historyRows,
        lookbackDays: 7,
      })
    : {
        history: historyRows,
        contextBrief: '',
        hints: {
          likelyQuestionnaireAck: false,
          hasPendingQuestionnaire: false,
          pendingPreviousDays: [],
        },
        pendingCycles: [],
      };

  let cycle: ActiveCycleContext | undefined;
  let draft: QuestionnaireDraft | Draft | null = null;
  const awaitingFormsOffer = await isAwaitingQuestionnaireSelection(input.conversationId);

  // Agenda Forms: oferta entre formulários / intenção explícita (pular, trocar, só X…).
  // Pedido de lista de catálogo (“quais fornecedores?”) nunca entra na agenda.
  if (
    !multiDayIntent &&
    !otherDayIntent &&
    contactId &&
    !isFormsCatalogListAsk(inboundText) &&
    (awaitingFormsOffer || looksLikeFormsBotAgendaMeta(inboundText, { awaitingOffer: awaitingFormsOffer }))
  ) {
    const agendaResult = await applyFormsBotAgendaIntent({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      nowMinutes: clock.minutes,
      inbound: inboundText,
      awaitingOffer: awaitingFormsOffer,
    });
    if (agendaResult.handled && agendaResult.text) {
      draft = {
        text: agendaResult.text,
        source: 'fallback',
        detail: agendaResult.detail || 'agenda Forms',
        completed: Boolean(agendaResult.completed),
      };
      if (agendaResult.cycle) cycle = agendaResult.cycle;
    }
  }

  // Várias datas na mesma mensagem → um ciclo por data.
  if (!draft && multiDayIntent && contactId) {
    draft = await draftMultiDayQuestionnaireReply({
      contactId,
      contactName,
      segments: dateSegments,
      inboundType,
      mediaUrl,
      history: historyRows,
      today: clock.date,
    });
  }

  // Sempre carrega ciclos do dia alvo (inclui concluídos): o agente de questionário decide pelo contexto.
  const completed =
    !draft && contactId ? await listCompletedCycleContexts(contactId, [targetDate]) : [];
  const explicitlyNamed = !draft ? selectExplicitlyNamedCycle(completed, inboundText) : undefined;
  cycle = cycle || explicitlyNamed;

  // Passado/futuro explícito (ontem, amanhã, 15/10, sexta…): grava naquela data.
  if (!draft && !cycle && !resolution.ambiguous.length && contactId && otherDayIntent) {
    const otherDay = await listCycleContextsForDate(
      contactId,
      targetDate,
      weekdayFromIsoDate(targetDate),
      true,
    );
    if (otherDay.length === 1) {
      cycle = otherDay[0];
    } else if (otherDay.length > 1) {
      resolution = { ambiguous: otherDay };
      await setConversationCycleCandidates(
        input.conversationId,
        otherDay.map((item) => item.cycle.id),
      );
    } else if (completed.length === 1) {
      cycle = completed[0];
    } else if (completed.length > 1) {
      resolution = { ambiguous: completed };
      await setConversationCycleCandidates(
        input.conversationId,
        completed.map((item) => item.cycle.id),
      );
    }
  }

  if (!draft && !cycle && !resolution.ambiguous.length && contactId && !otherDayIntent) {
    resolution = await resolveActiveCycleForConversation({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      inbound: inboundText,
      includeCompletedContext: true,
    });
    cycle = resolution.context;
  }

  if (!draft && !cycle && !resolution.ambiguous.length && completed.length && !otherDayIntent) {
    if (completed.length === 1) {
      cycle = completed[0];
    } else {
      resolution = { ambiguous: completed };
      await setConversationCycleCandidates(
        input.conversationId,
        completed.map((item) => item.cycle.id),
      );
    }
  }

  // Mid-coleta: troca/pulo explícito de formulário Forms.
  if (
    !draft &&
    cycle &&
    contactId &&
    !otherDayIntent &&
    isFormsBotQuestionnaire(cycle.questionnaire) &&
    !isFormsCatalogListAsk(inboundText) &&
    looksLikeFormsBotAgendaMeta(inboundText)
  ) {
    const agendaResult = await applyFormsBotAgendaIntent({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      nowMinutes: clock.minutes,
      inbound: inboundText,
      awaitingOffer: false,
    });
    if (agendaResult.handled && agendaResult.text) {
      draft = {
        text: agendaResult.text,
        source: 'fallback',
        detail: agendaResult.detail || 'agenda Forms',
        completed: Boolean(agendaResult.completed),
      };
      if (agendaResult.cycle) cycle = agendaResult.cycle;
    }
  }

  if (!draft) {
    draft = resolution.ambiguous.length
      ? {
          text: [
            'Encontrei mais de um questionário possível. Qual deseja responder ou atualizar?',
            ...resolution.ambiguous.map((item, index) => `${index + 1}) ${item.questionnaire.name}`),
          ].join('\n'),
          source: 'fallback' as const,
          detail: 'seleção de questionário necessária',
          completed: false,
        }
      : resolution.selectionConsumed && cycle
        ? {
            text: cycle.cycle.status === 'completed'
              ? `Certo! O que deseja corrigir em “${cycle.questionnaire.name}”? Informe o número da pergunta e a nova resposta.`
              : [
                  `Certo! Vamos responder “${cycle.questionnaire.name}”:`,
                  ...cycle.missing.map((item, index) => `${index + 1}) ${item.body}`),
                ].join('\n'),
            source: 'fallback' as const,
            detail: 'questionário selecionado',
            completed: false,
          }
        : cycle
          ? await (async () => {
              const catalogList = await tryFormsCatalogListReply({
                inbound: inboundText,
                questionnaire: cycle.questionnaire,
                history: historyRows,
              });
              if (catalogList) {
                const notice = pendingPreviousDaysNotice(contextPack.hints);
                await rememberCyclePrompt(
                  cycle.cycle.id,
                  questionIdForCatalogList(cycle.questionnaire, catalogList) ||
                    cycle.missing[0]?.id ||
                    cycle.questionnaire.questions[0]?.id ||
                    '',
                  'reply: lista de catálogo',
                );
                return {
                  text: [catalogList, notice].filter(Boolean).join('\n\n'),
                  source: 'fallback' as const,
                  detail: 'listagem de catálogo Forms',
                  completed: cycle.cycle.status === 'completed',
                };
              }
              return draftQuestionnaireReply({
                context: cycle,
                contactName,
                inbound: inboundText,
                inboundType,
                mediaUrl,
                history: historyRows,
                forceCompletedEdit: resolution.completedEditContext,
                today: clock.date,
                contextBrief: contextPack.contextBrief,
                hints: contextPack.hints,
              });
            })()
          : null;
  }

  if (
    resolution.completedEditContext &&
    draft?.text &&
    'completed' in draft &&
    draft.completed &&
    draft.detail !== 'edição sem mudança clara'
  ) {
    await clearConversationCompletedEditContext(input.conversationId);
  }

  // Prensagem recém-concluída: devolve o balanço (kg de entrada → fardos, rejeito, estoque).
  if (
    draft?.text &&
    'completed' in draft &&
    draft.completed &&
    cycle &&
    cycle.cycle.status !== 'completed' &&
    cycle.questionnaire.formKind === 'production'
  ) {
    const note = await formsBotCompletionNote(cycle.cycle.id).catch(() => '');
    if (note) draft = { ...draft, text: `${draft.text}\n\n${note}` };
  }

  // Após concluir um Forms Bot, oferece os outros pendentes do dia.
  if (
    draft?.text &&
    'completed' in draft &&
    draft.completed &&
    contactId &&
    cycle &&
    isFormsBotQuestionnaire(cycle.questionnaire) &&
    !String(draft.detail || '').startsWith('agenda Forms')
  ) {
    const offer = await offerRemainingFormsBotAgenda({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      nowMinutes: clock.minutes,
      excludeCycleId: cycle.cycle.id,
    });
    if (offer.text) {
      draft = {
        ...draft,
        text: `${draft.text}\n\n${offer.text}`,
        detail: `${draft.detail} · agenda Forms oferta`,
        completed: false,
      };
    }
  }

  const questionnaireDeferred =
    Boolean(draft && 'deferToFree' in draft && (draft as QuestionnaireDraft).deferToFree);

  // Sem ciclo, ou questionário julgou fora de contexto → agente geral.
  if ((!cycle && !draft?.text) || questionnaireDeferred) {
    draft = await draftReply({
      contactName: contact?.name || input.contactName || conversation?.contact_name || '',
      contactPhone: phone,
      notes: contact?.notes || '',
      instructions: contact?.instructions || '',
      prompt: contact?.prompt || '',
      history: history.map((item) => ({ direction: item.direction, text: item.text })),
      inbound: inboundText,
      hasText: true,
      allowReply: true,
      contextBrief: contextPack.contextBrief,
      hints: contextPack.hints,
    });
  }

  const pendingQuestion = await pendingQuestionTrace(cycle);
  if (!draft?.text) {
    await withTransaction(async () => {
      await insertEvent({
        id: marker,
        event: 'message.received',
        status: 'ignore',
        summary: draft?.detail || 'Sem resposta',
        payload: { messageId: input.messageId, conversationId: input.conversationId },
        result: {
          action: 'ignore',
          source: draft?.source || 'none',
          mode: cycle ? 'questionnaire' : 'free',
          cycleId: cycle?.cycle.id,
          pendingQuestion,
        },
      });
    });
    return empty(draft?.detail || 'Sem resposta');
  }

  const handoff = looksLikeHumanHandoff(draft.text);
  await withTransaction(async () => {
    await enqueueOutbound({
      dedupeKey: marker,
      kind: 'text',
      phone,
      channelId,
      conversationId: input.conversationId,
      contactId,
      cycleId: cycle?.cycle.id,
      text: draft.text,
      origin: 'agent',
      raw: {
        source: draft.source,
        messageId: input.messageId,
        mode: cycle ? 'questionnaire' : 'free',
        cycleId: cycle?.cycle.id,
        humanHandoff: handoff,
      },
    });
    if (handoff && contactId) await setAwaitingHuman(contactId, true);
    await insertEvent({
      id: marker,
      event: 'message.received',
      status: 'queued',
      summary: handoff ? `${draft.detail} · handoff humano` : draft.detail,
      payload: { messageId: input.messageId, conversationId: input.conversationId },
      result: {
        action: 'reply',
        source: draft.source,
        text: draft.text,
        humanHandoff: handoff,
        mode: cycle
          ? 'questionnaire'
          : resolution.ambiguous.length
            ? 'questionnaire-selection'
            : 'free',
        cycleId: cycle?.cycle.id,
        pendingQuestion,
      },
    });
  });
  return { sent: true, text: draft.text, detail: draft.detail, phone, channelId, source: draft.source };
}

/** Pergunta pendente antes/depois da resposta — diagnóstico de captura no evento. */
async function pendingQuestionTrace(cycle: ActiveCycleContext | undefined) {
  if (!cycle) return undefined;
  return {
    before: {
      questionId: cycle.cycle.pending_question_id || '',
      setBy: cycle.cycle.pending_question_set_by || '',
    },
    after: await readCyclePrompt(cycle.cycle.id),
  };
}

async function isAwaitingQuestionnaireSelection(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  const row = await one<{ awaiting_selection: number }>(
    `SELECT awaiting_selection FROM conversation_questionnaire_context WHERE conversation_id = $1`,
    [conversationId],
  );
  return Number(row?.awaiting_selection) === 1;
}

async function messageTime(messageId: string): Promise<string> {
  const row = await one<{ created_at: string }>('SELECT created_at FROM messages WHERE id = $1', [messageId]);
  return row?.created_at || '';
}

function isRecent(value: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && Date.now() - at <= RECENT_MS;
}

function selectExplicitlyNamedCycle(
  candidates: ActiveCycleContext[],
  inbound: string,
): ActiveCycleContext | undefined {
  const normalizedInbound = ` ${foldText(inbound)} `;
  const matches = candidates.filter((item) => {
    const name = foldText(item.questionnaire.name);
    return Boolean(name) && normalizedInbound.includes(` ${name} `);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function hasLaterOutbound(conversationId: string, createdAt: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM messages
     WHERE conversation_id = $1 AND direction = 'OUTBOUND' AND created_at > $2
     LIMIT 1`,
    [conversationId, createdAt],
  );
  return Boolean(row);
}
