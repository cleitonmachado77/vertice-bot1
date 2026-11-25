import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDaysIso,
  assertCanDeliver,
  assertHarvestCoversDeliveries,
  deliveryTotal,
  deriveHarvestEstimates,
  derivePlantingForecast,
  harvestCurveWeight,
  isoDateWithinWindow,
  stockDelta,
  assertDateNotFuture,
  parseIsoDate,
  parseMoney,
  parseOptionalDate,
  parseQuantity,
  statusAfterHarvest,
  statusAfterHarvestRemoval,
} from './agro-rules.js';

test('datas e quantidades do ciclo agrícola aceitam o formato usado na tela', () => {
  assert.equal(parseIsoDate('2026-11-12'), '2026-11-12');
  assert.equal(parseOptionalDate(''), null);
  assert.equal(parseQuantity('1.250,5'), 1250.5);
  assert.equal(parseQuantity('10.5'), 10.5);
  assert.equal(parseMoney('1.234,50'), 1234.5);
  assert.equal(parseMoney(''), null);
  assert.equal(deliveryTotal(10, 2.5), 25);
  assert.equal(deliveryTotal(10, null), null);
  assert.equal(stockDelta(40, 55), 15);
  assert.equal(stockDelta(40, 25), -15);
  assert.equal(stockDelta(10, 10), 0);
  assert.throws(() => parseIsoDate('2026-02-31'), /data válida/);
  assert.throws(() => parseQuantity('0', 'Área planejada'), /maior que zero/);
  assert.equal(assertDateNotFuture('2026-11-12', '2026-11-12', 'Data do plantio'), '2026-11-12');
  assert.throws(() => assertDateNotFuture('2026-11-13', '2026-11-12', 'Data do plantio'), /não pode ser futura/);
});

test('entrega só sai da quantidade já colhida', () => {
  assert.throws(() => assertCanDeliver(0, 0, 1), /colheita antes/);
  assert.throws(() => assertCanDeliver(10, 5, 6), /passa do que foi colhido/);
  assert.doesNotThrow(() => assertCanDeliver(10.5, 10.2, 0.3));
  assert.throws(() => assertHarvestCoversDeliveries(4, 5), /já entregue/);
});

test('o status do plantio acompanha a colheita', () => {
  assert.equal(statusAfterHarvest(false), 'em_colheita');
  assert.equal(statusAfterHarvest(true), 'colhido');
  assert.equal(statusAfterHarvestRemoval(0, 'em_colheita'), 'planejado');
  assert.equal(statusAfterHarvestRemoval(2, 'colhido'), 'colhido');
  assert.equal(statusAfterHarvestRemoval(1, 'em_colheita'), 'em_colheita');
});

test('previsão e estimativa saem dos parâmetros do produto', () => {
  assert.equal(addDaysIso('2026-11-09', 105), '2027-02-22');
  assert.deepEqual(
    derivePlantingForecast({ plantedOn: '2026-11-09', areaHa: 1.5, cycleDays: 105, yieldPerHa: 500 }),
    {
      forecastOn: '2027-02-22',
      forecastQty: 750,
      estimates: [{ index: 1, forecastOn: '2027-02-22', estimatedQty: 750, weight: 1 }],
    },
  );
  assert.deepEqual(
    derivePlantingForecast({ plantedOn: '2026-11-09', areaHa: 1.5, cycleDays: null, yieldPerHa: null }),
    { forecastOn: null, forecastQty: null, estimates: [] },
  );
});

test('curva de colheita espelha a planilha (pesos e datas)', () => {
  assert.equal(harvestCurveWeight(1, 4, 'Decrescente', 1), 8);
  assert.equal(harvestCurveWeight(4, 4, 'Decrescente', 1), 5);
  assert.equal(harvestCurveWeight(1, 4, 'Crescente', 1), 1);
  assert.equal(harvestCurveWeight(4, 4, 'Crescente', 1), 4);
  assert.equal(harvestCurveWeight(2, 4, 'Pico no meio', 1), 2);
  assert.equal(harvestCurveWeight(1, 4, 'Uniforme', 2), 1);

  const lines = deriveHarvestEstimates({
    plantedOn: '2026-01-01',
    areaHa: 0.01,
    cycleDays: 45,
    yieldPerHa: 12300,
    harvestCount: 4,
    harvestIntervalDays: 25,
    harvestCurve: 'Decrescente',
    curveIntensity: 1,
  });
  assert.equal(lines.length, 4);
  assert.equal(lines[0].forecastOn, '2026-02-15');
  assert.equal(lines[1].forecastOn, '2026-03-12');
  assert.equal(lines[3].forecastOn, '2026-05-01');
  const total = Math.round(lines.reduce((sum, line) => sum + line.estimatedQty, 0) * 1000) / 1000;
  assert.equal(total, 123);
  assert.ok(lines[0].estimatedQty > lines[3].estimatedQty);
  assert.equal(isoDateWithinWindow('2026-03-10', '2026-03-12', 30), true);
  assert.equal(isoDateWithinWindow('2026-05-01', '2026-03-12', 30), false);
});
