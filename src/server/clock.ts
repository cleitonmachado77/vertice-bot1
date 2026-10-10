import { getSetting } from './db.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedNow(timeZone = getSetting('timezone', 'America/Sao_Paulo')): {
  date: string;
  minutes: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const read = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    minutes: Number(read('hour')) * 60 + Number(read('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(weekdayName)),
  };
}

export function minutesFromClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 9 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}
