import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDefaultValues } from './questionnaires.js';

test('normaliza valores padrão RFQ e ignora campos inválidos', () => {
  assert.deepEqual(
    normalizeDefaultValues({
      unit_price: ' R$ 12,50 ',
      products: '',
      inventado: 'x',
      vendor: 'Vértice',
    }),
    { unit_price: 'R$ 12,50', vendor: 'Vértice' },
  );
  assert.deepEqual(normalizeDefaultValues('{"taxes":"0","unit_price":"10"}'), {
    taxes: '0',
    unit_price: '10',
  });
  assert.deepEqual(normalizeDefaultValues('nao-json'), {});
});
