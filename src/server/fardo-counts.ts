import { findBagMaterial, lookupBagType, type BagMaterial } from './bag-materials.js';

/** Padrão Produção de Fardos da Reciclabrasil. */
export const FARDO_PRODUCTION_PRESET_ID = 'be8a792d-97e5-4d71-a54d-c3e51e667ed5';

export const FARDO_QUESTION =
  'Quantos bags de qual tipo viraram quantos fardos? (ex.: 10 pts, 1 fardo)';

export type FardoRun = {
  code: string;
  name: string;
  bags: string;
  fardos: string;
};

export type FardoReading = { understood: FardoRun[]; unknown: string[] };

const FILLER =
  /^(bags?|fardos?|unidades?|de|do|da|serao|seram|sera|produzidos?|produzir|para|viraram|virou|em|que|foram|foi|usados?|usadas?|usado|criar|criou|criados?|fabricar|fabricou|fabricados?|na|no)$/;

export function isFardoProductionPreset(preset: { id?: string; kind?: string; name?: string }): boolean {
  if (preset.kind && preset.kind !== 'production') return false;
  if (String(preset.id || '') === FARDO_PRODUCTION_PRESET_ID) return true;
  const name = fold(preset.name || '');
  return name.includes('producao') && name.includes('fardo');
}

/** “10 bags de pts … 1 fardo de pts”. O fardo fica no mesmo tipo do bag. */
export function interpretFardoRuns(text: string): FardoReading {
  const pieces = quantityPieces(text);
  if (!pieces.length) return { understood: [], unknown: [] };
  const understood: FardoRun[] = [];
  const unknown: string[] = [];
  let pending: QuantityPiece | null = null;

  const closePending = () => {
    if (!pending) return;
    unknown.push(pending.raw);
    pending = null;
  };

  for (const piece of pieces) {
    const role = pieceRole(piece.rest);
    if (role === 'bag') {
      closePending();
      pending = piece;
      continue;
    }
    if (!pending) {
      unknown.push(piece.raw);
      continue;
    }
    const outcome = pairRun(pending, piece);
    if (outcome.run) understood.push(outcome.run);
    else unknown.push(outcome.note || `${pending.raw} / ${piece.raw}`);
    pending = null;
  }
  closePending();
  return { understood: mergeRuns(understood), unknown };
}

export function fardoClarification(understood: FardoRun[], unknown: string[]): string {
  const lines: string[] = [];
  if (understood.length) {
    lines.push('Entendi:', ...understood.map((item) => `- ${item.bags} bags ${item.code} (${item.name}) → ${item.fardos} fardo`));
  }
  if (unknown.length) {
    if (lines.length) lines.push('');
    lines.push('Não entendi:', ...unknown.map((item) => `- ${item}`));
  }
  lines.push('', 'O fardo é do mesmo tipo do bag. Corrija o que não entendi. Ex.: 10 pts, 1 fardo');
  return lines.join('\n');
}

/** JSON final da pergunta. Resposta parcial marcada não produz fardo. */
export function runsFromAnswer(text: string): FardoRun[] | null {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('[novo?]')) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const items: FardoRun[] = [];
    for (const row of parsed) {
      const source = row && typeof row === 'object' ? (row as { code?: string; bags?: string; fardos?: string }) : {};
      const material = findBagMaterial(String(source.code || ''));
      const bags = Number(String(source.bags || '').replace(',', '.'));
      const fardos = Number(String(source.fardos || '').replace(',', '.'));
      if (!material || !Number.isFinite(bags) || bags <= 0 || !Number.isFinite(fardos) || fardos <= 0) return null;
      items.push({ code: material.code, name: material.name, bags: formatQty(bags), fardos: formatQty(fardos) });
    }
    return items.length ? mergeRuns(items) : null;
  } catch {
    return null;
  }
}

type QuantityPiece = { qty: number; raw: string; rest: string };

function quantityPieces(text: string): QuantityPiece[] {
  const pieces: QuantityPiece[] = [];
  for (const match of String(text || '').matchAll(/(\d+(?:[.,]\d+)?)\s*([^\d]+)/gu)) {
    const qty = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    pieces.push({ qty, raw: match[0].trim().replace(/[,.;]+$/g, ''), rest: match[2] || '' });
  }
  return pieces;
}

function pieceRole(rest: string): 'bag' | 'fardo' {
  return /\bfardos?\b/.test(fold(rest)) ? 'fardo' : 'bag';
}

function typeWords(rest: string): string {
  return fold(rest)
    .replace(/[,.;]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLER.test(word))
    .join(' ');
}

function pairRun(bag: QuantityPiece, fardo: QuantityPiece): { run?: FardoRun; note?: string } {
  const bagPhrase = typeWords(bag.rest);
  const fardoPhrase = typeWords(fardo.rest);
  const bagType = bagPhrase ? lookupBagType(bagPhrase) : {};
  const fardoType = fardoPhrase ? lookupBagType(fardoPhrase) : bagType;
  if (!bagPhrase || bagType.ambiguous?.length) {
    return { note: bagType.ambiguous?.length ? ambiguityNote(bag.raw, bagType.ambiguous) : bag.raw };
  }
  if (!bagType.material) return { note: bag.raw };
  if (fardoPhrase && fardoType.ambiguous?.length) return { note: ambiguityNote(fardo.raw, fardoType.ambiguous) };
  if (fardoPhrase && !fardoType.material) return { note: fardo.raw };
  if (!fardoType.material) return { note: `${bag.raw} / ${fardo.raw}` };
  if (fardoType.material.code !== bagType.material.code) {
    return { note: `${bag.raw} / ${fardo.raw} (o fardo precisa ser ${bagType.material.code}, o mesmo tipo do bag)` };
  }
  return { run: toRun(bagType.material, bag.qty, fardo.qty) };
}

function toRun(material: BagMaterial, bags: number, fardos: number): FardoRun {
  return { code: material.code, name: material.name, bags: formatQty(bags), fardos: formatQty(fardos) };
}

function ambiguityNote(piece: string, options: BagMaterial[]): string {
  return `${piece} (pode ser ${options.map((item) => `${item.code} ${item.name}`).join(', ')})`;
}

function mergeRuns(items: FardoRun[]): FardoRun[] {
  const byCode = new Map<string, FardoRun>();
  for (const item of items) {
    const current = byCode.get(item.code);
    if (!current) {
      byCode.set(item.code, { ...item });
      continue;
    }
    current.bags = formatQty(Number(current.bags) + Number(item.bags));
    current.fardos = formatQty(Number(current.fardos) + Number(item.fardos));
  }
  return [...byCode.values()];
}

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}
