/**
 * Rótulos padrão do Odoo (EN) → português para exibição e sync.
 * Complementa context lang=pt_BR quando a base ainda traz nomes em inglês.
 */
const EN_TO_PT: Record<string, string> = {
  units: 'Unidades',
  unit: 'Unidade',
  dozen: 'Dúzia',
  dozens: 'Dúzias',
  hours: 'Horas',
  hour: 'Hora',
  days: 'Dias',
  day: 'Dia',
  goods: 'Mercadorias',
  services: 'Serviços',
  expenses: 'Despesas',
  deliveries: 'Entregas',
  donations: 'Doações',
  events: 'Eventos',
  'services / events': 'Serviços / Eventos',
  'all / salesable': 'Todos / Vendáveis',
  'all / expenses': 'Todos / Despesas',
  'all / goods': 'Todos / Mercadorias',
};

function normKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Traduz nome conhecido do Odoo para PT; senão devolve o original. */
export function odooLabelPt(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mapped = EN_TO_PT[normKey(raw)];
  if (mapped) return mapped;
  // Caminhos "Services / Events" e variantes com espaços
  return raw
    .split(/\s*\/\s*/)
    .map((part) => EN_TO_PT[normKey(part)] || part)
    .join(' / ');
}

/** Nomes alternativos para localizar o registro no Odoo (PT ↔ EN). */
export function odooLookupNames(value: string): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const pt = odooLabelPt(raw);
  if (pt) out.add(pt);
  const key = normKey(raw);
  const keyPt = normKey(pt);
  for (const [en, p] of Object.entries(EN_TO_PT)) {
    if (key === en || key === normKey(p) || keyPt === en || keyPt === normKey(p)) {
      out.add(p);
      out.add(
        en
          .split(' ')
          .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
          .join(' '),
      );
    }
  }
  return [...out];
}
