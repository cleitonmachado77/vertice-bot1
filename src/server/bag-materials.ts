import { getSetting } from './db.js';

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

/**
 * Tipos da Associação de Florestopolis (Bag/Fardo).
 * Serviços da planilha (Emissão fiscal, Travel Fees) ficam de fora — não são material.
 */
export const BAG_MATERIALS_FLORESTOPOLIS: BagMaterial[] = [
  { name: 'COPINHO', code: 'COP', category: 'Plástico' },
  { name: 'CRISTAL', code: 'CRI', category: 'Plástico' },
  { name: 'PET', code: 'PET', category: 'Plástico' },
  { name: 'PP BRANCO', code: 'PPB', category: 'Plástico' },
  { name: 'PP COLORIDO', code: 'PPC', category: 'Plástico' },
  { name: 'PVC', code: 'PVC', category: 'Plástico' },
  { name: 'PAPELAO', code: 'PAP', category: 'Papel' },
  { name: 'PEAD BRANCO', code: 'PEB', category: 'Plástico' },
  { name: 'PEAD COLORIDO', code: 'PEC', category: 'Plástico' },
  { name: 'PLASTICO PRETO', code: 'PLP', category: 'Plástico' },
  { name: 'RAFIA', code: 'RAF', category: 'Plástico' },
  { name: 'SACOLINHA COLORIDA', code: 'SAC', category: 'Plástico' },
  { name: 'TETRA PARK', code: 'TEP', category: 'Papel' },
];

/** Tipos da Reciclagem Sertanópolis (Bag/Fardo). */
export const BAG_MATERIALS_SERTANOPOLIS: BagMaterial[] = [
  { name: 'PL FINO CANELA', code: 'PFC', category: 'Plástico' },
  { name: 'PL FINO COLORIDO', code: 'PLF', category: 'Plástico' },
  { name: 'PL FINO PRETO', code: 'PFP', category: 'Plástico' },
  { name: 'PP COLORIDO', code: 'PPC', category: 'Plástico' },
  { name: 'PP PRETO', code: 'PPP', category: 'Plástico' },
  { name: 'PAPEL BRANCO', code: 'PAB', category: 'Papel' },
  { name: 'PAPELAO', code: 'PAP', category: 'Papel' },
  { name: 'PEAD COLORIDO', code: 'PEC', category: 'Plástico' },
  { name: 'PET BRANCA VERDE', code: 'PBV', category: 'Plástico' },
  { name: 'PET OLEO', code: 'PEO', category: 'Plástico' },
  { name: 'TERCEIRA', code: 'TER', category: 'Papel' },
  { name: 'TETRA', code: 'TET', category: 'Papel' },
];

/** Tipos da Cooperjaty / Jataizinho (Bag/Fardo) — PDF Abreviações de Produtos. */
export const BAG_MATERIALS_COOPERJATY: BagMaterial[] = [
  { name: 'ALUMINIO', code: 'ALU', category: 'Metal Não Ferroso' },
  { name: 'BERLIM', code: 'BER', category: 'Vidro' },
  { name: 'BORDALEZA', code: 'BOR', category: 'Vidro' },
  { name: 'BRANCO', code: 'BRA', category: 'Papel' },
  { name: 'CL', code: 'CLS', category: 'Plástico' },
  { name: 'CILINDRINHO', code: 'CIL', category: 'Vidro' },
  { name: 'CRISTAL', code: 'CRI', category: 'Plástico' },
  { name: 'FERRO', code: 'FER', category: 'Metal Ferroso' },
  { name: 'GARRAFA DE CERVEJA', code: 'GAC', category: 'Vidro' },
  { name: 'GRANADA', code: 'GRA', category: 'Vidro' },
  { name: 'HEINEKEN', code: 'HEI', category: 'Vidro' },
  { name: 'JAMEL LISA', code: 'JAL', category: 'Vidro' },
  { name: 'JAMEL TIMBRADA', code: 'JAT', category: 'Vidro' },
  { name: 'LEITE', code: 'LEI', category: 'Papel' },
  { name: 'LITRINHO LISO', code: 'LIL', category: 'Vidro' },
  { name: 'METAL', code: 'MET', category: 'Metal Não Ferroso' },
  { name: 'MISTO', code: 'MIS', category: 'Papel' },
  { name: 'P OLEO', code: 'POE', category: 'Plástico' },
  { name: 'PAD', code: 'PAD', category: 'Plástico' },
  { name: 'PP', code: 'PPL', category: 'Plástico' },
  { name: 'PALMITO', code: 'PAL', category: 'Vidro' },
  { name: 'PANELA', code: 'PAN', category: 'Metal Ferroso' },
  { name: 'PAPELAO', code: 'PAP', category: 'Papel' },
  { name: 'PET', code: 'PET', category: 'Plástico' },
  { name: 'POTAO', code: 'POT', category: 'Vidro' },
  { name: 'PRESIDENTE', code: 'PRE', category: 'Vidro' },
  { name: 'S PRETO', code: 'SPR', category: 'Plástico' },
  { name: 'SACOLINHA', code: 'SAC', category: 'Plástico' },
  { name: 'VIDRO', code: 'VID', category: 'Vidro' },
  { name: 'VINHO TUBINHO', code: 'VIT', category: 'Vidro' },
  { name: 'ZAELAO', code: 'ZAE', category: 'Vidro' },
];

/** Setting gravado ao promover o parceiro Florestopolis a res.company. */
export const FLORESTOPOLIS_COMPANY_SETTING = 'odoo_company_florestopolis_id';
export const SERTANOPOLIS_COMPANY_SETTING = 'odoo_company_sertanopolis_id';
export const COOPERJATY_COMPANY_SETTING = 'odoo_company_cooperjaty_id';

/** Ids Odoo conhecidos (fallback se o setting ainda não foi gravado). */
const FLORESTOPOLIS_COMPANY_ID_FALLBACK = 22;
const SERTANOPOLIS_COMPANY_ID_FALLBACK = 9;
const COOPERJATY_COMPANY_ID_FALLBACK = 12;

/** Siglas exclusivas + Recicla por último (códigos compartilhados mantêm o nome da Recicla). */
const BY_CODE = new Map<string, BagMaterial>([
  ...BAG_MATERIALS_COOPERJATY.map((item) => [item.code, item] as const),
  ...BAG_MATERIALS_SERTANOPOLIS.map((item) => [item.code, item] as const),
  ...BAG_MATERIALS_FLORESTOPOLIS.map((item) => [item.code, item] as const),
  ...BAG_MATERIALS.map((item) => [item.code, item] as const),
]);

/** Materiais cadastrados no Bag/Fardo da empresa (Recicla Brasil = padrão). */
export function materialsForCompany(companyId: number): BagMaterial[] {
  if (!companyId) return BAG_MATERIALS;
  const florestId = Number(getFlorestopolisCompanyId() || FLORESTOPOLIS_COMPANY_ID_FALLBACK);
  if (companyId === florestId) return BAG_MATERIALS_FLORESTOPOLIS;
  const sertaId = Number(getSertanopolisCompanyId() || SERTANOPOLIS_COMPANY_ID_FALLBACK);
  if (companyId === sertaId) return BAG_MATERIALS_SERTANOPOLIS;
  const jatyId = Number(getCooperjatyCompanyId() || COOPERJATY_COMPANY_ID_FALLBACK);
  if (companyId === jatyId) return BAG_MATERIALS_COOPERJATY;
  return BAG_MATERIALS;
}

export function getFlorestopolisCompanyId(): string {
  return String(getSetting(FLORESTOPOLIS_COMPANY_SETTING) || '').trim();
}

export function getSertanopolisCompanyId(): string {
  return String(getSetting(SERTANOPOLIS_COMPANY_SETTING) || '').trim();
}

export function getCooperjatyCompanyId(): string {
  return String(getSetting(COOPERJATY_COMPANY_SETTING) || '').trim();
}

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

export function findBagMaterial(code: string, companyId?: number): BagMaterial | undefined {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return undefined;
  if (companyId && companyId > 0) {
    return materialsForCompany(companyId).find((item) => item.code === key);
  }
  return BY_CODE.get(key);
}

/** Sigla ou nome cadastrado. Vários tipos com a mesma nota voltam em ambiguous. */
export function lookupBagType(
  phrase: string,
  materials: BagMaterial[] = BAG_MATERIALS,
): { material?: BagMaterial; ambiguous?: BagMaterial[] } {
  return matchBagType(phrase, materials);
}

export type BagReading = { understood: BagCount[]; unknown: string[] };

/** “50 pts, 20 latinha” ou “50 plástico seco”. O que não bater com a lista volta em unknown. */
export function interpretBagCounts(text: string, materials: BagMaterial[] = BAG_MATERIALS): BagReading {
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
    const found = matchBagType(phrase, materials);
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
export function parseBagCounts(text: string, materials: BagMaterial[] = BAG_MATERIALS): BagParse {
  const reading = interpretBagCounts(text, materials);
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
export function countsFromAnswer(text: string, companyId?: number): BagCount[] | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const materials = companyId && companyId > 0 ? materialsForCompany(companyId) : BAG_MATERIALS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const items: BagCount[] = [];
      for (const row of parsed) {
        const source = row && typeof row === 'object' ? (row as { code?: string; quantity?: string }) : {};
        const material = findBagMaterial(String(source.code || ''), companyId);
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
  const parsed = parseBagCounts(raw, materials);
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

function matchBagType(
  phrase: string,
  materials: BagMaterial[] = BAG_MATERIALS,
): { material?: BagMaterial; ambiguous?: BagMaterial[] } {
  const text = cleanTypePhrase(phrase);
  if (!text) return {};
  const byCode = materials.find((item) => fold(item.code) === text);
  if (byCode) return { material: byCode };
  const byName = materials.filter((item) => fold(item.name) === text);
  if (byName.length === 1) return { material: byName[0] };
  if (byName.length > 1) return { ambiguous: byName };
  const words = text.split(' ').filter(Boolean);
  const scored = materials.map((item) => ({ item, score: scoreType(words, fold(item.name)) }))
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
