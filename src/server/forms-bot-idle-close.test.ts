import assert from 'node:assert/strict';
import test from 'node:test';
import { formsAnswersSummary, tryConfirmCapture, tryLateLinesCapture } from './forms-bot-closing.js';
import {
  FORMS_BOT_CONFIRM_FIELD,
  FORMS_BOT_LINES_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  isLinesMoreDoneAnswer,
} from './forms-bot-fields.js';
import {
  IDLE_CLOSE_ANSWER,
  IDLE_CONFIRM_ANSWER,
  decideIdleAction,
  idleCloseMessage,
  idleReminderMessage,
  isReadyForIdleClose,
} from './forms-bot-idle-close.js';
import { isQuietTime, sanitizeFormsBotRules } from './forms-bot-rules.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import { isFullyAnswered } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const question = (id: string, body: string, exportField: string, sortOrder: number): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'forms-preset:p1',
  body,
  expected_type: 'any',
  export_field: exportField,
  sort_order: sortOrder,
});
const questions = [
  question('v', 'Fornecedor?', 'vendor', 0),
  question('l', 'Qtd de ABACATE - KG?', FORMS_BOT_LINES_FIELD, 1),
  question('m', 'Mais produtos?', FORMS_BOT_LINES_MORE_FIELD, 2),
];
const withConfirm = [...questions, question('c', 'Confirma o registro? (sim / corrigir)', FORMS_BOT_CONFIRM_FIELD, 3)];
const answer = (questionId: string, text: string): CycleAnswer => ({
  id: questionId,
  cycle_id: 'c',
  question_id: questionId,
  answer_text: text,
  answer_type: 'text',
  media_url: '',
});
const vendor = answer('v', 'MUNICIPIO DE CAMBE');
const lines = answer('l', JSON.stringify([{ product: 'manga', quantity: '100 kg' }, { product: 'mandioca', quantity: '20 kg' }]));
const rules = { reminderMinutes: 15, closeMinutes: 30, stalledAlertMinutes: 240 };
const decide = (overrides: Partial<Parameters<typeof decideIdleAction>[0]>) =>
  decideIdleAction({ ready: true, idleMinutes: 0, rules, reminderAgeMinutes: null, stalledAlerted: false, quiet: false, ...overrides });

test('pronto para encerrar quando só falta “Mais produtos?” e/ou a confirmação', () => {
  assert.equal(isReadyForIdleClose(questions, [vendor, lines]), true);
  assert.equal(isReadyForIdleClose(withConfirm, [vendor, lines]), true);
  assert.equal(isReadyForIdleClose(withConfirm, [vendor, lines, answer('m', 'não')]), true);
});

test('não encerra sem os dados obrigatórios', () => {
  assert.equal(isReadyForIdleClose(questions, [vendor]), false);
  assert.equal(isReadyForIdleClose(questions, [lines]), false);
  assert.equal(isReadyForIdleClose([question('v', 'Fornecedor?', 'vendor', 0)], []), false);
});

test('respostas automáticas concluem o ciclo', () => {
  assert.equal(isLinesMoreDoneAnswer(IDLE_CLOSE_ANSWER), true);
  const answers = [vendor, lines, answer('m', IDLE_CLOSE_ANSWER), answer('c', IDLE_CONFIRM_ANSWER)];
  assert.ok(isFullyAnswered(withConfirm, answers));
});

test('lembrete antes, encerramento só depois do tempo prometido', () => {
  assert.equal(decide({ idleMinutes: 10 }), 'none');
  assert.equal(decide({ idleMinutes: 16 }), 'remind-more');
  // Lembrete enviado há 5 min: ainda não encerra, mesmo com 31 min parado.
  assert.equal(decide({ idleMinutes: 31, reminderAgeMinutes: 5 }), 'none');
  assert.equal(decide({ idleMinutes: 31, reminderAgeMinutes: 16 }), 'close');
});

test('sem lembrete, encerra direto; encerramento 0 nunca fecha', () => {
  const noReminder = { ...rules, reminderMinutes: 0 };
  assert.equal(decide({ idleMinutes: 31, rules: noReminder }), 'close');
  const neverClose = { ...rules, closeMinutes: 0 };
  assert.equal(decide({ idleMinutes: 16, rules: neverClose }), 'remind-more');
  assert.equal(decide({ idleMinutes: 300, rules: neverClose, reminderAgeMinutes: 200 }), 'none');
});

test('horário de silêncio segura lembretes e encerramento, mas não o alerta do painel', () => {
  assert.equal(decide({ idleMinutes: 60, quiet: true }), 'none');
  assert.equal(decide({ ready: false, idleMinutes: 60, quiet: true }), 'none');
  assert.equal(decide({ ready: false, idleMinutes: 300, quiet: true }), 'alert-stalled');
});

test('dados parciais: um lembrete do que falta e depois alerta único', () => {
  assert.equal(decide({ ready: false, idleMinutes: 16 }), 'remind-missing');
  assert.equal(decide({ ready: false, idleMinutes: 100, reminderAgeMinutes: 80 }), 'none');
  assert.equal(decide({ ready: false, idleMinutes: 250, reminderAgeMinutes: 230 }), 'alert-stalled');
  assert.equal(decide({ ready: false, idleMinutes: 250, reminderAgeMinutes: 230, stalledAlerted: true }), 'none');
});

test('resumo e mensagens', () => {
  const summary = formsAnswersSummary(questions, [vendor, lines, answer('m', 'não')]);
  assert.equal(summary, 'MUNICIPIO DE CAMBE; 100 kg de manga; 20 kg de mandioca');
  assert.equal(
    idleCloseMessage('Cleiton Machado', summary),
    'Cleiton, como não recebi mais itens, encerrei o registro: MUNICIPIO DE CAMBE; 100 kg de manga; 20 kg de mandioca.\nSe faltou algo, é só me mandar que eu atualizo.',
  );
  assert.equal(
    idleReminderMessage({ contactName: 'Cleiton Machado', summary, onlyConfirm: false, closeInMinutes: 15 }),
    'Cleiton, mais algum produto? Se não, é só responder “não”. Se eu não tiver resposta, registro em 15 minutos.',
  );
});

test('confirmação: “sim” registra, “corrigir” pede o ajuste, outra pergunta pendente não conta', () => {
  const saved = [vendor, lines, answer('m', 'não')];
  const yes = tryConfirmCapture({ inbound: 'sim', questions: withConfirm, alreadySaved: saved, pendingQuestionId: 'c' });
  assert.deepEqual(yes, { kind: 'yes', accepted: [{ questionId: 'c', text: 'sim', type: 'text' }] });
  const fix = tryConfirmCapture({ inbound: 'corrigir', questions: withConfirm, alreadySaved: saved, pendingQuestionId: 'c' });
  assert.equal(fix?.kind, 'correct');
  assert.equal(tryConfirmCapture({ inbound: 'sim', questions: withConfirm, alreadySaved: [vendor], pendingQuestionId: 'l' }), null);
});

test('itens depois do encerramento entram em “Mais produtos?”', () => {
  const closed = [vendor, lines, answer('m', IDLE_CLOSE_ANSWER)];
  const late = tryLateLinesCapture({ inbound: '10 kg de banana', questions, alreadySaved: closed });
  assert.deepEqual(late, {
    accepted: [{ questionId: 'm', text: '10 kg de banana', type: 'text' }],
    summary: '10 kg de banana',
  });
  const again = tryLateLinesCapture({
    inbound: '5 kg de limão',
    questions,
    alreadySaved: [vendor, lines, answer('m', '10 kg de banana')],
  });
  assert.equal(again?.accepted[0].text, '10 kg de banana; 5 kg de limão');
  // Correção não é acréscimo: segue o fluxo de edição.
  assert.equal(tryLateLinesCapture({ inbound: 'na verdade eram 30 kg de manga', questions, alreadySaved: closed }), null);
});

test('regras do padrão e horário de silêncio', () => {
  assert.deepEqual(sanitizeFormsBotRules({ idle_reminder_minutes: '10', idle_close_minutes: '', confirm_before_close: 1 }), {
    idle_reminder_minutes: 10,
    idle_close_minutes: null,
    confirm_before_close: true,
  });
  assert.equal(isQuietTime(23 * 60, '22:00-07:00'), true);
  assert.equal(isQuietTime(6 * 60 + 59, '22:00-07:00'), true);
  assert.equal(isQuietTime(7 * 60, '22:00-07:00'), false);
  assert.equal(isQuietTime(13 * 60, '12:00-14:00'), true);
  assert.equal(isQuietTime(13 * 60, ''), false);
});
