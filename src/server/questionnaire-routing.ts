import { many, one } from './db.js';
import { runsOnWeekday } from './plans.js';
import {
  getOrCreateCycle,
  getCycleContextsByIds,
  getQuestionnaireForCycle,
  listCycleAnswers,
  listPendingCycleContextsNearDate,
  setConversationCycleContext,
  setConversationCycleCandidates,
  toCycleContext,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';

type AssignedQuestionnaire = {
  questionnaire_id: string;
  frequency: string;
  weekday: number;
  send_time: string;
};

export type ActiveCycleResolution = {
  context?: ActiveCycleContext;
  ambiguous: ActiveCycleContext[];
  selectionConsumed?: boolean;
  completedEditContext?: boolean;
};

/** Dias recentes (além de hoje) considerados para preferir ciclo notificado. */
const RECENT_ROUTE_LOOKBACK = 3;

export async function resolveActiveCycleForConversation(input: {
  contactId: string;
  conversationId: string;
  date: string;
  weekday: number;
  inbound: string;
  includeCompletedContext?: boolean;
}): Promise<ActiveCycleResolution> {
  const stored = input.conversationId
    ? await one<{
        active_cycle_id: string;
        candidate_cycle_ids_json: string;
        awaiting_selection: number;
      }>(
        `SELECT active_cycle_id, candidate_cycle_ids_json, awaiting_selection
         FROM conversation_questionnaire_context WHERE conversation_id = $1`,
        [input.conversationId],
      )
    : undefined;

  if (stored?.awaiting_selection === 1) {
    const allowed = safeIds(stored.candidate_cycle_ids_json);
    const pendingSelection = await getCycleContextsByIds(allowed);
    const selection = selectCycle(pendingSelection, input.inbound);
    if (selection) {
      await setConversationCycleContext(
        input.conversationId,
        selection.cycle.id,
        selection.cycle.status === 'completed',
      );
      return { context: selection, ambiguous: [], selectionConsumed: true };
    }
    return { ambiguous: pendingSelection };
  }

  if (stored?.awaiting_selection === 2 && stored.active_cycle_id) {
    const [selected] = await getCycleContextsByIds([stored.active_cycle_id]);
    if (selected && ['completed', 'in_progress'].includes(selected.cycle.status)) {
      return { context: selected, ambiguous: [], completedEditContext: true };
    }
  }

  if (stored?.active_cycle_id && input.includeCompletedContext) {
    const [selected] = await getCycleContextsByIds([stored.active_cycle_id]);
    if (selected?.cycle.status === 'completed') {
      return { context: selected, ambiguous: [] };
    }
  }

  const todayCandidates = await listActiveCycleContexts(
    input.contactId,
    input.date,
    input.weekday,
    Boolean(input.includeCompletedContext),
  );
  const recentPending = await listPendingCycleContextsNearDate(
    input.contactId,
    input.date,
    RECENT_ROUTE_LOOKBACK,
  );
  const candidates = mergeCycleCandidates(todayCandidates, recentPending, input.date);

  if (!candidates.length) return { ambiguous: [] };
  const active = candidates.find((item) => item.cycle.id === stored?.active_cycle_id);
  if (active) return { context: active, ambiguous: [] };

  const preferred = preferPromptedRecentCycle(candidates, input.date);
  if (preferred) {
    await setConversationCycleContext(input.conversationId, preferred.cycle.id);
    return { context: preferred, ambiguous: [] };
  }

  if (candidates.length === 1) {
    await setConversationCycleContext(input.conversationId, candidates[0].cycle.id);
    return { context: candidates[0], ambiguous: [] };
  }

  const prompted = candidates
    .filter((item) => item.cycle.last_prompted_at)
    .sort((a, b) => String(b.cycle.last_prompted_at).localeCompare(String(a.cycle.last_prompted_at)));
  if (prompted.length && prompted[0].cycle.last_prompted_at !== prompted[1]?.cycle.last_prompted_at) {
    await setConversationCycleContext(input.conversationId, prompted[0].cycle.id);
    return { context: prompted[0], ambiguous: [] };
  }

  if (input.conversationId) {
    await setConversationCycleCandidates(
      input.conversationId,
      candidates.map((item) => item.cycle.id),
    );
  }
  return { ambiguous: candidates };
}

/**
 * Prefere ciclo notificado/em progresso com last_prompted_at recente
 * em vez de um ciclo de hoje só open sem prompt.
 */
export function preferPromptedRecentCycle(
  candidates: ActiveCycleContext[],
  today: string,
): ActiveCycleContext | undefined {
  if (!candidates.length) return undefined;

  const openPrompted = candidates
    .filter(
      (item) =>
        item.missing.length > 0 &&
        ['notified', 'in_progress'].includes(item.cycle.status) &&
        Boolean(item.cycle.last_prompted_at),
    )
    .sort((a, b) =>
      String(b.cycle.last_prompted_at).localeCompare(String(a.cycle.last_prompted_at)),
    );

  if (!openPrompted.length) return undefined;

  const best = openPrompted[0];
  // Se o melhor prompt é de dia anterior, prefere-o a um "open" de hoje sem prompt.
  if (best.cycle.occurrence_date < today) {
    const todayUnprompted = candidates.filter(
      (item) =>
        item.cycle.occurrence_date === today &&
        item.cycle.status === 'open' &&
        !item.cycle.last_prompted_at &&
        item.questionnaire.id === best.questionnaire.id,
    );
    if (todayUnprompted.length || candidates.some((c) => c.cycle.id === best.cycle.id)) {
      return best;
    }
  }

  // Mesmo dia: se há um prompted único mais recente, use-o.
  if (
    openPrompted.length === 1 ||
    openPrompted[0].cycle.last_prompted_at !== openPrompted[1]?.cycle.last_prompted_at
  ) {
    return best;
  }
  return undefined;
}

/** Une ciclos de hoje com pendentes recentes, sem duplicar id. */
export function mergeCycleCandidates(
  todayCandidates: ActiveCycleContext[],
  recentPending: ActiveCycleContext[],
  today: string,
): ActiveCycleContext[] {
  const byId = new Map<string, ActiveCycleContext>();
  for (const item of todayCandidates) byId.set(item.cycle.id, item);
  for (const item of recentPending) {
    if (item.cycle.occurrence_date > today) continue;
    if (!byId.has(item.cycle.id)) byId.set(item.cycle.id, item);
  }
  return [...byId.values()];
}

/** Ciclos do contato numa data (cria se ainda não existir e o plano roda nesse dia). */
export async function listCycleContextsForDate(
  contactId: string,
  date: string,
  weekday: number,
  includeCompleted = false,
): Promise<ActiveCycleContext[]> {
  return listActiveCycleContexts(contactId, date, weekday, includeCompleted);
}

async function listActiveCycleContexts(
  contactId: string,
  date: string,
  weekday: number,
  includeCompleted = false,
): Promise<ActiveCycleContext[]> {
  const result: ActiveCycleContext[] = [];
  for (const item of await listAssignedQuestionnaires(contactId)) {
    if (!runsOnWeekday(item, weekday)) continue;
    const cycle = await getOrCreateCycle(item.questionnaire_id, contactId, date);
    if (cycle.status === 'completed' && !includeCompleted) continue;
    const questionnaire = await getQuestionnaireForCycle(cycle);
    if (!questionnaire?.questions.length) continue;
    result.push(toCycleContext(cycle, questionnaire, await listCycleAnswers(cycle.id)));
  }
  return result;
}

async function listAssignedQuestionnaires(contactId: string): Promise<AssignedQuestionnaire[]> {
  return many(
    `SELECT q.id AS questionnaire_id, q.frequency, q.weekday, q.send_time
     FROM questionnaire_assignments a
     JOIN questionnaires q ON q.id = a.questionnaire_id
     WHERE a.contact_id = $1 AND q.active = 1 AND q.deleted_at = ''
     ORDER BY q.send_time, q.name`,
    [contactId],
  );
}

function selectCycle(candidates: ActiveCycleContext[], inbound: string): ActiveCycleContext | undefined {
  const normalized = fold(inbound);
  const ordinal = Number(/(?:^|\s)(\d+)(?:\s|$)/.exec(normalized)?.[1] || 0);
  if (ordinal >= 1 && ordinal <= candidates.length) return candidates[ordinal - 1];
  const matches = candidates.filter((item) => normalized.includes(fold(item.questionnaire.name)));
  return matches.length === 1 ? matches[0] : undefined;
}

function safeIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function fold(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}
