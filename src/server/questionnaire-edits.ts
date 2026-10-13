import { completeChat } from './agent.js';
import { withTransaction } from './db.js';
import {
  deleteCycleAnswers,
  listCycleAnswers,
  markCycleCompleted,
  reopenCycle,
  upsertAnswers,
  type CycleAnswer,
} from './questionnaire-cycles.js';
import { QuestionnaireTemporarilyUnavailableError } from './questionnaire-errors.js';
import {
  extractJson,
  filterAccepted,
  normalizeExtractedAnswers,
  parseExtracted,
  type ExtractedAnswer,
} from './questionnaire-extraction.js';
import { editReply, formatAnswers, type EditAction } from './questionnaire-replies.js';
import { isFullyAnswered } from './questionnaire-rules.js';
import type { QuestionnaireDraft } from './questionnaire-agent.js';
import type { MediaUnderstanding } from './media-understand.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

type AnswerEditPlan = {
  answers: ExtractedAnswer[];
  clearQuestionIds: string[];
  clearAll: boolean;
  action: EditAction;
};

export async function applyQuestionnaireEdit(input: {
  cycleId: string;
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  userMessage: string;
  media: MediaUnderstanding;
  mediaUrl: string;
  contactName: string;
  occurrenceDate: string;
}): Promise<QuestionnaireDraft | null> {
  try {
    const plan = await planAnswerEdit(input);
    return await withTransaction(() => applyEditPlan(input, plan));
  } catch (error) {
    if (error instanceof QuestionnaireTemporarilyUnavailableError) throw error;
    console.error('edição de questionário:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function applyEditPlan(
  input: {
    cycleId: string;
    questions: QuestionnaireQuestion[];
    alreadySaved: CycleAnswer[];
    media: MediaUnderstanding;
    mediaUrl: string;
    contactName: string;
  },
  plan: AnswerEditPlan,
): Promise<QuestionnaireDraft | null> {
  if (plan.clearAll) await deleteCycleAnswers(input.cycleId);
  else if (plan.clearQuestionIds.length) {
    await deleteCycleAnswers(input.cycleId, plan.clearQuestionIds);
  }

  const accepted = filterAccepted(
    normalizeExtractedAnswers(plan.answers, input.questions, input.questions),
    input.questions,
    input.media,
  );
  let answers = input.alreadySaved;
  if (accepted.length) {
    answers = await upsertAnswers(
      input.cycleId,
      accepted.map((item) => ({
        questionId: item.questionId,
        text: item.text,
        type: item.type,
        mediaUrl: item.type === 'text' ? '' : input.media.mediaUrl || input.mediaUrl,
      })),
    );
  } else if (plan.clearAll || plan.clearQuestionIds.length) {
    answers = await listCycleAnswers(input.cycleId);
  }

  if (!accepted.length && !plan.clearAll && !plan.clearQuestionIds.length) return null;
  const complete = isFullyAnswered(input.questions, answers);
  if (complete) await markCycleCompleted(input.cycleId);
  else await reopenCycle(input.cycleId);
  return {
    text: editReply(input.contactName, plan.action),
    source: 'model',
    detail:
      plan.action === 'delete'
        ? 'questionário apagado/parcialmente apagado'
        : plan.action === 'correct'
          ? 'questionário corrigido'
          : 'questionário atualizado',
    completed: complete,
  };
}

export function isCorrectionOrDeleteRequest(inbound: string): boolean {
  return /engan|corrig|erra(do|da|mos)?|apag(ar|ue|a|o)?|delet|remov(er|a|e)|limpar|limpa|n[aã]o foi|na verdade|foi \d+/i.test(
    inbound,
  );
}

async function planAnswerEdit(input: {
  questions: QuestionnaireQuestion[];
  alreadySaved: CycleAnswer[];
  userMessage: string;
  media: MediaUnderstanding;
  occurrenceDate: string;
}): Promise<AnswerEditPlan> {
  const empty: AnswerEditPlan = { answers: [], clearQuestionIds: [], clearAll: false, action: 'update' };
  if (!input.questions.length) return empty;
  const message = (input.media.summary || input.media.transcript || input.userMessage || '').trim();
  if (!message) return empty;
  const validIds = new Set(input.questions.map((item) => item.id));
  try {
    const raw = await completeChat(
      [
        {
          role: 'system',
          content: [
            'Você edita respostas salvas de um questionário conforme o pedido do usuário.',
            `Data do ciclo: ${input.occurrenceDate}.`,
            'Retorne APENAS JSON válido:',
            '{"action":"append|correct|delete|update","clearAll":false,"clearQuestionIds":[],"answers":[{"questionId":"id-exato","text":"valor","type":"text"}]}',
            'Complemento: mescle com o valor anterior. Correção: substitua o valor errado.',
            'Exclusão: use clearAll ou clearQuestionIds. Nunca invente fatos.',
            'Perguntas:',
            ...input.questions.map((item, index) => `${index + 1}. id=${item.id} | ${item.body}`),
            'Respostas já salvas:',
            formatAnswers(input.questions, input.alreadySaved) || '(nenhuma)',
          ].join('\n'),
        },
        { role: 'user', content: `Pedido do usuário:\n${message}` },
      ],
      { temperature: 0.1, timeoutMs: 25_000 },
    );
    return parseEditPlan(raw, input.media, validIds);
  } catch (error) {
    throw new QuestionnaireTemporarilyUnavailableError(
      error instanceof Error ? error.message : 'Falha ao interpretar alteração',
    );
  }
}

function parseEditPlan(
  raw: string,
  media: MediaUnderstanding,
  validIds: Set<string>,
): AnswerEditPlan {
  const extracted = parseExtracted(raw, media);
  const jsonText = extractJson(raw);
  let clearAll = false;
  let clearQuestionIds: string[] = [];
  let action: EditAction = 'update';
  if (jsonText) {
    try {
      const data = JSON.parse(jsonText) as {
        action?: unknown;
        clearAll?: unknown;
        clearQuestionIds?: unknown;
      };
      const actionRaw = String(data.action || '').toLowerCase();
      if (['append', 'correct', 'delete', 'update'].includes(actionRaw)) {
        action = actionRaw as EditAction;
      }
      clearAll = Boolean(data.clearAll);
      if (Array.isArray(data.clearQuestionIds)) {
        clearQuestionIds = data.clearQuestionIds.map(String).filter((id) => validIds.has(id));
      }
    } catch {
      // JSON inválido não produz mutação destrutiva.
    }
  }
  if (clearAll || (clearQuestionIds.length && !extracted.answers.length)) action = 'delete';
  return {
    answers: extracted.answers.filter((item) => validIds.has(item.questionId)),
    clearQuestionIds,
    clearAll,
    action,
  };
}
