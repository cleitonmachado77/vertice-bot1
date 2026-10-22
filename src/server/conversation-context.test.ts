import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextBrief,
  buildConversationHints,
  detectLikelyQuestionnaireAck,
  isShortAck,
  looksLikeQuestionnaireInvite,
  pendingDaysFromCycles,
  pendingPreviousDaysNotice,
} from './conversation-context.js';
import type { ActiveCycleContext } from './questionnaire-cycles.js';
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

function fakeCycle(
  date: string,
  status: string,
  missingAll = true,
  promptedAt = '',
): ActiveCycleContext {
  const answers = missingAll
    ? []
    : [
        {
          id: 'a1',
          cycle_id: 'c1',
          question_id: 'kg',
          answer_text: '10',
          answer_type: 'text',
          media_url: '',
        },
      ];
  const answered = new Set(answers.map((row) => row.question_id));
  return {
    cycle: {
      id: `cycle-${date}`,
      questionnaire_id: 'q1',
      contact_id: 'contact',
      revision_id: 'rev',
      occurrence_date: date,
      status: status as ActiveCycleContext['cycle']['status'],
      template_sent_at: promptedAt,
      completed_at: '',
      error: '',
      last_prompted_at: promptedAt,
      last_inbound_at: '',
    },
    questionnaire: {
      id: 'q1',
      name: 'Teste 1',
      greeting: '',
      frequency: 'daily',
      weekday: 1,
      send_time: '09:00',
      active: 1,
      template_id: '',
      version: 1,
      created_at: '',
      updated_at: '',
      defaultValues: {},
      sourcePresetId: '',
      formKind: '',
      companyOdooId: '',
      contactIds: [],
      questions,
    },
    answers,
    missing: questions.filter((q) => !answered.has(q.id)),
  };
}

test('isShortAck reconhece confirmações curtas', () => {
  assert.equal(isShortAck('Ok'), true);
  assert.equal(isShortAck('sim'), true);
  assert.equal(isShortAck('pode'), true);
  assert.equal(isShortAck('certo'), true);
  assert.equal(isShortAck('obrigado, tchau'), false);
  assert.equal(isShortAck('recebi 10 kg de plástico'), false);
});

test('looksLikeQuestionnaireInvite detecta convite', () => {
  assert.equal(
    looksLikeQuestionnaireInvite(
      'Oi Cleiton Machado! Aqui é a Vértice. Pode responder o questionário de acompanhamento?',
    ),
    true,
  );
  assert.equal(
    looksLikeQuestionnaireInvite(
      'Olá Cleiton Machado aqui é a Vertice, responda essa mensagem para iniciarmos seu atendimento.',
    ),
    true,
  );
  assert.equal(looksLikeQuestionnaireInvite('Bom dia, tudo bem?'), false);
});

test('detectLikelyQuestionnaireAck — cenário Cleiton', () => {
  const history = [
    {
      direction: 'OUTBOUND',
      text: 'Oi Cleiton Machado! Aqui é a Vértice. Pode responder o questionário de acompanhamento?',
    },
  ];
  assert.equal(detectLikelyQuestionnaireAck(history, 'Ok'), true);
  assert.equal(detectLikelyQuestionnaireAck(history, 'obrigado, tchau'), false);
  assert.equal(
    detectLikelyQuestionnaireAck(
      [{ direction: 'OUTBOUND', text: 'Perfeito! Anotei tudo, obrigado.' }],
      'Ok',
    ),
    false,
  );
});

test('pendingDaysFromCycles lista dias anteriores incompletos', () => {
  const cycles = [
    fakeCycle('2026-10-19', 'open'),
    fakeCycle('2026-10-18', 'notified', true, '2026-10-18T23:53:23.619Z'),
    fakeCycle('2026-10-17', 'notified', true, '2026-10-17T23:53:23.656Z'),
  ];
  const pending = pendingDaysFromCycles(cycles, '2026-10-19');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].date, '2026-10-18');
  assert.equal(pending[1].date, '2026-10-17');
  const notice = pendingPreviousDaysNotice({
    likelyQuestionnaireAck: true,
    hasPendingQuestionnaire: true,
    pendingPreviousDays: pending,
  });
  assert.match(notice, /18\/10\/2026/);
  assert.match(notice, /17\/10\/2026/);
});

test('buildConversationHints e contextBrief incluem hint de ack', () => {
  const history = [
    {
      direction: 'OUTBOUND',
      text: 'Oi Cleiton! Pode responder o questionário de acompanhamento?',
    },
  ];
  const pendingCycles = [
    fakeCycle('2026-10-19', 'open'),
    fakeCycle('2026-10-18', 'notified', true, '2026-10-18T23:53:23.619Z'),
  ];
  const hints = buildConversationHints({
    history,
    inbound: 'Ok',
    today: '2026-10-19',
    pendingCycles,
  });
  assert.equal(hints.likelyQuestionnaireAck, true);
  assert.equal(hints.hasPendingQuestionnaire, true);
  assert.equal(hints.pendingPreviousDays.length, 1);

  const brief = buildContextBrief({
    today: '2026-10-19',
    history,
    pendingCycles,
    hints,
  });
  assert.match(brief, /confirmação curta/i);
  assert.match(brief, /18\/10\/2026/);
  assert.match(brief, /dias anteriores ainda incompletos/i);
});

test('encerramento real não gera likelyQuestionnaireAck', () => {
  const hints = buildConversationHints({
    history: [
      { direction: 'OUTBOUND', text: 'Perfeito, Cleiton! Anotei tudo, obrigado.' },
      { direction: 'INBOUND', text: 'Valeu' },
    ],
    inbound: 'obrigado, tchau',
    today: '2026-10-19',
    pendingCycles: [],
  });
  assert.equal(hints.likelyQuestionnaireAck, false);
  assert.equal(hints.hasPendingQuestionnaire, false);
  assert.equal(hints.pendingPreviousDays.length, 0);
});
