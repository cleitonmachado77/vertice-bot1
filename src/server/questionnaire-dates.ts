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

export type DatedSegment = OccurrenceDateRef & {
  /** Trecho da mensagem referente a esta data. */
  text: string;
};

type DateMarker = {
  index: number;
  length: number;
  date: string;
  label: string;
};

/**
 * Interpreta passado / presente / futuro na mensagem para escolher a data do ciclo.
 * Com várias datas, usa a primeira citação (veja também splitDatedSegments).
 */
export function parseOccurrenceDateRef(today: string, text: string): OccurrenceDateRef {
  const [first] = splitDatedSegments(today, text);
  return {
    date: first.date,
    explicit: first.explicit,
    relation: first.relation,
    label: first.label,
  };
}

/**
 * Parte a mensagem em trechos por data citada (ex.: “dia 16/10 … e dia 10/10 …”).
 * Uma data só → um segmento com o texto inteiro.
 */
export function splitDatedSegments(today: string, text: string): DatedSegment[] {
  const original = String(text || '').trim();
  const normalized = foldText(original);
  if (!normalized) {
    return [{ date: today, explicit: false, relation: 'present', label: 'hoje', text: '' }];
  }

  const markers = findDateMarkers(today, normalized);
  if (!markers.length) {
    return [
      {
        date: today,
        explicit: false,
        relation: 'present',
        label: 'hoje',
        text: original,
      },
    ];
  }

  const uniqueDates = new Set(markers.map((item) => item.date));
  if (uniqueDates.size === 1) {
    const marker = markers[0];
    return [
      {
        ...withRelation(today, marker.date, true, marker.label),
        text: original,
      },
    ];
  }

  const segments: DatedSegment[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const start = i === 0 ? 0 : markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : normalized.length;
    let chunk = normalized.slice(start, end).trim();
    chunk = chunk.replace(/^(e|e\s+tambem|,)\s+/i, '').trim();
    if (!chunk) continue;
    const prev = segments[segments.length - 1];
    if (prev && prev.date === markers[i].date) {
      prev.text = `${prev.text} ${chunk}`.trim();
      continue;
    }
    segments.push({
      ...withRelation(today, markers[i].date, true, markers[i].label),
      text: chunk,
    });
  }

  return segments.length
    ? segments
    : [{ date: today, explicit: false, relation: 'present', label: 'hoje', text: original }];
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

function findDateMarkers(today: string, normalized: string): DateMarker[] {
  const markers: DateMarker[] = [];

  for (const match of normalized.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    if (match.index === undefined) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (!isValidIso(date)) continue;
    markers.push({
      index: match.index,
      length: match[0].length,
      date,
      label: formatBrDate(date),
    });
  }

  for (const match of normalized.matchAll(
    /\b(?:dia\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/g,
  )) {
    if (match.index === undefined) continue;
    const resolved = resolveBrDate(today, match[1], match[2], match[3]);
    if (!resolved) continue;
    markers.push({
      index: match.index,
      length: match[0].length,
      date: resolved.date,
      label: resolved.label,
    });
  }

  const relatives: { re: RegExp; days: number; label: string }[] = [
    { re: /\bdepois\s+de\s+amanha\b/g, days: 2, label: 'depois de amanhã' },
    { re: /\bapos\s+amanha\b/g, days: 2, label: 'depois de amanhã' },
    { re: /\banteontem\b/g, days: -2, label: 'anteontem' },
    { re: /\bontem\b/g, days: -1, label: 'ontem' },
    { re: /\bamanha\b/g, days: 1, label: 'amanhã' },
    { re: /\bhoje\b/g, days: 0, label: 'hoje' },
  ];
  for (const item of relatives) {
    for (const match of normalized.matchAll(item.re)) {
      if (match.index === undefined) continue;
      const date = shiftIsoDate(today, item.days);
      markers.push({
        index: match.index,
        length: match[0].length,
        date,
        label: item.label,
      });
    }
  }

  for (const item of WEEKDAY_NAMES) {
    const re = new RegExp(item.re.source, 'g');
    for (const match of normalized.matchAll(re)) {
      if (match.index === undefined) continue;
      const window = normalized.slice(Math.max(0, match.index - 16), match.index + match[0].length + 16);
      const past = /\b(passad[oa]|anterior|ultima|ultimo)\b/.test(window);
      const next = /\b(proxim[oa]|que\s+vem)\b/.test(window);
      const todayWeekday = weekdayFromIsoDate(today);
      let delta = (item.day - todayWeekday + 7) % 7;
      if (past) delta = delta === 0 ? -7 : delta - 7;
      else if (next) delta = delta === 0 ? 7 : delta;
      const date = shiftIsoDate(today, delta);
      const prefix = past ? 'passada' : next ? 'próxima' : '';
      markers.push({
        index: match.index,
        length: match[0].length,
        date,
        label: prefix ? `${item.label} ${prefix}` : item.label,
      });
    }
  }

  markers.sort((a, b) => a.index - b.index || b.length - a.length);
  const filtered: DateMarker[] = [];
  for (const marker of markers) {
    const overlaps = filtered.some(
      (item) =>
        !(marker.index + marker.length <= item.index || marker.index >= item.index + item.length),
    );
    if (!overlaps) filtered.push(marker);
  }
  return filtered;
}

function resolveBrDate(
  today: string,
  dayRaw: string,
  monthRaw: string,
  yearRaw?: string,
): { date: string; label: string } | undefined {
  const todayParts = parseIso(today);
  if (!todayParts) return undefined;
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  let year = yearRaw
    ? yearRaw.length === 2
      ? 2000 + Number(yearRaw)
      : Number(yearRaw)
    : todayParts.y;
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  let date = toIso(year, month, day);
  if (!isValidIso(date)) return undefined;
  if (!yearRaw && compareIsoDates(date, shiftIsoDate(today, -180)) < 0) {
    date = toIso(year + 1, month, day);
    if (!isValidIso(date)) return undefined;
  }
  return { date, label: formatBrDate(date) };
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
