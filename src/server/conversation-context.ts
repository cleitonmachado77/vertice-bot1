import { formatBrDate, shiftIsoDate } from './questionnaire-dates.js';
import {
  listPendingCycleContextsNearDate,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';

export type HistoryRow = { direction: string; text: string };

export type PendingDayHint = {
  date: string;
  label: string;
  questionnaireName: string;
  status: string;
  missingCount: number;
};

export type ConversationHints = {
  /** Confirmação curta após convite/template de questionário. */
  likelyQuestionnaireAck: boolean;
  /** Há ciclo de questionário aberto (hoje ou recente). */
  hasPendingQuestionnaire: boolean;
  /** Dias anteriores a hoje ainda incompletos. */
  pendingPreviousDays: PendingDayHint[];
};

export type ConversationContextPack = {
  history: HistoryRow[];
  contextBrief: string;
  hints: ConversationHints;
  pendingCycles: ActiveCycleContext[];
};

const SHORT_ACK_RE = /^(ok|sim|si+|pode|claro|certo|isso|isso mesmo|beleza|blz|show|combinado|pode ser|vamos|bora)\.?$/i;

const INVITE_RE =
  /question[aá]rio|acompanhamento|responda (essa|esta)?\s*mensagem|pode responder|iniciarmos? (seu )?atendimento|template/i;

/** Confirmação curta (ok, sim, pode…). */
export function isShortAck(text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > 40) return false;
  return SHORT_ACK_RE.test(trimmed);
}

/** Última outbound parece convite de questionário / first-contact. */
export function looksLikeQuestionnaireInvite(text: string): boolean {
  return INVITE_RE.test(String(text || ''));
}

export function detectLikelyQuestionnaireAck(
  history: HistoryRow[],
  inbound: string,
): boolean {
  if (!isShortAck(inbound)) return false;
  const lastOutbound = [...history]
    .reverse()
    .find((item) => item.direction === 'OUTBOUND' && String(item.text || '').trim());
  return Boolean(lastOutbound && looksLikeQuestionnaireInvite(lastOutbound.text));
}

export function pendingDaysFromCycles(
  cycles: ActiveCycleContext[],
  today: string,
): PendingDayHint[] {
  return cycles
    .filter(
      (item) =>
        item.cycle.occurrence_date < today &&
        item.missing.length > 0 &&
        ['open', 'notified', 'in_progress'].includes(item.cycle.status),
    )
    .sort((a, b) => b.cycle.occurrence_date.localeCompare(a.cycle.occurrence_date))
    .map((item) => ({
      date: item.cycle.occurrence_date,
      label: formatBrDate(item.cycle.occurrence_date),
      questionnaireName: item.questionnaire.name,
      status: item.cycle.status,
      missingCount: item.missing.length,
    }));
}

export function buildConversationHints(input: {
  history: HistoryRow[];
  inbound: string;
  today: string;
  pendingCycles: ActiveCycleContext[];
}): ConversationHints {
  const pendingPreviousDays = pendingDaysFromCycles(input.pendingCycles, input.today);
  const hasPendingQuestionnaire = input.pendingCycles.some((item) => item.missing.length > 0);
  return {
    likelyQuestionnaireAck: detectLikelyQuestionnaireAck(input.history, input.inbound),
    hasPendingQuestionnaire,
    pendingPreviousDays,
  };
}

/** Texto curto (sem LLM) com histórico resumido + ciclos por data. */
export function buildContextBrief(input: {
  today: string;
  history: HistoryRow[];
  pendingCycles: ActiveCycleContext[];
  hints: ConversationHints;
}): string {
  const lines: string[] = [
    `Hoje no calendário: ${input.today} (${formatBrDate(input.today)}).`,
    '',
    'Ciclos recentes do contato (por data):',
  ];

  const byDate = new Map<string, ActiveCycleContext[]>();
  for (const item of input.pendingCycles) {
    const key = item.cycle.occurrence_date;
    const list = byDate.get(key) || [];
    list.push(item);
    byDate.set(key, list);
  }

  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  if (!dates.length) {
    lines.push('- (nenhum ciclo aberto nos últimos dias)');
  } else {
    for (const date of dates) {
      for (const item of byDate.get(date) || []) {
        const answered = item.answers.filter((row) => String(row.answer_text || '').trim()).length;
        const total = item.questionnaire.questions.length;
        lines.push(
          `- ${formatBrDate(date)} | “${item.questionnaire.name}” | status=${item.cycle.status}` +
            ` | respondidas=${answered}/${total} | faltam=${item.missing.length}` +
            (item.cycle.last_prompted_at ? ` | notificado=${item.cycle.last_prompted_at}` : ''),
        );
      }
    }
  }

  if (input.hints.pendingPreviousDays.length) {
    lines.push('');
    lines.push('Atenção — dias anteriores ainda incompletos:');
    for (const day of input.hints.pendingPreviousDays) {
      lines.push(
        `- ${day.label} (“${day.questionnaireName}”, ${day.status}): faltam ${day.missingCount} pergunta(s). Avise o usuário.`,
      );
    }
  }

  if (input.hints.likelyQuestionnaireAck) {
    lines.push('');
    lines.push(
      'Hint: a mensagem atual parece confirmação curta (ok/sim) após convite de questionário — apresente as perguntas e continue a coleta; não encerre com silêncio.',
    );
  }

  const recent = input.history.filter((item) => item.text.trim()).slice(-6);
  if (recent.length) {
    lines.push('');
    lines.push('Últimas mensagens (resumo):');
    for (const item of recent) {
      const who = item.direction === 'OUTBOUND' ? 'Empresa' : 'Contato';
      const text = item.text.replace(/\s+/g, ' ').trim().slice(0, 160);
      lines.push(`- ${who}: ${text}`);
    }
  }

  return lines.join('\n');
}

export async function buildConversationContextPack(input: {
  contactId: string;
  today: string;
  inbound: string;
  history: HistoryRow[];
  lookbackDays?: number;
}): Promise<ConversationContextPack> {
  const lookback = input.lookbackDays ?? 7;
  const pendingCycles = input.contactId
    ? await listPendingCycleContextsNearDate(input.contactId, input.today, lookback)
    : [];
  const hints = buildConversationHints({
    history: input.history,
    inbound: input.inbound,
    today: input.today,
    pendingCycles,
  });
  return {
    history: input.history,
    hints,
    pendingCycles,
    contextBrief: buildContextBrief({
      today: input.today,
      history: input.history,
      pendingCycles,
      hints,
    }),
  };
}

/** Aviso curto para anexar na reply quando há dias anteriores faltando. */
export function pendingPreviousDaysNotice(hints: ConversationHints): string {
  if (!hints.pendingPreviousDays.length) return '';
  const labels = hints.pendingPreviousDays.map((item) => item.label);
  if (labels.length === 1) {
    return `Obs.: ainda falta concluir o questionário de ${labels[0]}.`;
  }
  return `Obs.: ainda faltam questionários de ${labels.join(', ')}.`;
}

/** Datas ISO dos últimos N dias a partir de today (inclui today). */
export function recentDatesInclusive(today: string, days: number): string[] {
  const count = Math.max(1, days);
  const dates: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    dates.push(shiftIsoDate(today, -offset));
  }
  return dates;
}
