import { zonedNow } from './clock.js';
import { many, run } from './db.js';

export const DAY_CLOSE_ERROR = 'Ciclo encerrado ao virar o dia';

export type DayCloseResult = {
  closed: number;
  clearedContexts: number;
  date: string;
};

/** Ciclos incompletos de dias anteriores: a resposta só vale no ciclo do dia. */
export async function expirePastDayCycles(today = zonedNow().date): Promise<DayCloseResult> {
  const stamp = new Date().toISOString();
  const stale = await many<{ id: string }>(
    `SELECT id FROM questionnaire_cycles
     WHERE superseded_at = ''
       AND occurrence_date < $1
       AND status IN ('open', 'notified', 'in_progress', 'sending', 'delivery_unknown')`,
    [today],
  );

  if (stale.length) {
    await run(
      `UPDATE questionnaire_cycles
       SET status = 'failed',
           error = $2,
           pending_question_id = '',
           pending_question_set_by = '',
           updated_at = $3
       WHERE id = ANY($1::text[])
         AND superseded_at = ''
         AND status <> 'completed'`,
      [stale.map((row) => row.id), DAY_CLOSE_ERROR, stamp],
    );
  }

  const clearedContexts = await clearStaleConversationContexts(today, stamp);
  return { closed: stale.length, clearedContexts, date: today };
}

/** Tira da conversa qualquer ciclo que já não possa receber resposta. */
async function clearStaleConversationContexts(today: string, stamp: string): Promise<number> {
  const rows = await many<{ conversation_id: string }>(
    `SELECT ctx.conversation_id
     FROM conversation_questionnaire_context ctx
     LEFT JOIN questionnaire_cycles cyc ON cyc.id = NULLIF(ctx.active_cycle_id, '')
     WHERE ctx.active_cycle_id <> ''
       AND (
         cyc.id IS NULL
         OR cyc.status = 'failed'
         OR (cyc.occurrence_date < $1 AND cyc.status <> 'completed')
       )`,
    [today],
  );
  if (!rows.length) return 0;
  await run(
    `UPDATE conversation_questionnaire_context ctx
     SET active_cycle_id = '',
         candidate_cycle_ids_json = '[]',
         awaiting_selection = 0,
         updated_at = $2
     WHERE ctx.conversation_id = ANY($1::text[])
       AND ctx.active_cycle_id <> ''`,
    [rows.map((row) => row.conversation_id), stamp],
  );
  return rows.length;
}
