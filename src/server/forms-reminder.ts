import { getSetting, run } from './db.js';

// Lembrete único do Forms Bot: um horário padrão vale para todos os formulários.
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

/** Alinha os questionários do Forms Bot ao horário padrão (agendador, agenda e roteamento leem daqui). */
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
