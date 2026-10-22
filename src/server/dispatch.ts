import { getSetting, withDispatchLock } from './db.js';
import { minutesFromClock, zonedNow } from './clock.js';
import { NevoaError, sendWhatsappText } from './nevoa.js';
import { dispatchStatus, listDueMessages, markDispatch, runsOnWeekday } from './plans.js';
import { runFormsBotIdleRules } from './forms-bot-idle-close.js';
import { runQuestionnaireDispatches } from './questionnaire-dispatch.js';
import { ensureConversation, recordOutbound } from './thread.js';

export type DispatchRun = {
  date: string;
  sent: number;
  failed: number;
  waiting: number;
  skipped: number;
  locked?: boolean;
  items: { phone: string; status: string; detail: string }[];
  questionnaires?: {
    sent: number;
    failed: number;
    waiting: number;
    skipped: number;
  };
  /** Forms Bot parado: encerrados, lembretes enviados e alertas no painel nesta rodada. */
  idle?: { closed: number; reminded: number; alerted: number };
};

export async function runDueDispatches(): Promise<DispatchRun> {
  const empty = emptyRun(zonedNow().date);
  const locked = await withDispatchLock(() => runDispatchBody());
  if (!locked.ran) {
    return { ...empty, locked: false, skipped: 1, items: [{ phone: '-', status: 'skipped', detail: 'lock ocupado' }] };
  }
  return { ...locked.value, locked: true };
}

async function runDispatchBody(): Promise<DispatchRun> {
  const clock = zonedNow();
  const result = emptyRun(clock.date);
  const channelId = getSetting('nevoa_channel_id');

  for (const message of await listDueMessages()) {
    if (!runsOnWeekday(message, clock.weekday)) {
      result.skipped += 1;
      continue;
    }
    if (clock.minutes < minutesFromClock(message.send_time)) {
      result.waiting += 1;
      continue;
    }
    const status = await dispatchStatus(message.id, clock.date);
    if (status === 'sent' || status === 'answered') {
      result.skipped += 1;
      continue;
    }

    try {
      await sendWhatsappText({
        phone: message.phone,
        text: message.body,
        channelIntegrationId: channelId,
      });
      const conversationId = await ensureConversation({
        contactId: message.contact_id,
        name: message.name,
        phone: message.phone,
        channelId,
      });
      await recordOutbound({
        conversationId,
        text: message.body,
        origin: 'scheduled',
      });
      await markDispatch({
        contactId: message.contact_id,
        messageId: message.id,
        day: clock.date,
        status: 'sent',
      });
      result.sent += 1;
      result.items.push({ phone: message.phone, status: 'sent', detail: message.send_time });
    } catch (error) {
      const detail = error instanceof NevoaError ? error.message : 'Falha ao enviar';
      await markDispatch({
        contactId: message.contact_id,
        messageId: message.id,
        day: clock.date,
        status: 'failed',
        error: detail,
      });
      result.failed += 1;
      result.items.push({ phone: message.phone, status: 'failed', detail });
    }
  }

  const questionnaires = await runQuestionnaireDispatches();
  result.sent += questionnaires.sent;
  result.failed += questionnaires.failed;
  result.waiting += questionnaires.waiting;
  result.skipped += questionnaires.skipped;
  result.items.push(...questionnaires.items.map((item) => ({ ...item, detail: `questionário: ${item.detail}` })));
  result.questionnaires = {
    sent: questionnaires.sent,
    failed: questionnaires.failed,
    waiting: questionnaires.waiting,
    skipped: questionnaires.skipped,
  };

  const idle = await runFormsBotIdleRules();
  result.idle = { closed: idle.closed, reminded: idle.reminded, alerted: idle.alerted };
  result.items.push(...idle.items.map((item) => ({ phone: item.phone, status: 'sent', detail: item.detail })));

  return result;
}

function emptyRun(date: string): DispatchRun {
  return { date, sent: 0, failed: 0, waiting: 0, skipped: 0, items: [] };
}
