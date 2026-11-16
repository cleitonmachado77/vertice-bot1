import assert from 'node:assert/strict';
import test from 'node:test';
import { separationFromInventory } from './hub-dashboard.js';

test('separação soma a quantidade contada no inventário, no dia de São Paulo', () => {
  const section = separationFromInventory(
    [
      {
        header: { bag_type: 'CRI', bag_type_name: 'CRISTAL', counted_qty: '6', qty_on_hand: '6' },
        created_at: '2026-11-13T20:58:26.439Z',
      },
      {
        header: { bag_type: 'PAP', bag_type_name: 'PAPELAO', counted_qty: '12' },
        created_at: '2026-11-14T01:30:00.000Z',
      },
      {
        header: { bag_type: 'FER', bag_type_name: 'SUCATA DE FERRO', counted_qty: '1' },
        created_at: '2026-10-15T15:00:00.000Z',
      },
      {
        header: { name: 'Bag', qty_on_hand: '46' },
        created_at: '2026-11-13T20:58:26.439Z',
      },
    ],
    2026,
    11,
  );

  assert.equal(section.total, 18);
  assert.equal(section.unit, 'Bag');
  assert.deepEqual(section.products, ['CRI CRISTAL', 'PAP PAPELAO']);
  assert.equal(section.daily[12]?.value, 18);
  assert.equal(section.dailyStacked?.[12]?.byProduct['CRI CRISTAL'], 6);
  assert.equal(section.dailyStacked?.[12]?.byProduct['PAP PAPELAO'], 12);
});
