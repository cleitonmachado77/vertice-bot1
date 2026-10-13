/** Campos da planilha Requests for Quotations (import Meta/Odoo-like). */
export type RfqField = {
  key: string;
  header: string;
  label: string;
  required: boolean;
  column: number;
};

export const RFQ_FIELDS: RfqField[] = [
  {
    key: 'order_reference',
    header: 'Order Reference',
    label: 'Referência do pedido / cupom fiscal',
    required: false,
    column: 1,
  },
  {
    key: 'vendor',
    header: 'Vendor*',
    label: 'Vendedor / fornecedor',
    required: true,
    column: 2,
  },
  {
    key: 'order_deadline',
    header: 'Order Deadline',
    label: 'Data de compra / prazo do pedido',
    required: false,
    column: 3,
  },
  {
    key: 'expected_arrival',
    header: 'Expected Arrival',
    label: 'Data prevista de fornecimento',
    required: false,
    column: 4,
  },
  {
    key: 'vendor_reference',
    header: 'Vendor Reference',
    label: 'Quem está fazendo a compra',
    required: false,
    column: 5,
  },
  {
    key: 'products',
    header: 'Order Lines/Products*',
    label: 'Nome do produto',
    required: true,
    column: 6,
  },
  {
    key: 'quantity',
    header: 'Order Lines/Quantity',
    label: 'Quantidade do produto',
    required: false,
    column: 7,
  },
  {
    key: 'unit_price',
    header: 'Order Lines/Unit Price',
    label: 'Preço total / unitário do produto',
    required: false,
    column: 8,
  },
  {
    key: 'taxes',
    header: 'Order Lines/Taxes',
    label: 'Taxas do produto',
    required: false,
    column: 9,
  },
  {
    key: 'payment_terms',
    header: 'Payment Terms',
    label: 'Forma de pagamento',
    required: false,
    column: 10,
  },
];

const byKey = new Map(RFQ_FIELDS.map((item) => [item.key, item]));

export function isRfqFieldKey(value: string): boolean {
  return !value || byKey.has(value);
}

export function getRfqField(key: string): RfqField | undefined {
  return byKey.get(key);
}

export function requiredRfqKeys(): string[] {
  return RFQ_FIELDS.filter((item) => item.required).map((item) => item.key);
}
