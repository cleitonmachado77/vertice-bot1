import assert from 'node:assert/strict';
import test from 'node:test';
import { tryFormsBotCapture } from './forms-bot-capture.js';
import { FARDO_PRODUCTION_PRESET_ID, interpretFardoRuns } from './fardo-counts.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

test('10 bags de pts viram 1 fardo de pts, no mesmo tipo', () => {
  const spoken = interpretFardoRuns('10 bags de pts seram produzidos 1 fardo de pts');
  assert.deepEqual(spoken.unknown, []);
  assert.deepEqual(spoken.understood, [{ code: 'PTS', name: 'PLASTICO SECO', bags: '10', fardos: '1' }]);

  const short = interpretFardoRuns('10 pts, 1 fardo');
  assert.deepEqual(short.understood.map((item) => item.code), ['PTS']);
  assert.equal(short.understood[0].fardos, '1');

  const named = interpretFardoRuns('10 plastico seco, 1 fardo');
  assert.equal(named.understood[0]?.code, 'PTS');

  const two = interpretFardoRuns('10 pts, 1 fardo; 20 lat, 2 fardos');
  assert.deepEqual(
    two.understood.map((item) => `${item.bags} ${item.code} → ${item.fardos}`),
    ['10 PTS → 1', '20 LAT → 2'],
  );
});

test('tipo diferente ou desconhecido não fecha a produção', () => {
  const other = interpretFardoRuns('10 pts, 1 fardo de lat');
  assert.equal(other.understood.length, 0);
  assert.match(other.unknown[0], /mesmo tipo/);

  const vague = interpretFardoRuns('10 pet, 1 fardo');
  assert.equal(vague.understood.length, 0);
  assert.match(vague.unknown[0], /PTB/);
});

test('o bot da produção de fardos guarda o par e pede correção do que falhou', async () => {
  const question: QuestionnaireQuestion = {
    id: 'q1',
    questionnaire_id: `forms-preset:${FARDO_PRODUCTION_PRESET_ID}`,
    body: 'Quantos bags de qual tipo viraram quantos fardos? (ex.: 10 pts, 1 fardo)',
    expected_type: 'any',
    export_field: 'fardo_run',
    sort_order: 0,
    fixed_value: '',
  };
  const questionnaire = {
    id: question.questionnaire_id,
    sourcePresetId: FARDO_PRODUCTION_PRESET_ID,
    questions: [question],
  } as Questionnaire;

  const partial = await tryFormsBotCapture({
    inbound: '10 pts, 1 fardo, 4 batata',
    questionnaire,
    questions: [question],
    alreadySaved: [],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(partial?.kind, 'answers');
  if (partial?.kind !== 'answers') return;
  assert.equal(partial.detail, 'produção de fardos parcial');
  assert.match(partial.summary, /10 bags PTS/);
  assert.match(partial.summary, /4 batata/);

  const fixed = await tryFormsBotCapture({
    inbound: '20 latinha, 2 fardos',
    questionnaire,
    questions: [question],
    alreadySaved: [
      {
        id: 'a1',
        cycle_id: 'c1',
        question_id: 'q1',
        answer_text: partial.accepted[0].text,
        answer_type: 'text',
        media_url: '',
      },
    ],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(fixed?.kind, 'answers');
  if (fixed?.kind !== 'answers') return;
  assert.equal(fixed.detail, 'produção de fardos');
  assert.deepEqual(JSON.parse(fixed.accepted[0].text), [
    { code: 'PTS', bags: '10', fardos: '1' },
    { code: 'LAT', bags: '20', fardos: '2' },
  ]);
});
