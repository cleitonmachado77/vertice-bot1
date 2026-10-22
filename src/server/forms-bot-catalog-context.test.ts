import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_PAGE_SIZE,
  detectCatalogListRequest,
  extractCatalogIndexInbound,
  formatCatalogListPage,
  isCatalogMoreAsk,
  isFormsCatalogListAsk,
  optionsFromCatalogOutbound,
  parseCatalogListCursor,
  tryResolveCatalogIndexAnswer,
} from './forms-bot-catalog-context.js';
import type { FormField } from './forms-fields.js';
import { isGreetingOrAck, isUnusableQuestionnaireAnswer } from './questionnaire-rules.js';
import type { Questionnaire } from './questionnaires.js';

const vendor: FormField = { key: 'vendor', label: 'Fornecedor', required: true };
const customer: FormField = { key: 'customer', label: 'Cliente', required: true };
const product: FormField = { key: 'product', label: 'Produto', required: true };

test('detectCatalogListRequest reconhece lista de fornecedores', () => {
  const hit = detectCatalogListRequest('qual a lista de fornecedores ?', [vendor, product]);
  assert.equal(hit?.key, 'vendor');
});

test('detectCatalogListRequest reconhece fornecedores disponíveis', () => {
  const hit = detectCatalogListRequest('quais são os fornecedores disponíveis?', [vendor]);
  assert.equal(hit?.key, 'vendor');
  assert.equal(isFormsCatalogListAsk('quais são os fornecedores disponíveis?'), true);
});

test('detectCatalogListRequest reconhece “quais são os fornecedores?”', () => {
  assert.equal(isFormsCatalogListAsk('quais são os fornecedores?'), true);
  assert.equal(detectCatalogListRequest('quais são os fornecedores?', [vendor])?.key, 'vendor');
});

test('detectCatalogListRequest reconhece pedido genérico com um campo só', () => {
  const hit = detectCatalogListRequest('me passa a lista de fornecedores', [vendor]);
  assert.equal(hit?.key, 'vendor');
});

test('detectCatalogListRequest não confunde com resposta de nome', () => {
  assert.equal(isFormsCatalogListAsk('foi o João'), false);
  assert.equal(detectCatalogListRequest('foi o João', [vendor]), undefined);
});

test('pedido de lista não conta como resposta utilizável', () => {
  assert.equal(
    isUnusableQuestionnaireAnswer('bom dia, quais os fornecedores disponíveis ?'),
    true,
  );
  assert.equal(isUnusableQuestionnaireAnswer('MUNICIPIO DE CAMBE'), false);
  assert.equal(isGreetingOrAck('bom dia'), true);
  assert.equal(isUnusableQuestionnaireAnswer('bom dia'), true);
});

test('formatCatalogListPage pagina com numeração global e opção mais', () => {
  const options = Array.from({ length: 15 }, (_, index) => ({
    value: `F${index + 1}`,
    label: `Fornecedor ${index + 1}`,
    score: 0,
  }));
  const page1 = formatCatalogListPage(vendor, options, 0);
  assert.match(page1, /^Fornecedor — escolha o número:/m);
  assert.match(page1, /^1\) Fornecedor 1$/m);
  assert.match(page1, new RegExp(`^${CATALOG_PAGE_SIZE}\\) Fornecedor ${CATALOG_PAGE_SIZE}$`, 'm'));
  assert.match(page1, /Digite \*mais\* para ver 11–15/);
  assert.equal(page1.includes('11)'), false);

  const page2 = formatCatalogListPage(vendor, options, CATALOG_PAGE_SIZE);
  assert.match(page2, /^11\) Fornecedor 11$/m);
  assert.match(page2, /Fim da lista \(15\)/);
  assert.equal(isCatalogMoreAsk('mais'), true);
  assert.equal(isCatalogMoreAsk('ver mais'), true);
});

test('parseCatalogListCursor não confunde “Mais produtos?” com campo product', () => {
  const invite = [
    'Oi Cleiton! Compras — Ademir - Compras',
    '',
    'Fornecedor — escolha o número:',
    '1) Associaçao Teste',
    '2) Fornecedor Teste Vertice',
    '3) Marcio Luiz Pietsrzak',
    '4) MUNICIPIO DE CAMBE',
    'Responda com o número ou o nome.',
    '',
    'Depois: Qtd de ABACATE - KG; Mais produtos? (produto + qtd, ou “não”).',
    '',
    'Pode responder por texto, áudio, imagem ou vídeo.',
  ].join('\n');
  const cursor = parseCatalogListCursor(invite);
  assert.equal(cursor?.fieldKey, 'vendor');
  assert.equal(cursor?.offset, 0);
  assert.equal(extractCatalogIndexInbound('3'), '3');
  assert.equal(extractCatalogIndexInbound('eu ja confirmei, é o fornecedor 3'), '3');
  const options = optionsFromCatalogOutbound(invite);
  assert.equal(options.get(1), 'Associaçao Teste');
  assert.equal(options.get(3), 'Marcio Luiz Pietsrzak');
});

test('número após a lista só preenche o campo se ele ainda estiver pendente', async () => {
  const invite = [
    'Fornecedor — escolha o número:',
    '1) Associaçao Teste',
    '2) Fornecedor Teste Vertice',
    '3) Marcio Luiz Pietsrzak',
    'Responda com o número ou o nome.',
  ].join('\n');
  const questionnaire = {
    id: 'forms-preset:p1',
    formKind: 'purchase',
    companyOdooId: '1',
    questions: [
      { id: 'v', questionnaire_id: 'forms-preset:p1', body: 'Fornecedor?', expected_type: 'any', export_field: 'vendor', sort_order: 0 },
      { id: 'l', questionnaire_id: 'forms-preset:p1', body: 'Qtd de ABACATE - KG?', expected_type: 'any', export_field: '__lines__', sort_order: 1 },
    ],
  } as unknown as Questionnaire;
  const history = [{ direction: 'OUTBOUND', text: invite }];

  const fresh = await tryResolveCatalogIndexAnswer({ inbound: '3', questionnaire, history, alreadySaved: [] });
  assert.equal(fresh?.value, 'Marcio Luiz Pietsrzak');

  const vendorSaved = [
    { id: 'a', cycle_id: 'c', question_id: 'v', answer_text: 'Associaçao Teste', answer_type: 'text', media_url: '' },
  ];
  // “3” agora é quantidade, não troca o fornecedor.
  const after = await tryResolveCatalogIndexAnswer({ inbound: '3', questionnaire, history, alreadySaved: vendorSaved });
  assert.equal(after, null);
});

const vendorInvite = [
  'Fornecedor — escolha o número:',
  '1) Associaçao Teste',
  '2) Fornecedor Teste Vertice',
  '3) Marcio Luiz Pietsrzak',
  'Responda com o número ou o nome.',
].join('\n');
const vendorAndLinesQuestionnaire = {
  id: 'forms-preset:p1',
  formKind: 'purchase',
  companyOdooId: '1',
  questions: [
    { id: 'v', questionnaire_id: 'forms-preset:p1', body: 'Fornecedor?', expected_type: 'any', export_field: 'vendor', sort_order: 0 },
    { id: 'l', questionnaire_id: 'forms-preset:p1', body: 'Qtd?', expected_type: 'any', export_field: '__lines__', sort_order: 1 },
  ],
} as unknown as Questionnaire;

test('lista na última mensagem do bot prevalece sobre pending_question_id', async () => {
  const hit = await tryResolveCatalogIndexAnswer({
    inbound: '3',
    questionnaire: vendorAndLinesQuestionnaire,
    history: [{ direction: 'OUTBOUND', text: vendorInvite }],
    alreadySaved: [],
    pendingQuestionId: 'l',
  });
  assert.equal(hit?.questionId, 'v');
  assert.equal(hit?.value, 'Marcio Luiz Pietsrzak');
});

test('lista antiga no histórico não vale quando o bot já perguntou outra coisa', async () => {
  const hit = await tryResolveCatalogIndexAnswer({
    inbound: '3',
    questionnaire: vendorAndLinesQuestionnaire,
    history: [
      { direction: 'OUTBOUND', text: vendorInvite },
      { direction: 'OUTBOUND', text: 'Qual a quantidade de abacate?' },
    ],
    alreadySaved: [],
    pendingQuestionId: 'l',
  });
  assert.equal(hit, null);
});
