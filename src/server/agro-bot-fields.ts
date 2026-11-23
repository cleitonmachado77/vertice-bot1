/** Perguntas do Vertice Bot para o Agro. O padrão escolhe quais campos aparecem. */

export const AGRO_BOT_KINDS = ['agro_plantio', 'agro_colheita', 'agro_entrega'] as const;
export type AgroBotKind = (typeof AGRO_BOT_KINDS)[number];

export const AGRO_BOT_LABELS: Record<AgroBotKind, string> = {
  agro_plantio: 'Plantio',
  agro_colheita: 'Colheita',
  agro_entrega: 'Entrega',
};

export type AgroBotField = {
  key: string;
  label: string;
  required?: boolean;
  body: string;
  /** Lista do espelho do Odoo. O valor padrão é um cadastro, não um texto livre. */
  catalog?: 'producer' | 'product' | 'buyer';
  /** Este valor é gravado no Odoo. */
  odoo?: boolean;
};

export const AGRO_BOT_FIELDS: Record<AgroBotKind, AgroBotField[]> = {
  agro_plantio: [
    { key: 'propertyName', label: 'Propriedade', required: true, odoo: true, body: 'Qual é a propriedade? Vira local de estoque.' },
    { key: 'producerName', label: 'Fornecedor (produtor)', catalog: 'producer', odoo: true, body: 'Qual é o fornecedor (produtor)?' },
    {
      key: 'plotName',
      label: 'Código do talhão',
      required: true,
      odoo: true,
      body: 'Qual é o código do talhão/área? (ex.: 1 ou A1). Vira local de estoque.',
    },
    { key: 'productName', label: 'Produto', required: true, catalog: 'product', odoo: true, body: 'Qual produto do inventário foi plantado?' },
    { key: 'unit', label: 'Unidade', odoo: true, body: 'Qual a unidade do produto? (ex.: KG)' },
    { key: 'plantedOn', label: 'Data do plantio', required: true, body: 'Qual a data do plantio? (dd/mm/aaaa ou hoje)' },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
  agro_colheita: [
    { key: 'planting', label: 'Plantio', required: true, body: 'De qual plantio é a colheita? (propriedade ou produto)' },
    { key: 'harvestedOn', label: 'Data', required: true, body: 'Qual a data da colheita? (dd/mm/aaaa ou hoje)' },
    { key: 'quantity', label: 'Quantidade', required: true, odoo: true, body: 'Qual a quantidade colhida? Entra no estoque do talhão.' },
    { key: 'close', label: 'Encerrar', body: 'Encerrar a colheita deste plantio? (sim ou não)' },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
  agro_entrega: [
    { key: 'planting', label: 'Plantio', required: true, body: 'De qual plantio é a entrega? (propriedade ou produto)' },
    {
      key: 'partnerName',
      label: 'Local de entrega',
      required: true,
      catalog: 'buyer',
      odoo: true,
      body: 'Qual o local de entrega? (Sacolão, Escola Municipal, Escola Estadual, Coara…)',
    },
    { key: 'deliveredOn', label: 'Data', required: true, body: 'Qual a data da entrega? (dd/mm/aaaa ou hoje)' },
    { key: 'quantity', label: 'Quantidade', required: true, odoo: true, body: 'Qual a quantidade entregue?' },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
};

export const AGRO_BOT_CONFIRM = '__confirm__';

export function isAgroBotKind(value: string): value is AgroBotKind {
  return (AGRO_BOT_KINDS as readonly string[]).includes(value);
}

export function agroBotFields(kind: string): AgroBotField[] {
  return isAgroBotKind(kind) ? AGRO_BOT_FIELDS[kind] : [];
}

export function isAgroBotField(kind: string, key: string): boolean {
  if (key === AGRO_BOT_CONFIRM) return true;
  return agroBotFields(kind).some((field) => field.key === key);
}

export function agroTabKind(tab: string): AgroBotKind {
  if (tab === 'colheita' || tab === 'agro_colheita') return 'agro_colheita';
  if (tab === 'entrega' || tab === 'agro_entrega') return 'agro_entrega';
  return 'agro_plantio';
}

/** “hoje”, “12/11/2026” ou AAAA-MM-DD. */
export function agroAnswerDate(value: string, today: string): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'hoje') return today;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return raw.slice(0, 10);
}

export function agroAnswerYes(value: string): boolean {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return raw === 'sim' || raw === 's' || raw === '1' || raw === 'encerrar';
}
