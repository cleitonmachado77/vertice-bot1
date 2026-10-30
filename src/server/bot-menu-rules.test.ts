import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFormMenu,
  buildKindMenu,
  buildMainMenu,
  formatMenu,
  isMenuKeyword,
  isNewMenuSession,
  isShortMenuReply,
  matchMenuOption,
  menuFormName,
  menuGreeting,
  normalizeMenuForms,
  singleRegisterOption,
  type MenuCycle,
  type MenuForm,
} from './bot-menu-rules.js';

const forms: MenuForm[] = normalizeMenuForms([
  { questionnaire_id: 'forms-preset:p1', name: '[Forms] Compras · Ademir - Compras', form_kind: 'purchase' },
  { questionnaire_id: 'forms-preset:p2', name: '[Forms] Inventário · Estoque geral', form_kind: 'product' },
  { questionnaire_id: 'forms-preset:p3', name: '[Forms] Vendas · Vendas do Dia', form_kind: 'sale' },
  { questionnaire_id: 'forms-preset:p4', name: '[Forms] Vendas · Feira', form_kind: 'sale' },
  { questionnaire_id: 'legacy', name: 'Questionário antigo', form_kind: '' },
]);

const none: MenuCycle[] = [];

test('normaliza padrões: tira prefixo e ignora questionário sem tipo Forms', () => {
  assert.equal(forms.length, 4);
  assert.equal(forms[0].name, 'Ademir - Compras');
  assert.equal(menuFormName('[Forms] Fabricação · Prensa', 'production'), 'Prensa');
});

test('menu principal lista tipos na ordem Compras, Inventário, Fabricação, Vendas + atendente', () => {
  const node = buildMainMenu({ forms, cycles: none, attendant: true, title: 'O que deseja fazer hoje?' });
  assert.deepEqual(
    node.options.map((option) => `${option.key}) ${option.label}`),
    ['1) Compras', '2) Inventário', '3) Vendas', '4) Falar com um atendente'],
  );
});

test('estado do dia aparece no próprio item do tipo, sem duplicar opções', () => {
  const cycles: MenuCycle[] = [
    { questionnaireId: 'forms-preset:p1', status: 'notified', answers: 0, lastPromptedAt: '' },
    { questionnaireId: 'forms-preset:p2', status: 'completed', answers: 3, lastPromptedAt: '' },
    { questionnaireId: 'forms-preset:p3', status: 'in_progress', answers: 2, lastPromptedAt: '' },
  ];
  const node = buildMainMenu({ forms, cycles, attendant: false, title: 'Menu' });
  assert.deepEqual(
    node.options.map((option) => `${option.key}) ${option.label}`),
    ['1) Compras — pendente hoje', '2) Inventário — concluído hoje', '3) Vendas — em andamento'],
  );
  assert.deepEqual(
    node.options.map((option) => Boolean(option.featured)),
    [true, false, true],
  );
});

test('“sim” abre o primeiro tipo pendente; nome do tipo e atendente casam por texto', () => {
  const cycles: MenuCycle[] = [
    { questionnaireId: 'forms-preset:p3', status: 'notified', answers: 0, lastPromptedAt: '' },
  ];
  const node = buildMainMenu({ forms, cycles, attendant: true, title: 'Menu' });
  assert.equal(matchMenuOption('sim', node)?.target, 'kind:sale');
  assert.equal(matchMenuOption('pode sim', node)?.target, 'kind:sale');
  assert.equal(matchMenuOption('Bom, pode sim', node), undefined);
  assert.equal(matchMenuOption('compras', node)?.target, 'kind:purchase');
  assert.equal(matchMenuOption('quero falar com atendente', node)?.action, 'human');

  const nothingPending = buildMainMenu({ forms, cycles: none, attendant: true, title: 'Menu' });
  assert.equal(matchMenuOption('sim', nothingPending), undefined);
});

test('entra direto no formulário quando a única ação é registrar', () => {
  const fresh = buildFormMenu(forms[0], none, 'main');
  assert.equal(singleRegisterOption(fresh)?.target, 'forms-preset:p1');
  const done = buildFormMenu(
    forms[0],
    [{ questionnaireId: 'forms-preset:p1', status: 'completed', answers: 2, lastPromptedAt: '' }],
    'main',
  );
  assert.equal(singleRegisterOption(done), undefined);
});

test('número escolhe a opção; número inexistente não casa', () => {
  const node = buildMainMenu({ forms, cycles: none, attendant: true, title: 'Menu' });
  assert.equal(matchMenuOption('2', node)?.target, 'kind:product');
  assert.equal(matchMenuOption(' 2) ', node)?.target, 'kind:product');
  assert.equal(matchMenuOption('opção 3', node)?.target, 'kind:sale');
  assert.equal(matchMenuOption('9', node), undefined);
  assert.equal(matchMenuOption('50 kg de abacate', node), undefined);
});

test('tipo com um padrão vai direto às ações; com vários, lista os padrões', () => {
  const purchase = buildKindMenu('purchase', forms, none);
  assert.equal(purchase.node, 'form:forms-preset:p1');
  assert.equal(purchase.parent, 'main');
  assert.equal(purchase.options[0].label, 'Registrar compras de hoje');

  const sales = buildKindMenu('sale', forms, none);
  assert.equal(sales.node, 'kind:sale');
  assert.deepEqual(
    sales.options.map((option) => option.key),
    ['1', '2', '0'],
  );
  assert.equal(matchMenuOption('0', sales)?.action, 'back');
});

test('ações do formulário mudam com o estado do dia', () => {
  const form = forms[0];
  const done = buildFormMenu(
    form,
    [{ questionnaireId: form.questionnaireId, status: 'completed', answers: 3, lastPromptedAt: '' }],
    'main',
  );
  assert.deepEqual(
    done.options.map((option) => option.action),
    ['register', 'correct', 'view', 'back'],
  );
  assert.equal(matchMenuOption('corrigir', done)?.action, 'correct');

  const going = buildFormMenu(
    form,
    [{ questionnaireId: form.questionnaireId, status: 'in_progress', answers: 1, lastPromptedAt: '' }],
    'main',
  );
  assert.equal(going.options[0].label, 'Continuar o registro de hoje');
});

test('formatação numerada com rodapé e “0) Voltar” no fim', () => {
  const node = buildKindMenu('sale', forms, none);
  const text = formatMenu(node, { hint: 'Não entendi a opção.' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Não entendi a opção.');
  assert.equal(lines[1], 'Vendas — escolha o formulário:');
  assert.equal(lines.at(-3), '0) Voltar');
  assert.equal(lines.at(-1), 'Responda com o número da opção.');

  const main = formatMenu(buildMainMenu({ forms, cycles: none, attendant: true, title: 'O que deseja?' }), {
    greeting: 'Bom dia, Cleiton!',
  });
  assert.match(main, /^Bom dia, Cleiton! O que deseja\?\n\n1\) Compras/);
  assert.match(main, /Digite \*menu\*/);
});

test('palavra “menu” e sessão nova', () => {
  assert.ok(isMenuKeyword('Menu'));
  assert.ok(isMenuKeyword('voltar ao menu'));
  assert.ok(!isMenuKeyword('menu de compras do dia 50 kg'));

  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.ok(isNewMenuSession('', now, 2));
  assert.ok(isNewMenuSession('2026-10-29T09:00:00Z', now, 2));
  assert.ok(!isNewMenuSession('2026-10-29T11:30:00Z', now, 2));
});

test('resposta curta reapresenta; texto longo segue para o agente', () => {
  assert.ok(isShortMenuReply('não sei'));
  assert.ok(!isShortMenuReply('qual o horário da coleta de amanhã?'));
});

test('saudação usa o primeiro nome e ignora nome que é telefone', () => {
  assert.equal(menuGreeting('Cleiton Machado', 9 * 60), 'Bom dia, Cleiton!');
  assert.equal(menuGreeting('+5543991201041', 15 * 60), 'Boa tarde!');
  assert.equal(menuGreeting('', 20 * 60), 'Boa noite!');
});
