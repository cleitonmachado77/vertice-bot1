import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanRfqAnswer,
  detectRfqFieldFromQuestion,
  messageLooksLikeField,
} from './rfq-answer-dictionary.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const q = (body: string, export_field = ''): QuestionnaireQuestion => ({
  id: 'q1',
  questionnaire_id: 'q',
  body,
  expected_type: 'any',
  export_field,
  sort_order: 0,
});

test('detecta campo RFQ pelo export_field e pelo texto da pergunta', () => {
  assert.equal(detectRfqFieldFromQuestion(q('Qualquer texto', 'products')), 'products');
  assert.equal(detectRfqFieldFromQuestion(q('Quantos kg vc recebeu?')), 'quantity');
  assert.equal(detectRfqFieldFromQuestion(q('Qual produto vc recebeu?')), 'products');
  assert.equal(detectRfqFieldFromQuestion(q('Qual foi o fornecedor?')), 'vendor');
  assert.equal(detectRfqFieldFromQuestion(q('Forma de pagamento?')), 'payment_terms');
  assert.equal(detectRfqFieldFromQuestion(q('Qual o preço unitário?')), 'unit_price');
});

test('limpa quantity e products quando misturados', () => {
  assert.equal(cleanRfqAnswer('399kg de cobre', 'quantity'), '399 kg');
  assert.equal(cleanRfqAnswer('399kg de cobre', 'products'), 'cobre');
  assert.equal(cleanRfqAnswer('hoje recebi 250 kg de Alumínio', 'products'), 'alumínio');
  assert.equal(cleanRfqAnswer('cobre queimado 10kg', 'products'), 'cobre queimado');
});

test('catalogo cobre agricola, educacional e outras unidades', () => {
  assert.equal(cleanRfqAnswer('200 sacas de soja', 'products'), 'soja');
  assert.equal(cleanRfqAnswer('200 sacas de soja', 'quantity'), '200 sc');
  assert.equal(cleanRfqAnswer('50 un de caderno', 'products'), 'caderno');
  assert.equal(cleanRfqAnswer('50 un de caderno', 'quantity'), '50 un');
  assert.equal(cleanRfqAnswer('30 litros de leite', 'products'), 'leite');
  assert.equal(cleanRfqAnswer('30 litros de leite', 'quantity'), '30 L');
  assert.equal(cleanRfqAnswer('fertilizante NPK', 'products'), 'NPK');
  assert.equal(cleanRfqAnswer('recebi PET', 'products'), 'PET');
  assert.equal(messageLooksLikeField('100 sc de milho', 'products'), true);
});

test('normaliza preço, taxa, pagamento e datas', () => {
  assert.equal(cleanRfqAnswer('saiu por R$ 12,50 o kg', 'unit_price'), 'R$ 12,50');
  assert.equal(cleanRfqAnswer('ICMS de R$ 3,00', 'taxes'), 'R$ 3,00');
  assert.equal(cleanRfqAnswer('paguei no pix', 'payment_terms'), 'PIX');
  assert.equal(cleanRfqAnswer('chegada em 14/10/2026', 'expected_arrival'), '14/10/2026');
  assert.equal(cleanRfqAnswer('comprei ontem', 'order_deadline'), 'ontem');
});

test('referencia e vendor não engolem quantidade', () => {
  assert.equal(cleanRfqAnswer('NF 12345', 'order_reference'), '12345');
  assert.equal(cleanRfqAnswer('fornecedor João da Silva', 'vendor'), 'João da Silva');
  assert.equal(messageLooksLikeField('Recebi 10 kg', 'vendor'), false);
  assert.equal(messageLooksLikeField('Recebi 10 kg de cobre', 'products'), true);
  assert.equal(messageLooksLikeField('Recebi 10 kg de cobre', 'quantity'), true);
});
