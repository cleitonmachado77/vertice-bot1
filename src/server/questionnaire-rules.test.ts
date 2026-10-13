import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coversQuestions,
  isFullyAnswered,
  isNonAnswerText,
  looksLikeQuestionnaireAnswer,
  looksLikeQuestionnaireEdit,
  relativeOccurrenceDate,
} from './questionnaire-rules.js';
import type { CycleAnswer } from './questionnaire-cycles.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

const questions: QuestionnaireQuestion[] = [
  {
    id: 'supplier',
    questionnaire_id: 'q1',
    body: 'Quem foi o fornecedor de hoje?',
    expected_type: 'text',
    export_field: 'supplier',
    sort_order: 0,
  },
  {
    id: 'quantity',
    questionnaire_id: 'q1',
    body: 'Qual foi a quantidade recebida?',
    expected_type: 'text',
    export_field: 'quantity',
    sort_order: 1,
  },
];

test('conversa comum não é tratada como edição de ciclo concluído', () => {
  assert.equal(looksLikeQuestionnaireEdit('text', 'qual é o horário de atendimento?'), false);
  assert.equal(looksLikeQuestionnaireEdit('text', 'na verdade foram 135 kg'), true);
  assert.equal(looksLikeQuestionnaireEdit('text', 'apague a resposta de ontem'), true);
});

test('respostas negativas são conteúdo válido', () => {
  for (const value of ['nenhum', 'nada', 'sem entregas', 'n/a']) {
    assert.equal(isNonAnswerText(value), false);
    assert.equal(looksLikeQuestionnaireAnswer('text', value), true);
  }
  assert.equal(isNonAnswerText('---'), true);
});

test('uma lista só cobre o questionário quando contém todas as perguntas', () => {
  assert.equal(coversQuestions('Quem foi o fornecedor de hoje?', questions), false);
  assert.equal(
    coversQuestions(
      '1) Quem foi o fornecedor de hoje?\n2) Qual foi a quantidade recebida?',
      questions,
    ),
    true,
  );
});

test('conclusão exige resposta persistida para toda pergunta', () => {
  const oneAnswer: CycleAnswer[] = [
    {
      id: 'a1',
      cycle_id: 'c1',
      question_id: 'supplier',
      answer_text: 'Ademir',
      answer_type: 'text',
      media_url: '',
    },
  ];
  assert.equal(isFullyAnswered(questions, oneAnswer), false);
  assert.equal(
    isFullyAnswered(questions, [
      ...oneAnswer,
      {
        id: 'a2',
        cycle_id: 'c1',
        question_id: 'quantity',
        answer_text: '135 kg',
        answer_type: 'text',
        media_url: '',
      },
    ]),
    true,
  );
});

test('referências relativas selecionam a data do ciclo corretamente', () => {
  assert.equal(relativeOccurrenceDate('2026-10-13', 'corrija o valor de ontem'), '2026-10-12');
  assert.equal(relativeOccurrenceDate('2026-10-13', 'foi anteontem'), '2026-10-11');
  assert.equal(relativeOccurrenceDate('2026-10-13', 'corrija o valor'), '2026-10-13');
});
