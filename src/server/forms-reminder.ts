import { getSetting, many, run } from './db.js';

// Horário padrão do Forms Bot, com substituição por contato.
// Os formulários ficam sempre disponíveis no menu; o horário só lembra o contato.

export type ReminderDays = 'daily' | 'weekdays';

export const REMINDER_TIME_SETTING = 'bot_reminder_time';
export const REMINDER_DAYS_SETTING = 'bot_reminder_days';

export function sanitizeReminderTime(raw: unknown): string {
  const value = String(raw || '').trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '08:00';
}

export function sanitizeReminderDays(raw: unknown): ReminderDays {
  return String(raw || '').trim() === 'weekdays' ? 'weekdays' : 'daily';
}

export function formsReminderSchedule(): { frequency: ReminderDays; weekday: number; sendTime: string } {
  return {
    frequency: sanitizeReminderDays(getSetting(REMINDER_DAYS_SETTING, 'daily')),
    weekday: 1,
    sendTime: sanitizeReminderTime(getSetting(REMINDER_TIME_SETTING, '08:00')),
  };
}

/** Horário efetivo do envio. Sem horário próprio, usa o padrão. */
export function effectiveReminder(input: {
  defaultTime: string;
  defaultDays: unknown;
  contactTime?: string | null;
  contactDays?: string | null;
}): { sendTime: string; frequency: ReminderDays } {
  const own = String(input.contactTime || '').trim();
  if (!own) {
    return {
      sendTime: sanitizeReminderTime(input.defaultTime),
      frequency: sanitizeReminderDays(input.defaultDays),
    };
  }
  return {
    sendTime: sanitizeReminderTime(own),
    frequency: sanitizeReminderDays(input.contactDays),
  };
}

export type FormsReminderContact = {
  id: string;
  name: string;
  phone: string;
  /** Vazio quando o contato segue o horário padrão. */
  sendTime: string;
  days: string;
};

/** Contatos com formulário do Forms Bot, e o horário próprio quando existir. */
export async function listFormsReminderContacts(): Promise<FormsReminderContact[]> {
  const rows = await many<{
    id: string;
    name: string;
    phone: string;
    send_time: string;
    days: string;
  }>(
    `SELECT c.id, c.name, c.phone,
            COALESCE(s.send_time, '') AS send_time,
            COALESCE(s.days, '') AS days
     FROM contacts c
     JOIN questionnaire_assignments a ON a.contact_id = c.id
     JOIN questionnaires q ON q.id = a.questionnaire_id
     LEFT JOIN contact_reminder_schedules s ON s.contact_id = c.id
     WHERE q.active = 1 AND q.deleted_at = '' AND c.hidden = 0
       AND (COALESCE(q.source_preset_id, '') <> '' OR q.id LIKE 'forms-preset:%')
     GROUP BY c.id, c.name, c.phone, s.send_time, s.days
     ORDER BY c.name, c.phone`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    sendTime: row.send_time ? sanitizeReminderTime(row.send_time) : '',
    days: row.send_time ? sanitizeReminderDays(row.days) : '',
  }));
}

export async function saveContactReminderSchedules(
  items: Array<{ contactId?: string; useDefault?: boolean; reminderTime?: string; reminderDays?: string }>,
): Promise<void> {
  const allowed = new Set((await listFormsReminderContacts()).map((item) => item.id));
  const stamp = new Date().toISOString();
  for (const item of items) {
    const contactId = String(item.contactId || '').trim();
    if (!allowed.has(contactId)) continue;
    if (item.useDefault !== false) {
      await run('DELETE FROM contact_reminder_schedules WHERE contact_id = $1', [contactId]);
      continue;
    }
    await run(
      `INSERT INTO contact_reminder_schedules(contact_id, send_time, days, updated_at)
       VALUES($1, $2, $3, $4)
       ON CONFLICT(contact_id) DO UPDATE SET
         send_time = excluded.send_time,
         days = excluded.days,
         updated_at = excluded.updated_at`,
      [contactId, sanitizeReminderTime(item.reminderTime), sanitizeReminderDays(item.reminderDays), stamp],
    );
  }
}

/** Alinha os questionários do Forms Bot ao horário padrão. O contato com horário próprio substitui na hora do envio. */
export async function applyFormsReminderSchedule(): Promise<void> {
  const schedule = formsReminderSchedule();
  await run(
    `UPDATE questionnaires
     SET frequency = $1, weekday = $2, send_time = $3, updated_at = $4
     WHERE (COALESCE(source_preset_id, '') <> '' OR id LIKE 'forms-preset:%')
       AND (frequency <> $1 OR weekday <> $2 OR send_time <> $3)`,
    [schedule.frequency, schedule.weekday, schedule.sendTime, new Date().toISOString()],
  );
}
