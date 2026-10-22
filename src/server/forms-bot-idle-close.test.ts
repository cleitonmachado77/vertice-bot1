import assert from 'node:assert/strict';
import test from 'node:test';
import { FORMS_BOT_LINES_FIELD, FORMS_BOT_LINES_MORE_FIELD, isLinesMoreDoneAnswer } from './forms-bot-fields.js';
import {
  IDLE_CLOSE_ANSWER,
  idleCloseMessage,
  idleCloseSummary,
  isReadyForIdleClose,
} from './forms-bot-idle-close.js';
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
const answer = (questionId: string, text: string): CycleAnswer => ({
  id: questionId,
  cycle_id: 'c',
  question_id: questionId,
  answer_text: text,
  answer_type: 'text',
  media_url: '',
});
const lines = answer('l', JSON.stringify([{ product: 'manga', quantity: '100 kg' }, { product: 'mandioca', quantity: '20 kg' }]));

test('pronto para encerrar quando só falta “Mais produtos?”', () => {
  assert.equal(isReadyForIdleClose(questions, [answer('v', 'MUNICIPIO DE CAMBE'), lines]), true);
});

test('não encerra sem as linhas ou sem o fornecedor', () => {
  assert.equal(isReadyForIdleClose(questions, [answer('v', 'MUNICIPIO DE CAMBE')]), false);
  assert.equal(isReadyForIdleClose(questions, [lines]), false);
  assert.equal(isReadyForIdleClose(questions, []), false);
});

test('não encerra questionário sem bloco de linhas', () => {
  const headerOnly = [question('v', 'Fornecedor?', 'vendor', 0)];
  assert.equal(isReadyForIdleClose(headerOnly, []), false);
});

test('resposta automática conta como “não” e conclui o ciclo', () => {
  assert.equal(isLinesMoreDoneAnswer(IDLE_CLOSE_ANSWER), true);
  const answers = [answer('v', 'MUNICIPIO DE CAMBE'), lines, answer('m', IDLE_CLOSE_ANSWER)];
  assert.ok(isFullyAnswered(questions, answers));
});

test('resumo e mensagem de encerramento', () => {
  const summary = idleCloseSummary(questions, [answer('v', 'MUNICIPIO DE CAMBE'), lines]);
  assert.equal(summary, 'MUNICIPIO DE CAMBE; 100 kg de manga; 20 kg de mandioca');
  assert.equal(
    idleCloseMessage('Cleiton Machado', summary),
    'Cleiton, como não recebi mais itens, encerrei o registro: MUNICIPIO DE CAMBE; 100 kg de manga; 20 kg de mandioca.\nSe faltou algo, é só me mandar que eu atualizo.',
  );
});
