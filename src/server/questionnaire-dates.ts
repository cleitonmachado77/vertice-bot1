export type TemporalRelation = 'past' | 'present' | 'future';

export type OccurrenceDateRef = {
  /** YYYY-MM-DD do ciclo alvo. */
  date: string;
  /** true se a mensagem citou data (relativa, weekday ou absoluta). */
  explicit: boolean;
  relation: TemporalRelation;
  /** Rótulo amigável para o agente (ex.: "amanhã", "15/10/2026"). */
  label: string;
};

const WEEKDAY_NAMES: { re: RegExp; day: number; label: string }[] = [
  { re: /\bdomingo\b/, day: 0, label: 'domingo' },
  { re: /\bsegunda(?:-feira)?\b/, day: 1, label: 'segunda' },
  { re: /\bterca(?:-feira)?\b/, day: 2, label: 'terça' },
  { re: /\bquarta(?:-feira)?\b/, day: 3, label: 'quarta' },
  { re: /\bquinta(?:-feira)?\b/, day: 4, label: 'quinta' },
  { re: /\bsexta(?:-feira)?\b/, day: 5, label: 'sexta' },
  { re: /\bsabado\b/, day: 6, label: 'sábado' },
];

/** Weekday 0=Dom … 6=Sáb a partir de YYYY-MM-DD (calendário). */
export function weekdayFromIsoDate(isoDate: string): number {
  const parts = parseIso(isoDate);
  if (!parts) return 0;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const parts = parseIso(isoDate);
  if (!parts) return isoDate;
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function compareIsoDates(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function temporalRelation(today: string, date: string): TemporalRelation {
  const cmp = compareIsoDates(date, today);
  if (cmp < 0) return 'past';
  if (cmp > 0) return 'future';
  return 'present';
}

export function formatBrDate(isoDate: string): string {
  const parts = parseIso(isoDate);
  if (!parts) return isoDate;
  return `${String(parts.d).padStart(2, '0')}/${String(parts.m).padStart(2, '0')}/${parts.y}`;
}

/**
 * Interpreta passado / presente / futuro na mensagem para escolher a data do ciclo.
 * Prioridade: data absoluta > relativa (ontem/hoje/amanhã…) > dia da semana.
 */
export function parseOccurrenceDateRef(today: string, text: string): OccurrenceDateRef {
  const normalized = foldText(text);
  if (!normalized) {
    return { date: today, explicit: false, relation: 'present', label: 'hoje' };
  }

  const absolute = parseAbsoluteDate(normalized, today);
  if (absolute) return withRelation(today, absolute.date, true, absolute.label);

  const relative = parseRelativeDate(normalized, today);
  if (relative) return withRelation(today, relative.date, true, relative.label);

  const weekday = parseWeekdayDate(normalized, today);
  if (weekday) return withRelation(today, weekday.date, true, weekday.label);

  return { date: today, explicit: false, relation: 'present', label: 'hoje' };
}

/** Compat: só a data ISO alvo. */
export function relativeOccurrenceDate(today: string, text: string): string {
  return parseOccurrenceDateRef(today, text).date;
}

export function temporalRelationLabel(relation: TemporalRelation): string {
  if (relation === 'past') return 'passado';
  if (relation === 'future') return 'futuro';
  return 'presente (hoje)';
}

function withRelation(
  today: string,
  date: string,
  explicit: boolean,
  label: string,
): OccurrenceDateRef {
  return { date, explicit, relation: temporalRelation(today, date), label };
}

function parseRelativeDate(
  normalized: string,
  today: string,
): { date: string; label: string } | undefined {
  if (/\bdepois\s+de\s+amanha\b/.test(normalized) || /\bapos\s+amanha\b/.test(normalized)) {
    return { date: shiftIsoDate(today, 2), label: 'depois de amanhã' };
  }
  if (/\banteontem\b/.test(normalized)) {
    return { date: shiftIsoDate(today, -2), label: 'anteontem' };
  }
  if (/\bontem\b/.test(normalized)) {
    return { date: shiftIsoDate(today, -1), label: 'ontem' };
  }
  if (/\bamanha\b/.test(normalized)) {
    return { date: shiftIsoDate(today, 1), label: 'amanhã' };
  }
  if (/\bhoje\b/.test(normalized)) {
    return { date: today, label: 'hoje' };
  }
  return undefined;
}

function parseAbsoluteDate(
  normalized: string,
  today: string,
): { date: string; label: string } | undefined {
  const iso = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (isValidIso(date)) return { date, label: formatBrDate(date) };
  }

  const br = normalized.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
  if (!br) return undefined;
  const todayParts = parseIso(today);
  if (!todayParts) return undefined;
  const day = Number(br[1]);
  const month = Number(br[2]);
  let year = br[3]
    ? br[3].length === 2
      ? 2000 + Number(br[3])
      : Number(br[3])
    : todayParts.y;
  if (!Number.isFinite(day) || !Number.isFinite(month) || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  let date = toIso(year, month, day);
  if (!isValidIso(date)) return undefined;
  // Sem ano: se a data caiu há mais de ~180 dias, assume ano seguinte (intenção futura).
  if (!br[3] && compareIsoDates(date, shiftIsoDate(today, -180)) < 0) {
    date = toIso(year + 1, month, day);
    if (!isValidIso(date)) return undefined;
  }
  return { date, label: formatBrDate(date) };
}

function parseWeekdayDate(
  normalized: string,
  today: string,
): { date: string; label: string } | undefined {
  const hit = WEEKDAY_NAMES.find((item) => item.re.test(normalized));
  if (!hit) return undefined;
  const past = /\b(passad[oa]|anterior|ultima|ultimo)\b/.test(normalized);
  const next = /\b(proxim[oa]|que\s+vem)\b/.test(normalized);
  const todayWeekday = weekdayFromIsoDate(today);
  let delta = (hit.day - todayWeekday + 7) % 7;
  if (past) {
    delta = delta === 0 ? -7 : delta - 7;
  } else if (next) {
    delta = delta === 0 ? 7 : delta;
  } else if (delta === 0) {
    // "na segunda" dito na própria segunda → hoje.
    delta = 0;
  }
  const date = shiftIsoDate(today, delta);
  const prefix = past ? 'passada' : next ? 'próxima' : '';
  return {
    date,
    label: prefix ? `${hit.label} ${prefix}` : hit.label,
  };
}

function foldText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}

function parseIso(isoDate: string): { y: number; m: number; d: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return undefined;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isValidIso(isoDate: string): boolean {
  const parts = parseIso(isoDate);
  if (!parts) return false;
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  return (
    date.getUTCFullYear() === parts.y &&
    date.getUTCMonth() === parts.m - 1 &&
    date.getUTCDate() === parts.d
  );
}
