import { draftReply, type Draft } from './agent.js';
import { understandInbound } from './media-understand.js';
import {
  AUDIO_MISSED,
  OFFER_REPEAT_HINT,
  dayChoicePrompt,
  findYesterdayResume,
  readBotMode,
  resumeYesterdayCycle,
  saveBotMode,
  todayCollectionIsOpen,
} from './conversation-mode.js';
import { isMenuKeyword } from './bot-menu-rules.js';
import { onlyOptionNumber } from './forms-bot-fields.js';
import { getSetting, one, withTransaction } from './db.js';
import { zonedNow } from './clock.js';
import {
  buildConversationContextPack,
  pendingPreviousDaysNotice,
  type ConversationContextPack,
} from './conversation-context.js';
import { ensureCycleMaterialized, formsBotCompletionNote } from './forms-bot.js';
import { missingPromptFor, questionIdForCatalogList } from './forms-bot-capture.js';
import { tryFormsCatalogListReply } from './forms-bot-catalog-context.js';
import { formatAgroCatalogList, matchAgroCatalogAsk } from './agro-bot-catalog.js';
import {
  confirmStoredAnswer,
  draftQuestionnaireReply,
  type QuestionnaireDraft,
} from './questionnaire-agent.js';
import {
  parseOccurrenceDateRef,
  splitDatedSegments,
  weekdayFromIsoDate,
} from './questionnaire-dates.js';
import { draftMultiDayQuestionnaireReply } from './questionnaire-multi-day.js';
import { EDIT_NOT_UNDERSTOOD_DETAIL } from './questionnaire-replies.js';
import {
  looksLikeQuestionnaireEdit,
  looksLikeRfqOrRegisterPayload,
  wantsQuestionnaireContext,
} from './questionnaire-rules.js';
import {
  clearConversationCompletedEditContext,
  getCycleContextsByIds,
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
  outboundOffersFormsAgenda,
} from './forms-bot-agenda.js';
import { isFormsCatalogListAsk } from './forms-bot-catalog-context.js';
import { looksLikeHumanHandoff } from './human-handoff.js';
import { tryBotMenu } from './bot-menu.js';
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
  let inboundType = input.inboundType || 'text';
  const mediaUrl = input.mediaUrl || '';
  let inboundText =
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
  const originalInbound = inboundText;
  const history = (await recentMessages(input.conversationId, limit)).filter(
    (item, index, all) =>
      !(index === all.length - 1 && item.direction === 'INBOUND' && item.text === originalInbound),
  );
  let audioMissed = false;
  if (inboundType === 'audio' && mediaUrl) {
    const heard = await understandInbound({ type: inboundType, text: input.text.trim(), mediaUrl });
    if (!heard.transcript) audioMissed = true;
    else {
      inboundText = heard.transcript;
      inboundType = 'text';
    }
  }
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
  // O pacote de 7 dias só entra quando a resposta vai ao modelo. Menu, agenda e número não esperam isso.
  let contextPack: ConversationContextPack | undefined;
  const loadContextPack = async (): Promise<ConversationContextPack> => {
    if (contextPack) return contextPack;
    contextPack = contactId
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
    return contextPack;
  };

  let cycle: ActiveCycleContext | undefined;
  let draft: QuestionnaireDraft | Draft | null = null;
  let formReply = false;
  let offerAppended = false;

  const lastBotText = lastOutboundText(historyRows);

  if (audioMissed) {
    draft = {
      text: AUDIO_MISSED,
      source: 'fallback',
      detail: 'áudio sem transcrição',
      completed: false,
    };
  } else if (contactId && !isMenuKeyword(inboundText)) {
    const exclusive = await routeExclusiveMode({
      conversationId: input.conversationId,
      contactId,
      contactName,
      today: clock.date,
      weekday: clock.weekday,
      minutes: clock.minutes,
      inbound: inboundText,
      otherDay: otherDayIntent,
    });
    if (exclusive) {
      draft = {
        text: exclusive.text,
        source: 'fallback',
        detail: exclusive.detail,
        completed: exclusive.completed,
      };
      if (exclusive.cycle) cycle = exclusive.cycle;
    }
  }

  // Sem pergunta aberta, o menu abre. Com formulário ou agenda abertos, a mensagem é a resposta.
  if (!draft && contactId) {
    const menu = await tryBotMenu({
      contactId,
      contactName,
      conversationId: input.conversationId,
      messageId: input.messageId,
      inbound: inboundText,
      inboundType,
      mediaUrl,
      date: clock.date,
      minutes: clock.minutes,
      lastBotText,
    });
    formReply = menu.detail === 'menu: resposta do formulário';
    if (menu.handled) {
      draft = { text: menu.text, source: 'fallback', detail: menu.detail, completed: false };
      if (menu.cycle) cycle = menu.cycle;
    }
  }

  const agendaOfferOpen =
    !draft &&
    !multiDayIntent &&
    !otherDayIntent &&
    !isFormsCatalogListAsk(inboundText) &&
    outboundOffersFormsAgenda(lastBotText);

  // A oferta entre formulários vale mesmo se o envio tiver recolocado o ciclo concluído.
  if (agendaOfferOpen && contactId) {
    const agendaResult = await applyFormsBotAgendaIntent({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      nowMinutes: clock.minutes,
      inbound: inboundText,
      awaitingOffer: true,
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

  const awaitingFormsOffer = !draft && (await isAwaitingQuestionnaireSelection(input.conversationId));

  // Agenda Forms: oferta entre formulários / intenção explícita (pular, trocar, só X…).
  // Pedido de lista de catálogo (“quais fornecedores?”) nunca entra na agenda.
  if (
    !draft &&
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
      conversationId: input.conversationId,
    });
  }

  // Coleta aberta já sabe o ciclo. A lista de concluídos só entra quando a mensagem pode citar outro.
  const completed =
    !draft && contactId && !formReply ? await listCompletedCycleContexts(contactId, [targetDate]) : [];
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
              if (String(cycle.questionnaire.id || '').startsWith('agro-preset:')) {
                const agroAsk = matchAgroCatalogAsk(inboundText);
                if (agroAsk) {
                  const companyId =
                    String(cycle.questionnaire.companyOdooId || '').trim() ||
                    getSetting('odoo_active_company_id', '1') ||
                    '1';
                  const agroList = await formatAgroCatalogList(companyId, agroAsk);
                  await rememberCyclePrompt(
                    cycle.cycle.id,
                    cycle.missing[0]?.id || cycle.questionnaire.questions[0]?.id || '',
                    'reply: lista de catálogo Agro',
                  );
                  return {
                    text: `${agroList}\n\nQuando terminar, responda a pergunta atual.`,
                    source: 'fallback' as const,
                    detail: `listagem de catálogo Agro (${agroAsk})`,
                    completed: cycle.cycle.status === 'completed',
                  };
                }
              }
              const catalogList = await tryFormsCatalogListReply({
                inbound: inboundText,
                questionnaire: cycle.questionnaire,
                history: historyRows,
              });
              if (catalogList) {
                const notice = pendingPreviousDaysNotice({
                  likelyQuestionnaireAck: false,
                  hasPendingQuestionnaire: false,
                  pendingPreviousDays: [],
                });
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
                conversationId: input.conversationId,
              });
            })()
          : null;
  }

  if (
    resolution.completedEditContext &&
    draft?.text &&
    'completed' in draft &&
    draft.completed &&
    draft.detail !== EDIT_NOT_UNDERSTOOD_DETAIL
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
    await ensureCycleMaterialized(cycle.cycle.id);
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
      offerAppended = true;
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

  // Fora do questionário: repete a pergunta pendente. O agente livre só atende quem não está em coleta.
  if (cycle && (questionnaireDeferred || !draft?.text)) {
    const ask = await missingPromptFor(
      cycle.questionnaire,
      cycle.missing.length ? cycle.missing : cycle.questionnaire.questions,
      cycle.answers,
    );
    draft = {
      text: ask || 'Pode repetir a resposta desta pergunta?',
      source: 'fallback',
      detail: 'pergunta repetida',
      completed: false,
    };
  } else if (!cycle && !draft?.text) {
    const pack = await loadContextPack();
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
      contextBrief: pack.contextBrief,
      hints: pack.hints,
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

  await syncBotMode(input.conversationId, {
    draft,
    cycle,
    offerAppended,
    today: clock.date,
  });

  const handoff = draft.source !== 'model' && looksLikeHumanHandoff(draft.text);
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

async function routeExclusiveMode(input: {
  conversationId: string;
  contactId: string;
  contactName: string;
  today: string;
  weekday: number;
  minutes: number;
  inbound: string;
  otherDay: boolean;
}): Promise<{ text: string; detail: string; completed: boolean; cycle?: ActiveCycleContext } | null> {
  let mode = await readBotMode(input.conversationId);
  if (mode?.kind === 'question' && mode.cycleId) {
    const [open] = await getCycleContextsByIds([mode.cycleId]);
    if (
      !open ||
      open.cycle.occurrence_date < input.today ||
      open.cycle.status === 'failed' ||
      open.cycle.status === 'completed'
    ) {
      mode = undefined;
    } else return null;
  }
  if (mode?.kind === 'menu') return null;
  if (mode?.kind === 'day') {
    const choice = onlyOptionNumber(input.inbound);
    if (choice === '1' && mode.cycleId) {
      const resumed = await resumeYesterdayCycle({
        conversationId: input.conversationId,
        cycleId: mode.cycleId,
        today: input.today,
        contactName: input.contactName,
      });
      return {
        text: resumed.text,
        detail: 'dia: retomou ontem',
        completed: false,
        cycle: resumed.cycle,
      };
    }
    if (choice === '2') {
      await saveBotMode(input.conversationId, { kind: 'menu', dayResolved: input.today });
      return null;
    }
    return {
      text: dayChoicePrompt(mode.names || []),
      detail: 'dia: repetir escolha',
      completed: false,
    };
  }
  if (mode?.kind === 'confirm' && mode.cycleId && mode.questionId && mode.value) {
    const [context] = await getCycleContextsByIds([mode.cycleId]);
    if (onlyOptionNumber(input.inbound) === '1' && context) {
      const saved = await confirmStoredAnswer({
        context,
        questionId: mode.questionId,
        value: mode.value,
        contactName: input.contactName,
      });
      return {
        text: saved.text,
        detail: saved.detail,
        completed: saved.completed,
        cycle: context,
      };
    }
    const ask = context
      ? await missingPromptFor(
          context.questionnaire,
          context.missing.length ? context.missing : context.questionnaire.questions,
          context.answers,
        )
      : 'Pode repetir a resposta?';
    if (context) {
      await saveBotMode(input.conversationId, {
        kind: 'question',
        cycleId: context.cycle.id,
        questionId: context.missing[0]?.id || mode.questionId,
      });
    }
    return {
      text: ['Não anotei.', ask].filter(Boolean).join('\n\n'),
      detail: 'confirmação recusada',
      completed: false,
      cycle: context,
    };
  }
  if (mode?.kind === 'offer') {
    const agenda = await applyFormsBotAgendaIntent({
      contactId: input.contactId,
      conversationId: input.conversationId,
      date: input.today,
      weekday: input.weekday,
      nowMinutes: input.minutes,
      inbound: input.inbound,
      awaitingOffer: true,
    });
    if (!agenda.handled || !agenda.text) {
      await saveBotMode(input.conversationId, { kind: 'menu', dayResolved: input.today });
      return null;
    }
    const unrecognized = String(agenda.detail || '').includes('não reconhecida');
    return {
      text: unrecognized ? `${OFFER_REPEAT_HINT}\n\n${agenda.text}` : agenda.text,
      detail: agenda.detail || 'agenda Forms',
      completed: Boolean(agenda.completed),
      cycle: agenda.cycle,
    };
  }
  if (!mode && !input.otherDay && modeDayUnresolved(mode, input.today)) {
    const openToday = await todayCollectionIsOpen(input.contactId, input.today);
    if (!openToday) {
      const yesterday = await findYesterdayResume(input.contactId, input.today);
      if (yesterday) {
        await saveBotMode(input.conversationId, {
          kind: 'day',
          cycleId: yesterday.cycleId,
          names: yesterday.names,
        });
        return { text: dayChoicePrompt(yesterday.names), detail: 'dia: escolha', completed: false };
      }
    }
  }
  return null;
}

function modeDayUnresolved(mode: { dayResolved?: string } | undefined, today: string): boolean {
  return mode?.dayResolved !== today;
}

async function syncBotMode(
  conversationId: string,
  input: {
    draft: { text?: string; detail?: string; completed?: boolean } | null;
    cycle?: ActiveCycleContext;
    offerAppended: boolean;
    today: string;
  },
): Promise<void> {
  const detail = String(input.draft?.detail || '');
  if (!input.draft?.text) return;
  if (/^(menu:|dia:|áudio)/.test(detail) || detail === 'confirmação de frase' || detail.includes('não reconhecida')) {
    return;
  }
  if (input.offerAppended || detail.includes('agenda Forms oferta')) {
    await saveBotMode(conversationId, { kind: 'offer' });
    return;
  }
  if (input.draft.completed) {
    await saveBotMode(conversationId, { kind: 'menu', dayResolved: input.today });
    return;
  }
  if (detail.startsWith('agenda Forms') && input.cycle && !input.draft.completed) {
    await saveBotMode(conversationId, {
      kind: 'question',
      cycleId: input.cycle.cycle.id,
      questionId:
        input.cycle.missing[0]?.id ||
        input.cycle.cycle.pending_question_id ||
        input.cycle.questionnaire.questions[0]?.id ||
        '',
    });
    return;
  }
  if (detail.startsWith('agenda Forms') && (!input.cycle || input.draft.completed)) {
    await saveBotMode(conversationId, { kind: 'menu', dayResolved: input.today });
    return;
  }
  if (input.cycle) {
    await saveBotMode(conversationId, {
      kind: 'question',
      cycleId: input.cycle.cycle.id,
      questionId:
        input.cycle.missing[0]?.id ||
        input.cycle.cycle.pending_question_id ||
        input.cycle.questionnaire.questions[0]?.id ||
        '',
    });
  }
}

function lastOutboundText(history: { direction: string; text: string }[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].direction === 'OUTBOUND') return history[index].text || '';
  }
  return '';
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
