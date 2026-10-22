import assert from 'node:assert/strict';
import test from 'node:test';
import { FORMS_BOT_LINES_FIELD, buildFormsBotQuestions } from './forms-bot.js';
import type { FormPreset } from './forms-presets.js';

function preset(partial: Partial<FormPreset> & Pick<FormPreset, 'kind'>): FormPreset {
  return {
    id: 'p1',
    company_odoo_id: '1',
    name: 'Teste',
    title: '',
    status: 'draft',
    header: {},
    lines: [],
    visible: { title: true, status: true, header: [], lines: [] },
    bot_enabled: true,
    bot_frequency: 'daily',
    bot_weekday: 1,
    bot_send_time: '08:00',
    bot_template_id: '',
    bot_contact_id: '',
    sort_order: 0,
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

test('buildFormsBotQuestions gera header e bloco de linhas', () => {
  const built = buildFormsBotQuestions(
    preset({
      kind: 'purchase',
      visible: {
        title: true,
        status: false,
        header: ['vendor', 'order_deadline'],
        lines: ['product', 'quantity', 'unit_price'],
      },
    }),
  );
  assert.equal(built.questions.length, 4);
  assert.equal(built.questions[0].exportField, 'vendor');
  assert.equal(built.questions[1].exportField, 'order_deadline');
  assert.equal(built.questions[2].exportField, FORMS_BOT_LINES_FIELD);
  assert.equal(built.questions[3].exportField, '__lines_more__');
});

test('buildFormsBotQuestions pula campos com valor padrão', () => {
  const built = buildFormsBotQuestions(
    preset({
      kind: 'product',
      header: { name: 'Cenoura', category: '' },
      visible: {
        title: true,
        status: false,
        header: ['name', 'category', 'sales_price'],
        lines: [],
      },
    }),
  );
  assert.deepEqual(
    built.questions.map((item) => item.exportField),
    ['category', 'sales_price'],
  );
  assert.equal(built.defaultValues.name, 'Cenoura');
});

test('buildFormsBotQuestions pergunta linhas quando quantidade visível está vazia', () => {
  const built = buildFormsBotQuestions(
    preset({
      kind: 'purchase',
      header: {},
      lines: [{ values: { product: 'ABACATE - KG', quantity: '', unit_price: '15.5' } }],
      visible: {
        title: false,
        status: false,
        header: ['vendor'],
        lines: ['quantity'],
      },
    }),
  );
  assert.deepEqual(
    built.questions.map((item) => item.exportField),
    ['vendor', FORMS_BOT_LINES_FIELD, '__lines_more__'],
  );
  assert.match(built.questions[1].body, /Qtd de ABACATE/i);
  assert.equal(built.questions[1].fixedValue, 'ABACATE - KG');
  assert.match(built.questions[2].body, /Mais produtos/i);
});

test('produto visível no padrão não fica fixo na pergunta de linhas', () => {
  const built = buildFormsBotQuestions(
    preset({
      kind: 'purchase',
      lines: [{ values: { product: 'ABACATE - KG', quantity: '' } }],
      visible: { title: false, status: false, header: [], lines: ['product', 'quantity'] },
    }),
  );
  assert.equal(built.questions[0].exportField, FORMS_BOT_LINES_FIELD);
  assert.equal(built.questions[0].fixedValue, '');
});
