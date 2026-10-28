import { getSetting, many, run, setSetting } from './db.js';
import { minutesFromClock } from './clock.js';
import { KIND_LABELS, isFormKind, type FormKind } from './forms-fields.js';
import { runsOnWeekday } from './plans.js';
import {
  getOrCreateCycle,
  getQuestionnaireForCycle,
  listCycleAnswers,
  setConversationCycleCandidates,
  setConversationCycleContext,
  toCycleContext,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';
import type { Questionnaire } from './questionnaires.js';

export type AgendaItemStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export type FormsBotAgendaItem = {
  questionnaireId: string;
  cycleId: string;
  presetId: string;
  kind: FormKind;
  name: string;
  label: string;
  sendTime: string;
  status: AgendaItemStatus;
  context: ActiveCycleContext;
};

export type FormsBotAgendaIntent =
  | { action: 'none' }
  | { action: 'select'; item: FormsBotAgendaItem; alsoSkip?: FormsBotAgendaItem[] }
  | { action: 'skip'; item: FormsBotAgendaItem }
  | { action: 'skip_many'; items: FormsBotAgendaItem[] }
  | { action: 'decline_offer' }
  | { action: 'accept_offer' };

const KIND_ORDER: Record<FormKind, number> = {
  purchase: 0,
  production: 1,
  sale: 2,
  product: 3,
};

// “fornecedor”, “cliente” e “produto” são nomes de CAMPO do questionário
// (ex.: “já respondi o fornecedor”) — nunca sinônimo de tipo de formulário.
const KIND_ALIASES: Array<{ kind: FormKind; patterns: RegExp[] }> = [
  { kind: 'purchase', patterns: [/\bcompras?\b/, /\bpurchase\b/] },
  { kind: 'sale', patterns: [/\bvendas?\b/, /\bsale\b/] },
  // “fardos” fica de fora: aparece nas respostas (“3 fardos de PET”) e roubaria a captura.
  { kind: 'production', patterns: [/\bfabricacao\b/, /\bprensagem\b/, /\bprensa(do|dos|r)?\b/] },
  {
    kind: 'product',
    patterns: [/\binventario\b/, /\bestoque\b/, /\bproducao\b/, /\bproduct\b/],
  },
];

const FORM_MENTION_RE =
  /\b(questionario|formulario|inventario|estoque|producao|fabricacao|prensagem|vendas?|compras?)\b/;

export function isFormsBotQuestionnaire(
  questionnaire: Pick<Questionnaire, 'id' | 'sourcePresetId'>,
): boolean {
  if (String(questionnaire.sourcePresetId || '').trim()) return true;
  return String(questionnaire.id || '').startsWith('forms-preset:');
}

export function formsBotDisplayName(
  questionnaire: Pick<Questionnaire, 'name' | 'formKind'>,
): string {
  const raw = String(questionnaire.name || '')
    .replace(/^\[Forms\]\s*/i, '')
    .trim();
  if (raw) return raw;
  const kind = String(questionnaire.formKind || '').trim();
  return isFormKind(kind) ? KIND_LABELS[kind] : 'Formulário';
}

export function formsBotAgendaLabel(
  questionnaire: Pick<Questionnaire, 'name' | 'formKind'>,
): string {
  return formsBotDisplayName(questionnaire);
}

export function compareFormsBotAgendaItems(
  a: Pick<FormsBotAgendaItem, 'sendTime' | 'kind' | 'label'>,
  b: Pick<FormsBotAgendaItem, 'sendTime' | 'kind' | 'label'>,
  nowMinutes: number,
): number {
  const distA = Math.abs(minutesFromClock(a.sendTime) - nowMinutes);
  const distB = Math.abs(minutesFromClock(b.sendTime) - nowMinutes);
  if (distA !== distB) return distA - distB;
  const dueA = minutesFromClock(a.sendTime) <= nowMinutes ? 0 : 1;
  const dueB = minutesFromClock(b.sendTime) <= nowMinutes ? 0 : 1;
  if (dueA !== dueB) return dueA - dueB;
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff) return kindDiff;
  return a.label.localeCompare(b.label, 'pt-BR');
}

export function sortFormsBotAgenda(
  items: FormsBotAgendaItem[],
  nowMinutes: number,
): FormsBotAgendaItem[] {
  return [...items].sort((a, b) => compareFormsBotAgendaItems(a, b, nowMinutes));
}

/** Em andamento primeiro; depois pendentes pela proximidade do horário. */
export function pickPrimaryFormsBotAgendaItem(
  items: FormsBotAgendaItem[],
  nowMinutes: number,
): FormsBotAgendaItem | undefined {
  const open = items.filter((item) => item.status === 'in_progress' || item.status === 'pending');
  if (!open.length) return undefined;
  const inProgress = open.filter((item) => item.status === 'in_progress');
  if (inProgress.length) {
    return [...inProgress].sort((a, b) => {
      const prompted = String(b.context.cycle.last_prompted_at).localeCompare(
        String(a.context.cycle.last_prompted_at),
      );
      if (prompted) return prompted;
      return compareFormsBotAgendaItems(a, b, nowMinutes);
    })[0];
  }
  return sortFormsBotAgenda(open, nowMinutes)[0];
}

export function remainingFormsBotAgendaItems(items: FormsBotAgendaItem[]): FormsBotAgendaItem[] {
  return items.filter((item) => item.status === 'pending' || item.status === 'in_progress');
}

export function looksLikeFormsBotAgendaMeta(
  inbound: string,
  options: { awaitingOffer?: boolean } = {},
): boolean {
  const folded = fold(inbound);
  if (!folded) return false;
  // sim/não curtos só contam na oferta entre formulários (evita roubar “mais produtos?”).
  if (
    /^(nao|n|agora nao|por hoje|so isso|somente isso|apenas isso|obrigado|valeu|ok|sim|pode|vamos|quero)$/.test(
      folded,
    )
  ) {
    return Boolean(options.awaitingOffer);
  }
  // “já respondi o fornecedor”, “não tem mais” (em “Mais produtos?”) falam de um CAMPO,
  // não da agenda. Só é meta quando cita pular/outro ou um formulário/tipo.
  return /\b(pular|pule|pulando|outra|outro)\b/.test(folded) || FORM_MENTION_RE.test(folded);
}

export function parseFormsBotAgendaIntent(
  inbound: string,
  agenda: FormsBotAgendaItem[],
  options: { awaitingOffer?: boolean } = {},
): FormsBotAgendaIntent {
  const folded = fold(inbound);
  if (!folded || !agenda.length) return { action: 'none' };

  const selectable = agenda.filter((item) => item.status !== 'completed');
  const remaining = remainingFormsBotAgendaItems(agenda);

  if (options.awaitingOffer) {
    if (isDeclineOffer(folded)) return { action: 'decline_offer' };
    if (isAcceptOffer(folded)) return { action: 'accept_offer' };
  }

  const ordinal = Number(/(?:^|\s)(\d+)(?:\s|$)/.exec(folded)?.[1] || 0);
  const ordinalPool = options.awaitingOffer ? remaining : selectable;
  if (ordinal >= 1 && ordinal <= ordinalPool.length) {
    return { action: 'select', item: ordinalPool[ordinal - 1] };
  }

  const compound = parseCompoundAgendaIntent(folded, selectable);
  if (compound) return compound;

  const mentioned = matchAgendaItemsByText(folded, selectable);
  const skipMentioned = mentioned.filter((item) => item.status !== 'completed');
  const wantsSkip = isSkipPhrase(folded);
  const wantsOnly = /\b(so|somente|apenas)\b/.test(folded) && mentioned.length === 1;

  if (wantsOnly && mentioned[0]) {
    const skipOthers = selectable.filter(
      (item) => item.questionnaireId !== mentioned[0].questionnaireId && item.status !== 'completed',
    );
    return { action: 'select', item: mentioned[0], alsoSkip: skipOthers };
  }

  if (wantsSkip && skipMentioned.length === 1) {
    return { action: 'skip', item: skipMentioned[0] };
  }
  if (wantsSkip && skipMentioned.length > 1) {
    return { action: 'skip_many', items: skipMentioned };
  }
  if (wantsSkip && !skipMentioned.length && remaining.length === 1 && options.awaitingOffer) {
    return { action: 'decline_offer' };
  }

  if (mentioned.length === 1 && !wantsSkip) {
    return { action: 'select', item: mentioned[0] };
  }

  if (options.awaitingOffer && isDeclineOffer(folded)) return { action: 'decline_offer' };
  if (options.awaitingOffer && isAcceptOffer(folded)) return { action: 'accept_offer' };

  return { action: 'none' };
}

export function formatFormsBotAgendaOffer(remaining: FormsBotAgendaItem[]): string {
  if (!remaining.length) return '';
  if (remaining.length === 1) {
    return [
      `Quer seguir com “${remaining[0].label}”?`,
      'Responda sim, não, ou diga se prefere pular (ex.: “hoje não tem inventário”).',
    ].join('\n');
  }
  return [
    'Ainda posso registrar hoje:',
    ...remaining.map((item, index) => `${index + 1}) ${item.label}`),
    'Responda o número, o nome, ou diga se prefere pular algum.',
  ].join('\n');
}

export async function formatFormsBotAgendaIntro(item: FormsBotAgendaItem): Promise<string> {
  const { buildFormsBotGuidedPrompt } = await import('./forms-bot-catalog-context.js');
  const { rememberCyclePrompt } = await import('./questionnaire-cycles.js');
  const questions = item.context.missing.length
    ? item.context.missing
    : item.context.questionnaire.questions;
  const guided = await buildFormsBotGuidedPrompt({
    questionnaire: item.context.questionnaire,
    questions,
  });
  await rememberCyclePrompt(item.context.cycle.id, questions[0]?.id || '', 'agenda: intro');
  return [`Certo! Vamos responder “${item.label}”:`, '', guided].join('\n');
}

function agendaSkipKey(contactId: string, date: string): string {
  return `forms_bot_agenda_skip:${contactId}:${date}`;
}

export async function listSkippedFormsBotQuestionnaireIds(
  contactId: string,
  date: string,
): Promise<Set<string>> {
  if (!contactId || !date) return new Set();
  try {
    const raw = getSetting(agendaSkipKey(contactId, date), '[]');
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(String).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function skipFormsBotQuestionnaire(
  contactId: string,
  date: string,
  questionnaireId: string,
): Promise<void> {
  if (!contactId || !date || !questionnaireId) return;
  const skipped = await listSkippedFormsBotQuestionnaireIds(contactId, date);
  skipped.add(questionnaireId);
  await setSetting(agendaSkipKey(contactId, date), JSON.stringify([...skipped]));
}

export async function unskipFormsBotQuestionnaire(
  contactId: string,
  date: string,
  questionnaireId: string,
): Promise<void> {
  if (!contactId || !date || !questionnaireId) return;
  const skipped = await listSkippedFormsBotQuestionnaireIds(contactId, date);
  if (!skipped.delete(questionnaireId)) return;
  await setSetting(agendaSkipKey(contactId, date), JSON.stringify([...skipped]));
}

export async function clearFormsBotAgendaSkips(contactId: string, date: string): Promise<void> {
  if (!contactId || !date) return;
  await setSetting(agendaSkipKey(contactId, date), '[]');
}

export function statusForFormsBotContext(
  context: ActiveCycleContext,
  skipped: Set<string>,
): AgendaItemStatus {
  if (context.cycle.status === 'completed') return 'completed';
  if (skipped.has(context.questionnaire.id)) return 'skipped';
  if (
    context.missing.length > 0 &&
    (context.cycle.status === 'in_progress' ||
      context.cycle.status === 'notified' ||
      Boolean(context.cycle.last_prompted_at) ||
      context.answers.length > 0)
  ) {
    return 'in_progress';
  }
  return 'pending';
}

export function buildFormsBotAgendaItems(
  contexts: ActiveCycleContext[],
  skipped: Set<string>,
  nowMinutes: number,
): FormsBotAgendaItem[] {
  const items: FormsBotAgendaItem[] = [];
  for (const context of contexts) {
    if (!isFormsBotQuestionnaire(context.questionnaire)) continue;
    const kindRaw = String(context.questionnaire.formKind || '').trim();
    const kind: FormKind = isFormKind(kindRaw) ? kindRaw : 'purchase';
    const presetId =
      String(context.questionnaire.sourcePresetId || '').trim() ||
      (context.questionnaire.id.startsWith('forms-preset:')
        ? context.questionnaire.id.slice('forms-preset:'.length)
        : '');
    items.push({
      questionnaireId: context.questionnaire.id,
      cycleId: context.cycle.id,
      presetId,
      kind,
      name: formsBotDisplayName(context.questionnaire),
      label: formsBotAgendaLabel(context.questionnaire),
      sendTime: context.questionnaire.send_time || '08:00',
      status: statusForFormsBotContext(context, skipped),
      context,
    });
  }
  return sortFormsBotAgenda(items, nowMinutes);
}

export async function loadFormsBotAgenda(input: {
  contactId: string;
  date: string;
  weekday: number;
  nowMinutes: number;
}): Promise<FormsBotAgendaItem[]> {
  const contexts = await listFormsBotCycleContexts(
    input.contactId,
    input.date,
    input.weekday,
  );
  const skipped = await listSkippedFormsBotQuestionnaireIds(input.contactId, input.date);
  return buildFormsBotAgendaItems(contexts, skipped, input.nowMinutes);
}

async function listFormsBotCycleContexts(
  contactId: string,
  date: string,
  weekday: number,
): Promise<ActiveCycleContext[]> {
  if (!contactId) return [];
  const assigned = await many<{
    questionnaire_id: string;
    frequency: string;
    weekday: number;
    send_time: string;
  }>(
    `SELECT q.id AS questionnaire_id, q.frequency, q.weekday, q.send_time
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     WHERE a.contact_id = $1
       AND q.active = 1
       AND q.deleted_at = ''
       AND (
         COALESCE(q.source_preset_id, '') <> ''
         OR q.id LIKE 'forms-preset:%'
       )
     ORDER BY q.send_time, q.name`,
    [contactId],
  );
  const result: ActiveCycleContext[] = [];
  for (const item of assigned) {
    if (!runsOnWeekday(item, weekday)) continue;
    const cycle = await getOrCreateCycle(item.questionnaire_id, contactId, date);
    const questionnaire = await getQuestionnaireForCycle(cycle);
    if (!questionnaire?.questions.length) continue;
    result.push(toCycleContext(cycle, questionnaire, await listCycleAnswers(cycle.id)));
  }
  return result;
}

/**
 * Quando há vários Forms Bot no mesmo contato, escolhe o da agenda
 * (em andamento ou mais próximo do horário) em vez de pedir desambiguação.
 */
export function resolveFormsBotAgendaContext(
  candidates: ActiveCycleContext[],
  skipped: Set<string>,
  nowMinutes: number,
): ActiveCycleContext | undefined {
  const forms = candidates.filter((item) => isFormsBotQuestionnaire(item.questionnaire));
  if (!forms.length) return undefined;
  const agenda = buildFormsBotAgendaItems(forms, skipped, nowMinutes);
  const primary = pickPrimaryFormsBotAgendaItem(agenda, nowMinutes);
  return primary?.context;
}

export async function offerRemainingFormsBotAgenda(input: {
  contactId: string;
  conversationId: string;
  date: string;
  weekday: number;
  nowMinutes: number;
  excludeCycleId?: string;
}): Promise<{ text: string; remaining: FormsBotAgendaItem[] }> {
  const agenda = await loadFormsBotAgenda(input);
  const remaining = remainingFormsBotAgendaItems(agenda).filter(
    (item) => item.cycleId !== input.excludeCycleId,
  );
  if (!remaining.length) {
    return { text: '', remaining: [] };
  }
  if (input.conversationId) {
    await setConversationCycleCandidates(
      input.conversationId,
      remaining.map((item) => item.cycleId),
    );
  }
  return { text: formatFormsBotAgendaOffer(remaining), remaining };
}

export async function applyFormsBotAgendaIntent(input: {
  contactId: string;
  conversationId: string;
  date: string;
  weekday: number;
  nowMinutes: number;
  inbound: string;
  awaitingOffer?: boolean;
}): Promise<{
  handled: boolean;
  cycle?: ActiveCycleContext;
  text?: string;
  detail?: string;
  completed?: boolean;
}> {
  const agenda = await loadFormsBotAgenda(input);
  if (agenda.length < 2 && !input.awaitingOffer) {
    // Com um único Forms Bot, só trata meta explícita de pular/recusar.
    if (!looksLikeFormsBotAgendaMeta(input.inbound)) {
      return { handled: false };
    }
  }

  const intent = parseFormsBotAgendaIntent(input.inbound, agenda, {
    awaitingOffer: input.awaitingOffer,
  });

  if (intent.action === 'none') {
    if (!input.awaitingOffer) return { handled: false };
    return {
      handled: true,
      text: formatFormsBotAgendaOffer(remainingFormsBotAgendaItems(agenda)),
      detail: 'agenda Forms: seleção não reconhecida',
      completed: false,
    };
  }

  if (intent.action === 'decline_offer') {
    if (input.conversationId) {
      await setConversationCycleCandidates(input.conversationId, []);
      // limpa awaiting_selection gravando contexto vazio via candidates vazio — setConversationCycleCandidates exige length.
      // Usa setConversationCycleContext com cycle vazio não é suportado; marca skips suaves só limpando candidates:
      await clearAwaitingSelection(input.conversationId);
    }
    return {
      handled: true,
      text: 'Ok! Quando quiser registrar outro formulário hoje, é só chamar.',
      detail: 'agenda Forms: oferta recusada',
      completed: true,
    };
  }

  if (intent.action === 'accept_offer') {
    const next = pickPrimaryFormsBotAgendaItem(agenda, input.nowMinutes);
    if (!next) {
      return {
        handled: true,
        text: 'Por hoje não há outro formulário pendente. Obrigado!',
        detail: 'agenda Forms: nada pendente',
        completed: true,
      };
    }
    await unskipFormsBotQuestionnaire(input.contactId, input.date, next.questionnaireId);
    if (input.conversationId) {
      await setConversationCycleContext(input.conversationId, next.cycleId);
    }
    return {
      handled: true,
      cycle: next.context,
      text: await formatFormsBotAgendaIntro(next),
      detail: 'agenda Forms: oferta aceita',
      completed: false,
    };
  }

  if (intent.action === 'skip' || intent.action === 'skip_many') {
    const toSkip = intent.action === 'skip' ? [intent.item] : intent.items;
    for (const item of toSkip) {
      await skipFormsBotQuestionnaire(input.contactId, input.date, item.questionnaireId);
    }
    const refreshed = await loadFormsBotAgenda(input);
    const next = pickPrimaryFormsBotAgendaItem(refreshed, input.nowMinutes);
    const skippedLabels = toSkip.map((item) => item.label).join(', ');
    if (!next) {
      if (input.conversationId) await clearAwaitingSelection(input.conversationId);
      return {
        handled: true,
        text: `Certo, pulei ${skippedLabels} por hoje. Se precisar, é só chamar.`,
        detail: 'agenda Forms: pulados sem pendentes',
        completed: true,
      };
    }
    if (input.conversationId) {
      await setConversationCycleContext(input.conversationId, next.cycleId);
    }
    return {
      handled: true,
      cycle: next.context,
      text: [`Certo, pulei ${skippedLabels}.`, await formatFormsBotAgendaIntro(next)].join('\n\n'),
      detail: 'agenda Forms: pulado e próximo iniciado',
      completed: false,
    };
  }

  if (intent.action === 'select') {
    for (const item of intent.alsoSkip || []) {
      await skipFormsBotQuestionnaire(input.contactId, input.date, item.questionnaireId);
    }
    await unskipFormsBotQuestionnaire(input.contactId, input.date, intent.item.questionnaireId);
    if (input.conversationId) {
      await setConversationCycleContext(input.conversationId, intent.item.cycleId);
    }
    const item = intent.item;
    const skippedNote = intent.alsoSkip?.length
      ? `Certo, pulei ${intent.alsoSkip.map((entry) => entry.label).join(', ')}.\n\n`
      : '';
    if (item.context.cycle.status === 'completed') {
      return {
        handled: true,
        cycle: item.context,
        text: `${skippedNote}“${item.label}” já está concluído hoje. O que deseja corrigir? Informe a pergunta e a nova resposta.`,
        detail: 'agenda Forms: selecionou concluído',
        completed: false,
      };
    }
    return {
      handled: true,
      cycle: item.context,
      text: `${skippedNote}${await formatFormsBotAgendaIntro(item)}`,
      detail: 'agenda Forms: formulário selecionado',
      completed: false,
    };
  }

  return { handled: false };
}

async function clearAwaitingSelection(conversationId: string): Promise<void> {
  if (!conversationId) return;
  await run(
    `UPDATE conversation_questionnaire_context
     SET awaiting_selection = 0, candidate_cycle_ids_json = '[]', updated_at = $2
     WHERE conversation_id = $1`,
    [conversationId, new Date().toISOString()],
  );
}

function matchAgendaItemsByText(
  folded: string,
  items: FormsBotAgendaItem[],
): FormsBotAgendaItem[] {
  const byName = items.filter((item) => {
    const label = fold(item.label);
    const name = fold(item.name);
    return (label && folded.includes(label)) || (name && folded.includes(name));
  });
  if (byName.length) return byName;

  const byKind: FormsBotAgendaItem[] = [];
  for (const alias of KIND_ALIASES) {
    if (!alias.patterns.some((pattern) => pattern.test(folded))) continue;
    byKind.push(...items.filter((item) => item.kind === alias.kind));
  }
  return uniqueItems(byKind);
}

/** Ex.: “respondi compras, vou responder vendas” ou “hoje só inventário”. */
function parseCompoundAgendaIntent(
  folded: string,
  selectable: FormsBotAgendaItem[],
): FormsBotAgendaIntent | undefined {
  const selectMatch =
    /\b(?:vou|quero|vamos)\s+responder\s+(.+)$/.exec(folded) ||
    /\bresponder\s+(.+)$/.exec(folded);
  if (selectMatch) {
    const selectPart = fold(selectMatch[1] || '');
    const selectItems = matchAgendaItemsByText(selectPart, selectable);
    if (selectItems.length === 1) {
      const alreadyDonePart = folded.slice(0, selectMatch.index);
      const skipItems = matchAgendaItemsByText(alreadyDonePart, selectable).filter(
        (item) =>
          item.questionnaireId !== selectItems[0].questionnaireId &&
          (/\b(ja )?respondi\b/.test(alreadyDonePart) ||
            isSkipPhrase(alreadyDonePart) ||
            /\bnao\b/.test(alreadyDonePart)),
      );
      return {
        action: 'select',
        item: selectItems[0],
        alsoSkip: skipItems,
      };
    }
  }

  if (/\b(ja )?respondi\b/.test(folded)) {
    const mentioned = matchAgendaItemsByText(folded, selectable);
    if (mentioned.length === 1) return { action: 'skip', item: mentioned[0] };
  }
  return undefined;
}

function isSkipPhrase(folded: string): boolean {
  return (
    /\b(pular|pule|pulando)\b/.test(folded) ||
    /\b(hoje )?nao (tem|terei|vamos|preciso|quero|terei)\b/.test(folded) ||
    /\bnao temos\b/.test(folded) ||
    /\bsem (novos? )?registros?\b/.test(folded) ||
    /\bsem novidade\b/.test(folded) ||
    /\b(ja )?respondi\b/.test(folded)
  );
}

function isDeclineOffer(folded: string): boolean {
  return /^(nao|n|agora nao|por hoje|por hoje (e|eh) so|so isso|somente isso|apenas isso|obrigado|valeu|depois)$/.test(
    folded,
  );
}

function isAcceptOffer(folded: string): boolean {
  return /^(sim|s|pode|vamos|quero|ok|certo|bora|isso)$/.test(folded);
}

function uniqueItems(items: FormsBotAgendaItem[]): FormsBotAgendaItem[] {
  const seen = new Set<string>();
  const out: FormsBotAgendaItem[] = [];
  for (const item of items) {
    if (seen.has(item.questionnaireId)) continue;
    seen.add(item.questionnaireId);
    out.push(item);
  }
  return out;
}

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
