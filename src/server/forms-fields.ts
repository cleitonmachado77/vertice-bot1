export type FormKind = 'sale' | 'purchase' | 'product';

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

export const FORM_KINDS: FormKind[] = ['product', 'purchase', 'sale'];

export const KIND_LABELS: Record<FormKind, string> = {
  product: 'Inventário',
  purchase: 'Compras',
  sale: 'Vendas',
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

export function statusesFor(kind: FormKind): FormStatusOption[] {
  if (kind === 'sale') return SALE_ODOO_STATUSES;
  if (kind === 'purchase') return PURCHASE_ODOO_STATUSES;
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

export function isFormKind(value: string): value is FormKind {
  return FORM_KINDS.includes(value as FormKind);
}

export function headerFieldsFor(kind: FormKind): FormField[] {
  if (kind === 'sale') return SALE_HEADER_FIELDS;
  if (kind === 'purchase') return PURCHASE_HEADER_FIELDS;
  return PRODUCT_FIELDS;
}

export function lineFieldsFor(kind: FormKind): FormField[] {
  if (kind === 'sale') return SALE_LINE_FIELDS;
  if (kind === 'purchase') return PURCHASE_LINE_FIELDS;
  return [];
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

export function documentTitle(kind: FormKind, header: Record<string, string>): string {
  if (kind === 'sale') return header.customer?.trim() || header.order_reference?.trim() || 'Cotação';
  if (kind === 'purchase') return header.vendor?.trim() || header.order_reference?.trim() || 'Solicitação';
  return header.name?.trim() || 'Produto';
}
