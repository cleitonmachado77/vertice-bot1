import assert from 'node:assert/strict';
import test from 'node:test';
import { questionIdForCatalogList, tryFormsLinesCapture } from './forms-bot-capture.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

const questions: QuestionnaireQuestion[] = [
  {
    id: 'v',
    questionnaire_id: 'q',
    body: 'Fornecedor?',
    expected_type: 'any',
    export_field: 'vendor',
    sort_order: 0,
  },
  {
    id: 'l',
    questionnaire_id: 'q',
    body: 'Produtos?',
    expected_type: 'any',
    export_field: '__lines__',
    sort_order: 1,
  },
  {
    id: 'm',
    questionnaire_id: 'q',
    body: 'Mais produtos?',
    expected_type: 'any',
    export_field: '__lines_more__',
    sort_order: 2,
  },
];

test('tryFormsLinesCapture grava JSON nas linhas', () => {
  const accepted = tryFormsLinesCapture({
    inbound: 'Recebi 60 kg de abacate e 23 kg de mandioca',
    questions,
    alreadySaved: [
      { id: 'a', cycle_id: 'c', question_id: 'v', answer_text: 'João', answer_type: 'text', media_url: '' },
    ],
  });
  assert.ok(accepted);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].questionId, 'l');
  assert.match(accepted[0].text, /abacate/);
});

test('não encerra “mais produtos” se a pergunta pendente for o fornecedor', () => {
  const accepted = tryFormsLinesCapture({
    inbound: 'não',
    questions,
    alreadySaved: [
      { id: 'a', cycle_id: 'c', question_id: 'l', answer_text: '[{"product":"abacate","quantity":"60"}]', answer_type: 'text', media_url: '' },
    ],
    pendingQuestionId: 'v',
  });
  assert.equal(accepted, null);
});

test('linhas claras são gravadas mesmo com o fornecedor pendente', () => {
  const accepted = tryFormsLinesCapture({
    inbound: '50 kg de abacate e 20 kg de mandioca',
    questions,
    alreadySaved: [],
    pendingQuestionId: 'v',
  });
  assert.ok(accepted);
  assert.equal(accepted[0].questionId, 'l');
  assert.deepEqual(JSON.parse(accepted[0].text), [
    { product: 'abacate', quantity: '50 kg' },
    { product: 'mandioca', quantity: '20 kg' },
  ]);
});

test('nome com número não vira linha quando a pergunta pendente é o fornecedor', () => {
  const accepted = tryFormsLinesCapture({
    inbound: '3 Irmãos',
    questions,
    alreadySaved: [],
    pendingQuestionId: 'v',
  });
  assert.equal(accepted, null);
});

test('“não” fecha mais produtos quando essa for a pergunta pendente', () => {
  const accepted = tryFormsLinesCapture({
    inbound: 'não',
    questions,
    alreadySaved: [
      { id: 'a', cycle_id: 'c', question_id: 'v', answer_text: 'João', answer_type: 'text', media_url: '' },
      { id: 'b', cycle_id: 'c', question_id: 'l', answer_text: '[{"product":"abacate","quantity":"60"}]', answer_type: 'text', media_url: '' },
    ],
    pendingQuestionId: 'm',
  });
  assert.deepEqual(accepted, [{ questionId: 'm', text: 'não', type: 'text' }]);
});

test('lista enviada aponta a pergunta que ela responde', () => {
  const questionnaire = { id: 'forms-preset:p1', questions } as unknown as Questionnaire;
  const vendorList = 'Fornecedor — escolha o número:\n1) João\n2) Maria\nResponda com o número ou o nome.';
  const productList = 'Produto — escolha o número:\n1) ABACATE - KG\n2) VAGEM - KG\nDigite *mais* para ver 11–20 (total 30).';
  assert.equal(questionIdForCatalogList(questionnaire, vendorList), 'v');
  // Lista de produtos responde a pergunta de linhas, não a primeira pergunta do questionário.
  assert.equal(questionIdForCatalogList(questionnaire, productList), 'l');
  assert.equal(questionIdForCatalogList(questionnaire, 'Anotei, obrigado!'), '');
});
