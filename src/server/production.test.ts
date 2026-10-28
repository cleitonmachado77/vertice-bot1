import assert from 'node:assert/strict';
import test from 'node:test';
import { tryFormsLinesCapture } from './forms-bot-capture.js';
import { buildFormsBotQuestions, productionSummaryText } from './forms-bot.js';
import { FORMS_BOT_LINES_FIELD, FORMS_BOT_LINES_MORE_FIELD } from './forms-bot-fields.js';
import { planBotLines } from './forms-bot-lines.js';
import { documentTitle, productionBalance, shouldAutofillFormTitle } from './forms-fields.js';
import type { FormPreset } from './forms-presets.js';
import { convertUom, findUom, splitQuantityUnit, toKg, type UomInfo } from './forms-uom.js';
import type { QuestionnaireQuestion } from './questionnaires.js';

// Fabricação espelhando o Odoo: unidades uom.uom (Bag = 100 KG) e 1 mrp.production com subprodutos.

// Árvores como no Odoo 19 de produção: KG(1) ← Bag(100 KG); g(15) ← kg(1000 g).
const uoms: UomInfo[] = [
  { name: 'KG', rootId: '1', factor: 1 },
  { name: 'Bag', rootId: '1', factor: 100 },
  { name: 'g', rootId: '15', factor: 1 },
  { name: 'kg', rootId: '15', factor: 1000 },
  { name: 'Horas', rootId: '4', factor: 1 },
];
const productUom = new Map([
  ['bag', 'KG'],
  ['fardo pet - kg', 'KG'],
  ['fardo papelão - kg', 'KG'],
]);
const convert = (qty: number, uom: string, product: string) =>
  toKg(qty, uom || productUom.get(product.trim().toLowerCase()) || '', uoms);

const doc = (header: Record<string, string>, lines: Array<Record<string, string>>) => ({
  header,
  lines: lines.map((values) => ({ values })),
});

test('unidades do Odoo: Bag = 100 KG, plural aceito, árvores diferentes não convertem', () => {
  assert.equal(findUom(uoms, 'bags')?.name, 'Bag');
  assert.equal(convertUom(2, findUom(uoms, 'Bag')!, findUom(uoms, 'KG')!), 200);
  assert.equal(toKg(2, 'Bag', uoms), 200);
  assert.equal(toKg(500, 'g', uoms), 0.5);
  assert.equal(toKg(3, 'Horas', uoms), null);
  assert.equal(toKg(1, 'Tonel', uoms), null);
});

test('“10 bags” / “120 kg” / “12” / “3 caixas”', () => {
  assert.deepEqual(splitQuantityUnit('10 bags'), { quantity: '10', uom: 'Bag' });
  assert.deepEqual(splitQuantityUnit('120 kg'), { quantity: '120', uom: 'KG' });
  assert.deepEqual(splitQuantityUnit('12'), { quantity: '12', uom: '' });
  assert.deepEqual(splitQuantityUnit('3 caixas'), { quantity: '3', uom: 'Caixa' });
  assert.deepEqual(splitQuantityUnit('1,5 kg'), { quantity: '1.5', uom: 'KG' });
});

test('balanço da ordem: componente em Bag, principal + subproduto, perda e divisão de custo', () => {
  const balance = productionBalance(
    doc({ input_product: 'Bag', input_qty: '2', input_uom: 'Bag' }, [
      { product: 'FARDO PET - KG', quantity: '120', uom: '' },
      { product: 'FARDO PAPELÃO - KG', quantity: '60', uom: 'KG' },
    ]),
    convert,
  );
  assert.equal(balance.inputKg, 200);
  assert.equal(balance.outputKg, 180);
  assert.equal(balance.lossKg, 20);
  assert.deepEqual(
    balance.lines.map((line) => line.costShare),
    [66.667, 33.333],
  );
});

test('balanço: unidade que não converte para kg não inventa perda; custo pela quantidade', () => {
  const balance = productionBalance(
    doc({ input_product: 'Bag', input_qty: '2', input_uom: 'Bag' }, [
      { product: 'Serviço', quantity: '3', uom: 'Horas' },
      { product: 'FARDO PET - KG', quantity: '1', uom: 'KG' },
    ]),
    convert,
  );
  assert.equal(balance.outputKg, null);
  assert.equal(balance.lossKg, null);
  assert.deepEqual(
    balance.lines.map((line) => line.costShare),
    [75, 25],
  );
});

test('compra de bags: “10 bags” vai na unidade Bag do Odoo; “50 kg” fica na do produto', () => {
  const base = { kind: 'purchase' as const, presetLines: [{ values: { product: 'Bag', quantity: '', unit_price: '' } }], visibleLineKeys: ['quantity'], moreAnswer: '' };
  const bags = planBotLines({ ...base, linesAnswer: JSON.stringify([{ product: 'Bag', quantity: '10 bags' }]) });
  assert.equal(bags.primary[0].quantity, '10');
  assert.equal(bags.primary[0].uom, 'Bag');
  assert.ok(bags.primaryKeys.includes('uom'));

  const kg = planBotLines({ ...base, linesAnswer: JSON.stringify([{ product: 'Bag', quantity: '50 kg' }]) });
  assert.equal(kg.primary[0].quantity, '50');
  assert.equal(kg.primary[0].uom, undefined);
});

const preset = (partial: Partial<FormPreset>): FormPreset => ({
  id: 'p-fab',
  company_odoo_id: '7',
  kind: 'production',
  name: 'Fabricação',
  title: '',
  status: 'done',
  header: { input_product: 'Bag', input_uom: 'Bag' },
  lines: [],
  visible: { title: false, status: false, header: ['input_qty', 'input_uom'], lines: ['product', 'quantity', 'uom'] },
  bot_enabled: true,
  bot_frequency: 'daily',
  bot_weekday: 1,
  bot_send_time: '17:00',
  bot_template_id: '',
  bot_contact_id: '',
  bot_rules: { idle_reminder_minutes: null, idle_close_minutes: null, confirm_before_close: false },
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...partial,
});

test('padrão de Fabricação: pergunta a entrada (unidade do Odoo junto) e os produtos gerados', () => {
  const built = buildFormsBotQuestions(preset({}));
  assert.deepEqual(
    built.questions.map((item) => item.exportField),
    ['input_qty', FORMS_BOT_LINES_FIELD, FORMS_BOT_LINES_MORE_FIELD],
  );
  assert.equal(built.questions[0].body, 'Quanto de Bag foi usado? (ex.: 2 bags ou 200 kg)');
  assert.match(built.questions[1].body, /Quais produtos foram gerados/);
  assert.ok(!/Unidade/.test(built.questions[1].body));
  assert.match(built.questions[2].body, /Mais produtos gerados/);
  assert.equal(built.defaultValues.input_uom, 'Bag');

  const noUom = buildFormsBotQuestions(preset({ header: { input_product: 'Farinha' } }));
  assert.equal(noUom.questions[0].body, 'Quanto de Farinha foi usado? (ex.: 200 kg)');
  assert.ok(noUom.questions.every((item) => item.exportField !== 'input_uom'));
});

test('“PET 120 kg, papelão 60 kg” vira duas linhas de produto gerado', () => {
  const question = (id: string, body: string, field: string, order: number): QuestionnaireQuestion => ({
    id,
    questionnaire_id: 'forms-preset:p-fab',
    body,
    expected_type: 'any',
    export_field: field,
    sort_order: order,
    fixed_value: '',
  });
  const questions = [
    question('b', 'Quanto de Bag foi usado?', 'input_qty', 0),
    question('l', 'Quais produtos foram gerados?', FORMS_BOT_LINES_FIELD, 1),
    question('m', 'Mais produtos gerados?', FORMS_BOT_LINES_MORE_FIELD, 2),
  ];
  const captured = tryFormsLinesCapture({
    inbound: 'PET 120 kg, papelão 60 kg',
    questions,
    alreadySaved: [{ id: 'b', cycle_id: 'c', question_id: 'b', answer_text: '2 bags', answer_type: 'text', media_url: '' }],
    pendingQuestionId: 'l',
  });
  assert.deepEqual(JSON.parse(captured?.[0]?.text || '[]'), [
    { product: 'PET', quantity: '120 kg' },
    { product: 'papelão', quantity: '60 kg' },
  ]);
});

test('resumo do bot com o número da ordem, conversão do Odoo e perda', () => {
  const text = productionSummaryText(
    doc({ order_reference: 'C7/MO/00001', input_product: 'Bag', input_qty: '2', input_uom: 'Bag' }, [
      { product: 'FARDO PET - KG', quantity: '120', uom: 'KG' },
      { product: 'FARDO PAPELÃO - KG', quantity: '60', uom: 'KG' },
    ]),
    convert,
  );
  assert.equal(
    text,
    'Fabricação C7/MO/00001: 2 Bag (200 kg) de Bag → FARDO PET - KG 120 KG; FARDO PAPELÃO - KG 60 KG.\nPerda: 20 kg.',
  );
});

test('título espelha o número da ordem de produção', () => {
  assert.equal(documentTitle('production', { order_reference: 'C7/MO/00001', production_date: '2026-10-28' }), 'C7/MO/00001 · 28/10/2026');
  assert.equal(documentTitle('production', { production_date: '2026-10-28' }), 'Fabricação 28/10/2026');
  assert.equal(shouldAutofillFormTitle('production', 'Fabricação 28/10/2026', { order_reference: 'C7/MO/00001' }), true);
  assert.equal(shouldAutofillFormTitle('production', 'Prensagem 27/10/2026', {}), true);
  assert.equal(shouldAutofillFormTitle('production', 'Prensa do turno da tarde', {}), false);
});
