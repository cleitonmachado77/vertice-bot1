import assert from 'node:assert/strict';
import test from 'node:test';
import { tryHeuristicQuestionnaireCapture } from './questionnaire-agent.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const question = (
  id: string,
  body: string,
  export_field = '',
): QuestionnaireQuestion => ({
  id,
  questionnaire_id: 'q1',
  body,
  expected_type: 'any',
  export_field,
  sort_order: 0,
});

const textMedia = (summary: string) => ({
  type: 'text',
  summary,
  transcript: summary,
  caption: summary,
  mediaUrl: '',
  understood: true,
});

test('atalho heurístico cobre kg + produto sem LLM', () => {
  const qty = question('kg', 'Quantos kg vc recebeu?', 'quantity');
  const product = question('produto', 'Qual produto vc recebeu?', 'products');
  const result = tryHeuristicQuestionnaireCapture({
    questions: [qty, product],
    missing: [qty, product],
    alreadySaved: [],
    media: textMedia('Eu recebi 399kg de cobre'),
    inbound: 'Eu recebi 399kg de cobre',
    contactName: 'Cleiton Machado',
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.match(result.reply, /Anotei tudo/i);
  assert.deepEqual(
    result.accepted.map((item) => ({ id: item.questionId, text: item.text })).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    [
      { id: 'kg', text: '399 kg' },
      { id: 'produto', text: 'cobre' },
    ],
  );
});

test('atalho heurístico parcial pede o que falta', () => {
  const qty = question('kg', 'Quantos kg vc recebeu?', 'quantity');
  const product = question('produto', 'Qual produto vc recebeu?', 'products');
  const result = tryHeuristicQuestionnaireCapture({
    questions: [qty, product],
    missing: [qty, product],
    alreadySaved: [],
    media: textMedia('Recebi 10 kg'),
    inbound: 'Recebi 10 kg',
    contactName: 'Cleiton',
  });
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, '10 kg');
  assert.match(result.reply, /ainda falta/i);
});

test('atalho heurístico ignora conversa sem resposta', () => {
  const qty = question('kg', 'Quantos kg vc recebeu?', 'quantity');
  const result = tryHeuristicQuestionnaireCapture({
    questions: [qty],
    missing: [qty],
    alreadySaved: [],
    media: textMedia('Amanhã a vértice estará aberta?'),
    inbound: 'Amanhã a vértice estará aberta?',
    contactName: 'Cleiton',
  });
  assert.equal(result, null);
});
