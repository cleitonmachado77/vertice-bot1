import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { many } from './db.js';
import { getQuestionnaire } from './questionnaires.js';
import { getRfqField, RFQ_FIELDS, requiredRfqKeys } from './rfq-fields.js';

const templatePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../templates/requests_for_quotation_import_template1.xlsx',
);

export type RfqExportRow = {
  cycleId: string;
  occurrenceDate: string;
  contactName: string;
  contactPhone: string;
  status: string;
  values: Record<string, string>;
  missingRequired: string[];
};

export type RfqExportResult = {
  buffer: Buffer;
  filename: string;
  rows: number;
  warnings: string[];
};

type CycleRow = {
  cycle_id: string;
  occurrence_date: string;
  status: string;
  contact_name: string;
  contact_phone: string;
  question_id: string;
  export_field: string;
  answer_text: string;
};

export async function buildRfqExport(questionnaireId: string): Promise<RfqExportResult> {
  const questionnaire = await getQuestionnaire(questionnaireId, true);
  if (!questionnaire) throw new Error('Questionário não encontrado');

  const mappedKeys = new Set(
    questionnaire.questions.map((item) => item.export_field).filter(Boolean),
  );
  const unmappedRequired = requiredRfqKeys().filter((key) => !mappedKeys.has(key));
  const warnings: string[] = [];
  if (unmappedRequired.length) {
    warnings.push(
      `Campos obrigatórios sem pergunta vinculada: ${unmappedRequired
        .map((key) => getRfqField(key)?.header || key)
        .join(', ')}`,
    );
  }

  const rows = await loadCycleRows(questionnaireId, questionnaire.defaultValues || {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const sheet =
    workbook.getWorksheet('Requests for Quotations') || workbook.worksheets[0];
  if (!sheet) throw new Error('Planilha modelo sem aba válida');

  // Remove linhas de exemplo/descrição do template; mantém só cabeçalhos limpos.
  clearTemplateBody(sheet);
  for (const field of RFQ_FIELDS) {
    sheet.getRow(1).getCell(field.column).value = field.header;
  }
  sheet.getRow(1).commit();

  let written = 0;
  for (const row of rows) {
    if (!Object.values(row.values).some((value) => value.trim())) continue;
    written += 1;
    const excelRow = sheet.getRow(written + 1);
    for (const field of RFQ_FIELDS) {
      excelRow.getCell(field.column).value = row.values[field.key] || '';
    }
    excelRow.commit();
    if (row.missingRequired.length) {
      warnings.push(
        `Ciclo ${row.occurrenceDate} (${row.contactName || row.contactPhone}): faltam ${row.missingRequired
          .map((key) => getRfqField(key)?.header || key)
          .join(', ')}`,
      );
    }
  }

  if (!written) {
    throw new Error('Nenhum ciclo com respostas para exportar neste questionário');
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const safeName = questionnaire.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return {
    buffer,
    filename: `rfq_${safeName || 'questionario'}_${new Date().toISOString().slice(0, 10)}.xlsx`,
    rows: written,
    warnings: [...new Set(warnings)].slice(0, 12),
  };
}

function clearTemplateBody(sheet: ExcelJS.Worksheet): void {
  const last = Math.max(sheet.rowCount, 20);
  if (last > 1) sheet.spliceRows(2, last - 1);
  for (let r = 2; r <= 20; r++) {
    const row = sheet.getRow(r);
    for (const field of RFQ_FIELDS) row.getCell(field.column).value = null;
    row.commit();
  }
}

async function loadCycleRows(
  questionnaireId: string,
  defaultValues: Record<string, string> = {},
): Promise<RfqExportRow[]> {
  const data = await many<CycleRow>(
    `SELECT cyc.id AS cycle_id, cyc.occurrence_date, cyc.status,
            COALESCE(ct.name, '') AS contact_name, COALESCE(ct.phone, '') AS contact_phone,
            qq.question_id, COALESCE(qq.export_field, '') AS export_field,
            COALESCE(ans.answer_text, '') AS answer_text
     FROM questionnaire_cycles cyc
     JOIN contacts ct ON ct.id = cyc.contact_id
     JOIN questionnaire_revisions rev ON rev.id = cyc.revision_id
     JOIN questionnaire_revision_questions qq ON qq.revision_id = rev.id
     LEFT JOIN questionnaire_answers ans
       ON ans.cycle_id = cyc.id AND ans.question_id = qq.question_id
     WHERE cyc.questionnaire_id = $1 AND cyc.superseded_at = ''
     ORDER BY cyc.occurrence_date, ct.name, qq.sort_order`,
    [questionnaireId],
  );

  const defaults = Object.fromEntries(
    RFQ_FIELDS.map((field) => [field.key, String(defaultValues[field.key] || '').trim()]),
  );

  const byCycle = new Map<string, RfqExportRow>();
  for (const item of data) {
    let row = byCycle.get(item.cycle_id);
    if (!row) {
      row = {
        cycleId: item.cycle_id,
        occurrenceDate: item.occurrence_date,
        contactName: item.contact_name,
        contactPhone: item.contact_phone,
        status: item.status,
        // Defaults primeiro; respostas do contato sobrescrevem abaixo.
        values: { ...defaults },
        missingRequired: [],
      };
      byCycle.set(item.cycle_id, row);
    }
    if (item.export_field && item.answer_text.trim()) {
      const previous = row.values[item.export_field] || '';
      const answered = item.answer_text.trim();
      const baseline = defaults[item.export_field] || '';
      // Se só havia o padrão, substitui; se já havia outra resposta, concatena.
      row.values[item.export_field] =
        previous && previous !== baseline ? `${previous} | ${answered}` : answered;
    }
  }

  const rows = [...byCycle.values()];
  for (const row of rows) {
    // Se nada mapeou order_reference, usa data + contato como referência útil.
    if (!row.values.order_reference?.trim()) {
      row.values.order_reference = [row.occurrenceDate, row.contactName || row.contactPhone]
        .filter(Boolean)
        .join(' · ');
    }
    row.missingRequired = requiredRfqKeys().filter((key) => !row.values[key]?.trim());
  }
  return rows;
}
