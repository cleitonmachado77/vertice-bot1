import { getSetting } from './db.js';
import { minutesFromClock, zonedNow } from './clock.js';
import { NevoaError, sendWhatsappText } from './nevoa.js';
import { dispatchStatus, listDueMessages, markDispatch, runsOnWeekday } from './plans.js';
import { ensureConversation, recordOutbound } from './thread.js';

export type DispatchRun = {
  date: string;
  sent: number;
  failed: number;
  waiting: number;
  skipped: number;
  items: { phone: string; status: string; detail: string }[];
};

export async function runDueDispatches(): Promise<DispatchRun> {
  const clock = zonedNow();
  const result: DispatchRun = {
    date: clock.date,
    sent: 0,
    failed: 0,
    waiting: 0,
    skipped: 0,
    items: [],
  };
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

  return result;
}
