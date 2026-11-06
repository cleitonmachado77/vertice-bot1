import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFormsBotQuestions } from './forms-bot.js';
import { FARDO_SALE_FIELD } from './forms-bot-fields.js';
import { FARDO_DELIVERY_PRESET_ID, FARDO_SALE_QUESTION, interpretFardoSales, salesInStock } from './fardo-sale.js';
import type { FormPreset } from './forms-presets.js';

test('pts 87 kg vende um fardo que já existe, com o peso pesado', () => {
  const one = interpretFardoSales('pts 87 kg');
  assert.deepEqual(one.unknown, []);
  assert.deepEqual(one.understood, [{ code: 'PTS', name: 'PLASTICO SECO', fardos: '1', weight: '87' }]);

  const spoken = interpretFardoSales('1 fardo de plastico seco 87,5 kg');
  assert.equal(spoken.understood[0]?.code, 'PTS');
  assert.equal(spoken.understood[0]?.weight, '87.5');

  const two = interpretFardoSales('pts 87 kg, lat 12 kg');
  assert.deepEqual(
    two.understood.map((item) => `${item.fardos} ${item.code} ${item.weight}`),
    ['1 PTS 87', '1 LAT 12'],
  );

  const vague = interpretFardoSales('pet 10 kg');
  assert.equal(vague.understood.length, 0);
  assert.match(vague.unknown[0], /PTB/);
});

test('sem estoque o fardo não entra na venda', () => {
  const sales = interpretFardoSales('pts 87 kg, lat 12 kg').understood;
  const checked = salesInStock(sales, new Map([['PTS', 1]]));
  assert.deepEqual(checked.available.map((item) => item.code), ['PTS']);
  assert.match(checked.missing[0], /LAT/);
  assert.match(checked.missing[0], /não há fardo/);
});

test('entrega de fardos pergunta o cliente e o peso do fardo em estoque', () => {
  const built = buildFormsBotQuestions({
    id: FARDO_DELIVERY_PRESET_ID,
    kind: 'sale',
    name: 'Entrega de Fardos',
    header: { customer: '' },
    lines: [],
    visible: { title: true, status: false, header: ['customer'], lines: ['product', 'quantity', 'uom'] },
  } as FormPreset);
  assert.deepEqual(
    built.questions.map((item) => item.exportField),
    ['customer', FARDO_SALE_FIELD],
  );
  assert.equal(built.questions[1].body, FARDO_SALE_QUESTION);
});
