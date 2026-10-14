import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatBrDate,
  parseOccurrenceDateRef,
  relativeOccurrenceDate,
  temporalRelation,
  weekdayFromIsoDate,
} from './questionnaire-dates.js';

const TODAY = '2026-10-14'; // quarta-feira

test('passado, presente e futuro relativos', () => {
  assert.equal(relativeOccurrenceDate(TODAY, 'corrija o valor de ontem'), '2026-10-13');
  assert.equal(relativeOccurrenceDate(TODAY, 'foi anteontem'), '2026-10-12');
  assert.equal(relativeOccurrenceDate(TODAY, 'registra pra hoje'), '2026-10-14');
  assert.equal(
    relativeOccurrenceDate(TODAY, 'Certo, amanhã vou receber 20 kg de plástico'),
    '2026-10-15',
  );
  assert.equal(relativeOccurrenceDate(TODAY, 'depois de amanhã chega'), '2026-10-16');
  assert.equal(relativeOccurrenceDate(TODAY, 'após amanhã são 10 kg'), '2026-10-16');
  assert.equal(relativeOccurrenceDate(TODAY, 'sem referência de dia'), '2026-10-14');
});

test('datas absolutas e dias da semana', () => {
  assert.equal(relativeOccurrenceDate(TODAY, 'anota pro dia 15/10'), '2026-10-15');
  assert.equal(relativeOccurrenceDate(TODAY, 'foi em 12/10/2026'), '2026-10-12');
  assert.equal(relativeOccurrenceDate(TODAY, 'para 2026-10-16'), '2026-10-16');
  assert.equal(relativeOccurrenceDate(TODAY, 'na sexta vou receber 10 kg'), '2026-10-16');
  assert.equal(relativeOccurrenceDate(TODAY, 'na próxima quarta'), '2026-10-21');
  assert.equal(relativeOccurrenceDate(TODAY, 'na segunda passada'), '2026-10-12');
  assert.equal(relativeOccurrenceDate(TODAY, 'ainda nesta quarta'), '2026-10-14');
});

test('parseOccurrenceDateRef classifica relação temporal', () => {
  const past = parseOccurrenceDateRef(TODAY, 'ontem foram 50 kg');
  assert.equal(past.date, '2026-10-13');
  assert.equal(past.explicit, true);
  assert.equal(past.relation, 'past');

  const present = parseOccurrenceDateRef(TODAY, 'hoje recebi alumínio');
  assert.equal(present.date, TODAY);
  assert.equal(present.explicit, true);
  assert.equal(present.relation, 'present');

  const future = parseOccurrenceDateRef(TODAY, 'amanhã 20 kg de plástico');
  assert.equal(future.date, '2026-10-15');
  assert.equal(future.relation, 'future');
  assert.equal(future.label, 'amanhã');

  const none = parseOccurrenceDateRef(TODAY, 'recebi 20 kg');
  assert.equal(none.explicit, false);
  assert.equal(none.relation, 'present');
});

test('helpers de calendário', () => {
  assert.equal(weekdayFromIsoDate(TODAY), 3);
  assert.equal(weekdayFromIsoDate('2026-10-15'), 4);
  assert.equal(formatBrDate(TODAY), '14/10/2026');
  assert.equal(temporalRelation(TODAY, '2026-10-13'), 'past');
  assert.equal(temporalRelation(TODAY, TODAY), 'present');
  assert.equal(temporalRelation(TODAY, '2026-10-15'), 'future');
});
