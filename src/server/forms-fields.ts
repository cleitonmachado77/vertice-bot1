import { toOdooNumber } from './odoo-number.js';

export type FormKind = 'sale' | 'purchase' | 'product' | 'production';

export type FormCatalogRef =
  | 'category'
  | 'uom'
  | 'payment_term'
  | 'tax'
  | 'sales_team'
  | 'tag';

export type FormFieldOption = { value: string; label: string };

export type FormField = {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  /** Campo gerado pelo Odoo (ex.: sequência do pedido). */
  readonly?: boolean;
  /** Data exibida como dd/mm/aaaa; persistida/enviada ao Odoo como AAAA-MM-DD. */
  date?: boolean;
  /** Seletor alimentado por cadastro Odoo (forms_odoo_refs). */
  catalog?: FormCatalogRef;
  /** Permite vários valores separados por vírgula (impostos, marcadores). */
  catalogMulti?: boolean;
  /** Select fixo (ex.: is_storable True/False do Odoo). */
  options?: FormFieldOption[];
};

export const FORM_KINDS: FormKind[] = ['product', 'purchase', 'sale', 'production'];

export const KIND_LABELS: Record<FormKind, string> = {
  product: 'Inventário',
  purchase: 'Compras',
  sale: 'Vendas',
  production: 'Fabricação',
};

export type FormStatusOption = { value: string; label: string };

/** Estados de sale.order (campo state no Odoo). */
export const SALE_ODOO_STATUSES: FormStatusOption[] = [
  { value: 'draft', label: 'Cotação' },
  { value: 'sent', label: 'Cotação enviada' },
  { value: 'sale', label: 'Pedido de venda' },
  { value: 'done', label: 'Bloqueado' },
  { value: 'cancel', label: 'Cancelado' },
];

/** Estados de purchase.order (campo state no Odoo). */
export const PURCHASE_ODOO_STATUSES: FormStatusOption[] = [
  { value: 'draft', label: 'Solicitação de cotação' },
  { value: 'sent', label: 'RFQ enviada' },
  { value: 'to approve', label: 'A aprovar' },
  { value: 'purchase', label: 'Pedido de compra' },
  { value: 'done', label: 'Bloqueado' },
  { value: 'cancel', label: 'Cancelado' },
];

/** Estados de mrp.production (campo state no Odoo). “Concluído” lança no estoque. */
export const PRODUCTION_STATUSES: FormStatusOption[] = [
  { value: 'draft', label: 'Rascunho' },
  { value: 'confirmed', label: 'Confirmado' },
  { value: 'progress', label: 'Em andamento' },
  { value: 'to_close', label: 'A fechar' },
  { value: 'done', label: 'Concluído' },
  { value: 'cancel', label: 'Cancelado' },
];

export function statusesFor(kind: FormKind): FormStatusOption[] {
  if (kind === 'sale') return SALE_ODOO_STATUSES;
  if (kind === 'purchase') return PURCHASE_ODOO_STATUSES;
  if (kind === 'production') return PRODUCTION_STATUSES;
  return [];
}

/** Converte status legado do Vertice e alinha ao state do Odoo. */
export function normalizeFormStatus(kind: FormKind, status: string): string {
  const raw = String(status || 'draft').trim().toLowerCase();
  if (kind === 'product') return 'draft';
  if (raw === 'ready') return 'draft';
  if (raw === 'exported') {
    if (kind === 'sale') return 'sale';
    if (kind === 'purchase') return 'purchase';
    return 'draft';
  }
  const allowed = new Set(statusesFor(kind).map((item) => item.value));
  if (allowed.has(raw)) return raw;
  // Odoo às vezes usa "to approve" com espaço
  if (raw === 'to_approve' && allowed.has('to approve')) return 'to approve';
  return 'draft';
}

export function statusLabel(kind: FormKind, status: string): string {
  const value = normalizeFormStatus(kind, status);
  return statusesFor(kind).find((item) => item.value === value)?.label || value;
}

/** Espelha sale.order (Odoo Vendas / Cotações). */
export const SALE_HEADER_FIELDS: FormField[] = [
  { key: 'order_reference', label: 'Número', placeholder: 'Gerado pelo Odoo (ex.: S00001)', readonly: true },
  { key: 'customer', label: 'Cliente', required: true, placeholder: 'Buscar cliente…' },
  { key: 'order_date', label: 'Data do pedido', placeholder: 'dd/mm/aaaa', date: true },
  { key: 'expiration', label: 'Validade', placeholder: 'dd/mm/aaaa', date: true },
  {
    key: 'payment_terms',
    label: 'Condições de pagamento',
    placeholder: 'Buscar condição…',
    catalog: 'payment_term',
  },
  { key: 'sales_team', label: 'Equipe de vendas', placeholder: 'Buscar equipe…', catalog: 'sales_team' },
  { key: 'customer_reference', label: 'Referência do cliente', placeholder: 'PO do cliente…' },
  {
    key: 'tags',
    label: 'Marcadores',
    placeholder: 'Buscar marcador…',
    catalog: 'tag',
    catalogMulti: true,
  },
];

/** Espelha sale.order.line. */
export const SALE_LINE_FIELDS: FormField[] = [
  { key: 'product', label: 'Produto', required: true, placeholder: 'Buscar produto…' },
  { key: 'quantity', label: 'Quantidade' },
  { key: 'uom', label: 'Unidade', placeholder: 'Unidade do produto', catalog: 'uom' },
  { key: 'unit_price', label: 'Preço unitário' },
  {
    key: 'taxes',
    label: 'Impostos',
    placeholder: 'Buscar imposto…',
    catalog: 'tax',
    catalogMulti: true,
  },
];

/** Espelha purchase.order (Odoo Compras / RFQ). */
export const PURCHASE_HEADER_FIELDS: FormField[] = [
  { key: 'order_reference', label: 'Número', placeholder: 'Gerado pelo Odoo (ex.: P00001)', readonly: true },
  { key: 'vendor', label: 'Fornecedor', required: true, placeholder: 'Buscar fornecedor…' },
  { key: 'order_deadline', label: 'Prazo do pedido', placeholder: 'dd/mm/aaaa', date: true },
  { key: 'expected_arrival', label: 'Chegada prevista', placeholder: 'dd/mm/aaaa', date: true },
  { key: 'vendor_reference', label: 'Referência do fornecedor', placeholder: 'Ref. do fornecedor' },
  {
    key: 'payment_terms',
    label: 'Condições de pagamento',
    placeholder: 'Buscar condição…',
    catalog: 'payment_term',
  },
];

/** Espelha purchase.order.line. */
export const PURCHASE_LINE_FIELDS: FormField[] = [
  { key: 'product', label: 'Produto', required: true, placeholder: 'Buscar produto…' },
  { key: 'quantity', label: 'Quantidade' },
  { key: 'uom', label: 'Unidade', placeholder: 'Unidade do produto', catalog: 'uom' },
  { key: 'unit_price', label: 'Custo unitário' },
  {
    key: 'taxes',
    label: 'Impostos',
    placeholder: 'Buscar imposto…',
    catalog: 'tax',
    catalogMulti: true,
  },
];

/** Espelha product.template (+ qty via stock.quant). */
export const PRODUCT_FIELDS: FormField[] = [
  { key: 'name', label: 'Nome', required: true, placeholder: 'ex.: Cenoura' },
  {
    key: 'category',
    label: 'Categoria do produto',
    placeholder: 'Buscar categoria…',
    catalog: 'category',
  },
  { key: 'sales_price', label: 'Preço de venda' },
  { key: 'cost', label: 'Custo' },
  { key: 'uom', label: 'Unidade de medida', placeholder: 'Buscar unidade…', catalog: 'uom' },
  { key: 'internal_ref', label: 'Referência interna' },
  { key: 'weight', label: 'Peso (kg)', placeholder: 'Peso de 1 unidade do produto (Odoo)' },
  { key: 'qty_on_hand', label: 'Quantidade em mãos', readonly: true, placeholder: 'Via estoque Odoo' },
  {
    key: 'track_inventory',
    label: 'Rastrear inventário',
    options: [
      { value: 'True', label: 'Sim' },
      { value: 'False', label: 'Não' },
    ],
  },
];

/** Unidade da linha (uom.uom do Odoo); vazio = unidade do produto. */
const LINE_UOM_FIELD: FormField = {
  key: 'uom',
  label: 'Unidade',
  placeholder: 'Unidade do produto',
  catalog: 'uom',
};

/**
 * Espelha mrp.production: componente (produto de entrada) → produto principal (1ª linha)
 * + subprodutos (demais linhas), cada um na sua unidade do Odoo (ex.: 2 Bag = 200 KG).
 */
export const PRODUCTION_HEADER_FIELDS: FormField[] = [
  { key: 'order_reference', label: 'Número', placeholder: 'Gerado pelo Odoo (ex.: WH/MO/00001)', readonly: true },
  { key: 'production_date', label: 'Data', placeholder: 'dd/mm/aaaa', date: true },
  { key: 'input_product', label: 'Produto de entrada (componente)', required: true, placeholder: 'Buscar produto…' },
  { key: 'input_qty', label: 'Quantidade de entrada', placeholder: 'ex.: 2' },
  { key: 'input_uom', label: 'Unidade de entrada', placeholder: 'Unidade do produto', catalog: 'uom' },
  { key: 'notes', label: 'Observações' },
];

export const PRODUCTION_LINE_FIELDS: FormField[] = [
  { key: 'product', label: 'Produto gerado', required: true, placeholder: 'Buscar produto…' },
  { key: 'quantity', label: 'Quantidade' },
  LINE_UOM_FIELD,
];

export function isFormKind(value: string): value is FormKind {
  return FORM_KINDS.includes(value as FormKind);
}

export function headerFieldsFor(kind: FormKind): FormField[] {
  if (kind === 'sale') return SALE_HEADER_FIELDS;
  if (kind === 'purchase') return PURCHASE_HEADER_FIELDS;
  if (kind === 'production') return PRODUCTION_HEADER_FIELDS;
  return PRODUCT_FIELDS;
}

export function lineFieldsFor(kind: FormKind): FormField[] {
  if (kind === 'sale') return SALE_LINE_FIELDS;
  if (kind === 'purchase') return PURCHASE_LINE_FIELDS;
  if (kind === 'production') return PRODUCTION_LINE_FIELDS;
  return [];
}

export type ProductionBalanceLine = {
  product: string;
  quantity: number;
  uom: string;
  /** Mesma quantidade em kg (null se a unidade não converte para kg). */
  kg: number | null;
  /** Divisão de custo (%) da ordem — subprodutos pelo peso; o principal fica com o restante. */
  costShare: number;
};

export type ProductionBalance = {
  inputQty: number;
  inputUom: string;
  inputKg: number | null;
  outputKg: number | null;
  /** Entrada − saída em kg (perda: umidade, rejeito). null se alguma unidade não converte. */
  lossKg: number | null;
  lines: ProductionBalanceLine[];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Balanço da ordem: entrada e saída na unidade de cada item e, quando converte, em kg.
 * `toKg(qty, unidade, produto)` faz a conversão do Odoo (unidade vazia = unidade do produto).
 */
export function productionBalance(
  doc: { header: Record<string, string>; lines: Array<{ values: Record<string, string> }> },
  toKg: (qty: number, uom: string, product: string) => number | null,
): ProductionBalance {
  const inputQty = toOdooNumber(doc.header.input_qty, 0);
  const inputUom = String(doc.header.input_uom || '').trim();
  const inputKg = inputQty > 0 ? toKg(inputQty, inputUom, String(doc.header.input_product || '')) : null;
  const rows = doc.lines
    .map((line) => {
      const product = String(line.values.product || '').trim();
      const quantity = toOdooNumber(line.values.quantity, 0);
      const uom = String(line.values.uom || '').trim();
      return { product, quantity, uom, kg: product && quantity > 0 ? toKg(quantity, uom, product) : null };
    })
    .filter((row) => row.product && row.quantity > 0);
  const allKg = rows.length > 0 && rows.every((row) => row.kg != null);
  const outputKg = allKg ? round3(rows.reduce((sum, row) => sum + (row.kg || 0), 0)) : null;
  const weightOf = (row: (typeof rows)[number]) => (allKg ? row.kg || 0 : row.quantity);
  const total = rows.reduce((sum, row) => sum + weightOf(row), 0);
  const byproductShares = rows.slice(1).map((row) => (total > 0 ? round3((weightOf(row) / total) * 100) : 0));
  const mainShare = round3(100 - byproductShares.reduce((sum, share) => sum + share, 0));
  const lines = rows.map((row, index) => ({ ...row, costShare: index === 0 ? mainShare : byproductShares[index - 1] }));
  return {
    inputQty,
    inputUom,
    inputKg,
    outputKg,
    lossKg: inputKg != null && outputKg != null ? round3(inputKg - outputKg) : null,
    lines,
  };
}

export function emptyHeader(kind: FormKind): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of headerFieldsFor(kind)) {
    out[field.key] = field.key === 'track_inventory' ? 'True' : '';
  }
  return out;
}

export function emptyLine(kind: FormKind): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of lineFieldsFor(kind)) out[field.key] = '';
  return out;
}

function partnerName(kind: FormKind, header: Record<string, string>): string {
  if (kind === 'sale') return String(header.customer || '').trim();
  if (kind === 'purchase') return String(header.vendor || '').trim();
  return '';
}

/** “WH/MO/00003 · 28/10/2026” (número da ordem no Odoo + data); sem número: “Fabricação 28/10/2026”. */
function productionTitle(header: Record<string, string>): string {
  const raw = String(header.production_date || '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const date = iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : /^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? raw : '';
  const ref = String(header.order_reference || '').trim();
  if (ref) return date ? `${ref} · ${date}` : ref;
  return date ? `Fabricação ${date}` : 'Fabricação';
}

/** Título padrão: Número + Fornecedor/Cliente (ex.: P00013 · Associação…). */
export function documentTitle(kind: FormKind, header: Record<string, string>): string {
  if (kind === 'product') return header.name?.trim() || 'Produto';
  if (kind === 'production') return productionTitle(header);
  const ref = String(header.order_reference || '').trim();
  const partner = partnerName(kind, header);
  if (ref && partner) return `${ref} · ${partner}`;
  if (partner) return partner;
  if (ref) return ref;
  return kind === 'sale' ? 'Cotação' : 'Solicitação';
}

/** True quando o título ainda é genérico ou espelha só número/parceiro (pode regenerar). */
export function shouldAutofillFormTitle(
  kind: FormKind,
  title: string,
  header: Record<string, string>,
): boolean {
  if (kind === 'product') return false;
  const current = String(title || '').trim();
  if (!current) return true;
  if (kind === 'production') {
    return (
      /^(Fabricação|Prensagem)(\s+\d{2}\/\d{2}\/\d{4})?$/.test(current) ||
      current === productionTitle({ ...header, production_date: header.production_date || '' }) ||
      /^\S+\/MO\/\S+( · \d{2}\/\d{2}\/\d{4})?$/.test(current)
    );
  }
  if (kind === 'sale' && (current === 'Cotação' || current === 'Cotacao')) return true;
  if (kind === 'purchase' && (current === 'Solicitação' || current === 'Solicitacao')) return true;
  const ref = String(header.order_reference || '').trim();
  const partner = partnerName(kind, header);
  if (ref && current === ref) return true;
  if (partner && current === partner) return true;
  if (ref && partner && current === `${ref} · ${partner}`) return true;
  return false;
}
