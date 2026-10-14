import { draftReply, type Draft } from './agent.js';
import { getSetting, one, withTransaction } from './db.js';
import { zonedNow } from './clock.js';
import {
  draftQuestionnaireReply,
  type QuestionnaireDraft,
} from './questionnaire-agent.js';
import {
  looksLikeQuestionnaireEdit,
  relativeOccurrenceDate,
} from './questionnaire-rules.js';
import {
  clearConversationCompletedEditContext,
  listCompletedCycleContexts,
  setConversationCycleCandidates,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';
import {
  resolveActiveCycleForConversation,
  type ActiveCycleResolution,
} from './questionnaire-routing.js';
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

  const limit = Number(getSetting('agent_history') || '8');
  const history = (await recentMessages(input.conversationId, limit)).filter(
    (item, index, all) =>
      !(index === all.length - 1 && item.direction === 'INBOUND' && item.text === inboundText),
  );
  const clock = zonedNow();
  const editLike = looksLikeQuestionnaireEdit(inboundType, inboundText, mediaUrl);
  const targetDate = relativeOccurrenceDate(clock.date, inboundText);
  let resolution: ActiveCycleResolution = { ambiguous: [] };
  const completed = contactId && editLike
    ? await listCompletedCycleContexts(contactId, [targetDate])
    : [];
  const explicitlyNamed = selectExplicitlyNamedCycle(completed, inboundText);
  let cycle = explicitlyNamed;

  if (!cycle && editLike && targetDate !== clock.date) {
    if (completed.length === 1) {
      cycle = completed[0];
    } else if (completed.length > 1) {
      resolution = { ambiguous: completed };
      await setConversationCycleCandidates(
        input.conversationId,
        completed.map((item) => item.cycle.id),
      );
    }
  }

  if (!cycle && !resolution.ambiguous.length && contactId) {
    resolution = await resolveActiveCycleForConversation({
      contactId,
      conversationId: input.conversationId,
      date: clock.date,
      weekday: clock.weekday,
      inbound: inboundText,
      includeCompletedContext: editLike,
    });
    cycle = resolution.context;
  }

  if (!cycle && !resolution.ambiguous.length && completed.length) {
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

  let draft: QuestionnaireDraft | Draft | null = resolution.ambiguous.length
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
      ? await draftQuestionnaireReply({
          context: cycle,
          contactName: contact?.name || input.contactName || conversation?.contact_name || '',
          inbound: inboundText,
          inboundType,
          mediaUrl,
          history: history.map((item) => ({ direction: item.direction, text: item.text })),
          forceCompletedEdit: resolution.completedEditContext,
        })
      : null;

  if (
    resolution.completedEditContext &&
    draft?.text &&
    'completed' in draft &&
    draft.completed &&
    draft.detail !== 'edição sem mudança clara'
  ) {
    await clearConversationCompletedEditContext(input.conversationId);
  }

  if (!draft?.text && !cycle) {
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
    });
  }

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
      },
    });
  });
  return { sent: true, text: draft.text, detail: draft.detail, phone, channelId, source: draft.source };
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
