import { many } from './db.js';
import { salesFromAnswer } from './fardo-sale.js';
import { createFormDocument, getFormDocument, saveFormDocument, type FormDocument } from './forms.js';
import { resolveCatalogValue } from './forms-bot-match.js';
import { markDocSyncPending, scheduleOdooPush } from './odoo-sync.js';
import { isUnusableQuestionnaireAnswer } from './questionnaire-rules.js';

/** Vende cada fardo do estoque na unidade, com o peso pesado na descrição da linha. */
export async function materializeFardoSale(input: {
  cycleId: string;
  companyOdooId: string;
  sourcePresetId: string;
  occurrenceDate: string;
  customerRaw: string;
  answer: string;
}): Promise<FormDocument | null> {
  const items = salesFromAnswer(input.answer);
  const customer = await resolveCatalogValue({
    kind: 'sale',
    fieldKey: 'customer',
    raw: input.customerRaw,
    companyOdooId: input.companyOdooId,
  });
  if (!items?.length || isUnusableQuestionnaireAnswer(customer.value || '')) {
    console.warn(`forms-bot: ciclo ${input.cycleId} sem cliente ou sem fardo para vender`);
    return null;
  }
  const previous = await documentForCycle(input.cycleId);
  if (previous?.header.odoo_id) return previous;
  const header: Record<string, string> = {
    customer: customer.value,
    order_date: input.occurrenceDate ? `${input.occurrenceDate.slice(0, 10)} 12:00:00` : '',
    source: 'bot',
    source_cycle_id: input.cycleId,
    source_preset_id: input.sourcePresetId,
  };
  const lines = items.map((item) => ({
    values: {
      product: 'Fardo',
      quantity: item.fardos,
      uom: 'Unidade',
      fardo_type: item.code,
      weight: item.weight,
    },
  }));
  const docId = previous?.id || (await createFormDocument('sale', { companyOdooId: input.companyOdooId })).id;
  const saved = await saveFormDocument(docId, {
    title: items.map((item) => `${item.fardos} ${item.code} · ${item.weight} kg`).join(', '),
    status: 'draft',
    header,
    lines,
  });
  await markDocSyncPending(saved.id);
  scheduleOdooPush(saved.id);
  return (await getFormDocument(saved.id)) || saved;
}

async function documentForCycle(cycleId: string): Promise<FormDocument | undefined> {
  const row = await many<{ id: string }>(
    `SELECT id FROM forms_documents
     WHERE kind = 'sale' AND header_json LIKE $1
     ORDER BY created_at DESC LIMIT 1`,
    [`%"source_cycle_id":"${cycleId}"%`],
  );
  return row[0] ? await getFormDocument(row[0].id) : undefined;
}
