import { many } from './db.js';

type PendingSide = { questionId: string; setBy: string; body: string };
export type PendingQuestionView = { before: PendingSide; after: PendingSide; changed: boolean };

type TracedResult = {
  pendingQuestion?: {
    before?: { questionId?: string; setBy?: string } | null;
    after?: { questionId?: string; setBy?: string } | null;
  };
};

/** Pergunta pendente antes/depois de cada evento, com o texto da pergunta (painel → Histórico). */
export async function pendingQuestionViews(
  results: unknown[],
): Promise<Array<PendingQuestionView | undefined>> {
  const traces = results.map((result) => (result as TracedResult | null)?.pendingQuestion);
  const ids = [
    ...new Set(
      traces.flatMap((trace) => [trace?.before?.questionId, trace?.after?.questionId]).filter(Boolean),
    ),
  ] as string[];
  const bodies = new Map<string, string>();
  if (ids.length) {
    const rows = await many<{ question_id: string; body: string }>(
      `SELECT DISTINCT ON (question_id) question_id, body
       FROM questionnaire_revision_questions
       WHERE question_id = ANY($1::text[])
       ORDER BY question_id, revision_id`,
      [ids],
    );
    for (const row of rows) bodies.set(row.question_id, row.body);
  }
  const side = (raw?: { questionId?: string; setBy?: string } | null): PendingSide => {
    const questionId = String(raw?.questionId || '');
    return { questionId, setBy: String(raw?.setBy || ''), body: bodies.get(questionId) || '' };
  };
  return traces.map((trace) => {
    if (!trace) return undefined;
    const before = side(trace.before);
    const after = side(trace.after);
    return { before, after, changed: before.questionId !== after.questionId };
  });
}
