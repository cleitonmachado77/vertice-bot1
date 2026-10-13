import { many, one } from './db.js';
import { runsOnWeekday } from './plans.js';
import {
  getOrCreateCycle,
  getCycleContextsByIds,
  getQuestionnaireForCycle,
  listCycleAnswers,
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

  const candidates = await listActiveCycleContexts(input.contactId, input.date, input.weekday);
  if (!candidates.length) return { ambiguous: [] };
  const active = candidates.find((item) => item.cycle.id === stored?.active_cycle_id);
  if (active) return { context: active, ambiguous: [] };
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

async function listActiveCycleContexts(
  contactId: string,
  date: string,
  weekday: number,
): Promise<ActiveCycleContext[]> {
  const result: ActiveCycleContext[] = [];
  for (const item of await listAssignedQuestionnaires(contactId)) {
    if (!runsOnWeekday(item, weekday)) continue;
    const cycle = await getOrCreateCycle(item.questionnaire_id, contactId, date);
    if (cycle.status === 'completed') continue;
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

