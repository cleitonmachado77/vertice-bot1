import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFormsBotQuestions } from './forms-bot.js';
import { tryFormsBotCapture } from './forms-bot-capture.js';
import { FARDO_ENTREGA_FIELD } from './forms-bot-fields.js';
import {
  FARDO_ENTREGA_PRESET_ID,
  FARDO_ENTREGA_QUESTION,
  interpretFardoEntregas,
  isFardoEntregaPreset,
} from './fardo-entrega.js';
import type { FormPreset } from './forms-presets.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

test('3 pts e 3 fardos pts registram a mesma quantidade de fardo', () => {
  const short = interpretFardoEntregas('3 pts');
  assert.deepEqual(short.unknown, []);
  assert.deepEqual(short.understood, [
    { code: 'PTS', name: 'PLASTICO SECO', category: 'Plástico', quantity: '3' },
  ]);

  const spoken = interpretFardoEntregas('3 fardos de pts');
  assert.equal(spoken.understood[0]?.code, 'PTS');
  assert.equal(spoken.understood[0]?.quantity, '3');

  const many = interpretFardoEntregas('2 lat, 1 pap');
  assert.deepEqual(
    many.understood.map((item) => `${item.quantity} ${item.code}`),
    ['2 LAT', '1 PAP'],
  );
});

test('entrega de fardos é production e pergunta só quantidade e tipo', () => {
  assert.equal(
    isFardoEntregaPreset({ id: FARDO_ENTREGA_PRESET_ID, kind: 'production', name: 'Entrega de Fardos' }),
    true,
  );
  assert.equal(
    isFardoEntregaPreset({ id: 'x', kind: 'sale', name: 'Entrega de Fardos' }),
    false,
  );

  const built = buildFormsBotQuestions({
    id: FARDO_ENTREGA_PRESET_ID,
    kind: 'production',
    name: 'Entrega de Fardos',
    header: {},
    lines: [],
    visible: { title: true, status: false, header: [], lines: [] },
  } as FormPreset);
  assert.deepEqual(
    built.questions.map((item) => item.exportField),
    [FARDO_ENTREGA_FIELD],
  );
  assert.equal(built.questions[0].body, FARDO_ENTREGA_QUESTION);
  assert.equal(built.defaultValues.input_product, 'Fardo');
});

test('o bot da entrega de fardos guarda quantidade e tipo', async () => {
  const question: QuestionnaireQuestion = {
    id: 'q1',
    questionnaire_id: `forms-preset:${FARDO_ENTREGA_PRESET_ID}`,
    body: FARDO_ENTREGA_QUESTION,
    expected_type: 'any',
    export_field: FARDO_ENTREGA_FIELD,
    sort_order: 0,
    fixed_value: '',
  };
  const questionnaire = {
    id: question.questionnaire_id,
    sourcePresetId: FARDO_ENTREGA_PRESET_ID,
    questions: [question],
  } as Questionnaire;

  const ok = await tryFormsBotCapture({
    inbound: '3 pts',
    questionnaire,
    questions: [question],
    alreadySaved: [],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(ok?.kind, 'answers');
  if (ok?.kind !== 'answers') return;
  assert.equal(ok.detail, 'entrega de fardos');
  assert.deepEqual(JSON.parse(ok.accepted[0].text), [{ code: 'PTS', quantity: '3' }]);
});
