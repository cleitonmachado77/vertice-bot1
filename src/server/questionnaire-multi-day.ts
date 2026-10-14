import {
  draftQuestionnaireReply,
  type QuestionnaireDraft,
} from './questionnaire-agent.js';
import {
  formatBrDate,
  weekdayFromIsoDate,
  type DatedSegment,
} from './questionnaire-dates.js';
import { listCycleContextsForDate } from './questionnaire-routing.js';

/**
 * Processa uma mensagem com várias datas: grava cada trecho no ciclo do dia certo
 * e devolve uma reply única confirmando os dias.
 */
export async function draftMultiDayQuestionnaireReply(input: {
  contactId: string;
  contactName: string;
  segments: DatedSegment[];
  inboundType: string;
  mediaUrl: string;
  history: { direction: string; text: string }[];
  today: string;
}): Promise<QuestionnaireDraft | null> {
  const explicit = input.segments.filter((item) => item.explicit && item.text.trim());
  if (explicit.length < 2) return null;

  const byDate = new Map<string, DatedSegment>();
  for (const segment of explicit) {
    const prev = byDate.get(segment.date);
    if (prev) {
      prev.text = `${prev.text} ${segment.text}`.trim();
    } else {
      byDate.set(segment.date, { ...segment });
    }
  }
  if (byDate.size < 2) return null;

  const parts: { date: string; label: string; draft: QuestionnaireDraft }[] = [];
  for (const segment of byDate.values()) {
    const cycles = await listCycleContextsForDate(
      input.contactId,
      segment.date,
      weekdayFromIsoDate(segment.date),
      true,
    );
    if (!cycles.length) continue;
    const context = cycles[0];
    const draft = await draftQuestionnaireReply({
      context,
      contactName: input.contactName,
      inbound: segment.text,
      inboundType: input.inboundType,
      mediaUrl: input.mediaUrl,
      history: input.history,
      today: input.today,
    });
    if (draft.deferToFree && !draft.text) continue;
    parts.push({ date: segment.date, label: segment.label, draft });
  }

  if (!parts.length) return null;
  return {
    text: synthesizeMultiDayReply(parts).slice(0, 1500),
    source: parts.some((item) => item.draft.source === 'model') ? 'model' : 'fallback',
    detail: `multiplas datas (${parts.map((item) => item.date).join(', ')})`,
    completed: parts.every((item) => item.draft.completed),
  };
}

export function synthesizeMultiDayReply(
  parts: { date: string; label: string; draft: QuestionnaireDraft }[],
): string {
  if (parts.length === 1) return parts[0].draft.text;
  const allDone = parts.every((item) =>
    /anotei tudo|registre(i|amos) (a alteracao|tudo)/i.test(item.draft.text),
  );
  if (allDone) {
    const dates = parts.map((item) => formatBrDate(item.date)).join(' e ');
    return `Perfeito! Anotei tudo para ${dates}, obrigado.`;
  }
  return parts
    .map((item) => `• ${formatBrDate(item.date)}: ${item.draft.text}`)
    .join('\n');
}
