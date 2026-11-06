/** Padrão Separação de Bags da Reciclabrasil. */
export const BAG_SEPARATION_PRESET_ID = '34673f79-a413-4832-940e-7f6427c9e070';

export const BAG_COUNT_QUESTION = 'Quantidade e sigla (ex.: 50 pts). Se forem vários: 50 pts, 20 lat';

export type BagMaterial = {
  name: string;
  code: string;
  category: string;
};

/** Nome da planilha, sigla de 2 ou 3 letras e categoria já usada no Odoo. */
export const BAG_MATERIALS: BagMaterial[] = [
  { name: 'BATERIA', code: 'BAT', category: 'ELETRO ELETRONICO' },
  { name: 'CACO DE VIDRO', code: 'CDV', category: 'Vidro' },
  { name: 'CAIXA DE ENGRADADO', code: 'ENG', category: 'Plástico' },
  { name: 'COBRE SUJO', code: 'COB', category: 'Metal Não Ferroso' },
  { name: 'COPINHO PLASTICO', code: 'COP', category: 'Plástico' },
  { name: 'CRISTAL', code: 'CRI', category: 'Plástico' },
  { name: 'ELETRONICO', code: 'ELE', category: 'ELETRO ELETRONICO' },
  { name: 'LATINHA', code: 'LAT', category: 'Metal Não Ferroso' },
  { name: 'LEITE', code: 'LEI', category: 'Papel' },
  { name: 'PAPELAO', code: 'PAP', category: 'Papel' },
  { name: 'PAPEL BRANCO', code: 'PBR', category: 'Papel' },
  { name: 'PAPEL MISTO', code: 'PMI', category: 'Papel' },
  { name: 'PARA-CHOQUE', code: 'PCH', category: 'Papel' },
  { name: 'PEAD BRANCO', code: 'PEB', category: 'Plástico' },
  { name: 'PEAD COLORIDO', code: 'PEC', category: 'Plástico' },
  { name: 'PET BRANCO', code: 'PTB', category: 'Plástico' },
  { name: 'PET COLORIDA', code: 'PTC', category: 'Plástico' },
  { name: 'PET OLEO', code: 'PTO', category: 'Plástico' },
  { name: 'PET VERDE', code: 'PTV', category: 'Plástico' },
  { name: 'PLASTICO SECO', code: 'PTS', category: 'Plástico' },
  { name: 'PP', code: 'PP', category: 'Plástico' },
  { name: 'PP BRANCO', code: 'PPB', category: 'Plástico' },
  { name: 'PP PRETO', code: 'PPP', category: 'Plástico' },
  { name: 'PVC', code: 'PVC', category: 'Plástico' },
  { name: 'SACOLA COLORIDA', code: 'SCC', category: 'Plástico' },
  { name: 'SACOLA PRETO', code: 'SCP', category: 'Plástico' },
  { name: 'SUCATA DE FERRO', code: 'FER', category: 'Metal Ferroso' },
];

const BY_CODE = new Map(BAG_MATERIALS.map((item) => [item.code, item]));

export type BagCount = {
  code: string;
  name: string;
  category: string;
  quantity: string;
};

export type BagParse =
  | { ok: true; items: BagCount[] }
  | { ok: false; message: string };

export function isBagSeparationPreset(preset: { id?: string; kind?: string; name?: string }): boolean {
  if (preset.kind !== 'product') return false;
  if (String(preset.id || '') === BAG_SEPARATION_PRESET_ID) return true;
  const name = fold(preset.name || '');
  return name.includes('separacao') && name.includes('bag');
}

export function findBagMaterial(code: string): BagMaterial | undefined {
  return BY_CODE.get(String(code || '').trim().toUpperCase());
}

/** Sigla ou nome cadastrado. Vários tipos com a mesma nota voltam em ambiguous. */
export function lookupBagType(phrase: string): { material?: BagMaterial; ambiguous?: BagMaterial[] } {
  return matchBagType(phrase);
}

export type BagReading = { understood: BagCount[]; unknown: string[] };

/** “50 pts, 20 latinha” ou “50 plástico seco”. O que não bater com a lista volta em unknown. */
export function interpretBagCounts(text: string): BagReading {
  const pieces = splitBagPieces(text);
  if (!pieces.length) return { understood: [], unknown: [] };
  const understood: BagCount[] = [];
  const unknown: string[] = [];
  for (const piece of pieces) {
    const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/u.exec(piece);
    if (!match) {
      unknown.push(piece);
      continue;
    }
    const quantity = Number(match[1].replace(',', '.'));
    const phrase = cleanTypePhrase(match[2]);
    if (!Number.isFinite(quantity) || quantity <= 0 || !phrase) {
      unknown.push(piece);
      continue;
    }
    const found = matchBagType(phrase);
    if (found.material) {
      understood.push({
        code: found.material.code,
        name: found.material.name,
        category: found.material.category,
        quantity: formatQty(quantity),
      });
      continue;
    }
    unknown.push(found.ambiguous?.length ? ambiguityNote(piece, found.ambiguous) : piece);
  }
  return { understood: mergeCounts(understood), unknown };
}

/** Só fecha quando todos os itens foram reconhecidos. */
export function parseBagCounts(text: string): BagParse {
  const reading = interpretBagCounts(text);
  if (!reading.understood.length || reading.unknown.length) {
    return { ok: false, message: bagClarification(reading.understood, reading.unknown.length ? reading.unknown : [String(text || '').trim() || 'mensagem vazia']) };
  }
  return { ok: true, items: reading.understood };
}

/** Mostra o que fechou e o que precisa de correção, sem sair da pergunta. */
export function bagClarification(understood: BagCount[], unknown: string[]): string {
  const lines: string[] = [];
  if (understood.length) {
    lines.push('Entendi:', ...understood.map((item) => `- ${item.quantity} ${item.code} (${item.name})`));
  }
  if (unknown.length) {
    if (lines.length) lines.push('');
    lines.push('Não entendi:', ...unknown.map((item) => `- ${item}`));
  }
  lines.push('', 'Corrija o que não entendi. Ex.: 10 pap');
  return lines.join('\n');
}

/** Resposta gravada (JSON) ou texto livre da conversa. */
export function countsFromAnswer(text: string): BagCount[] | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const items: BagCount[] = [];
      for (const row of parsed) {
        const source = row && typeof row === 'object' ? (row as { code?: string; quantity?: string }) : {};
        const material = findBagMaterial(String(source.code || ''));
        const quantity = Number(String(source.quantity || '').replace(',', '.'));
        if (!material || !Number.isFinite(quantity) || quantity <= 0) return null;
        items.push({
          code: material.code,
          name: material.name,
          category: material.category,
          quantity: formatQty(quantity),
        });
      }
      return items.length ? mergeCounts(items) : null;
    }
  } catch {
    /* texto livre */
  }
  const parsed = parseBagCounts(raw);
  return parsed.ok ? parsed.items : null;
}

function splitBagPieces(text: string): string[] {
  const chunks = String(text || '')
    .split(/\s*(?:,|;|\n|\+|\s+\be\b\s+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const chunk of chunks) {
    const bits = chunk.split(/\s+(?=\d+(?:[.,]\d+)?(?:\s|\p{L}))/u).map((part) => part.trim()).filter(Boolean);
    pieces.push(...(bits.length ? bits : [chunk]));
  }
  return pieces;
}

function cleanTypePhrase(value: string): string {
  return fold(value)
    .replace(/^(bags?|unidades?)\s+/, '')
    .replace(/^(de|do|da)\s+/, '')
    .replace(/^(bags?|unidades?)\s+/, '')
    .trim();
}

function matchBagType(phrase: string): { material?: BagMaterial; ambiguous?: BagMaterial[] } {
  const text = cleanTypePhrase(phrase);
  if (!text) return {};
  const byCode = BAG_MATERIALS.find((item) => fold(item.code) === text);
  if (byCode) return { material: byCode };
  const byName = BAG_MATERIALS.filter((item) => fold(item.name) === text);
  if (byName.length === 1) return { material: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };
  const words = text.split(' ').filter(Boolean);
  const scored = BAG_MATERIALS.map((item) => ({ item, score: scoreType(words, fold(item.name)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return {};
  const top = scored.filter((row) => row.score === scored[0].score);
  if (top.length > 1) return { ambiguous: top.map((row) => row.item) };
  return { material: scored[0].item };
}

function scoreType(words: string[], name: string): number {
  const nameWords = name.split(' ').filter(Boolean);
  if (!words.length || !words.every((word) => nameWords.includes(word))) return 0;
  return 80 + words.length;
}

function ambiguityNote(piece: string, options: BagMaterial[]): string {
  const list = options.map((item) => `${item.code} ${item.name}`).join(', ');
  return `${piece} (pode ser ${list})`;
}

function mergeCounts(items: BagCount[]): BagCount[] {
  const byCode = new Map<string, BagCount>();
  for (const item of items) {
    const current = byCode.get(item.code);
    if (!current) {
      byCode.set(item.code, { ...item });
      continue;
    }
    current.quantity = formatQty(Number(current.quantity) + Number(item.quantity));
  }
  return [...byCode.values()];
}

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export { bagVariantRef, ensureBagMaterials, fardoVariantRef } from './bag-product.js';

function fold(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ç/g, 'c')
    .trim();
}
