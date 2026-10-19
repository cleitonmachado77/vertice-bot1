/** Rótulos padrão Odoo (EN) → PT para a UI do Forms. */
const EN_TO_PT = {
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
};

function normKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Traduz nome conhecido do Odoo para PT. */
export function odooLabelPt(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mapped = EN_TO_PT[normKey(raw)];
  if (mapped) return mapped;
  return raw
    .split(/\s*\/\s*/)
    .map((part) => EN_TO_PT[normKey(part)] || part)
    .join(' / ');
}
