/** Perguntas do Vertice Bot para o Agro. O padrão escolhe quais campos aparecem. */

export const AGRO_BOT_KINDS = ['agro_plantio', 'agro_colheita', 'agro_entrega', 'agro_custo'] as const;
export type AgroBotKind = (typeof AGRO_BOT_KINDS)[number];

export const AGRO_BOT_LABELS: Record<AgroBotKind, string> = {
  agro_plantio: 'Plantio',
  agro_colheita: 'Colheita',
  agro_entrega: 'Entrega',
  agro_custo: 'Custos',
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
    { key: 'propertyName', label: 'Propriedade', required: true, odoo: true, body: 'Qual é a propriedade?' },
    { key: 'producerName', label: 'Fornecedor (produtor)', catalog: 'producer', odoo: true, body: 'Qual é o fornecedor (produtor)?' },
    {
      key: 'plantedOn',
      label: 'Data do plantio',
      required: true,
      body: 'Qual a data do plantio? (hoje ou dd/mm/aaaa)',
    },
    {
      key: 'productName',
      label: 'Produto (sigla)',
      required: true,
      catalog: 'product',
      odoo: true,
      body: 'Qual o produto? (sigla, ex.: ABA, CEN)',
    },
    { key: 'unit', label: 'Unidade', odoo: true, body: 'Qual a unidade do produto? (ex.: KG)' },
    {
      key: 'forecastQty',
      label: 'Produção estimada',
      required: true,
      body: 'Qual a produção estimada? (número)',
    },
    {
      key: 'plotName',
      label: 'Área (talhão)',
      required: true,
      odoo: true,
      body: 'Qual a área? (código, ex.: 1 ou A1)',
    },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
  agro_colheita: [
    {
      key: 'harvestedOn',
      label: 'Data',
      required: true,
      body: 'Qual a data da colheita? (hoje ou dd/mm/aaaa)',
    },
    {
      key: 'productName',
      label: 'Produto (sigla)',
      required: true,
      catalog: 'product',
      body: 'Qual o produto colhido? (sigla, ex.: ABA, CEN)',
    },
    {
      key: 'quantity',
      label: 'Quantidade',
      required: true,
      odoo: true,
      body: 'Qual a quantidade colhida?',
    },
    {
      key: 'plotName',
      label: 'Área (talhão)',
      required: true,
      body: 'Qual a área? (código, ex.: 1 ou A1)',
    },
    { key: 'close', label: 'Encerrar', body: 'Encerrar a colheita deste plantio? (sim ou não)' },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
  agro_entrega: [
    {
      key: 'deliveredOn',
      label: 'Data',
      required: true,
      body: 'Qual a data da entrega? (hoje ou dd/mm/aaaa)',
    },
    {
      key: 'productName',
      label: 'Produto (sigla)',
      required: true,
      catalog: 'product',
      body: 'Qual o produto entregue? (sigla, ex.: ABA, CEN)',
    },
    {
      key: 'quantity',
      label: 'Quantidade',
      required: true,
      odoo: true,
      body: 'Qual a quantidade entregue?',
    },
    {
      key: 'partnerName',
      label: 'Local de entrega',
      required: true,
      catalog: 'buyer',
      odoo: true,
      body: 'Qual o local de entrega? (Sacolão, Escola Municipal, Escola Estadual, Coara…)',
    },
    {
      key: 'plotName',
      label: 'Área (talhão)',
      body: 'Qual a área de origem? (código, ex.: 1 ou A1 — opcional se só houver um plantio)',
    },
    { key: 'notes', label: 'Observações', body: 'Alguma observação?' },
  ],
  agro_custo: [
    {
      key: 'costOn',
      label: 'Data',
      required: true,
      body: 'Qual a data do custo? (hoje ou dd/mm/aaaa)',
    },
    {
      key: 'name',
      label: 'Nome do custo',
      required: true,
      body: 'Qual o nome do custo? (ex.: adubo, veneno)',
    },
    {
      key: 'quantity',
      label: 'Quantidade / valor',
      required: true,
      body: 'Qual a quantidade ou valor do custo?',
    },
    {
      key: 'plotName',
      label: 'Área (talhão)',
      required: true,
      body: 'Qual a área? (código, ex.: 1 ou A1)',
    },
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
  if (tab === 'custos' || tab === 'custo' || tab === 'agro_custo') return 'agro_custo';
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
