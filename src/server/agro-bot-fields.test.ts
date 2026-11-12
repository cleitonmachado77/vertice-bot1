import assert from 'node:assert/strict';
import test from 'node:test';
import { agroAnswerDate, agroAnswerYes, isAgroBotKind } from './agro-bot-fields.js';
import { buildMainMenu, normalizeMenuForms } from './bot-menu-rules.js';

test('datas do WhatsApp do Agro viram o formato do registro', () => {
  assert.equal(agroAnswerDate('hoje', '2026-11-12'), '2026-11-12');
  assert.equal(agroAnswerDate('12/11/2026', '2026-11-01'), '2026-11-12');
  assert.equal(agroAnswerDate('2026-11-03', '2026-11-01'), '2026-11-03');
  assert.equal(agroAnswerYes('Sim'), true);
  assert.equal(agroAnswerYes('não'), false);
  assert.equal(isAgroBotKind('agro_entrega'), true);
  assert.equal(isAgroBotKind('sale'), false);
});

test('padrão do Agro entra no menu do WhatsApp junto com os formulários', () => {
  const forms = normalizeMenuForms([
    { questionnaire_id: 'forms-preset:p1', name: '[Forms] Compras · Ademir', form_kind: 'purchase' },
    { questionnaire_id: 'agro-preset:a1', name: '[Agro] Plantio · Semana', form_kind: 'agro_plantio' },
  ]);
  const node = buildMainMenu({ forms, cycles: [], attendant: false, title: 'Menu' });
  assert.deepEqual(
    node.options.map((option) => option.label),
    ['Ademir', 'Semana'],
  );
});
