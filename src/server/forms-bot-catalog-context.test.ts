import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectCatalogListRequest,
  isFormsCatalogListAsk,
} from './forms-bot-catalog-context.js';
import type { FormField } from './forms-fields.js';

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

test('detectCatalogListRequest reconhece pedido genérico com um campo só', () => {
  const hit = detectCatalogListRequest('me passa a lista de fornecedores', [vendor]);
  assert.equal(hit?.key, 'vendor');
});

test('detectCatalogListRequest não confunde com resposta de nome', () => {
  assert.equal(isFormsCatalogListAsk('foi o João'), false);
  assert.equal(detectCatalogListRequest('foi o João', [vendor]), undefined);
});
