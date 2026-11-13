import { many, one, run } from './db.js';
import { shiftIsoDate } from './questionnaire-dates.js';
import { DAY_CLOSE_ERROR } from './questionnaire-day-close.js';
import { missingPromptFor } from './forms-bot-capture.js';
import { onlyOptionNumber, parseQtyProductChunks } from './forms-bot-fields.js';
import {
  getCycleContextsByIds,
  setConversationCycleContext,
  type ActiveCycleContext,
} from './questionnaire-cycles.js';

/** Um modo por conversa. Entrar num fecha o intérprete dos outros. */
export type BotMode = {
  kind: 'menu' | 'offer' | 'question' | 'confirm' | 'day';
  dayResolved?: string;
  cycleId?: string;
  questionId?: string;
  field?: string;
  value?: string;
  names?: string[];
};

const PARTNER_OR_QTY = new Set([
  'vendor',
  'customer',
  'product',
  'name',
  'quantity',
  'qty',
  'input_qty',
  'qty_on_hand',
]);

export function isLoosePhrase(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || onlyOptionNumber(raw)) return false;
  if (parseQtyProductChunks(raw).length) return false;
  return raw.split(/\s+/).filter(Boolean).length >= 4;
}

/** Frase longa em fornecedor, cliente, produto ou quantidade pede confirmação antes de gravar. */
export function shouldConfirmLoose(field: string, inbound: string): boolean {
  const key = String(field || '').trim();
  if (!key || key.startsWith('__')) return false;
  if (!PARTNER_OR_QTY.has(key)) return false;
  return isLoosePhrase(inbound);
}

export function looseConfirmPrompt(field: string, value: string): string {
  const label =
    field === 'vendor'
      ? 'fornecedor'
      : field === 'customer'
        ? 'cliente'
        : field === 'product'
          ? 'produto'
          : field === 'name'
            ? 'nome'
            : 'quantidade';
  const article = label === 'quantidade' ? 'a' : 'o';
  return `Anotei ${article} ${label} como ${value}? Responda 1 para confirmar.`;
}

export function dayChoicePrompt(names: string[]): string {
  const list =
    names.length <= 1
      ? `Ontem ficou pendente: ${names[0] || 'um formulário'}.`
      : `Ontem ficaram pendentes: ${names.join(', ')}.`;
  const resume = names.length <= 1 ? 'Retomar ontem' : `Retomar ${names[0]}`;
  return [list, `1) ${resume}`, '2) Começar hoje', 'Digite o número da opção.'].join('\n');
}

export const AUDIO_MISSED =
  'Não consegui ouvir o áudio. Pode repetir por texto ou enviar o áudio de novo?';

export const OFFER_REPEAT_HINT = 'Você está escolhendo o próximo formulário.';

export async function readBotMode(conversationId: string): Promise<BotMode | undefined> {
  if (!conversationId) return undefined;
  const row = await one<{ bot_mode: string; bot_mode_json: string }>(
    `SELECT bot_mode, bot_mode_json FROM conversation_questionnaire_context WHERE conversation_id = $1`,
    [conversationId],
  );
  if (!row?.bot_mode) return undefined;
  let extra: Partial<BotMode> = {};
  try {
    extra = JSON.parse(row.bot_mode_json || '{}') as Partial<BotMode>;
  } catch {
    extra = {};
  }
  const kind = row.bot_mode;
  if (kind !== 'menu' && kind !== 'offer' && kind !== 'question' && kind !== 'confirm' && kind !== 'day') {
    return undefined;
  }
  return { ...extra, kind };
}

export async function saveBotMode(conversationId: string, mode: BotMode): Promise<void> {
  if (!conversationId) return;
  const current = await readBotMode(conversationId);
  const stored: BotMode = {
    ...mode,
    dayResolved: mode.dayResolved || current?.dayResolved || '',
  };
  const kind = stored.kind;
  const stamp = new Date().toISOString();
  await run(
    `INSERT INTO conversation_questionnaire_context(
       conversation_id, active_cycle_id, candidate_cycle_ids_json, awaiting_selection, updated_at,
       bot_mode, bot_mode_json
     ) VALUES($1, '', '[]', 0, $2, $3, $4)
     ON CONFLICT(conversation_id) DO UPDATE SET
       bot_mode = excluded.bot_mode,
       bot_mode_json = excluded.bot_mode_json,
       updated_at = excluded.updated_at`,
    [conversationId, stamp, kind, JSON.stringify(stored)],
  );
  if (kind !== 'menu') await clearMenuOpen(conversationId);
}

async function clearMenuOpen(conversationId: string): Promise<void> {
  await run(
    `UPDATE conversation_menu_state SET shown_at = '', updated_at = $2
     WHERE conversation_id = $1 AND shown_at <> ''`,
    [conversationId, new Date().toISOString()],
  );
}

export async function todayCollectionIsOpen(contactId: string, today: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM questionnaire_cycles
     WHERE contact_id = $1 AND occurrence_date = $2 AND superseded_at = ''
       AND status IN ('in_progress', 'notified', 'sending')
     LIMIT 1`,
    [contactId, today],
  );
  return Boolean(row);
}

export async function findYesterdayResume(
  contactId: string,
  today: string,
): Promise<{ cycleId: string; names: string[] } | undefined> {
  if (!contactId) return undefined;
  const yesterday = shiftIsoDate(today, -1);
  const rows = await one<{ id: string; name: string }>(
    `SELECT cyc.id, q.name
     FROM questionnaire_cycles cyc
     JOIN questionnaires q ON q.id = cyc.questionnaire_id
     WHERE cyc.contact_id = $1 AND cyc.occurrence_date = $2 AND cyc.superseded_at = ''
       AND (
         cyc.status IN ('open', 'notified', 'in_progress', 'sending')
         OR (cyc.status = 'failed' AND cyc.error = $3)
       )
     ORDER BY cyc.updated_at DESC
     LIMIT 1`,
    [contactId, yesterday, DAY_CLOSE_ERROR],
  );
  if (!rows) return undefined;
  const names = await listYesterdayNames(contactId, yesterday);
  return { cycleId: rows.id, names: names.length ? names : [rows.name] };
}

async function listYesterdayNames(contactId: string, yesterday: string): Promise<string[]> {
  const rows = await many<{ name: string }>(
    `SELECT q.name
     FROM questionnaire_cycles cyc
     JOIN questionnaires q ON q.id = cyc.questionnaire_id
     WHERE cyc.contact_id = $1 AND cyc.occurrence_date = $2 AND cyc.superseded_at = ''
       AND (
         cyc.status IN ('open', 'notified', 'in_progress', 'sending')
         OR (cyc.status = 'failed' AND cyc.error = $3)
       )
     ORDER BY cyc.updated_at DESC`,
    [contactId, yesterday, DAY_CLOSE_ERROR],
  );
  return rows.map((row) => String(row.name || '').replace(/^\[(Forms|Agro)\]\s*/i, '').trim()).filter(Boolean);
}

export async function resumeYesterdayCycle(input: {
  conversationId: string;
  cycleId: string;
  today: string;
  contactName: string;
}): Promise<{ text: string; cycle?: ActiveCycleContext }> {
  const stamp = new Date().toISOString();
  await run(
    `UPDATE questionnaire_cycles
     SET status = 'in_progress', error = '', updated_at = $2
     WHERE id = $1 AND status = 'failed'`,
    [input.cycleId, stamp],
  );
  await setConversationCycleContext(input.conversationId, input.cycleId);
  const [context] = await getCycleContextsByIds([input.cycleId]);
  if (!context) {
    await saveBotMode(input.conversationId, { kind: 'menu', dayResolved: input.today });
    return { text: 'Não encontrei o formulário de ontem. Vamos começar o de hoje.' };
  }
  const questionId = context.missing[0]?.id || context.questionnaire.questions[0]?.id || '';
  await saveBotMode(input.conversationId, {
    kind: 'question',
    cycleId: context.cycle.id,
    questionId,
    dayResolved: input.today,
  });
  const ask = await missingPromptFor(context.questionnaire, context.missing.length ? context.missing : context.questionnaire.questions, context.answers);
  return {
    cycle: context,
    text: [`Certo, seguimos com o de ontem.`, ask].filter(Boolean).join('\n\n'),
  };
}
