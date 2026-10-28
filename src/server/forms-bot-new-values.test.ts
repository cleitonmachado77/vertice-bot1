import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedSummary, tryFormsBotCapture } from './forms-bot-capture.js';
import { describeLinesAnswer } from './forms-bot-closing.js';
import {
  FORMS_BOT_LINES_FIELD,
  FORMS_BOT_LINES_MORE_FIELD,
  isMarkedNewValue,
  markNewValue,
  parseQtyProductChunks,
  quantityOnlyLinesQuestion,
  unmarkNewValue,
} from './forms-bot-fields.js';
import { isReadyForIdleClose } from './forms-bot-idle-close.js';
import { missingQuestions, type CycleAnswer } from './questionnaire-cycles.js';
import { normalizeExtractedAnswers } from './questionnaire-extraction.js';
import { ensureMissingAsked, promisesListWithoutItems } from './questionnaire-replies.js';
import { isAckPhrase, isGreetingOrAck, isUnusableQuestionnaireAnswer } from './questionnaire-rules.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

// Ciclo de 27/10: “bom dia posso sim” virou fornecedor e “fornecedor 2” virou produto no Odoo.

const question = (id: string, body: string, exportField: string, sortOrder: number, fixedValue = ''): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'forms-preset:p1',
  body,
  expected_type: 'any',
  export_field: exportField,
  sort_order: sortOrder,
  fixed_value: fixedValue,
});

const questions = [
  question('v', 'Fornecedor?', 'vendor', 0),
  question('l', quantityOnlyLinesQuestion('ABACATE - KG'), FORMS_BOT_LINES_FIELD, 1, 'ABACATE - KG'),
  question('m', 'Mais produtos? (produto + qtd, ou “não”)', FORMS_BOT_LINES_MORE_FIELD, 2),
];
const questionnaire = {
  id: 'forms-preset:p1',
  sourcePresetId: 'p1',
  formKind: 'purchase',
  companyOdooId: '1',
  questions,
} as unknown as Questionnaire;

const answer = (questionId: string, text: string): CycleAnswer => ({
  id: questionId,
  cycle_id: 'c',
  question_id: questionId,
  answer_text: text,
  answer_type: 'text',
  media_url: '',
});

test('aceite com saudação não é resposta de campo', () => {
  for (const text of ['bom dia posso sim', 'Bom dia, pode sim!', 'oi, tudo bem? pode mandar', 'sim, vamos lá', 'ok pode']) {
    assert.equal(isAckPhrase(text), true, text);
    assert.equal(isGreetingOrAck(text), true, text);
    assert.equal(isUnusableQuestionnaireAnswer(text), true, text);
  }
  const dropped = normalizeExtractedAnswers([{ questionId: 'v', text: 'bom dia posso sim', type: 'text' }], questions, questions);
  assert.deepEqual(dropped, []);
});

test('nomes reais e recusas não viram aceite', () => {
  for (const text of ['MUNICIPIO DE CAMBE', 'SESAI', 'Fornecedor Teste Vertice', 'não posso hoje', 'Sítio Boa Vista', 'Posto Bom Dia']) {
    assert.equal(isAckPhrase(text), false, text);
  }
  assert.equal(isUnusableQuestionnaireAnswer('Posto Bom Dia'), false);
});

test('“fornecedor 2” não vira 2 kg do produto “fornecedor”', () => {
  assert.deepEqual(parseQtyProductChunks('fornecedor 2, 50 kg de abacate'), [{ quantity: '50 kg', product: 'abacate' }]);
  assert.deepEqual(parseQtyProductChunks('cliente 3'), []);
  assert.deepEqual(parseQtyProductChunks('abacate 60 kg, mandioca 23 kg'), [
    { quantity: '60 kg', product: 'abacate' },
    { quantity: '23 kg', product: 'mandioca' },
  ]);
});

test('valor “[novo?]” não conta como respondido nem libera o encerramento por inatividade', () => {
  const marked = markNewValue('Sítio do Zé');
  assert.equal(isMarkedNewValue(marked), true);
  assert.equal(unmarkNewValue(marked), 'Sítio do Zé');
  assert.equal(markNewValue(marked), marked);
  assert.equal(isUnusableQuestionnaireAnswer(marked), true);

  const answers = [answer('v', 'Fornecedor Teste Vertice'), answer('l', markNewValue('[{"product":"jaca","quantity":"5 kg"}]'))];
  assert.deepEqual(missingQuestions(questions, answers).map((item) => item.id), ['l', 'm']);

  const onlyMoreMarked = [answer('v', 'Fornecedor Teste Vertice'), answer('l', '[{"product":"ABACATE - KG","quantity":"5"}]'), answer('m', markNewValue('3 kg de jaca'))];
  assert.equal(isReadyForIdleClose(questions, onlyMoreMarked), false);
  assert.equal(describeLinesAnswer(onlyMoreMarked[2].answer_text), '3 kg de jaca');
});

test('“sim” confirma o fornecedor novo e grava sem a marca', async () => {
  const captured = await tryFormsBotCapture({
    inbound: 'sim',
    questionnaire,
    questions,
    alreadySaved: [answer('v', markNewValue('Sítio do Zé'))],
    history: [],
    pendingQuestionId: 'v',
  });
  assert.equal(captured?.kind, 'answers');
  assert.ok(captured?.kind === 'answers');
  assert.deepEqual(captured.accepted, [{ questionId: 'v', text: 'Sítio do Zé', type: 'text', confirmedNew: true }]);
  assert.equal(captured.summary, 'Sítio do Zé (cadastro novo)');
});

test('“não” no produto novo pede as linhas de novo', async () => {
  const captured = await tryFormsBotCapture({
    inbound: 'não',
    questionnaire,
    questions,
    alreadySaved: [answer('v', 'Fornecedor Teste Vertice'), answer('l', markNewValue('[{"product":"jaca","quantity":"5 kg"}]'))],
    history: [],
    pendingQuestionId: 'l',
  });
  assert.equal(captured?.kind, 'reask');
  assert.ok(captured?.kind === 'reask' && /50 kg de abacate/.test(captured.text));
});

test('resumo omite o que ainda aguarda “é novo?”', () => {
  const summary = acceptedSummary(
    [
      { questionId: 'v', text: markNewValue('bom fornecedor'), type: 'text' },
      { questionId: 'l', text: '[{"product":"abacate","quantity":"50 kg"}]', type: 'text' },
      { questionId: 'm', text: 'não', type: 'text' },
    ],
    ['v'],
  );
  assert.equal(summary, '50 kg de abacate');
});

test('reply que promete a lista e não traz é substituída', () => {
  assert.equal(promisesListWithoutItems('Ótimo, Cleiton! Vamos começar. Aqui estão as perguntas:'), true);
  assert.equal(promisesListWithoutItems('Aqui estão as perguntas:\n1) Fornecedor?\n2) Qtd?'), false);
  assert.equal(promisesListWithoutItems('Anotei o fornecedor. Qual a quantidade de abacate?'), false);

  const replaced = ensureMissingAsked({
    reply: 'Ótimo, Cleiton! Vamos começar. Aqui estão as perguntas:',
    missing: questions,
    answers: [],
    media: { type: 'text', summary: '', transcript: '', caption: '', mediaUrl: '', understood: true },
    contactName: 'Cleiton Machado',
    questions,
  });
  assert.match(replaced, /Fornecedor\?/);
});
