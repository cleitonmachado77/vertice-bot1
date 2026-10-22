import { withTransaction } from './db.js';
import { FORMS_BOT_LINES_FIELD } from './forms-bot-fields.js';
import { resolveCatalogValue } from './forms-bot-match.js';
import { isFormKind } from './forms-fields.js';
import type { MediaUnderstanding } from './media-understand.js';
import {
  markCycleCompleted,
  markCycleInProgress,
  missingQuestions,
  upsertAnswers,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import type { ExtractedAnswer } from './questionnaire-extraction.js';
import { isFullyAnswered } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

async function expandFormsCatalogAnswers(input: {
  questions: QuestionnaireQuestion[];
  accepted: ExtractedAnswer[];
  formKind?: string;
  companyOdooId?: string;
}): Promise<ExtractedAnswer[]> {
  const kindRaw = String(input.formKind || '').trim();
  if (!isFormKind(kindRaw) || !input.accepted.length) return input.accepted;
  const companyOdooId = String(input.companyOdooId || '').trim() || '1';
  const byId = new Map(input.questions.map((item) => [item.id, item]));
  const out: ExtractedAnswer[] = [];
  for (const item of input.accepted) {
    const question = byId.get(item.questionId);
    const field = String(question?.export_field || '').trim();
    if (!field || field === FORMS_BOT_LINES_FIELD) {
      out.push(item);
      continue;
    }
    const resolved = await resolveCatalogValue({
      kind: kindRaw,
      fieldKey: field,
      raw: item.text,
      companyOdooId,
    });
    if (!resolved.matched && PARTNER_FIELDS.has(field)) {
      const asProduct = await resolveCatalogValue({
        kind: kindRaw,
        fieldKey: 'product',
        raw: item.text,
        companyOdooId,
      });
      if (asProduct.matched) {
        console.warn(`questionnaire: "${item.text}" é produto, não ${field} — descartado`);
        continue;
      }
    }
    out.push({ ...item, text: resolved.value || item.text });
  }
  return out;
}

const PARTNER_FIELDS = new Set(['vendor', 'customer']);

export async function persistAcceptedAnswers(input: {
  cycleId: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  accepted: ExtractedAnswer[];
  media: MediaUnderstanding;
  mediaUrl: string;
  formKind?: string;
  companyOdooId?: string;
}): Promise<{ answers: CycleAnswer[]; missing: QuestionnaireQuestion[]; complete: boolean }> {
  return withTransaction(async () => {
    const accepted = await expandFormsCatalogAnswers({
      questions: input.questions,
      accepted: input.accepted,
      formKind: input.formKind,
      companyOdooId: input.companyOdooId,
    });
    const answers = accepted.length
      ? await upsertAnswers(
          input.cycleId,
          accepted.map((item) => ({
            questionId: item.questionId,
            text: item.text,
            type: item.type,
            mediaUrl: item.type === 'text' ? '' : input.media.mediaUrl || input.mediaUrl,
          })),
        )
      : input.alreadySaved;
    let missing = missingQuestions(input.questions, answers);
    const complete = isFullyAnswered(input.questions, answers);
    if (!complete && missing.length === 0) {
      missing = input.questions.filter(
        (question) =>
          !answers.some((row) => row.question_id === question.id && row.answer_text.trim()),
      );
    }
    await syncCycleProgress(
      input.cycleId,
      complete,
      accepted.length > 0 || input.alreadySaved.length > 0,
    );
    return { answers, missing, complete };
  });
}

async function syncCycleProgress(cycleId: string, complete: boolean, engaged: boolean): Promise<void> {
  if (complete) {
    await markCycleCompleted(cycleId);
    return;
  }
  if (engaged) await markCycleInProgress(cycleId);
}
