import { headerFieldsFor, lineFieldsFor, type FormKind } from './forms-fields.js';

export const FORMS_BOT_LINES_FIELD = '__lines__';

export function formsBotQuestionnaireId(presetId: string): string {
  return `forms-preset:${presetId}`;
}

export function isFormsBotExportField(kind: FormKind, exportField: string): boolean {
  const key = String(exportField || '').trim();
  if (!key) return true;
  if (key === FORMS_BOT_LINES_FIELD) return lineFieldsFor(kind).length > 0;
  return (
    headerFieldsFor(kind).some((field) => field.key === key) ||
    lineFieldsFor(kind).some((field) => field.key === key)
  );
}
