import { getSetting } from './db.js';

/** Regras de fechamento do Forms Bot por padrão. `null` = usa o padrão global (settings). */
export type FormsBotRules = {
  /** Minutos parado até o lembrete “Mais algum produto?” (0 = sem lembrete). */
  idle_reminder_minutes: number | null;
  /** Minutos parado até encerrar sozinho (0 = nunca encerra sozinho). */
  idle_close_minutes: number | null;
  /** Mostra o resumo e pede “sim / corrigir” antes de gerar o registro. */
  confirm_before_close: boolean;
};

export const DEFAULT_FORMS_BOT_RULES: FormsBotRules = {
  idle_reminder_minutes: null,
  idle_close_minutes: null,
  confirm_before_close: false,
};

export const IDLE_REMINDER_SETTING = 'forms_bot_idle_reminder_minutes';
export const IDLE_CLOSE_SETTING = 'forms_bot_idle_close_minutes';
/** Parado com dados obrigatórios faltando por N min → alerta no painel. */
export const STALLED_ALERT_SETTING = 'forms_bot_stalled_alert_minutes';
/** “22:00-07:00”: sem lembretes/avisos nesse intervalo (fica para o próximo horário permitido). */
export const QUIET_HOURS_SETTING = 'forms_bot_quiet_hours';

const MAX_MINUTES = 7 * 24 * 60;

function minutesOrNull(raw: unknown): number | null {
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.trunc(value), MAX_MINUTES);
}

export function sanitizeFormsBotRules(raw: unknown): FormsBotRules {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    idle_reminder_minutes: minutesOrNull(src.idle_reminder_minutes),
    idle_close_minutes: minutesOrNull(src.idle_close_minutes),
    confirm_before_close: Boolean(src.confirm_before_close),
  };
}

export function parseFormsBotRules(json: string | undefined): FormsBotRules {
  try {
    return sanitizeFormsBotRules(JSON.parse(json || '{}'));
  } catch {
    return { ...DEFAULT_FORMS_BOT_RULES };
  }
}

function settingMinutes(key: string, fallback: number): number {
  return minutesOrNull(getSetting(key, String(fallback))) ?? fallback;
}

export type EffectiveIdleRules = {
  reminderMinutes: number;
  closeMinutes: number;
  stalledAlertMinutes: number;
};

/** Regras do padrão com fallback para as globais (lembrete 15, encerramento 30, alerta 240). */
export function effectiveIdleRules(rules: FormsBotRules): EffectiveIdleRules {
  return {
    reminderMinutes: rules.idle_reminder_minutes ?? settingMinutes(IDLE_REMINDER_SETTING, 15),
    closeMinutes: rules.idle_close_minutes ?? settingMinutes(IDLE_CLOSE_SETTING, 30),
    stalledAlertMinutes: settingMinutes(STALLED_ALERT_SETTING, 240),
  };
}

/** “22:00-07:00” → true entre 22h e 7h (minutos do dia no fuso do app). */
export function isQuietTime(minutesOfDay: number, range = getSetting(QUIET_HOURS_SETTING, '22:00-07:00')): boolean {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(range || '');
  if (!match) return false;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) return false;
  return start < end
    ? minutesOfDay >= start && minutesOfDay < end
    : minutesOfDay >= start || minutesOfDay < end;
}
