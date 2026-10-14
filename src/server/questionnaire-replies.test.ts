import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimsCompleteWhileIncomplete,
  ensureMissingAsked,
} from './questionnaire-replies.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const questions: QuestionnaireQuestion[] = [
  {
    id: 'kg',
    questionnaire_id: 'q1',
    body: 'Quantos kg vc recebeu?',
    expected_type: 'any',
    export_field: 'quantity',
    sort_order: 0,
  },
  {
    id: 'produto',
    questionnaire_id: 'q1',
    body: 'Qual produto vc recebeu?',
    expected_type: 'any',
    export_field: 'products',
    sort_order: 1,
  },
];

const media = {
  type: 'text',
  summary: '',
  transcript: '',
  caption: '',
  mediaUrl: '',
  understood: true,
};

test('ensureMissingAsked mantém reply natural da IA', () => {
  const reply = ensureMissingAsked({
    reply: 'Beleza, anotei os 10 kg. Qual produto você recebeu?',
    missing: [questions[1]],
    answers: [],
    media,
    contactName: 'Cleiton',
    questions,
  });
  assert.equal(reply, 'Beleza, anotei os 10 kg. Qual produto você recebeu?');
});

test('ensureMissingAsked só usa template se reply vazia ou fingir conclusão', () => {
  const saved = [
    {
      id: 'a1',
      cycle_id: 'c1',
      question_id: 'kg',
      answer_text: '10 kg',
      answer_type: 'text',
      media_url: '',
    },
  ];
  const empty = ensureMissingAsked({
    reply: '   ',
    missing: [questions[1]],
    answers: saved,
    media,
    contactName: 'Cleiton',
    questions,
  });
  assert.match(empty, /ainda falta/i);
  assert.match(empty, /produto/i);

  const fakeDone = ensureMissingAsked({
    reply: 'Perfeito! Anotei tudo, obrigado.',
    missing: [questions[1]],
    answers: saved,
    media,
    contactName: 'Cleiton',
    questions,
  });
  assert.match(fakeDone, /ainda falta/i);
});

test('claimsCompleteWhileIncomplete ignora quando ainda pede mais', () => {
  assert.equal(claimsCompleteWhileIncomplete('Anotei tudo'), true);
  assert.equal(
    claimsCompleteWhileIncomplete('Anotei os kg. Ainda falta o produto.'),
    false,
  );
});
