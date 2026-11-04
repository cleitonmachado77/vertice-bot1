import { completeChat } from './agent.js';
import { getSetting, many, one, run } from './db.js';
import { KIND_LABELS, isFormKind } from './forms-fields.js';
import {
  buildFormsBotAgendaItems,
  formatFormsBotAgendaIntro,
  outboundOffersFormsAgenda,
  unskipFormsBotQuestionnaire,
} from './forms-bot-agenda.js';
import { formsAnswersSummary } from './forms-bot-closing.js';
import {
  buildFormMenu,
  buildKindMenu,
  buildMainMenu,
  formatMenu,
  isBotAsking,
  isContactOpener,
  isLikelyFormAnswer,
  isMenuKeyword,
  parseMenuDecision,
  isShortMenuReply,
  matchMenuOption,
  menuGreeting,
  normalizeMenuForms,
  singleRegisterOption,
  type MenuCycle,
  type MenuCycleStatus,
  type MenuForm,
  type MenuNode,
  type MenuOption,
} from './bot-menu-rules.js';
import {
  getOrCreateCycle,
  getQuestionnaireForCycle,
  listCycleAnswers,
  setConversationCycleContext,
  toCycleContext,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';
import { looksLikeRfqOrRegisterPayload } from './questionnaire-rules.js';
import { setAwaitingHuman } from './store.js';

/** Menu aberto vale por este tempo; depois, número volta a ser resposta comum. */
const MENU_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MENU_INTRO = 'O que deseja fazer hoje?';

export type BotMenuSettings = {
  enabled: boolean;
  intro: string;
  sessionHours: number;
  attendant: boolean;
};

export function botMenuSettings(): BotMenuSettings {
  const hours = Number(getSetting('bot_menu_session_hours', '2'));
  return {
    enabled: getSetting('bot_menu_enabled', '1') === '1',
    intro: getSetting('bot_menu_intro').trim() || DEFAULT_MENU_INTRO,
    sessionHours: Number.isFinite(hours) ? Math.min(48, Math.max(0.25, hours)) : 2,
    attendant: getSetting('bot_menu_attendant', '1') !== '0',
  };
}

export type BotMenuResult =
  | { handled: false; detail?: string }
  | { handled: true; text: string; detail: string; cycle?: ActiveCycleContext };

type MenuState = { node: MenuNode; shownAt: string };

type MenuInput = {
  contactId: string;
  contactName: string;
  conversationId: string;
  messageId: string;
  inbound: string;
  inboundType: string;
  mediaUrl: string;
  date: string;
  minutes: number;
  /** Última mensagem do bot, para saber se o usuário está respondendo ou chamando. */
  lastBotText?: string;
};

export async function tryBotMenu(input: MenuInput): Promise<BotMenuResult> {
  const settings = botMenuSettings();
  if (!settings.enabled || !input.contactId || !input.conversationId) return { handled: false };

  const forms = await listMenuForms(input.contactId);
  if (!forms.length) {
    await clearMenuState(input.conversationId);
    return { handled: false, detail: 'menu: contato sem formulários' };
  }

  const payload = looksLikeRfqOrRegisterPayload(input.inboundType, input.inbound, input.mediaUrl);
  const cycles = await listTodayCycles(input.contactId, input.date);
  const mainTitle = settings.intro;
  const showMain = async (hint = '', greet = false): Promise<BotMenuResult> => {
    const node = buildMainMenu({ forms, cycles, attendant: settings.attendant, title: mainTitle });
    await clearAgendaSelection(input.conversationId);
    await saveMenuState(input.conversationId, node);
    return {
      handled: true,
      text: formatMenu(node, { hint, greeting: greet ? menuGreeting(input.contactName, input.minutes) : '' }),
      detail: 'menu: principal',
    };
  };

  if (isMenuKeyword(input.inbound)) return showMain();

  const lastBotText = input.lastBotText || '';
  const agendaOffer = outboundOffersFormsAgenda(lastBotText);
  const answering =
    isLikelyFormAnswer(input.inbound, lastBotText) ||
    (Boolean(input.inboundType !== 'text' && input.mediaUrl) && isBotAsking(lastBotText)) ||
    (Boolean(payload) && isBotAsking(lastBotText) && /\d/.test(input.inbound));

  const state = agendaOffer ? undefined : await readMenuState(input.conversationId, input.contactId);
  if (agendaOffer) await clearMenuState(input.conversationId);
  if (state) {
    const option = matchMenuOption(input.inbound, state.node);
    if (option) return runOption(option, state.node, { input, forms, cycles, settings, showMain });
  }

  // Resposta da pergunta que o bot fez: segue o formulário. O resto, se parte do usuário, abre o menu.
  if (answering) {
    if (state) await clearMenuState(input.conversationId);
    return { handled: false, detail: 'menu: resposta do formulário' };
  }

  const showMenu = await userIsReachingAgent(input.inbound, lastBotText);
  if (showMenu) return showMain('', true);

  if (state) {
    if (isShortMenuReply(input.inbound)) {
      await saveMenuState(input.conversationId, state.node);
      return {
        handled: true,
        text: formatMenu(state.node, { hint: 'Não entendi a opção.' }),
        detail: 'menu: opção não reconhecida',
      };
    }
    await clearMenuState(input.conversationId);
  }
  return { handled: false, detail: 'menu: resposta do formulário' };
}

/**
 * O modelo entende se a pessoa está chamando o agente (qualquer frase)
 * ou só respondendo a pergunta pendente.
 * Sem modelo: saudação e fala solta abrem o menu; pergunta pendente ambígua não.
 */
async function userIsReachingAgent(inbound: string, lastBotText: string): Promise<boolean> {
  if (isContactOpener(inbound)) return true;
  if (!isBotAsking(lastBotText)) return true;
  if (getSetting('agent_active') !== '1' || !getSetting('agent_api_key')) return false;
  try {
    const raw = await completeChat(
      [
        {
          role: 'system',
          content: [
            'Você decide se o menu de formulários deve aparecer.',
            'A pessoa tem formulários disponíveis. Se a mensagem PARTE DELA — ela chama o agente, cumprimenta de qualquer jeito, pede ajuda, quer começar, mudar de assunto ou conversar — o menu aparece.',
            'Se a mensagem RESPONDE o que o bot acabou de perguntar (número, quantidade, produto, sim/não, correção do que foi pedido), o menu não aparece.',
            'Responda só JSON: {"menu": true} ou {"menu": false}.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Última mensagem do bot:\n${lastBotText.slice(0, 800)}\n\nMensagem do usuário:\n${inbound.slice(0, 500)}`,
        },
      ],
      { temperature: 0, timeoutMs: 12_000, maxTokens: 40 },
    );
    const decision = parseMenuDecision(raw);
    return decision === true;
  } catch {
    return false;
  }
}

/**
 * Disparo agendado: em vez de mandar cada formulário, manda o menu principal
 * (com os pendentes do dia marcados) e deixa ele aberto para a resposta numerada.
 */
export async function buildMenuKickoff(input: {
  contactId: string;
  contactName: string;
  conversationId: string;
  date: string;
  minutes: number;
}): Promise<string> {
  const settings = botMenuSettings();
  const forms = await listMenuForms(input.contactId);
  if (!forms.length) return '';
  const cycles = await listTodayCycles(input.contactId, input.date);
  const node = buildMainMenu({ forms, cycles, attendant: settings.attendant, title: settings.intro });
  if (input.conversationId) {
    await clearAgendaSelection(input.conversationId);
    await saveMenuState(input.conversationId, node);
  }
  return formatMenu(node, { greeting: menuGreeting(input.contactName, input.minutes) });
}

async function runOption(
  option: MenuOption,
  current: MenuNode,
  ctx: {
    input: MenuInput;
    forms: MenuForm[];
    cycles: MenuCycle[];
    settings: BotMenuSettings;
    showMain: (hint?: string, greet?: boolean) => Promise<BotMenuResult>;
  },
): Promise<BotMenuResult> {
  const { input, forms, cycles } = ctx;
  if (option.action === 'back') {
    if (!current.parent || current.parent === 'main') return ctx.showMain();
    return showNode(input.conversationId, resolveNode(current.parent, forms, cycles, ctx.settings));
  }
  if (option.action === 'node' && option.target) {
    const node = resolveNode(option.target, forms, cycles, ctx.settings, current.node);
    const only = singleRegisterOption(node);
    if (only) return runOption(only, node, ctx);
    return showNode(input.conversationId, node);
  }
  if (option.action === 'human') {
    await clearMenuState(input.conversationId);
    await setAwaitingHuman(input.contactId, true);
    return {
      handled: true,
      text: 'Certo! Vou chamar um atendente. Em instantes alguém da equipe continua com você por aqui.',
      detail: 'menu: atendente',
    };
  }

  const form = forms.find((item) => item.questionnaireId === option.target);
  if (!form) return ctx.showMain('Esse formulário não está mais disponível.');
  const context = await openCycleContext(form.questionnaireId, input.contactId, input.date);
  if (!context) return ctx.showMain('Esse formulário está sem perguntas configuradas.');
  const label = `${KIND_LABELS[form.kind]} · ${form.name}`;
  const summary = formsAnswersSummary(context.questionnaire.questions, context.answers);

  if (option.action === 'view') {
    const node = buildFormMenu(form, cycles, current.parent || 'main');
    await saveMenuState(input.conversationId, node);
    return {
      handled: true,
      text: formatMenu(node, { hint: summary ? `Registro de hoje — ${label}: ${summary}.` : `Ainda não há respostas em “${label}” hoje.` }),
      detail: 'menu: ver registro',
    };
  }

  await clearMenuState(input.conversationId);
  await unskipFormsBotQuestionnaire(input.contactId, input.date, form.questionnaireId);
  await setConversationCycleContext(input.conversationId, context.cycle.id);

  if (option.action === 'correct' || context.cycle.status === 'completed') {
    const ask =
      option.action === 'correct'
        ? 'O que deseja corrigir? Ex.: “corrigir fornecedor para MUNICIPIO DE CAMBE” ou “corrigir manga para 30 kg”.'
        : 'Envie os itens que quer acrescentar (ex.: “10 kg de banana”) ou o que deseja corrigir.';
    return {
      handled: true,
      cycle: context,
      text: [`“${label}” de hoje já está registrado${summary ? `: ${summary}` : ''}.`, ask].join('\n'),
      detail: option.action === 'correct' ? 'menu: corrigir registro' : 'menu: acrescentar itens',
    };
  }

  const [item] = buildFormsBotAgendaItems([context], new Set(), input.minutes);
  return {
    handled: true,
    cycle: context,
    text: await formatFormsBotAgendaIntro(item),
    detail: 'menu: formulário iniciado',
  };
}

function resolveNode(
  target: string,
  forms: MenuForm[],
  cycles: MenuCycle[],
  settings: BotMenuSettings,
  parent = 'main',
): MenuNode {
  if (target.startsWith('kind:')) {
    const kind = target.slice('kind:'.length);
    if (isFormKind(kind)) return buildKindMenu(kind, forms, cycles);
  }
  if (target.startsWith('form:')) {
    const form = forms.find((item) => item.questionnaireId === target.slice('form:'.length));
    if (form) return buildFormMenu(form, cycles, parent);
  }
  return buildMainMenu({ forms, cycles, attendant: settings.attendant, title: settings.intro });
}

async function showNode(conversationId: string, node: MenuNode): Promise<BotMenuResult> {
  await saveMenuState(conversationId, node);
  return { handled: true, text: formatMenu(node), detail: `menu: ${node.node}` };
}

async function openCycleContext(
  questionnaireId: string,
  contactId: string,
  date: string,
): Promise<ActiveCycleContext | undefined> {
  const cycle = await getOrCreateCycle(questionnaireId, contactId, date);
  const questionnaire = await getQuestionnaireForCycle(cycle);
  if (!questionnaire?.questions.length) return undefined;
  return toCycleContext(cycle, questionnaire, await listCycleAnswers(cycle.id));
}

/** Padrões Forms com Bot atribuídos ao contato — em qualquer dia da semana. */
async function listMenuForms(contactId: string): Promise<MenuForm[]> {
  const rows = await many<{ questionnaire_id: string; name: string; form_kind: string }>(
    `SELECT q.id AS questionnaire_id, q.name, COALESCE(q.form_kind, '') AS form_kind
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     WHERE a.contact_id = $1
       AND q.active = 1
       AND q.deleted_at = ''
       AND (COALESCE(q.source_preset_id, '') <> '' OR q.id LIKE 'forms-preset:%')
     ORDER BY q.send_time, q.name`,
    [contactId],
  );
  return normalizeMenuForms(rows);
}

async function listTodayCycles(contactId: string, date: string): Promise<MenuCycle[]> {
  const rows = await many<{
    questionnaire_id: string;
    status: string;
    answers: number;
    last_prompted_at: string | null;
  }>(
    `SELECT cyc.questionnaire_id, cyc.status, COALESCE(cyc.last_prompted_at, '') AS last_prompted_at,
            (SELECT COUNT(*) FROM questionnaire_answers ans WHERE ans.cycle_id = cyc.id)::int AS answers
     FROM questionnaire_cycles cyc
     WHERE cyc.contact_id = $1 AND cyc.occurrence_date = $2 AND cyc.superseded_at = ''`,
    [contactId, date],
  );
  return rows.map((row) => ({
    questionnaireId: row.questionnaire_id,
    status: menuStatus(row.status),
    answers: Number(row.answers) || 0,
    lastPromptedAt: String(row.last_prompted_at || ''),
  }));
}

function menuStatus(status: string): MenuCycleStatus {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'notified' || status === 'delivery_unknown') return 'notified';
  return 'open';
}

async function readMenuState(conversationId: string, contactId: string): Promise<MenuState | undefined> {
  const row = await one<{ node_json: string; shown_at: string }>(
    `SELECT node_json, shown_at FROM conversation_menu_state WHERE conversation_id = $1`,
    [conversationId],
  );
  if (!row?.shown_at) return undefined;
  const shownMs = Date.parse(row.shown_at);
  if (!Number.isFinite(shownMs) || Date.now() - shownMs > MENU_TTL_MS) return undefined;
  // Disparo agendado ou lembrete depois do menu: a próxima mensagem responde a eles, não ao menu.
  const later = await one<{ id: string }>(
    `SELECT id FROM questionnaire_cycles
     WHERE contact_id = $1 AND COALESCE(last_prompted_at, '') > $2 LIMIT 1`,
    [contactId, row.shown_at],
  );
  if (later) return undefined;
  try {
    const node = JSON.parse(row.node_json) as MenuNode;
    return Array.isArray(node?.options) ? { node, shownAt: row.shown_at } : undefined;
  } catch {
    return undefined;
  }
}

async function saveMenuState(conversationId: string, node: MenuNode): Promise<void> {
  const stamp = new Date().toISOString();
  await run(
    `INSERT INTO conversation_menu_state(conversation_id, node_json, shown_at, updated_at)
     VALUES($1, $2, $3, $3)
     ON CONFLICT(conversation_id) DO UPDATE SET
       node_json = excluded.node_json, shown_at = excluded.shown_at, updated_at = excluded.updated_at`,
    [conversationId, JSON.stringify(node), stamp],
  );
}

export async function clearMenuState(conversationId: string): Promise<void> {
  if (!conversationId) return;
  await run(
    `UPDATE conversation_menu_state SET shown_at = '', updated_at = $2
     WHERE conversation_id = $1 AND shown_at <> ''`,
    [conversationId, new Date().toISOString()],
  );
}

/** Oferta antiga da agenda (“1) Compras 2) Vendas”) não pode disputar o número com o menu. */
async function clearAgendaSelection(conversationId: string): Promise<void> {
  await run(
    `UPDATE conversation_questionnaire_context
     SET awaiting_selection = 0, candidate_cycle_ids_json = '[]', updated_at = $2
     WHERE conversation_id = $1 AND awaiting_selection <> 0`,
    [conversationId, new Date().toISOString()],
  );
}
