import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { FormDocument } from './forms.js';
import { many } from './db.js';
import { KIND_LABELS, productionBalance, statusLabel, type FormKind } from './forms-fields.js';
import { listUomInfos, toKg } from './forms-uom.js';
import { getFormDocument, listFormDocuments } from './forms.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEMPLATES: Record<'sale' | 'purchase', { file: string; sheet: string }> = {
  sale: {
    file: path.join(root, 'templates/quotations_import_template.xlsx'),
    sheet: 'Quotations',
  },
  purchase: {
    file: path.join(root, 'templates/requests_for_quotation_import_template1.xlsx'),
    sheet: 'Requests for Quotations',
  },
};

export type FormsExportResult = {
  buffer: Buffer;
  filename: string;
  rows: number;
};

function clearBody(sheet: ExcelJS.Worksheet): void {
  const last = sheet.rowCount;
  for (let r = last; r >= 2; r -= 1) sheet.spliceRows(r, 1);
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

async function exportOrderDocs(
  kind: 'sale' | 'purchase',
  docs: FormDocument[],
): Promise<FormsExportResult> {
  const meta = TEMPLATES[kind];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(meta.file);
  const sheet = workbook.getWorksheet(meta.sheet) || workbook.worksheets[0];
  if (!sheet) throw new Error('Planilha modelo inválida');
  clearBody(sheet);

  let written = 0;
  for (const doc of docs) {
    const lines = doc.lines.length ? doc.lines : [{ id: '', sort_order: 0, values: {} }];
    lines.forEach((line, index) => {
      written += 1;
      const row = sheet.getRow(written + 1);
      if (kind === 'sale') {
        if (index === 0) {
          row.getCell(1).value = text(doc.header.order_reference);
          row.getCell(2).value = text(doc.header.customer);
          row.getCell(3).value = text(doc.header.order_date);
          row.getCell(4).value = text(doc.header.expiration);
          row.getCell(5).value = text(doc.header.payment_terms);
          row.getCell(10).value = text(doc.header.sales_team);
          row.getCell(11).value = text(doc.header.customer_reference);
          row.getCell(12).value = text(doc.header.tags);
        }
        row.getCell(6).value = text(line.values.product);
        row.getCell(7).value = text(line.values.quantity);
        row.getCell(8).value = text(line.values.unit_price);
        row.getCell(9).value = text(line.values.taxes);
      } else {
        if (index === 0) {
          row.getCell(1).value = text(doc.header.order_reference);
          row.getCell(2).value = text(doc.header.vendor);
          row.getCell(3).value = text(doc.header.order_deadline);
          row.getCell(4).value = text(doc.header.expected_arrival);
          row.getCell(5).value = text(doc.header.vendor_reference);
          row.getCell(10).value = text(doc.header.payment_terms);
        }
        row.getCell(6).value = text(line.values.product);
        row.getCell(7).value = text(line.values.quantity);
        row.getCell(8).value = text(line.values.unit_price);
        row.getCell(9).value = text(line.values.taxes);
      }
      row.commit();
    });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    filename: `vertice-forms-${kind}-${stamp}.xlsx`,
    rows: written,
  };
}

async function exportProducts(docs: FormDocument[]): Promise<FormsExportResult> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Produtos');
  const headers = [
    'Moeda',
    'Moeda de custo',
    'Categoria de produtos',
    'Rastrear inventário',
    'Nome',
    'Preços de venda',
    'Custo',
    'Referência interna',
    'Quantidade em mãos',
    'Unidade',
  ];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };

  for (const doc of docs) {
    sheet.addRow([
      text(doc.header.currency) || 'BRL',
      text(doc.header.cost_currency) || 'BRL',
      text(doc.header.category),
      text(doc.header.track_inventory) || 'True',
      text(doc.header.name),
      text(doc.header.sales_price),
      text(doc.header.cost),
      text(doc.header.internal_ref),
      text(doc.header.qty_on_hand),
      text(doc.header.uom),
    ]);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    filename: `vertice-forms-produtos-${stamp}.xlsx`,
    rows: docs.length,
  };
}

/** Uma linha por produto gerado da ordem de produção (principal + subprodutos), com o balanço em kg. */
async function exportProductions(docs: FormDocument[]): Promise<FormsExportResult> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Fabricação');
  sheet.addRow([
    'Número',
    'Data',
    'Estado',
    'Produto de entrada',
    'Quantidade de entrada',
    'Unidade de entrada',
    'Kg de entrada',
    'Produto gerado',
    'Quantidade',
    'Unidade',
    'Kg',
    'Divisão de custo (%)',
    'Perda (kg)',
  ]);
  sheet.getRow(1).font = { bold: true };

  const uoms = await listUomInfos();
  const products = await many<{ name: string; uom: string }>(
    `SELECT lower(trim(both FROM header_json::json->>'name')) AS name, COALESCE(header_json::json->>'uom', '') AS uom
     FROM forms_documents WHERE kind = 'product'`,
  );
  const productUom = new Map(products.map((item) => [item.name, item.uom]));
  const convert = (qty: number, uom: string, product: string) =>
    toKg(qty, uom || productUom.get(product.trim().toLowerCase()) || '', uoms);

  let rows = 0;
  for (const doc of docs) {
    const balance = productionBalance(doc, convert);
    const lines = balance.lines.length ? balance.lines : [null];
    lines.forEach((line, index) => {
      rows += 1;
      sheet.addRow([
        index === 0 ? text(doc.header.order_reference) : '',
        index === 0 ? text(doc.header.production_date) : '',
        index === 0 ? statusLabel('production', doc.status) : '',
        index === 0 ? text(doc.header.input_product) : '',
        index === 0 ? balance.inputQty || '' : '',
        index === 0 ? text(doc.header.input_uom) : '',
        index === 0 ? (balance.inputKg ?? '') : '',
        line?.product || '',
        line?.quantity || '',
        line?.uom || '',
        line?.kg ?? '',
        line?.costShare ?? '',
        index === 0 ? (balance.lossKg ?? '') : '',
      ]);
    });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `vertice-forms-fabricacao-${stamp}.xlsx`, rows };
}

function exportDocs(kind: FormKind, docs: FormDocument[]): Promise<FormsExportResult> {
  if (kind === 'product') return exportProducts(docs);
  if (kind === 'production') return exportProductions(docs);
  return exportOrderDocs(kind, docs);
}

export async function exportFormsByKind(kind: FormKind): Promise<FormsExportResult> {
  const docs = await listFormDocuments(kind, { includeLines: true });
  if (!docs.length) throw new Error(`Nenhum registro em ${KIND_LABELS[kind]} para exportar`);
  return exportDocs(kind, docs);
}

export async function exportFormById(id: string): Promise<FormsExportResult> {
  const doc = await getFormDocument(id);
  if (!doc) throw new Error('Formulário não encontrado');
  return exportDocs(doc.kind, [doc]);
}
