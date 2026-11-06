import assert from 'node:assert/strict';
import test from 'node:test';
import { BAG_MATERIALS, BAG_SEPARATION_PRESET_ID, interpretBagCounts, parseBagCounts } from './bag-materials.js';
import { tryFormsBotCapture } from './forms-bot-capture.js';
import type { Questionnaire, QuestionnaireQuestion } from './questionnaires.js';

test('as 27 siglas são únicas e têm 2 ou 3 letras', () => {
  const codes = BAG_MATERIALS.map((item) => item.code);
  assert.equal(new Set(codes).size, 27);
  assert.equal(codes.length, 27);
  assert.ok(codes.every((code) => /^[A-Z]{2,3}$/.test(code)));
  assert.equal(BAG_MATERIALS.find((item) => item.name === 'PLASTICO SECO')?.code, 'PTS');
});

test('50 pts e vários itens', () => {
  const one = parseBagCounts('50 pts');
  assert.equal(one.ok, true);
  if (!one.ok) return;
  assert.deepEqual(one.items, [
    { code: 'PTS', name: 'PLASTICO SECO', category: 'Plástico', quantity: '50' },
  ]);

  const many = parseBagCounts('50 PTS, 20 lat');
  assert.equal(many.ok, true);
  if (!many.ok) return;
  assert.deepEqual(
    many.items.map((item) => `${item.quantity} ${item.code}`),
    ['50 PTS', '20 LAT'],
  );
});

test('sem sigla, sigla desconhecida ou peso não entram', () => {
  assert.equal(parseBagCounts('50').ok, false);
  assert.equal(parseBagCounts('pts').ok, false);
  assert.equal(parseBagCounts('50 kg').ok, false);
  assert.equal(parseBagCounts('50 plastico').ok, false);
});

test('nome do material vale como o tipo, e o trecho duvidoso fica de fora', () => {
  const named = interpretBagCounts('50 plástico seco, 20 latinha');
  assert.deepEqual(
    named.understood.map((item) => `${item.quantity} ${item.code}`),
    ['50 PTS', '20 LAT'],
  );
  assert.deepEqual(named.unknown, []);

  const partial = interpretBagCounts('50 pts, 10 batata');
  assert.deepEqual(partial.understood.map((item) => item.code), ['PTS']);
  assert.deepEqual(partial.unknown, ['10 batata']);

  const vague = interpretBagCounts('50 pet');
  assert.equal(vague.understood.length, 0);
  assert.match(vague.unknown[0], /PTB/);
  assert.match(vague.unknown[0], /PTV/);
});

test('o bot da separação grava a sigla e recusa texto fora do padrão', async () => {
  const question: QuestionnaireQuestion = {
    id: 'q1',
    questionnaire_id: `forms-preset:${BAG_SEPARATION_PRESET_ID}`,
    body: 'Quantidade e sigla (ex.: 50 pts)',
    expected_type: 'any',
    export_field: 'qty_on_hand',
    sort_order: 0,
    fixed_value: '',
  };
  const questionnaire = {
    id: question.questionnaire_id,
    sourcePresetId: BAG_SEPARATION_PRESET_ID,
    questions: [question],
  } as Questionnaire;

  const accepted = await tryFormsBotCapture({
    inbound: '50 pts',
    questionnaire,
    questions: [question],
    alreadySaved: [],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(accepted?.kind, 'answers');
  if (accepted?.kind !== 'answers') return;
  assert.equal(accepted.summary, '50 PTS');
  assert.deepEqual(JSON.parse(accepted.accepted[0].text), [{ code: 'PTS', quantity: '50' }]);

  const rejected = await tryFormsBotCapture({
    inbound: '50',
    questionnaire,
    questions: [question],
    alreadySaved: [],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(rejected?.kind, 'reask');

  const partial = await tryFormsBotCapture({
    inbound: '50 pts, 10 batata',
    questionnaire,
    questions: [question],
    alreadySaved: [],
    history: [],
    pendingQuestionId: 'q1',
  });
  assert.equal(partial?.kind, 'answers');
  if (partial?.kind !== 'answers') return;
  assert.equal(partial.detail, 'separação de bags parcial');
  assert.match(partial.summary, /Entendi/);
  assert.match(partial.summary, /50 PTS/);
  assert.match(partial.summary, /Não entendi/);
  assert.match(partial.summary, /10 batata/);

  const fixed = await tryFormsBotCapture({
    inbound: '10 papelao',
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
  assert.equal(fixed.detail, 'separação de bags');
  assert.deepEqual(JSON.parse(fixed.accepted[0].text), [
    { code: 'PTS', quantity: '50' },
    { code: 'PAP', quantity: '10' },
  ]);
});
