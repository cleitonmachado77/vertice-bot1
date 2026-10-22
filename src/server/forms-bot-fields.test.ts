import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasExplicitUnit,
  isLinesMoreDoneAnswer,
  isUsableLinesMoreAnswer,
  mentionsNoMoreLines,
  parseQtyProductChunks,
  quantityNumber,
} from './forms-bot-fields.js';
import { scoreMatch } from './forms-bot-match.js';
import { partnerNameKey, repairCorruptedName } from './forms-name-key.js';
import { isFullyAnswered, isUsableAnswerForQuestion } from './questionnaire-rules.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

test('parseQtyProductChunks — quantidade antes ou depois do produto', () => {
  assert.deepEqual(parseQtyProductChunks('Recebi 60 kg de abacate e 23 kg de mandioca'), [
    { quantity: '60 kg', product: 'abacate' },
    { quantity: '23 kg', product: 'mandioca' },
  ]);
  assert.deepEqual(parseQtyProductChunks('abacate 60 kg, mandioca 23 kg'), [
    { quantity: '60 kg', product: 'abacate' },
    { quantity: '23 kg', product: 'mandioca' },
  ]);
  assert.deepEqual(parseQtyProductChunks('abacate 60 kg'), [{ quantity: '60 kg', product: 'abacate' }]);
  assert.deepEqual(parseQtyProductChunks('60kg abacate'), [{ quantity: '60 kg', product: 'abacate' }]);
  assert.deepEqual(parseQtyProductChunks('20 kg de abacate, nao temos mais produtos para lançar'), [
    { quantity: '20 kg', product: 'abacate' },
  ]);
  assert.deepEqual(parseQtyProductChunks('12 un de alface americana'), [
    { quantity: '12 un', product: 'alface americana' },
  ]);
  // Sem produto identificável → nada (nunca “kg” como produto).
  assert.deepEqual(parseQtyProductChunks('Recebi 60 kg'), []);
  assert.deepEqual(parseQtyProductChunks('3'), []);
  assert.deepEqual(parseQtyProductChunks('1'), []);
});

test('isLinesMoreDoneAnswer aceita variações naturais de “não”', () => {
  for (const text of ['não', 'Não, só isso', 'nao tem mais', 'só isso mesmo', 'nada mais', 'pronto', 'por enquanto é só']) {
    assert.equal(isLinesMoreDoneAnswer(text), true, text);
  }
  for (const text of ['não, mais 10 kg de banana', 'sim', 'banana também', 'ainda tem mandioca', 'mais banana']) {
    assert.equal(isLinesMoreDoneAnswer(text), false, text);
  }
  assert.equal(isUsableLinesMoreAnswer('10 kg de banana'), true);
  assert.equal(isUsableLinesMoreAnswer('banana'), false);
});

test('mentionsNoMoreLines detecta encerramento junto das linhas', () => {
  assert.equal(mentionsNoMoreLines('20 kg de abacate, nao temos mais produtos para lançar'), true);
  assert.equal(mentionsNoMoreLines('Recebi 60 kg de abacate e 23 kg de mandioca'), false);
});

test('“não” em “Mais produtos?” conta como resposta e conclui o ciclo', () => {
  const questions: QuestionnaireQuestion[] = [
    { id: 'v', questionnaire_id: 'q', body: 'Fornecedor?', expected_type: 'any', export_field: 'vendor', sort_order: 0 },
    { id: 'l', questionnaire_id: 'q', body: 'Qtd de ABACATE - KG?', expected_type: 'any', export_field: '__lines__', sort_order: 1 },
    { id: 'm', questionnaire_id: 'q', body: 'Mais produtos?', expected_type: 'any', export_field: '__lines_more__', sort_order: 2 },
  ];
  assert.equal(isUsableAnswerForQuestion(questions[2], 'não'), true);
  assert.equal(isUsableAnswerForQuestion(questions[0], 'não'), false);
  assert.equal(isUsableAnswerForQuestion(questions[0], 'Já respondi o fornecedor'), false);
  const answers = [
    { id: '1', cycle_id: 'c', question_id: 'v', answer_text: 'MUNICIPIO DE CAMBE', answer_type: 'text', media_url: '' },
    { id: '2', cycle_id: 'c', question_id: 'l', answer_text: '[{"product":"abacate","quantity":"60 kg"}]', answer_type: 'text', media_url: '' },
    { id: '3', cycle_id: 'c', question_id: 'm', answer_text: 'não', answer_type: 'text', media_url: '' },
  ];
  assert.equal(isFullyAnswered(questions, answers), true);
});

test('scoreMatch não casa palavra genérica nem prefixo curto', () => {
  assert.equal(scoreMatch('fornecedor', 'Fornecedor Teste Vertice'), 0);
  assert.equal(scoreMatch('eu ja confirmei, é o fornecedor 3', 'Fornecedor Teste Vertice'), 0);
  assert.equal(scoreMatch('cam', 'MUNICIPIO DE CAMBE'), 0);
  assert.ok(scoreMatch('cambe', 'MUNICIPIO DE CAMBE') >= 60);
  assert.ok(scoreMatch('municipio de cambe', 'MUNICIPIO DE CAMBE') === 100);
  assert.ok(scoreMatch('Marcio Luiz', 'Marcio Luiz Pietsrzak') >= 90);
});

test('partnerNameKey / repairCorruptedName lidam com encoding quebrado', () => {
  assert.equal(partnerNameKey('Lupionópolis'), partnerNameKey('LUPIONOPOLIS'));
  const broken = 'Associa\uFFFD\uFFFDo do Desenvolvimento Comunit\uFFFDrio de Lupion\uFFFDpolis';
  const clean = 'Associação do Desenvolvimento Comunitário de Lupionópolis';
  assert.equal(repairCorruptedName(broken, ['Outro', clean]), clean);
  assert.equal(repairCorruptedName(broken, ['Outro']), broken);
  assert.equal(repairCorruptedName(clean, [broken]), clean);
});

test('quantityNumber guarda só o número da quantidade', () => {
  assert.equal(quantityNumber('50 kg'), '50');
  assert.equal(quantityNumber('1,5 kg'), '1.5');
  assert.equal(quantityNumber('3'), '3');
  assert.equal(quantityNumber('kg'), '');
});

test('hasExplicitUnit distingue quantidade de nome com número', () => {
  assert.equal(hasExplicitUnit('50 kg de abacate'), true);
  assert.equal(hasExplicitUnit('recebi 20kg'), true);
  assert.equal(hasExplicitUnit('3 Irmãos'), false);
  assert.equal(hasExplicitUnit('3 limões'), false);
});
