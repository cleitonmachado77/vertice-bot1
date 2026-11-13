import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dayChoicePrompt,
  isLoosePhrase,
  looseConfirmPrompt,
  shouldConfirmLoose,
} from './conversation-mode.js';

test('frase longa pede confirmação; número, quantidade e linha não', () => {
  assert.equal(isLoosePhrase('quero registrar o fornecedor municipio de cambe'), true);
  assert.equal(isLoosePhrase('3'), false);
  assert.equal(isLoosePhrase('50 kg de manga'), false);
  assert.equal(isLoosePhrase('municipio de cambe'), false);
  assert.equal(shouldConfirmLoose('vendor', 'quero registrar o fornecedor municipio de cambe'), true);
  assert.equal(shouldConfirmLoose('__lines__', 'quero registrar o fornecedor municipio de cambe'), false);
  assert.equal(shouldConfirmLoose('vendor', '50 kg de manga'), false);
  assert.equal(shouldConfirmLoose('notes', 'quero registrar uma observacao qualquer aqui'), false);
});

test('confirmação e escolha do dia nomeiam o que será gravado', () => {
  assert.equal(
    looseConfirmPrompt('vendor', 'MUNICIPIO DE CAMBE'),
    'Anotei o fornecedor como MUNICIPIO DE CAMBE? Responda 1 para confirmar.',
  );
  assert.match(looseConfirmPrompt('qty', '50 kg'), /Anotei a quantidade como 50 kg/);
  const day = dayChoicePrompt(['Compra de sucata', 'Venda']);
  assert.match(day, /Ontem ficaram pendentes: Compra de sucata, Venda/);
  assert.match(day, /1\) Retomar Compra de sucata/);
  assert.match(day, /2\) Começar hoje/);
});
