import { many } from './db.js';
import { sqlPartnerVisibleInCompany } from './forms-companies.js';
import type { FormCatalogRef, FormField, FormKind } from './forms-fields.js';
import { headerFieldsFor, lineFieldsFor } from './forms-fields.js';
import { listOdooRefsGrouped } from './forms-odoo-refs.js';
import { odooLabelPt } from './odoo-pt.js';

export type MatchCandidate = { value: string; label: string; score: number };

function normalize(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreMatch(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.startsWith(q) || q.startsWith(c)) return 90;
  if (c.includes(q) || q.includes(c)) return 75;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const cTokens = new Set(c.split(/\s+/).filter(Boolean));
  const hit = qTokens.filter((token) => cTokens.has(token)).length;
  if (!hit) return 0;
  return Math.round((hit / qTokens.length) * 60);
}

function fieldByKey(kind: FormKind, key: string): FormField | undefined {
  return [...headerFieldsFor(kind), ...lineFieldsFor(kind)].find((field) => field.key === key);
}

function parseHeader(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) {
      out[key] = item == null ? '' : String(item);
    }
    return out;
  } catch {
    return {};
  }
}

export function isFormsCatalogField(field: FormField | undefined): boolean {
  if (!field) return false;
  return Boolean(field.catalog) || field.key === 'vendor' || field.key === 'customer' || field.key === 'product';
}

export async function listCatalogOptionsForField(
  kind: FormKind,
  fieldKey: string,
  companyId: string,
): Promise<MatchCandidate[]> {
  const field = fieldByKey(kind, fieldKey);
  if (!field) return [];
  return catalogOptions(kind, field, companyId);
}

async function catalogOptions(
  kind: FormKind,
  field: FormField,
  companyId: string,
): Promise<MatchCandidate[]> {
  if (field.key === 'vendor' || field.key === 'customer') {
    const wantVendor = field.key === 'vendor';
    const rows = await many<{ name: string; is_customer: number; is_vendor: number }>(
      `SELECT name, is_customer, is_vendor FROM forms_partners
       WHERE ${sqlPartnerVisibleInCompany('$1')}
       ORDER BY name ASC`,
      [companyId],
    );
    return rows
      .filter((item) => (wantVendor ? Number(item.is_vendor) === 1 : Number(item.is_customer) === 1))
      .map((item) => ({ value: item.name, label: item.name, score: 0 }));
  }
  if (field.key === 'product') {
    const rows = await many<{ header_json: string }>(
      `SELECT header_json FROM forms_documents
       WHERE kind = 'product' AND COALESCE(NULLIF(company_odoo_id, ''), '1') = $1
       ORDER BY updated_at DESC`,
      [companyId],
    );
    const out: MatchCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const header = parseHeader(row.header_json);
      const name = header.name?.trim();
      if (!name) continue;
      const key = normalize(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = header.internal_ref?.trim();
      out.push({
        value: name,
        label: ref ? `${name} (${ref})` : name,
        score: 0,
      });
    }
    return out;
  }
  const ref = field.catalog as FormCatalogRef | undefined;
  if (!ref) return [];
  const grouped = await listOdooRefsGrouped();
  return (grouped[ref] || []).map((item) => {
    const name = ref === 'category' || ref === 'uom' ? odooLabelPt(item.name) : item.name;
    return { value: name, label: name, score: 0 };
  });
}

/**
 * Resolve texto livre contra catálogo Forms.
 * - 1 candidato alto → resolve
 * - vários → devolve lista numerada para o bot
 * - nenhum → mantém texto original
 */
export async function resolveCatalogValue(input: {
  kind: FormKind;
  fieldKey: string;
  raw: string;
  companyOdooId: string;
}): Promise<{ value: string; ambiguous?: MatchCandidate[]; matched: boolean }> {
  const raw = String(input.raw || '').trim();
  if (!raw) return { value: '', matched: false };
  const field = fieldByKey(input.kind, input.fieldKey);
  if (!field) return { value: raw, matched: false };
  if (!isFormsCatalogField(field)) {
    if (field.options?.length) {
      const hit = field.options.find(
        (opt) => normalize(opt.value) === normalize(raw) || normalize(opt.label) === normalize(raw),
      );
      return hit ? { value: hit.value, matched: true } : { value: raw, matched: false };
    }
    return { value: raw, matched: false };
  }

  const options = await catalogOptions(input.kind, field, input.companyOdooId);
  // Resposta "3" após lista numerada → 3º item do catálogo.
  const indexMatch = raw.match(/^(\d{1,3})$/);
  if (indexMatch && options.length) {
    const index = Number(indexMatch[1]) - 1;
    if (index >= 0 && index < options.length) {
      return { value: options[index].value, matched: true };
    }
  }

  const ranked = options
    .map((item) => ({ ...item, score: scoreMatch(raw, item.value) || scoreMatch(raw, item.label) }))
    .filter((item) => item.score >= 60)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { value: raw, matched: false };
  if (ranked.length === 1 || ranked[0].score >= 90) {
    return { value: ranked[0].value, matched: true };
  }
  const top = ranked.filter((item) => item.score >= ranked[0].score - 10).slice(0, 8);
  if (top.length === 1) return { value: top[0].value, matched: true };
  return { value: raw, matched: false, ambiguous: top };
}

export function formatAmbiguousOptions(candidates: MatchCandidate[]): string {
  return candidates.map((item, index) => `${index + 1}) ${item.label}`).join('\n');
}
